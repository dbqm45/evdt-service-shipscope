const { test } = require('node:test');
const assert = require('node:assert');
const { buildApp } = require('../web');
const { version } = require('../package.json');

const AUTH = {
    githubClientId: 'Iv1.test',
    githubClientSecret: 'test-secret',
    publicBaseUrl: 'http://localhost:3000',
    secureCookies: false,
};

test('GET /health returns ok without touching the pool', async (t) => {
    const query = t.mock.fn();
    const app = buildApp({ pool: { query } });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { status: 'ok', version });
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.strictEqual(query.mock.callCount(), 0);
});

test('GET /health/db returns 200 when the database is reachable', async (t) => {
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) } });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/health/db' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().ok, true);
});

test('GET /health/db returns 503 when the database is unreachable', async (t) => {
    const app = buildApp({ pool: { query: async () => { throw new Error('timeout'); } } });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/health/db' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().ok, false);
});

test('auth routes do not exist without an auth config', async (t) => {
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) } });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/auth/github/login' });
    assert.strictEqual(res.statusCode, 404);
});

test('GET /auth/github/login redirects to GitHub with a state that matches an httpOnly cookie', async (t) => {
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/auth/github/login' });
    assert.strictEqual(res.statusCode, 302);
    const location = new URL(res.headers.location);
    assert.strictEqual(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
    assert.strictEqual(location.searchParams.get('client_id'), 'Iv1.test');
    assert.strictEqual(location.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/github/callback');

    const stateCookie = res.cookies.find((c) => c.name === 'oauth_state');
    assert.ok(stateCookie, 'state cookie set');
    assert.strictEqual(stateCookie.value, location.searchParams.get('state'));
    assert.strictEqual(stateCookie.httpOnly, true);
    assert.strictEqual(stateCookie.sameSite, 'Lax');
});

test('GET /auth/github/login marks cookies Secure when the public URL is https', async (t) => {
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: { ...AUTH, publicBaseUrl: 'https://x.example', secureCookies: true } });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/auth/github/login' });
    assert.strictEqual(res.cookies.find((c) => c.name === 'oauth_state').secure, true);
});

test('GET /auth/github/callback rejects a state that does not match the cookie, without calling GitHub', async (t) => {
    const fetchMock = t.mock.fn();
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH, fetch: fetchMock });
    t.after(() => app.close());

    const missingCookie = await app.inject({ method: 'GET', url: '/auth/github/callback?code=c&state=s' });
    assert.strictEqual(missingCookie.statusCode, 400);

    const wrongState = await app.inject({
        method: 'GET',
        url: '/auth/github/callback?code=c&state=attacker',
        cookies: { oauth_state: 'victim' },
    });
    assert.strictEqual(wrongState.statusCode, 400);
    assert.strictEqual(fetchMock.mock.callCount(), 0);
});

test('GET /auth/github/callback returns 400 when GitHub sends the user back without a code', async (t) => {
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/auth/github/callback?error=access_denied&state=s' });
    assert.strictEqual(res.statusCode, 400);
});

test('GET /auth/github/callback returns 502 when GitHub rejects the code', async (t) => {
    const fetchMock = async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 });
    const query = t.mock.fn(async () => ({ rows: [] }));
    const app = buildApp({ pool: { query }, auth: AUTH, fetch: fetchMock });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/auth/github/callback?code=c&state=s', cookies: { oauth_state: 's' } });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(query.mock.callCount(), 0, 'no user or session is written');
    assert.ok(!res.cookies.some((c) => c.name === 'sid' && c.value), 'no session cookie');
});

test('protected routes return 401 without a session cookie', async (t) => {
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH });
    t.after(() => app.close());

    for (const [method, url] of [['GET', '/me'], ['POST', '/tenants'], ['GET', '/tenants/00000000-0000-0000-0000-000000000000/members']]) {
        const res = await app.inject({ method, url, payload: method === 'POST' ? { name: 'x' } : undefined });
        assert.strictEqual(res.statusCode, 401, `${method} ${url}`);
    }
});

test('unexpected errors return a generic 500 without leaking the message', async (t) => {
    const app = buildApp({ pool: { query: async () => { throw new Error('password authentication failed for user "x"'); } }, auth: AUTH });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/me', cookies: { sid: 'anything' } });
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.json(), { error: 'Internal Server Error' });
});

test('request logs never contain the OAuth callback query string', async (t) => {
    const lines = [];
    const stream = { write: (line) => lines.push(line) };
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH, logger: { stream } });
    t.after(() => app.close());

    await app.inject({ method: 'GET', url: '/auth/github/callback?code=SECRET_CODE&state=SECRET_STATE' });
    const log = lines.join('');
    assert.ok(log.includes('/auth/github/callback'), 'request was logged');
    assert.ok(!log.includes('SECRET_CODE') && !log.includes('SECRET_STATE'), 'query string was not logged');
});

test('GET /auth/github/login keeps an invitation return path, and rejects anything else', async (t) => {
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH });
    t.after(() => app.close());

    const path = `/invitations/${'a'.repeat(32)}`;
    const ok = await app.inject({ method: 'GET', url: `/auth/github/login?returnTo=${encodeURIComponent(path)}` });
    assert.strictEqual(ok.statusCode, 302);
    const cookie = ok.cookies.find((c) => c.name === 'oauth_return_to');
    assert.strictEqual(cookie.value, path);
    assert.strictEqual(cookie.httpOnly, true);

    // Open-redirect attempts and other paths: protocol-relative, absolute, traversal, a different route.
    for (const bad of ['//evil.example', 'https://evil.example', `/invitations/${'a'.repeat(32)}/../../me`, '/me', `${path}x`]) {
        const res = await app.inject({ method: 'GET', url: `/auth/github/login?returnTo=${encodeURIComponent(bad)}` });
        assert.strictEqual(res.statusCode, 400, bad);
    }
});

test('an invitation link opened without a session redirects to sign-in and back', async (t) => {
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH });
    t.after(() => app.close());

    const path = `/invitations/${'b'.repeat(32)}`;
    const res = await app.inject({ method: 'GET', url: path });
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.location, `/auth/github/login?returnTo=${encodeURIComponent(path)}`);

    const accept = await app.inject({ method: 'POST', url: `${path}/accept` });
    assert.strictEqual(accept.statusCode, 401, 'POST stays a plain 401');
});

test('request logs mask invitation tokens', async (t) => {
    const lines = [];
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH, logger: { stream: { write: (l) => lines.push(l) } } });
    t.after(() => app.close());

    const token = 'SECRETtokenSECRETtokenSECRETtokn';
    await app.inject({ method: 'GET', url: `/invitations/${token}` });
    await app.inject({ method: 'POST', url: `/invitations/${token}/accept` });
    const log = lines.join('');
    assert.ok(log.includes('/invitations/:token'), 'request was logged with a placeholder');
    assert.ok(!log.includes(token), 'token not logged');
});
