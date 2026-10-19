const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createAppJwt, getInstallation, userCanAccessInstallation, listInstallationRepos, GitHubApiError } = require('../lib/github-app');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const app = { appId: '4242', privateKey };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('createAppJwt: RS256, verifiable with the public key, issuer and a 10-minute-max window', () => {
    const now = Date.UTC(2026, 9, 16, 12, 0, 0);
    const jwt = createAppJwt({ ...app, now });
    const [header, payload, signature] = jwt.split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
    assert.deepStrictEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.deepStrictEqual(claims, { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '4242' });
});

test('userCanAccessInstallation: pages through /user/installations with the user token', async (t) => {
    const pages = [Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), [{ id: 777 }]];
    const fetchMock = t.mock.fn(async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        return json({ installations: pages[page - 1] });
    });
    assert.strictEqual(await userCanAccessInstallation({ accessToken: 'ghu', installationId: 777, fetch: fetchMock }), true);
    assert.strictEqual(fetchMock.mock.callCount(), 2);
    assert.strictEqual(fetchMock.mock.calls[0].arguments[1].headers.authorization, 'Bearer ghu');
    assert.strictEqual(await userCanAccessInstallation({ accessToken: 'ghu', installationId: 778, fetch: fetchMock }), false);
});

test('userCanAccessInstallation: a GitHub error is a GitHubApiError, not "no access"', async () => {
    await assert.rejects(
        () => userCanAccessInstallation({ accessToken: 'x', installationId: 1, fetch: async () => json({}, 401) }),
        (err) => err instanceof GitHubApiError && err.status === 401
    );
    await assert.rejects(() => userCanAccessInstallation({ accessToken: 'x', installationId: 1, fetch: async () => json({}) }), GitHubApiError);
});

test('getInstallation: reads the account as the App and validates the response', async (t) => {
    const fetchMock = t.mock.fn(async () => json({ id: 5, account: { login: 'acme', type: 'Organization' } }));
    assert.deepStrictEqual(await getInstallation({ app, installationId: 5, fetch: fetchMock }), { installationId: 5, accountLogin: 'acme', accountType: 'Organization' });
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.strictEqual(url, 'https://api.github.com/app/installations/5');
    assert.strictEqual(init.headers.authorization.split('.').length, 3, 'JWT bearer');

    await assert.rejects(() => getInstallation({ app, installationId: 5, fetch: async () => json({ id: 6, account: { login: 'x', type: 'User' } }) }), GitHubApiError);
    await assert.rejects(() => getInstallation({ app, installationId: 5, fetch: async () => json({}, 404) }), GitHubApiError);
});

test('listInstallationRepos: mints an installation token, then pages repos with it', async (t) => {
    const fetchMock = t.mock.fn(async (url, init) => {
        if (url.endsWith('/access_tokens')) {
            assert.strictEqual(init.method, 'POST');
            return json({ token: 'ghs_inst' }, 201);
        }
        assert.strictEqual(init.headers.authorization, 'Bearer ghs_inst');
        return json({ repositories: [{ id: 1, full_name: 'acme/a', private: true }, { id: 2, full_name: 'acme/b' }] });
    });
    assert.deepStrictEqual(await listInstallationRepos({ app, installationId: 5, fetch: fetchMock }), [
        { id: 1, fullName: 'acme/a', private: true },
        { id: 2, fullName: 'acme/b', private: false },
    ]);

    const bad = async (url) => (url.endsWith('/access_tokens') ? json({ token: 't' }) : json({ repositories: [{ id: 'x' }] }));
    await assert.rejects(() => listInstallationRepos({ app, installationId: 5, fetch: bad }), GitHubApiError);
    await assert.rejects(() => listInstallationRepos({ app, installationId: 5, fetch: async () => json({}) }), GitHubApiError);
});

test('createInstallationToken: asks for read-only permissions; on a 422 asks for the ones the installation has', async () => {
    const { createInstallationToken, TOKEN_PERMISSIONS } = require('../lib/github-app');
    assert.deepStrictEqual(TOKEN_PERMISSIONS, { actions: 'read', contents: 'read', deployments: 'read', metadata: 'read' });

    const asked = [];
    const full = async (url, init) => {
        asked.push(JSON.parse(init.body).permissions);
        assert.strictEqual(init.headers['content-type'], 'application/json');
        return json({ token: 'ghs_read' }, 201);
    };
    assert.strictEqual(await createInstallationToken({ app, installationId: 5, fetch: full }), 'ghs_read');
    assert.deepStrictEqual(asked, [TOKEN_PERMISSIONS]);

    // An installation without Actions (granted before ShipScope asked for it): GitHub refuses the full set.
    const calls = [];
    const noActions = async (url, init) => {
        calls.push(`${init.method} ${url.replace('https://api.github.com', '')}`);
        if (url.endsWith('/access_tokens')) {
            const { permissions } = JSON.parse(init.body);
            return permissions.actions ? json({ message: 'The permissions requested are not granted to this installation.' }, 422) : json({ token: 'ghs_less', permissions }, 201);
        }
        return json({ id: 5, account: { login: 'acme', type: 'Organization' }, permissions: { contents: 'write', deployments: 'read', metadata: 'read', issues: 'write' } });
    };
    assert.strictEqual(await createInstallationToken({ app, installationId: 5, fetch: noActions }), 'ghs_less');
    assert.deepStrictEqual(calls, ['POST /app/installations/5/access_tokens', 'GET /app/installations/5', 'POST /app/installations/5/access_tokens']);

    // Other errors are not retried.
    await assert.rejects(() => createInstallationToken({ app, installationId: 5, fetch: async () => json({}, 404) }), (err) => err.status === 404);
});
