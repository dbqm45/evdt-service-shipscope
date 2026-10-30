// `node scripts/local-pdi.js connect|test` (pdi L4, `sdlc up`): in local mode only, the connection with a pdi receiver on
// this machine without the browser, as the workspace's first admin. The variables pdi needs go to stdout as JSON.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { run } = require('../scripts/local-pdi');

const KEY = crypto.randomBytes(32);
const LOCAL = { PUBLIC_BASE_URL: 'http://localhost:3000', TOKEN_ENCRYPTION_KEY: KEY.toString('base64') };

function capture() {
    const out = [];
    const err = [];
    return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, json: () => JSON.parse(out.join('')), err };
}

test('refused outside local mode, without the key and for an unknown command; nothing touches the database', async () => {
    const pool = { query: () => { throw new Error('no database here'); } };
    for (const [argv, env, why] of [
        [['connect'], { ...LOCAL, PUBLIC_BASE_URL: 'https://shipscope.example.com' }, /local mode/],
        [['connect'], { ...LOCAL, NODE_ENV: 'production' }, /local mode/],
        [['connect'], { PUBLIC_BASE_URL: 'http://localhost:3000' }, /TOKEN_ENCRYPTION_KEY/],
        [['disconnect'], LOCAL, /connect.*test/],
        [['connect', '--receiver', 'http://10.0.0.5:8787'], LOCAL, /receiver/],
    ]) {
        const c = capture();
        assert.strictEqual(await run({ argv, env, pool, io: c.io }), 2, argv.join(' '));
        assert.match(c.err.join(''), why);
    }
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { fakeGitHub, AUTH, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { safeFetch } = require('../lib/safe-fetch');

test('no workspace yet: exit 3, so sdlc up waits for the sign-in in the browser', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const c = capture();
    assert.strictEqual(await run({ argv: ['connect'], env: LOCAL, pool, io: c.io }), 3);
    assert.match(c.err.join(''), /Sign in.*create a workspace/);
});

test('connect gives the three variables once; again is exit 4 unless --replace; test pings the receiver', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 850_600_001, login: 'alice' } }), encryptionKey: KEY });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Lokalnie' } })).json().tenant.id;

    const pings = [];
    const receiver = http.createServer((req, res) => { pings.push([req.method, req.url, req.headers['x-shipscope-event']]); res.end('{}'); });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    t.after(() => { receiver.closeAllConnections(); receiver.close(); });
    const receiverUrl = `http://127.0.0.1:${receiver.address().port}`;

    let c = capture();
    assert.strictEqual(await run({ argv: ['connect', '--receiver', receiverUrl], env: LOCAL, pool, io: c.io }), 0, c.err.join(''));
    const first = c.json();
    assert.deepStrictEqual([first.workspace, first.connection.state, first.connection.receiverUrl], [{ id: tenantId, name: 'Lokalnie' }, 'pending', receiverUrl]);
    assert.strictEqual(first.env.PDI_SHIPSCOPE_URL, 'http://localhost:3000');
    assert.match(first.env.PDI_SHIPSCOPE_TOKEN, /^shps_/);
    assert.match(first.env.PDI_SHIPSCOPE_SIGNING_SECRET, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!c.err.join('').includes(first.env.PDI_SHIPSCOPE_TOKEN), 'secrets only on stdout');

    c = capture();
    assert.strictEqual(await run({ argv: ['connect', '--receiver', receiverUrl], env: LOCAL, pool, io: c.io }), 4);
    assert.match(c.err.join(''), /already connected.*--replace/);

    c = capture();
    assert.strictEqual(await run({ argv: ['connect', '--receiver', receiverUrl, '--replace'], env: LOCAL, pool, io: c.io }), 0);
    const second = c.json();
    assert.notStrictEqual(second.env.PDI_SHIPSCOPE_TOKEN, first.env.PDI_SHIPSCOPE_TOKEN);
    const old = await app.inject({ method: 'GET', url: '/api/service/v1/connection', headers: { authorization: `Bearer ${first.env.PDI_SHIPSCOPE_TOKEN}` } });
    assert.strictEqual(old.statusCode, 401, 'the replaced token no longer works');

    // pdi reads ShipScope with its token, then `test` pings the receiver: connected.
    const read = await app.inject({ method: 'GET', url: '/api/service/v1/connection', headers: { authorization: `Bearer ${second.env.PDI_SHIPSCOPE_TOKEN}` } });
    assert.strictEqual(read.statusCode, 200);
    c = capture();
    assert.strictEqual(await run({ argv: ['test'], env: LOCAL, pool, io: c.io, fetchImpl: safeFetch }), 0, c.err.join(''));
    assert.strictEqual(c.json().connection.state, 'connected');
    assert.deepStrictEqual(pings.at(-1), ['GET', '/events/shipscope', 'ping']);
    const kinds = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/audit-events`, cookies: { sid: alice } })).json().events.map((e) => e.kind);
    assert.deepStrictEqual(kinds.filter((k) => k.startsWith('pdi_')).sort(), ['pdi_connected', 'pdi_connected', 'pdi_disconnected']);
});

test('track: the repo of a linked installation, and its flags read from code; again changes nothing', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { withScope } = require('../lib/scope');
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 850_600_002, login: 'alice' } }), encryptionKey: KEY });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Lokalnie' } })).json().tenant.id;
    const listed = [];
    const listRepos = async (installationId) => {
        listed.push(installationId);
        return [{ id: 901, fullName: 'alice/sdlc-proba', private: true }, { id: 902, fullName: 'alice/inne', private: false }];
    };
    const flags = JSON.stringify({ file: 'config/flags.{env}.json', path: 'flags' });
    const track = (argv) => {
        const c = capture();
        return run({ argv: ['track', ...argv], env: LOCAL, pool, io: c.io, listRepos }).then((code) => ({ code, c }));
    };

    let { code, c } = await track(['--repo', 'alice/sdlc-proba', '--flags', flags]);
    assert.strictEqual(code, 5, 'no installation linked yet');
    assert.match(c.err.join(''), /Install the ShipScope GitHub App.*alice/);

    const { rows: [user] } = await pool.query('SELECT id FROM users LIMIT 1');
    await withScope(pool, { tenantId }, (cl) => cl.query(
        "INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type, created_by) VALUES ($1, 77, 'alice', 'User', $2)", [tenantId, user.id]
    ));
    ({ code, c } = await track(['--repo', 'alice/nie-ma', '--flags', flags]));
    assert.strictEqual(code, 5, 'the installation cannot see that repo');
    assert.match(c.err.join(''), /alice\/nie-ma/);

    ({ code, c } = await track(['--repo', 'alice/sdlc-proba', '--flags', flags]));
    assert.strictEqual(code, 0, c.err.join(''));
    const first = c.json();
    assert.deepStrictEqual([first.workspace.id, first.repo, first.flagSource.created], [tenantId, { repoId: 901, fullName: 'alice/sdlc-proba', installationId: 77 }, true]);
    const sources = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice } })).json().sources;
    assert.strictEqual(sources.length, 1);
    assert.deepStrictEqual([sources[0].origin, sources[0].kind, sources[0].repoIds, sources[0].code.file], ['code', 'build', [901], 'config/flags.{env}.json']);
    const repos = await withScope(pool, { tenantId }, async (cl) => (await cl.query('SELECT full_name, installation_id FROM tracked_repos')).rows);
    assert.deepStrictEqual(repos, [{ full_name: 'alice/sdlc-proba', installation_id: '77' }]);

    ({ code, c } = await track(['--repo', 'alice/sdlc-proba', '--flags', flags]));
    assert.strictEqual(code, 0);
    assert.strictEqual(c.json().flagSource.created, false, 'the same source is kept');
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice } })).json().sources.length, 1);

    for (const argv of [['--repo', 'zła nazwa'], ['--repo', 'alice/sdlc-proba', '--flags', '{"file":"../x.json"}'], ['--repo', 'alice/sdlc-proba', '--flags', 'nie json']]) {
        ({ code, c } = await track(argv));
        assert.strictEqual(code, 2, argv.join(' '));
    }
});
