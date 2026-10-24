// Logs and the worker health check (ROADMAP increment 2, monitoring): what one log line holds and hides, how the
// worker is judged, GET /health/worker, and the context on the web service's request logs.
const { test } = require('node:test');
const assert = require('node:assert');
const { createLogger, logLevel, redact, loggerOptions } = require('../lib/log');
const { judgeWorker, recordRun } = require('../lib/worker-status');
const { memoryLogger } = require('./helpers/memory-logger');
const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');

test('logger: one JSON line with time, level, service and message; fields and child fields; below the level nothing', () => {
    const lines = [];
    const logger = createLogger({ service: 'worker', level: 'info', write: (l) => lines.push(l), now: () => new Date('2026-10-24T10:00:00Z'), base: { version: '1.2.3' } });
    logger.debug('not shown');
    logger.child({ job: 'jira' }).warn('tenant failed', { tenantId: 't1', retryAt: new Date('2026-10-24T11:00:00Z') });
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(JSON.parse(lines[0]), {
        time: '2026-10-24T10:00:00.000Z', level: 'warn', service: 'worker', msg: 'tenant failed', version: '1.2.3', job: 'jira', tenantId: 't1', retryAt: '2026-10-24T11:00:00.000Z',
    });
    assert.strictEqual(logLevel({}), 'info');
    assert.strictEqual(logLevel({ LOG_LEVEL: 'DEBUG' }), 'debug');
    assert.throws(() => logLevel({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
});

test('logger: errors become type, message, code and stack; secrets never reach a line', () => {
    const { logger, lines } = memoryLogger();
    const err = Object.assign(new Error('GitHub said 401 for Bearer abcdefghijklmnopqrstuvwxyz'), { code: 'E_AUTH', status: 401 });
    logger.error('call failed', {
        err, token: 'shpi_secretsecretsecret', headers: { authorization: 'Bearer x', accept: 'json' }, refreshToken: 'r', url: 'https://x/cb?code=abc123&state=s1&ok=1',
    });
    const line = lines[0];
    assert.deepStrictEqual([line.err.type, line.err.code, line.err.status], ['Error', 'E_AUTH', 401]);
    assert.match(line.err.message, /Bearer \[redacted\]$/);
    assert.ok(line.err.stack.includes('observability.test.js'));
    assert.deepStrictEqual([line.token, line.headers.authorization, line.headers.accept, line.refreshToken], ['[redacted]', '[redacted]', 'json', '[redacted]']);
    assert.strictEqual(line.url, 'https://x/cb?code=[redacted]&state=[redacted]&ok=1');
    assert.strictEqual(redact('sent with shpi_AbCdEfGhIjKlMnOp and ghs_abcdefghijklmnopqrstuvwxyz12'), 'sent with shpi_[redacted] and [redacted]');
    assert.strictEqual(redact('Invalid ingest token'), 'Invalid ingest token', 'plain words stay');
});

test('judgeWorker: down without a heartbeat or a recent successful sync, or with an undrained queue; degraded when tenants fail', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    const ago = (minutes) => new Date(now - minutes * 60_000);
    const row = (job, okMinutesAgo, extra = {}) => ({ job, last_run_at: ago(0), last_ok_at: okMinutesAgo === null ? null : ago(okMinutesAgo), last_error: null, last_error_at: null, details: {}, ...extra });
    const healthy = [row('heartbeat', 0.5), row('deployments', 10, { details: { failed: 0 } }), row('jira', 20)];
    const judge = (rows, queue = { pending: 0, oldestAt: null }, expect = { deployments: true, jira: true }) => judgeWorker({ rows, queue, expect, syncIntervalMinutes: 15, now });

    assert.deepStrictEqual(judge(healthy), {
        status: 'ok',
        checks: {
            heartbeat: { status: 'ok', lastOkSecondsAgo: 30 },
            deployments: { status: 'ok', lastOkSecondsAgo: 600, failed: 0 },
            jira: { status: 'ok', lastOkSecondsAgo: 1200, failed: 0 },
            webhookQueue: { status: 'ok', pending: 0, oldestSecondsAgo: null },
        },
    });
    assert.strictEqual(judge([row('heartbeat', 3), ...healthy.slice(1)]).status, 'down', 'no heartbeat for 3 minutes');
    assert.strictEqual(judge([]).status, 'down', 'the worker never ran');
    const stuck = judge([healthy[0], row('deployments', 51, { last_error: 'db down', last_error_at: ago(1) }), healthy[2]]);
    assert.deepStrictEqual([stuck.status, stuck.checks.deployments.status, stuck.checks.deployments.lastErrorSecondsAgo], ['down', 'fail', 60], 'no success for 3 x 15 + 5 minutes');
    assert.strictEqual(stuck.checks.deployments.lastError, undefined, 'error text stays out of the public route');
    assert.strictEqual(judge([healthy[0], row('deployments', 49), healthy[2]]).status, 'ok');
    assert.deepStrictEqual(judge([healthy[0], row('deployments', 5, { details: { failed: 2 } }), healthy[2]]).checks.deployments, { status: 'warn', lastOkSecondsAgo: 300, failed: 2 });
    assert.strictEqual(judge([healthy[0], row('deployments', 5, { details: { failed: 2 } }), healthy[2]]).status, 'degraded');
    assert.strictEqual(judge(healthy, { pending: 3, oldestAt: ago(11) }).status, 'down', 'a webhook waiting 11 minutes');
    assert.deepStrictEqual(Object.keys(judge([healthy[0]], undefined, { deployments: false, jira: false }).checks), ['heartbeat'], 'nothing configured: only the heartbeat');
});

test('GET /health/worker: 503 until the worker reports, 200 once it does, degraded when tenants fail', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, githubApp: null, atlassian: null });
    t.after(() => app.close());
    const get = () => app.inject({ method: 'GET', url: '/health/worker' });

    let res = await get();
    assert.deepStrictEqual([res.statusCode, res.json().status, res.headers['cache-control']], [503, 'down', 'no-store']);
    await recordRun(pool, { job: 'heartbeat', ok: true });
    res = await get();
    assert.deepStrictEqual([res.statusCode, res.json()], [200, { status: 'ok', checks: { heartbeat: { status: 'ok', lastOkSecondsAgo: 0 } } }]);

    const withSyncs = buildApp({ pool, githubApp: { appId: '1' }, atlassian: null, syncIntervalMinutes: 15 });
    t.after(() => withSyncs.close());
    res = await withSyncs.inject({ method: 'GET', url: '/health/worker' });
    assert.deepStrictEqual([res.statusCode, res.json().checks.deployments.status], [503, 'fail'], 'GitHub configured but no sync yet');
    await recordRun(pool, { job: 'deployments', ok: true, details: { repos: 3, failed: 1 } });
    res = await withSyncs.inject({ method: 'GET', url: '/health/worker' });
    assert.deepStrictEqual([res.statusCode, res.json().status, res.json().checks.deployments.failed], [200, 'degraded', 1]);

    // A failed run keeps the last success; a later success clears nothing it shouldn't.
    await recordRun(pool, { job: 'deployments', ok: false, error: 'db down' });
    const { rows: [row] } = await pool.query("SELECT last_ok_at IS NOT NULL AS ok_kept, last_error FROM worker_status WHERE job = 'deployments'");
    assert.deepStrictEqual(row, { ok_kept: true, last_error: 'db down' });
});

test('web logs: every request line carries its request id, tenant and user; the id goes back as X-Request-Id', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const lines = [];
    const app = buildApp({
        pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 880_000_001, login: 'alice' } }),
        logger: { ...loggerOptions({ level: 'info', version: '9.9.9' }), stream: { write: (l) => lines.push(JSON.parse(l)) } },
    });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;

    lines.length = 0;
    const res = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: alice }, headers: { 'x-request-id': 'req-from-proxy' } });
    assert.strictEqual(res.headers['x-request-id'], 'req-from-proxy');
    const done = lines.find((l) => l.msg === 'request completed');
    assert.deepStrictEqual([done.service, done.version, done.level, done.requestId, done.tenantId, typeof done.userId, done.res.statusCode],
        ['web', '9.9.9', 'info', 'req-from-proxy', tenantId, 'string', 200]);

    // A refusal says why, on its own line of the same request.
    lines.length = 0;
    await app.inject({ method: 'POST', url: '/api/flags/ingest', headers: { authorization: 'Bearer shpi_nottherealtokenatallnottherealtokenatall12' }, payload: { schemaVersion: 2, observations: [] } });
    const refused = lines.find((l) => l.msg === 'request refused');
    assert.deepStrictEqual([refused.statusCode, refused.reason], [401, 'Invalid ingest token']);
    assert.ok(!JSON.stringify(lines).includes('shpi_nottherealtoken'), 'the token never reaches the log');
});
