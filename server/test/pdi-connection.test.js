// The connection with pdi (design-docs/PDI-CONNECTION-PLAN.pl.md): one card creates the pdi service token, the event
// subscription with its own signing secret and the connection; it is `connected` only once pdi has read ShipScope with
// its token and ShipScope has reached pdi (a signed ping or a delivered event). This step hides nothing yet.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { judgePdiConnection, PDI_READ_STALE_DAYS } = require('../lib/pdi-connection-model');

const NOW = new Date('2026-10-27T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const row = (over = {}) => ({ receiver_url: 'https://pdi.example.com', created_at: ago(2 * DAY), last_ping_ok_at: null, last_ping_error: null, last_ping_error_at: null, disconnected_at: null, ...over });

test('states: none, pending until both directions are proven, connected, degraded, disconnected', () => {
    const judge = (connection, extra = {}) => judgePdiConnection({ connection, tokenLastUsedAt: null, subscription: null, now: NOW, ...extra });
    assert.strictEqual(judge(null).state, 'none');
    const pending = judge(row());
    assert.strictEqual(pending.state, 'pending');
    assert.deepStrictEqual(pending.checks.map((c) => [c.id, c.ok]), [['pdi_reads', false], ['reaches_pdi', false]]);
    assert.strictEqual(judge(row({ last_ping_ok_at: ago(HOUR) })).state, 'pending', 'pdi has not read ShipScope yet');
    assert.strictEqual(judge(row(), { tokenLastUsedAt: ago(HOUR) }).state, 'pending', 'ShipScope has not reached pdi yet');

    const ok = judge(row({ last_ping_ok_at: ago(HOUR) }), { tokenLastUsedAt: ago(DAY) });
    assert.strictEqual(ok.state, 'connected');
    assert.deepStrictEqual(ok.checks.map((c) => c.ok), [true, true]);
    assert.strictEqual(judge(row(), { tokenLastUsedAt: ago(DAY), subscription: { last_delivered_at: ago(3 * DAY) } }).state, 'connected', 'a delivered event proves it too');

    const failing = judge(row({ last_ping_ok_at: ago(2 * HOUR), last_ping_error: 'pdi.example.com answered HTTP 404', last_ping_error_at: ago(10 * 60_000) }), { tokenLastUsedAt: ago(DAY) });
    assert.strictEqual(failing.state, 'degraded');
    assert.match(failing.checks[1].error, /404/);
    assert.strictEqual(judge(row({ last_ping_ok_at: ago(20 * 60_000), last_ping_error: 'x', last_ping_error_at: ago(60_000) }), { tokenLastUsedAt: ago(DAY) }).state, 'connected', 'one failure within the hour is not a problem yet');
    assert.strictEqual(judge(row({ last_ping_ok_at: ago(HOUR) }), { tokenLastUsedAt: ago((PDI_READ_STALE_DAYS + 1) * DAY) }).state, 'degraded', 'pdi stopped reading');
    assert.strictEqual(judge(row({ disconnected_at: ago(HOUR) }), { tokenLastUsedAt: ago(DAY) }).state, 'disconnected');
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { fakeGitHub, AUTH, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { deliverEvents } = require('../lib/outgoing-events');
const { pingPdiConnections } = require('../lib/pdi-connection');

const KEY = crypto.randomBytes(32);
const sign = (secret, timestamp, body) => `v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const fetch = fakeGitHub({ alice: { id: 850_500_001, login: 'alice' }, bob: { id: 850_500_002, login: 'bob' } });
    const received = [];
    let answer = 200;
    const receiver = async (url, init = {}) => {
        received.push({ url, ...init });
        if (answer instanceof Error) throw answer;
        return { status: answer, headers: {}, contentType: 'application/json', body: '{}' };
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
    const service = (token, url) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    return { pool, app, alice, bob, tenantId, as, rows, service, receiver, received, setAnswer: (a) => { answer = a; } };
}

test('connecting: admins only; one token, one subscription with its own secret; the variables are shown once', async (t) => {
    const { as, alice, bob, rows } = await setup(t);
    assert.deepStrictEqual((await as(bob)('GET', '/pdi-connection')).json().connection.state, 'none', 'members see the state');
    assert.strictEqual((await as(bob)('POST', '/pdi-connection', { receiverUrl: 'https://pdi.example.com' })).statusCode, 403);
    for (const receiverUrl of ['http://pdi.example.com', 'https://10.0.0.5', 'not a url']) {
        assert.strictEqual((await as(alice)('POST', '/pdi-connection', { receiverUrl })).statusCode, 400, receiverUrl);
    }
    const res = await as(alice)('POST', '/pdi-connection', { receiverUrl: 'https://pdi.example.com/' });
    assert.strictEqual(res.statusCode, 201, res.body);
    const { connection, env } = res.json();
    assert.deepStrictEqual([connection.state, connection.receiverUrl], ['pending', 'https://pdi.example.com']);
    assert.strictEqual(env.PDI_SHIPSCOPE_URL, AUTH.publicBaseUrl);
    assert.match(env.PDI_SHIPSCOPE_TOKEN, /^shps_[A-Za-z0-9_-]{43}$/);
    assert.match(env.PDI_SHIPSCOPE_SIGNING_SECRET, /^[A-Za-z0-9_-]{43}$/);

    const [token] = await rows('SELECT name, expires_at FROM service_tokens');
    assert.deepStrictEqual([token.name, token.expires_at], ['pdi', null]);
    const [sub] = await rows('SELECT url, types, signing_secret_enc FROM event_subscriptions');
    assert.deepStrictEqual([sub.url, sub.types], ['https://pdi.example.com/events/shipscope', ['release.stage_changed', 'feature.released']]);
    assert.ok(sub.signing_secret_enc && !sub.signing_secret_enc.includes(env.PDI_SHIPSCOPE_SIGNING_SECRET), 'stored sealed');

    const [ownSub] = await rows('SELECT id FROM event_subscriptions');
    const [ownToken] = await rows('SELECT id FROM service_tokens');
    assert.match((await as(alice)('DELETE', `/event-subscriptions/${ownSub.id}`)).json().error, /belongs to the connection with pdi/);
    assert.match((await as(alice)('DELETE', `/service-tokens/${ownToken.id}`)).json().error, /belongs to the connection with pdi/);
    const again = (await as(alice)('GET', '/pdi-connection')).json();
    assert.ok(!JSON.stringify(again).includes(env.PDI_SHIPSCOPE_TOKEN) && !JSON.stringify(again).includes(env.PDI_SHIPSCOPE_SIGNING_SECRET), 'never shown again');
    assert.strictEqual((await as(alice)('POST', '/pdi-connection', { receiverUrl: 'https://other.example.com' })).statusCode, 409);
    const kinds = (await as(alice)('GET', '/audit-events')).json().events.map((e) => [e.kind, e.subject]);
    assert.deepStrictEqual(kinds.filter(([k]) => k === 'pdi_connected'), [['pdi_connected', 'pdi.example.com']]);
});

test('proofs: pdi reads ShipScope with its token, ShipScope reaches pdi with a signed ping; then connected', async (t) => {
    const { as, alice, service, received, setAnswer, pool, receiver } = await setup(t);
    const { env } = (await as(alice)('POST', '/pdi-connection', { receiverUrl: 'https://pdi.example.com' })).json();

    const seen = await service(env.PDI_SHIPSCOPE_TOKEN, '/api/service/v1/connection');
    assert.strictEqual(seen.statusCode, 200, seen.body);
    assert.deepStrictEqual([seen.json().workspace.name, seen.json().pdi.state], ['Acme', 'pending']);
    let connection = (await as(alice)('GET', '/pdi-connection')).json().connection;
    assert.deepStrictEqual(connection.checks.map((c) => [c.id, c.ok]), [['pdi_reads', true], ['reaches_pdi', false]]);

    const tested = await as(alice)('POST', '/pdi-connection/test');
    assert.strictEqual(tested.statusCode, 200, tested.body);
    assert.strictEqual(tested.json().connection.state, 'connected');
    const ping = received.at(-1);
    assert.strictEqual(ping.url, 'https://pdi.example.com/events/shipscope');
    assert.strictEqual(ping.method || 'GET', 'GET');
    assert.strictEqual(ping.headers['x-shipscope-event'], 'ping');
    assert.strictEqual(ping.headers['x-shipscope-signature'], sign(env.PDI_SHIPSCOPE_SIGNING_SECRET, ping.headers['x-shipscope-timestamp'], ''));

    // The worker pings every hour; a failure keeps the last success and says why.
    setAnswer(404);
    assert.deepStrictEqual(await pingPdiConnections(pool, { encryptionKey: KEY, fetchImpl: receiver, now: new Date(Date.now() + 2 * 3600_000) }), { pinged: 1, failed: 1 });
    connection = (await as(alice)('GET', '/pdi-connection')).json().connection;
    assert.match(connection.checks[1].error, /HTTP 404/);
    assert.strictEqual((await as(alice)('POST', '/pdi-connection/test')).json().connection.checks[1].ok, false);
});

test('events go out signed with the connection\'s own secret, not the workspace\'s', async (t) => {
    const { as, alice, rows, pool, receiver, received, tenantId } = await setup(t);
    const { env } = (await as(alice)('POST', '/pdi-connection', { receiverUrl: 'https://pdi.example.com' })).json();
    const [sub] = await rows('SELECT id FROM event_subscriptions');
    const event = { id: 'shipscope-1', type: 'feature.released', source: 'shipscope', occurred_at: '2026-10-27T12:00:00Z', contract_version: '0.4.0', payload: {} };
    await rows('INSERT INTO event_outbox (tenant_id, subscription_id, event) VALUES ($1, $2, $3)', [tenantId, sub.id, JSON.stringify(event)]);
    assert.deepStrictEqual(await deliverEvents(pool, { encryptionKey: KEY, fetchImpl: receiver }), { delivered: 1, failed: 0, retried: 0 });
    const sent = received.at(-1);
    assert.strictEqual(sent.headers['x-shipscope-signature'], sign(env.PDI_SHIPSCOPE_SIGNING_SECRET, sent.headers['x-shipscope-timestamp'], sent.body));
});

test('disconnecting revokes the token and the subscription; the workspace can connect again', async (t) => {
    const { as, alice, bob, rows, service } = await setup(t);
    const { env } = (await as(alice)('POST', '/pdi-connection', { receiverUrl: 'https://pdi.example.com' })).json();
    assert.strictEqual((await as(bob)('DELETE', '/pdi-connection')).statusCode, 403);
    assert.strictEqual((await as(alice)('DELETE', '/pdi-connection')).statusCode, 204);
    assert.strictEqual((await service(env.PDI_SHIPSCOPE_TOKEN, '/api/service/v1/connection')).statusCode, 401);
    assert.deepStrictEqual(await rows('SELECT id FROM event_subscriptions'), []);
    assert.strictEqual((await as(alice)('GET', '/pdi-connection')).json().connection.state, 'disconnected');
    assert.strictEqual((await as(alice)('DELETE', '/pdi-connection')).statusCode, 404);

    const again = await as(alice)('POST', '/pdi-connection', { receiverUrl: 'https://pdi2.example.com' });
    assert.strictEqual(again.statusCode, 201, again.body);
    assert.strictEqual(again.json().connection.state, 'pending');
    assert.notStrictEqual(again.json().env.PDI_SHIPSCOPE_TOKEN, env.PDI_SHIPSCOPE_TOKEN);
    const kinds = (await as(alice)('GET', '/audit-events')).json().events.map((e) => e.kind);
    assert.deepStrictEqual(kinds.filter((k) => k.startsWith('pdi_')).sort(), ['pdi_connected', 'pdi_connected', 'pdi_disconnected']);
});

test('RLS: pdi_connections is invisible and unwritable without the tenant\'s scope', async (t) => {
    const { as, alice, pool, tenantId } = await setup(t);
    await as(alice)('POST', '/pdi-connection', { receiverUrl: 'https://pdi.example.com' });
    assert.deepStrictEqual((await pool.query('SELECT * FROM pdi_connections')).rows, []);
    await assert.rejects(() => pool.query("INSERT INTO pdi_connections (tenant_id, receiver_url) VALUES ($1, 'https://x.example.com')", [tenantId]), /row-level security/);
});
