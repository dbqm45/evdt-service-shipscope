const { test } = require('node:test');
const assert = require('node:assert');
const { fakeGitHub, AUTH, signIn, testGitHubApp } = require('./helpers/auth');
const { createCaches, resolveManual, resolveDisplayName } = require('../lib/deployment-people');

const TOKEN = 'inst-token-1';
const RUN = (id) => `https://github.com/acme/web/actions/runs/${id}`;

function counted(github) {
    const fake = fakeGitHub({}, github);
    const calls = [];
    return { calls, fetch: (url, init) => { calls.push(url.replace('https://api.github.com', '')); return fake(url, init); } };
}

test('resolveManual: workflow_dispatch -> true, other events -> false, unknown -> null; cached and budgeted', async () => {
    const { calls, fetch } = counted({ repos: { 'acme/web': { runs: { 1: { event: 'workflow_dispatch' }, 2: { event: 'push' } } } } });
    const caches = createCaches();
    const budget = { runs: 3 };
    const manual = (url) => resolveManual({ token: TOKEN, fullName: 'acme/web', workflowRunUrl: url, caches, budget, fetch });

    assert.strictEqual(await manual(RUN(1)), true);
    assert.strictEqual(await manual(RUN(1)), true, 'cached');
    assert.strictEqual(await manual(RUN(2)), false);
    assert.strictEqual(await manual(RUN(3)), null, 'no Actions read access (403)');
    assert.strictEqual(await manual(null), null, 'no run link');
    assert.strictEqual(await manual('https://example.com/build/9'), null, 'not an Actions run');
    assert.deepStrictEqual(calls, ['/repos/acme/web/actions/runs/1', '/repos/acme/web/actions/runs/2', '/repos/acme/web/actions/runs/3']);
    assert.strictEqual(budget.runs, 0);
    assert.strictEqual(await manual(RUN(4)), null, 'over budget: not looked up');
    assert.strictEqual(calls.length, 3);
});

test('resolveDisplayName: the public name, else null; odd logins are never looked up', async () => {
    const { calls, fetch } = counted({ users: { carol: { name: '  Carol Nowak ' }, dave: { name: null }, erin: { name: '' } } });
    const caches = createCaches();
    const name = (login) => resolveDisplayName({ token: TOKEN, login, caches, fetch });

    assert.strictEqual(await name('carol'), 'Carol Nowak');
    assert.strictEqual(await name('carol'), 'Carol Nowak', 'cached');
    assert.strictEqual(await name('dave'), null, 'no public name');
    assert.strictEqual(await name('erin'), null, 'blank name');
    assert.strictEqual(await name('ghost'), null, 'unknown user (404)');
    for (const odd of ['dependabot[bot]', '../orgs/x', 'a/b', '', null, 'x'.repeat(40)]) assert.strictEqual(await name(odd), null, String(odd));
    assert.deepStrictEqual(calls, ['/users/carol', '/users/dave', '/users/erin', '/users/ghost']);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { syncAll } = require('../lib/deployment-sync');

const USERS = { alice: { id: 860_000_001, login: 'alice' } };
const ACME = 8001;
const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const sha = (n) => n.toString(16).padStart(40, 'a');

test('sync: manual flag and display names are stored and shown; a failed lookup never fails the sync', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const web = {
        deployments: [
            { id: 3, environment: 'prod', sha: sha(1), created_at: at(10), creator: { login: 'dependabot[bot]' } },
            { id: 2, environment: 'qa', sha: sha(1), created_at: at(20), creator: { login: 'dave' } },
            { id: 1, environment: 'test', sha: sha(1), created_at: at(30), creator: { login: 'carol' } },
        ],
        statuses: {
            1: [{ state: 'success', created_at: at(29), log_url: RUN(100) }],
            2: [{ state: 'success', created_at: at(19), log_url: RUN(100) }], // same run as 1: one lookup
            3: [{ state: 'success', created_at: at(9), log_url: RUN(300) }],  // no Actions access: unknown
        },
        runs: { 100: { event: 'workflow_dispatch' } },
        compare: () => ({ status: 'identical', commits: [] }),
    };
    const { app: githubApp, publicKey } = testGitHubApp();
    const fake = fakeGitHub(USERS, {
        publicKey,
        installations: { [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: [] } },
        repos: { 'acme/web': web },
        users: { carol: { name: 'Carol Nowak' }, dave: { name: null } },
    });
    const calls = [];
    const fetch = (url, init) => { calls.push(url.replace('https://api.github.com', '')); return fake(url, init); };
    const app = buildApp({ pool, auth: AUTH, githubApp, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, $2, 'acme', 'Organization')", [tenantId, ACME]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, $2, 'acme/web')", [tenantId, ACME]);
    });

    assert.deepStrictEqual(await syncAll({ pool, app: githubApp, fetch, now: NOW }), { repos: 1, inserted: 3, failed: 0 });
    const rows = await withScope(pool, { tenantId }, async (c) => (await c.query(
        'SELECT deployment_id, manual, deployed_by_login, deployed_by_name FROM deployments ORDER BY deployment_id'
    )).rows);
    assert.deepStrictEqual(rows.map((r) => [Number(r.deployment_id), r.manual, r.deployed_by_login, r.deployed_by_name]), [
        [1, true, 'carol', 'Carol Nowak'],
        [2, true, 'dave', null],
        [3, null, 'dependabot[bot]', null],
    ]);
    assert.strictEqual(calls.filter((u) => u.includes('/actions/runs/100')).length, 1, 'one lookup per run');
    assert.ok(!calls.some((u) => u.startsWith('/users/dependabot')), 'bot logins are not looked up');

    const data = (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    assert.deepStrictEqual(data.deployments.map((d) => [d.id, d.manual, d.deployedBy, d.deployedByLogin]), [
        ['gh-3', false, 'dependabot[bot]', 'dependabot[bot]'],
        ['gh-2', true, 'dave', 'dave'],
        ['gh-1', true, 'Carol Nowak', 'carol'],
    ]);
});
