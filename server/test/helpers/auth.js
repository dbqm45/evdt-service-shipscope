const assert = require('node:assert');

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

/**
 * Runs login → callback for one fake GitHub user. Returns the session cookie value and where the callback
 * redirected to. `loginUrl` lets a test start from e.g. /auth/github/login?returnTo=...
 *
 * @returns {Promise<{ sid: string, location: string }>}
 */
async function signInWithRedirect(app, code, loginUrl = '/auth/github/login') {
    const login = await app.inject({ method: 'GET', url: loginUrl });
    assert.strictEqual(login.statusCode, 302, login.body);
    const cookies = Object.fromEntries(login.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
    const callback = await app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=${code}&state=${cookies.oauth_state}`,
        cookies,
    });
    assert.strictEqual(callback.statusCode, 302, callback.body);
    const sid = callback.cookies.find((c) => c.name === 'sid');
    assert.ok(sid && sid.value, 'session cookie set');
    assert.strictEqual(sid.httpOnly, true);
    return { sid: sid.value, location: callback.headers.location };
}

/** Signs in and asserts the default landing on /me. Returns the session cookie value. */
async function signIn(app, code) {
    const { sid, location } = await signInWithRedirect(app, code);
    assert.strictEqual(location, '/me');
    return sid;
}

module.exports = { AUTH, fakeGitHub, signIn, signInWithRedirect };
