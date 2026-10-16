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

const crypto = require('crypto');
const { loadGitHubAppConfig } = require('../lib/config');

test('loadGitHubAppConfig: absent entirely is fine (connection routes off)', () => {
    assert.strictEqual(loadGitHubAppConfig({}), null);
});

test('loadGitHubAppConfig: accepts a PEM with real or escaped newlines', () => {
    const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    for (const key of [pem, pem.replace(/\n/g, '\\n')]) {
        const config = loadGitHubAppConfig({ GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'shipscope-dev', GITHUB_APP_PRIVATE_KEY: key });
        assert.strictEqual(config.appId, '123');
        assert.strictEqual(config.slug, 'shipscope-dev');
        assert.strictEqual(config.privateKey.asymmetricKeyType, 'rsa');
    }
});

test('loadGitHubAppConfig: a partial or malformed set fails fast, naming each problem', () => {
    assert.throws(() => loadGitHubAppConfig({ GITHUB_APP_ID: '123' }), (err) => /GITHUB_APP_SLUG/.test(err.message) && /GITHUB_APP_PRIVATE_KEY/.test(err.message));
    assert.throws(() => loadGitHubAppConfig({ GITHUB_APP_ID: 'abc', GITHUB_APP_SLUG: 'Bad Slug', GITHUB_APP_PRIVATE_KEY: 'nope' }),
        (err) => /numeric/.test(err.message) && /URL name/.test(err.message) && /RSA private key/.test(err.message));
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => loadGitHubAppConfig({ GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'x', GITHUB_APP_PRIVATE_KEY: ec }), /RSA private key/);
});
