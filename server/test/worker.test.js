const { test } = require('node:test');
const assert = require('node:assert');
const { heartbeatTick } = require('../worker');

const { memoryLogger } = require('./helpers/memory-logger');

/** Records what a job would write to worker_status. */
const recorder = () => {
    const runs = [];
    return { runs, recordRun: async (pool, run) => runs.push(run) };
};

test('heartbeatTick: a successful ping is recorded (and logged at debug)', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const { logger, lines } = memoryLogger();
    const { runs, recordRun } = recorder();
    await heartbeatTick(pool, logger, { recordRun });
    assert.strictEqual(lines[0].msg, 'heartbeat ok');
    assert.strictEqual(lines[0].level, 'debug');
    assert.strictEqual(typeof lines[0].dbLatencyMs, 'number');
    assert.deepStrictEqual(runs.map((r) => [r.job, r.ok]), [['heartbeat', true]]);
});

test('heartbeatTick: a failure is logged as an error, never thrown, and not recorded as a heartbeat', async () => {
    const pool = { query: async () => { throw new Error('connection refused'); } };
    const { logger, lines } = memoryLogger();
    const { runs, recordRun } = recorder();
    await heartbeatTick(pool, logger, { recordRun });
    assert.deepStrictEqual([lines[0].level, lines[0].msg, lines[0].err.message], ['error', 'heartbeat failed: database unreachable', 'connection refused']);
    assert.deepStrictEqual(runs, []);
});

const { runExclusive, syncIntervalMinutes, tenantBudgetSeconds, syncTick, jiraTick, cleanupTick } = require('../worker');

/** A pool whose client answers the advisory-lock queries; `locked` decides whether the lock is free. */
function lockPool(locked) {
    const queries = [];
    const client = {
        query: async (sql, params) => {
            queries.push([sql, params]);
            return { rows: [{ locked }] };
        },
        release: () => queries.push(['release']),
    };
    return { pool: { connect: async () => client }, queries };
}

test('runExclusive: runs and unlocks when the lock is free; skips when it is held', async () => {
    const free = lockPool(true);
    assert.deepStrictEqual(await runExclusive(free.pool, 7, async () => 'done'), { skipped: false, result: 'done' });
    assert.deepStrictEqual(free.queries.map((q) => q[0]), ['SELECT pg_try_advisory_lock($1) AS locked', 'SELECT pg_advisory_unlock($1)', 'release']);

    const held = lockPool(false);
    let ran = false;
    assert.deepStrictEqual(await runExclusive(held.pool, 7, async () => { ran = true; }), { skipped: true });
    assert.strictEqual(ran, false);
    assert.deepStrictEqual(held.queries.at(-1), ['release']);
});

test('runExclusive: unlocks and releases even when the work throws', async () => {
    const { pool, queries } = lockPool(true);
    await assert.rejects(() => runExclusive(pool, 7, async () => { throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual(queries.slice(1).map((q) => q[0]), ['SELECT pg_advisory_unlock($1)', 'release']);
});

test('syncIntervalMinutes: default 15, 1-1440 whole minutes', () => {
    assert.strictEqual(syncIntervalMinutes({}), 15);
    assert.strictEqual(syncIntervalMinutes({ SYNC_INTERVAL_MINUTES: '5' }), 5);
    for (const bad of ['0', '1441', '2.5', 'x']) assert.throws(() => syncIntervalMinutes({ SYNC_INTERVAL_MINUTES: bad }), /SYNC_INTERVAL_MINUTES/);
});

test('tenantBudgetSeconds: default 120, 10-3600 whole seconds', () => {
    assert.strictEqual(tenantBudgetSeconds({}), 120);
    assert.strictEqual(tenantBudgetSeconds({ SYNC_TENANT_BUDGET_SECONDS: '' }), 120);
    assert.strictEqual(tenantBudgetSeconds({ SYNC_TENANT_BUDGET_SECONDS: '10' }), 10);
    assert.strictEqual(tenantBudgetSeconds({ SYNC_TENANT_BUDGET_SECONDS: '3600' }), 3600);
    for (const bad of ['9', '3601', '1.5', 'x']) assert.throws(() => tenantBudgetSeconds({ SYNC_TENANT_BUDGET_SECONDS: bad }), /SYNC_TENANT_BUDGET_SECONDS/);
});

test('syncTick and cleanupTick log their outcome with fields, record it, and never throw', async () => {
    const { logger, lines } = memoryLogger();
    const { runs, recordRun } = recorder();
    let options = null;
    let syncLog = null;
    await syncTick(lockPool(true).pool, {}, logger, { recordRun, syncAll: async (input) => { ({ options, log: syncLog } = input); return { repos: 2, inserted: 3, failed: 1, deferred: 4 }; } }, 30_000);
    assert.deepStrictEqual(options, { tenantBudgetMs: 30_000 }, 'each tenant\'s share of the pass');
    await syncTick(lockPool(false).pool, {}, logger, { recordRun, syncAll: async () => assert.fail('must not run') });
    await syncTick(lockPool(true).pool, {}, logger, { recordRun, syncAll: async () => { throw new Error('db down'); } });
    await cleanupTick(lockPool(true).pool, logger, { recordRun, cleanupAll: async () => ({ deployments: 4, flagChanges: 7 }) });
    await cleanupTick({ connect: async () => { throw new Error('no db'); } }, logger, { recordRun });

    const done = lines[0];
    assert.match(done.msg, /deployment sync done: 2 repos, \+3 deployments, 1 failed, 4 left for the next pass/);
    assert.deepStrictEqual([done.level, done.job, done.repos, done.failed, typeof done.durationMs], ['warn', 'deployments', 2, 1, 'number'], 'a pass with failed repos is a warning');
    assert.match(lines[1].msg, /deployments skipped/);
    assert.deepStrictEqual([lines[2].level, lines[2].msg, lines[2].err.message], ['error', 'deployments failed', 'db down']);
    assert.deepStrictEqual([lines[3].level, lines[3].msg, lines[3].deployments, lines[3].flagChanges], ['info', 'cleanup done: 4 old deployment records and 7 old flag changes deleted', 4, 7]);
    assert.deepStrictEqual([lines[4].msg, lines[4].err.message], ['cleanup failed', 'no db']);
    assert.deepStrictEqual(runs.map((r) => [r.job, r.ok, r.error || null]), [
        ['deployments', true, null], ['deployments', false, 'db down'], ['cleanup', true, null], ['cleanup', false, 'no db'],
    ], 'a skipped run is not recorded');
    assert.deepStrictEqual(runs[0].details, { repos: 2, inserted: 3, failed: 1, deferred: 4 });

    // The sync modules log through fields: level, tenant, repo.
    syncLog('acme/web: sync failed: boom', { level: 'warn', tenantId: 't1', repo: 'acme/web' });
    assert.deepStrictEqual([lines.at(-1).level, lines.at(-1).tenantId, lines.at(-1).repo, lines.at(-1).job], ['warn', 't1', 'acme/web', 'deployments']);
});

test('a job whose status cannot be recorded still runs, and says so', async () => {
    const { logger, lines } = memoryLogger();
    await cleanupTick(lockPool(true).pool, logger, { recordRun: async () => { throw new Error('read-only'); }, cleanupAll: async () => ({ deployments: 0, flagChanges: 0 }) });
    assert.deepStrictEqual(lines.map((l) => l.msg), ['cleanup done: 0 old deployment records and 0 old flag changes deleted', 'could not record the worker status']);
});

test('jiraTick runs the Jira sync under its own lock, logs its outcome and never throws', async () => {
    const { logger, lines } = memoryLogger();
    const { recordRun } = recorder();
    const { pool, queries } = lockPool(true);
    await jiraTick(pool, { clientId: 'x' }, logger, {
        recordRun,
        syncAllJira: async ({ atlassian, tenantBudgetMs }) => {
            assert.deepStrictEqual([atlassian.clientId, tenantBudgetMs], ['x', 120_000]);
            return { tenants: 2, issues: 30, failed: 1, deferred: 1 };
        },
    });
    await jiraTick(lockPool(false).pool, {}, logger, { recordRun, syncAllJira: async () => assert.fail('must not run') });
    await jiraTick(lockPool(true).pool, {}, logger, { recordRun, syncAllJira: async () => { throw new Error('db down'); } });
    assert.deepStrictEqual(queries[0], ['SELECT pg_try_advisory_lock($1) AS locked', [727_003]], 'not the deployment sync\'s lock');
    assert.match(lines[0].msg, /jira sync done: 2 tenants, 30 issues, 1 failed, 1 left for the next pass/);
    assert.match(lines[1].msg, /jira skipped/);
    assert.deepStrictEqual([lines[2].msg, lines[2].err.message], ['jira failed', 'db down']);
});
