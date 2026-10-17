const crypto = require('crypto');
const { withScope, setScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');
const {
    IngestPayloadError, checkPayload, planIngestWrites, sourceDescriptors, pickWinningValues, visibleFlagsMeta, historyRecords,
} = require('./flags-logic');

/**
 * Feature flags pushed from outside (migration 008, contract schemaVersion 2 -- server/README.md). A tenant names
 * its flag sources; each sends, with its own token, the full state of its flags for the environments it covers.
 * Flags missing from a full-state message are marked removed; a value older than the stored one is ignored; every
 * actual change goes to history. Values are off/on/partial (with an optional rollout percentage).
 *
 * The file-based scripts/ ingest (scripts/lib/flag-ingest.js, schemaVersion 1) is a different, older contract for
 * the single-tenant setup; this one replaces it for the server and is not a port of it.
 */

class IngestTokenError extends Error {}
class FlagSourceNotFoundError extends Error {}
class FlagSourceConflictError extends Error {}

const TOKEN_PREFIX = 'shpi_';
const TOKEN_PATTERN = /^shpi_[A-Za-z0-9_-]{43}$/;
const DEFAULT_PRIORITY = { build: 0, runtime: 100 };

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    return { token, tokenHash: hashToken(token) };
}

async function assertTrackedRepo(client, tenantId, repoId) {
    if (repoId === null || repoId === undefined) return;
    const { rows } = await client.query('SELECT 1 FROM tracked_repos WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repoId]);
    if (!rows.length) throw new FlagSourceNotFoundError('That repository is not tracked');
}

function toSource(row) {
    return { id: row.id, name: row.name, kind: row.kind, priority: row.priority, repoId: row.repo_id === null ? null : Number(row.repo_id), createdAt: row.created_at };
}

const SOURCE_COLUMNS = 'id, name, kind, priority, repo_id, created_at';

/**
 * Creates a flag source with its first token. Admins only. The token is returned once and never stored.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, name: string, kind: 'build'|'runtime', priority?: number, repoId?: number|null }} input
 * @returns {Promise<{ source: { id: string, name: string, kind: string, priority: number, repoId: number|null, createdAt: Date }, token: { id: string, token: string } }>}
 * @throws {FlagSourceNotFoundError} repoId isn't tracked
 * @throws {FlagSourceConflictError} the name is taken
 */
async function createFlagSource(pool, { tenantId, actorUserId, name, kind, priority, repoId = null }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        await assertTrackedRepo(client, tenantId, repoId);
        const row = await saveSource(client, () => client.query(
            `INSERT INTO flag_sources (tenant_id, name, kind, priority, repo_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${SOURCE_COLUMNS}`,
            [tenantId, name, kind, priority ?? DEFAULT_PRIORITY[kind], repoId]
        ));
        const { token, tokenHash } = newToken();
        const { rows: [tokenRow] } = await client.query(
            'INSERT INTO ingest_tokens (token_hash, tenant_id, source_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
            [tokenHash, tenantId, row.id, actorUserId]
        );
        return { source: toSource(row), token: { id: tokenRow.id, token } };
    });
}

/** Runs an INSERT/UPDATE of a source, turning a duplicate name into FlagSourceConflictError. */
async function saveSource(client, query) {
    try {
        const { rows } = await query();
        return rows[0];
    } catch (err) {
        if (err.code === '23505') throw new FlagSourceConflictError('A flag source with that name already exists');
        throw err;
    }
}

/**
 * Changes a source's name, kind, priority or component. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, sourceId: string, name: string, kind: 'build'|'runtime', priority: number, repoId: number|null }} input
 * @returns {Promise<{ id: string, name: string, kind: string, priority: number, repoId: number|null, createdAt: Date }>}
 * @throws {FlagSourceNotFoundError|FlagSourceConflictError}
 */
async function updateFlagSource(pool, { tenantId, actorUserId, sourceId, name, kind, priority, repoId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        await assertTrackedRepo(client, tenantId, repoId);
        const row = await saveSource(client, () => client.query(
            `UPDATE flag_sources SET name = $3, kind = $4, priority = $5, repo_id = $6 WHERE tenant_id = $1 AND id = $2 RETURNING ${SOURCE_COLUMNS}`,
            [tenantId, sourceId, name, kind, priority, repoId]
        ));
        if (!row) throw new FlagSourceNotFoundError('No such flag source');
        return toSource(row);
    });
}

/**
 * Deletes a source with its tokens, values and history. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, sourceId: string }} input
 * @returns {Promise<boolean>} false if there was no such source
 */
async function deleteFlagSource(pool, { tenantId, actorUserId, sourceId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rowCount } = await client.query('DELETE FROM flag_sources WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId]);
        return rowCount === 1;
    });
}

/**
 * The tenant's flag sources with their tokens (never the tokens themselves). Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<{ id: string, name: string, kind: string, priority: number, repoId: number|null, createdAt: Date, tokens: Array<{ id: string, createdAt: Date, lastUsedAt: Date|null }> }>>}
 */
async function listFlagSources(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: sources } = await client.query(`SELECT ${SOURCE_COLUMNS} FROM flag_sources WHERE tenant_id = $1 ORDER BY name`, [tenantId]);
        const { rows: tokens } = await client.query(
            'SELECT id, source_id, created_at, last_used_at FROM ingest_tokens WHERE tenant_id = $1 ORDER BY created_at',
            [tenantId]
        );
        return sources.map((s) => ({
            ...toSource(s),
            tokens: tokens.filter((t) => t.source_id === s.id).map((t) => ({ id: t.id, createdAt: t.created_at, lastUsedAt: t.last_used_at })),
        }));
    });
}

/**
 * Adds a token to a source (e.g. to rotate one). Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, sourceId: string }} input
 * @returns {Promise<{ id: string, token: string }>}
 * @throws {FlagSourceNotFoundError}
 */
async function createIngestToken(pool, { tenantId, actorUserId, sourceId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: source } = await client.query('SELECT 1 FROM flag_sources WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId]);
        if (!source.length) throw new FlagSourceNotFoundError('No such flag source');
        const { token, tokenHash } = newToken();
        const { rows } = await client.query(
            'INSERT INTO ingest_tokens (token_hash, tenant_id, source_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
            [tokenHash, tenantId, sourceId, actorUserId]
        );
        return { id: rows[0].id, token };
    });
}

/**
 * Revokes (deletes) a token. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, tokenId: string }} input
 * @returns {Promise<boolean>} false if there was no such token in this tenant
 */
async function revokeIngestToken(pool, { tenantId, actorUserId, tokenId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rowCount } = await client.query('DELETE FROM ingest_tokens WHERE tenant_id = $1 AND id = $2', [tenantId, tokenId]);
        return rowCount === 1;
    });
}

/**
 * Applies one source's message. Resolves the token through its own RLS policy, then works under its tenant, one
 * ingest per tenant at a time. Per observation: ignored when the stored value changed later (a delayed message);
 * written, with a history entry, when it differs from what is stored or the flag had been removed. With
 * `complete` (the default), every stored flag of this source in the covered environments that the message does not
 * list is marked removed, with a history entry.
 *
 * @param {import('pg').Pool} pool
 * @param {{ token: string, payload: object, now?: Date }} input
 * @returns {Promise<{ source: string, flags: number, changed: number, removed: number, stale: number, created: string[] }>}
 * @throws {IngestTokenError|IngestPayloadError}
 */
async function ingestFlags(pool, { token, payload, now = new Date() }) {
    if (!TOKEN_PATTERN.test(token || '')) throw new IngestTokenError('Invalid ingest token');
    const tokenHash = hashToken(token);
    return withScope(pool, { ingestTokenHash: tokenHash }, async (client) => {
        const { rows: found } = await client.query('SELECT id, tenant_id, source_id FROM ingest_tokens WHERE token_hash = $1', [tokenHash]);
        if (!found.length) throw new IngestTokenError('Invalid ingest token');
        const { id: tokenId, tenant_id: tenantId, source_id: sourceId } = found[0];
        await setScope(client, { tenantId, ingestTokenHash: '' });
        // One ingest per tenant at a time, so two messages from one source can't interleave their full-state diffs.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('flags:' || $1, 0))", [tenantId]);

        const { rows: [source] } = await client.query('SELECT name FROM flag_sources WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId]);
        const { complete, environments, observations, metaByKey } = checkPayload(payload, now);
        const changedBy = payload.changedBy || source.name;
        const keys = [...new Set(observations.map((o) => o.key))];

        const { rows: existing } = await client.query(
            `SELECT key, environment, state, rollout, changed_at, removed_at FROM flag_values
             WHERE tenant_id = $1 AND source_id = $2 AND (environment = ANY($3) OR key = ANY($4))`,
            [tenantId, sourceId, environments, keys]
        );
        const { rows: inserted } = await client.query(
            `INSERT INTO flags (tenant_id, key, created_at) SELECT $1, k, $3 FROM unnest($2::text[]) AS k
             ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
            [tenantId, keys, now]
        );
        for (const [key, meta] of metaByKey) {
            await client.query(
                `UPDATE flags SET description = CASE WHEN $3 THEN $4 ELSE description END,
                                  jira_keys = CASE WHEN $5 THEN $6::text[] ELSE jira_keys END
                 WHERE tenant_id = $1 AND key = $2`,
                [tenantId, key, 'description' in meta, meta.description ?? null, 'jiraKeys' in meta, meta.jiraKeys || []]
            );
        }

        const { writes, removals, stale } = planIngestWrites({ observations, existing, complete, environments });

        if (writes.length) {
            const cols = [writes.map((w) => w.key), writes.map((w) => w.env), writes.map((w) => w.state), writes.map((w) => w.rollout), writes.map((w) => w.changedAt)];
            await client.query(
                `INSERT INTO flag_values (tenant_id, source_id, key, environment, state, rollout, changed_at, changed_by, removed_at)
                 SELECT $1, $2, k, e, s, r, c, $8, NULL FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[], $7::timestamptz[]) AS t(k, e, s, r, c)
                 ON CONFLICT (tenant_id, source_id, key, environment) DO UPDATE SET state = EXCLUDED.state, rollout = EXCLUDED.rollout,
                     changed_at = EXCLUDED.changed_at, changed_by = EXCLUDED.changed_by, removed_at = NULL`,
                [tenantId, sourceId, ...cols, changedBy]
            );
            await client.query(
                `INSERT INTO flag_value_history (tenant_id, source_id, key, environment, state, rollout, changed_at, changed_by)
                 SELECT $1, $2, k, e, s, r, c, $8 FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[], $7::timestamptz[]) AS t(k, e, s, r, c)`,
                [tenantId, sourceId, ...cols, changedBy]
            );
        }
        if (removals.length) {
            const cols = [removals.map((r) => r.key), removals.map((r) => r.environment)];
            await client.query(
                `UPDATE flag_values v SET removed_at = $5, changed_by = $6 FROM unnest($3::text[], $4::text[]) AS t(k, e)
                 WHERE v.tenant_id = $1 AND v.source_id = $2 AND v.key = t.k AND v.environment = t.e`,
                [tenantId, sourceId, ...cols, now, changedBy]
            );
            await client.query(
                `INSERT INTO flag_value_history (tenant_id, source_id, key, environment, removed, changed_at, changed_by)
                 SELECT $1, $2, k, e, true, $5, $6 FROM unnest($3::text[], $4::text[]) AS t(k, e)`,
                [tenantId, sourceId, ...cols, now, changedBy]
            );
        }
        await client.query('UPDATE ingest_tokens SET last_used_at = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, tokenId, now]);

        return { source: source.name, flags: keys.length, changed: writes.length, removed: removals.length, stale, created: inserted.map((r) => r.key).sort() };
    });
}

/** flag key -> issue keys whose Jira issue names that flag (jira_issues.data.featureFlags, migration 014). */
async function jiraLinks(client, tenantId) {
    const { rows } = await client.query(
        `SELECT DISTINCT f AS flag, key FROM jira_issues, jsonb_array_elements_text(COALESCE(data->'featureFlags', '[]')) AS f
         WHERE tenant_id = $1 ORDER BY key`,
        [tenantId]
    );
    const links = new Map();
    for (const r of rows) {
        if (!links.has(r.flag)) links.set(r.flag, []);
        links.get(r.flag).push(r.key);
    }
    return links;
}

class FlagNotFoundError extends Error {}

/**
 * The tenant's flags for the settings page: every flag some source still reports, with its description and its
 * Jira links by origin (the sender's, set by hand in ShipScope, named in Jira itself), and its effective state per
 * environment (the dashboard's: per slot, the highest-priority source). Members.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<{ key: string, description: string, senderDescription: string|null, manualDescription: string|null, links: { sender: string[], manual: string[], jira: string[] }, states: object, components: string[] }>>}
 * @throws {TenantNotFoundError}
 */
async function listFlags(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows: repos } = await client.query('SELECT repo_id, full_name FROM tracked_repos WHERE tenant_id = $1', [tenantId]);
        const names = new Map(repos.map((r) => [Number(r.repo_id), r.full_name.split('/').pop()]));
        const { flagsMeta, flagStates } = await readDashboardFlags(client, { tenantId, componentOf: (id) => names.get(id) });
        const { rows } = await client.query(
            'SELECT key, description, jira_keys, manual_description, manual_jira_keys FROM flags WHERE tenant_id = $1 ORDER BY key',
            [tenantId]
        );
        const fromJira = await jiraLinks(client, tenantId);
        return rows.filter((r) => flagsMeta[r.key]).map((r) => ({
            key: r.key,
            description: flagsMeta[r.key].description,
            senderDescription: r.description,
            manualDescription: r.manual_description,
            links: { sender: r.jira_keys, manual: r.manual_jira_keys, jira: fromJira.get(r.key) || [] },
            states: flagStates[r.key] || {},
            components: flagsMeta[r.key].components,
        }));
    });
}

/**
 * What an admin sets on a flag in ShipScope: a description that wins over the sender's (null: the sender's again)
 * and Jira issues linked by hand. A sender's next message never overwrites these. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, key: string, description: string|null, jiraKeys: string[] }} input
 * @returns {Promise<{ key: string, manualDescription: string|null, manualJiraKeys: string[] }>}
 * @throws {TenantNotFoundError|ForbiddenError|FlagNotFoundError}
 */
async function setFlagDetails(pool, { tenantId, actorUserId, key, description, jiraKeys }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const text = description === null ? null : description.trim() || null;
        const keys = [...new Set(jiraKeys)].sort();
        const { rowCount } = await client.query(
            'UPDATE flags SET manual_description = $3, manual_jira_keys = $4 WHERE tenant_id = $1 AND key = $2',
            [tenantId, key, text, keys]
        );
        if (!rowCount) throw new FlagNotFoundError(`No flag ${key}`);
        return { key, manualDescription: text, manualJiraKeys: keys };
    });
}

/**
 * The tenant's flags in the dashboard's data/*.json shapes (flags-meta.json, flag-states.json,
 * flag-state-history.json). Sources of one kind fold into that kind's slot (`build`, or `runtime-be` for runtime
 * sources), the highest priority winning and then the latest change; removed values don't count. `enabled` is
 * true for "on" and "partial", with `state` and `rollout` alongside. Call inside the tenant's scope.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, componentOf: (repoId: number) => string }} input
 * @returns {Promise<{ flagsMeta: object, flagStates: object, flagStateHistory: object[] }>}
 */
async function readDashboardFlags(client, { tenantId, componentOf }) {
    const { rows: sourceRows } = await client.query('SELECT id, name, kind, priority, repo_id FROM flag_sources WHERE tenant_id = $1', [tenantId]);
    const sources = sourceDescriptors(sourceRows, componentOf);
    const { rows: flags } = await client.query(
        'SELECT key, description, jira_keys, manual_description, manual_jira_keys, created_at FROM flags WHERE tenant_id = $1',
        [tenantId]
    );
    const fromJira = await jiraLinks(client, tenantId);
    const { rows: values } = await client.query(
        'SELECT source_id, key, environment, state, rollout, changed_at, changed_by FROM flag_values WHERE tenant_id = $1 AND removed_at IS NULL',
        [tenantId]
    );
    const { rows: history } = await client.query(
        `SELECT source_id, key, environment, state, changed_at, changed_by FROM flag_value_history
         WHERE tenant_id = $1 AND NOT removed ORDER BY changed_at, id`,
        [tenantId]
    );

    const { flagStates, slotsOf, componentsOf } = pickWinningValues(values, sources);
    const flagsMeta = visibleFlagsMeta(flags, { slotsOf, componentsOf }, fromJira);
    return { flagsMeta, flagStates, flagStateHistory: historyRecords(history, sources) };
}

module.exports = {
    FlagNotFoundError,
    listFlags,
    setFlagDetails,
    TOKEN_PATTERN,
    IngestTokenError,
    IngestPayloadError,
    FlagSourceNotFoundError,
    FlagSourceConflictError,
    createFlagSource,
    updateFlagSource,
    deleteFlagSource,
    listFlagSources,
    createIngestToken,
    revokeIngestToken,
    checkPayload,
    ingestFlags,
    readDashboardFlags,
};
