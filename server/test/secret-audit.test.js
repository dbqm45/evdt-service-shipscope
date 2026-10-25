// The audit log of a workspace's secrets (lib/secret-audit.js) and replacing its signing secret: who showed or replaced
// a secret, set or removed an endpoint token, and when; never the secret itself. Against a real Postgres.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');

const KEY = crypto.randomBytes(32);

test('the signing secret replaced, endpoint tokens set and removed, the secret shown: each one is an event; admins only', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const calls = [];
    const safeFetch = async (url, { headers }) => {
        calls.push(headers);
        return { status: 200, contentType: 'application/json', body: '{}' };
    };
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 895_000_001, login: 'alice' }, bob: { id: 895_000_002, login: 'bob' } }), encryptionKey: KEY, safeFetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const api = (method, url, payload, sid = alice) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid }, payload });

    const { source } = (await api('POST', '/flag-sources', { name: 'Flags API', kind: 'runtime', origin: 'endpoint', endpoint: { urls: { prod: 'https://flags.acme.io/f' } }, endpointToken: 'cust-1' })).json();
    const first = (await api('GET', '/flag-endpoint-signing')).json().secret;
    const rotated = await api('POST', '/flag-endpoint-signing/rotate');
    assert.strictEqual(rotated.statusCode, 200, rotated.body);
    const second = rotated.json().secret;
    assert.match(second, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(second, first);
    assert.strictEqual((await api('GET', '/flag-endpoint-signing')).json().secret, second, 'stored: shown again as it is');

    // Requests are signed with the new secret only.
    await api('POST', '/flag-endpoint-test', { endpoint: { urls: { prod: 'https://flags.acme.io/f' } }, endpointToken: null });
    const h = calls.at(-1);
    assert.strictEqual(h['x-shipscope-signature'], `v1=${crypto.createHmac('sha256', second).update(`${h['x-shipscope-timestamp']}.GET.https://flags.acme.io/f`).digest('hex')}`);
    await api('PUT', `/flag-sources/${source.id}`, { name: 'Flags API', kind: 'runtime', priority: 100, repoIds: [], endpointToken: null });

    const events = (await api('GET', '/secret-events')).json().events;
    assert.deepStrictEqual(events.map((e) => [e.actor, e.kind, e.subject]), [
        ['alice', 'endpoint_token_removed', 'Flags API'],
        ['alice', 'signing_secret_viewed', null],
        ['alice', 'signing_secret_rotated', null],
        ['alice', 'signing_secret_viewed', null],
        ['alice', 'endpoint_token_set', 'Flags API'],
    ], 'newest first');
    const stored = await withScope(pool, { tenantId }, async (c) => JSON.stringify((await c.query('SELECT * FROM secret_events')).rows));
    assert.ok(![first, second, 'cust-1'].some((secret) => stored.includes(secret)), 'never a secret in the log');

    const link = (await api('POST', '/invitations', { role: 'member' })).json().url;
    const bob = await signIn(app, 'bob');
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    assert.strictEqual((await api('GET', '/secret-events', undefined, bob)).statusCode, 403);
    assert.strictEqual((await api('POST', '/flag-endpoint-signing/rotate', undefined, bob)).statusCode, 403);
    assert.strictEqual((await api('GET', '/secret-events')).json().events.length, 5, 'a refused attempt changes nothing');
});
