// Work items from a repo (F1 of the pdi one-flow plan, contract 0.4.0): changes CHG-n and their tasks TSK-n read from
// docs/project/changes/<CHG>/intent.md and plan.md (lib/work-items-model.js parses, lib/work-items.js syncs), shown as an
// increment of their own, "Changes (repo)", where a commit naming a task counts for its change.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseFrontMatter, planTasks, buildWorkItems, workItemIssues, intentProblem, WorkItemFileError, CHANGES_KEY } = require('../lib/work-items-model');

const INTENT = `---
artifact: intent
phase: discovery
status: accepted
version: 2
created: 2026-10-20
updated: 2026-10-23
change: CHG-12
source: PRB-34
source_reported_at: 2026-10-15
---

# Retry a failed payment without a double charge

## Problem
Customers whose card payment fails at checkout
cannot retry it — they start the order again and are sometimes charged twice.

## Warianty
| Wariant | Za | Przeciw |
`;
const PLAN = `---
artifact: plan
phase: plan
status: accepted
version: 1
created: 2026-10-23
updated: 2026-10-23
change: CHG-12
source: PRB-34
tasks: [TSK-57, TSK-58, TSK-59, TSK-60]
---

# Plan

| Cięcie | Tytuł | Wydanie | Flaga | Status |
|---|---|---|---|---|
| TSK-57 | Retry endpoint for a failed payment | R1 | payment-retry | done |
| TSK-58 | Idempotency key on charges | R1 | payment-retry | in_progress |

- TSK-59: Retry banner in the app (planned)
- **TSK-60** — Old retry job, dropped
`;

test('parseFrontMatter: the simple YAML header (text, numbers, lists) and the body; no header is an error', () => {
    const { header, body } = parseFrontMatter(PLAN);
    assert.deepStrictEqual(header, {
        artifact: 'plan', phase: 'plan', status: 'accepted', version: 1, created: '2026-10-23', updated: '2026-10-23',
        change: 'CHG-12', source: 'PRB-34', tasks: ['TSK-57', 'TSK-58', 'TSK-59', 'TSK-60'],
    });
    assert.match(body, /^\n# Plan/);
    assert.deepStrictEqual(parseFrontMatter('---\ntitle: "A: quoted"\nempty: []\n---\n').header, { title: 'A: quoted', empty: [] });
    assert.throws(() => parseFrontMatter('# no header\n'), WorkItemFileError);
    assert.throws(() => parseFrontMatter('---\nchange: CHG-1\nno end\n'), WorkItemFileError);
});

test('planTasks: title and status from a table row or a list line; a task the body never names keeps its key', () => {
    const { body } = parseFrontMatter(PLAN);
    assert.deepStrictEqual(planTasks(body, ['TSK-57', 'TSK-58', 'TSK-59', 'TSK-60', 'TSK-61']), [
        { key: 'TSK-57', title: 'Retry endpoint for a failed payment', status: 'done' },
        { key: 'TSK-58', title: 'Idempotency key on charges', status: 'in_progress' },
        { key: 'TSK-59', title: 'Retry banner in the app', status: 'planned' },
        { key: 'TSK-60', title: 'Old retry job', status: 'dropped' },
        { key: 'TSK-61', title: 'TSK-61', status: null },
    ]);
    assert.deepStrictEqual(planTasks('Mentions TSK-570 only', ['TSK-57']), [{ key: 'TSK-57', title: 'TSK-57', status: null }], 'whole keys only');
});

test('buildWorkItems: a change with its tasks; a bad file is an error for its change and the others still count', () => {
    const { items, errors } = buildWorkItems([
        { dir: 'CHG-12', intent: INTENT, plan: PLAN },
        { dir: 'CHG-13', intent: INTENT.replace('CHG-12', 'CHG-14') },
        { dir: 'CHG-15', intent: '# no header' },
        { dir: 'CHG-16', plan: PLAN.replace(/CHG-12/g, 'CHG-16').replace('TSK-57, ', 'not-a-key, ') },
        { dir: 'notes' },
    ]);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    assert.deepStrictEqual(byKey['CHG-12'], { key: 'CHG-12', kind: 'change', parent: null, title: 'Retry a failed payment without a double charge', status: 'accepted', source: 'PRB-34', path: 'docs/project/changes/CHG-12/intent.md', problem: 'Customers whose card payment fails at checkout cannot retry it — they start the order again and are sometimes charged twice.', created: '2026-10-20', reported: '2026-10-15' });
    assert.deepStrictEqual(byKey['TSK-57'], { key: 'TSK-57', kind: 'task', parent: 'CHG-12', title: 'Retry endpoint for a failed payment', status: 'done', source: null, path: 'docs/project/changes/CHG-12/plan.md', problem: null, created: null, reported: null });
    assert.strictEqual(byKey['TSK-60'], undefined, 'dropped tasks are not shown');
    assert.deepStrictEqual(errors.map((e) => e.change), ['CHG-13', 'CHG-15', 'CHG-16']);
    assert.match(errors[0].message, /intent\.md: change is CHG-14, not CHG-13/);
    assert.match(errors[1].message, /intent\.md: no YAML header/);
    assert.match(errors[2].message, /plan\.md: tasks/);
    assert.ok(!items.some((i) => i.key === 'CHG-13' || i.key === 'CHG-15'));
});

test('intentProblem: the Problem section as one line; the tf template, a missing section and comments give nothing', () => {
    assert.strictEqual(intentProblem(parseFrontMatter(INTENT).body),
        'Customers whose card payment fails at checkout cannot retry it — they start the order again and are sometimes charged twice.');
    assert.strictEqual(intentProblem('# T\n\n## Problem\n<Czyj problem, w jakiej sytuacji, skąd wiemy (zgłoszenie, dane, rozmowa).>\n\n## Warianty\n'), null);
    assert.strictEqual(intentProblem('# T\n\n## Warianty\nA\n'), null);
    assert.strictEqual(intentProblem('## problem\n<!-- note -->\nShort.\n'), 'Short.');
    assert.strictEqual(intentProblem(`## Problem\n${'x'.repeat(700)}\n`).length, 600);
});

test('workItemIssues: a change is an Epic over its tasks (subtaskKeys), tasks are Stories under it, in the Changes increment', () => {
    const { items } = buildWorkItems([{ dir: 'CHG-12', intent: INTENT, plan: PLAN }]);
    const issues = workItemIssues(items);
    const chg = issues.find((i) => i.key === 'CHG-12');
    assert.deepStrictEqual([chg.type, chg.pi, chg.subtaskKeys, chg.statusCategory, chg.status], ['Epic', CHANGES_KEY, ['TSK-57', 'TSK-58', 'TSK-59'], 'indeterminate', 'Accepted']);
    const tsk = issues.find((i) => i.key === 'TSK-58');
    assert.deepStrictEqual([tsk.type, tsk.epicKey, tsk.epicTitle, tsk.status, tsk.statusCategory, tsk.sprint, tsk.subtaskKeys, tsk.featureFlags],
        ['Story', 'CHG-12', 'Retry a failed payment without a double charge', 'In progress', 'indeterminate', null, [], []]);
    assert.strictEqual(issues.find((i) => i.key === 'TSK-57').statusCategory, 'done');
    assert.strictEqual(issues.find((i) => i.key === 'TSK-59').statusCategory, 'new');
    assert.match(chg.problem, /^Customers whose card payment fails/);
    assert.ok(!('problem' in tsk), 'tasks carry no problem of their own');
    const bare = workItemIssues(buildWorkItems([{ dir: 'CHG-13', plan: PLAN.replace('CHG-12', 'CHG-13') }]).items);
    assert.strictEqual(bare.find((i) => i.key === 'CHG-13').problem, null);
    assert.strictEqual(chg.intentCreated, '2026-10-20');
    assert.deepStrictEqual([chg.sourceKey, chg.sourceReportedAt], ['PRB-34', '2026-10-15'], 'the problem it came from and its report day');
    assert.strictEqual(buildWorkItems([{ dir: 'CHG-12', intent: INTENT.replace('source_reported_at: 2026-10-15', 'source_reported_at: 15.10.2026') }]).items[0].reported, null);
    assert.ok(!('intentCreated' in tsk));
    assert.strictEqual(bare.find((i) => i.key === 'CHG-13').intentCreated, null, 'no intent, no date');
    const odd = buildWorkItems([{ dir: 'CHG-12', intent: INTENT.replace('created: 2026-10-20', 'created: wczoraj') }]).items;
    assert.strictEqual(odd[0].created, null, 'only a RRRR-MM-DD date counts');
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const crypto = require('crypto');
const { createTestDb } = require('./helpers/test-db');
const { fakeGitHub, AUTH, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { refreshWorkItems } = require('../lib/work-items');

const sha = (n) => n.toString(16).padStart(40, 'c');
const DIR = 'docs/project/changes';
const treeOf = (files) => ({ truncated: false, tree: Object.keys(files).map((p) => ({ path: p, type: 'blob', sha: 'x' })) });

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const repo = { files: {}, trees: {}, fileCommits: {} };
    const fake = fakeGitHub({ alice: { id: 850_100_001, login: 'alice' } }, { repos: { 'acme/pay': repo } });
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
    await rows("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/pay')", [tenantId]);
    /** Puts `files` at commit `n` as the newest commit touching the changes folder. */
    const commit = (n, files) => {
        repo.files[sha(n)] = files;
        repo.trees[sha(n)] = treeOf(files);
        repo.fileCommits[DIR] = [sha(n)];
    };
    const read = () => refreshWorkItems({ pool, token: 'inst-token-1', tenantId, repo: { repoId: 1, fullName: 'acme/pay' }, fetch });
    const items = async () => (await rows('SELECT item_key, kind, parent_key, title, status FROM work_items ORDER BY item_key')).map((r) => [r.item_key, r.kind, r.parent_key, r.title, r.status]);
    const api = (url) => app.inject({ method: 'GET', url: `/api/tenants/${tenantId}${url}`, cookies: { sid: alice } });
    return { pool, app, alice, tenantId, repo, calls, rows, commit, read, items, api };
}

test('sync: changes and tasks from the default branch; unchanged folder = one request; a change replaces; a bad file is an error', async (t) => {
    const { calls, rows, commit, read, items } = await setup(t);
    commit(1, { [`${DIR}/CHG-12/intent.md`]: INTENT, [`${DIR}/CHG-12/plan.md`]: PLAN, [`${DIR}/README.md`]: '# notes' });
    assert.deepStrictEqual(await read(), { read: 4, errors: 0, plans: 0 });
    assert.deepStrictEqual(await items(), [
        ['CHG-12', 'change', null, 'Retry a failed payment without a double charge', 'accepted'],
        ['TSK-57', 'task', 'CHG-12', 'Retry endpoint for a failed payment', 'done'],
        ['TSK-58', 'task', 'CHG-12', 'Idempotency key on charges', 'in_progress'],
        ['TSK-59', 'task', 'CHG-12', 'Retry banner in the app', 'planned'],
    ]);
    assert.deepStrictEqual((await rows('SELECT work_items_ref, work_items_error FROM tracked_repos'))[0], { work_items_ref: sha(1), work_items_error: null });

    calls.length = 0;
    assert.deepStrictEqual(await read(), { read: 0, errors: 0, plans: 0, unchanged: true });
    assert.strictEqual(calls.length, 1, 'only the newest commit of the folder is asked for');
    // A folder read by an older version of the reader (before release.yaml, migration 038) is read again.
    await rows('UPDATE tracked_repos SET work_items_version = 0');
    assert.deepStrictEqual(await read(), { read: 4, errors: 0, plans: 0 });
    assert.strictEqual((await rows('SELECT work_items_version FROM tracked_repos'))[0].work_items_version, 4);
    assert.strictEqual((await rows("SELECT to_char(source_reported_at, 'YYYY-MM-DD') AS d FROM work_items WHERE item_key = 'CHG-12'"))[0].d, '2026-10-15');
    assert.strictEqual((await rows("SELECT to_char(intent_created, 'YYYY-MM-DD') AS d FROM work_items WHERE item_key = 'CHG-12'"))[0].d, '2026-10-20');
    assert.match((await rows("SELECT problem FROM work_items WHERE item_key = 'CHG-12'"))[0].problem, /^Customers whose card payment fails/);

    commit(2, { [`${DIR}/CHG-13/intent.md`]: INTENT.replace('CHG-12', 'CHG-13'), [`${DIR}/CHG-14/plan.md`]: '# no header' });
    assert.deepStrictEqual(await read(), { read: 1, errors: 1, plans: 0 });
    assert.deepStrictEqual((await items()).map((i) => i[0]), ['CHG-13'], 'the folder as it is now: CHG-12 is gone');
    assert.match((await rows('SELECT work_items_error FROM tracked_repos'))[0].work_items_error, /CHG-14\/plan\.md: no YAML header/);

    // A repo with no changes folder has no items and no error.
    commit(3, {});
    assert.deepStrictEqual(await read(), { read: 0, errors: 0, plans: 0 });
    assert.deepStrictEqual(await items(), []);
});

test('dashboard: a Changes increment without Jira; its issues; a commit naming a task counts for its change on PROD', async (t) => {
    const { pool, tenantId, commit, read, rows, api } = await setup(t);
    commit(1, { [`${DIR}/CHG-12/intent.md`]: INTENT, [`${DIR}/CHG-12/plan.md`]: PLAN });
    await read();
    await rows(`INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at, related_issues)
                VALUES ($1, 1, 1, 'prod', 'success', $2, now(), '{TSK-57}')`, [tenantId, sha(9)]);

    const data = (await api('/dashboard-data')).json();
    assert.deepStrictEqual(data.jiraIndex.pis.map((p) => [p.pi, p.kind, p.label]), [[CHANGES_KEY, 'change', 'Changes (repo)']]);
    assert.strictEqual(data.jiraIndex.currentPi, CHANGES_KEY, 'without Jira, the changes are what the dashboard opens on');
    assert.deepStrictEqual(data.issueStatusIndex['TSK-57'], { pi: CHANGES_KEY, statusCategory: 'done' });
    assert.strictEqual(data.workItemUrls['TSK-57'], `https://github.com/acme/pay/blob/${sha(1)}/${DIR}/CHG-12/plan.md`);

    const issues = (await api(`/jira-issues?pi=${encodeURIComponent(CHANGES_KEY)}`)).json();
    assert.deepStrictEqual(issues.map((i) => i.key).sort(), ['CHG-12', 'TSK-57', 'TSK-58', 'TSK-59']);
    assert.deepStrictEqual(issues.find((i) => i.key === 'CHG-12').subtaskKeys, ['TSK-57', 'TSK-58', 'TSK-59']);
    assert.match(issues.find((i) => i.key === 'CHG-12').problem, /cannot retry it/, 'the change carries its intent\'s Problem');
    assert.strictEqual(issues.find((i) => i.key === 'CHG-12').intentCreated, '2026-10-20');
    assert.strictEqual(issues.find((i) => i.key === 'CHG-12').sourceReportedAt, '2026-10-15');

    // Untracking the repo removes its items.
    await rows('DELETE FROM tracked_repos WHERE repo_id = 1');
    assert.strictEqual((await rows('SELECT count(*)::int AS n FROM work_items'))[0].n, 0);
    assert.strictEqual((await pool.query('SELECT * FROM work_items')).rows.length, 0);
});

test('RLS: work_items is invisible and unwritable without the tenant\'s scope', async (t) => {
    const { pool, tenantId, commit, read } = await setup(t);
    commit(1, { [`${DIR}/CHG-12/intent.md`]: INTENT });
    await read();
    assert.strictEqual((await pool.query('SELECT * FROM work_items')).rows.length, 0);
    assert.strictEqual((await withScope(pool, { tenantId: crypto.randomUUID() }, (c) => c.query('SELECT * FROM work_items'))).rows.length, 0);
    assert.strictEqual((await withScope(pool, { tenantId }, (c) => c.query('SELECT * FROM work_items'))).rows.length, 1);
    await assert.rejects(() => pool.query(
        "INSERT INTO work_items (tenant_id, item_key, kind, repo_id, title, path, ref) VALUES ($1, 'CHG-1', 'change', 1, 'x', 'p', 'r')", [tenantId]
    ), /row-level security/);
});
