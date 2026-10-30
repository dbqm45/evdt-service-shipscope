// Outgoing events (G1.5; the first outgoing webhooks of F5): a workspace's admin subscribes an https address to
// release.stage_changed and/or feature.released (pdi contract 0.4.0). The worker looks at the tenants with a
// subscription every few minutes (detectReleaseEvents(): the Release plan model, lib/release-status.js, against
// event_state; plan in lib/release-events-model.js), queues what changed in event_outbox, and delivers it
// (deliverEvents()): a POST through safeFetch() (lib/safe-fetch.js: https, public address, no redirects, limits),
// signed with the workspace's signing secret (the one endpoint requests carry, Settings → Sources):
//   X-ShipScope-Timestamp: <unix seconds>
//   X-ShipScope-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
//   X-ShipScope-Event: <type>
// In local mode (lib/local-mode.js) only the connection with pdi's own subscription may be on loopback
// (design-docs/LOCAL-PDI-PLAN.pl.md); every other subscription keeps those rules.
// A failed delivery is tried again after 1, 2, 4… minutes up to an hour; after MAX_ATTEMPTS it is given up. The last
// error shows on the subscription in Settings. Receivers deduplicate by the event's `id`.
const crypto = require('crypto');
const { withScope } = require('./scope');
const { assertAdmin } = require('./tenants');
const { recordAuditEvent } = require('./audit-log');
const { checkUrl, SafeFetchError } = require('./safe-fetch');
const { tenantSigningSecret } = require('./endpoint-flags');
const { open, SecretBoxError } = require('./secret-box');
const { pdiLayer } = require('./pdi-layer');
const { readDashboardData } = require('./dashboard-data');
const { releaseGroups } = require('./release-status');
const { EVENT_TYPES, emptyEventState, planReleaseEvents, checkEvent } = require('./release-events-model');

const MAX_SUBSCRIPTIONS = 5;
const MAX_ATTEMPTS = 10;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 3600_000;
const BATCH = 50;
const ERROR_MAX = 300;

class EventSubscriptionError extends Error {}

/**
 * The signature header's value for one delivery.
 *
 * @param {{ secret: Buffer|string, timestamp: string, body: string }} input
 * @returns {string} `v1=<hex>`
 */
function eventSignature({ secret, timestamp, body }) {
    return `v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** What binds a subscription's own sealed signing secret (the pdi connection's, lib/pdi-connection.js) to its place. */
function subscriptionSecretAad(tenantId, subscriptionId) {
    return `${tenantId}/event-subscription/${subscriptionId}`;
}

/**
 * Inside withScope: the secret that signs a subscription's deliveries: its own when it has one, else the workspace's.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, encryptionKey: Buffer|object, subscriptionId: string }} input
 * @returns {Promise<string>}
 */
async function subscriptionSigningSecret(client, { tenantId, encryptionKey, subscriptionId }) {
    const { rows: [sub] } = await client.query('SELECT signing_secret_enc FROM event_subscriptions WHERE tenant_id = $1 AND id = $2', [tenantId, subscriptionId]);
    if (!sub || !sub.signing_secret_enc) return tenantSigningSecret(client, { tenantId, encryptionKey });
    try {
        return open(encryptionKey, sub.signing_secret_enc, subscriptionSecretAad(tenantId, subscriptionId));
    } catch (err) {
        if (err instanceof SecretBoxError) throw new EventSubscriptionError('The subscription\'s signing secret cannot be read (was TOKEN_ENCRYPTION_KEY changed without TOKEN_ENCRYPTION_KEY_PREVIOUS?)');
        throw err;
    }
}

/**
 * The workspace's subscriptions with their delivery state. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<{ id: string, url: string, types: string[], createdAt: Date, lastDeliveredAt: Date|null, lastError: string|null, lastErrorAt: Date|null, pending: number }>>}
 */
async function listSubscriptions(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            `SELECT s.id, s.url, s.types, s.created_at, s.last_delivered_at, s.last_error, s.last_error_at,
                    (SELECT count(*)::int FROM event_outbox o WHERE o.tenant_id = s.tenant_id AND o.subscription_id = s.id AND o.delivered_at IS NULL AND o.failed_at IS NULL) AS pending
             FROM event_subscriptions s WHERE s.tenant_id = $1 ORDER BY s.created_at`,
            [tenantId]
        );
        return rows.map((r) => ({
            id: r.id, url: r.url, types: r.types, createdAt: r.created_at, lastDeliveredAt: r.last_delivered_at, lastError: r.last_error, lastErrorAt: r.last_error_at, pending: r.pending,
        }));
    });
}

/**
 * Subscribes an address. Admins only; audited.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, url: string, types: string[] }} input
 * @returns {Promise<{ id: string, url: string, types: string[] }>}
 * @throws {EventSubscriptionError} not a public https address, an unknown type, or the limit reached
 */
async function addSubscription(pool, { tenantId, actorUserId, url, types }) {
    try {
        checkUrl(url);
    } catch (err) {
        if (err instanceof SafeFetchError) throw new EventSubscriptionError(err.message);
        throw err;
    }
    const wanted = [...new Set(types)];
    if (!wanted.length || wanted.some((t) => !EVENT_TYPES.includes(t))) throw new EventSubscriptionError(`Events are ${EVENT_TYPES.join(' and ')}`);
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM event_subscriptions WHERE tenant_id = $1', [tenantId]);
        if (n >= MAX_SUBSCRIPTIONS) throw new EventSubscriptionError(`A workspace has at most ${MAX_SUBSCRIPTIONS} event subscriptions`);
        const { rows: [row] } = await client.query(
            'INSERT INTO event_subscriptions (tenant_id, url, types, created_by) VALUES ($1, $2, $3, $4) RETURNING id, url, types',
            [tenantId, url, wanted, actorUserId]
        );
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'event_subscription_added', subject: `${new URL(url).host} (${wanted.join(', ')})` });
        return row;
    });
}

/**
 * Removes a subscription and what waits for it. Admins only; audited.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, id: string }} input
 * @returns {Promise<boolean>} whether there was one
 */
async function removeSubscription(pool, { tenantId, actorUserId, id }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: owned } = await client.query('SELECT 1 FROM pdi_connections WHERE tenant_id = $1 AND subscription_id = $2 AND disconnected_at IS NULL', [tenantId, id]);
        if (owned.length) throw new EventSubscriptionError('This subscription belongs to the connection with pdi; disconnect pdi in Settings → pdi instead');
        const { rows: [row] } = await client.query('DELETE FROM event_subscriptions WHERE tenant_id = $1 AND id = $2 RETURNING url', [tenantId, id]);
        if (row) await recordAuditEvent(client, { tenantId, actorUserId, kind: 'event_subscription_removed', subject: new URL(row.url).host });
        return Boolean(row);
    });
}

/** event_state rows as the planner's state. */
function stateFrom(rows) {
    const state = emptyEventState();
    for (const r of rows) {
        if (r.kind === 'seen') state.seen.add(r.subject);
        else if (r.kind === 'released') state.released.add(r.subject);
        else if (r.kind === 'stage') state.stage.set(r.subject, r.value);
    }
    return state;
}

/**
 * Compares the tenant's release plan now with what was seen last, keeps the new state and queues the events for its
 * subscriptions. Nothing for a tenant without a subscription.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, now?: Date, log?: Function }} input
 * @returns {Promise<{ events: number, queued: number }>}
 */
async function detectReleaseEvents(pool, { tenantId, now = new Date(), log = () => {} }) {
    return withScope(pool, { tenantId }, async (client) => {
        const { rows: subscriptions } = await client.query('SELECT id, types FROM event_subscriptions WHERE tenant_id = $1', [tenantId]);
        // Events are part of the pdi layer: looked for only with an active connection (pending included, so pdi can
        // prove it with a delivery).
        if (!subscriptions.length || !(await pdiLayer(client, { tenantId, now })).active) return { events: 0, queued: 0 };
        const { rows: stateRows } = await client.query('SELECT kind, subject, value FROM event_state WHERE tenant_id = $1', [tenantId]);
        const groups = releaseGroups(await readDashboardData(client, { tenantId }), { now });
        const { events, state } = planReleaseEvents({ groups, previous: stateFrom(stateRows), now });
        const valid = events.filter((e) => {
            const errors = checkEvent(e);
            if (errors.length) log(`event ${e.type} not sent: ${errors.join('; ')}`, { level: 'error', tenantId });
            return !errors.length;
        });
        await client.query('DELETE FROM event_state WHERE tenant_id = $1', [tenantId]);
        const entries = [
            ...[...state.seen].map((s) => ['seen', s, '']),
            ...[...state.released].map((s) => ['released', s, '']),
            ...[...state.stage].map(([s, v]) => ['stage', s, v]),
        ];
        if (entries.length) {
            await client.query(
                `INSERT INTO event_state (tenant_id, kind, subject, value)
                 SELECT $1, k, s, v FROM unnest($2::text[], $3::text[], $4::text[]) AS t(k, s, v)`,
                [tenantId, entries.map((e) => e[0]), entries.map((e) => e[1]), entries.map((e) => e[2])]
            );
        }
        let queued = 0;
        for (const event of valid) {
            for (const sub of subscriptions.filter((s) => s.types.includes(event.type))) {
                await client.query('INSERT INTO event_outbox (tenant_id, subscription_id, event) VALUES ($1, $2, $3)', [tenantId, sub.id, JSON.stringify(event)]);
                queued += 1;
            }
        }
        return { events: valid.length, queued };
    });
}

/**
 * Delivers what is due, oldest first, for every tenant. Never throws for one delivery.
 *
 * @param {import('pg').Pool} pool
 * @param {{ encryptionKey: Buffer, fetchImpl: Function, localMode?: boolean, now?: Date, log?: Function }} input
 *   `localMode`: the active pdi connection's subscription may be on loopback
 * @returns {Promise<{ delivered: number, failed: number, retried: number }>} failed: given up this time
 */
async function deliverEvents(pool, { encryptionKey, fetchImpl, localMode = false, now = new Date(), log = () => {} }) {
    const totals = { delivered: 0, failed: 0, retried: 0 };
    const { rows: tenants } = await pool.query('SELECT id FROM tenants ORDER BY created_at');
    for (const { id: tenantId } of tenants) {
        const due = await withScope(pool, { tenantId }, async (client) => {
            const { rows } = await client.query(
                `SELECT o.id, o.event, o.attempts, s.id AS subscription_id, s.url,
                        EXISTS (SELECT 1 FROM pdi_connections p WHERE p.tenant_id = s.tenant_id AND p.subscription_id = s.id AND p.disconnected_at IS NULL) AS pdi
                 FROM event_outbox o
                 JOIN event_subscriptions s ON s.tenant_id = o.tenant_id AND s.id = o.subscription_id
                 WHERE o.tenant_id = $1 AND o.delivered_at IS NULL AND o.failed_at IS NULL AND o.next_attempt_at <= $2
                 ORDER BY o.created_at LIMIT $3`,
                [tenantId, now, BATCH]
            );
            // Each subscription signs with its own secret when it has one (the pdi connection's), else the workspace's.
            const secrets = new Map();
            for (const row of rows) {
                if (!secrets.has(row.subscription_id)) secrets.set(row.subscription_id, await subscriptionSigningSecret(client, { tenantId, encryptionKey, subscriptionId: row.subscription_id }));
            }
            return { rows, secrets };
        });
        for (const row of due.rows) {
            const body = JSON.stringify(row.event);
            const timestamp = String(Math.floor(now.getTime() / 1000));
            let error = null;
            try {
                const res = await fetchImpl(row.url, {
                    method: 'POST', body, loopback: localMode && row.pdi,
                    headers: {
                        'content-type': 'application/json', 'x-shipscope-timestamp': timestamp, 'x-shipscope-event': row.event.type,
                        'x-shipscope-signature': eventSignature({ secret: due.secrets.get(row.subscription_id), timestamp, body }),
                    },
                });
                if (res.status < 200 || res.status >= 300) error = `${new URL(row.url).host} answered HTTP ${res.status}`;
            } catch (err) {
                error = String(err && err.message ? err.message : err).slice(0, ERROR_MAX);
            }
            await withScope(pool, { tenantId }, async (client) => {
                if (!error) {
                    totals.delivered += 1;
                    await client.query('UPDATE event_outbox SET delivered_at = $3, attempts = attempts + 1, last_error = NULL WHERE tenant_id = $1 AND id = $2', [tenantId, row.id, now]);
                    await client.query('UPDATE event_subscriptions SET last_delivered_at = $3, last_error = NULL, last_error_at = NULL WHERE tenant_id = $1 AND id = $2', [tenantId, row.subscription_id, now]);
                    return;
                }
                const attempts = row.attempts + 1;
                const giveUp = attempts >= MAX_ATTEMPTS;
                if (giveUp) totals.failed += 1;
                else totals.retried += 1;
                const wait = Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
                await client.query(
                    'UPDATE event_outbox SET attempts = $3, last_error = $4, next_attempt_at = $5, failed_at = $6 WHERE tenant_id = $1 AND id = $2',
                    [tenantId, row.id, attempts, error, new Date(now.getTime() + wait), giveUp ? now : null]
                );
                await client.query('UPDATE event_subscriptions SET last_error = $3, last_error_at = $4 WHERE tenant_id = $1 AND id = $2',
                    [tenantId, row.subscription_id, giveUp ? `${error} (given up after ${MAX_ATTEMPTS} attempts)` : error, now]);
                log(`event ${row.event.type} to ${new URL(row.url).host}: ${error}`, { level: 'warn', tenantId, attempts });
            });
        }
    }
    return totals;
}

module.exports = { MAX_SUBSCRIPTIONS, MAX_ATTEMPTS, EventSubscriptionError, eventSignature, subscriptionSecretAad, subscriptionSigningSecret, listSubscriptions, addSubscription, removeSubscription, detectReleaseEvents, deliverEvents };
