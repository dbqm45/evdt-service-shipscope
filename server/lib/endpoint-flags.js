// Flags from an endpoint (ADR-003, ROADMAP increment 4): a runtime flag source ShipScope polls itself, at the https
// address the customer gave per environment, with their read-only token.
//
// - Every request goes through lib/safe-fetch.js (https:443, public addresses only, pinned, no redirects, limits).
// - Each request is signed for the tenant (signatureHeaders()), so the customer's endpoint can tell ShipScope's calls
//   from anyone else's: `X-ShipScope-Timestamp` and `X-ShipScope-Signature: v1=<hex HMAC-SHA256>` over
//   `<timestamp>.GET.<url>`, with the tenant's signing secret (tenantSigningSecret(): stored sealed in
//   `tenants.endpoint_signing_secret_enc`, first filled with signingSecret(); shown to admins in Settings).
// - The answer is read like a file of its format (lib/flag-file-parser.js, isolated, value-free errors); it states
//   the full set of flags for that environment, so a flag no longer listed is marked removed.
// - A failed read is an error on that environment, never a removal; the flags stay and the dashboard shows the doubt.
// - "Test" (testEndpoint()) returns only the parsed flags, never the answer itself.
const crypto = require('crypto');
const { withScope } = require('./scope');
const { assertAdmin } = require('./tenants');
const { open, seal, keyRing, SecretBoxError } = require('./secret-box');
const { openWith, isSealedFor, SealedBoxError } = require('./sealed-box');
const { requestSync } = require('./webhooks');
const { safeFetch, SafeFetchError } = require('./safe-fetch');
const { parseFlagFile, FlagFileError } = require('./flag-file-parser');
const { checkEndpointConfig, FlagSourceConfigError } = require('./flags-logic');
const { recordAuditEvent } = require('./audit-log');
const { lockTenantFlags, applyObservations, recordSourceEnvError, endpointTokenAad, FlagSourceNotFoundError } = require('./flags');

const ENVS = ['test', 'qa', 'prod'];
const SIGNATURE_VERSION = 'v1';
// How a customer's endpoint checks a signature, returned with the secret.
const SIGNING_SCHEME = {
    algorithm: 'HMAC-SHA256',
    signedText: '<X-ShipScope-Timestamp>.GET.<the full URL>',
    headers: ['X-ShipScope-Timestamp', `X-ShipScope-Signature (${SIGNATURE_VERSION}=<hex>)`],
};

/**
 * A tenant's first signing secret, derived from the key (HKDF-SHA256, the tenant id in the info): what versions before
 * the stored secret used, so a secret a customer already configured stays the same once stored. During a rotation it
 * derives from the oldest previous key (the list is newest first), the one such a secret came from.
 *
 * @param {Buffer|{ current: Buffer, previous: Buffer[] }} encryptionKey
 * @param {string} tenantId
 * @returns {string} 64 hex characters
 */
function signingSecret(encryptionKey, tenantId) {
    const ring = keyRing(encryptionKey);
    const key = ring.previous.length ? ring.previous[ring.previous.length - 1] : ring.current;
    return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), `shipscope flag-endpoint signing ${tenantId}`, 32)).toString('hex');
}

/** What binds a tenant's sealed signing secret to its place. */
function signingSecretAad(tenantId) {
    return `${tenantId}/endpoint-signing`;
}

/**
 * Inside withScope: the tenant's signing secret, stored sealed; the first call stores signingSecret()'s value.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, encryptionKey: Buffer|{ current: Buffer, previous: Buffer[] } }} input
 * @returns {Promise<string>}
 * @throws {FlagSourceConfigError} the stored one cannot be opened with any key
 */
async function tenantSigningSecret(client, { tenantId, encryptionKey }) {
    let { rows: [row] } = await client.query('SELECT endpoint_signing_secret_enc FROM tenants WHERE id = $1', [tenantId]);
    if (row && !row.endpoint_signing_secret_enc) {
        // Two first calls at once: the second one's UPDATE finds a value and keeps it.
        await client.query('UPDATE tenants SET endpoint_signing_secret_enc = $2 WHERE id = $1 AND endpoint_signing_secret_enc IS NULL',
            [tenantId, seal(encryptionKey, signingSecret(encryptionKey, tenantId), signingSecretAad(tenantId))]);
        ({ rows: [row] } = await client.query('SELECT endpoint_signing_secret_enc FROM tenants WHERE id = $1', [tenantId]));
    }
    if (!row) throw new FlagSourceConfigError('No such workspace');
    try {
        return open(encryptionKey, row.endpoint_signing_secret_enc, signingSecretAad(tenantId));
    } catch (err) {
        if (err instanceof SecretBoxError) throw new FlagSourceConfigError('The stored signing secret cannot be read (was TOKEN_ENCRYPTION_KEY changed without TOKEN_ENCRYPTION_KEY_PREVIOUS?)');
        throw err;
    }
}

/**
 * The headers that sign one request: the customer recomputes the HMAC over `<timestamp>.GET.<url>` with the secret
 * and refuses a mismatch or an old timestamp.
 *
 * @param {{ secret: string, url: string, now: Date }} input
 * @returns {{ 'x-shipscope-timestamp': string, 'x-shipscope-signature': string }}
 */
function signatureHeaders({ secret, url, now }) {
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.GET.${url}`).digest('hex');
    return { 'x-shipscope-timestamp': timestamp, 'x-shipscope-signature': `${SIGNATURE_VERSION}=${mac}` };
}

/** One environment's flags from its address: fetched, checked and parsed; errors are value-free. */
async function readEndpoint({ endpoint, env, token, secret, now, fetchImpl }) {
    const url = endpoint.urls[env];
    const host = new URL(url).hostname;
    const headers = { ...signatureHeaders({ secret, url, now }) };
    if (token) headers[endpoint.tokenHeader || 'authorization'] = endpoint.tokenHeader ? token : `Bearer ${token}`;
    const res = await fetchImpl(url, { headers });
    if (res.status < 200 || res.status >= 300) throw new FlagFileError(`${host} answered HTTP ${res.status}`);
    const format = endpoint.format || (/yaml/i.test(res.contentType) ? 'yaml' : 'json');
    return parseFlagFile({ text: res.body, fileName: host, format, options: endpoint });
}

/** A failure as the admin sees it: ours and the parser's are value-free; anything else says only that it failed. */
function readError(err, url) {
    if (err instanceof SafeFetchError || err instanceof FlagFileError) return err.message;
    return `${new URL(url).hostname}: could not be read`;
}

/** A stored token sealed for the worker, asked for where only the public key is (the web service). */
class TokenOnWorkerError extends Error {}

/**
 * The stored token of an endpoint source, opened; null without one. A token sealed for the worker
 * (lib/sealed-box.js) opens only with `sealingKeys.privateKeys`.
 *
 * @throws {TokenOnWorkerError} sealed for the worker, and no private key here
 * @throws {FlagSourceConfigError} no key opens it
 */
function openToken(row, { tenantId, encryptionKey, sealingKeys = null }) {
    if (!row.endpoint_token_enc) return null;
    const aad = endpointTokenAad(tenantId, row.id);
    try {
        if (isSealedFor(row.endpoint_token_enc)) {
            if (!sealingKeys || !sealingKeys.privateKeys.length) throw new TokenOnWorkerError('Only the worker can read this token');
            return openWith(sealingKeys.privateKeys, row.endpoint_token_enc, aad);
        }
        return open(encryptionKey, row.endpoint_token_enc, aad);
    } catch (err) {
        if (err instanceof SecretBoxError || err instanceof SealedBoxError) {
            throw new FlagSourceConfigError('The stored endpoint token cannot be read (was a key changed without its previous one?); enter it again');
        }
        throw err;
    }
}

/** Each configured environment's reading, for "Test": host, then the parsed flags or why not. */
async function runEndpointTest({ config, token, secret, now, fetchImpl }) {
    const out = [];
    for (const env of ENVS.filter((e) => config.urls[e])) {
        const host = new URL(config.urls[env]).hostname;
        try {
            out.push({ env, host, flags: await readEndpoint({ endpoint: config, env, token, secret, now, fetchImpl }) });
        } catch (err) {
            out.push({ env, host, error: readError(err, config.urls[env]) });
        }
    }
    return out;
}

// How long a queued test is kept for Settings to read back.
const TEST_KEEP_HOURS = 24;

/**
 * "Test" in Settings: reads an endpoint configuration per environment, before or after it is saved, and returns only
 * the parsed flags (or why not). Nothing is stored. Admins only. Without `endpointToken` a saved source's own token
 * is used (`sourceId`); null tests without one. A stored token only the worker can read is tested there: the test is
 * queued (`{ pending: true, testId }`) and its result read with endpointTestResult().
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, endpoint: object, endpointToken?: string|null, sourceId?: string, encryptionKey: Buffer|null, sealingKeys?: object|null, fetchImpl?: typeof safeFetch, now?: Date }} input
 * @returns {Promise<{ envs: Array<{ env: string, host: string, flags?: Record<string, { state: string, rollout?: number }>, error?: string }> }|{ pending: true, testId: string }>}
 * @throws {FlagSourceConfigError|FlagSourceNotFoundError}
 */
async function testEndpoint(pool, { tenantId, actorUserId, endpoint, endpointToken, sourceId, encryptionKey, sealingKeys = null, fetchImpl = safeFetch, now = new Date() }) {
    const config = checkEndpointConfig(endpoint, { kind: 'runtime' });
    if (!encryptionKey) throw new FlagSourceConfigError('Reading flags from an endpoint needs TOKEN_ENCRYPTION_KEY on the server');
    const prepared = await withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const signing = await tenantSigningSecret(client, { tenantId, encryptionKey });
        if (endpointToken !== undefined || !sourceId) return { token: endpointToken ?? null, secret: signing };
        const { rows: [row] } = await client.query("SELECT id, endpoint_token_enc FROM flag_sources WHERE tenant_id = $1 AND id = $2 AND origin = 'endpoint'", [tenantId, sourceId]);
        if (!row) throw new FlagSourceNotFoundError('No such flag source');
        try {
            return { token: openToken(row, { tenantId, encryptionKey, sealingKeys }), secret: signing };
        } catch (err) {
            if (!(err instanceof TokenOnWorkerError)) throw err;
            await client.query("DELETE FROM endpoint_tests WHERE tenant_id = $1 AND requested_at < now() - make_interval(hours => $2)", [tenantId, TEST_KEEP_HOURS]);
            const { rows: [test] } = await client.query(
                'INSERT INTO endpoint_tests (tenant_id, source_id, endpoint_config, requested_by) VALUES ($1, $2, $3, $4) RETURNING id',
                [tenantId, sourceId, config, actorUserId]
            );
            return { queued: test.id };
        }
    });
    if (prepared.queued) {
        await requestSync(pool, { source: 'endpoint-test', keys: [`${tenantId}/${prepared.queued}`] });
        return { pending: true, testId: prepared.queued };
    }
    return { envs: await runEndpointTest({ config, token: prepared.token, secret: prepared.secret, now, fetchImpl }) };
}

/**
 * A queued test's result, for Settings to read back: pending until the worker ran it. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, testId: string }} input
 * @returns {Promise<{ status: 'pending' } | { status: 'done', envs: object[] }>}
 * @throws {FlagSourceNotFoundError} no such test (or older than a day)
 */
async function endpointTestResult(pool, { tenantId, actorUserId, testId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [row] } = await client.query('SELECT finished_at, result FROM endpoint_tests WHERE tenant_id = $1 AND id = $2', [tenantId, testId]);
        if (!row) throw new FlagSourceNotFoundError('No such test');
        return row.finished_at ? { status: 'done', envs: row.result } : { status: 'pending' };
    });
}

/**
 * The worker's side of a queued test: opens the source's token with the private key, reads every address and stores
 * the parsed flags (or why not). A test whose source is gone is dropped.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, testId: string, encryptionKey: object, sealingKeys: object|null, fetchImpl?: typeof safeFetch, now?: Date }} input
 * @returns {Promise<boolean>} whether a test was run
 */
async function runQueuedEndpointTest(pool, { tenantId, testId, encryptionKey, sealingKeys, fetchImpl = safeFetch, now = new Date() }) {
    const prepared = await withScope(pool, { tenantId }, async (client) => {
        const { rows: [test] } = await client.query(
            `SELECT t.endpoint_config, s.id, s.endpoint_token_enc FROM endpoint_tests t
             JOIN flag_sources s ON s.tenant_id = t.tenant_id AND s.id = t.source_id
             WHERE t.tenant_id = $1 AND t.id = $2 AND t.finished_at IS NULL`,
            [tenantId, testId]
        );
        if (!test) return null;
        const secret = await tenantSigningSecret(client, { tenantId, encryptionKey });
        try {
            return { config: test.endpoint_config, token: openToken(test, { tenantId, encryptionKey, sealingKeys }), secret };
        } catch (err) {
            if (!(err instanceof FlagSourceConfigError || err instanceof TokenOnWorkerError)) throw err;
            return { config: test.endpoint_config, error: err.message };
        }
    });
    if (!prepared) return false;
    const envs = prepared.error
        ? ENVS.filter((e) => prepared.config.urls[e]).map((env) => ({ env, host: new URL(prepared.config.urls[env]).hostname, error: prepared.error }))
        : await runEndpointTest({ config: prepared.config, token: prepared.token, secret: prepared.secret, now, fetchImpl });
    await withScope(pool, { tenantId }, (client) => client.query(
        'UPDATE endpoint_tests SET finished_at = $3, result = $4 WHERE tenant_id = $1 AND id = $2',
        [tenantId, testId, now, JSON.stringify(envs)]
    ));
    return true;
}

/**
 * Polls one endpoint source: each environment's address, its flags written as that environment's full state through
 * applyObservations() (changedAt = now: an endpoint says what is, not since when). A failed environment is recorded
 * on it and the others go on.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, sourceId: string, encryptionKey: Buffer, sealingKeys?: object|null, fetchImpl?: typeof safeFetch, now?: Date, log?: Function }} input
 *   `sealingKeys`: the worker's private keys, for tokens sealed for it
 * @returns {Promise<{ read: number, failed: number }|null>} null when there is no such endpoint source
 */
async function refreshEndpointSource(pool, { tenantId, sourceId, encryptionKey, sealingKeys = null, fetchImpl = safeFetch, now = new Date(), log = () => {} }) {
    const row = await withScope(pool, { tenantId }, async (client) => {
        const { rows } = await client.query(
            "SELECT id, name, endpoint_config, endpoint_token_enc FROM flag_sources WHERE tenant_id = $1 AND id = $2 AND origin = 'endpoint'",
            [tenantId, sourceId]
        );
        return rows[0] || null;
    });
    if (!row) return null;
    const endpoint = row.endpoint_config;
    const envs = ENVS.filter((e) => endpoint.urls[e]);
    const totals = { read: 0, failed: 0 };
    let token;
    let secret;
    try {
        token = openToken(row, { tenantId, encryptionKey, sealingKeys });
        secret = await withScope(pool, { tenantId }, (client) => tenantSigningSecret(client, { tenantId, encryptionKey }));
    } catch (err) {
        // Recorded like an unreadable token: the environments show why until the worker has its private key.
        if (err instanceof TokenOnWorkerError) err = new FlagSourceConfigError('The endpoint token is sealed for the worker: set SECRETS_PRIVATE_KEY on it');
        if (!(err instanceof FlagSourceConfigError)) throw err;
        for (const env of envs) await recordSourceEnvError(pool, { tenantId, sourceId, env, message: err.message, now });
        log(`flags not read from endpoint source ${row.name}: ${err.message}`, { level: 'warn', tenantId, source: row.name, reason: err.message });
        return { read: 0, failed: envs.length };
    }
    for (const env of envs) {
        const host = new URL(endpoint.urls[env]).hostname;
        const fields = { tenantId, source: row.name, env, host };
        try {
            const flags = await readEndpoint({ endpoint, env, token, secret, now, fetchImpl });
            const observations = Object.entries(flags).map(([key, v]) => ({ key, env, state: v.state, rollout: v.rollout ?? null, changedAt: now }));
            const result = await withScope(pool, { tenantId }, async (client) => {
                await lockTenantFlags(client, tenantId);
                const written = await applyObservations(client, {
                    tenantId, sourceId, observations, metaByKey: new Map(), complete: true, environments: [env], changedBy: `endpoint ${host}`, now,
                });
                await client.query(
                    'UPDATE flag_source_envs SET last_error = NULL, last_error_at = NULL WHERE tenant_id = $1 AND source_id = $2 AND environment = $3',
                    [tenantId, sourceId, env]
                );
                const summary = { flags: written.flags, changed: written.changed, removed: written.removed, stale: written.stale };
                await client.query('UPDATE flag_sources SET last_ingest_at = $3, last_ingest = $4 WHERE tenant_id = $1 AND id = $2', [tenantId, sourceId, now, summary]);
                return summary;
            });
            totals.read += 1;
            log(`flags read from ${host} (${env})`, { ...fields, ...result });
        } catch (err) {
            totals.failed += 1;
            const message = readError(err, endpoint.urls[env]);
            await recordSourceEnvError(pool, { tenantId, sourceId, env, message, now });
            log(`flags not read from ${host} (${env}): ${message}`, { level: 'warn', ...fields, reason: message });
        }
    }
    return totals;
}

/**
 * How a tenant's endpoint verifies ShipScope's requests: the signing secret and the scheme. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, encryptionKey: Buffer|null }} input
 * @returns {Promise<{ secret: string, algorithm: 'HMAC-SHA256', signedText: string, headers: string[] }>}
 * @throws {FlagSourceConfigError} without TOKEN_ENCRYPTION_KEY
 */
async function endpointSigning(pool, { tenantId, actorUserId, encryptionKey }) {
    if (!encryptionKey) throw new FlagSourceConfigError('Reading flags from an endpoint needs TOKEN_ENCRYPTION_KEY on the server');
    const secret = await withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'signing_secret_viewed' });
        return tenantSigningSecret(client, { tenantId, encryptionKey });
    });
    return { secret, ...SIGNING_SCHEME };
}

/**
 * Replaces the workspace's signing secret with a new random one (a leaked secret, a staff change). From then on every
 * request is signed with the new one only: until the customer's endpoint has it, it refuses ShipScope's reads, which
 * show as errors and keep the flags. Admins only; returned once, like endpointSigning().
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, encryptionKey: Buffer|{ current: Buffer, previous: Buffer[] }|null }} input
 * @returns {Promise<{ secret: string, algorithm: 'HMAC-SHA256', signedText: string, headers: string[] }>}
 * @throws {FlagSourceConfigError} without TOKEN_ENCRYPTION_KEY
 */
async function rotateSigningSecret(pool, { tenantId, actorUserId, encryptionKey }) {
    if (!encryptionKey) throw new FlagSourceConfigError('Reading flags from an endpoint needs TOKEN_ENCRYPTION_KEY on the server');
    const secret = crypto.randomBytes(32).toString('hex');
    await withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        await client.query('UPDATE tenants SET endpoint_signing_secret_enc = $2 WHERE id = $1', [tenantId, seal(encryptionKey, secret, signingSecretAad(tenantId))]);
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'signing_secret_rotated' });
    });
    return { secret, ...SIGNING_SCHEME };
}

module.exports = { endpointTestResult, runQueuedEndpointTest, TokenOnWorkerError, rotateSigningSecret, signingSecret, signingSecretAad, tenantSigningSecret, signatureHeaders, testEndpoint, refreshEndpointSource, endpointSigning };
