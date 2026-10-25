// Flags from an endpoint (lib/endpoint-flags.js, ADR-003 increment 4): a runtime source ShipScope polls itself, with
// the customer's sealed token and a per-tenant signature. Against a real Postgres; the network is a fake safeFetch.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { listFlagSources, createIngestToken, FlagSourceConfigError } = require('../lib/flags');
const { refreshEndpointSource, signingSecret, signatureHeaders } = require('../lib/endpoint-flags');
const { checkEndpointConfig } = require('../lib/flags-logic');

const KEY = crypto.randomBytes(32);
const PROD = 'https://flags.acme.io/api/flags?env=prod';
const QA = 'https://flags.acme.io/api/flags?env=qa';

async function setup(t, { encryptionKey = KEY } = {}) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const answers = {};
    const calls = [];
    const safeFetch = async (url, { headers }) => {
        calls.push({ url, headers });
        const answer = answers[url];
        if (!answer) throw new (require('../lib/safe-fetch').SafeFetchError)('Could not reach flags.acme.io (ECONNREFUSED)');
        return { status: 200, contentType: 'application/json', ...answer };
    };
    const fetch = fakeGitHub({ alice: { id: 892_000_001, login: 'alice' }, bob: { id: 892_000_002, login: 'bob' } });
    const app = buildApp({ pool, auth: AUTH, fetch, encryptionKey, safeFetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    await rows("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
    await rows("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/api')", [tenantId]);
    const [{ user_id: aliceId }] = await rows("SELECT user_id FROM memberships WHERE role = 'admin'");
    const api = (method, url, payload, sid = alice) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid }, payload });
    const create = (extra = {}) => api('POST', '/flag-sources', {
        name: 'Flags API', kind: 'runtime', origin: 'endpoint', repoIds: [1], endpoint: { urls: { prod: PROD, qa: QA }, path: 'features' }, endpointToken: 'cust-secret-1', ...extra,
    });
    const poll = (sourceId, now = new Date()) => refreshEndpointSource(pool, { tenantId, sourceId, encryptionKey, fetchImpl: safeFetch, now });
    const values = () => rows('SELECT key, environment, state, rollout::float AS rollout, removed_at IS NOT NULL AS removed FROM flag_values WHERE tenant_id = $1 ORDER BY environment, key', [tenantId]);
    return { pool, app, alice, aliceId, tenantId, answers, calls, rows, api, create, poll, values };
}

test('checkEndpointConfig: a runtime source, https addresses per environment that safe-fetch accepts, json or yaml, a token header', () => {
    const ok = (endpoint, kind = 'runtime') => checkEndpointConfig(endpoint, { kind });
    assert.deepStrictEqual(ok({ urls: { prod: 'https://Flags.acme.io/f?env=prod' }, path: 'features', tokenHeader: 'X-Api-Key' }),
        { urls: { prod: 'https://flags.acme.io/f?env=prod' }, path: 'features', tokenHeader: 'x-api-key' });
    for (const [endpoint, kind, why] of [
        [{ urls: { prod: PROD } }, 'build', /runtime source/],
        [{ urls: {} }, undefined, /at least one environment/],
        [{ urls: { staging: PROD } }, undefined, /test, qa or prod/],
        [{ urls: { prod: 'http://flags.acme.io/f' } }, undefined, /^prod: Only https/],
        [{ urls: { prod: 'https://169.254.169.254/latest' } }, undefined, /private or reserved/],
        [{ urls: { prod: 'https://flags.internal/f' } }, undefined, /not a public name/],
        [{ urls: { prod: PROD }, format: 'ts' }, undefined, /json or yaml/],
        [{ urls: { prod: PROD }, tokenHeader: 'cookie' }, undefined, /Authorization or in a header/],
        [{ urls: { prod: PROD }, tokenHeader: 'x-shipscope-signature' }, undefined, /Authorization or in a header/],
    ]) assert.throws(() => ok(endpoint, kind), (err) => err instanceof FlagSourceConfigError && why.test(err.message), JSON.stringify(endpoint));
});

test('signing: a secret per tenant, derived from the key; the customer recomputes the HMAC over timestamp, method and URL', () => {
    const a = signingSecret(KEY, '00000000-0000-4000-8000-000000000001');
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(a, signingSecret(KEY, '00000000-0000-4000-8000-000000000002'));
    assert.notStrictEqual(a, signingSecret(crypto.randomBytes(32), '00000000-0000-4000-8000-000000000001'));
    const headers = signatureHeaders({ secret: a, url: PROD, now: new Date('2026-10-25T10:00:00Z') });
    assert.strictEqual(headers['x-shipscope-timestamp'], '1792922400');
    assert.strictEqual(headers['x-shipscope-signature'], `v1=${crypto.createHmac('sha256', a).update(`1792922400.GET.${PROD}`).digest('hex')}`);
});

test('an endpoint source: its token is sealed and never returned, it takes no ingest token, it needs the key', async (t) => {
    const { create, api, rows, pool, tenantId, aliceId } = await setup(t);
    const res = await create();
    assert.strictEqual(res.statusCode, 201, res.body);
    const { source, token } = res.json();
    assert.strictEqual(token, null);
    assert.deepStrictEqual([source.origin, source.kind, source.hasEndpointToken, source.endpoint], ['endpoint', 'runtime', true, { urls: { prod: PROD, qa: QA }, path: 'features' }]);
    assert.ok(!res.body.includes('cust-secret-1'));
    const [{ endpoint_token_enc: sealed }] = await rows('SELECT endpoint_token_enc FROM flag_sources WHERE id = $1', [source.id]);
    assert.match(sealed, /^v2\./);
    assert.ok(!sealed.includes('cust-secret-1'));
    assert.ok(!(await api('GET', '/flag-sources')).body.includes(sealed), 'the sealed value is not listed either');
    await assert.rejects(createIngestToken(pool, { tenantId, actorUserId: aliceId, sourceId: source.id }), /takes no ingest token/);

    const put = (body) => api('PUT', `/flag-sources/${source.id}`, { name: 'Flags API', kind: 'runtime', priority: 100, repoIds: [1], ...body });
    assert.strictEqual((await put({})).json().hasEndpointToken, true, 'left out: kept');
    assert.strictEqual((await put({ endpointToken: null })).json().hasEndpointToken, false, 'null: removed');
    assert.strictEqual((await put({ kind: 'build' })).statusCode, 400, 'an endpoint source stays runtime');
    assert.strictEqual((await put({ endpoint: { urls: { prod: 'https://10.0.0.5/flags' } } })).statusCode, 400);
    assert.strictEqual((await create({ name: 'B', origin: 'push' })).statusCode, 400, 'only an endpoint source has an address');
});

test('without TOKEN_ENCRYPTION_KEY endpoint sources are refused, saying why', async (t) => {
    const { create, api } = await setup(t, { encryptionKey: null });
    const res = await create();
    assert.deepStrictEqual([res.statusCode, res.json().error], [400, 'Reading flags from an endpoint needs TOKEN_ENCRYPTION_KEY on the server']);
    assert.strictEqual((await api('GET', '/flag-endpoint-signing')).statusCode, 400);
});

test('Test: the parsed flags per environment, signed and with the token; errors without values; admins only', async (t) => {
    const { app, api, answers, calls, tenantId, create } = await setup(t);
    answers[PROD] = { body: JSON.stringify({ features: { newCheckout: true, beta: 40 } }) };
    answers[QA] = { status: 401, body: '{"error":"bad token cust-secret-9"}' };
    const test1 = await api('POST', '/flag-endpoint-test', { endpoint: { urls: { prod: PROD, qa: QA }, path: 'features' }, endpointToken: 'cust-secret-9' });
    assert.strictEqual(test1.statusCode, 200, test1.body);
    assert.deepStrictEqual(test1.json().envs, [
        { env: 'qa', host: 'flags.acme.io', error: 'flags.acme.io answered HTTP 401' },
        { env: 'prod', host: 'flags.acme.io', flags: { newCheckout: { state: 'on' }, beta: { state: 'partial', rollout: 40 } } },
    ]);
    assert.ok(!test1.body.includes('cust-secret-9'), 'the answer itself never comes back');
    const prodCall = calls.find((c) => c.url === PROD);
    assert.strictEqual(prodCall.headers.authorization, 'Bearer cust-secret-9');
    const expected = crypto.createHmac('sha256', signingSecret(KEY, tenantId)).update(`${prodCall.headers['x-shipscope-timestamp']}.GET.${PROD}`).digest('hex');
    assert.strictEqual(prodCall.headers['x-shipscope-signature'], `v1=${expected}`);

    answers[PROD] = { body: JSON.stringify({ features: { dbPassword: 'hunter2' } }) };
    const bad = (await api('POST', '/flag-endpoint-test', { endpoint: { urls: { prod: PROD }, path: 'features' } })).json().envs[0];
    assert.match(bad.error, /dbPassword is not on, off or a rollout percentage/);
    assert.ok(!bad.error.includes('hunter2'));

    const { source } = (await create()).json();
    calls.length = 0;
    await api('POST', '/flag-endpoint-test', { endpoint: { urls: { prod: PROD }, tokenHeader: 'x-api-key' }, sourceId: source.id });
    assert.strictEqual(calls[0].headers['x-api-key'], 'cust-secret-1', 'a saved source is tested with its own stored token');
    assert.strictEqual(calls[0].headers.authorization, undefined);

    const link = (await api('POST', '/invitations', { role: 'member' })).json().url;
    const bob = await signIn(app, 'bob');
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    assert.strictEqual((await api('POST', '/flag-endpoint-test', { endpoint: { urls: { prod: PROD } } }, bob)).statusCode, 403);
    assert.strictEqual((await api('GET', '/flag-endpoint-signing', undefined, bob)).statusCode, 403);
    const signing = (await api('GET', '/flag-endpoint-signing')).json();
    assert.deepStrictEqual([signing.secret, signing.algorithm], [signingSecret(KEY, tenantId), 'HMAC-SHA256']);
});

test('Test is limited per workspace: it calls the customer\'s endpoints', async (t) => {
    const { api, answers } = await setup(t);
    answers[PROD] = { body: '{}' };
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await api('POST', '/flag-endpoint-test', { endpoint: { urls: { prod: PROD } } })).statusCode);
    assert.deepStrictEqual([codes.slice(0, 10).every((c) => c === 200), codes[10]], [true, 429]);
});

test('polling: each environment\'s full state written; a flag gone is removed; a failure keeps the flags and shows as an error', async (t) => {
    const { create, poll, answers, values, pool, tenantId, aliceId, rows } = await setup(t);
    const { source } = (await create()).json();
    answers[PROD] = { body: JSON.stringify({ features: { newCheckout: true, beta: 40 } }) };
    answers[QA] = { contentType: 'application/yaml', body: 'features:\n  newCheckout: false\n' };
    assert.deepStrictEqual(await poll(source.id, new Date('2026-10-25T10:00:00Z')), { read: 2, failed: 0 });
    assert.deepStrictEqual(await values(), [
        { key: 'beta', environment: 'prod', state: 'partial', rollout: 40, removed: false },
        { key: 'newCheckout', environment: 'prod', state: 'on', rollout: null, removed: false },
        { key: 'newCheckout', environment: 'qa', state: 'off', rollout: null, removed: false },
    ]);

    answers[PROD] = { body: JSON.stringify({ features: { newCheckout: true } }) };
    delete answers[QA];
    assert.deepStrictEqual(await poll(source.id, new Date('2026-10-25T10:05:00Z')), { read: 1, failed: 1 });
    const after = await values();
    assert.strictEqual(after.find((v) => v.key === 'beta').removed, true, 'no longer listed: removed');
    assert.strictEqual(after.find((v) => v.environment === 'qa').removed, false, 'a failed read removes nothing');
    const [listed] = await listFlagSources(pool, { tenantId, actorUserId: aliceId, now: new Date('2026-10-25T10:06:00Z') });
    assert.deepStrictEqual(listed.environments.map((e) => [e.env, e.state]), [['prod', 'fresh'], ['qa', 'error']]);
    const [{ last_error: qaError }] = await rows("SELECT last_error FROM flag_source_envs WHERE environment = 'qa'");
    assert.strictEqual(qaError, 'Could not reach flags.acme.io (ECONNREFUSED)');

    // A sealed token moved to another source does not open there: an error on every environment, nothing called.
    const other = (await create({ name: 'Other', endpointToken: undefined })).json().source;
    await rows('UPDATE flag_sources SET endpoint_token_enc = (SELECT endpoint_token_enc FROM flag_sources WHERE id = $1) WHERE id = $2', [source.id, other.id]);
    assert.deepStrictEqual(await poll(other.id), { read: 0, failed: 2 });
    const errors = await rows('SELECT last_error FROM flag_source_envs WHERE source_id = $1', [other.id]);
    assert.ok(errors.length === 2 && errors.every((e) => /cannot be read/.test(e.last_error)));
    assert.strictEqual(await poll('00000000-0000-4000-8000-000000000000'), null);
});
