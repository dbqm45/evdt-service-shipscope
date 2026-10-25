// Setting up flags in code (lib/flag-discovery.js): proposing flags files from a repository's tree, and previewing a
// reading per environment before it is saved.
const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, testGitHubApp } = require('./helpers/auth');
const { withScope } = require('../lib/scope');
const { flagFileCandidates } = require('../lib/flag-discovery');

const sha = (n) => n.toString(16).padStart(40, 'a');
const ACME = 6101;
const USERS = { alice: { id: 891_000_001, login: 'alice' }, bob: { id: 891_000_002, login: 'bob' } };
const blob = (path) => ({ path, type: 'blob', sha: 'x' });

test('flagFileCandidates: names that say flags or toggles, readable formats, outside tests and builds; one {env} file per environment', () => {
    const paths = [
        'src/config/featureFlags.ts', 'flags.json', 'config/flags.production.json', 'config/flags.qa.json', 'config/flags.test.json',
        'deploy/toggles.staging.yaml', 'deploy/toggles.prod.yaml',
        'node_modules/x/flags.json', 'dist/flags.js', 'test/flags.json', 'src/flags.test.ts', 'src/flags.d.ts',
        '.env', 'config/flags.properties', 'src/flagship.json', 'README.md', 'package.json',
    ];
    assert.deepStrictEqual(flagFileCandidates(paths), [
        { file: 'flags.json', samplePath: 'flags.json' },
        { file: 'config/flags.{env}.json', envNames: { prod: 'production' }, samplePath: 'config/flags.production.json' },
        { file: 'deploy/toggles.{env}.yaml', envNames: { qa: 'staging' }, samplePath: 'deploy/toggles.prod.yaml' },
        { file: 'src/config/featureFlags.ts', samplePath: 'src/config/featureFlags.ts' },
    ], '.env and .properties are never proposed: they hold credentials too');
});

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { app: githubApp, publicKey } = testGitHubApp();
    const repo = {
        deployments: [], statuses: {}, commits: {}, compare: () => ({ status: 'ahead', commits: [] }),
        trees: {
            [sha(1)]: { truncated: false, tree: [blob('src/flags.ts'), blob('config/flags.prod.json'), blob('config/flags.qa.json'), blob('settings.yaml'), blob('ui/feature-flags.json')] },
        },
        files: {
            [sha(1)]: {
                'src/flags.ts': 'export const flags = { newCheckout: true, beta: 40 };',
                'config/flags.prod.json': '{"features": {"newCheckout": false}}',
                'ui/feature-flags.json': '{"dbUrl": "postgres://app:hunter2@db"}',
            },
            [sha(2)]: { 'config/flags.qa.json': '{"features": {"newCheckout": true}}' },
        },
    };
    const fake = fakeGitHub(USERS, { publicKey, installations: { [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: [] } }, repos: { 'acme/web': repo } });
    const app = buildApp({ pool, auth: AUTH, githubApp, fetch: fake });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, $2, 'acme', 'Organization')", [tenantId, ACME]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, $2, 'acme/web')", [tenantId, ACME]);
        await c.query(`INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at)
                       VALUES ($1, 1, 1, 'prod', 'success', $2, now() - interval '1 hour'), ($1, 1, 2, 'qa', 'success', $3, now())`, [tenantId, sha(1), sha(2)]);
    });
    const link = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice }, payload: { role: 'member' } })).json().url;
    const bob = await signIn(app, 'bob');
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    return { app, alice, bob, tenantId };
}

test('GET .../flag-files: proposes the flags files at the prod deployment, each with how it reads', async (t) => {
    const { app, alice, bob, tenantId } = await setup(t);
    const get = (sid, repoId = 1) => app.inject({ method: 'GET', url: `/tenants/${tenantId}/github/repos/${repoId}/flag-files`, cookies: { sid } });
    assert.strictEqual((await get(bob)).statusCode, 403, 'admins only: it reads the repository');
    assert.strictEqual((await get(alice, 99)).statusCode, 404);
    const res = await get(alice);
    assert.strictEqual(res.statusCode, 200, res.body);
    const { ref, candidates } = res.json();
    assert.strictEqual(ref, sha(1), 'what prod runs');
    assert.deepStrictEqual(candidates, [
        { file: 'config/flags.{env}.json', path: 'features', flags: { newCheckout: { state: 'off' } }, readFrom: 'config/flags.prod.json' },
        { file: 'src/flags.ts', flags: { newCheckout: { state: 'on' }, beta: { state: 'partial', rollout: 40 } }, readFrom: 'src/flags.ts' },
        { file: 'ui/feature-flags.json', error: 'ui/feature-flags.json: flag dbUrl is not on, off or a rollout percentage', readFrom: 'ui/feature-flags.json' },
    ], 'a file that is not flags says why, without its values');
});

test('POST .../flag-preview: each environment at its own deployment, before anything is saved', async (t) => {
    const { app, alice, tenantId } = await setup(t);
    const post = (code) => app.inject({ method: 'POST', url: `/tenants/${tenantId}/github/repos/1/flag-preview`, cookies: { sid: alice }, payload: { code } });
    const res = await post({ file: 'config/flags.{env}.json', path: 'features' });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.deepStrictEqual(res.json().envs, [
        { env: 'qa', ref: sha(2), file: 'config/flags.qa.json', flags: { newCheckout: { state: 'on' } } },
        { env: 'prod', ref: sha(1), file: 'config/flags.prod.json', flags: { newCheckout: { state: 'off' } } },
    ]);
    const missing = (await post({ file: 'src/flags.ts' })).json().envs;
    assert.deepStrictEqual(missing.map((e) => [e.env, e.error || null]), [['qa', `src/flags.ts is not in acme/web at ${sha(2).slice(0, 12)}`], ['prod', null]]);
    assert.strictEqual((await post({ file: '.env' })).statusCode, 400, 'the same rules as saving');
    assert.strictEqual((await post({ file: 'x.json', nope: 1 })).statusCode, 400);
});
