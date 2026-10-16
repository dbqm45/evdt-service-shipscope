const crypto = require('crypto');
const { withScope, setScope } = require('./scope');
const { assertAdmin } = require('./tenants');

/**
 * Feature flags pushed from outside (migration 008): ingest tokens per tracked repo, and the ingest itself --
 * a port of scripts/lib/flag-ingest.js's applyObservations (collision guard, idempotent writes, history), so a
 * fix to one belongs in both. The payload is the file-based contract (design-docs/FLAG-INGEST.pl.md,
 * schemaVersion 1) plus optional per-flag metadata; Fastify validates its shape (web.js), this module the rules
 * a schema can't express.
 */

class IngestTokenError extends Error {}
class IngestPayloadError extends Error {}

const TOKEN_PREFIX = 'shpi_';
const TOKEN_PATTERN = /^shpi_[A-Za-z0-9_-]{43}$/;
const ENVIRONMENTS = ['test', 'qa', 'prod'];
// Keys become object keys in the dashboard's flag data; these would turn into prototype writes there.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Creates an ingest token for a tracked repo. Admins only. The token is returned once and never stored.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, repoId: number, label: string }} input
 * @returns {Promise<{ id: string, repoId: number, label: string, createdAt: Date, token: string }|null>} null if the repo isn't tracked
 */
async function createIngestToken(pool, { tenantId, actorUserId, repoId, label }) {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: repo } = await client.query('SELECT 1 FROM tracked_repos WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repoId]);
        if (!repo.length) return null;
        const { rows } = await client.query(
            `INSERT INTO ingest_tokens (token_hash, tenant_id, repo_id, label, created_by) VALUES ($1, $2, $3, $4, $5)
             RETURNING id, created_at`,
            [hashToken(token), tenantId, repoId, label, actorUserId]
        );
        return { id: rows[0].id, repoId, label, createdAt: rows[0].created_at, token };
    });
}

/**
 * A tenant's ingest tokens (never the tokens themselves). Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<{ id: string, repoId: number, fullName: string, label: string, createdAt: Date, lastUsedAt: Date|null }>>}
 */
async function listIngestTokens(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            `SELECT t.id, t.repo_id, r.full_name, t.label, t.created_at, t.last_used_at
             FROM ingest_tokens t JOIN tracked_repos r ON r.tenant_id = t.tenant_id AND r.repo_id = t.repo_id
             WHERE t.tenant_id = $1 ORDER BY r.full_name, t.created_at`,
            [tenantId]
        );
        return rows.map((r) => ({
            id: r.id, repoId: Number(r.repo_id), fullName: r.full_name, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at,
        }));
    });
}

/**
 * Revokes (deletes) an ingest token. Admins only.
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
 * Checks what the schema can't: keys, the component claim, and conflicting duplicates. Returns the values grouped
 * by key (`{ [key]: { [env]: boolean } }`, as applyObservations takes them) and the metadata by key.
 *
 * @param {{ source: string, component?: string, observations: Array<{ key: string, env: string, enabled: boolean }>, flags?: Array<{ key: string, description?: string|null, jiraKeys?: string[] }> }} payload
 * @param {{ fullName: string }} repo
 * @returns {{ valuesByKey: Record<string, Record<string, boolean>>, metaByKey: Map<string, { description?: string|null, jiraKeys?: string[] }> }}
 * @throws {IngestPayloadError}
 */
function checkPayload(payload, repo) {
    const shortName = repo.fullName.split('/').pop();
    // The component comes from the token, never the payload; a payload naming another one is a mistake to report.
    if (payload.component !== undefined && payload.component !== repo.fullName && payload.component !== shortName) {
        throw new IngestPayloadError(`component ${JSON.stringify(payload.component)} does not match this token's repository "${repo.fullName}"`);
    }
    const valuesByKey = {};
    payload.observations.forEach((obs, i) => {
        if (DANGEROUS_KEYS.has(obs.key)) throw new IngestPayloadError(`observations[${i}].key is not a valid flag key`);
        const byEnv = (valuesByKey[obs.key] ||= {});
        if (obs.env in byEnv && byEnv[obs.env] !== obs.enabled) throw new IngestPayloadError(`conflicting values for ${obs.key}.${obs.env}`);
        byEnv[obs.env] = obs.enabled;
    });
    const metaByKey = new Map();
    for (const [i, meta] of (payload.flags || []).entries()) {
        if (DANGEROUS_KEYS.has(meta.key)) throw new IngestPayloadError(`flags[${i}].key is not a valid flag key`);
        if (metaByKey.has(meta.key)) throw new IngestPayloadError(`flags[${i}]: ${meta.key} is listed twice`);
        // Metadata only travels with values: a sender describes the flags it reports, never someone else's.
        if (!valuesByKey[meta.key]) throw new IngestPayloadError(`flags[${i}]: ${meta.key} has no observations in this payload`);
        metaByKey.set(meta.key, meta);
    }
    return { valuesByKey, metaByKey };
}

/**
 * Applies one sender's payload. Resolves the token through its own RLS policy, then works under its tenant.
 * Per key: refused when another repo already owns it for this source (a name collision -- the rest of the
 * payload still applies); otherwise the flag row is created if new, metadata sent with it is applied, and each
 * environment whose value actually changed is written with a history entry. A resend of the same values
 * changes nothing.
 *
 * @param {import('pg').Pool} pool
 * @param {{ token: string, payload: object, now?: Date }} input
 * @returns {Promise<{ component: string, flags: number, changed: number, created: string[], collisions: Array<{ key: string, ownedBy: string }> }>}
 * @throws {IngestTokenError|IngestPayloadError}
 */
async function ingestFlags(pool, { token, payload, now = new Date() }) {
    if (!TOKEN_PATTERN.test(token || '')) throw new IngestTokenError('Invalid ingest token');
    const tokenHash = hashToken(token);
    return withScope(pool, { ingestTokenHash: tokenHash }, async (client) => {
        const { rows: found } = await client.query(
            'SELECT id, tenant_id, repo_id FROM ingest_tokens WHERE token_hash = $1',
            [tokenHash]
        );
        if (!found.length) throw new IngestTokenError('Invalid ingest token');
        const { id: tokenId, tenant_id: tenantId, repo_id: repoIdRaw } = found[0];
        const repoId = Number(repoIdRaw);
        await setScope(client, { tenantId, ingestTokenHash: '' });
        // One ingest per tenant at a time: two senders introducing the same new key concurrently would both see no
        // owner and the later write would take it over, slipping past the collision guard.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('flags:' || $1, 0))", [tenantId]);

        const { rows: repos } = await client.query('SELECT repo_id, full_name FROM tracked_repos WHERE tenant_id = $1', [tenantId]);
        const nameOf = new Map(repos.map((r) => [Number(r.repo_id), r.full_name]));
        const repo = { fullName: nameOf.get(repoId) };
        const { valuesByKey, metaByKey } = checkPayload(payload, repo);
        const changedBy = payload.changedBy || `ingest: ${repo.fullName}`;
        const { source } = payload;
        const keys = Object.keys(valuesByKey);

        const { rows: existing } = await client.query(
            'SELECT key, environment, enabled, repo_id FROM flag_states WHERE tenant_id = $1 AND source = $2 AND key = ANY($3)',
            [tenantId, source, keys]
        );
        const current = new Map(existing.map((r) => [`${r.key}\u0000${r.environment}`, r]));
        const ownerOf = new Map();
        for (const r of existing) if (Number(r.repo_id) !== repoId) ownerOf.set(r.key, Number(r.repo_id));

        const collisions = [];
        const accepted = [];
        for (const key of keys) {
            if (ownerOf.has(key)) collisions.push({ key, ownedBy: nameOf.get(ownerOf.get(key)) || 'another repository' });
            else accepted.push(key);
        }

        const { rows: inserted } = await client.query(
            `INSERT INTO flags (tenant_id, key, created_at) SELECT $1, k, $3 FROM unnest($2::text[]) AS k
             ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
            [tenantId, accepted, now]
        );
        for (const key of accepted) {
            const meta = metaByKey.get(key);
            if (!meta) continue;
            await client.query(
                `UPDATE flags SET description = CASE WHEN $3 THEN $4 ELSE description END,
                                  jira_keys = CASE WHEN $5 THEN $6::text[] ELSE jira_keys END
                 WHERE tenant_id = $1 AND key = $2`,
                [tenantId, key, 'description' in meta, meta.description ?? null, 'jiraKeys' in meta, meta.jiraKeys || []]
            );
        }

        const changes = [];
        for (const key of accepted) {
            for (const env of ENVIRONMENTS) {
                if (!(env in valuesByKey[key])) continue;
                const before = current.get(`${key}\u0000${env}`);
                if (!before || before.enabled !== valuesByKey[key][env]) changes.push({ key, env, enabled: valuesByKey[key][env] });
            }
        }
        if (changes.length) {
            const cols = [changes.map((c) => c.key), changes.map((c) => c.env), changes.map((c) => c.enabled)];
            await client.query(
                `INSERT INTO flag_states (tenant_id, key, environment, source, enabled, changed_at, changed_by, repo_id)
                 SELECT $1, k, e, $5, v, $6, $7, $8 FROM unnest($2::text[], $3::text[], $4::boolean[]) AS t(k, e, v)
                 ON CONFLICT (tenant_id, key, environment, source)
                 DO UPDATE SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at, changed_by = EXCLUDED.changed_by, repo_id = EXCLUDED.repo_id`,
                [tenantId, ...cols, source, now, changedBy, repoId]
            );
            await client.query(
                `INSERT INTO flag_state_history (tenant_id, key, environment, source, enabled, changed_at, changed_by, repo_id)
                 SELECT $1, k, e, $5, v, $6, $7, $8 FROM unnest($2::text[], $3::text[], $4::boolean[]) AS t(k, e, v)`,
                [tenantId, ...cols, source, now, changedBy, repoId]
            );
        }
        await client.query('UPDATE ingest_tokens SET last_used_at = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, tokenId, now]);

        return { component: repo.fullName, flags: keys.length, changed: changes.length, created: inserted.map((r) => r.key).sort(), collisions };
    });
}

/**
 * The tenant's flags in the dashboard's data/*.json shapes (flags-meta.json, flag-states.json,
 * flag-state-history.json). Call inside the tenant's scope.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, componentOf: (repoId: number) => string }} input
 * @returns {Promise<{ flagsMeta: object, flagStates: object, flagStateHistory: object[] }>}
 */
async function readDashboardFlags(client, { tenantId, componentOf }) {
    const { rows: flags } = await client.query('SELECT key, description, jira_keys, created_at FROM flags WHERE tenant_id = $1', [tenantId]);
    const { rows: states } = await client.query(
        'SELECT key, environment, source, enabled, changed_at, changed_by, repo_id FROM flag_states WHERE tenant_id = $1 ORDER BY key, environment, source',
        [tenantId]
    );
    const { rows: history } = await client.query(
        'SELECT key, environment, source, enabled, changed_at, changed_by FROM flag_state_history WHERE tenant_id = $1 ORDER BY changed_at, id',
        [tenantId]
    );
    const flagStates = {};
    const componentsOf = new Map();
    const sourcesOf = new Map();
    for (const s of states) {
        const component = componentOf(Number(s.repo_id));
        ((flagStates[s.key] ||= {})[s.environment] ||= {})[s.source] = {
            enabled: s.enabled, changedAt: s.changed_at.toISOString(), changedBy: s.changed_by, component,
        };
        if (!componentsOf.has(s.key)) componentsOf.set(s.key, new Set());
        componentsOf.get(s.key).add(component);
        if (!sourcesOf.has(s.key)) sourcesOf.set(s.key, new Set());
        sourcesOf.get(s.key).add(s.source);
    }
    const flagsMeta = {};
    // A flag whose every value went with an untracked repo has nothing left to show.
    for (const f of flags.filter((row) => componentsOf.has(row.key))) {
        flagsMeta[f.key] = {
            description: f.description || '',
            source: sourcesOf.get(f.key).has('runtime-be') ? 'runtime-be' : 'build',
            jiraKeys: f.jira_keys,
            components: [...componentsOf.get(f.key)].sort(),
            createdAt: f.created_at.toISOString(),
        };
    }
    return {
        flagsMeta,
        flagStates,
        flagStateHistory: history.map((h) => ({
            key: h.key, env: h.environment, source: h.source, enabled: h.enabled, changedAt: h.changed_at.toISOString(), changedBy: h.changed_by,
        })),
    };
}

module.exports = {
    TOKEN_PATTERN,
    IngestTokenError,
    IngestPayloadError,
    createIngestToken,
    listIngestTokens,
    revokeIngestToken,
    checkPayload,
    ingestFlags,
    readDashboardFlags,
};
