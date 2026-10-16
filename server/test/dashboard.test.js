const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, signInWithRedirect } = require('./helpers/auth');
const { withScope } = require('../lib/scope');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const USERS = { alice: { id: 850_000_001, login: 'alice' }, mallory: { id: 850_000_002, login: 'mallory' } };

async function setup(t, options = {}) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub(USERS), ...options });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    return { pool, app, alice, tenantId };
}

test('/ sends you to sign-in, to your first tenant\'s dashboard, or to /me without a tenant', async (t) => {
    const { app, alice, tenantId } = await setup(t);
    assert.strictEqual((await app.inject({ method: 'GET', url: '/' })).headers.location, '/auth/github/login');
    assert.strictEqual((await app.inject({ method: 'GET', url: '/', cookies: { sid: alice } })).headers.location, `/t/${tenantId}/`);
    const mallory = await signIn(app, 'mallory');
    assert.strictEqual((await app.inject({ method: 'GET', url: '/', cookies: { sid: mallory } })).headers.location, '/me');
});

test('the dashboard page: members only, signed-out users go through sign-in and come back', async (t) => {
    const { app, alice, tenantId } = await setup(t);
    const page = `/t/${tenantId}/`;

    const anonymous = await app.inject({ method: 'GET', url: page });
    assert.strictEqual(anonymous.statusCode, 302);
    assert.strictEqual(anonymous.headers.location, `/auth/github/login?returnTo=${encodeURIComponent(page)}`);
    const { location } = await signInWithRedirect(app, 'alice', anonymous.headers.location);
    assert.strictEqual(location, page);

    const res = await app.inject({ method: 'GET', url: page, cookies: { sid: alice } });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.body, /<script src="app-data\.js"><\/script>/);
    assert.ok(!/<link rel="preload" href="data\//.test(res.body), 'no preloads of data/*.json');

    assert.strictEqual((await app.inject({ method: 'GET', url: `/t/${tenantId}` })).headers.location, page);

    const mallory = await signIn(app, 'mallory');
    assert.strictEqual((await app.inject({ method: 'GET', url: page, cookies: { sid: mallory } })).statusCode, 404);
});

test('only the dashboard\'s own assets are served -- never data/*.json or config files', async (t) => {
    const { app, tenantId } = await setup(t);
    const js = await app.inject({ method: 'GET', url: `/t/${tenantId}/app-data.js` });
    assert.strictEqual(js.statusCode, 200);
    assert.match(js.headers['content-type'], /^text\/javascript/);
    assert.match(js.body, /API_TENANT_ID/);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/t/${tenantId}/style.css` })).statusCode, 200);

    for (const url of [
        `/t/${tenantId}/data/deployments.json`,
        `/t/${tenantId}/components.json`,
        `/t/${tenantId}/jira-spaces.json`,
        `/t/${tenantId}/app-missing.js`,
        `/t/${tenantId}/index.html`,
        `/t/${tenantId}/..%2Fpackage.json`,
        `/t/${tenantId}/%2e%2e%2fweb.js`,
    ]) {
        const res = await app.inject({ method: 'GET', url });
        assert.ok([400, 404].includes(res.statusCode), `${url} -> ${res.statusCode}`);
        assert.ok(!/"dependencies"|module\.exports/.test(res.body), `${url} leaked a file`);
    }
});

test('dashboard-data: the tenant\'s deployments in the data/*.json shapes the views read', async (t) => {
    const { pool, app, alice, tenantId } = await setup(t);
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
        await c.query(`INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name, last_synced_at)
                       VALUES ($1, 1, 9, 'acme/web', '2026-10-16T10:00:00Z'), ($1, 2, 9, 'acme/api', '2026-10-16T11:00:00Z')`, [tenantId]);
        await c.query(`INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at, deployed_by_login,
                           workflow_run_url, duration_ms, commit_url, rollback_to_sha, related_issues, issue_commit_types)
                       VALUES ($1, 1, 11, 'prod', 'success', 'aaaaaaaaaaaaaaaaaaaa', '2026-10-15T10:00:00Z', 'carol',
                           'https://x/runs/1', 60000, 'https://github.com/acme/web/compare/a...b', 'bbbbbbbbbbbbbbbbbbbb', '{ABC-1}', '{"ABC-1":"feat"}'),
                              ($1, 2, 12, 'test', 'failed', 'cccccccccccccccccccc', '2026-10-16T09:00:00Z', NULL, NULL, NULL, NULL, NULL, '{}', '{}')`, [tenantId]);
        await c.query(`INSERT INTO issue_deployments (tenant_id, issue_key, environment, repo_id, first_deployed_at, commit_url)
                       VALUES ($1, 'ABC-1', 'prod', 1, '2026-10-15T10:00:00Z', 'https://github.com/acme/web/compare/a...b')`, [tenantId]);
    });

    const res = await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    const data = res.json();
    assert.deepStrictEqual(data.deployments, [
        {
            id: 'gh-12', component: 'api', environment: 'test', version: 'cccccccccccc', commitUrl: null, workflowRunUrl: null,
            durationMs: null, manual: false, rollback: null, deployedAt: '2026-10-16T09:00:00.000Z', deployedBy: 'unknown',
            deployedByLogin: null, status: 'failed', relatedIssues: [], issueCommitTypes: {}, resolvedRef: null,
        },
        {
            id: 'gh-11', component: 'web', environment: 'prod', version: 'aaaaaaaaaaaa', commitUrl: 'https://github.com/acme/web/compare/a...b',
            workflowRunUrl: 'https://x/runs/1', durationMs: 60000, manual: false, rollback: { toRef: 'bbbbbbbbbbbb' },
            deployedAt: '2026-10-15T10:00:00.000Z', deployedBy: 'carol', deployedByLogin: 'carol', status: 'success',
            relatedIssues: ['ABC-1'], issueCommitTypes: { 'ABC-1': 'feat' }, resolvedRef: null,
        },
    ]);
    // Same created_at (one INSERT), so full_name decides the order.
    assert.deepStrictEqual(data.componentsOrder.map((c) => [c.name, c.description]), [['api', 'acme/api'], ['web', 'acme/web']]);
    assert.deepStrictEqual(data.issueDeployments, { 'ABC-1': { prod: { web: { deployedAt: '2026-10-15T10:00:00.000Z', commitUrl: 'https://github.com/acme/web/compare/a...b' } } } });
    assert.strictEqual(data.lastSyncedAt, '2026-10-16T11:00:00.000Z');
    assert.deepStrictEqual([data.flagsMeta, data.flagStates, data.jiraIndex, data.summary], [{}, {}, { currentPi: null, pis: [] }, { components: {} }]);

    const mallory = await signIn(app, 'mallory');
    assert.strictEqual((await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: mallory } })).statusCode, 404);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data` })).statusCode, 401);
});

test('dashboard-data: version, resolved ref and drift on each environment\'s latest successful record only', async (t) => {
    const { pool, app, alice, tenantId } = await setup(t);
    const drift = { behindEnv: 'qa', commitCount: 3, diff: { files: 1, paths: ['a.js'], ignored: 0 } };
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name, drift) VALUES ($1, 1, 9, 'acme/web', $2)",
            [tenantId, JSON.stringify({ inputs: {}, failed: [], envs: { prod: drift } })]);
        await c.query(`INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at, version, resolved_ref, rollback_to_sha)
                       VALUES ($1, 1, 1, 'prod', 'success', 'aaaaaaaaaaaaaaaaaaaa', '2026-10-14T10:00:00Z', NULL, NULL, NULL),
                              ($1, 1, 2, 'prod', 'success', 'bbbbbbbbbbbbbbbbbbbb', '2026-10-15T10:00:00Z', 'v1.2.0', 'v1.2.0', 'v1.2.0'),
                              ($1, 1, 3, 'prod', 'failed', 'cccccccccccccccccccc', '2026-10-16T10:00:00Z', 'v1.3.0', 'v1.3.0', NULL)`, [tenantId]);
    });
    const data = (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    assert.deepStrictEqual(data.deployments.map((d) => [d.id, d.version, d.resolvedRef, d.rollback, d.driftBehind]), [
        ['gh-3', 'v1.3.0', 'v1.3.0', null, undefined],
        ['gh-2', 'v1.2.0', 'v1.2.0', { toRef: 'v1.2.0' }, drift],
        ['gh-1', 'aaaaaaaaaaaa', null, null, undefined],
    ]);
});

test('two tracked repos with the same short name keep their full names as component names', async (t) => {
    const { pool, app, alice, tenantId } = await setup(t);
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization'), ($1, 10, 'beta', 'Organization')", [tenantId]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/web'), ($1, 2, 10, 'beta/web'), ($1, 3, 9, 'acme/api')", [tenantId]);
    });
    const data = (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    assert.deepStrictEqual(data.componentsOrder.map((c) => c.name).sort(), ['acme/web', 'api', 'beta/web']);
});

test('without the dashboard files the page answers 503 instead of crashing', async (t) => {
    const { app, alice, tenantId } = await setup(t, { dashboardDir: path.join(__dirname, 'no-such-dir') });
    const res = await app.inject({ method: 'GET', url: `/t/${tenantId}/`, cookies: { sid: alice } });
    assert.strictEqual(res.statusCode, 503);
});
