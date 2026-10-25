// GET /metrics (lib/metrics.js): Prometheus' text format, behind METRICS_TOKEN; the web service's own counters and the
// worker's jobs from worker_status (migration 033, which also lets the flags/secrets/sources jobs be recorded at all).
const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { recordRun, workerHealth } = require('../lib/worker-status');
const { createMetrics, renderMetrics } = require('../lib/metrics');
const { flagSourceHealth } = require('../lib/flags');
const { sourcesTick } = require('../worker');
const { loadMetricsToken } = require('../lib/config');
const { createLogger } = require('../lib/log');

const TOKEN = 'm'.repeat(40);
const quiet = createLogger({ service: 'test', level: 'error', write: () => {} });

test('renderMetrics: counters, worker jobs and the queue in the text format; odd label values are left out', () => {
    const metrics = createMetrics();
    metrics.observe('/api/flags/ingest', 200);
    metrics.observe('/api/flags/ingest', 401);
    metrics.observe('/api/flags/ingest', 401);
    metrics.observe('/webhooks/jira', 202);
    metrics.observe('/health', 200);
    const now = new Date('2026-10-25T12:00:00Z');
    const text = renderMetrics({
        version: '0.2.42', counters: metrics.snapshot(), now,
        rows: [
            { job: 'deployments', last_run_at: new Date('2026-10-25T11:59:00Z'), last_ok_at: new Date('2026-10-25T11:59:00Z'), last_duration_ms: 1500, runs_total: '7', failures_total: '1', details: { failed: 2 } },
            { job: 'Bad Job"', last_run_at: now, last_ok_at: null, last_duration_ms: null, runs_total: 1, failures_total: 0, details: {} },
            { job: 'sources', last_run_at: now, last_ok_at: now, last_duration_ms: 20, runs_total: 1, failures_total: 0,
                details: { tenants: 2, sources: { push: 1, code: 2, endpoint: 0 }, environments: { fresh: 3, stale: 1, error: 1, unknown: 0 }, refusedLastHour: 1 } },
        ],
        queue: [{ source: 'github', pending: 3, oldest_at: new Date('2026-10-25T11:58:00Z') }],
    });
    for (const line of [
        'shipscope_build_info{version="0.2.42"} 1',
        'shipscope_flag_ingest_messages_total{outcome="accepted"} 1',
        'shipscope_flag_ingest_messages_total{outcome="unauthorized"} 2',
        'shipscope_webhook_deliveries_total{source="jira",outcome="accepted"} 1',
        'shipscope_http_responses_total{status_class="2xx"} 3',
        'shipscope_worker_job_last_duration_seconds{job="deployments"} 1.5',
        'shipscope_worker_job_runs_total{job="deployments"} 7',
        'shipscope_worker_job_failures_total{job="deployments"} 1',
        'shipscope_worker_job_failed_tenants{job="deployments"} 2',
        `shipscope_worker_job_last_success_timestamp_seconds{job="deployments"} ${Date.parse('2026-10-25T11:59:00Z') / 1000}`,
        'shipscope_sync_queue_pending{source="github"} 3',
        'shipscope_sync_queue_oldest_age_seconds{source="github"} 120',
        'shipscope_flag_sources{origin="code"} 2',
        'shipscope_flag_source_environments{state="error"} 1',
        'shipscope_flag_sources_refused_last_hour 1',
        '# TYPE shipscope_worker_job_runs_total counter',
    ]) assert.ok(text.split('\n').includes(line), line);
    assert.ok(!text.includes('Bad Job'), 'a label value outside [a-z0-9_.-] never reaches the text');
    assert.ok(text.endsWith('\n'));
});

test('METRICS_TOKEN: none = no route; a short one is a configuration error', () => {
    assert.strictEqual(loadMetricsToken({}), null);
    assert.strictEqual(loadMetricsToken({ METRICS_TOKEN: TOKEN }), TOKEN);
    assert.throws(() => loadMetricsToken({ METRICS_TOKEN: 'short' }), /at least 32 characters/);
});

test('GET /metrics: bearer METRICS_TOKEN only; counts what this process answered and what the worker recorded', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 898_000_001, login: 'alice' } }), metricsToken: TOKEN });
    t.after(() => app.close());
    const off = buildApp({ pool, auth: AUTH });
    t.after(() => off.close());
    assert.strictEqual((await off.inject({ method: 'GET', url: '/metrics' })).statusCode, 404, 'no METRICS_TOKEN, no route');

    // The jobs 020 did not list (flags, secrets, sources) are recorded now, with durations and counters.
    await recordRun(pool, { job: 'flags', ok: true, details: { failed: 0 }, durationMs: 250 });
    await recordRun(pool, { job: 'flags', ok: false, error: 'boom', durationMs: 900 });
    await recordRun(pool, { job: 'heartbeat', ok: true });
    const health = await workerHealth(pool, { expect: { deployments: false, jira: false, flags: true }, syncIntervalMinutes: 15 });
    assert.strictEqual(health.checks.flags.status, 'ok', '/health/worker sees the flags job');

    // A tenant with a source, counted by the worker's sources job.
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const { token } = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice }, payload: { name: 'CI', kind: 'build' } })).json();
    const ingest = (authorization, observations) => app.inject({ method: 'POST', url: '/api/flags/ingest', headers: { authorization }, payload: { schemaVersion: 2, observations } });
    assert.strictEqual((await ingest(`Bearer ${token.token}`, [{ key: 'a', env: 'prod', state: 'on' }])).statusCode, 200);
    assert.strictEqual((await ingest('Bearer shpi_nope', [{ key: 'a', env: 'prod', state: 'on' }])).statusCode, 401);
    assert.strictEqual((await ingest(`Bearer ${token.token}`, [{ key: 'a b', env: 'prod', state: 'on' }])).statusCode, 400);
    assert.deepStrictEqual(await flagSourceHealth(pool), {
        tenants: 1, sources: { push: 1, code: 0, endpoint: 0 }, environments: { fresh: 0, stale: 0, error: 1, unknown: 0 }, refusedLastHour: 1,
    });
    await sourcesTick(pool, quiet);

    for (const authorization of [undefined, 'Bearer wrong', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
        const res = await app.inject({ method: 'GET', url: '/metrics', headers: authorization ? { authorization } : {} });
        assert.strictEqual(res.statusCode, 401, String(authorization));
    }
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/plain; version=0\.0\.4/);
    const lines = res.body.split('\n');
    for (const line of [
        'shipscope_flag_ingest_messages_total{outcome="accepted"} 1',
        'shipscope_flag_ingest_messages_total{outcome="unauthorized"} 1',
        'shipscope_flag_ingest_messages_total{outcome="invalid"} 1',
        'shipscope_worker_job_runs_total{job="flags"} 2',
        'shipscope_worker_job_failures_total{job="flags"} 1',
        'shipscope_worker_job_last_duration_seconds{job="flags"} 0.9',
        'shipscope_worker_job_runs_total{job="sources"} 1',
        'shipscope_flag_sources{origin="push"} 1',
        'shipscope_flag_source_environments{state="error"} 1',
        'shipscope_flag_sources_refused_last_hour 1',
    ]) assert.ok(lines.includes(line), `${line}\n${res.body}`);
    assert.ok(!res.body.includes('Acme') && !res.body.includes('boom') && !res.body.includes(token.token), 'no tenant name, error text or token');
});
