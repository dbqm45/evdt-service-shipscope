const { test } = require('node:test');
const assert = require('node:assert');
const { heartbeatTick } = require('../worker');

test('heartbeatTick: logs a successful ping', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const lines = [];
    await heartbeatTick(pool, (line) => lines.push(line));
    assert.match(lines[0], /heartbeat ok \(db latency \d+ms\)/);
});

test('heartbeatTick: logs a failure without throwing', async () => {
    const pool = { query: async () => { throw new Error('connection refused'); } };
    const lines = [];
    await heartbeatTick(pool, (line) => lines.push(line));
    assert.match(lines[0], /heartbeat failed: connection refused/);
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

test('syncTick and cleanupTick log their outcome and never throw', async () => {
    const lines = [];
    const log = (l) => lines.push(l);
    let options = null;
    await syncTick(lockPool(true).pool, {}, log, { syncAll: async (input) => { ({ options } = input); return { repos: 2, inserted: 3, failed: 1, deferred: 4 }; } }, 30_000);
    assert.deepStrictEqual(options, { tenantBudgetMs: 30_000 }, 'each tenant\'s share of the pass');
    await syncTick(lockPool(false).pool, {}, log, { syncAll: async () => assert.fail('must not run') });
    await syncTick(lockPool(true).pool, {}, log, { syncAll: async () => { throw new Error('db down'); } });
    await cleanupTick(lockPool(true).pool, log, { cleanupAll: async () => 4 });
    await cleanupTick({ connect: async () => { throw new Error('no db'); } }, log);
    assert.match(lines[0], /sync done: 2 repos, \+3 deployments, 1 failed, 4 left for the next pass/);
    assert.match(lines[1], /sync skipped/);
    assert.match(lines[2], /sync failed: db down/);
    assert.match(lines[3], /cleanup done: 4 old deployment records deleted/);
    assert.match(lines[4], /cleanup failed: no db/);
});

test('jiraTick runs the Jira sync under its own lock, logs its outcome and never throws', async () => {
    const lines = [];
    const log = (l) => lines.push(l);
    const { pool, queries } = lockPool(true);
    await jiraTick(pool, { clientId: 'x' }, log, {
        syncAllJira: async ({ atlassian, tenantBudgetMs }) => {
            assert.deepStrictEqual([atlassian.clientId, tenantBudgetMs], ['x', 120_000]);
            return { tenants: 2, issues: 30, failed: 1, deferred: 1 };
        },
    });
    await jiraTick(lockPool(false).pool, {}, log, { syncAllJira: async () => assert.fail('must not run') });
    await jiraTick(lockPool(true).pool, {}, log, { syncAllJira: async () => { throw new Error('db down'); } });
    assert.deepStrictEqual(queries[0], ['SELECT pg_try_advisory_lock($1) AS locked', [727_003]], 'not the deployment sync\'s lock');
    assert.match(lines[0], /jira sync done: 2 tenants, 30 issues, 1 failed, 1 left for the next pass/);
    assert.match(lines[1], /jira sync skipped/);
    assert.match(lines[2], /jira sync failed: db down/);
});
