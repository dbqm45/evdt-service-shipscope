const { test } = require('node:test');
const assert = require('node:assert');
const { loadAuthConfig } = require('../lib/config');

const VALID = { GITHUB_APP_CLIENT_ID: 'Iv1.x', GITHUB_APP_CLIENT_SECRET: 's', PUBLIC_BASE_URL: 'http://localhost:3000' };

test('loadAuthConfig: accepts a complete local config with non-secure cookies', () => {
    assert.deepStrictEqual(loadAuthConfig(VALID), {
        githubClientId: 'Iv1.x',
        githubClientSecret: 's',
        publicBaseUrl: 'http://localhost:3000',
        secureCookies: false,
    });
});

test('loadAuthConfig: https base URL turns on secure cookies and is normalized to its origin', () => {
    const config = loadAuthConfig({ ...VALID, PUBLIC_BASE_URL: 'https://shipscope.example/' });
    assert.strictEqual(config.publicBaseUrl, 'https://shipscope.example');
    assert.strictEqual(config.secureCookies, true);
});

test('loadAuthConfig: names every missing variable at once', () => {
    assert.throws(() => loadAuthConfig({}), (err) =>
        /GITHUB_APP_CLIENT_ID/.test(err.message) && /GITHUB_APP_CLIENT_SECRET/.test(err.message) && /PUBLIC_BASE_URL/.test(err.message));
});

test('loadAuthConfig: rejects a non-http(s) or relative base URL', () => {
    assert.throws(() => loadAuthConfig({ ...VALID, PUBLIC_BASE_URL: 'localhost:3000' }), /PUBLIC_BASE_URL/);
    assert.throws(() => loadAuthConfig({ ...VALID, PUBLIC_BASE_URL: 'ftp://x' }), /PUBLIC_BASE_URL/);
});
