// The worker's own state (migration 020) and the check GET /health/worker answers with: is the worker alive, are its
// syncs succeeding, is the webhook queue drained. An uptime monitor polls that route and alerts on a 503, so a worker
// that stopped quietly is noticed in minutes, not when a customer asks why the dashboard is old.

const ERROR_MAX_LENGTH = 500;
// A heartbeat runs every 30 s; two minutes without one means the worker is gone (crashed, restarting, stuck).
const HEARTBEAT_MAX_AGE_MS = 2 * 60_000;
// A webhook request should be picked up within the 30 s tick; ten minutes means the queue is not being drained.
const QUEUE_MAX_AGE_MS = 10 * 60_000;

/**
 * Records one run of a worker job: always when it ran; when it succeeded, or the error.
 *
 * @param {import('pg').Pool} pool
 * @param {{ job: 'heartbeat'|'deployments'|'jira'|'flags'|'secrets'|'webhooks'|'cleanup', ok: boolean, error?: string|null, details?: object, now?: Date }} input
 * @returns {Promise<void>}
 */
async function recordRun(pool, { job, ok, error = null, details = {}, now = new Date() }) {
    await pool.query(
        `INSERT INTO worker_status (job, last_run_at, last_ok_at, last_error, last_error_at, details)
         VALUES ($1, $2::timestamptz, CASE WHEN $3::boolean THEN $2::timestamptz END, $4, CASE WHEN $3::boolean THEN NULL ELSE $2::timestamptz END, $5)
         ON CONFLICT (job) DO UPDATE SET last_run_at = EXCLUDED.last_run_at,
             last_ok_at = COALESCE(EXCLUDED.last_ok_at, worker_status.last_ok_at),
             last_error = CASE WHEN $3 THEN worker_status.last_error ELSE EXCLUDED.last_error END,
             last_error_at = CASE WHEN $3 THEN worker_status.last_error_at ELSE EXCLUDED.last_error_at END,
             details = EXCLUDED.details`,
        [job, now, ok, error === null ? null : String(error).slice(0, ERROR_MAX_LENGTH), details]
    );
}

/**
 * Judges the worker from its rows and the webhook queue. A check fails when its job has not succeeded for too long
 * (a sync: three intervals plus five minutes); it warns when the job succeeds but some tenants' syncs fail.
 * `status` is `down` when any check fails, `degraded` when one warns, else `ok`.
 *
 * @param {{ rows: Array<{ job: string, last_run_at: Date, last_ok_at: Date|null, last_error: string|null, last_error_at: Date|null, details: object }>, queue: { pending: number, oldestAt: Date|null }, expect: { deployments: boolean, jira: boolean, flags?: boolean }, syncIntervalMinutes: number, now: Date }} input
 * @returns {{ status: 'ok'|'degraded'|'down', checks: Object<string, { status: 'ok'|'warn'|'fail', [key: string]: any }> }}
 */
function judgeWorker({ rows, queue, expect, syncIntervalMinutes, now }) {
    const byJob = new Map(rows.map((r) => [r.job, r]));
    const age = (at) => (at ? Math.round((now - at) / 1000) : null);
    const syncLimitMs = (3 * syncIntervalMinutes + 5) * 60_000;
    const checks = {};

    const heartbeat = byJob.get('heartbeat');
    checks.heartbeat = {
        status: heartbeat?.last_ok_at && now - heartbeat.last_ok_at <= HEARTBEAT_MAX_AGE_MS ? 'ok' : 'fail',
        lastOkSecondsAgo: age(heartbeat?.last_ok_at),
    };
    for (const job of ['deployments', 'jira', 'flags']) {
        if (!expect[job]) continue;
        const row = byJob.get(job);
        const failedTenants = Number(row?.details?.failed || 0);
        let status = row?.last_ok_at && now - row.last_ok_at <= syncLimitMs ? 'ok' : 'fail';
        if (status === 'ok' && failedTenants > 0) status = 'warn';
        checks[job] = {
            status,
            lastOkSecondsAgo: age(row?.last_ok_at),
            failed: failedTenants,
            // The error text stays in the worker's log and the table: this route is public.
            ...(row?.last_error_at && (!row.last_ok_at || row.last_error_at > row.last_ok_at) ? { lastErrorSecondsAgo: age(row.last_error_at) } : {}),
        };
    }
    if (expect.deployments || expect.jira || expect.flags) {
        const oldest = queue.oldestAt ? now - queue.oldestAt : 0;
        checks.webhookQueue = { status: oldest > QUEUE_MAX_AGE_MS ? 'fail' : 'ok', pending: queue.pending, oldestSecondsAgo: age(queue.oldestAt) };
    }

    const states = Object.values(checks).map((c) => c.status);
    const status = states.includes('fail') ? 'down' : states.includes('warn') ? 'degraded' : 'ok';
    return { status, checks };
}

/**
 * Reads what judgeWorker() needs.
 *
 * @param {import('pg').Pool} pool
 * @param {{ expect: { deployments: boolean, jira: boolean, flags?: boolean }, syncIntervalMinutes: number, now?: Date }} input
 * @returns {Promise<ReturnType<typeof judgeWorker>>}
 */
async function workerHealth(pool, { expect, syncIntervalMinutes, now = new Date() }) {
    const { rows } = await pool.query('SELECT job, last_run_at, last_ok_at, last_error, last_error_at, details FROM worker_status');
    const { rows: [queue] } = await pool.query('SELECT count(*)::int AS pending, min(requested_at) AS oldest_at FROM sync_requests');
    return judgeWorker({ rows, queue: { pending: queue.pending, oldestAt: queue.oldest_at }, expect, syncIntervalMinutes, now });
}

module.exports = { HEARTBEAT_MAX_AGE_MS, QUEUE_MAX_AGE_MS, recordRun, judgeWorker, workerHealth };
