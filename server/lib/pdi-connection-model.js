// The state of a workspace's connection with pdi (design-docs/PDI-CONNECTION-PLAN.pl.md), from what each side has
// proven. Pure: lib/pdi-connection.js reads the rows and calls judgePdiConnection().

/** pdi reads ShipScope at least daily; after this many days without a read the connection has a problem. */
const PDI_READ_STALE_DAYS = 14;
/** A failure is a problem once the last successful contact with pdi is older than this. */
const REACH_GRACE_MS = 3600_000;
const DAY_MS = 86400_000;
/** After a disconnect the pdi layer's data stays this long, then the daily retention removes it (decision D5). */
const PDI_DATA_KEEP_DAYS = 30;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const later = (a, b) => (!a ? b : !b ? a : (new Date(a) > new Date(b) ? a : b));

/**
 * `none` (never connected), `pending` (created, a direction not proven yet), `connected`, `degraded` (the last contact
 * with pdi failed and the last success is older than an hour, or pdi has not read ShipScope for 14 days) or
 * `disconnected`; with one check per direction for the settings card. Once disconnected, `dataKeptUntil` says until when
 * the pdi layer's data stays (connecting again before then keeps it), or `dataRemovedAt` when it was removed.
 *
 * @param {{ connection: { receiver_url: string, created_at: Date, last_ping_ok_at: Date|null, last_ping_error: string|null, last_ping_error_at: Date|null, disconnected_at: Date|null, data_removed_at?: Date|null }|null, tokenLastUsedAt: Date|null, subscription: { last_delivered_at?: Date|null, last_error?: string|null, last_error_at?: Date|null }|null, now: Date }} input
 * @returns {{ state: 'none'|'pending'|'connected'|'degraded'|'disconnected', receiverUrl: string|null, connectedAt: string|null, disconnectedAt: string|null, dataKeptUntil: string|null, dataRemovedAt: string|null, checks: Array<{ id: 'pdi_reads'|'reaches_pdi', ok: boolean, at: string|null, error: string|null }> }}
 */
function judgePdiConnection({ connection, tokenLastUsedAt, subscription, now }) {
    if (!connection) return { state: 'none', receiverUrl: null, connectedAt: null, disconnectedAt: null, dataKeptUntil: null, dataRemovedAt: null, checks: [] };
    const base = { receiverUrl: connection.receiver_url, connectedAt: iso(connection.created_at), disconnectedAt: iso(connection.disconnected_at), dataKeptUntil: null, dataRemovedAt: null };
    if (connection.disconnected_at) {
        const removed = connection.data_removed_at || null;
        return { ...base, state: 'disconnected', checks: [], dataRemovedAt: iso(removed), dataKeptUntil: removed ? null : iso(pdiDataRemovalDue(connection.disconnected_at)) };
    }

    const sub = subscription || {};
    const lastOk = later(connection.last_ping_ok_at, sub.last_delivered_at);
    const pingFailedLast = connection.last_ping_error_at && (!connection.last_ping_ok_at || new Date(connection.last_ping_error_at) > new Date(connection.last_ping_ok_at));
    const deliveryFailedLast = sub.last_error_at && (!sub.last_delivered_at || new Date(sub.last_error_at) > new Date(sub.last_delivered_at));
    const lastError = pingFailedLast ? connection.last_ping_error : deliveryFailedLast ? sub.last_error : null;
    const reachesOk = Boolean(lastOk) && !lastError;
    const readStale = tokenLastUsedAt && now - new Date(tokenLastUsedAt) > PDI_READ_STALE_DAYS * DAY_MS;
    const checks = [
        { id: 'pdi_reads', ok: Boolean(tokenLastUsedAt) && !readStale, at: iso(tokenLastUsedAt), error: readStale ? `pdi has not read ShipScope for more than ${PDI_READ_STALE_DAYS} days` : null },
        { id: 'reaches_pdi', ok: reachesOk, at: iso(lastOk), error: lastError },
    ];
    if (!tokenLastUsedAt || !lastOk) return { ...base, state: 'pending', checks };
    const failing = lastError && now - new Date(lastOk) > REACH_GRACE_MS;
    return { ...base, state: failing || readStale ? 'degraded' : 'connected', checks };
}

/**
 * When the pdi layer's data of a connection disconnected at `disconnectedAt` is due for removal.
 *
 * @param {Date|string} disconnectedAt
 * @returns {Date}
 */
function pdiDataRemovalDue(disconnectedAt){
    return new Date(new Date(disconnectedAt).getTime() + PDI_DATA_KEEP_DAYS * DAY_MS);
}

module.exports = { judgePdiConnection, pdiDataRemovalDue, PDI_READ_STALE_DAYS, PDI_DATA_KEEP_DAYS, REACH_GRACE_MS };
