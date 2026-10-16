const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const AUTH = {
    githubClientId: 'Iv1.test',
    githubClientSecret: 'test-secret',
    publicBaseUrl: 'http://localhost:3000',
    secureCookies: false,
};

/** Fake GitHub: every code maps to the user registered for it. Asserts the app sends the real client secret. */
function fakeGitHub(usersByCode) {
    return async (url, init = {}) => {
        if (url === 'https://github.com/login/oauth/access_token') {
            const { code, client_secret: secret } = JSON.parse(init.body);
            assert.strictEqual(secret, 'test-secret');
            if (!usersByCode[code]) return new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 });
            return new Response(JSON.stringify({ access_token: `token-for-${code}` }), { status: 200 });
        }
        if (url === 'https://api.github.com/user') {
            const code = init.headers.authorization.replace('Bearer token-for-', '');
            return new Response(JSON.stringify(usersByCode[code]), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
    };
}

/** Runs login → callback for one fake GitHub user and returns their session cookie value. */
async function signIn(app, code) {
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const state = login.cookies.find((c) => c.name === 'oauth_state').value;
    const callback = await app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=${code}&state=${state}`,
        cookies: { oauth_state: state },
    });
    assert.strictEqual(callback.statusCode, 302, callback.body);
    assert.strictEqual(callback.headers.location, '/me');
    const sid = callback.cookies.find((c) => c.name === 'sid');
    assert.ok(sid && sid.value, 'session cookie set');
    assert.strictEqual(sid.httpOnly, true);
    return sid.value;
}

test('sign in, create a tenant, list it and its members, then sign out', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 810_000_001, login: 'alice' } }) });
    t.after(() => app.close());

    const sid = await signIn(app, 'alice');

    const me = await app.inject({ method: 'GET', url: '/me', cookies: { sid } });
    assert.strictEqual(me.statusCode, 200);
    assert.strictEqual(me.json().user.githubLogin, 'alice');
    assert.deepStrictEqual(me.json().tenants, []);

    const created = await app.inject({ method: 'POST', url: '/tenants', cookies: { sid }, payload: { name: '  Acme  ' } });
    assert.strictEqual(created.statusCode, 201);
    const tenantId = created.json().tenant.id;
    assert.strictEqual(created.json().tenant.name, 'Acme');

    const meAfter = await app.inject({ method: 'GET', url: '/me', cookies: { sid } });
    assert.deepStrictEqual(meAfter.json().tenants, [{ id: tenantId, name: 'Acme', role: 'admin' }]);

    const members = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid } });
    assert.strictEqual(members.statusCode, 200);
    assert.deepStrictEqual(members.json().members.map((m) => [m.githubLogin, m.role]), [['alice', 'admin']]);

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { sid } });
    assert.strictEqual(logout.statusCode, 204);
    const afterLogout = await app.inject({ method: 'GET', url: '/me', cookies: { sid } });
    assert.strictEqual(afterLogout.statusCode, 401);
});

test('the database stores only a hash of the session token, and no GitHub token at all', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ bob: { id: 810_000_002, login: 'bob' } }) });
    t.after(() => app.close());

    const sid = await signIn(app, 'bob');

    const { rows } = await pool.query('SELECT * FROM sessions');
    assert.strictEqual(rows.length, 1);
    const dump = JSON.stringify(rows) + JSON.stringify((await pool.query('SELECT * FROM users')).rows);
    assert.ok(!dump.includes(sid), 'raw session token not stored');
    assert.ok(!dump.includes('token-for-bob'), 'GitHub access token not stored');
});

test('a user cannot see another tenant: 404, same as a tenant that does not exist', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({
        pool,
        auth: AUTH,
        fetch: fakeGitHub({ carol: { id: 810_000_003, login: 'carol' }, dave: { id: 810_000_004, login: 'dave' } }),
    });
    t.after(() => app.close());

    const carol = await signIn(app, 'carol');
    const dave = await signIn(app, 'dave');

    const carolTenant = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: carol }, payload: { name: 'Carol Co' } })).json().tenant.id;
    await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: dave }, payload: { name: 'Dave Co' } });

    const foreign = await app.inject({ method: 'GET', url: `/tenants/${carolTenant}/members`, cookies: { sid: dave } });
    assert.strictEqual(foreign.statusCode, 404);
    const missing = await app.inject({ method: 'GET', url: '/tenants/00000000-0000-0000-0000-000000000000/members', cookies: { sid: dave } });
    assert.strictEqual(missing.statusCode, 404);
    assert.deepStrictEqual(foreign.json(), missing.json());

    const daveTenants = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: dave } })).json().tenants;
    assert.deepStrictEqual(daveTenants.map((x) => x.name), ['Dave Co']);
});

test('signing in again keeps one user row and refreshes a renamed login', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const users = { first: { id: 810_000_005, login: 'old-name' }, second: { id: 810_000_005, login: 'new-name' } };
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub(users) });
    t.after(() => app.close());

    await signIn(app, 'first');
    const sid = await signIn(app, 'second');

    const { rows } = await pool.query('SELECT github_login FROM users');
    assert.deepStrictEqual(rows, [{ github_login: 'new-name' }]);
    assert.strictEqual((await app.inject({ method: 'GET', url: '/me', cookies: { sid } })).json().user.githubLogin, 'new-name');
});

test('an expired session is rejected', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ erin: { id: 810_000_006, login: 'erin' } }) });
    t.after(() => app.close());

    const sid = await signIn(app, 'erin');
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");

    const res = await app.inject({ method: 'GET', url: '/me', cookies: { sid } });
    assert.strictEqual(res.statusCode, 401);
});

test('POST /tenants validates its body', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ fay: { id: 810_000_007, login: 'fay' } }) });
    t.after(() => app.close());

    const sid = await signIn(app, 'fay');
    for (const payload of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 'ok', role: 'admin' }, { name: 42 }]) {
        const res = await app.inject({ method: 'POST', url: '/tenants', cookies: { sid }, payload });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(payload));
    }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM tenants');
    assert.strictEqual(rows[0].n, 0);
});
