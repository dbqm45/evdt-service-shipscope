// Contract between the server's dashboard data and the frontend that reads it. The deployment and Jira syncs run
// against fake GitHub/Atlassian APIs, the data goes out through the real /dashboard-data and /jira-issues routes,
// and the real docs/app-*.js load it with loadData() in a vm and compute what the views show: release status by
// sub-task and blocker keys, the current version, the drift button, the never-trimmed issueDeployments. A field
// renamed on one side only (driftBehind.diff, relatedIssues, subtaskKeys, blockedByKeys, issueDeployments, ...)
// turns this red, where each side's own tests would still pass.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn, testGitHubApp } = require('./helpers/auth');
const { fakeAtlassian } = require('./helpers/atlassian');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { syncAll } = require('../lib/deployment-sync');

const DOCS = path.join(__dirname, '..', '..', 'docs');
// docs/index.html order, without app-main.js (it starts the page on load).
const SCRIPTS = ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model', 'app-product', 'app-technical', 'app-technical-matrix'];
const USERS = { alice: { id: 870_000_001, login: 'alice' } };
const ACME = 7101;
const ATLASSIAN = { clientId: 'atl-client', clientSecret: 'atl-secret', encryptionKey: crypto.randomBytes(32) };
const SITE = { id: 'cloud-a', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] };
const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const sha = (n) => n.toString(16).padStart(40, 'a');
const tree = (files) => ({ truncated: false, tree: Object.entries(files).map(([p, blob]) => ({ path: p, type: 'blob', sha: blob })) });
const issue = (key, type, fields = {}) => ({
    key,
    fields: {
        summary: `${key} title`, issuetype: { name: type, hierarchyLevel: 0 }, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        priority: { name: 'Major' }, created: '2026-09-01T10:00:00.000+0000', resolutiondate: null, project: { name: 'Sparks' },
        customfield_10020: [{ id: 103, name: 'Sparks 27.3.2' }], ...fields,
    },
});

/** The dashboard scripts in a vm, as served at /t/<tenantId>/, with fetch going to the app (signed in as `sid`). */
function loadFrontend(app, tenantId, sid) {
    const stub = () => ({ style: {}, dataset: {}, hidden: true, textContent: '', title: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, addEventListener() {} });
    const ctx = {
        console, URLSearchParams, URL, Date, Math, JSON, Promise, Map, Set,
        location: { pathname: `/t/${tenantId}/`, search: '', assign() { throw new Error('redirected to sign-in'); } },
        localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: stub(), body: stub(), getElementById: stub, querySelector: stub, querySelectorAll: () => [], createElement: stub, addEventListener() {} },
        fetch: async (url) => {
            const res = await app.inject({ method: 'GET', url, cookies: { sid } });
            return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
        },
    };
    vm.createContext(ctx);
    for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(DOCS, `${f}.js`), 'utf8'), ctx, { filename: `${f}.js` });
    return (code) => vm.runInContext(code, ctx);
}

test('the frontend reads what the syncs stored: release status by sub-task and blocker keys, versions, drift, history', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    // Jira: Story ABC-1 has sub-task ABC-7; Bug ABC-9 is blocked by ABC-1 and has no commit of its own; ABC-8 is untouched.
    const jira = {
        'cloud-a': {
            boards: [{ id: 10, name: 'Sparks', type: 'scrum', location: { projectKey: 'ABC', projectName: 'Sparks' } }],
            sprints: { 10: [{ id: 103, name: 'Sparks 27.3.2', state: 'active', startDate: '2026-08-15', endDate: '2026-09-01' }] },
            fields: [{ id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }],
            issues: [
                issue('ABC-1', 'Story', { subtasks: [{ key: 'ABC-7', fields: { status: { statusCategory: { key: 'done' } } } }] }),
                issue('ABC-8', 'Story'),
                issue('ABC-9', 'Bug', { issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'ABC-1', fields: { status: { statusCategory: { key: 'indeterminate' } } } } }] }),
            ],
        },
    };
    const atlassian = fakeAtlassian({ codes: { c1: [SITE] }, jira });
    // GitHub: only the sub-task's key is in the commits; qa runs older code than test.
    const web = {
        deployments: [
            { id: 2, environment: 'test', sha: sha(2), created_at: at(20) },
            { id: 1, environment: 'qa', sha: sha(1), created_at: at(30) },
        ],
        statuses: { 1: [{ state: 'success', created_at: at(29) }], 2: [{ state: 'success', created_at: at(19) }] },
        commits: { [sha(1)]: 'feat: ABC-7 first part', [sha(2)]: 'feat: ABC-7 second part' },
        tags: [{ name: 'v1.0.0', commit: { sha: sha(1) } }, { name: 'v1.1.0', commit: { sha: sha(2) } }],
        compare: () => ({ ahead_by: 1, behind_by: 0 }),
        trees: { [`tree-${sha(1)}`]: tree({ 'src/a.js': '1' }), [`tree-${sha(2)}`]: tree({ 'src/a.js': '2' }) },
    };
    const { app: githubApp, publicKey } = testGitHubApp();
    const github = fakeGitHub(USERS, { publicKey, installations: { [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: [] } }, repos: { 'acme/web': web } });
    const fetch = (url, init) => (/^https:\/\/(auth|api)\.atlassian\.com\//.test(url) ? atlassian.handler(url, init) : github(url, init));
    const app = buildApp({ pool, auth: AUTH, githubApp, atlassian: ATLASSIAN, fetch });
    t.after(() => app.close());

    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const call = (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid: alice }, payload });
    const start = await call('GET', '/jira/connect');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cookie = start.cookies.find((c) => c.name === 'jira_connect').value;
    assert.strictEqual((await app.inject({ method: 'GET', url: `/auth/atlassian/callback?code=c1&state=${state}`, cookies: { sid: alice, jira_connect: cookie } })).statusCode, 302);
    assert.strictEqual((await call('PUT', '/jira/boards', { boardIds: [10] })).statusCode, 200);
    assert.strictEqual((await call('POST', '/jira/sync')).statusCode, 200);

    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, $2, 'acme', 'Organization')", [tenantId, ACME]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, $2, 'acme/web')", [tenantId, ACME]);
    });
    await syncAll({ pool, app: githubApp, fetch, now: NOW });

    const run = loadFrontend(app, tenantId, alice);
    await run(`(async () => {
        state = await loadData();
        state.selectedPi = state.jiraIndex.currentPi;
        state.jiraIssues = await loadJiraIssuesForPi(state.selectedPi);
    })()`);
    const ev = (code) => JSON.parse(JSON.stringify(run(code)));

    assert.strictEqual(ev('state.selectedPi'), 'PI-27.3');
    assert.deepStrictEqual(ev('state.jiraIssues.map(i => i.key).sort()'), ['ABC-1', 'ABC-8', 'ABC-9']);
    assert.strictEqual(ev('jiraIssueUrl("ABC-1")'), 'https://acme.atlassian.net/browse/ABC-1');
    const component = ev('state.componentsOrder[0].name');
    const level = (key, env) => ev(`issueStatusForEnv(state.jiraIssues.find(i => i.key === ${JSON.stringify(key)}), ${JSON.stringify(env)}).level`);

    // subtaskKeys + relatedIssues: the Story shipped through its sub-task's commits.
    assert.strictEqual(level('ABC-1', 'qa'), 'deployed_code_only');
    assert.strictEqual(level('ABC-1', 'prod'), 'none');
    // blockedByKeys: the Bug shipped in the Story that blocks it.
    assert.strictEqual(level('ABC-9', 'test'), 'deployed_code_only');
    assert.strictEqual(level('ABC-8', 'test'), 'none');

    // version / resolvedRef and driftBehind on each environment's latest record, read by the matrix.
    assert.strictEqual(ev(`currentVersion(${JSON.stringify(component)}, 'qa').version`), 'v1.0.0');
    assert.strictEqual(ev(`currentVersion(${JSON.stringify(component)}, 'test').version`), 'v1.1.0');
    const button = ev(`String(driftNotesHtml(currentVersion(${JSON.stringify(component)}, 'qa').driftBehind))`);
    assert.match(button, /Diff to TEST/);
    assert.match(button, /data-behind="1"/);
    assert.match(button, /src\/a\.js/, 'the file diff reaches the drift modal');
    assert.strictEqual(ev(`String(driftNotesHtml(currentVersion(${JSON.stringify(component)}, 'test').driftBehind))`), '', 'the newer environment has no drift');

    // issueDeployments outlives retention: with no live deployment records the Story still counts as on qa.
    run('state.deployments = []');
    assert.strictEqual(level('ABC-1', 'qa'), 'deployed_code_only');
    assert.strictEqual(level('ABC-9', 'test'), 'deployed_code_only');
});
