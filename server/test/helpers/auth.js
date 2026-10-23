const assert = require('node:assert');
const crypto = require('crypto');

// Retried GitHub GETs (5xx, network errors) wait 2/4/8 s in production; a fake GitHub answering 500 on purpose
// must not slow the suite down.
require('../../lib/github-app').RETRY.delaysMs = [0, 0, 0];

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
        // Repo endpoints for the deployment sync: github.repos[fullName] = { deployments (newest first),
        // statuses: { [id]: [...] (newest first) }, commits: { [sha]: message }, compare(base, head) -> body,
        // tags: [{ name, commit: { sha } }], releases: [{ tag_name }], files: { [sha]: { [path]: text } },
        // treeOf: { [commitSha]: treeSha } (default `tree-<sha>`), trees: { [treeSha]: listing },
        // runs: { [runId]: { event } }, fail: HTTP status to answer everything with }. Refs in commits/compare
        // may be tag names. github.users[login] = { name } answers GET /users/<login> (the sync's display names).
        m = url.match(/^https:\/\/api\.github\.com\/users\/([^/?]+)$/);
        if (m && github.users) {
            assert.match(auth, /^Bearer inst-token-\d+$/, 'installation token');
            const user = github.users[m[1]];
            return user ? json({ login: m[1], ...user }) : json({ message: 'Not Found' }, 404);
        }
        m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(.+)$/);
        if (m && github.repos?.[m[1]]) {
            assert.match(auth, /^Bearer inst-token-\d+$/, 'installation token');
            const repo = github.repos[m[1]];
            if (repo.fail) return json({ message: 'boom' }, repo.fail);
            const rest = m[2];
            const shaOf = (ref) => (/^[0-9a-f]{40}$/.test(ref) ? ref : (repo.tags || []).find((t) => t.name === ref)?.commit.sha);
            if (rest.startsWith('deployments?')) return json(pageOf(repo.deployments, url));
            if (rest.startsWith('tags?')) return json(pageOf(repo.tags || [], url));
            if (rest.startsWith('releases?')) return json(pageOf(repo.releases || [], url));
            let sub = rest.match(/^deployments\/(\d+)\/statuses/);
            if (sub) return json((repo.statuses[sub[1]] || []).slice(0, 10));
            sub = rest.match(/^commits\/([^/?]+)$/);
            if (sub) {
                const commitSha = shaOf(decodeURIComponent(sub[1]));
                if (!commitSha) return json({ message: 'No commit found' }, 422);
                const tree = repo.treeOf?.[commitSha] || `tree-${commitSha}`;
                return json({ sha: commitSha, commit: { message: repo.commits?.[commitSha] || '', tree: { sha: tree } } });
            }
            sub = rest.match(/^compare\/([^/?]+)$/);
            if (sub) {
                const [base, head] = sub[1].split('...').map(decodeURIComponent);
                if (!shaOf(base) || !shaOf(head)) return json({ message: 'Not Found' }, 404);
                return json(repo.compare(base, head));
            }
            sub = rest.match(/^contents\/([^?]+)\?ref=([0-9a-f]{40})$/);
            if (sub) {
                const text = repo.files?.[sub[2]]?.[decodeURIComponent(sub[1])];
                if (text === undefined) return json({ message: 'Not Found' }, 404);
                return json({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });
            }
            sub = rest.match(/^actions\/runs\/(\d+)$/);
            if (sub) {
                const run = repo.runs?.[sub[1]];
                return run ? json({ id: Number(sub[1]), ...run }) : json({ message: 'Resource not accessible by integration' }, 403);
            }
            sub = rest.match(/^git\/trees\/([^/?]+)\?recursive=1$/);
            if (sub) {
                const listing = repo.trees?.[sub[1]];
                return listing ? json(listing) : json({ message: 'Not Found' }, 404);
            }
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

/** Signs in and asserts the default landing on / (which forwards to a dashboard). Returns the session cookie value. */
async function signIn(app, code) {
    const { sid, location, callback } = await signInWithRedirect(app, code);
    assert.strictEqual(callback.statusCode, 302, callback.body);
    assert.strictEqual(location, '/');
    return sid;
}

module.exports = { AUTH, fakeGitHub, signIn, signInWithRedirect, testGitHubApp };
