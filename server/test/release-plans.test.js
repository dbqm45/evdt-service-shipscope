// Release plans from a repo (G1.3 repo mode, pdi contract 0.4.0): docs/project/changes/<CHG>/release.yaml, read with
// the work items (lib/work-items.js), validated by a pinned copy of the contract's schema
// (schemas/release-plan.v0.4.0.schema.json, lib/json-schema-lite.js), kept in release_plans (migration 038, RLS).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validate, KNOWN_KEYWORDS } = require('../lib/json-schema-lite');
const { parseDocumentFile, FlagFileError } = require('../lib/flag-file-parser');
const { checkReleasePlan } = require('../lib/work-items-model');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'release-plan.v0.4.0.schema.json'), 'utf8'));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'release-plan.example.json'), 'utf8'));

const YAML = `change: CHG-12
mvp:
  release: R1
  outcome: Retry a failed payment without a double charge
  metric: { name: recovered_payments, target: ">= 25%", horizon_days: 30 }
  guardrails: [double_charges = 0]
releases:
  - { id: R1, name: MVP, tasks: [TSK-57, TSK-58] }
  - { id: R2, tasks: [TSK-59] }
flags:
  - key: payment-retry
    tasks: [TSK-57, TSK-58]
    owner: PO Payments
    remove_by: 2026-12-31
    rollout:
      - { stage: internal, min_days: 3, exit: "0 critical errors" }
      - { stage: "10%", min_days: 7 }
      - { stage: "100%" }
`;

test('the pinned schema is the contract\'s 0.4.0 copy and the validator knows every keyword it uses', () => {
    assert.match(SCHEMA.title, /kontrakt 0\.4\.0/);
    const unknown = new Set();
    const walk = (schema) => {
        for (const [k, v] of Object.entries(schema)) {
            if (!KNOWN_KEYWORDS.includes(k)) unknown.add(k);
            if (k === 'properties') Object.values(v).forEach(walk);
            if (k === 'items' && typeof v === 'object') walk(v);
        }
    };
    walk(SCHEMA);
    assert.deepStrictEqual([...unknown], [], 'a keyword the validator does not enforce would let a bad file through');
});

test('validate: the contract\'s example passes; a broken plan fails with where and why', () => {
    assert.deepStrictEqual(validate(SCHEMA, EXAMPLE), []);
    const errors = (doc) => validate(SCHEMA, doc);
    assert.match(errors({ change: 'CHG-12' }).join('\n'), /releases: is required/);
    assert.match(errors({ ...EXAMPLE, releases: [] }).join('\n'), /releases: at least 1 item/);
    assert.match(errors({ ...EXAMPLE, releases: [{ id: 'MVP', tasks: [] }] }).join('\n'), /releases\[0\]\.id: does not match/);
    assert.match(errors({ ...EXAMPLE, releases: [{ id: 'R1', tasks: ['tsk-1'] }] }).join('\n'), /releases\[0\]\.tasks\[0\]: does not match/);
    assert.match(errors({ ...EXAMPLE, extra: 1 }).join('\n'), /extra: is not allowed/);
    assert.match(errors({ ...EXAMPLE, flags: [{ key: 'x', rollout: [{ stage: 'internal', min_days: -1 }] }] }).join('\n'), /flags\[0\]\.rollout\[0\]\.min_days: below 0/);
    assert.match(errors({ ...EXAMPLE, flags: [{ key: 'x', remove_by: 'end of year' }] }).join('\n'), /flags\[0\]\.remove_by: does not match/);
    assert.match(errors({ ...EXAMPLE, mvp: { release: 'R1', metric: { name: 'x' } } }).join('\n'), /mvp\.metric\.target: is required/);
    assert.match(errors([]).join('\n'), /^\(root\): is not an object/);
});

test('parseDocumentFile: YAML in the isolated thread; a broken file is an error with no value in it', async () => {
    assert.deepStrictEqual(await parseDocumentFile({ text: YAML, fileName: 'release.yaml' }), {
        change: 'CHG-12',
        mvp: { release: 'R1', outcome: 'Retry a failed payment without a double charge', metric: { name: 'recovered_payments', target: '>= 25%', horizon_days: 30 }, guardrails: ['double_charges = 0'] },
        releases: [{ id: 'R1', name: 'MVP', tasks: ['TSK-57', 'TSK-58'] }, { id: 'R2', tasks: ['TSK-59'] }],
        flags: [{ key: 'payment-retry', tasks: ['TSK-57', 'TSK-58'], owner: 'PO Payments', remove_by: '2026-12-31', rollout: [{ stage: 'internal', min_days: 3, exit: '0 critical errors' }, { stage: '10%', min_days: 7 }, { stage: '100%' }] }],
    });
    await assert.rejects(() => parseDocumentFile({ text: 'change: [unclosed\n  secret: s3cr3t', fileName: 'release.yaml' }), (err) => err instanceof FlagFileError && /release\.yaml: not valid YAML/.test(err.message) && !/s3cr3t/.test(err.message));
    await assert.rejects(() => parseDocumentFile({ text: 'x'.repeat(300 * 1024), fileName: 'release.yaml' }), /larger than/);
});

test('checkReleasePlan: valid and for its folder, else an error naming the file', () => {
    const plan = checkReleasePlan(EXAMPLE, { dir: 'CHG-12', schema: SCHEMA });
    assert.strictEqual(plan.change, 'CHG-12');
    assert.throws(() => checkReleasePlan(EXAMPLE, { dir: 'CHG-13', schema: SCHEMA }), /change is CHG-12, not CHG-13/);
    assert.throws(() => checkReleasePlan({ change: 'CHG-12' }, { dir: 'CHG-12', schema: SCHEMA }), /releases: is required/);
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

const sha = (n) => n.toString(16).padStart(40, 'd');
const DIR = 'docs/project/changes';
const PLAN_MD = '---\nartifact: plan\nchange: CHG-12\ntasks: [TSK-57, TSK-58, TSK-59]\n---\n\n- TSK-57: Retry endpoint (done)\n- TSK-58: Idempotency key (in_progress)\n- TSK-59: Retry banner (planned)\n';

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const repo = { files: {}, trees: {}, fileCommits: {} };
    const fetch = fakeGitHub({ alice: { id: 850_200_001, login: 'alice' } }, { repos: { 'acme/pay': repo } });
    const app = buildApp({ pool, auth: AUTH, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    await rows("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
    await rows("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/pay')", [tenantId]);
    const commit = (n, files) => {
        repo.files[sha(n)] = files;
        repo.trees[sha(n)] = { truncated: false, tree: Object.keys(files).map((p) => ({ path: p, type: 'blob', sha: 'x' })) };
        repo.fileCommits[DIR] = [sha(n)];
    };
    const read = () => refreshWorkItems({ pool, token: 'inst-token-1', tenantId, repo: { repoId: 1, fullName: 'acme/pay' }, fetch });
    const plans = async () => (await rows('SELECT change_key, plan FROM release_plans ORDER BY change_key')).map((r) => [r.change_key, r.plan]);
    const dashboard = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    return { pool, tenantId, rows, commit, read, plans, dashboard };
}

test('sync: release.yaml is validated and kept with the change; a bad one is a visible error, never an empty plan', async (t) => {
    const { rows, commit, read, plans, dashboard } = await setup(t);
    commit(1, { [`${DIR}/CHG-12/plan.md`]: PLAN_MD, [`${DIR}/CHG-12/release.yaml`]: YAML });
    assert.deepStrictEqual(await read(), { read: 4, errors: 0, plans: 1 });
    const [[key, plan]] = await plans();
    assert.deepStrictEqual([key, plan.mvp.release, plan.flags[0].rollout.length], ['CHG-12', 'R1', 3]);

    const { releasePlan } = await dashboard();
    assert.strictEqual(releasePlan.mode, 'repo');
    assert.deepStrictEqual(releasePlan.plans.map((p) => p.change), ['CHG-12']);
    assert.deepStrictEqual(releasePlan.lines.map((l) => [l.key, l.release, l.title, l.epicKey]), [
        ['TSK-57', 'R1', 'Retry endpoint', 'CHG-12'], ['TSK-58', 'R1', 'Idempotency key', 'CHG-12'], ['TSK-59', 'R2', 'Retry banner', 'CHG-12'],
    ], 'the plan\'s tasks with their titles from plan.md');

    commit(2, { [`${DIR}/CHG-12/plan.md`]: PLAN_MD, [`${DIR}/CHG-12/release.yaml`]: YAML.replace('id: R1, name', 'id: MVP, name') });
    assert.deepStrictEqual(await read(), { read: 4, errors: 1, plans: 0 });
    assert.deepStrictEqual(await plans(), []);
    assert.match((await rows('SELECT work_items_error FROM tracked_repos'))[0].work_items_error, /CHG-12\/release\.yaml: releases\[0\]\.id: does not match/);

    commit(3, { [`${DIR}/CHG-12/release.yaml`]: YAML.replace('change: CHG-12', 'change: CHG-99') });
    assert.deepStrictEqual(await read(), { read: 0, errors: 1, plans: 0 });
    assert.match((await rows('SELECT work_items_error FROM tracked_repos'))[0].work_items_error, /release\.yaml: change is CHG-99, not CHG-12/);

    commit(4, { [`${DIR}/CHG-12/release.yaml`]: 'releases: [unclosed' });
    assert.deepStrictEqual(await read(), { read: 0, errors: 1, plans: 0 });
    assert.match((await rows('SELECT work_items_error FROM tracked_repos'))[0].work_items_error, /release\.yaml: not valid YAML/);
});

test('RLS: release_plans is invisible and unwritable without the tenant\'s scope; untracking removes them', async (t) => {
    const { pool, tenantId, rows, commit, read } = await setup(t);
    commit(1, { [`${DIR}/CHG-12/release.yaml`]: YAML });
    await read();
    assert.strictEqual((await rows('SELECT * FROM release_plans')).length, 1);
    assert.strictEqual((await pool.query('SELECT * FROM release_plans')).rows.length, 0);
    assert.strictEqual((await withScope(pool, { tenantId: crypto.randomUUID() }, (c) => c.query('SELECT * FROM release_plans'))).rows.length, 0);
    await assert.rejects(() => pool.query("INSERT INTO release_plans (tenant_id, change_key, repo_id, plan, ref) VALUES ($1, 'CHG-1', 1, '{}', 'r')", [tenantId]), /row-level security/);
    await rows('DELETE FROM tracked_repos WHERE repo_id = 1');
    assert.strictEqual((await rows('SELECT * FROM release_plans')).length, 0);
});
