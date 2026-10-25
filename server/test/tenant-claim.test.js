// Spreading the worker over instances (lib/tenant-claim.js): claims, in-process concurrency, the per-host limit and
// WORKER_CONCURRENCY. The syncs that use them are tested with two passes at once in sync-fairness.test.js and
// flag-poll.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { withTenantClaim, eachLimited, workerConcurrency, limitPerHost } = require('../lib/tenant-claim');

const tick = () => new Promise((r) => setImmediate(r));

test('eachLimited: at most `concurrency` at a time, every item once; an error stops nothing and is rethrown at the end', async () => {
    let active = 0;
    let peak = 0;
    const done = [];
    await eachLimited([1, 2, 3, 4, 5], 2, async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        done.push(n);
        active -= 1;
    });
    assert.deepStrictEqual([peak, done.sort()], [2, [1, 2, 3, 4, 5]]);

    const seen = [];
    await assert.rejects(() => eachLimited(['a', 'b', 'c'], 1, async (x) => {
        seen.push(x);
        if (x === 'a') throw new Error('a failed');
    }), /a failed/);
    assert.deepStrictEqual(seen, ['a', 'b', 'c']);
    await eachLimited([], 4, async () => assert.fail('nothing to run'));
});

test('workerConcurrency: default 1, whole numbers 1-8', () => {
    assert.strictEqual(workerConcurrency({}), 1);
    assert.strictEqual(workerConcurrency({ WORKER_CONCURRENCY: '' }), 1);
    assert.strictEqual(workerConcurrency({ WORKER_CONCURRENCY: '4' }), 4);
    for (const bad of ['0', '9', '1.5', 'x']) assert.throws(() => workerConcurrency({ WORKER_CONCURRENCY: bad }), /WORKER_CONCURRENCY/);
});

test('limitPerHost: at most `max` requests to one host at once; other hosts are not held up; a failure frees its slot', async () => {
    const open = {};
    const peak = {};
    const waiting = [];
    const fetchImpl = (url) => new Promise((resolve, reject) => {
        const { host } = new URL(url);
        open[host] = (open[host] || 0) + 1;
        peak[host] = Math.max(peak[host] || 0, open[host]);
        waiting.push(() => {
            open[host] -= 1;
            if (url.endsWith('/fail')) reject(new Error('refused'));
            else resolve(url);
        });
    });
    const limited = limitPerHost(fetchImpl, 2);
    const calls = ['https://a.io/1', 'https://a.io/fail', 'https://a.io/3', 'https://a.io/4', 'https://b.io/1'].map((u) => limited(u).catch((e) => e.message));
    await tick();
    assert.deepStrictEqual([open['a.io'], open['b.io']], [2, 1], 'two to a.io, b.io not held up');
    while (waiting.length) {
        waiting.shift()();
        await tick();
    }
    assert.deepStrictEqual(await Promise.all(calls), ['https://a.io/1', 'refused', 'https://a.io/3', 'https://a.io/4', 'https://b.io/1']);
    assert.strictEqual(peak['a.io'], 2);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');

test('withTenantClaim: one holder per job and tenant; other tenants and other jobs go on; released after an error', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    let release;
    const holding = withTenantClaim(pool, { job: 'deployments', tenantId: A }, () => new Promise((r) => { release = r; }).then(() => 'first'));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(await withTenantClaim(pool, { job: 'deployments', tenantId: A }, async () => assert.fail('held')), { claimed: false });
    assert.deepStrictEqual(await withTenantClaim(pool, { job: 'deployments', tenantId: B }, async () => 'other tenant'), { claimed: true, result: 'other tenant' });
    assert.deepStrictEqual(await withTenantClaim(pool, { job: 'jira', tenantId: A }, async () => 'other job'), { claimed: true, result: 'other job' });
    release();
    assert.deepStrictEqual(await holding, { claimed: true, result: 'first' });

    await assert.rejects(() => withTenantClaim(pool, { job: 'flags', tenantId: A }, async () => { throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual(await withTenantClaim(pool, { job: 'flags', tenantId: A }, async () => 'again'), { claimed: true, result: 'again' });
    assert.deepStrictEqual(await withTenantClaim(pool, { job: 'deployments', tenantId: A }, async () => 'free again'), { claimed: true, result: 'free again' });
    await assert.rejects(() => withTenantClaim(pool, { job: 'nope', tenantId: A }, async () => {}), /No claim class/);
});
