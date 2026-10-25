const crypto = require('crypto');
const { withScope, setScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');
const { seal } = require('./secret-box');
const { sealFor } = require('./sealed-box');
const { recordAuditEvent } = require('./audit-log');
const {
    IngestPayloadError, checkPayload, planIngestWrites, sourceDescriptors, pickWinningValues, visibleFlagsMeta, historyRecords,
    STALE_AFTER_MINUTES, freshnessOf, freshnessByComponent, FlagSourceConfigError, checkCodeConfig, checkEndpointConfig, POLL,
    checkOidcConfig, oidcRefAllowed,
} = require('./flags-logic');

/**
 * Feature flags pushed from outside (migration 008, contract schemaVersion 2 -- server/README.md). A tenant names
 * its flag sources; each sends, with its own token, the full state of its flags for the environments it covers.
 * Flags missing from a full-state message are marked removed; a value older than the stored one is ignored; every
 * actual change goes to history. Values are off/on/partial (with an optional rollout percentage).
 *
 * The file-based sync's ingest (flag-ingest.js, schemaVersion 1) is a different, older contract for
 * the single-tenant setup; this one replaces it for the server and is not a port of it.
 */

class IngestTokenError extends Error {}
/** A known token past its expiry: refused like an unknown one (401), but noted on its source for Settings. */
class IngestTokenExpiredError extends IngestTokenError {}
/** A token limited to some environments sent a message covering another one (403). */
class IngestScopeError extends Error {}
/** The tenant's previous message is still being written for longer than the wait allows; the sender retries. */
class IngestBusyError extends Error {
    constructor(message, retryAfterSeconds) {
        super(message);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
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

/** The services a source covers, from the new `repoIds` or the older single `repoId` (null/absent: none). */
function scopeOf({ repoIds, repoId }) {
    if (repoIds !== undefined) return [...new Set(repoIds.map(Number))].sort((a, b) => a - b);
    return repoId === null || repoId === undefined ? [] : [Number(repoId)];
}

async function assertTrackedRepos(client, tenantId, repoIds) {
    if (!repoIds.length) return;
    const { rows } = await client.query('SELECT repo_id FROM tracked_repos WHERE tenant_id = $1 AND repo_id = ANY($2)', [tenantId, repoIds]);
    if (rows.length !== repoIds.length) throw new FlagSourceNotFoundError('That repository is not tracked');
}

/**
 * Inside withScope: replaces the services a source covers. `flag_sources.repo_id` keeps the first of them for
 * readers of the older single-component field.
 */
async function setSourceScope(client, tenantId, sourceId, repoIds) {
    await client.query('DELETE FROM flag_source_repos WHERE tenant_id = $1 AND source_id = $2', [tenantId, sourceId]);
    await client.query(
        'INSERT INTO flag_source_repos (tenant_id, source_id, repo_id) SELECT $1, $2, unnest($3::bigint[])',
        [tenantId, sourceId, repoIds]
    );
    await client.query('UPDATE flag_sources SET repo_id = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId, repoIds[0] ?? null]);
}

/** source id -> the repo ids it covers, for the whole tenant. */
async function sourceScopes(client, tenantId) {
    const { rows } = await client.query('SELECT source_id, repo_id FROM flag_source_repos WHERE tenant_id = $1 ORDER BY repo_id', [tenantId]);
    const scopes = new Map();
    for (const r of rows) {
        if (!scopes.has(r.source_id)) scopes.set(r.source_id, []);
        scopes.get(r.source_id).push(Number(r.repo_id));
    }
    return scopes;
}

function toSource(row, repoIds = []) {
    return {
        id: row.id, name: row.name, kind: row.kind, priority: row.priority, repoIds, repoId: repoIds[0] ?? null, createdAt: row.created_at,
        lastIngestAt: row.last_ingest_at, lastIngest: row.last_ingest,
        lastError: row.last_error_at ? { at: row.last_error_at, message: row.last_error } : null,
        origin: row.origin || 'push',
        code: row.code_config || null,
        endpoint: row.endpoint_config || null,
        hasEndpointToken: row.has_endpoint_token === true,
        oidc: row.oidc_config || null,
        ...(row.origin === 'endpoint' ? {
            pollIntervalMinutes: row.poll_interval_minutes ?? null,
            effectivePollIntervalMinutes: row.poll_interval_minutes ?? POLL.defaultMinutes,
            lastPolledAt: row.last_polled_at, nextPollAt: row.next_poll_at, pollFailures: row.poll_failures,
        } : {}),
        staleAfterMinutes: row.stale_after_minutes ?? null,
        effectiveStaleAfterMinutes: row.stale_after_minutes ?? STALE_AFTER_MINUTES[row.kind],
    };
}

const SOURCE_COLUMNS = 'id, name, kind, priority, repo_id, created_at, last_ingest_at, last_ingest, last_error, last_error_at, stale_after_minutes, origin, code_config, '
    + 'endpoint_config, endpoint_token_enc IS NOT NULL AS has_endpoint_token, poll_interval_minutes, last_polled_at, next_poll_at, poll_failures, oidc_config';

/** source id -> its environments' freshness (freshnessOf()), by environment name. */
async function sourceEnvironments(client, tenantId, sourceRows, now) {
    const { rows } = await client.query(
        'SELECT source_id, environment, last_observed_at, last_error_at FROM flag_source_envs WHERE tenant_id = $1 ORDER BY environment',
        [tenantId]
    );
    const byId = new Map(sourceRows.map((s) => [s.id, s]));
    const out = new Map(sourceRows.map((s) => [s.id, []]));
    for (const r of rows) {
        const s = byId.get(r.source_id);
        if (!s) continue;
        const errorAt = [r.last_error_at, s.last_error_at].filter(Boolean).sort((a, b) => b - a)[0] || null;
        out.get(r.source_id).push({
            env: r.environment,
            observedAt: r.last_observed_at,
            state: freshnessOf({ observedAt: r.last_observed_at, errorAt, staleAfterMinutes: s.stale_after_minutes ?? STALE_AFTER_MINUTES[s.kind], now }),
        });
    }
    return out;
}
// A refused message's reason is kept for Settings up to this length.
const MAX_ERROR_LENGTH = 500;
// A new token lasts this long unless the admin picks another lifetime or none ("never").
const DEFAULT_TOKEN_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// How long an ingest waits for the tenant's previous message before answering 503, and what it tells the sender.
const INGEST_LOCK_TIMEOUT_MS = 10_000;
const INGEST_RETRY_AFTER_SECONDS = 5;
// Postgres "lock_not_available": the lock_timeout above ran out.
const LOCK_NOT_AVAILABLE = '55P03';

/** @typedef {{ id: string, name: string, kind: string, priority: number, repoIds: number[], repoId: number|null, createdAt: Date, lastIngestAt: Date|null, lastIngest: { flags: number, changed: number, removed: number, stale: number }|null, lastError: { at: Date, message: string }|null }} FlagSource */

/**
 * Creates a flag source with its first token. Admins only. The token is returned once and never stored.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, name: string, kind: 'build'|'runtime', priority?: number, repoIds?: number[], repoId?: number|null, tokenExpiresInDays?: number|null, tokenEnvironments?: string[]|null, staleAfterMinutes?: number|null, origin?: 'push'|'code'|'endpoint', code?: object, endpoint?: object, endpointToken?: string|null, pollIntervalMinutes?: number|null, encryptionKey?: Buffer|null, sealingKeys?: { publicKey: object }|null }} input
 *   the first token's lifetime and environments, as for createIngestToken(); `staleAfterMinutes` null = the kind's default.
 *   `origin: 'code'` with `code` (checkCodeConfig()): a source ShipScope reads itself from one repository; it has no token.
 *   `origin: 'endpoint'` with `endpoint` (checkEndpointConfig()) and optionally the customer's `endpointToken`, sealed
 *   with `encryptionKey` (TOKEN_ENCRYPTION_KEY): a runtime source ShipScope polls (lib/endpoint-flags.js); no ingest token.
 *   `oidc` (checkOidcConfig(), push sources only): GitHub Actions runs of its services may send with an OIDC token.
 * @returns {Promise<{ source: FlagSource, token: { id: string, token: string, expiresAt: Date|null, environments: string[]|null } }>}
 * @throws {FlagSourceNotFoundError} a repo in its scope isn't tracked
 * @throws {FlagSourceConflictError} the name is taken
 */
async function createFlagSource(pool, { tenantId, actorUserId, name, kind, priority, repoIds, repoId, tokenExpiresInDays, tokenEnvironments = null, staleAfterMinutes = null, origin = 'push', code, endpoint, endpointToken, pollIntervalMinutes, oidc = null, encryptionKey = null, sealingKeys = null }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const scope = scopeOf({ repoIds, repoId });
        if (origin !== 'code' && code !== undefined) throw new FlagSourceConfigError('Only a source read from code has a file to read');
        const codeConfig = origin === 'code' ? checkCodeConfig(code, { kind, repoIds: scope }) : null;
        const endpointConfig = checkEndpointFields({ origin, kind, endpoint, endpointToken, pollIntervalMinutes, encryptionKey });
        const oidcConfig = oidc === null ? null : checkOidcConfig(oidc, { origin, repoIds: scope });
        if (endpointConfig) {
            const { rows: [{ n }] } = await client.query("SELECT count(*)::int AS n FROM flag_sources WHERE tenant_id = $1 AND origin = 'endpoint'", [tenantId]);
            if (n >= POLL.maxSources) throw new FlagSourceConfigError(`A workspace reads at most ${POLL.maxSources} endpoints`);
        }
        await assertTrackedRepos(client, tenantId, scope);
        let row = await saveSource(client, () => client.query(
            `INSERT INTO flag_sources (tenant_id, name, kind, priority, stale_after_minutes, origin, code_config, endpoint_config, poll_interval_minutes, oidc_config)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${SOURCE_COLUMNS}`,
            [tenantId, name, kind, priority ?? DEFAULT_PRIORITY[kind], staleAfterMinutes, origin, codeConfig, endpointConfig, pollIntervalMinutes ?? null, oidcConfig]
        ));
        await setSourceScope(client, tenantId, row.id, scope);
        row = { ...row, repo_id: scope[0] ?? null };
        if (endpointToken) {
            await client.query('UPDATE flag_sources SET endpoint_token_enc = $3 WHERE tenant_id = $1 AND id = $2',
                [tenantId, row.id, sealEndpointToken({ encryptionKey, sealingKeys }, endpointToken, endpointTokenAad(tenantId, row.id))]);
            row.has_endpoint_token = true;
            await recordAuditEvent(client, { tenantId, actorUserId, kind: 'endpoint_token_set', subject: name });
        }
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'flag_source_created', subject: name });
        if (codeConfig || endpointConfig) return { source: toSource(row, scope), token: null };
        const token = await insertToken(client, { tenantId, sourceId: row.id, actorUserId, expiresInDays: tokenExpiresInDays, environments: tokenEnvironments });
        return { source: toSource(row, scope), token };
    });
}

/**
 * Inside withScope: stores a new token for a source and returns it (the only time it is visible).
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, sourceId: string, actorUserId: string, expiresInDays?: number|null, environments?: string[]|null, now?: Date }} input
 *   `expiresInDays` undefined = DEFAULT_TOKEN_DAYS, null = never; `environments` null/undefined = every environment
 * @returns {Promise<{ id: string, token: string, expiresAt: Date|null, environments: string[]|null }>}
 */
async function insertToken(client, { tenantId, sourceId, actorUserId, expiresInDays, environments = null, now = new Date() }) {
    const days = expiresInDays === undefined ? DEFAULT_TOKEN_DAYS : expiresInDays;
    const expiresAt = days === null ? null : new Date(now.getTime() + days * DAY_MS);
    const scope = environments && environments.length ? [...new Set(environments)].sort() : null;
    const { token, tokenHash } = newToken();
    const { rows: [row] } = await client.query(
        'INSERT INTO ingest_tokens (token_hash, tenant_id, source_id, created_by, expires_at, environments) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [tokenHash, tenantId, sourceId, actorUserId, expiresAt, scope]
    );
    return { id: row.id, token, expiresAt, environments: scope };
}

/**
 * What binds a sealed endpoint token to its place (secret-box's associated data): the tenant, the source and the
 * purpose. A sealed value copied to another source, tenant or use fails to open.
 *
 * @param {string} tenantId
 * @param {string} sourceId
 * @returns {string}
 */
function endpointTokenAad(tenantId, sourceId) {
    return `${tenantId}/flag-source/${sourceId}/endpoint-token`;
}

/**
 * Seals a customer's endpoint token: for the worker alone when the sealing key pair is configured (lib/sealed-box.js,
 * the web service then cannot read it back), else with TOKEN_ENCRYPTION_KEY.
 *
 * @param {{ encryptionKey: Buffer|object, sealingKeys?: { publicKey: object }|null }} keys
 * @param {string} token
 * @param {string} aad endpointTokenAad()
 * @returns {string}
 */
function sealEndpointToken({ encryptionKey, sealingKeys }, token, aad) {
    return sealingKeys && sealingKeys.publicKey ? sealFor(sealingKeys.publicKey, token, aad) : seal(encryptionKey, token, aad);
}

/** The endpoint fields of a create/update: checked config for an endpoint source, else none may be given. */
function checkEndpointFields({ origin, kind, endpoint, endpointToken, pollIntervalMinutes, encryptionKey }) {
    if (origin !== 'endpoint') {
        if (endpoint !== undefined || endpointToken !== undefined || pollIntervalMinutes !== undefined) {
            throw new FlagSourceConfigError('Only a source read from an endpoint has an address, a token and a polling interval');
        }
        return null;
    }
    const config = checkEndpointConfig(endpoint, { kind });
    if (!encryptionKey) throw new FlagSourceConfigError('Reading flags from an endpoint needs TOKEN_ENCRYPTION_KEY on the server');
    return config;
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
 * Changes a source's name, kind, priority, the services it covers (`repoIds`; the older `repoId` sets one) or its
 * freshness threshold (`staleAfterMinutes`; left out = unchanged, null = the kind's default); for a source read from
 * code, its `code` (left out = unchanged; a change reads every environment again on the next pass); for one read from
 * an endpoint, its `endpoint` (left out = unchanged), `endpointToken` (left out = unchanged, null = none) and
 * `pollIntervalMinutes` (left out = unchanged, null = the default); saving one reads it at the next tick. For a push
 * source, `oidc` (left out = unchanged, null = off): whether GitHub Actions runs of its services may send. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, sourceId: string, name: string, kind: 'build'|'runtime', priority: number, repoIds?: number[], repoId?: number|null, staleAfterMinutes?: number|null, code?: object, endpoint?: object, endpointToken?: string|null, pollIntervalMinutes?: number|null, oidc?: { refs?: string[]|null, environments?: string[]|null }|null, encryptionKey?: Buffer|null, sealingKeys?: { publicKey: object }|null }} input
 * @returns {Promise<FlagSource>}
 * @throws {FlagSourceNotFoundError|FlagSourceConflictError}
 */
async function updateFlagSource(pool, { tenantId, actorUserId, sourceId, name, kind, priority, repoIds, repoId, staleAfterMinutes, code, endpoint, endpointToken, pollIntervalMinutes, oidc, encryptionKey = null, sealingKeys = null }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const scope = scopeOf({ repoIds, repoId });
        const { rows: [current] } = await client.query('SELECT origin, code_config, endpoint_config, oidc_config FROM flag_sources WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId]);
        if (!current) throw new FlagSourceNotFoundError('No such flag source');
        if (current.origin !== 'code' && code !== undefined) throw new FlagSourceConfigError('Only a source read from code has a file to read');
        const codeConfig = current.origin === 'code' ? checkCodeConfig(code ?? current.code_config, { kind, repoIds: scope }) : null;
        const endpointConfig = checkEndpointFields({ origin: current.origin, kind, endpoint: current.origin === 'endpoint' ? endpoint ?? current.endpoint_config : endpoint, endpointToken, pollIntervalMinutes, encryptionKey });
        // Left out: the stored settings, checked again against the new scope (no services = none to trust).
        const oidcWanted = oidc === undefined ? current.oidc_config : oidc;
        const oidcConfig = oidcWanted === null ? null : checkOidcConfig(oidcWanted, { origin: current.origin, repoIds: scope });
        await assertTrackedRepos(client, tenantId, scope);
        const sealed = typeof endpointToken === 'string' ? sealEndpointToken({ encryptionKey, sealingKeys }, endpointToken, endpointTokenAad(tenantId, sourceId)) : null;
        const row = await saveSource(client, () => client.query(
            `UPDATE flag_sources SET name = $3, kind = $4, priority = $5, repo_id = $6,
                 stale_after_minutes = CASE WHEN $7 THEN $8::integer ELSE stale_after_minutes END,
                 code_config = $9, endpoint_config = $10,
                 endpoint_token_enc = CASE WHEN $11 THEN $12::text ELSE endpoint_token_enc END,
                 poll_interval_minutes = CASE WHEN $13 THEN $14::integer ELSE poll_interval_minutes END,
                 next_poll_at = CASE WHEN origin = 'endpoint' THEN NULL ELSE next_poll_at END,
                 poll_failures = 0, oidc_config = $15
             WHERE tenant_id = $1 AND id = $2 RETURNING ${SOURCE_COLUMNS}`,
            [tenantId, sourceId, name, kind, priority, scope[0] ?? null, staleAfterMinutes !== undefined, staleAfterMinutes ?? null, codeConfig,
                endpointConfig, endpointToken !== undefined, sealed, pollIntervalMinutes !== undefined, pollIntervalMinutes ?? null, oidcConfig]
        ));
        if (!row) throw new FlagSourceNotFoundError('No such flag source');
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'flag_source_updated', subject: name });
        if (endpointToken !== undefined) {
            await recordAuditEvent(client, { tenantId, actorUserId, kind: endpointToken === null ? 'endpoint_token_removed' : 'endpoint_token_set', subject: name });
        }
        if (codeConfig && JSON.stringify(codeConfig) !== JSON.stringify(current.code_config)) {
            // A new file or reading: every environment is read again on the next pass.
            await client.query('UPDATE flag_source_envs SET last_ref = NULL WHERE tenant_id = $1 AND source_id = $2', [tenantId, sourceId]);
        }
        await setSourceScope(client, tenantId, sourceId, scope);
        return toSource(row, scope);
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
        const { rows } = await client.query('DELETE FROM flag_sources WHERE tenant_id = $1 AND id = $2 RETURNING name', [tenantId, sourceId]);
        if (rows.length) await recordAuditEvent(client, { tenantId, actorUserId, kind: 'flag_source_deleted', subject: rows[0].name });
        return rows.length === 1;
    });
}

/**
 * The tenant's flag sources with their status (last accepted message, last refused one, each environment's
 * freshness) and their tokens (never the tokens themselves). Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<FlagSource & { tokens: Array<{ id: string, createdAt: Date, lastUsedAt: Date|null, expiresAt: Date|null, environments: string[]|null }> }>>}
 */
async function listFlagSources(pool, { tenantId, actorUserId, now = new Date() }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: sources } = await client.query(`SELECT ${SOURCE_COLUMNS} FROM flag_sources WHERE tenant_id = $1 ORDER BY name`, [tenantId]);
        const scopes = await sourceScopes(client, tenantId);
        const envs = await sourceEnvironments(client, tenantId, sources, now);
        const { rows: tokens } = await client.query(
            'SELECT id, source_id, created_at, last_used_at, expires_at, environments FROM ingest_tokens WHERE tenant_id = $1 ORDER BY created_at',
            [tenantId]
        );
        return sources.map((s) => ({
            ...toSource(s, scopes.get(s.id) || []),
            environments: envs.get(s.id),
            tokens: tokens.filter((t) => t.source_id === s.id).map((t) => ({
                id: t.id, createdAt: t.created_at, lastUsedAt: t.last_used_at, expiresAt: t.expires_at, environments: t.environments,
            })),
        }));
    });
}

/**
 * Adds a token to a source (e.g. to rotate one). Admins only. It expires after `expiresInDays` (default
 * DEFAULT_TOKEN_DAYS, null = never) and may only send the listed `environments` (default: all).
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, sourceId: string, expiresInDays?: number|null, environments?: string[]|null }} input
 * @returns {Promise<{ id: string, token: string, expiresAt: Date|null, environments: string[]|null }>}
 * @throws {FlagSourceNotFoundError}
 */
async function createIngestToken(pool, { tenantId, actorUserId, sourceId, expiresInDays, environments = null }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: source } = await client.query('SELECT origin, name FROM flag_sources WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId]);
        if (!source.length) throw new FlagSourceNotFoundError('No such flag source');
        if (source[0].origin === 'code') throw new FlagSourceConfigError('A source read from code takes no token: ShipScope reads it from the repository');
        if (source[0].origin === 'endpoint') throw new FlagSourceConfigError('A source read from an endpoint takes no ingest token: ShipScope polls it');
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'ingest_token_created', subject: source[0].name });
        return insertToken(client, { tenantId, sourceId, actorUserId, expiresInDays, environments });
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
        const { rows } = await client.query(
            `DELETE FROM ingest_tokens t USING flag_sources s WHERE t.tenant_id = $1 AND t.id = $2 AND s.tenant_id = t.tenant_id AND s.id = t.source_id
             RETURNING s.name`,
            [tenantId, tokenId]
        );
        if (rows.length) await recordAuditEvent(client, { tenantId, actorUserId, kind: 'ingest_token_revoked', subject: rows[0].name });
        return rows.length === 1;
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
async function ingestFlags(pool, { token, payload, now = new Date(), lockTimeoutMs = INGEST_LOCK_TIMEOUT_MS }) {
    try {
        return await applyIngest(pool, { token, payload, now, lockTimeoutMs });
    } catch (err) {
        // Best effort: the sender gets its 400/401/403 either way.
        if (err instanceof IngestPayloadError || err instanceof IngestTokenExpiredError || err instanceof IngestScopeError) await recordIngestError(pool, { token, message: err.message, now }).catch(() => {});
        throw err;
    }
}

/**
 * Inside withScope: the token's row, found through the token's own RLS policy, after which the transaction works
 * under the token's tenant.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} token
 * @returns {Promise<{ tokenId: string, tenantId: string, sourceId: string, expiresAt: Date|null, environments: string[]|null }|null>} null for an unknown token
 */
async function resolveToken(client, token) {
    const { rows: found } = await client.query('SELECT id, tenant_id, source_id, expires_at, environments FROM ingest_tokens WHERE token_hash = $1', [hashToken(token)]);
    if (!found.length) return null;
    const { id: tokenId, tenant_id: tenantId, source_id: sourceId, expires_at: expiresAt, environments } = found[0];
    await setScope(client, { tenantId, ingestTokenHash: '' });
    return { tokenId, tenantId, sourceId, expiresAt, environments };
}

/**
 * Notes a refused message on its source, for Settings: the reason and when. Called after the ingest's own
 * transaction rolled back. An unknown token is nobody's: nothing is recorded.
 *
 * @param {import('pg').Pool} pool
 * @param {{ token: string, message: string, now?: Date }} input
 * @returns {Promise<void>}
 */
async function recordIngestError(pool, { token, message, now = new Date() }) {
    if (!TOKEN_PATTERN.test(token || '')) return;
    await withScope(pool, { ingestTokenHash: hashToken(token) }, async (client) => {
        const found = await resolveToken(client, token);
        if (!found) return;
        await client.query(
            'UPDATE flag_sources SET last_error = $3, last_error_at = $4 WHERE tenant_id = $1 AND id = $2',
            [found.tenantId, found.sourceId, String(message).slice(0, MAX_ERROR_LENGTH), now]
        );
    });
}

/**
 * Inside withScope: takes the tenant's flag-writing lock for the rest of the transaction. One writer per tenant at a
 * time (a pushed message, a file read from code), so two of one source can't interleave their full-state diffs. The
 * wait is bounded: a writer queued behind a slow one gives its pooled connection back instead of holding it, so a
 * flood of messages for one tenant can't use up the pool every other request needs.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} tenantId
 * @param {number} [lockTimeoutMs]
 * @returns {Promise<void>}
 * @throws {IngestBusyError} the wait ran out
 */
async function lockTenantFlags(client, tenantId, lockTimeoutMs = INGEST_LOCK_TIMEOUT_MS) {
    await client.query("SELECT set_config('lock_timeout', $1, true)", [`${Math.max(1, Math.floor(lockTimeoutMs))}ms`]);
    try {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('flags:' || $1, 0))", [tenantId]);
    } catch (err) {
        if (err.code === LOCK_NOT_AVAILABLE) {
            throw new IngestBusyError('Another flag message for this workspace is still being written; try again shortly', INGEST_RETRY_AFTER_SECONDS);
        }
        throw err;
    }
    await client.query("SELECT set_config('lock_timeout', '0', true)");
}

async function applyIngest(pool, { token, payload, now, lockTimeoutMs }) {
    if (!TOKEN_PATTERN.test(token || '')) throw new IngestTokenError('Invalid ingest token');
    return withScope(pool, { ingestTokenHash: hashToken(token) }, async (client) => {
        const found = await resolveToken(client, token);
        if (!found) throw new IngestTokenError('Invalid ingest token');
        const { tokenId, tenantId, sourceId } = found;
        if (found.expiresAt && found.expiresAt <= now) {
            throw new IngestTokenExpiredError(`Ingest token expired on ${found.expiresAt.toISOString().slice(0, 10)}; create a new one in Settings`);
        }
        await lockTenantFlags(client, tenantId, lockTimeoutMs);
        const { rows: [source] } = await client.query('SELECT name FROM flag_sources WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId]);
        const result = await applyMessage(client, {
            tenantId, sourceId, sourceName: source.name, payload, now, allowed: found.environments, refusal: (envs) => `This token may only send ${envs}`,
        });
        await client.query('UPDATE ingest_tokens SET last_used_at = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, tokenId, now]);
        return result;
    });
}

/**
 * Inside the tenant's scope and its flags lock: writes one checked message for a source, within the environments it
 * may send (`allowed`, null = all), and records it as the source's last accepted message.
 */
async function applyMessage(client, { tenantId, sourceId, sourceName, payload, now, allowed, refusal, sender = null }) {
    const { complete, environments, observations, metaByKey } = checkPayload(payload, now);
    const outside = allowed ? environments.filter((env) => !allowed.includes(env)) : [];
    if (outside.length) throw new IngestScopeError(`${refusal(allowed.join(', '))}, not ${outside.join(', ')}`);
    const changedBy = payload.changedBy || sourceName;
    const result = await applyObservations(client, { tenantId, sourceId, observations, metaByKey, complete, environments, changedBy, now });
    const summary = { flags: result.flags, changed: result.changed, removed: result.removed, stale: result.stale, ...(sender ? { sender } : {}) };
    await client.query('UPDATE flag_sources SET last_ingest_at = $3, last_ingest = $4 WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId, now, summary]);
    return { source: sourceName, flags: result.flags, changed: result.changed, removed: result.removed, stale: result.stale, created: result.created };
}

/**
 * Applies a message sent from a GitHub Actions run with an OIDC token (lib/github-oidc.js), already verified as
 * GitHub's and addressed to this server. The sender names the source (`X-ShipScope-Source: <tenantId>/<sourceId>`);
 * it must take OIDC tokens, cover the run's repository (by id) and allow its ref and the message's environments. An
 * unknown source, or one that takes no OIDC tokens, is refused like an unknown token (401, nothing recorded: the
 * caller is not known to be the source's); a run the source does not trust is a 403 noted on the source, so Settings
 * shows why.
 *
 * @param {import('pg').Pool} pool
 * @param {{ identity: { repository: string, repositoryId: number, ref: string|null }, tenantId: string, sourceId: string, payload: object, now?: Date, lockTimeoutMs?: number }} input
 * @returns {Promise<{ source: string, flags: number, changed: number, removed: number, stale: number, created: string[] }>}
 * @throws {IngestTokenError|IngestScopeError|IngestPayloadError|IngestBusyError}
 */
async function ingestWithOidc(pool, { identity, tenantId, sourceId, payload, now = new Date(), lockTimeoutMs = INGEST_LOCK_TIMEOUT_MS }) {
    const sender = `${identity.repository}${identity.ref ? `@${identity.ref}` : ''}`;
    try {
        return await withScope(pool, { tenantId }, async (client) => {
            const { rows: [source] } = await client.query(
                "SELECT name, oidc_config FROM flag_sources WHERE tenant_id = $1 AND id = $2 AND origin = 'push' AND oidc_config IS NOT NULL",
                [tenantId, sourceId]
            );
            if (!source) throw new IngestTokenError('This source takes no GitHub Actions tokens');
            const { rows: trusted } = await client.query(
                `SELECT 1 FROM flag_source_repos s JOIN tracked_repos r ON r.tenant_id = s.tenant_id AND r.repo_id = s.repo_id
                 WHERE s.tenant_id = $1 AND s.source_id = $2 AND s.repo_id = $3`,
                [tenantId, sourceId, identity.repositoryId]
            );
            if (!trusted.length) throw new IngestScopeError(`GitHub Actions of ${identity.repository} may not send for this source: it does not cover that repository`);
            if (!oidcRefAllowed(source.oidc_config.refs, identity.ref)) {
                throw new IngestScopeError(`GitHub Actions on ${identity.ref || 'no branch'} may not send for this source, only on ${source.oidc_config.refs.join(', ')}`);
            }
            await lockTenantFlags(client, tenantId, lockTimeoutMs);
            return applyMessage(client, {
                tenantId, sourceId, sourceName: source.name, payload, now, sender,
                allowed: source.oidc_config.environments, refusal: (envs) => 'GitHub Actions may only send ' + envs,
            });
        });
    } catch (err) {
        if (err instanceof IngestPayloadError || err instanceof IngestScopeError) {
            await recordSourceError(pool, { tenantId, sourceId, message: `${sender}: ${err.message}`, now }).catch(() => {});
        }
        throw err;
    }
}

/** Notes a refused message on its source (Settings shows it), after the refusing transaction rolled back. */
async function recordSourceError(pool, { tenantId, sourceId, message, now }) {
    await withScope(pool, { tenantId }, (client) => client.query(
        'UPDATE flag_sources SET last_error = $3, last_error_at = $4 WHERE tenant_id = $1 AND id = $2',
        [tenantId, sourceId, String(message).slice(0, MAX_ERROR_LENGTH), now]
    ));
}

/**
 * Inside withScope, under the tenant's ingest lock: writes one source's observations, whatever brought them (a
 * pushed message today; a file read at a deployed commit or a polled endpoint later, ADR-003). Values that changed
 * get a history entry, an older observation never undoes a newer one, and with `complete` every stored value of a
 * covered environment that is not listed is marked removed and the environment counts as confirmed now
 * (`flag_source_envs.last_observed_at`).
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, sourceId: string, observations: Array<{ key: string, env: string, state: string, rollout: number|null, changedAt: Date }>, metaByKey: Map<string, object>, complete: boolean, environments: string[], changedBy: string, now: Date }} input
 * @returns {Promise<{ flags: number, changed: number, removed: number, stale: number, created: string[] }>}
 */
async function applyObservations(client, { tenantId, sourceId, observations, metaByKey, complete, environments, changedBy, now }) {
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
    if (metaByKey.size) {
        // One statement for every described flag; a field the sender left out keeps its stored value.
        const meta = [...metaByKey].map(([key, m]) => ({
            key, has_description: 'description' in m, description: m.description ?? null, has_jira_keys: 'jiraKeys' in m, jira_keys: m.jiraKeys || [],
        }));
        await client.query(
            `UPDATE flags f SET description = CASE WHEN m.has_description THEN m.description ELSE f.description END,
                                jira_keys = CASE WHEN m.has_jira_keys THEN ARRAY(SELECT jsonb_array_elements_text(m.jira_keys)) ELSE f.jira_keys END
             FROM jsonb_to_recordset($2::jsonb) AS m(key text, has_description boolean, description text, has_jira_keys boolean, jira_keys jsonb)
             WHERE f.tenant_id = $1 AND f.key = m.key`,
            [tenantId, JSON.stringify(meta)]
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
    if (complete && environments.length) {
        await client.query(
            `INSERT INTO flag_source_envs (tenant_id, source_id, environment, last_observed_at)
             SELECT $1, $2, e, $4 FROM unnest($3::text[]) AS e
             ON CONFLICT (tenant_id, source_id, environment) DO UPDATE SET last_observed_at = EXCLUDED.last_observed_at`,
            [tenantId, sourceId, environments, now]
        );
    }

    return { flags: keys.length, changed: writes.length, removed: removals.length, stale, created: inserted.map((r) => r.key).sort() };
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
 * @returns {Promise<Array<{ key: string, description: string, senderDescription: string|null, manualDescription: string|null, links: { sender: string[], manual: string[], jira: string[] }, suggestions: string[], states: object, components: string[] }>>}
 * @throws {TenantNotFoundError}
 */
async function listFlags(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows: repos } = await client.query('SELECT repo_id, full_name FROM tracked_repos WHERE tenant_id = $1', [tenantId]);
        const names = new Map(repos.map((r) => [Number(r.repo_id), r.full_name.split('/').pop()]));
        const { flagsMeta, flagStates } = await readDashboardFlags(client, { tenantId, componentOf: (id) => names.get(id) });
        const { rows } = await client.query(
            'SELECT key, description, jira_keys, manual_description, manual_jira_keys, suggested_jira_keys FROM flags WHERE tenant_id = $1 ORDER BY key',
            [tenantId]
        );
        const fromJira = await jiraLinks(client, tenantId);
        return rows.filter((r) => flagsMeta[r.key]).map((r) => ({
            key: r.key,
            description: flagsMeta[r.key].description,
            senderDescription: r.description,
            manualDescription: r.manual_description,
            links: { sender: r.jira_keys, manual: r.manual_jira_keys, jira: fromJira.get(r.key) || [] },
            // Issues whose commits changed this flag in a flags file (lib/flag-link-suggestions.js), not linked yet.
            suggestions: r.suggested_jira_keys.filter((k) => ![...r.jira_keys, ...r.manual_jira_keys, ...(fromJira.get(r.key) || [])].includes(k)),
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
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'flag_details_changed', subject: key });
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
 * Also `flagStatesByComponent` (key -> env -> service -> the value that service runs, pickWinningValues()) and the
 * set of services some source covers (`coveredComponents`).
 *
 * And `flagFreshness` (service -> env -> how sure its values are, freshnessByComponent()).
 *
 * @returns {Promise<{ flagsMeta: object, flagStates: object, flagStatesByComponent: object, flagFreshness: object, flagStateHistory: object[], coveredComponents: Set<string> }>}
 */
async function readDashboardFlags(client, { tenantId, componentOf, now = new Date() }) {
    const { rows: sourceRows } = await client.query('SELECT id, name, kind, priority, stale_after_minutes, last_error_at FROM flag_sources WHERE tenant_id = $1', [tenantId]);
    const sources = sourceDescriptors(sourceRows, componentOf, await sourceScopes(client, tenantId));
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

    const { flagStates, byComponent, slotsOf, componentsOf } = pickWinningValues(values, sources);
    const flagsMeta = visibleFlagsMeta(flags, { slotsOf, componentsOf }, fromJira);
    const coveredComponents = new Set([...sources.values()].flatMap((s) => s.components));
    const envs = await sourceEnvironments(client, tenantId, sourceRows, now);
    const flagFreshness = freshnessByComponent([...sources].map(([id, s]) => ({ name: s.name, components: s.components, envs: envs.get(id) })));
    return { flagsMeta, flagStates, flagStatesByComponent: byComponent, flagFreshness, flagStateHistory: historyRecords(history, sources), coveredComponents };
}

/**
 * Notes that a source ShipScope reads itself (code, endpoint) could not be read for one environment: Settings and the
 * dashboard's "?" show it (freshnessOf() gives `error` until the next full confirmation). The flags stay as they were.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, sourceId: string, env: string, message: string, now: Date }} input
 *   `message` must be value-free: it is shown to admins as is
 * @returns {Promise<void>}
 */
async function recordSourceEnvError(pool, { tenantId, sourceId, env, message, now }) {
    await withScope(pool, { tenantId }, (client) => client.query(
        `INSERT INTO flag_source_envs (tenant_id, source_id, environment, last_error, last_error_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, source_id, environment) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at`,
        [tenantId, sourceId, env, String(message).slice(0, MAX_ERROR_LENGTH), now]
    ));
}

module.exports = {
    recordSourceEnvError,
    endpointTokenAad,
    sealEndpointToken,
    FlagNotFoundError,
    listFlags,
    setFlagDetails,
    TOKEN_PATTERN,
    IngestTokenError,
    IngestTokenExpiredError,
    IngestScopeError,
    IngestBusyError,
    IngestPayloadError,
    recordIngestError,
    FlagSourceNotFoundError,
    FlagSourceConflictError,
    FlagSourceConfigError,
    lockTenantFlags,
    applyObservations,
    createFlagSource,
    updateFlagSource,
    deleteFlagSource,
    listFlagSources,
    createIngestToken,
    revokeIngestToken,
    checkPayload,
    ingestFlags,
    ingestWithOidc,
    readDashboardFlags,
};
