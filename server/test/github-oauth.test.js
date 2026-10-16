const { test } = require('node:test');
const assert = require('node:assert');
const { buildAuthorizeUrl, exchangeCode, fetchGitHubUser, GitHubOAuthError } = require('../lib/github-oauth');

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const EXCHANGE = { clientId: 'id', clientSecret: 'secret', code: 'abc', redirectUri: 'http://localhost:3000/auth/github/callback' };

test('buildAuthorizeUrl: includes client_id, redirect_uri and state, URL-encoded', () => {
    const url = new URL(buildAuthorizeUrl({ clientId: 'Iv1.x', redirectUri: 'http://h/cb?a=1', state: 's&t' }));
    assert.strictEqual(url.searchParams.get('client_id'), 'Iv1.x');
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://h/cb?a=1');
    assert.strictEqual(url.searchParams.get('state'), 's&t');
});

test('exchangeCode: posts the code and returns the access token', async (t) => {
    const fetchMock = t.mock.fn(async () => jsonResponse({ access_token: 'ghu_token', token_type: 'bearer' }));
    const token = await exchangeCode({ ...EXCHANGE, fetch: fetchMock });

    assert.strictEqual(token, 'ghu_token');
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.strictEqual(url, 'https://github.com/login/oauth/access_token');
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(init.headers.accept, 'application/json');
    assert.deepStrictEqual(JSON.parse(init.body), {
        client_id: 'id', client_secret: 'secret', code: 'abc', redirect_uri: EXCHANGE.redirectUri,
    });
});

test('exchangeCode: a 200 carrying an error field is a failure, not a token', async () => {
    const fetchMock = async () => jsonResponse({ error: 'bad_verification_code', error_description: 'expired' });
    await assert.rejects(() => exchangeCode({ ...EXCHANGE, fetch: fetchMock }), (err) => err instanceof GitHubOAuthError && /bad_verification_code/.test(err.message));
});

test('exchangeCode: non-2xx and missing token both reject with GitHubOAuthError', async () => {
    await assert.rejects(() => exchangeCode({ ...EXCHANGE, fetch: async () => jsonResponse({}, 500) }), GitHubOAuthError);
    await assert.rejects(() => exchangeCode({ ...EXCHANGE, fetch: async () => jsonResponse({ token_type: 'bearer' }) }), GitHubOAuthError);
});

test('fetchGitHubUser: returns the numeric id and login, sending the token as Bearer', async (t) => {
    const fetchMock = t.mock.fn(async () => jsonResponse({ id: 42, login: 'octocat', name: 'Mona' }));
    const user = await fetchGitHubUser({ accessToken: 'ghu_token', fetch: fetchMock });

    assert.deepStrictEqual(user, { githubUserId: 42, githubLogin: 'octocat' });
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.strictEqual(url, 'https://api.github.com/user');
    assert.strictEqual(init.headers.authorization, 'Bearer ghu_token');
});

test('fetchGitHubUser: rejects a response without a valid id/login', async () => {
    for (const body of [{ login: 'x' }, { id: '42', login: 'x' }, { id: 0, login: 'x' }, { id: 42 }, { id: 42, login: '' }, null]) {
        await assert.rejects(() => fetchGitHubUser({ accessToken: 't', fetch: async () => jsonResponse(body) }), GitHubOAuthError, JSON.stringify(body));
    }
    await assert.rejects(() => fetchGitHubUser({ accessToken: 't', fetch: async () => jsonResponse({}, 401) }), GitHubOAuthError);
});
