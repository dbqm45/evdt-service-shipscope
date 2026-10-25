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
const { safeFetch, SafeFetchError } = require('./safe-fetch');
const { parseFlagFile, FlagFileError } = require('./flag-file-parser');
const { checkEndpointConfig, FlagSourceConfigError } = require('./flags-logic');
const { lockTenantFlags, applyObservations, recordSourceEnvError, endpointTokenAad, FlagSourceNotFoundError } = require('./flags');

const ENVS = ['test', 'qa', 'prod'];
const SIGNATURE_VERSION = 'v1';

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

/** The stored token of an endpoint source, opened; null without one. */
function openToken(row, { tenantId, encryptionKey }) {
    if (!row.endpoint_token_enc) return null;
    try {
        return open(encryptionKey, row.endpoint_token_enc, endpointTokenAad(tenantId, row.id));
    } catch (err) {
        if (err instanceof SecretBoxError) throw new FlagSourceConfigError('The stored endpoint token cannot be read (was TOKEN_ENCRYPTION_KEY changed?); enter it again');
        throw err;
    }
}

/**
 * "Test" in Settings: reads an endpoint configuration per environment, before or after it is saved, and returns only
 * the parsed flags (or why not). Nothing is stored. Admins only. Without `endpointToken` a saved source's own token
 * is used (`sourceId`); null tests without one.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, endpoint: object, endpointToken?: string|null, sourceId?: string, encryptionKey: Buffer|null, fetchImpl?: typeof safeFetch, now?: Date }} input
 * @returns {Promise<Array<{ env: string, host: string, flags?: Record<string, { state: string, rollout?: number }>, error?: string }>>}
 * @throws {FlagSourceConfigError|FlagSourceNotFoundError}
 */
async function testEndpoint(pool, { tenantId, actorUserId, endpoint, endpointToken, sourceId, encryptionKey, fetchImpl = safeFetch, now = new Date() }) {
    const config = checkEndpointConfig(endpoint, { kind: 'runtime' });
    if (!encryptionKey) throw new FlagSourceConfigError('Reading flags from an endpoint needs TOKEN_ENCRYPTION_KEY on the server');
    const { token, secret } = await withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const signing = await tenantSigningSecret(client, { tenantId, encryptionKey });
        if (endpointToken !== undefined || !sourceId) return { token: endpointToken ?? null, secret: signing };
        const { rows: [row] } = await client.query("SELECT id, endpoint_token_enc FROM flag_sources WHERE tenant_id = $1 AND id = $2 AND origin = 'endpoint'", [tenantId, sourceId]);
        if (!row) throw new FlagSourceNotFoundError('No such flag source');
        return { token: openToken(row, { tenantId, encryptionKey }), secret: signing };
    });
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

/**
 * Polls one endpoint source: each environment's address, its flags written as that environment's full state through
 * applyObservations() (changedAt = now: an endpoint says what is, not since when). A failed environment is recorded
 * on it and the others go on.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, sourceId: string, encryptionKey: Buffer, fetchImpl?: typeof safeFetch, now?: Date, log?: Function }} input
 * @returns {Promise<{ read: number, failed: number }|null>} null when there is no such endpoint source
 */
async function refreshEndpointSource(pool, { tenantId, sourceId, encryptionKey, fetchImpl = safeFetch, now = new Date(), log = () => {} }) {
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
        token = openToken(row, { tenantId, encryptionKey });
        secret = await withScope(pool, { tenantId }, (client) => tenantSigningSecret(client, { tenantId, encryptionKey }));
    } catch (err) {
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
        return tenantSigningSecret(client, { tenantId, encryptionKey });
    });
    return {
        secret,
        algorithm: 'HMAC-SHA256',
        signedText: '<X-ShipScope-Timestamp>.GET.<the full URL>',
        headers: ['X-ShipScope-Timestamp', `X-ShipScope-Signature (${SIGNATURE_VERSION}=<hex>)`],
    };
}

module.exports = { signingSecret, signingSecretAad, tenantSigningSecret, signatureHeaders, testEndpoint, refreshEndpointSource, endpointSigning };
