// The pure parts of scripts/dev.js (`npm run dev`); the Docker/GitHub/process side is checked by running it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseEnvFile, setEnvValues, devDatabasePort, buildManifest, envFromConversion } = require('../scripts/dev');

test('parseEnvFile: KEY=value lines, comments skipped, quotes stripped, escapes kept as written', () => {
    const env = parseEnvFile([
        '# a comment',
        'DATABASE_URL=postgres://a:b@localhost:54329/shipscope',
        '  PORT = 3001 ',
        'QUOTED="x y"',
        "SINGLE='z'",
        'KEY=-----BEGIN\\nabc\\n-----END',
        '# PUBLIC_BASE_URL=http://commented',
        'not a line',
        'EMPTY=',
    ].join('\n'));
    assert.deepEqual(env, {
        DATABASE_URL: 'postgres://a:b@localhost:54329/shipscope', PORT: '3001', QUOTED: 'x y', SINGLE: 'z',
        KEY: '-----BEGIN\\nabc\\n-----END', EMPTY: '',
    });
});

test('setEnvValues: replaces a line, uncomments a commented one, appends a new key, rejects raw newlines', () => {
    const text = 'A=1\n# PORT=3000\nB=2\n';
    assert.equal(setEnvValues(text, { A: 'x', PORT: '3001', C: '$&3' }), 'A=x\nPORT=3001\nB=2\nC=$&3\n');
    assert.equal(setEnvValues('A=1', { B: '2' }), 'A=1\nB=2\n');
    assert.equal(setEnvValues('', { B: '2' }), 'B=2\n');
    assert.throws(() => setEnvValues('', { K: 'a\nb' }), /escape newlines/);
});

test('devDatabasePort: only the Docker database this script manages, at whatever port it was given', () => {
    assert.equal(devDatabasePort('postgres://shipscope_app:shipscope_app@localhost:54329/shipscope'), 54329);
    assert.equal(devDatabasePort('postgres://shipscope_app:x@127.0.0.1:6000/shipscope'), 6000);
    assert.equal(devDatabasePort('postgres://postgres:postgres@localhost:5432/postgres'), null, 'another database: used as it is');
    assert.equal(devDatabasePort('postgres://shipscope_app:x@db.example.com:5432/shipscope'), null, 'not local');
    assert.equal(devDatabasePort(undefined), null);
    assert.equal(devDatabasePort('not a url'), null);
});

test('buildManifest: callback, setup and redirect on this server, read-only permissions, inactive webhook', () => {
    const m = buildManifest({ baseUrl: 'http://localhost:3000', suffix: 'abc123' });
    assert.equal(m.name, 'ShipScope dev abc123');
    assert.ok(m.name.length <= 34, 'GitHub limits App names to 34 characters');
    assert.deepEqual(m.callback_urls, ['http://localhost:3000/auth/github/callback']);
    assert.equal(m.setup_url, 'http://localhost:3000/github/setup');
    assert.equal(m.redirect_url, 'http://localhost:3000/__dev/github-app');
    assert.equal(m.request_oauth_on_install, false);
    assert.deepEqual(m.hook_attributes, { url: 'http://localhost:3000/webhooks/github', active: false });
    assert.ok(Object.values(m.default_permissions).every((p) => p === 'read'));
    assert.deepEqual(Object.keys(m.default_permissions).sort(), ['actions', 'contents', 'deployments', 'metadata']);
});

test('envFromConversion: the five GITHUB_APP_* values, the key on one line, a missing field is an error', () => {
    const env = envFromConversion({ id: 42, slug: 'shipscope-dev-abc', client_id: 'Iv1.x', client_secret: 's', pem: '-----BEGIN\nabc\n-----END\n' });
    assert.deepEqual(env, {
        GITHUB_APP_CLIENT_ID: 'Iv1.x', GITHUB_APP_CLIENT_SECRET: 's', GITHUB_APP_ID: '42', GITHUB_APP_SLUG: 'shipscope-dev-abc',
        GITHUB_APP_PRIVATE_KEY: '-----BEGIN\\nabc\\n-----END',
    });
    assert.throws(() => envFromConversion({ id: 1, slug: 's', client_id: 'c', pem: 'p' }), /client_secret/);
});
