// Polling endpoint sources (lib/flag-poll.js, the worker's flags tick): when a source is read, how it backs off, the
// per-tenant limits, and a dashboard asking for a fresh read. Against a real Postgres; the network is a fake safeFetch.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { memoryLogger } = require('./helpers/memory-logger');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { createFlagSource, updateFlagSource, listFlagSources, FlagSourceConfigError } = require('../lib/flags');
const { pollEndpoints } = require('../lib/flag-poll');
const { nextPollAt, POLL } = require('../lib/flags-logic');
const { webhookTick } = require('../worker');
const { judgeWorker } = require('../lib/worker-status');

const KEY = crypto.randomBytes(32);
const at = (iso) => new Date(iso);
const minutesBetween = (a, b) => (b - a) / 60_000;

test('nextPollAt: the interval (default 5, never under 2) with ±10% jitter; after failures it doubles up to an hour', () => {
    const now = at('2026-10-25T10:00:00Z');
    const after = (opts) => minutesBetween(now, nextPollAt({ now, random: () => 0.5, ...opts }));
    assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 9].map((failures) => after({ intervalMinutes: null, failures })), [5, 10, 20, 40, 60, 60, 60]);
    assert.strictEqual(after({ intervalMinutes: 1, failures: 0 }), 2);
    assert.strictEqual(after({ intervalMinutes: 120, failures: 3 }), 120, 'a long interval is never shortened by the cap');
    assert.strictEqual(minutesBetween(now, nextPollAt({ now, intervalMinutes: 10, failures: 0, random: () => 0 })), 9);
    assert.strictEqual(minutesBetween(now, nextPollAt({ now, intervalMinutes: 10, failures: 0, random: () => 1 })), 11);
});

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const answers = {};
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (!answers[url]) throw new (require('../lib/safe-fetch').SafeFetchError)('Could not reach flags.acme.io (ECONNREFUSED)');
        return { status: 200, contentType: 'application/json', body: answers[url] };
    };
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 893_000_001, login: 'alice' } }), encryptionKey: KEY, safeFetch: fetchImpl });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    const [{ user_id: aliceId }] = await rows("SELECT user_id FROM memberships WHERE role = 'admin'");
    const add = (name, extra = {}) => createFlagSource(pool, {
        tenantId, actorUserId: aliceId, name, kind: 'runtime', origin: 'endpoint', endpoint: { urls: { prod: `https://flags.acme.io/${name}` } }, encryptionKey: KEY, ...extra,
    }).then((r) => r.source);
    const poll = (now, extra = {}) => pollEndpoints({ pool, encryptionKey: KEY, now, fetchImpl, random: () => 0.5, ...extra });
    const schedule = async (id) => (await rows('SELECT last_polled_at, next_poll_at, poll_failures FROM flag_sources WHERE id = $1', [id]))[0];
    return { pool, app, alice, aliceId, tenantId, answers, calls, rows, add, poll, schedule };
}

test('a source is read when due: at once when new, then every interval; a failing one backs off, a success resets it', async (t) => {
    const { add, poll, schedule, answers, calls } = await setup(t);
    const source = await add('a');
    answers['https://flags.acme.io/a'] = '{"newCheckout": true}';
    assert.deepStrictEqual(await poll(at('2026-10-25T10:00:00Z')), { tenants: 1, sources: 1, failed: 0 });
    assert.deepStrictEqual(await schedule(source.id), { last_polled_at: at('2026-10-25T10:00:00Z'), next_poll_at: at('2026-10-25T10:05:00Z'), poll_failures: 0 });
    assert.deepStrictEqual(await poll(at('2026-10-25T10:04:00Z')), { tenants: 0, sources: 0, failed: 0 }, 'not due yet');
    assert.strictEqual(calls.length, 1);

    delete answers['https://flags.acme.io/a'];
    assert.deepStrictEqual(await poll(at('2026-10-25T10:05:00Z')), { tenants: 1, sources: 1, failed: 1 });
    assert.deepStrictEqual(await schedule(source.id), { last_polled_at: at('2026-10-25T10:05:00Z'), next_poll_at: at('2026-10-25T10:15:00Z'), poll_failures: 1 });
    await poll(at('2026-10-25T10:15:00Z'));
    assert.strictEqual((await schedule(source.id)).next_poll_at.toISOString(), '2026-10-25T10:35:00.000Z', 'twice as long after a second failure');

    answers['https://flags.acme.io/a'] = '{"newCheckout": false}';
    await poll(at('2026-10-25T10:35:00Z'));
    assert.deepStrictEqual(await schedule(source.id), { last_polled_at: at('2026-10-25T10:35:00Z'), next_poll_at: at('2026-10-25T10:40:00Z'), poll_failures: 0 });
});

test('the source\'s own interval; saving it reads it at the next tick', async (t) => {
    const { add, poll, schedule, answers, pool, tenantId, aliceId } = await setup(t);
    const source = await add('a', { pollIntervalMinutes: 30 });
    answers['https://flags.acme.io/a'] = '{}';
    await poll(at('2026-10-25T10:00:00Z'));
    assert.strictEqual((await schedule(source.id)).next_poll_at.toISOString(), '2026-10-25T10:30:00.000Z');
    const saved = await updateFlagSource(pool, { tenantId, actorUserId: aliceId, sourceId: source.id, name: 'a', kind: 'runtime', priority: 100, repoIds: [], pollIntervalMinutes: null, encryptionKey: KEY });
    assert.deepStrictEqual([saved.pollIntervalMinutes, saved.effectivePollIntervalMinutes, saved.nextPollAt], [null, POLL.defaultMinutes, null]);
    assert.deepStrictEqual(await poll(at('2026-10-25T10:01:00Z')), { tenants: 1, sources: 1, failed: 0 });
    const [listed] = await listFlagSources(pool, { tenantId, actorUserId: aliceId });
    assert.deepStrictEqual([listed.lastPolledAt, listed.nextPollAt, listed.pollFailures], [at('2026-10-25T10:01:00Z'), at('2026-10-25T10:06:00Z'), 0]);
});

test('per tenant: at most 20 endpoint sources, at most 10 read in one tick (the rest the next one)', async (t) => {
    const { add, poll, answers } = await setup(t);
    for (let i = 0; i < POLL.maxSources; i++) {
        await add(`s${i}`);
        answers[`https://flags.acme.io/s${i}`] = '{}';
    }
    await assert.rejects(add('one-too-many'), (err) => err instanceof FlagSourceConfigError && /at most 20 endpoints/.test(err.message));
    assert.deepStrictEqual(await poll(at('2026-10-25T10:00:00Z')), { tenants: 1, sources: 10, failed: 0 });
    assert.deepStrictEqual(await poll(at('2026-10-25T10:01:00Z')), { tenants: 1, sources: 10, failed: 0 });
    assert.deepStrictEqual(await poll(at('2026-10-25T10:02:00Z')), { tenants: 0, sources: 0, failed: 0 });
});

test('a dashboard opened asks for a fresh read: queued per tenant, drained on demand, never more than once a minute nor while failing', async (t) => {
    const { app, alice, tenantId, add, poll, answers, pool, calls } = await setup(t);
    await add('ok');
    await add('down');
    answers['https://flags.acme.io/ok'] = '{}';
    await poll(at('2026-10-25T10:00:00Z'));
    calls.length = 0;

    assert.strictEqual((await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).statusCode, 200);
    assert.deepStrictEqual((await pool.query("SELECT external_key FROM sync_requests WHERE source = 'flags'")).rows, [{ external_key: tenantId }]);

    // Read just now: skipped. A minute later: read, except the source that is backing off.
    assert.deepStrictEqual(await poll(at('2026-10-25T10:00:30Z'), { tenantIds: [tenantId], onDemand: true }), { tenants: 0, sources: 0, failed: 0 });
    assert.deepStrictEqual(await poll(at('2026-10-25T10:01:00Z'), { tenantIds: [tenantId, 'not-a-uuid'], onDemand: true }), { tenants: 1, sources: 1, failed: 0 });
    assert.deepStrictEqual(calls, ['https://flags.acme.io/ok']);

    // The worker's webhook tick drains the request with an on-demand pass for exactly that tenant.
    const seen = [];
    await webhookTick(pool, { app: null, atlassian: null, encryptionKey: KEY }, memoryLogger().logger, {
        pollEndpoints: async (args) => {
            seen.push([args.tenantIds, args.onDemand, args.encryptionKey === KEY]);
            return { tenants: 1, sources: 1, failed: 0 };
        },
    });
    assert.deepStrictEqual(seen, [[[tenantId], true, true]]);
    assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM sync_requests WHERE source = 'flags'")).rows[0].n, 0);
});

test('GET /health/worker watches the flags tick when endpoint sources are on (TOKEN_ENCRYPTION_KEY set)', () => {
    const now = at('2026-10-25T10:00:00Z');
    const heartbeat = { job: 'heartbeat', last_run_at: now, last_ok_at: now, details: {} };
    const judge = (rows, flags = true) => judgeWorker({ rows: [heartbeat, ...rows], queue: { pending: 0, oldestAt: null }, expect: { deployments: false, jira: false, flags }, syncIntervalMinutes: 15, now });
    assert.deepStrictEqual([judge([]).status, judge([]).checks.flags.status], ['down', 'fail']);
    assert.strictEqual(judge([{ job: 'flags', last_run_at: now, last_ok_at: at('2026-10-25T09:59:00Z'), details: { failed: 0 } }]).status, 'ok');
    assert.strictEqual(judge([], false).checks.flags, undefined);
});

test('two workers polling at once read a source once: the tenant is claimed, what is due is read under the claim', async (t) => {
    const { add, poll, answers, calls } = await setup(t);
    await add('a');
    await add('b');
    answers['https://flags.acme.io/a'] = '{"newCheckout": true}';
    answers['https://flags.acme.io/b'] = '{"darkMode": false}';
    const now = at('2026-10-25T10:00:00Z');
    const results = await Promise.all([poll(now, { concurrency: 2 }), poll(now, { concurrency: 2 })]);
    assert.deepStrictEqual(calls.sort(), ['https://flags.acme.io/a', 'https://flags.acme.io/b'], 'each source once');
    assert.strictEqual(results.reduce((n, r) => n + r.sources, 0), 2);
});
