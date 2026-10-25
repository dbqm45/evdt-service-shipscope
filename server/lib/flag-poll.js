// The worker's flags tick (ADR-003 point 4, ROADMAP increment 4): reads every endpoint source whose `next_poll_at` is
// due (lib/endpoint-flags.js), then schedules its next read with nextPollAt(): the source's interval with jitter after
// a success, a doubling backoff after failures. Tenants are walked one by one under their own scope, at most
// POLL.perTenantPerTick sources each, so one tenant's many slow endpoints cannot hold up everyone else's.
//
// Opening a dashboard queues a `flags` sync request for its tenant (routes/dashboard.js); the worker's webhook tick
// drains it with `onDemand`, which reads only the sources not read in the last POLL.onDemandMinutes and not backing
// off, so reloading a page never hammers a customer's endpoint.
const { withScope } = require('./scope');
const { refreshEndpointSource } = require('./endpoint-flags');
const { POLL, nextPollAt } = require('./flags-logic');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One tenant's endpoint sources to read now: due ones, or (on demand) the ones not read just now and not failing. */
async function dueSources(pool, { tenantId, now, onDemand }) {
    return withScope(pool, { tenantId }, async (client) => {
        const { rows } = onDemand
            ? await client.query(
                `SELECT id, poll_interval_minutes, poll_failures FROM flag_sources
                 WHERE tenant_id = $1 AND origin = 'endpoint' AND poll_failures = 0
                   AND (last_polled_at IS NULL OR last_polled_at <= $2::timestamptz - make_interval(mins => $3))
                 ORDER BY last_polled_at NULLS FIRST LIMIT $4`,
                [tenantId, now, POLL.onDemandMinutes, POLL.perTenantPerTick]
            )
            : await client.query(
                `SELECT id, poll_interval_minutes, poll_failures FROM flag_sources
                 WHERE tenant_id = $1 AND origin = 'endpoint' AND (next_poll_at IS NULL OR next_poll_at <= $2)
                 ORDER BY next_poll_at NULLS FIRST LIMIT $3`,
                [tenantId, now, POLL.perTenantPerTick]
            );
        return rows;
    });
}

/** Records a read and when the next one is due. */
async function schedule(pool, { tenantId, sourceId, now, failures, intervalMinutes, random }) {
    await withScope(pool, { tenantId }, (client) => client.query(
        'UPDATE flag_sources SET last_polled_at = $3, poll_failures = $4, next_poll_at = $5 WHERE tenant_id = $1 AND id = $2',
        [tenantId, sourceId, now, failures, nextPollAt({ now, intervalMinutes, failures, random })]
    ));
}

/**
 * Reads the endpoint sources that are due, tenant by tenant. A source counts as failed when no environment could be
 * read; its errors are already recorded on its environments (Settings, the dashboard's "?"). Never throws for one
 * source: an unexpected error is logged and backs that source off like any other failure.
 *
 * @param {{ pool: import('pg').Pool, encryptionKey: Buffer, sealingKeys?: object|null, tenantIds?: string[]|null, onDemand?: boolean, now?: Date, fetchImpl?: Function, log?: Function, random?: () => number }} input
 *   `tenantIds` limits the pass (a dashboard's request); `onDemand` reads what a viewer would want fresh instead of what is due
 * @returns {Promise<{ tenants: number, sources: number, failed: number }>}
 */
async function pollEndpoints({ pool, encryptionKey, sealingKeys = null, tenantIds = null, onDemand = false, now = new Date(), fetchImpl, log = () => {}, random = Math.random }) {
    const ids = tenantIds
        ? tenantIds.filter((id) => UUID.test(id))
        : (await pool.query('SELECT id FROM tenants ORDER BY created_at')).rows.map((r) => r.id);
    const totals = { tenants: 0, sources: 0, failed: 0 };
    for (const tenantId of ids) {
        const sources = await dueSources(pool, { tenantId, now, onDemand });
        if (!sources.length) continue;
        totals.tenants += 1;
        for (const source of sources) {
            let failed;
            try {
                const result = await refreshEndpointSource(pool, { tenantId, sourceId: source.id, encryptionKey, sealingKeys, fetchImpl, now, log });
                if (!result) continue;
                failed = result.read === 0 && result.failed > 0;
            } catch (err) {
                failed = true;
                log(`endpoint source poll failed: ${err.message}`, { level: 'error', tenantId, err });
            }
            totals.sources += 1;
            if (failed) totals.failed += 1;
            await schedule(pool, {
                tenantId, sourceId: source.id, now, failures: failed ? source.poll_failures + 1 : 0, intervalMinutes: source.poll_interval_minutes, random,
            });
        }
    }
    return totals;
}

module.exports = { pollEndpoints };
