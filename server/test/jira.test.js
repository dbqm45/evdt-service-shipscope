const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { seal, open, SecretBoxError } = require('../lib/secret-box');
const { loadAtlassianConfig } = require('../lib/config');
const { SCOPES, AtlassianError, buildAuthorizeUrl, exchangeCode, refreshAccessToken, fetchJiraSites } = require('../lib/atlassian');

const KEY = crypto.randomBytes(32);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('secret box: round trip; tampering, another key or another tenant fails', () => {
    const sealed = seal(KEY, 'refresh-123', 'tenant-a');
    assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(!sealed.includes('refresh-123'));
    assert.notStrictEqual(seal(KEY, 'refresh-123', 'tenant-a'), sealed, 'a fresh IV every time');
    assert.strictEqual(open(KEY, sealed, 'tenant-a'), 'refresh-123');
    assert.throws(() => open(KEY, sealed, 'tenant-b'), SecretBoxError, 'bound to its tenant');
    assert.throws(() => open(crypto.randomBytes(32), sealed, 'tenant-a'), SecretBoxError);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('x'.repeat(11)).toString('base64url');
    assert.throws(() => open(KEY, parts.join('.'), 'tenant-a'), SecretBoxError, 'tampered');
    assert.throws(() => open(KEY, 'plain-token', 'tenant-a'), SecretBoxError);
});

test('loadAtlassianConfig: off when unset, all three or nothing, a 32-byte base64 key', () => {
    assert.strictEqual(loadAtlassianConfig({}), null);
    const good = { ATLASSIAN_CLIENT_ID: 'id', ATLASSIAN_CLIENT_SECRET: 'secret', TOKEN_ENCRYPTION_KEY: KEY.toString('base64') };
    assert.deepStrictEqual(loadAtlassianConfig(good).encryptionKey, KEY);
    assert.throws(() => loadAtlassianConfig({ ATLASSIAN_CLIENT_ID: 'id' }), /ATLASSIAN_CLIENT_SECRET is not set.*TOKEN_ENCRYPTION_KEY is not set/);
    for (const bad of ['short', crypto.randomBytes(16).toString('base64'), crypto.randomBytes(32).toString('hex')]) {
        assert.throws(() => loadAtlassianConfig({ ...good, TOKEN_ENCRYPTION_KEY: bad }), /32 bytes, base64/);
    }
    // Jira webhooks need a public https address; local http (or none) just leaves them off.
    assert.strictEqual(loadAtlassianConfig(good).webhookUrl, null);
    assert.strictEqual(loadAtlassianConfig({ ...good, PUBLIC_BASE_URL: 'http://localhost:3000' }).webhookUrl, null);
    assert.strictEqual(loadAtlassianConfig({ ...good, PUBLIC_BASE_URL: 'https://shipscope.example.com/' }).webhookUrl, 'https://shipscope.example.com/webhooks/jira');
    assert.strictEqual(loadAtlassianConfig({ ...good, PUBLIC_BASE_URL: 'https://shipscope.example.com/app' }).webhookUrl, null);
});

test('atlassian client: authorize URL asks for read scopes, its own webhooks and offline access; responses are checked', async () => {
    const url = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://localhost:3000/auth/atlassian/callback', state: 's1' }));
    assert.strictEqual(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
    assert.deepStrictEqual(Object.fromEntries(url.searchParams), {
        audience: 'api.atlassian.com', client_id: 'cid', scope: SCOPES.join(' '), redirect_uri: 'http://localhost:3000/auth/atlassian/callback',
        state: 's1', response_type: 'code', prompt: 'consent',
    });
    // Read-only on Jira's data; the one write is ShipScope's own webhook registration (lib/jira-sync.js ensureWebhook()).
    assert.ok(SCOPES.includes('offline_access') && SCOPES.every((s) => s.startsWith('read:') || s === 'offline_access' || s === 'manage:jira-webhook'), 'read-only');
    assert.ok(SCOPES.includes('read:project:jira'), 'the Agile board list needs it');

    const reject = (status, body) => async () => json(body, status);
    await assert.rejects(exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r', fetch: reject(200, { token_type: 'Bearer' }) }), /no access_token/);
    await assert.rejects(refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch: reject(403, { error: 'invalid_grant' }) }),
        (err) => err instanceof AtlassianError && err.reconnect && /invalid_grant/.test(err.message));
    await assert.rejects(refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch: reject(503, {}) }),
        (err) => err instanceof AtlassianError && !err.reconnect, 'an outage is not a revoked grant');
    await assert.rejects(refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch: async () => { throw new Error('ECONNRESET'); } }),
        (err) => err instanceof AtlassianError && !err.reconnect);

    const sites = await fetchJiraSites({ accessToken: 't', fetch: async () => json([
        { id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work', 'read:jira-user'] },
        { id: 'cloud-2', url: 'https://acme-confluence.atlassian.net', name: 'wiki', scopes: ['read:confluence-content.all'] },
        { id: 'bad id', url: 'https://x.atlassian.net', name: 'x', scopes: ['read:jira-work'] },
        { id: 'cloud-3', url: 'http://insecure.example', name: 'y', scopes: ['read:jira-work'] },
        null,
    ]) });
    assert.deepStrictEqual(sites, [{ cloudId: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }]);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { withScope } = require('../lib/scope');
const { accessTokenFor, JiraNotConnectedError } = require('../lib/jira-connections');
const { fakeAtlassian } = require('./helpers/atlassian');

const USERS = { alice: { id: 880_000_001, login: 'alice' }, bob: { id: 880_000_002, login: 'bob' }, mallory: { id: 880_000_003, login: 'mallory' } };
const ATLASSIAN = { clientId: 'atl-client', clientSecret: 'atl-secret', encryptionKey: KEY };
const SITE_A = { id: 'cloud-a', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work', 'read:jira-user'] };
const SITE_B = { id: 'cloud-b', url: 'https://acme-labs.atlassian.net', name: 'acme-labs', scopes: ['read:jira-work'] };

async function setup(t, { codes = {}, offline } = {}) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const atlassian = fakeAtlassian({ codes, offline });
    const github = fakeGitHub(USERS);
    const fetch = (url, init) => (/^https:\/\/(auth|api)\.atlassian\.com\//.test(url) ? atlassian.handler(url, init) : github(url, init));
    const app = buildApp({ pool, auth: AUTH, atlassian: ATLASSIAN, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const bob = await signIn(app, 'bob');
    const link = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice }, payload: { role: 'member' } })).json().url;
    assert.strictEqual((await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } })).statusCode, 201);

    /** connect -> Atlassian -> callback with `code`; returns the callback response. */
    const connect = async (sid, code, { tamperState = false, query } = {}) => {
        const start = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/connect`, cookies: { sid } });
        if (start.statusCode !== 302) return start;
        const state = new URL(start.headers.location).searchParams.get('state');
        const cookie = start.cookies.find((c) => c.name === 'jira_connect');
        return app.inject({
            method: 'GET',
            url: `/auth/atlassian/callback?${query ? query.replace('__STATE__', state) : `code=${code}&state=${tamperState ? 'x'.repeat(22) : state}`}`,
            cookies: { sid, jira_connect: cookie.value },
        });
    };
    const status = async (sid = alice) => (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira`, cookies: { sid } })).json();
    const rows = (sql) => withScope(pool, { tenantId }, async (c) => (await c.query(sql)).rows);
    return { pool, app, alice, bob, tenantId, connect, status, rows, atlassian };
}

test('connect: an admin links one Jira site; only an encrypted refresh token is stored; projects are listed through it', async (t) => {
    const { app, alice, tenantId, connect, status, rows, atlassian } = await setup(t, { codes: { c1: [SITE_A] } });
    assert.deepStrictEqual(await status(), { connected: false });

    const start = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/connect`, cookies: { sid: alice } });
    assert.strictEqual(start.statusCode, 302);
    assert.match(start.headers.location, /^https:\/\/auth\.atlassian\.com\/authorize\?/);
    const cookie = start.cookies.find((c) => c.name === 'jira_connect');
    assert.ok(cookie.httpOnly && cookie.path === '/auth/atlassian');

    const res = await connect(alice, 'c1');
    assert.strictEqual(res.statusCode, 302, res.body);
    assert.strictEqual(res.headers.location, `/t/${tenantId}/settings#jira`);
    const s = await status();
    assert.deepStrictEqual([s.connected, s.site, s.lastError, 'sites' in s], [true, { cloudId: 'cloud-a', url: 'https://acme.atlassian.net', name: 'acme' }, null, false]);

    const [stored] = await rows('SELECT refresh_token_enc FROM jira_connections');
    assert.match(stored.refresh_token_enc, /^v1\./);
    assert.ok(!stored.refresh_token_enc.includes('refresh-'), 'never in clear text');
    assert.ok(!JSON.stringify(s).includes('refresh-') && !JSON.stringify(s).includes('access-'), 'no token reaches the client');

    // Listing projects refreshes the token (rotation: the stored one is replaced) and pages through the results.
    const projects = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/projects`, cookies: { sid: alice } });
    assert.strictEqual(projects.statusCode, 200, projects.body);
    assert.deepStrictEqual(projects.json().projects.map((p) => p.key), ['ABC', 'DEF', 'GHI']);
    const again = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/projects`, cookies: { sid: alice } });
    assert.strictEqual(again.statusCode, 200, 'works again with the rotated refresh token');
    assert.strictEqual(atlassian.calls.filter((u) => u.endsWith('/oauth/token')).length, 3, 'one code exchange + one refresh per use');
});

test('connect: the state must round-trip; declined consent, missing offline access or no Jira site store nothing', async (t) => {
    const { app, alice, tenantId, connect, status } = await setup(t, { codes: { c1: [SITE_A], c2: [{ ...SITE_A, scopes: ['read:confluence-content.all'] }] } });
    assert.strictEqual((await connect(alice, 'c1', { tamperState: true })).statusCode, 400);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/auth/atlassian/callback?code=c1&state=${'y'.repeat(22)}`, cookies: { sid: alice } })).statusCode, 400, 'no cookie');
    const declined = await connect(alice, null, { query: `error=access_denied&state=__STATE__` });
    assert.strictEqual(declined.statusCode, 400);
    assert.strictEqual((await connect(alice, 'c2')).statusCode, 400, 'no Jira site in the grant');
    assert.strictEqual((await connect(alice, 'unknown')).statusCode, 502, 'Atlassian rejects the code');
    assert.deepStrictEqual(await status(), { connected: false });
});

test('connect: without offline access there is nothing to sync with later, so nothing is stored', async (t) => {
    const { alice, connect, status } = await setup(t, { codes: { c1: [SITE_A] }, offline: false });
    assert.strictEqual((await connect(alice, 'c1')).statusCode, 502);
    assert.deepStrictEqual(await status(), { connected: false });
});

test('several sites: an admin picks one of them; a reconnect keeps the choice', async (t) => {
    const { app, alice, bob, tenantId, connect, status } = await setup(t, { codes: { c1: [SITE_A, SITE_B], c2: [SITE_A, SITE_B] } });
    await connect(alice, 'c1');
    let s = await status();
    assert.deepStrictEqual([s.site, s.sites.map((x) => x.cloudId)], [null, ['cloud-a', 'cloud-b']]);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/projects`, cookies: { sid: alice } })).statusCode, 409, 'no site chosen yet');

    const put = (sid, cloudId) => app.inject({ method: 'PUT', url: `/tenants/${tenantId}/jira/site`, cookies: { sid }, payload: { cloudId } });
    assert.strictEqual((await put(bob, 'cloud-b')).statusCode, 403);
    assert.strictEqual((await put(alice, 'cloud-zzz')).statusCode, 400, 'not one the grant covers');
    assert.strictEqual((await put(alice, 'cloud b')).statusCode, 400);
    assert.deepStrictEqual((await put(alice, 'cloud-b')).json(), { cloudId: 'cloud-b', url: 'https://acme-labs.atlassian.net', name: 'acme-labs' });

    await connect(alice, 'c2');
    s = await status();
    assert.strictEqual(s.site.cloudId, 'cloud-b', 'kept across a reconnect');
});

test('a revoked grant is reported to the admin, and connecting again fixes it', async (t) => {
    const { pool, app, alice, tenantId, connect, status, atlassian } = await setup(t, { codes: { c1: [SITE_A], c2: [SITE_A] } });
    await connect(alice, 'c1');
    atlassian.revokeAll();
    const res = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/projects`, cookies: { sid: alice } });
    assert.strictEqual(res.statusCode, 409);
    assert.match(res.json().error, /revoked or has expired; connect Jira again/);
    assert.match((await status()).lastError, /connect Jira again/);

    await connect(alice, 'c2');
    assert.strictEqual((await status()).lastError, null);
    assert.ok((await accessTokenFor(pool, { tenantId, atlassian: ATLASSIAN, fetch: atlassian.handler })).accessToken);

    // A key change makes stored tokens unreadable: reported the same way, not a crash.
    await assert.rejects(accessTokenFor(pool, { tenantId, atlassian: { ...ATLASSIAN, encryptionKey: crypto.randomBytes(32) }, fetch: atlassian.handler }),
        (err) => err instanceof JiraNotConnectedError && /TOKEN_ENCRYPTION_KEY/.test(err.message));
});

test('concurrent uses refresh one at a time, so rotation never leaves a stale token behind', async (t) => {
    const { pool, alice, tenantId, connect, atlassian } = await setup(t, { codes: { c1: [SITE_A] } });
    await connect(alice, 'c1');
    const results = await Promise.all(Array.from({ length: 5 }, () => accessTokenFor(pool, { tenantId, atlassian: ATLASSIAN, fetch: atlassian.handler })));
    assert.strictEqual(new Set(results.map((r) => r.accessToken)).size, 5);
    assert.ok(await accessTokenFor(pool, { tenantId, atlassian: ATLASSIAN, fetch: atlassian.handler }), 'the stored token still works');
});

test('who may do what: members see the status, only admins connect, choose, list projects or disconnect; outsiders get 404', async (t) => {
    const { app, alice, bob, tenantId, connect, status, rows, pool } = await setup(t, { codes: { c1: [SITE_A], 'c-bob': [SITE_B] } });
    const mallory = await signIn(app, 'mallory');
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/connect`, cookies: { sid: bob } })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/connect`, cookies: { sid: mallory } })).statusCode, 404);
    await connect(alice, 'c1');
    assert.strictEqual((await status(bob)).connected, true);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira`, cookies: { sid: mallory } })).statusCode, 404);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/projects`, cookies: { sid: bob } })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira` })).statusCode, 401);

    // The state cookie is client-controlled: a member can forge one naming the tenant and complete a callback with
    // their own Atlassian code. The callback checks the admin role itself, so that grant is never stored.
    const forged = await app.inject({
        method: 'GET', url: `/auth/atlassian/callback?code=c-bob&state=${'s'.repeat(22)}`,
        cookies: { sid: bob, jira_connect: `${'s'.repeat(22)}.${tenantId}` },
    });
    assert.strictEqual(forged.statusCode, 403);
    assert.strictEqual((await status()).site.cloudId, 'cloud-a', 'the admin\'s connection is untouched');
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/jira`, cookies: { sid: bob } })).statusCode, 403);
    assert.deepStrictEqual((await pool.query('SELECT * FROM jira_connections')).rows, [], 'unscoped reads see nothing');
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/jira`, cookies: { sid: alice } })).statusCode, 204);
    assert.deepStrictEqual(await rows('SELECT * FROM jira_connections'), []);
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/jira`, cookies: { sid: alice } })).statusCode, 404);
});

test('without the Atlassian variables the Jira routes do not exist', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub(USERS) });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira`, cookies: { sid: alice } })).statusCode, 404);
});
