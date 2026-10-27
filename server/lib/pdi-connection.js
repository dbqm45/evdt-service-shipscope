// The connection with pdi (design-docs/PDI-CONNECTION-PLAN.pl.md): an admin gives pdi's receiver address, and one
// transaction creates the service token pdi reads ShipScope with, the event subscription to pdi with its own signing
// secret, and the connection itself; the token and secret are shown once, as the variables pdi reads. The state comes
// from what each side proved (lib/pdi-connection-model.js): pdi used the token, ShipScope reached pdi with a signed
// ping (the worker's pdiPingTick(), hourly, and Settings' Test) or a delivered event.
const crypto = require('crypto');
const { withScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');
const { recordAuditEvent } = require('./audit-log');
const { seal } = require('./secret-box');
const { checkUrl, SafeFetchError } = require('./safe-fetch');
const { insertServiceToken, withServiceToken } = require('./service-api');
const { EVENT_TYPES } = require('./release-events-model');
const { eventSignature, subscriptionSecretAad, subscriptionSigningSecret } = require('./outgoing-events');
const { judgePdiConnection } = require('./pdi-connection-model');

/** pdi-receiver's path for ShipScope (dbqm45/pdi src/pdi/receiver.py). */
const RECEIVER_PATH = '/events/shipscope';
const ERROR_MAX = 300;

class PdiConnectionError extends Error {}
class PdiConnectionConflictError extends Error {}
class NoPdiConnectionError extends Error {}

/** The receiver's base address, checked like every address a customer gives (https, public). */
function receiverBase(raw) {
    let url;
    try {
        url = checkUrl(String(raw).trim());
    } catch (err) {
        if (err instanceof SafeFetchError) throw new PdiConnectionError(err.message);
        throw err;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(new RegExp(`${RECEIVER_PATH}$`), '')}`;
}

/**
 * The connection's state as Settings shows it, inside withScope.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, now?: Date }} input
 * @returns {Promise<ReturnType<typeof judgePdiConnection>>}
 */
async function readPdiConnection(client, { tenantId, now = new Date() }) {
    const { rows: [connection] } = await client.query('SELECT * FROM pdi_connections WHERE tenant_id = $1', [tenantId]);
    if (!connection || connection.disconnected_at) return judgePdiConnection({ connection: connection || null, tokenLastUsedAt: null, subscription: null, now });
    const { rows: [token] } = await client.query('SELECT last_used_at FROM service_tokens WHERE tenant_id = $1 AND id = $2', [tenantId, connection.service_token_id]);
    const { rows: [subscription] } = await client.query('SELECT last_delivered_at, last_error, last_error_at FROM event_subscriptions WHERE tenant_id = $1 AND id = $2', [tenantId, connection.subscription_id]);
    return judgePdiConnection({ connection, tokenLastUsedAt: token ? token.last_used_at : null, subscription: subscription || null, now });
}

/**
 * The state for a member of the workspace.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, now?: Date }} input
 * @returns {Promise<ReturnType<typeof judgePdiConnection>>}
 * @throws {TenantNotFoundError} not a member
 */
async function getPdiConnection(pool, { tenantId, actorUserId, now = new Date() }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        return readPdiConnection(client, { tenantId, now });
    });
}

/**
 * Connects the workspace with pdi. Admins only; audited (the receiver's host, never a secret). The variables pdi
 * needs are in the answer only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, receiverUrl: string, publicBaseUrl: string, encryptionKey: Buffer|object|null, now?: Date }} input
 * @returns {Promise<{ connection: ReturnType<typeof judgePdiConnection>, env: { PDI_SHIPSCOPE_URL: string, PDI_SHIPSCOPE_TOKEN: string, PDI_SHIPSCOPE_SIGNING_SECRET: string } }>}
 * @throws {PdiConnectionError|PdiConnectionConflictError}
 */
async function connectPdi(pool, { tenantId, actorUserId, receiverUrl, publicBaseUrl, encryptionKey, now = new Date() }) {
    if (!encryptionKey) throw new PdiConnectionError('This server cannot connect pdi: TOKEN_ENCRYPTION_KEY is not set');
    if (!publicBaseUrl) throw new PdiConnectionError('This server cannot connect pdi: PUBLIC_BASE_URL is not set');
    const base = receiverBase(receiverUrl);
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [existing] } = await client.query('SELECT disconnected_at FROM pdi_connections WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
        if (existing && !existing.disconnected_at) throw new PdiConnectionConflictError('This workspace is already connected with pdi; disconnect it first');
        const token = await insertServiceToken(client, { tenantId, actorUserId, name: 'pdi', lifetimeDays: null, now });
        const secret = crypto.randomBytes(32).toString('base64url');
        const { rows: [sub] } = await client.query(
            'INSERT INTO event_subscriptions (tenant_id, url, types, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
            [tenantId, `${base}${RECEIVER_PATH}`, EVENT_TYPES, actorUserId]
        );
        await client.query('UPDATE event_subscriptions SET signing_secret_enc = $3 WHERE tenant_id = $1 AND id = $2',
            [tenantId, sub.id, seal(encryptionKey, secret, subscriptionSecretAad(tenantId, sub.id))]);
        await client.query(
            `INSERT INTO pdi_connections (tenant_id, receiver_url, service_token_id, subscription_id, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id) DO UPDATE SET receiver_url = $2, service_token_id = $3, subscription_id = $4, created_by = $5, created_at = $6,
                 last_ping_ok_at = NULL, last_ping_error = NULL, last_ping_error_at = NULL, disconnected_at = NULL`,
            [tenantId, base, token.id, sub.id, actorUserId, now]
        );
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'pdi_connected', subject: new URL(base).host });
        return {
            connection: await readPdiConnection(client, { tenantId, now }),
            env: { PDI_SHIPSCOPE_URL: publicBaseUrl, PDI_SHIPSCOPE_TOKEN: token.token, PDI_SHIPSCOPE_SIGNING_SECRET: secret },
        };
    });
}

/**
 * Disconnects: the token is revoked and the subscription removed with what waits for it; the connection's row stays,
 * marked disconnected. Admins only; audited.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, now?: Date }} input
 * @returns {Promise<boolean>} whether there was an active connection
 */
async function disconnectPdi(pool, { tenantId, actorUserId, now = new Date() }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [connection] } = await client.query('SELECT * FROM pdi_connections WHERE tenant_id = $1 AND disconnected_at IS NULL FOR UPDATE', [tenantId]);
        if (!connection) return false;
        await client.query('DELETE FROM service_tokens WHERE tenant_id = $1 AND id = $2', [tenantId, connection.service_token_id]);
        await client.query('DELETE FROM event_subscriptions WHERE tenant_id = $1 AND id = $2', [tenantId, connection.subscription_id]);
        await client.query('UPDATE pdi_connections SET disconnected_at = $2 WHERE tenant_id = $1', [tenantId, now]);
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'pdi_disconnected', subject: new URL(connection.receiver_url).host });
        return true;
    });
}

/**
 * One signed ping to pdi: `GET <receiver>/events/shipscope` with `X-ShipScope-Event: ping` and the subscription's
 * signature over an empty body; the result is kept on the connection.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, encryptionKey: Buffer|object, fetchImpl: Function, now?: Date }} input
 * @returns {Promise<boolean|null>} reached pdi; null without an active connection
 */
async function pingPdi(pool, { tenantId, encryptionKey, fetchImpl, now = new Date() }) {
    const target = await withScope(pool, { tenantId }, async (client) => {
        const { rows: [connection] } = await client.query('SELECT receiver_url, subscription_id FROM pdi_connections WHERE tenant_id = $1 AND disconnected_at IS NULL', [tenantId]);
        if (!connection) return null;
        const { rows: [sub] } = await client.query('SELECT signing_secret_enc FROM event_subscriptions WHERE tenant_id = $1 AND id = $2', [tenantId, connection.subscription_id]);
        if (!sub || !sub.signing_secret_enc) return { missing: true };
        const secret = await subscriptionSigningSecret(client, { tenantId, encryptionKey, subscriptionId: connection.subscription_id });
        return { url: `${connection.receiver_url}${RECEIVER_PATH}`, secret };
    });
    if (!target) return null;
    if (target.missing) {
        await withScope(pool, { tenantId }, (client) => client.query('UPDATE pdi_connections SET last_ping_error = $2, last_ping_error_at = $3 WHERE tenant_id = $1',
            [tenantId, 'The connection\'s event subscription is gone; disconnect and connect pdi again', now]));
        return false;
    }
    const timestamp = String(Math.floor(now.getTime() / 1000));
    let error = null;
    try {
        const res = await fetchImpl(target.url, {
            method: 'GET',
            headers: { 'x-shipscope-timestamp': timestamp, 'x-shipscope-event': 'ping', 'x-shipscope-signature': eventSignature({ secret: target.secret, timestamp, body: '' }) },
        });
        if (res.status < 200 || res.status >= 300) error = `${new URL(target.url).host} answered HTTP ${res.status}`;
    } catch (err) {
        error = String(err && err.message ? err.message : err).slice(0, ERROR_MAX);
    }
    await withScope(pool, { tenantId }, (client) => (error
        ? client.query('UPDATE pdi_connections SET last_ping_error = $2, last_ping_error_at = $3 WHERE tenant_id = $1', [tenantId, error, now])
        : client.query('UPDATE pdi_connections SET last_ping_ok_at = $2, last_ping_error = NULL, last_ping_error_at = NULL WHERE tenant_id = $1', [tenantId, now])));
    return !error;
}

/**
 * Pings every active connection (the worker, hourly). Never throws for one tenant.
 *
 * @param {import('pg').Pool} pool
 * @param {{ encryptionKey: Buffer|object, fetchImpl: Function, now?: Date, log?: Function }} input
 * @returns {Promise<{ pinged: number, failed: number }>}
 */
async function pingPdiConnections(pool, { encryptionKey, fetchImpl, now = new Date(), log = () => {} }) {
    const totals = { pinged: 0, failed: 0 };
    const { rows: tenants } = await pool.query('SELECT id FROM tenants ORDER BY created_at');
    for (const { id: tenantId } of tenants) {
        try {
            const ok = await pingPdi(pool, { tenantId, encryptionKey, fetchImpl, now });
            if (ok === null) continue;
            totals.pinged += 1;
            if (!ok) totals.failed += 1;
        } catch (err) {
            totals.failed += 1;
            log('pdi ping failed', { level: 'warn', tenantId, err });
        }
    }
    return totals;
}

/**
 * Settings' Test: a ping now, then the state. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, encryptionKey: Buffer|object|null, fetchImpl: Function, now?: Date }} input
 * @returns {Promise<ReturnType<typeof judgePdiConnection>>}
 * @throws {NoPdiConnectionError|PdiConnectionError}
 */
async function testPdiConnection(pool, { tenantId, actorUserId, encryptionKey, fetchImpl, now = new Date() }) {
    await withScope(pool, { tenantId }, (client) => assertAdmin(client, { tenantId, userId: actorUserId }));
    if (!encryptionKey) throw new PdiConnectionError('This server cannot test pdi: TOKEN_ENCRYPTION_KEY is not set');
    if ((await pingPdi(pool, { tenantId, encryptionKey, fetchImpl, now })) === null) throw new NoPdiConnectionError('This workspace is not connected with pdi');
    return withScope(pool, { tenantId }, (client) => readPdiConnection(client, { tenantId, now }));
}

/**
 * What a service token's workspace is and how it is connected with pdi: `GET /api/service/v1/connection`. pdi reads
 * it when it starts and daily, which is also its proof of reading ShipScope.
 *
 * @param {import('pg').Pool} pool
 * @param {{ token: string, now?: Date }} input
 * @returns {Promise<{ workspace: { id: string, name: string }, pdi: { state: string, receiverUrl: string|null } }>}
 */
async function serviceConnection(pool, { token, now = new Date() }) {
    return withServiceToken(pool, { token, now }, async (client, tenantId) => {
        const { rows: [tenant] } = await client.query('SELECT id, name FROM tenants WHERE id = $1', [tenantId]);
        const { state, receiverUrl } = await readPdiConnection(client, { tenantId, now });
        return { workspace: { id: tenant.id, name: tenant.name }, pdi: { state, receiverUrl } };
    });
}

module.exports = {
    RECEIVER_PATH, PdiConnectionError, PdiConnectionConflictError, NoPdiConnectionError,
    readPdiConnection, getPdiConnection, connectPdi, disconnectPdi, pingPdi, pingPdiConnections, testPdiConnection, serviceConnection,
};
