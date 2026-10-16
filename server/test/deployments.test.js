const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, testGitHubApp } = require('./helpers/auth');
const { withScope } = require('../lib/scope');
const { syncAll } = require('../lib/deployment-sync');
const { cleanupTenant } = require('../lib/retention');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const USERS = { alice: { id: 840_000_001, login: 'alice' }, mallory: { id: 840_000_002, login: 'mallory' } };
const ACME = 6001;
const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const status = (state, minutesAgo, extra = {}) => ({ state, created_at: at(minutesAgo), ...extra });
const sha = (n) => n.toString(16).padStart(40, 'a');

/**
 * A fresh tenant with ACME linked and `acme/web` (repo 1) and `acme/api` (repo 2) tracked, straight in the
 * database (the connect flow itself is covered by github.test.js). `repos` drives the fake GitHub.
 */
async function setup(t, repos) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { app: githubApp, publicKey } = testGitHubApp();
    const fake = fakeGitHub(USERS, {
        publicKey,
        installations: { [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: [] } },
        repos,
    });
    const calls = [];
    const fetch = (url, init) => {
        calls.push(url);
        return fake(url, init);
    };
    const app = buildApp({ pool, auth: AUTH, githubApp, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, $2, 'acme', 'Organization')", [tenantId, ACME]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, $2, 'acme/web'), ($1, 2, $2, 'acme/api')", [tenantId, ACME]);
    });
    const sync = (extra = {}) => syncAll({ pool, app: githubApp, fetch, now: NOW, ...extra });
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    return { pool, app, alice, tenantId, sync, rows, calls };
}

const emptyRepo = () => ({ deployments: [], statuses: {}, commits: {}, compare: () => ({ status: 'ahead', commits: [] }) });

test('sync: records, issue keys from the commit range, rollback, skips, and a cursor that waits for pending deploys', async (t) => {
    const web = {
        // GitHub lists newest first.
        deployments: [
            { id: 107, environment: 'qa', sha: sha(7), created_at: at(3 * 24 * 60) }, // no status for 3 days: stuck
            { id: 106, environment: 'qa', sha: sha(6), created_at: at(5) },           // pending: blocks the cursor
            { id: 105, environment: 'staging', sha: sha(5), created_at: at(40) },     // untracked environment
            { id: 104, environment: 'prod', sha: sha(2), created_at: at(50), creator: { login: 'carol' } },
            { id: 103, environment: 'prod', sha: sha(3), created_at: at(60) },
            { id: 102, environment: 'production', sha: sha(2), created_at: at(70) },
            { id: 101, environment: 'test', sha: sha(1), created_at: at(80) },
        ],
        statuses: {
            101: [status('success', 79, { log_url: 'https://github.com/acme/web/actions/runs/1' }), status('in_progress', 80)],
            102: [status('inactive', 59), status('success', 69), status('queued', 70)],
            103: [status('failure', 58)],
            104: [status('success', 49)],
            105: [status('success', 39)],
        },
        commits: { [sha(1)]: 'feat(SHP): first ABC-1', [sha(2)]: 'fix: ABC-2 crash' },
        compare: (base, head) => (head === sha(2)
            ? { status: 'behind', commits: [] }
            : { status: 'ahead', commits: [{ commit: { message: 'feat(x): ABC-3' } }, { commit: { message: 'ABC-4 and ABC-3' } }] }),
    };
    const { sync, rows, calls } = await setup(t, { 'acme/web': web, 'acme/api': emptyRepo() });

    assert.deepStrictEqual(await sync(), { repos: 2, inserted: 4, failed: 0 });

    const deps = await rows('SELECT deployment_id, environment, status, related_issues, rollback_to_sha, commit_url, deployed_by_login, duration_ms, workflow_run_url FROM deployments ORDER BY deployment_id');
    assert.deepStrictEqual(deps.map((d) => [Number(d.deployment_id), d.environment, d.status]), [
        [101, 'test', 'success'], [102, 'prod', 'success'], [103, 'prod', 'failed'], [104, 'prod', 'success'],
    ]);
    const byId = Object.fromEntries(deps.map((d) => [Number(d.deployment_id), d]));
    // 101/102: first on their environment, issues from the single commit.
    assert.deepStrictEqual(byId[101].related_issues, ['ABC-1']);
    assert.strictEqual(byId[101].commit_url, `https://github.com/acme/web/commit/${sha(1)}`);
    assert.strictEqual(byId[101].workflow_run_url, 'https://github.com/acme/web/actions/runs/1');
    assert.strictEqual(Number(byId[101].duration_ms), 60_000);
    // 102's newest status is `inactive`; the real outcome (success) is used, and inactive isn't in the duration.
    assert.deepStrictEqual(byId[102].related_issues, ['ABC-2']);
    assert.strictEqual(Number(byId[102].duration_ms), 60_000);
    // 103 failed: compared with the last success (102), but a failure never becomes "the previous" for 104.
    assert.deepStrictEqual(byId[103].related_issues.sort(), ['ABC-3', 'ABC-4']);
    // 104 redeploys 102's commit... after a different success? No: 103 failed, so previous is still 102 (same sha)
    // and it inherits 102's range instead of comparing a commit with itself.
    assert.deepStrictEqual(byId[104].related_issues, ['ABC-2']);
    assert.strictEqual(byId[104].rollback_to_sha, null);
    assert.strictEqual(byId[104].deployed_by_login, 'carol');

    const facts = await rows('SELECT issue_key, environment FROM issue_deployments ORDER BY issue_key, environment');
    assert.deepStrictEqual(facts.map((f) => `${f.issue_key}@${f.environment}`), ['ABC-1@test', 'ABC-2@prod'], 'only successful deploys count');

    const [cursor] = await rows('SELECT deployments_cursor, last_synced_at, last_sync_error FROM tracked_repos WHERE repo_id = 1');
    assert.strictEqual(Number(cursor.deployments_cursor), 105, 'stops just below the pending 106');
    assert.ok(cursor.last_synced_at);
    assert.strictEqual(cursor.last_sync_error, null);

    // Second pass: nothing new is written twice; 106 is still pending. Pagination stops at the cursor, so
    // already-synced deployments aren't fetched again (their statuses would cost API calls on every run).
    calls.length = 0;
    assert.strictEqual((await sync()).inserted, 0);
    const statusCalls = calls.filter((u) => u.includes('/statuses')).map((u) => Number(u.match(/deployments\/(\d+)\//)[1])).sort();
    assert.deepStrictEqual(statusCalls, [106, 107]);

    // 106 resolves: the next pass picks it up and the cursor moves past the stuck 107 as well.
    web.statuses[106] = [status('success', 1)];
    assert.strictEqual((await sync()).inserted, 1);
    const [after] = await rows('SELECT deployments_cursor FROM tracked_repos WHERE repo_id = 1');
    assert.strictEqual(Number(after.deployments_cursor), 107);
});

test('sync: a deploy that moves an environment back to an older commit is marked as a rollback', async (t) => {
    const web = {
        deployments: [
            { id: 203, environment: 'prod', sha: sha(21), created_at: at(10) },
            { id: 202, environment: 'prod', sha: sha(22), created_at: at(20) },
            { id: 201, environment: 'prod', sha: sha(21), created_at: at(30) },
        ],
        statuses: { 201: [status('success', 29)], 202: [status('success', 19)], 203: [status('success', 9)] },
        commits: { [sha(21)]: 'feat: OLD-1' },
        compare: (base, head) => (head === sha(21) ? { status: 'behind', commits: [] } : { status: 'ahead', commits: [{ commit: { message: 'feat: NEW-1' } }] }),
    };
    const { sync, rows } = await setup(t, { 'acme/web': web, 'acme/api': emptyRepo() });
    await sync();
    const deps = await rows('SELECT deployment_id, rollback_to_sha, related_issues FROM deployments ORDER BY deployment_id');
    assert.deepStrictEqual(deps.map((d) => [Number(d.deployment_id), d.rollback_to_sha, d.related_issues]), [
        [201, null, ['OLD-1']],
        [202, null, ['NEW-1']],
        [203, sha(21), []],
    ]);
});

test('sync: one failing repo records its error and the others still sync', async (t) => {
    const web = { ...emptyRepo(), fail: 500 };
    const api = {
        ...emptyRepo(),
        deployments: [{ id: 301, environment: 'prod', sha: sha(31), created_at: at(5) }],
        statuses: { 301: [status('success', 4)] },
    };
    const { sync, rows } = await setup(t, { 'acme/web': web, 'acme/api': api });

    assert.deepStrictEqual(await sync(), { repos: 2, inserted: 1, failed: 1 });
    const repos = await rows('SELECT full_name, last_sync_error, last_synced_at FROM tracked_repos ORDER BY full_name');
    assert.strictEqual(repos[0].full_name, 'acme/api');
    assert.strictEqual(repos[0].last_sync_error, null);
    assert.ok(repos[0].last_synced_at);
    assert.match(repos[1].last_sync_error, /HTTP 500/);
    assert.strictEqual(repos[1].last_synced_at, null);
});

test('sync: a webhook\'s targeted sync touches only the repos it names', async (t) => {
    const web = { ...emptyRepo(), fail: 500 };
    const api = { ...emptyRepo(), deployments: [{ id: 301, environment: 'prod', sha: sha(31), created_at: at(5) }], statuses: { 301: [status('success', 4)] } };
    const { sync, calls } = await setup(t, { 'acme/web': web, 'acme/api': api });
    assert.deepStrictEqual(await sync({ repoIds: [2] }), { repos: 1, inserted: 1, failed: 0 });
    assert.ok(!calls.some((u) => u.includes('acme/web')), 'the other repo is not even asked');
    assert.deepStrictEqual(await sync({ repoIds: [999] }), { repos: 0, inserted: 0, failed: 0 });
    assert.deepStrictEqual(await sync({ repoIds: [] }), { repos: 0, inserted: 0, failed: 0 });
});

test('sync: the per-run cap processes the oldest first and the cursor follows it', async (t) => {
    const deployments = Array.from({ length: 5 }, (_, i) => ({ id: 405 - i, environment: 'test', sha: sha(40 + i), created_at: at(60 - i) }));
    const web = { ...emptyRepo(), deployments, statuses: Object.fromEntries(deployments.map((d) => [d.id, [status('success', 1)]])) };
    const { pool, rows } = await setup(t, { 'acme/web': web, 'acme/api': emptyRepo() });
    const { app: githubApp, publicKey } = testGitHubApp();
    const fetch = fakeGitHub(USERS, { publicKey, installations: { [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: [] } }, repos: { 'acme/web': web, 'acme/api': emptyRepo() } });

    assert.strictEqual((await syncAll({ pool, app: githubApp, fetch, now: NOW, options: { maxPerRun: 2 } })).inserted, 2);
    assert.deepStrictEqual((await rows('SELECT deployment_id FROM deployments ORDER BY deployment_id')).map((d) => Number(d.deployment_id)), [401, 402]);
    assert.strictEqual(Number((await rows('SELECT deployments_cursor FROM tracked_repos WHERE repo_id = 1'))[0].deployments_cursor), 402);
});

test('retention: old records go, the latest and latest-successful per repo/environment stay, issue facts stay', async (t) => {
    const { pool, tenantId, rows } = await setup(t, { 'acme/web': emptyRepo(), 'acme/api': emptyRepo() });
    const insert = (id, repoId, env, state, daysAgo) => withScope(pool, { tenantId }, (c) => c.query(
        `INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at)
         VALUES ($1, $2, $3, $4, $5, 'x', now() - make_interval(days => $6))`,
        [tenantId, repoId, id, env, state, daysAgo]
    ));
    await insert(1, 1, 'prod', 'success', 400); // old
    await insert(2, 1, 'prod', 'success', 300); // latest successful on web/prod: kept although old
    await insert(3, 1, 'prod', 'failed', 200);  // latest overall on web/prod: kept although old
    await insert(4, 1, 'test', 'success', 100); // only one on web/test: kept
    await insert(5, 2, 'prod', 'success', 120); // old
    await insert(6, 2, 'prod', 'success', 10);  // recent
    await withScope(pool, { tenantId }, (c) => c.query(
        "INSERT INTO issue_deployments (tenant_id, issue_key, environment, repo_id, first_deployed_at) VALUES ($1, 'ABC-1', 'prod', 1, now() - interval '400 days')",
        [tenantId]
    ));

    assert.strictEqual(await cleanupTenant(pool, tenantId), 2, 'default 90 days');
    assert.deepStrictEqual((await rows('SELECT deployment_id FROM deployments ORDER BY deployment_id')).map((d) => Number(d.deployment_id)), [2, 3, 4, 6]);
    assert.strictEqual((await rows('SELECT * FROM issue_deployments')).length, 1);

    await pool.query('UPDATE tenants SET deployment_retention_days = 7 WHERE id = $1', [tenantId]);
    assert.strictEqual(await cleanupTenant(pool, tenantId), 0, 'the rest are latest/latest-success');
});

test('API: members read deployments with filters; admins set retention within 7-730; outsiders get 404', async (t) => {
    const api = {
        ...emptyRepo(),
        deployments: [
            { id: 502, environment: 'prod', sha: sha(52), created_at: at(5) },
            { id: 501, environment: 'test', sha: sha(51), created_at: at(10) },
        ],
        statuses: { 501: [status('success', 9)], 502: [status('success', 4)] },
    };
    const { app, alice, tenantId, sync } = await setup(t, { 'acme/web': emptyRepo(), 'acme/api': api });
    await sync();
    const mallory = await signIn(app, 'mallory');

    const all = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/deployments`, cookies: { sid: alice } });
    assert.strictEqual(all.statusCode, 200, all.body);
    assert.deepStrictEqual(all.json().deployments.map((d) => [d.deploymentId, d.repo, d.environment]), [[502, 'acme/api', 'prod'], [501, 'acme/api', 'test']]);
    const prod = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/deployments?environment=prod&limit=5&repoId=2`, cookies: { sid: alice } });
    assert.deepStrictEqual(prod.json().deployments.map((d) => d.deploymentId), [502]);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/deployments?environment=staging`, cookies: { sid: alice } })).statusCode, 400);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/deployments`, cookies: { sid: mallory } })).statusCode, 404);

    const settings = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/settings`, cookies: { sid: alice } });
    assert.deepStrictEqual(settings.json(), { name: 'Acme', deploymentRetentionDays: 90 });
    const put = (sid, payload) => app.inject({ method: 'PUT', url: `/tenants/${tenantId}/settings`, cookies: { sid }, payload });
    assert.deepStrictEqual((await put(alice, { deploymentRetentionDays: 30 })).json(), { name: 'Acme', deploymentRetentionDays: 30 });
    for (const bad of [{ deploymentRetentionDays: 6 }, { deploymentRetentionDays: 731 }, { deploymentRetentionDays: '30' }, { deploymentRetentionDays: 30.5 }, {}]) {
        assert.strictEqual((await put(alice, bad)).statusCode, 400, JSON.stringify(bad));
    }
    assert.strictEqual((await put(mallory, { deploymentRetentionDays: 30 })).statusCode, 404);
});

test('untracking a repo removes its deployments; RLS hides deployments from other tenants and unscoped reads', async (t) => {
    const api = { ...emptyRepo(), deployments: [{ id: 601, environment: 'prod', sha: sha(61), created_at: at(5) }], statuses: { 601: [status('success', 4)] }, commits: { [sha(61)]: 'ABC-9' } };
    const { pool, app, alice, tenantId, sync, rows } = await setup(t, { 'acme/web': emptyRepo(), 'acme/api': api });
    await sync();
    assert.strictEqual((await rows('SELECT * FROM deployments')).length, 1);
    assert.deepStrictEqual((await pool.query('SELECT * FROM deployments')).rows, [], 'unscoped');
    assert.deepStrictEqual((await pool.query('SELECT * FROM issue_deployments')).rows, [], 'unscoped');

    const other = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Other' } })).json().tenant.id;
    assert.deepStrictEqual(await withScope(pool, { tenantId: other }, async (c) => (await c.query('SELECT * FROM deployments')).rows), []);

    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/github/repos/2`, cookies: { sid: alice } })).statusCode, 204);
    assert.deepStrictEqual(await rows('SELECT * FROM deployments'), []);
    assert.deepStrictEqual(await rows('SELECT * FROM issue_deployments'), []);
});
