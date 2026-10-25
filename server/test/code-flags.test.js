// Flags in code (lib/code-flags.js, ADR-003 increment 3): a source ShipScope reads itself, from a file in one repo at
// the commit each environment last deployed. Against a real Postgres and a fake GitHub.
const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { fakeGitHub, AUTH, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { createFlagSource, createIngestToken, listFlagSources, updateFlagSource, FlagSourceConfigError } = require('../lib/flags');
const { refreshCodeFlags } = require('../lib/code-flags');
const { checkCodeConfig, codeFileFor } = require('../lib/flags-logic');

const sha = (n) => n.toString(16).padStart(40, 'a');
const at = (iso) => new Date(iso);

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const repo = { files: {} };
    const fake = fakeGitHub({ alice: { id: 890_000_001, login: 'alice' } }, { repos: { 'acme/web': repo } });
    const calls = [];
    const fetch = (url, init) => {
        calls.push(url);
        return fake(url, init);
    };
    const app = buildApp({ pool, auth: AUTH, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    await rows("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
    await rows("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/web'), ($1, 2, 9, 'acme/api')", [tenantId]);
    const [{ user_id: aliceId }] = await rows("SELECT user_id FROM memberships WHERE role = 'admin'");
    let nextId = 1;
    const deploy = (env, commit, when) => rows(
        "INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at) VALUES ($1, 1, $2, $3, 'success', $4, $5)",
        [tenantId, nextId++, env, commit, at(when)]
    );
    const read = (now = new Date()) => refreshCodeFlags({ pool, token: 'inst-token-1', tenantId, repo: { repoId: 1, fullName: 'acme/web' }, fetch, now });
    return { pool, app, alice, aliceId, tenantId, repo, calls, rows, deploy, read };
}

test('checkCodeConfig: one repo, a build source, a safe path with at most one {env}, a format, a selection for .env', () => {
    const ok = (code, source = { kind: 'build', repoIds: [1] }) => checkCodeConfig(code, source);
    assert.deepStrictEqual(ok({ file: 'config/flags.{env}.json', envNames: { prod: 'production' }, path: 'features' }), { file: 'config/flags.{env}.json', path: 'features', envNames: { prod: 'production' } });
    assert.deepStrictEqual(ok({ file: '.env', prefix: 'FF_' }), { file: '.env', prefix: 'FF_' });
    for (const [code, source, why] of [
        [{ file: 'f.json' }, { kind: 'runtime', repoIds: [1] }, /build source/],
        [{ file: 'f.json' }, { kind: 'build', repoIds: [1, 2] }, /exactly one/],
        [{ file: 'f.json' }, { kind: 'build', repoIds: [] }, /exactly one/],
        [{ file: '../secrets.json' }, undefined, /inside the repository/],
        [{ file: '/etc/passwd.json' }, undefined, /inside the repository/],
        [{ file: 'a/{env}/{env}.json' }, undefined, /at most one \{env\}/],
        [{ file: 'a/{name}.json' }, undefined, /at most one \{env\}/],
        [{ file: 'flags.toml' }, undefined, /format/],
        [{ file: 'config/.env.{env}' }, undefined, /prefix or their keys/],
        [{ file: 'f.json', envNames: { staging: 'stg' } }, undefined, /Environment names/],
        [{ file: 'f.json', envNames: { prod: 'a b' } }, undefined, /Environment names/],
    ]) assert.throws(() => ok(code, source), (err) => err instanceof FlagSourceConfigError && why.test(err.message), JSON.stringify(code));
    assert.strictEqual(codeFileFor({ file: 'cfg/{env}.json', envNames: { prod: 'production' } }, 'prod'), 'cfg/production.json');
    assert.strictEqual(codeFileFor({ file: 'cfg/{env}.json' }, 'qa'), 'cfg/qa.json');
});

test('flags in code: read at each environment\'s deployed commit; a missing file is an error, never a removal', async (t) => {
    const { pool, app, alice, aliceId, tenantId, repo, calls, rows, deploy, read } = await setup(t);
    const created = await createFlagSource(pool, {
        tenantId, actorUserId: aliceId, name: 'Web code', kind: 'build', repoIds: [1], origin: 'code',
        code: { file: 'config/flags.{env}.json', envNames: { prod: 'production' } },
    });
    assert.deepStrictEqual([created.token, created.source.origin, created.source.code.file], [null, 'code', 'config/flags.{env}.json'], 'no token: ShipScope reads it');
    await assert.rejects(() => createIngestToken(pool, { tenantId, actorUserId: aliceId, sourceId: created.source.id }), FlagSourceConfigError);

    repo.files[sha(1)] = { 'config/flags.production.json': '{"newCheckout": true, "beta": 30}' };
    await deploy('prod', sha(1), '2026-10-20T10:00:00Z');
    await deploy('qa', sha(2), '2026-10-21T10:00:00Z'); // no file at that commit
    assert.deepStrictEqual(await read(), { read: 1, failed: 1 });

    let values = await rows('SELECT key, environment, state, rollout::int, changed_at FROM flag_values ORDER BY key');
    assert.deepStrictEqual(values.map((v) => [v.key, v.environment, v.state, v.rollout]), [['beta', 'prod', 'partial', 30], ['newCheckout', 'prod', 'on', null]]);
    assert.strictEqual(values[0].changed_at.toISOString(), '2026-10-20T10:00:00.000Z', 'changedAt is the deployment\'s time');
    const envs = await rows('SELECT environment, last_ref, last_error FROM flag_source_envs ORDER BY environment');
    assert.deepStrictEqual(envs, [
        { environment: 'prod', last_ref: sha(1), last_error: null },
        { environment: 'qa', last_ref: null, last_error: `config/flags.qa.json is not in acme/web at ${sha(2).slice(0, 12)}` },
    ]);
    let source = (await listFlagSources(pool, { tenantId, actorUserId: aliceId }))[0];
    assert.deepStrictEqual(source.environments.map((e) => [e.env, e.state]), [['prod', 'fresh'], ['qa', 'error']]);

    // Nothing new on prod: not read again; qa is retried.
    calls.length = 0;
    assert.deepStrictEqual(await read(), { read: 0, failed: 1 });
    assert.ok(calls.every((url) => !url.includes('production')), 'prod is not fetched again');

    // The dashboard sees the web service's own value.
    const data = (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    assert.strictEqual(data.flagStatesByComponent.newCheckout.prod.web.state, 'on');
    assert.strictEqual(data.flagStatesByComponent.newCheckout.prod.web.changedBy, `deploy of ${sha(1).slice(0, 12)}`);
    assert.strictEqual(data.componentsOrder.find((c) => c.name === 'web').flagCoverage, 'tracked');

    // A new deployment drops a flag from the file: it is removed (the file is the full state of that environment).
    repo.files[sha(3)] = { 'config/flags.production.json': '{"newCheckout": false}' };
    await deploy('prod', sha(3), '2026-10-22T10:00:00Z');
    await read();
    values = await rows('SELECT key, state, removed_at IS NOT NULL AS removed FROM flag_values WHERE environment = $1 ORDER BY key', ['prod']);
    assert.deepStrictEqual(values, [{ key: 'beta', state: 'partial', removed: true }, { key: 'newCheckout', state: 'off', removed: false }]);

    // A file that is not flags any more: an error without its values, and the flags stay as they were.
    repo.files[sha(4)] = { 'config/flags.production.json': '{"newCheckout": true, "dbUrl": "postgres://app:hunter2@db/prod"}' };
    await deploy('prod', sha(4), '2026-10-23T10:00:00Z');
    await read();
    const [prod] = await rows("SELECT last_ref, last_error FROM flag_source_envs WHERE environment = 'prod'");
    assert.deepStrictEqual(prod, { last_ref: sha(3), last_error: 'config/flags.production.json: flag dbUrl is not on, off or a rollout percentage' });
    assert.strictEqual((await rows("SELECT state FROM flag_values WHERE key = 'newCheckout' AND environment = 'prod'"))[0].state, 'off', 'kept');
    source = (await listFlagSources(pool, { tenantId, actorUserId: aliceId }))[0];
    assert.strictEqual(source.environments.find((e) => e.env === 'prod').state, 'error');

    // Fixed in the next deployment: read, the error clears.
    repo.files[sha(5)] = { 'config/flags.production.json': '{"newCheckout": true}' };
    await deploy('prod', sha(5), '2026-10-24T10:00:00Z');
    await read();
    source = (await listFlagSources(pool, { tenantId, actorUserId: aliceId }))[0];
    assert.strictEqual(source.environments.find((e) => e.env === 'prod').state, 'fresh');

    // Changing where the file is reads every environment again.
    repo.files[sha(5)]['flags.json'] = '{"newCheckout": false}';
    await updateFlagSource(pool, { tenantId, actorUserId: aliceId, sourceId: created.source.id, name: 'Web code', kind: 'build', priority: 0, repoIds: [1], code: { file: 'flags.json' } });
    await read();
    assert.strictEqual((await rows("SELECT state FROM flag_values WHERE key = 'newCheckout' AND environment = 'prod'"))[0].state, 'off');
});

test('the API: a code source over one repo, no token, its config checked; a pushed source has no file', async (t) => {
    const { app, alice, tenantId } = await setup(t);
    const post = (payload) => app.inject({ method: 'POST', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice }, payload });
    const res = await post({ name: 'Code', kind: 'build', origin: 'code', repoIds: [1], code: { file: 'src/flags.ts', path: 'flags' } });
    assert.strictEqual(res.statusCode, 201, res.body);
    assert.deepStrictEqual([res.json().token, res.json().source.code], [null, { file: 'src/flags.ts', path: 'flags' }]);
    assert.strictEqual((await post({ name: 'X', kind: 'build', origin: 'code', repoIds: [1, 2], code: { file: 'f.json' } })).statusCode, 400);
    assert.strictEqual((await post({ name: 'X', kind: 'build', origin: 'code', repoIds: [1], code: { file: '.env' } })).json().error,
        'A .env or .properties file holds other settings too: name the flags\' prefix or their keys');
    assert.strictEqual((await post({ name: 'X', kind: 'build', repoIds: [1], code: { file: 'f.json' } })).statusCode, 400, 'a pushed source has no file');
    assert.strictEqual((await post({ name: 'X', kind: 'build', origin: 'code', repoIds: [1], code: { file: 'f.json', extra: 1 } })).statusCode, 400);
    const list = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice } })).json().sources;
    assert.deepStrictEqual(list.map((s) => [s.name, s.origin, s.tokens.length]), [['Code', 'code', 0]]);
});
