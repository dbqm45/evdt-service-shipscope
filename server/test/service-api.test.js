// Service API (F5 of the pdi one-flow plan, design-docs/F5-API-PLAN.pl.md): read-only service tokens per workspace,
// an item's status per environment and PROD metrics per day, for pdi (trace graph, outcome review) and tf (control
// bands). Status and lead time come from the real docs/app-*.js run on the server (lib/release-status.js).
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { fakeGitHub, AUTH, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { refreshWorkItems } = require('../lib/work-items');

const KEY = crypto.randomBytes(32);
const sha = (n) => n.toString(16).padStart(40, 'a');
const DIR = 'docs/project/changes';
const PLAN_MD = '---\nartifact: plan\nchange: CHG-12\ntasks: [TSK-57, TSK-58]\n---\n\n- TSK-57: Retry endpoint (done)\n- TSK-58: Idempotency key (done)\n';
const INTENT_MD = '---\nartifact: intent\nchange: CHG-12\nsource: PRB-3\nsource_reported_at: 2026-09-14\ncreated: 2026-09-20\n---\n\n# Retry failed payments\n\n## Problem\nOperators retry failed payments by hand.\n';
const RELEASE_YAML = 'change: CHG-12\nmvp:\n  release: R1\n  outcome: Retry without a double charge\nreleases:\n  - { id: R1, name: MVP, tasks: [TSK-57, TSK-58] }\nflags:\n  - key: payment-retry\n    tasks: [TSK-57, TSK-58]\n    remove_by: 2026-10-01\n    rollout:\n      - { stage: internal, min_days: 3 }\n      - { stage: "10%", min_days: 7 }\n      - { stage: "100%" }\n';

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const repo = { files: { [sha(1)]: { [`${DIR}/CHG-12/intent.md`]: INTENT_MD, [`${DIR}/CHG-12/plan.md`]: PLAN_MD, [`${DIR}/CHG-12/release.yaml`]: RELEASE_YAML } }, trees: {}, fileCommits: { [DIR]: [sha(1)] } };
    repo.trees[sha(1)] = { truncated: false, tree: Object.keys(repo.files[sha(1)]).map((p) => ({ path: p, type: 'blob', sha: 'x' })) };
    const fetch = fakeGitHub({ alice: { id: 850_400_001, login: 'alice' }, bob: { id: 850_400_002, login: 'bob' } }, { repos: { 'acme/pay': repo } });
    const app = buildApp({ pool, auth: AUTH, fetch, encryptionKey: KEY });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const as = (sid) => (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid }, payload });
    const link = (await as(alice)('POST', '/invitations', { role: 'member' })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    await rows("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
    await rows("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/pay')", [tenantId]);
    await refreshWorkItems({ pool, token: 'inst-token-1', tenantId, repo: { repoId: 1, fullName: 'acme/pay' }, fetch });
    const deploy = (id, env, status, at, issues, rollback = null) => rows(
        `INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at, related_issues, rollback_to_sha)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`, [tenantId, id, env, status, sha(100 + id), at, issues, rollback]);
    await deploy(1, 'qa', 'success', '2026-10-01T08:00:00Z', ['TSK-57', 'TSK-58', 'PAY-1']);
    await deploy(2, 'prod', 'success', '2026-10-02T10:00:00Z', ['TSK-57', 'TSK-58', 'PAY-1']);
    await deploy(3, 'prod', 'failed', '2026-10-04T10:00:00Z', []);
    await deploy(4, 'prod', 'success', '2026-10-04T12:00:00Z', [], sha(102));
    // A Jira issue resolved three days before it reached PROD.
    await rows("INSERT INTO jira_connections (tenant_id, refresh_token_enc, scopes, available_sites, connected_by) VALUES ($1, 'x', '{}', '[]', (SELECT user_id FROM memberships WHERE tenant_id = $1 LIMIT 1))", [tenantId]);
    await rows("INSERT INTO jira_pis (tenant_id, pi, synced_at) VALUES ($1, 'PI-1', now())", [tenantId]);
    const issue = { key: 'PAY-1', type: 'Story', title: 'Pay by link', pi: 'PI-1', sprint: null, status: 'Done', statusCategory: 'done', subtasks: null, subtaskKeys: [], blockedByKeys: [], featureFlags: [], epicKey: null, epicTitle: null, resolvedAt: '2026-09-29T10:00:00Z', created: '2026-09-01T00:00:00Z' };
    await rows("INSERT INTO jira_issues (tenant_id, pi, key, board_id, data, synced_at) VALUES ($1, 'PI-1', 'PAY-1', 1, $2, now())", [tenantId, issue]);
    const service = (token, url) => app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const flag = async (state, rollout) => {
        const { token } = (await as(alice)('POST', '/flag-sources', { name: 'LD', kind: 'runtime', repoIds: [1] })).json();
        const res = await app.inject({
            method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token.token}` },
            payload: { schemaVersion: 2, observations: [{ key: 'payment-retry', env: 'prod', state, ...(rollout === undefined ? {} : { rollout }) }], flags: [{ key: 'payment-retry', description: 'Retry button', itemKeys: ['TSK-57', 'TSK-58'] }] },
        });
        assert.strictEqual(res.statusCode, 200, res.body);
    };
    return { pool, app, alice, bob, tenantId, as, rows, service, flag };
}

test('service tokens: admins create them, the token is shown once and stored as a hash; revoked or expired is 401', async (t) => {
    const { as, alice, bob, rows, service } = await setup(t);
    assert.strictEqual((await as(bob)('POST', '/service-tokens', { name: 'pdi' })).statusCode, 403);
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'pdi', lifetimeDays: 0 }, { name: 'pdi', extra: 1 }]) {
        assert.strictEqual((await as(alice)('POST', '/service-tokens', body)).statusCode, 400, JSON.stringify(body));
    }
    const created = await as(alice)('POST', '/service-tokens', { name: 'pdi', lifetimeDays: 30 });
    assert.strictEqual(created.statusCode, 201, created.body);
    const { token } = created.json();
    assert.match(token.token, /^shps_[A-Za-z0-9_-]{43}$/);
    assert.ok(Math.abs(new Date(token.expiresAt) - Date.now() - 30 * 86400_000) < 60_000);
    const listed = (await as(alice)('GET', '/service-tokens')).json().tokens;
    assert.deepStrictEqual(listed.map((x) => [x.id, x.name]), [[token.id, 'pdi']]);
    assert.ok(!JSON.stringify(listed).includes(token.token), 'never listed again');
    const [stored] = await rows('SELECT token_hash FROM service_tokens');
    assert.strictEqual(stored.token_hash, crypto.createHash('sha256').update(token.token).digest('hex'));
    assert.strictEqual((await as(bob)('GET', '/service-tokens')).statusCode, 403);

    assert.strictEqual((await service(token.token, '/api/service/v1/items/TSK-57')).statusCode, 200);
    assert.ok((await rows('SELECT last_used_at FROM service_tokens'))[0].last_used_at, 'use is noted');
    for (const bad of [null, 'shps_nope', `shpi_${'a'.repeat(43)}`]) {
        const res = await service(bad, '/api/service/v1/items/TSK-57');
        assert.strictEqual(res.statusCode, 401, String(bad));
    }
    await rows("UPDATE service_tokens SET expires_at = now() - interval '1 minute'");
    assert.strictEqual((await service(token.token, '/api/service/v1/items/TSK-57')).statusCode, 401, 'expired');
    await rows('UPDATE service_tokens SET expires_at = NULL');
    assert.strictEqual((await as(alice)('DELETE', `/service-tokens/${token.id}`)).statusCode, 204);
    assert.strictEqual((await service(token.token, '/api/service/v1/items/TSK-57')).statusCode, 401, 'revoked');
    assert.strictEqual((await as(alice)('DELETE', `/service-tokens/${token.id}`)).statusCode, 404);
    const events = (await as(alice)('GET', '/audit-events')).json().events;
    assert.deepStrictEqual(events.filter((e) => e.kind.startsWith('service_token')).map((e) => [e.kind, e.subject]).sort(), [['service_token_created', 'pdi'], ['service_token_revoked', 'pdi']]);
    assert.ok(!JSON.stringify(events).includes(token.token));

    const never = (await as(alice)('POST', '/service-tokens', { name: 'tf', lifetimeDays: null })).json().token;
    assert.strictEqual(never.expiresAt, null, 'or no end');
});

test('item status: per environment as the dashboard pill shows it, for a task, a change and a Jira issue', async (t) => {
    const { as, alice, service } = await setup(t);
    const { token } = (await as(alice)('POST', '/service-tokens', { name: 'pdi' })).json();
    const task = await service(token.token, '/api/service/v1/items/TSK-57');
    assert.strictEqual(task.statusCode, 200, task.body);
    const body = task.json();
    assert.deepStrictEqual([body.key, body.source, body.title], ['TSK-57', 'repo', 'Retry endpoint']);
    assert.deepStrictEqual(Object.fromEntries(Object.entries(body.envs).map(([env, s]) => [env, s.status])), { test: 'none', qa: 'deployed_code_only', prod: 'deployed_code_only' });
    assert.deepStrictEqual([body.firstProdAt, body.releasedOnProd], ['2026-10-02T10:00:00.000Z', true]);

    const change = (await service(token.token, '/api/service/v1/items/CHG-12')).json();
    assert.deepStrictEqual([change.title, change.envs.prod.status], ['Retry failed payments', 'deployed_code_only']);
    const jira = (await service(token.token, '/api/service/v1/items/PAY-1')).json();
    assert.deepStrictEqual([jira.source, jira.title, jira.envs.prod.status], ['jira', 'Pay by link', 'deployed_code_only']);
    assert.strictEqual((await service(token.token, '/api/service/v1/items/NOPE-1')).statusCode, 404);
    assert.strictEqual((await service(token.token, '/api/service/v1/items/not-a-key')).statusCode, 400);
});

test('metrics: PROD per day as JSON or CSV (control_band.py reads the CSV), with range checks', async (t) => {
    const { as, alice, service } = await setup(t);
    const { token } = (await as(alice)('POST', '/service-tokens', { name: 'tf' })).json();
    const res = await service(token.token, '/api/service/v1/metrics?from=2026-10-01&to=2026-10-04');
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.deepStrictEqual(res.json().days, [
        { date: '2026-10-01', deployments: 0, failedDeployments: 0, rollbacks: 0, leadTimeDaysMedian: null, leadTimeCount: 0 },
        { date: '2026-10-02', deployments: 1, failedDeployments: 0, rollbacks: 0, leadTimeDaysMedian: 3, leadTimeCount: 1 },
        { date: '2026-10-03', deployments: 0, failedDeployments: 0, rollbacks: 0, leadTimeDaysMedian: null, leadTimeCount: 0 },
        { date: '2026-10-04', deployments: 1, failedDeployments: 1, rollbacks: 1, leadTimeDaysMedian: null, leadTimeCount: 0 },
    ]);
    assert.deepStrictEqual(Object.keys(res.json()).sort(), ['days', 'environment', 'from', 'to']);

    const csv = await service(token.token, '/api/service/v1/metrics?from=2026-10-01&to=2026-10-04&format=csv');
    assert.strictEqual(csv.statusCode, 200);
    assert.match(csv.headers['content-type'], /^text\/csv/);
    assert.deepStrictEqual(csv.body.trim().split('\n'), [
        'date,deployments,failed_deployments,rollbacks,lead_time_days_median,lead_time_count',
        '2026-10-01,0,0,0,,0',
        '2026-10-02,1,0,0,3,1',
        '2026-10-03,0,0,0,,0',
        '2026-10-04,1,1,1,,0',
    ]);
    for (const q of ['from=2026-1-01&to=2026-10-04', 'from=2026-10-05&to=2026-10-04', 'from=2025-01-01&to=2026-10-04', 'format=xml', 'from=2026-02-30&to=2026-03-01']) {
        assert.strictEqual((await service(token.token, `/api/service/v1/metrics?${q}`)).statusCode, 400, q);
    }
    const dflt = (await service(token.token, '/api/service/v1/metrics')).json();
    assert.strictEqual(dflt.days.length, 90, 'the last 90 days by default');
});

test('changes: the repo\'s changes with their problem, source, tasks and status per environment, as the dashboard has them', async (t) => {
    const { as, alice, service } = await setup(t);
    const { token } = (await as(alice)('POST', '/service-tokens', { name: 'pdi' })).json();
    const res = await service(token.token, '/api/service/v1/changes');
    assert.strictEqual(res.statusCode, 200, res.body);
    const { changes } = res.json();
    assert.deepStrictEqual(changes.map((c) => [c.key, c.title, c.problem, c.source, c.sourceReportedAt, c.intentCreated]), [
        ['CHG-12', 'Retry failed payments', 'Operators retry failed payments by hand.', 'PRB-3', '2026-09-14', '2026-09-20'],
    ]);
    const [change] = changes;
    assert.deepStrictEqual([change.envs.prod.status, change.envs.test.status, change.firstProdAt, change.releasedOnProd], ['deployed_code_only', 'none', '2026-10-02T10:00:00.000Z', true]);
    assert.deepStrictEqual(change.tasks.map((x) => [x.key, x.title, x.status, x.prod]), [['TSK-57', 'Retry endpoint', 'Done', 'deployed_code_only'], ['TSK-58', 'Idempotency key', 'Done', 'deployed_code_only']]);
    assert.deepStrictEqual(change.subtasks, { done: 2, total: 2 });
    assert.strictEqual((await service(null, '/api/service/v1/changes')).statusCode, 401);
});

test('release plan: lines with their items on PROD, the MVP, and each planned flag\'s stage and remove-by', async (t) => {
    const { as, alice, service, flag } = await setup(t);
    await flag('partial', 10);
    const { token } = (await as(alice)('POST', '/service-tokens', { name: 'pdi' })).json();
    const res = await service(token.token, '/api/service/v1/release-plan');
    assert.strictEqual(res.statusCode, 200, res.body);
    const { mode, groups } = res.json();
    assert.strictEqual(mode, 'repo');
    const group = groups.find((g) => g.key === 'CHG-12');
    assert.deepStrictEqual([group.mvp, group.outcome, group.problems], ['R1', 'Retry without a double charge', []]);
    assert.deepStrictEqual(group.lines.map((l) => [l.id, l.name, l.released, l.onProdCount, l.items.map((i) => [i.key, i.prod])]), [
        ['R1', 'MVP', false, 0, [['TSK-57', 'partial'], ['TSK-58', 'partial']]],
    ], 'the flag is at 10%, so the MVP is partly out');
    assert.strictEqual(group.mvpReleased, false);
    const [f] = group.flags;
    assert.deepStrictEqual([f.key, f.state, f.percent, f.stage, f.nextStage, f.overdue], ['payment-retry', 'partial', 10, '10%', '100%', true]);
    assert.ok(f.daysPastRemoveBy > 0);
});

test('flags: what each flag is, its items, PROD exposure and state per service, freshness and warnings', async (t) => {
    const { as, alice, service, flag } = await setup(t);
    await flag('partial', 10);
    const { token } = (await as(alice)('POST', '/service-tokens', { name: 'pdi' })).json();
    const res = await service(token.token, '/api/service/v1/flags');
    assert.strictEqual(res.statusCode, 200, res.body);
    const [f] = res.json().flags;
    assert.deepStrictEqual([f.key, f.description, f.kind, f.itemKeys], ['payment-retry', 'Retry button', 'runtime', ['TSK-57', 'TSK-58']]);
    assert.deepStrictEqual([f.prod.state, f.prod.percent], ['partial', 10]);
    const services = Object.entries(f.envs.prod).map(([component, v]) => [component, v.state, v.rollout, v.sourceName]);
    assert.deepStrictEqual(services, [['pay', 'partial', 10, 'LD']]);
    assert.deepStrictEqual(Object.keys(f.envs).sort(), ['prod']);
    assert.strictEqual(f.freshness.pay.prod.state, 'fresh');
    assert.deepStrictEqual([f.blastRadius, f.stale], [null, null]);
});

test('environments: each service\'s latest successful deployment per environment, with its drift', async (t) => {
    const { as, alice, service, rows } = await setup(t);
    await rows(`UPDATE tracked_repos SET drift = $1`, [{ inputs: {}, failed: false, envs: { prod: { behindEnv: 'qa', commitCount: 2, diff: { files: 3, paths: ['a.js', 'b.js', 'c.js'], ignored: 0 } } } }]);
    const { token } = (await as(alice)('POST', '/service-tokens', { name: 'pdi' })).json();
    const res = await service(token.token, '/api/service/v1/environments');
    assert.strictEqual(res.statusCode, 200, res.body);
    const [pay] = res.json().services;
    assert.strictEqual(pay.name, 'pay');
    assert.deepStrictEqual(Object.keys(pay.envs), ['test', 'qa', 'prod']);
    assert.strictEqual(pay.envs.test, null, 'never deployed there');
    assert.deepStrictEqual([pay.envs.qa.deployedAt, pay.envs.qa.drift], ['2026-10-01T08:00:00.000Z', null]);
    assert.deepStrictEqual([pay.envs.prod.deployedAt, pay.envs.prod.rollback], ['2026-10-04T12:00:00.000Z', true], 'the latest success, a rollback');
    assert.deepStrictEqual(pay.envs.prod.drift, { comparedWith: 'qa', files: 3, paths: ['a.js', 'b.js', 'c.js'], unknown: false, commitsBehind: 2 });
});

test('isolation: a token reads only its own workspace', async (t) => {
    const first = await setup(t);
    const { token } = (await first.as(first.alice)('POST', '/service-tokens', { name: 'pdi' })).json();
    // A second workspace of alice's with its own repo and change: invisible to the first token.
    const other = (await first.app.inject({ method: 'POST', url: '/tenants', cookies: { sid: first.alice }, payload: { name: 'Other' } })).json().tenant.id;
    await withScope(first.pool, { tenantId: other }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 10, 'other', 'Organization')", [other]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 2, 10, 'other/x')", [other]);
        await c.query("INSERT INTO work_items (tenant_id, repo_id, item_key, kind, title, status, path, ref) VALUES ($1, 2, 'CHG-99', 'change', 'Secret change', 'in_progress', 'docs/project/changes/CHG-99/intent.md', 'abc')", [other]);
    });
    assert.strictEqual((await first.service(token.token, '/api/service/v1/items/CHG-99')).statusCode, 404);
    const otherToken = (await first.app.inject({ method: 'POST', url: `/tenants/${other}/service-tokens`, cookies: { sid: first.alice }, payload: { name: 'o' } })).json().token;
    assert.strictEqual((await first.service(otherToken.token, '/api/service/v1/items/CHG-99')).statusCode, 200);
    assert.strictEqual((await first.service(otherToken.token, '/api/service/v1/items/TSK-57')).statusCode, 404);
    const keys = async (tok) => (await first.service(tok, '/api/service/v1/changes')).json().changes.map((c) => c.key);
    assert.deepStrictEqual([await keys(token.token), await keys(otherToken.token)], [['CHG-12'], ['CHG-99']]);
    assert.deepStrictEqual((await first.service(otherToken.token, '/api/service/v1/environments')).json().services.map((x) => x.name), ['x']);
});
