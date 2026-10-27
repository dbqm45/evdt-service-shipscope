// Which of ShipScope's features a workspace sees (design-docs/PDI-GATE-PLAN.pl.md, step 2 of "ShipScope bez pdi
// i z pdi"): the pdi layer — changes from repos, the release plan, outgoing events, the service API, lead time from the
// intent — only once the workspace is connected with pdi. Reads only; lib/pdi-connection.js changes the connection.
const { judgePdiConnection } = require('./pdi-connection-model');

const VISIBLE = ['connected', 'degraded'];
// While pending, what pdi needs to prove the connection keeps running: the service API and the events.
const ACTIVE = ['pending', 'connected', 'degraded'];

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
 * `visible`: people see the pdi layer (connected, with or without problems). `active`: the service API and the
 * outgoing events run (also while pending, so pdi can prove the connection).
 *
 * @param {import('pg').PoolClient} client inside withScope()
 * @param {{ tenantId: string, now?: Date }} input
 * @returns {Promise<{ state: string, visible: boolean, active: boolean }>}
 */
async function pdiLayer(client, { tenantId, now = new Date() }) {
    const { state } = await readPdiConnection(client, { tenantId, now });
    return { state, visible: VISIBLE.includes(state), active: ACTIVE.includes(state) };
}

module.exports = { readPdiConnection, pdiLayer };
