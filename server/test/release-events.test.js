// Outgoing release events (G1.5, pdi contract 0.4.0): release.stage_changed when a planned flag moves to another
// rollout stage on PROD, feature.released (with `release`) when every item of a line is with users. The plan is pure
// (lib/release-events-model.js); the statuses come from the real docs/app-model.js run on the server
// (lib/release-status.js); delivery is signed and retried (lib/outgoing-events.js).
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { planReleaseEvents, eventEnvelope, emptyEventState, checkEvent } = require('../lib/release-events-model');

const NOW = new Date('2026-11-10T09:00:00.123Z');
const group = (over = {}) => ({
    key: 'CHG-12', mvp: 'R1',
    lines: [
        { id: 'R1', released: false, items: [{ key: 'TSK-57', onProd: true }, { key: 'TSK-58', onProd: false }] },
        { id: 'R2', released: false, items: [{ key: 'TSK-59', onProd: false }] },
    ],
    flags: [{ key: 'payment-retry', hasPlan: true, stage: 'internal', status: 'ready', percent: 0, release: 'R1' }],
    ...over,
});

test('the first look at a change only records it; a stage move is release.stage_changed; a flag turned off is not', () => {
    let { events, state } = planReleaseEvents({ groups: [group()], previous: emptyEventState(), now: NOW });
    assert.deepStrictEqual(events, [], 'no history sent when a subscription starts');

    ({ events, state } = planReleaseEvents({ groups: [group({ flags: [{ key: 'payment-retry', hasPlan: true, stage: '10%', status: 'waiting', percent: 10, release: 'R1' }] })], previous: state, now: NOW }));
    assert.deepStrictEqual(events.map((e) => [e.type, e.payload]), [['release.stage_changed', { change: 'CHG-12', release: 'R1', flag: 'payment-retry', from_stage: 'internal', to_stage: '10%', rollout: 10 }]]);
    assert.strictEqual(events[0].occurred_at, '2026-11-10T09:00:00Z');
    assert.deepStrictEqual(checkEvent(events[0]), [], 'valid by the pinned contract schema');

    ({ events, state } = planReleaseEvents({ groups: [group({ flags: [{ key: 'payment-retry', hasPlan: true, stage: '10%', status: 'ready', percent: 10, release: 'R1' }] })], previous: state, now: NOW }));
    assert.deepStrictEqual(events, [], 'same stage, nothing');

    ({ events, state } = planReleaseEvents({ groups: [group({ flags: [{ key: 'payment-retry', hasPlan: true, stage: null, status: 'not_started', percent: 0, release: 'R1' }] })], previous: state, now: NOW }));
    assert.deepStrictEqual(events, [], 'turned off: no stage to name');
    ({ events } = planReleaseEvents({ groups: [group({ flags: [{ key: 'payment-retry', hasPlan: true, stage: 'internal', status: 'ready', percent: 1, release: 'R1' }] })], previous: state, now: NOW }));
    assert.deepStrictEqual(events.map((e) => [e.payload.from_stage, e.payload.to_stage]), [[undefined, 'internal']], 'back on: no from_stage');
    assert.deepStrictEqual(checkEvent(events[0]), []);

    const noPlan = planReleaseEvents({ groups: [group({ flags: [{ key: 'x', hasPlan: false, stage: null, status: 'no_plan', percent: 30 }] })], previous: state, now: NOW });
    assert.deepStrictEqual(noPlan.events, [], 'a flag without a plan has no stages');
});

test('feature.released once per line when all its items are on PROD, with `release`; again after it un-released', () => {
    const released = (r1) => group({ lines: [{ id: 'R1', released: r1, items: [{ key: 'TSK-57', onProd: true }, { key: 'TSK-58', onProd: r1 }] }] });
    let { state } = planReleaseEvents({ groups: [released(false)], previous: emptyEventState(), now: NOW });
    let events;
    ({ events, state } = planReleaseEvents({ groups: [released(true)], previous: state, now: NOW }));
    assert.deepStrictEqual(events.map((e) => [e.type, e.payload]), [['feature.released', { change: 'CHG-12', release: 'R1', tasks: ['TSK-57', 'TSK-58'], released_at: '2026-11-10T09:00:00Z', environment: 'prod' }]]);
    assert.deepStrictEqual(checkEvent(events[0]), []);
    ({ events, state } = planReleaseEvents({ groups: [released(true)], previous: state, now: NOW }));
    assert.deepStrictEqual(events, [], 'once');
    ({ state } = planReleaseEvents({ groups: [released(false)], previous: state, now: NOW }));
    ({ events } = planReleaseEvents({ groups: [released(true)], previous: state, now: NOW }));
    assert.strictEqual(events.length, 1, 'a line rolled back and released again is news again');

    const baseline = planReleaseEvents({ groups: [released(true)], previous: emptyEventState(), now: NOW });
    assert.deepStrictEqual(baseline.events, [], 'already released when first seen: not sent');
    assert.deepStrictEqual(planReleaseEvents({ groups: [{ ...released(true), key: '' }], previous: emptyEventState(), now: NOW }).state, emptyEventState(), 'issues without an Epic are no change');
});

test('eventEnvelope: the contract\'s envelope; checkEvent refuses what the schema refuses', () => {
    const e = eventEnvelope('feature.released', { change: 'CHG-12', released_at: '2026-11-10T09:00:00Z' }, NOW);
    assert.match(e.id, /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual([e.type, e.source, e.contract_version, e.occurred_at], ['feature.released', 'shipscope', '0.4.0', '2026-11-10T09:00:00Z']);
    assert.deepStrictEqual(checkEvent(e), []);
    assert.match(checkEvent({ ...e, payload: { change: 'chg-12', released_at: 'now' } }).join('\n'), /payload\.change: does not match[\s\S]*payload\.released_at: does not match/);
    assert.match(checkEvent({ ...e, payload: { ...e.payload, extra: 1 } }).join('\n'), /payload\.extra: is not allowed/);
    assert.match(checkEvent({ ...e, type: 'release.stage_changed', payload: { change: 'CHG-12', flag: 'f', to_stage: 'x', rollout: 101 } }).join('\n'), /payload\.rollout: above 100/);
    assert.match(checkEvent({ ...e, source: 'jira' }).join('\n'), /source: is not one of/);
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'event.v0.4.0.schema.json'), 'utf8'));
    assert.match(schema.title, /kontrakt 0\.4\.0/, 'the pinned copy of the contract\'s event schema');
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { fakeGitHub, AUTH, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { refreshWorkItems } = require('../lib/work-items');
const { detectReleaseEvents, deliverEvents, eventSignature } = require('../lib/outgoing-events');
const { tenantSigningSecret } = require('../lib/endpoint-flags');

const KEY = crypto.randomBytes(32);
const sha = (n) => n.toString(16).padStart(40, 'e');
const DIR = 'docs/project/changes';
const PLAN_MD = '---\nartifact: plan\nchange: CHG-12\ntasks: [TSK-57, TSK-58]\n---\n\n- TSK-57: Retry endpoint (done)\n- TSK-58: Idempotency key (done)\n';
const RELEASE = 'change: CHG-12\nmvp: { release: R1 }\nreleases:\n  - { id: R1, name: MVP, tasks: [TSK-57, TSK-58] }\nflags:\n  - key: payment-retry\n    tasks: [TSK-57, TSK-58]\n    remove_by: 2026-12-31\n    rollout: [{ stage: internal, min_days: 3 }, { stage: "10%", min_days: 7 }, { stage: "100%" }]\n';

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const repo = { files: { [sha(1)]: { [`${DIR}/CHG-12/plan.md`]: PLAN_MD, [`${DIR}/CHG-12/release.yaml`]: RELEASE } }, trees: {}, fileCommits: { [DIR]: [sha(1)] } };
    repo.trees[sha(1)] = { truncated: false, tree: Object.keys(repo.files[sha(1)]).map((p) => ({ path: p, type: 'blob', sha: 'x' })) };
    const fetch = fakeGitHub({ alice: { id: 850_300_001, login: 'alice' }, bob: { id: 850_300_002, login: 'bob' } }, { repos: { 'acme/pay': repo } });
    const received = [];
    let answer = 200;
    const receiver = async (url, init) => {
        received.push({ url, ...init });
        if (answer instanceof Error) throw answer;
        return { status: answer, headers: {}, contentType: 'text/plain', body: '' };
    };
    const app = buildApp({ pool, auth: AUTH, fetch, encryptionKey: KEY, safeFetch: receiver });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const as = (sid) => (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid }, payload });
    const link = (await as(alice)('POST', '/invitations', { role: 'member' })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    await rows("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
    await rows("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/pay')", [tenantId]);
    await refreshWorkItems({ pool, token: 'inst-token-1', tenantId, repo: { repoId: 1, fullName: 'acme/pay' }, fetch });
    await rows(`INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at, related_issues)
                VALUES ($1, 1, 1, 'prod', 'success', $2, now(), '{TSK-57,TSK-58}')`, [tenantId, sha(9)]);
    const { token } = (await as(alice)('POST', '/flag-sources', { name: 'LD', kind: 'runtime', repoIds: [1] })).json();
    const flag = (state, rollout) => app.inject({
        method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token.token}` },
        payload: { schemaVersion: 2, observations: [{ key: 'payment-retry', env: 'prod', state, ...(rollout === undefined ? {} : { rollout }) }], flags: [{ key: 'payment-retry', itemKeys: ['TSK-57', 'TSK-58'] }] },
    });
    const detect = (now = new Date()) => detectReleaseEvents(pool, { tenantId, now });
    const deliver = (now = new Date()) => deliverEvents(pool, { encryptionKey: KEY, fetchImpl: receiver, now });
    return { pool, app, alice, bob, tenantId, as, rows, flag, detect, deliver, received, setAnswer: (a) => { answer = a; } };
}

test('end to end: subscribed, a baseline, a stage move and the MVP released are sent signed; a failure is retried', async (t) => {
    const { as, alice, bob, tenantId, pool, rows, flag, detect, deliver, received, setAnswer } = await setup(t);
    const admin = as(alice);
    assert.strictEqual((await as(bob)('POST', '/event-subscriptions', { url: 'https://pdi.acme.io/hooks', types: ['feature.released'] })).statusCode, 403);
    for (const body of [{ url: 'http://pdi.acme.io/hooks', types: ['feature.released'] }, { url: 'https://10.0.0.1/hooks', types: ['feature.released'] }, { url: 'https://pdi.acme.io/hooks', types: ['gate.decided'] }, { url: 'https://pdi.acme.io/hooks', types: [] }]) {
        assert.strictEqual((await admin('POST', '/event-subscriptions', body)).statusCode, 400, JSON.stringify(body));
    }
    const created = await admin('POST', '/event-subscriptions', { url: 'https://pdi.acme.io/hooks', types: ['release.stage_changed', 'feature.released'] });
    assert.strictEqual(created.statusCode, 201, created.body);
    const subId = created.json().subscription.id;

    assert.strictEqual((await flag('on')).statusCode, 200);
    assert.deepStrictEqual(await detect(), { events: 0, queued: 0 }, 'the first look is the baseline (the flag is on: stage 100%, R1 released)');

    // The flag goes back to 10%: a stage change; the line is no longer released (its flag is partial).
    await flag('partial', 10);
    assert.deepStrictEqual(await detect(), { events: 1, queued: 1 });
    // Fully on again: a stage change and R1 released.
    await flag('on');
    assert.deepStrictEqual(await detect(), { events: 2, queued: 2 });
    assert.deepStrictEqual(await detect(), { events: 0, queued: 0 }, 'nothing new');

    assert.deepStrictEqual(await deliver(), { delivered: 3, failed: 0, retried: 0 });
    const bodies = received.map((r) => JSON.parse(r.body));
    assert.deepStrictEqual(bodies.map((b) => [b.type, b.payload.to_stage || b.payload.release]), [['release.stage_changed', '10%'], ['release.stage_changed', '100%'], ['feature.released', 'R1']]);
    assert.deepStrictEqual(bodies[2].payload.tasks, ['TSK-57', 'TSK-58']);
    const secret = await withScope(pool, { tenantId }, (c) => tenantSigningSecret(c, { tenantId, encryptionKey: KEY }));
    for (const r of received) {
        assert.strictEqual(r.method, 'POST');
        assert.strictEqual(r.url, 'https://pdi.acme.io/hooks');
        assert.strictEqual(r.headers['content-type'], 'application/json');
        assert.strictEqual(r.headers['x-shipscope-event'], JSON.parse(r.body).type);
        assert.strictEqual(r.headers['x-shipscope-signature'], eventSignature({ secret, timestamp: r.headers['x-shipscope-timestamp'], body: r.body }), 'the workspace signing secret over "<timestamp>.<body>"');
    }
    assert.deepStrictEqual(await deliver(), { delivered: 0, failed: 0, retried: 0 }, 'delivered once');

    // The receiver fails: retried later with a growing wait; the error is on the subscription.
    setAnswer(500);
    await flag('partial', 10);
    await detect();
    const t0 = new Date();
    assert.deepStrictEqual(await deliver(t0), { delivered: 0, failed: 0, retried: 1 });
    assert.deepStrictEqual(await deliver(t0), { delivered: 0, failed: 0, retried: 0 }, 'not before its next attempt');
    const [outbox] = await rows('SELECT attempts, next_attempt_at FROM event_outbox WHERE delivered_at IS NULL');
    assert.strictEqual(outbox.attempts, 1);
    assert.ok(outbox.next_attempt_at.getTime() >= t0.getTime() + 55_000, 'a minute later at least');
    const list = (await admin('GET', '/event-subscriptions')).json().subscriptions;
    assert.deepStrictEqual([list[0].id, list[0].url, list[0].types, /HTTP 500/.test(list[0].lastError), list[0].pending], [subId, 'https://pdi.acme.io/hooks', ['release.stage_changed', 'feature.released'], true, 1]);
    setAnswer(200);
    assert.deepStrictEqual(await deliver(new Date(t0.getTime() + 3600_000)), { delivered: 1, failed: 0, retried: 0 });
    assert.strictEqual((await admin('GET', '/event-subscriptions')).json().subscriptions[0].lastError, null, 'a later success clears it');

    // A subscription that is removed takes its queue with it; the change is in the settings activity.
    assert.strictEqual((await admin('DELETE', `/event-subscriptions/${subId}`)).statusCode, 204);
    assert.strictEqual((await rows('SELECT count(*)::int AS n FROM event_outbox'))[0].n, 0);
    const kinds = (await admin('GET', '/audit-events')).json().events.map((e) => e.kind);
    assert.ok(kinds.includes('event_subscription_added') && kinds.includes('event_subscription_removed'));
});

test('limits and isolation: at most 5 subscriptions; ten failed attempts give up; RLS on the three tables', async (t) => {
    const { as, alice, pool, tenantId, rows, flag, detect, deliver, setAnswer } = await setup(t);
    for (let i = 0; i < 5; i++) assert.strictEqual((await as(alice)('POST', '/event-subscriptions', { url: `https://h${i}.acme.io/x`, types: ['feature.released'] })).statusCode, 201);
    assert.strictEqual((await as(alice)('POST', '/event-subscriptions', { url: 'https://h6.acme.io/x', types: ['feature.released'] })).statusCode, 400);
    await rows("DELETE FROM event_subscriptions WHERE url <> 'https://h0.acme.io/x'");

    await flag('partial', 10);
    await detect();
    await flag('on');
    await detect();
    setAnswer(new Error('connection refused'));
    let now = Date.now();
    for (let i = 0; i < 10; i++) {
        now += 2 * 3600_000;
        await deliver(new Date(now));
    }
    const [row] = await rows('SELECT attempts, failed_at, last_error FROM event_outbox');
    assert.deepStrictEqual([row.attempts, Boolean(row.failed_at), /connection refused/.test(row.last_error)], [10, true, true]);
    assert.deepStrictEqual(await deliver(new Date(now + 10 * 3600_000)), { delivered: 0, failed: 0, retried: 0 }, 'given up');

    for (const table of ['event_subscriptions', 'event_state', 'event_outbox']) {
        assert.ok((await rows(`SELECT * FROM ${table}`)).length > 0, `${table} in scope`);
        assert.strictEqual((await pool.query(`SELECT * FROM ${table}`)).rows.length, 0, `${table}: unscoped reads see nothing`);
        assert.strictEqual((await withScope(pool, { tenantId: crypto.randomUUID() }, (c) => c.query(`SELECT * FROM ${table}`))).rows.length, 0);
    }
    await assert.rejects(() => pool.query("INSERT INTO event_state (tenant_id, kind, subject, value) VALUES ($1, 'seen', 'CHG-1', '1')", [tenantId]), /row-level security/);
});
