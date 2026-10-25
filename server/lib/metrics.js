// GET /metrics in Prometheus' text format (ROADMAP, Stan i monitoring): for whoever runs ShipScope, never tenant data.
// Two kinds of numbers. The web service counts what it answers itself, in memory per process (flag messages by
// outcome, webhook deliveries, responses by status class); they start at zero on each restart, as counters may.
// What the worker did comes from worker_status (migration 020, 033): each job's last run, last success, last
// duration, runs and failures, failed tenants, and the `sources` job's totals of flag sources by origin and freshness;
// the webhook queue from sync_requests. Labels are fixed words, never a name, key or error text.

/** What an answer of POST /api/flags/ingest means, by status code. */
const INGEST_OUTCOMES = { 200: 'accepted', 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 413: 'too_large', 429: 'rate_limited', 503: 'busy' };
const WEBHOOK_ROUTES = { '/webhooks/github': 'github', '/webhooks/jira': 'jira' };

/**
 * The web service's in-memory counters, fed by an onResponse hook (web.js).
 *
 * @returns {{ observe: (route: string|undefined, statusCode: number) => void, snapshot: () => { ingest: Record<string, number>, webhooks: Record<string, number>, responses: Record<string, number> } }}
 */
function createMetrics() {
    const ingest = {};
    const webhooks = {};
    const responses = {};
    const add = (map, key) => { map[key] = (map[key] || 0) + 1; };
    return {
        observe(route, statusCode) {
            add(responses, `${Math.floor(statusCode / 100)}xx`);
            if (route === '/api/flags/ingest') add(ingest, INGEST_OUTCOMES[statusCode] || 'error');
            if (WEBHOOK_ROUTES[route]) add(webhooks, `${WEBHOOK_ROUTES[route]}|${statusCode === 202 ? 'accepted' : statusCode === 401 ? 'refused' : 'error'}`);
        },
        snapshot: () => ({ ingest: { ...ingest }, webhooks: { ...webhooks }, responses: { ...responses } }),
    };
}

const LABEL = /^[a-z0-9_.-]{1,40}$/;
const labels = (pairs) => {
    const entries = Object.entries(pairs).filter(([, v]) => v !== undefined && LABEL.test(String(v)));
    return entries.length ? `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
};
const seconds = (date) => (date ? (new Date(date).getTime() / 1000).toFixed(3) : null);

/**
 * The text of GET /metrics.
 *
 * @param {{ version: string, counters: ReturnType<ReturnType<typeof createMetrics>['snapshot']>, rows: Array<{ job: string, last_run_at: Date, last_ok_at: Date|null, last_duration_ms: number|null, runs_total: string|number, failures_total: string|number, details: object }>, queue: Array<{ source: string, pending: number, oldest_at: Date|null }>, now: Date }} input
 * @returns {string}
 */
function renderMetrics({ version, counters, rows, queue, now }) {
    const out = [];
    const family = (name, type, help, samples) => {
        const lines = samples.filter(([, value]) => value !== null && value !== undefined && Number.isFinite(Number(value)));
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines.map(([l, value]) => `${name}${labels(l)} ${Number(value)}`));
    };
    family('shipscope_build_info', 'gauge', 'The running version.', [[{ version }, 1]]);
    family('shipscope_flag_ingest_messages_total', 'counter', 'Flag messages answered by this web process, by outcome.',
        Object.entries(counters.ingest).map(([outcome, n]) => [{ outcome }, n]));
    family('shipscope_webhook_deliveries_total', 'counter', 'Webhook deliveries answered by this web process.',
        Object.entries(counters.webhooks).map(([key, n]) => { const [source, outcome] = key.split('|'); return [{ source, outcome }, n]; }));
    family('shipscope_http_responses_total', 'counter', 'Responses of this web process, by status class.',
        Object.entries(counters.responses).map(([status_class, n]) => [{ status_class }, n]));

    const jobs = rows.filter((r) => LABEL.test(r.job));
    family('shipscope_worker_job_last_run_timestamp_seconds', 'gauge', 'When the worker last ran each job.', jobs.map((r) => [{ job: r.job }, seconds(r.last_run_at)]));
    family('shipscope_worker_job_last_success_timestamp_seconds', 'gauge', 'When each job last succeeded.', jobs.map((r) => [{ job: r.job }, seconds(r.last_ok_at)]));
    family('shipscope_worker_job_last_duration_seconds', 'gauge', 'How long the last run of each job took.',
        jobs.map((r) => [{ job: r.job }, r.last_duration_ms === null || r.last_duration_ms === undefined ? null : (r.last_duration_ms / 1000).toFixed(3)]));
    family('shipscope_worker_job_runs_total', 'counter', 'Runs of each job.', jobs.map((r) => [{ job: r.job }, r.runs_total]));
    family('shipscope_worker_job_failures_total', 'counter', 'Runs of each job that failed as a whole.', jobs.map((r) => [{ job: r.job }, r.failures_total]));
    family('shipscope_worker_job_failed_tenants', 'gauge', 'Tenants whose part of the last run failed.',
        jobs.filter((r) => r.details && r.details.failed !== undefined).map((r) => [{ job: r.job }, r.details.failed]));

    family('shipscope_sync_queue_pending', 'gauge', 'Queued sync requests (webhooks, dashboards, Settings), by source.', queue.map((q) => [{ source: q.source }, q.pending]));
    family('shipscope_sync_queue_oldest_age_seconds', 'gauge', 'Age of the oldest queued request, by source.',
        queue.map((q) => [{ source: q.source }, q.oldest_at ? ((now - new Date(q.oldest_at)) / 1000).toFixed(3) : 0]));

    const health = (rows.find((r) => r.job === 'sources') || {}).details || null;
    if (health && health.sources && health.environments) {
        family('shipscope_flag_sources', 'gauge', 'Flag sources of every tenant, by origin (the worker counts them every 5 minutes).',
            Object.entries(health.sources).map(([origin, n]) => [{ origin }, n]));
        family('shipscope_flag_source_environments', 'gauge', 'Environments of every flag source, by freshness.',
            Object.entries(health.environments).map(([state, n]) => [{ state }, n]));
        family('shipscope_flag_sources_refused_last_hour', 'gauge', 'Flag sources with a message refused in the last hour.', [[{}, health.refusedLastHour]]);
    }
    return `${out.join('\n')}\n`;
}

/**
 * Reads what renderMetrics() needs from the database (non-RLS tables only).
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ rows: object[], queue: object[] }>}
 */
async function readWorkerMetrics(pool) {
    const { rows } = await pool.query('SELECT job, last_run_at, last_ok_at, last_duration_ms, runs_total, failures_total, details FROM worker_status ORDER BY job');
    const { rows: queue } = await pool.query('SELECT source, count(*)::int AS pending, min(requested_at) AS oldest_at FROM sync_requests GROUP BY source ORDER BY source');
    return { rows, queue };
}

module.exports = { INGEST_OUTCOMES, createMetrics, renderMetrics, readWorkerMetrics };
