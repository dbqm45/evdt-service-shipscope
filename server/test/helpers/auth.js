const assert = require('node:assert');
const crypto = require('crypto');

const AUTH = {
    githubClientId: 'Iv1.test',
    githubClientSecret: 'test-secret',
    publicBaseUrl: 'http://localhost:3000',
    secureCookies: false,
};

/** A GitHub App config with a fresh key pair; the fake GitHub below verifies JWTs with `publicKey`. */
function testGitHubApp() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { app: { appId: '4242', slug: 'shipscope-test', privateKey }, publicKey };
}

/** Verifies an App JWT the way GitHub would: RS256 signature, issuer, and a live exp/iat window. */
function verifyAppJwt(authorization, publicKey) {
    const [header, payload, signature] = authorization.replace('Bearer ', '').split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), 'JWT signature');
    assert.deepStrictEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    const now = Math.floor(Date.now() / 1000);
    assert.strictEqual(claims.iss, '4242');
    assert.ok(claims.iat <= now && claims.exp > now && claims.exp - claims.iat <= 600, 'JWT time window');
}

/**
 * Fake GitHub. `usersByCode` maps an OAuth code to a user. Optional `github` adds the App side:
 * installations (id -> { account, repos: [{ id, full_name, private }] }), userInstallations
 * (login -> installation ids the user can access), and the App's publicKey for JWT checks.
 */
function fakeGitHub(usersByCode, github = {}) {
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    const pageOf = (list, url) => {
        const params = new URL(url).searchParams;
        const perPage = Number(params.get('per_page') || 30);
        const page = Number(params.get('page') || 1);
        return list.slice((page - 1) * perPage, page * perPage);
    };
    return async (url, init = {}) => {
        if (url === 'https://github.com/login/oauth/access_token') {
            const { code, client_secret: secret } = JSON.parse(init.body);
            assert.strictEqual(secret, 'test-secret');
            if (!usersByCode[code]) return json({ error: 'bad_verification_code' });
            return json({ access_token: `token-for-${code}` });
        }
        const auth = init.headers?.authorization || '';
        if (url === 'https://api.github.com/user') {
            return json(usersByCode[auth.replace('Bearer token-for-', '')]);
        }
        if (url.startsWith('https://api.github.com/user/installations')) {
            const user = usersByCode[auth.replace('Bearer token-for-', '')];
            if (!user) return json({ message: 'Bad credentials' }, 401);
            const ids = (github.userInstallations || {})[user.login] || [];
            return json({ total_count: ids.length, installations: pageOf(ids.map((id) => ({ id })), url) });
        }
        let m = url.match(/^https:\/\/api\.github\.com\/app\/installations\/(\d+)(\/access_tokens)?$/);
        if (m) {
            verifyAppJwt(auth, github.publicKey);
            const installation = github.installations?.[m[1]];
            if (!installation) return json({ message: 'Not Found' }, 404);
            if (m[2]) {
                assert.strictEqual(init.method, 'POST');
                return json({ token: `inst-token-${m[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
            }
            return json({ id: Number(m[1]), account: installation.account });
        }
        if (url.startsWith('https://api.github.com/installation/repositories')) {
            m = auth.match(/^Bearer inst-token-(\d+)$/);
            assert.ok(m, 'installation token');
            const repos = github.installations[m[1]].repos;
            return json({ total_count: repos.length, repositories: pageOf(repos, url) });
        }
        throw new Error(`unexpected fetch ${url}`);
    };
}

/**
 * Runs login → callback for one fake GitHub user. Returns the session cookie value and where the callback
 * redirected to. `loginUrl` lets a test start from e.g. /auth/github/login?returnTo=...; `extraCookies`
 * are sent to the callback too (e.g. the gh_link cookie set by /github/setup).
 *
 * @returns {Promise<{ sid: string, location: string, callback: object }>}
 */
async function signInWithRedirect(app, code, loginUrl = '/auth/github/login', extraCookies = {}) {
    const login = await app.inject({ method: 'GET', url: loginUrl });
    assert.strictEqual(login.statusCode, 302, login.body);
    const cookies = { ...extraCookies, ...Object.fromEntries(login.cookies.filter((c) => c.value).map((c) => [c.name, c.value])) };
    const callback = await app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=${code}&state=${cookies.oauth_state}`,
        cookies,
    });
    const sid = callback.cookies.find((c) => c.name === 'sid');
    assert.ok(sid && sid.value, `session cookie set (callback ${callback.statusCode}: ${callback.body})`);
    assert.strictEqual(sid.httpOnly, true);
    return { sid: sid.value, location: callback.headers.location, callback };
}

/** Signs in and asserts the default landing on /me. Returns the session cookie value. */
async function signIn(app, code) {
    const { sid, location, callback } = await signInWithRedirect(app, code);
    assert.strictEqual(callback.statusCode, 302, callback.body);
    assert.strictEqual(location, '/me');
    return sid;
}

module.exports = { AUTH, fakeGitHub, signIn, signInWithRedirect, testGitHubApp };
