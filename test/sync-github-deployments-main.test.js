// End-to-end tests for scripts/sync-github-deployments.js main(): run as a child process with a fetch
// fixture-router preload (test/sync-harness.js) — no network, fixed clock, rate-limit sleeps collapsed.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./sync-harness');

const SCRIPT = 'scripts/sync-github-deployments.js';
const BASE = 'https://api.github.com/repos/org/app';
const NOW = '2026-10-09T12:00:00Z';

let h;

before(() => { h = createHarness('sync-gh'); });
after(() => { h.cleanup(); });

const baseEnv = (extra = {}) => ({ GITHUB_TOKEN: 'tok', APP_REPO: 'org/app', COMPONENT: 'comp', ...extra });

const dep = (id, environment, extra = {}) => ({
    id, environment, sha: `s${id}`, ref: 'main', created_at: '2026-10-08T09:00:00Z',
    creator: { login: 'alice' }, ...extra,
});

const status = (state, created_at, log_url) => ({ state, created_at, ...(log_url ? { log_url } : {}) });

const listRoutes = (deployments, tags = [], releases = [], extra = {}) => [
    { exact: `${BASE}/deployments?per_page=100&page=1`, body: deployments, ...extra },
    { exact: `${BASE}/deployments?per_page=100&page=2`, body: [] },
    { exact: `${BASE}/tags?per_page=100&page=1`, body: tags },
    { exact: `${BASE}/tags?per_page=100&page=2`, body: [] },
    { exact: `${BASE}/releases?per_page=100&page=1`, body: releases },
    { exact: `${BASE}/releases?per_page=100&page=2`, body: [] },
];

const D = 'docs/data/deployments.json';
const C = 'docs/data/deployments-cursor.json';
const S = 'docs/data/summary.json';
const I = 'docs/data/issue-deployments.json';

describe('startup validation', () => {
    for (const [name, env, msg] of [
        ['GITHUB_TOKEN', { GITHUB_TOKEN: '' }, 'Missing GITHUB_TOKEN'],
        ['APP_REPO', { APP_REPO: '' }, 'Missing APP_REPO'],
        ['COMPONENT', { COMPONENT: '' }, 'Missing COMPONENT'],
        ['unsafe DATA_PATH', { DATA_PATH: '../escape.json' }, 'not a safe relative path'],
    ]) {
        test(`exits non-zero when ${name} is missing/unsafe`, () => {
            const ws = h.workspace();
            const r = h.run(SCRIPT, ws, { env: baseEnv(env) });

            assert.equal(r.status, 1);
            assert.match(r.out, new RegExp(msg));
            assert.equal(r.calls.length, 0);
        });
    }
});

describe('full sync', () => {
    const dep1 = dep(1, 'test', { creator: { login: 'alice' } });
    const dep2 = dep(2, 'qa', { creator: { login: 'bob' } });
    const routes = () => [
        { exact: `${BASE}/deployments/1/statuses?per_page=10`, body: [
            status('success', '2026-10-08T10:00:00Z', 'https://github.com/org/app/actions/runs/111'),
            status('in_progress', '2026-10-08T09:59:00Z'),
        ] },
        { exact: `${BASE}/deployments/2/statuses?per_page=10`, body: [
            status('inactive', '2026-10-08T12:00:00Z'),
            status('success', '2026-10-08T11:00:00Z', 'https://github.com/org/app/actions/runs/222'),
            status('queued', '2026-10-08T10:50:00Z'),
        ] },
        { exact: `${BASE}/commits/s1`, body: { commit: { message: 'feat(x): EVP-1 add thing' } } },
        { exact: `${BASE}/commits/s2`, body: { commit: { message: 'fix: EVP-2 release 1.2.3' } } },
        { exact: `${BASE}/actions/runs/111`, body: { event: 'workflow_dispatch' } },
        { exact: `${BASE}/actions/runs/222`, body: { event: 'push' } },
        { exact: 'https://api.github.com/users/alice', body: { name: 'Alice A' } },
        { exact: 'https://api.github.com/users/bob', status: 404, text: 'nope' },
        { exact: `${BASE}/compare/s2...v0.1.0`, body: { ahead_by: 2, behind_by: 1, commits: [] } },
        ...listRoutes(
            [dep2, dep1],
            [{ name: 'v0.1.0', commit: { sha: 's1' } }],
            [{ tag_name: 'v0.1.0' }, { tag_name: 'v-unknown' }],
            { etag: '"dep-etag"' }
        ),
    ];

    test('resolves records, drift, summary, cursor, issue history; second run is a byte-identical no-op', () => {
        const ws = h.workspace();
        const etagDir = path.join(ws.dir, 'etags');
        const env = baseEnv({ GITHUB_API_ETAG_CACHE_DIR: etagDir });
        const r1 = h.run(SCRIPT, ws, { env, routes: routes() });

        assert.equal(r1.status, 0, r1.out);
        assert.match(r1.out, /2 new, 2 processed this run/);
        assert.match(r1.out, /2 deployment record\(s\) recorded this run\./);

        const deployments = h.readJson(ws, D);
        const byId = Object.fromEntries(deployments.map(d => [d.id, d]));

        assert.equal(byId['gh-1'].version, 'v0.1.0');
        assert.equal(byId['gh-1'].manual, true);
        assert.equal(byId['gh-1'].deployedBy, 'Alice A');
        assert.equal(byId['gh-1'].deployedByLogin, 'alice');
        assert.deepEqual(byId['gh-1'].relatedIssues, ['EVP-1']);
        assert.deepEqual(byId['gh-1'].issueCommitTypes, { 'EVP-1': 'feat' });
        assert.equal(byId['gh-1'].commitUrl, 'https://github.com/org/app/commit/s1');
        assert.equal(byId['gh-1'].workflowRunUrl, 'https://github.com/org/app/actions/runs/111');
        assert.equal(byId['gh-1'].durationMs, 60000);
        assert.equal(byId['gh-2'].version, '1.2.3');
        assert.equal(byId['gh-2'].manual, false);
        assert.equal(byId['gh-2'].deployedBy, 'bob');
        assert.equal(byId['gh-2'].status, 'success');
        assert.equal(byId['gh-2'].durationMs, 600000);
        assert.deepEqual(byId['gh-2'].driftBehind, {
            behindEnv: 'test', commitCount: 2, untestedIn: 'test', untestedCommitCount: 1, diff: { unknown: true },
        });
        assert.equal(h.readJson(ws, C).comp, 2);
        assert.equal(h.readJson(ws, S).components.comp.test.current.id, 'gh-1');
        assert.equal(h.readJson(ws, S).components.comp.qa.latestOverall.id, 'gh-2');
        assert.deepEqual(Object.keys(h.readJson(ws, I)).sort(), ['EVP-1', 'EVP-2']);
        assert.equal(h.readJson(ws, I)['EVP-1'].test.comp.deployedAt, '2026-10-08T10:00:00Z');
        assert.ok(fs.existsSync(path.join(etagDir, 'shipscope-etags-comp.json')));

        const before = ['D', 'C', 'S', 'I'].map(k => fs.readFileSync(path.join(ws.dir, { D, C, S, I }[k]), 'utf8'));
        // Second run, fresh RUNNER_TEMP (no retry cache) but persisted ETag cache.
        const tmp2 = path.join(ws.dir, 'tmp2');

        fs.mkdirSync(tmp2);

        const r2 = h.run(SCRIPT, ws, { env: { ...env, RUNNER_TEMP: tmp2 }, routes: routes() });

        assert.equal(r2.status, 0, r2.out);
        assert.match(r2.out, /0 new, 0 processed this run/);
        assert.match(r2.out, /0 deployment record\(s\) recorded this run\./);

        const depCall = r2.calls.find(c => c.url.includes('/deployments?per_page=100&page=1'));

        assert.equal(depCall.headers['If-None-Match'], '"dep-etag"');
        assert.ok(!r2.calls.some(c => c.url.includes('/tags')));
        assert.deepEqual(['D', 'C', 'S', 'I'].map(k => fs.readFileSync(path.join(ws.dir, { D, C, S, I }[k]), 'utf8')), before);
    });

    test('a second invocation in the same job reuses the retry cache and does not re-fetch the lists', () => {
        const ws = h.workspace();
        const r1 = h.run(SCRIPT, ws, { env: baseEnv(), routes: routes() });

        assert.equal(r1.status, 0, r1.out);

        const first = fs.readFileSync(path.join(ws.dir, D), 'utf8');
        const r2 = h.run(SCRIPT, ws, { env: baseEnv(), routes: routes() });

        assert.equal(r2.status, 0, r2.out);
        assert.match(r2.out, /Reusing cached result/);
        assert.ok(!r2.calls.some(c => c.url.includes('/deployments')));
        // Only the drift check's tree lookups (refs already on live) may hit /commits/ — no per-deployment resolution.
        assert.deepEqual(r2.calls.filter(c => c.url.includes('/commits/')).map(c => c.url.split('/commits/')[1]).sort(), ['s2', 'v0.1.0']);
        assert.equal(fs.readFileSync(path.join(ws.dir, D), 'utf8'), first);
        assert.match(r2.out, /already present from a concurrent run|0 deployment record\(s\)/);
    });

    test('records already on live (concurrent run) are skipped, not double-added', () => {
        const ws = h.workspace();
        const seeded = { id: 'gh-1', component: 'comp', environment: 'test', status: 'success', version: 'x', deployedAt: '2026-10-08T10:00:00Z', relatedIssues: [] };

        h.writeJson(ws, D, [seeded]);

        const r = h.run(SCRIPT, ws, { env: baseEnv(), routes: routes() });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /1 deployment record\(s\) recorded this run \(1 already present from a concurrent run, skipped\)\./);
        assert.equal(h.readJson(ws, D).filter(d => d.id === 'gh-1').length, 1);
    });
});

describe('plan edge cases', () => {
    test('drops untracked envs, holds the cursor below a blocked deployment, skips a stuck one, handles failure + inactive', () => {
        const ws = h.workspace();
        const deployments = [
            dep(14, 'preprod'),
            dep(13, 'dev', { creator: null }),
            dep(12, 'qa', { created_at: '2026-09-01T00:00:00Z' }),
            dep(11, 'production'),
            dep(10, 'staging'),
        ];
        const routes = [
            { exact: `${BASE}/deployments/13/statuses?per_page=10`, body: [
                status('inactive', '2026-10-08T12:00:00Z'),
                status('failure', '2026-10-08T10:02:00Z', 'https://github.com/org/app/not-a-run'),
                status('queued', '2026-10-08T10:00:00Z'),
            ] },
            { exact: `${BASE}/deployments/12/statuses?per_page=10`, body: [status('queued', '2026-09-01T00:00:00Z')] },
            { exact: `${BASE}/deployments/11/statuses?per_page=10`, body: [] },
            { exact: `${BASE}/deployments/10/statuses?per_page=10`, body: [status('success', '2026-10-08T10:00:00Z')] },
            { exact: `${BASE}/deployments/14/statuses?per_page=10`, body: [status('success', '2026-10-08T10:00:00Z')] },
            { exact: `${BASE}/commits/s13`, body: { commit: { message: 'chore: EVP-13 tidy' } } },
            ...listRoutes(deployments),
        ];
        const r = h.run(SCRIPT, ws, { env: baseEnv(), routes });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /environment "staging", which ShipScope doesn't track/);
        assert.match(r.out, /environment "preprod", which ShipScope doesn't track/);
        assert.match(r.out, /::warning::Deployment 12 .* permanently skipping/);

        const recs = h.readJson(ws, D);

        assert.deepEqual(recs.map(x => x.id), ['gh-13']);
        assert.equal(recs[0].status, 'failed');
        assert.equal(recs[0].environment, 'test');
        assert.equal(recs[0].deployedBy, 'unknown');
        assert.equal(recs[0].durationMs, 120000);
        assert.equal(recs[0].manual, false);
        assert.deepEqual(recs[0].issueCommitTypes, { 'EVP-13': 'chore' });
        // Blocked id 11 caps the cursor at 10 even though 13 was processed.
        assert.equal(h.readJson(ws, C).comp, 10);
        // A failed deploy is never "current".
        assert.equal(h.readJson(ws, S).components.comp.test.current, null);
        assert.equal(h.readJson(ws, S).components.comp.test.latestOverall.id, 'gh-13');
        assert.ok(!h.exists(ws, I) || Object.keys(h.readJson(ws, I)).length === 0);
    });

    test('caps new deployments per run (oldest first), paginates, and stops at the cursor', () => {
        const ws = h.workspace();
        const page1 = Array.from({ length: 100 }, (_, i) => dep(200 - i, 'test'));
        const page2 = Array.from({ length: 100 }, (_, i) => dep(100 - i, 'test'));
        const routes = [
            { re: `/deployments/(\\d+)/statuses`, body: [{ state: 'success', created_at: '2026-10-08T10:00:00Z' }] },
            { re: `/commits/s(\\d+)`, body: { commit: { message: 'fix: EVP-{$1} thing' } } },
            { re: `/compare/s(\\d+)\\.\\.\\.s(\\d+)`, body: { status: 'ahead', total_commits: 1, commits: [{ commit: { message: 'feat: EVP-{$2} y' } }] } },
            { exact: `${BASE}/deployments?per_page=100&page=1`, body: page1 },
            { exact: `${BASE}/deployments?per_page=100&page=2`, body: page2 },
            { exact: `${BASE}/deployments?per_page=100&page=3`, body: [] },
            { exact: `${BASE}/tags?per_page=100&page=1`, body: [] },
            { exact: `${BASE}/releases?per_page=100&page=1`, body: [] },
        ];
        const r = h.run(SCRIPT, ws, { env: baseEnv({ MAX_NEW_DEPLOYMENTS_PER_RUN: '3' }), routes });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /::warning::200 new deployment\(s\) found .* only processing the oldest 3/);
        assert.deepEqual(h.readJson(ws, D).map(x => x.id).sort(), ['gh-1', 'gh-2', 'gh-3']);
        assert.equal(h.readJson(ws, C).comp, 3);

        // Next run with the cursor at 150: pagination stops after page 1 (it already contains ids <= cursor).
        const ws2 = h.workspace();

        h.writeJson(ws2, C, { comp: 150 });

        const r2 = h.run(SCRIPT, ws2, { env: baseEnv({ MAX_NEW_DEPLOYMENTS_PER_RUN: '2' }), routes });

        assert.equal(r2.status, 0, r2.out);
        assert.ok(!r2.calls.some(c => c.url.includes('page=2')));
        assert.deepEqual(h.readJson(ws2, D).map(x => x.id).sort(), ['gh-151', 'gh-152']);
        assert.equal(h.readJson(ws2, C).comp, 152);
    });
});

describe('range resolution', () => {
    test('rollback, duplicate-release range reuse, truncated compare warning, and compare-failure fallbacks', () => {
        const ws = h.workspace();
        const existing = [{
            id: 'gh-5', component: 'comp', environment: 'prod', status: 'success', version: 'sOld', resolvedRef: 'sOld',
            deployedAt: '2026-10-01T00:00:00Z', relatedIssues: ['EVP-0'], issueCommitTypes: {}, commitUrl: 'u',
        }, {
            id: 'gh-6', component: 'comp', environment: 'qa', status: 'failed', version: 'q', deployedAt: '2026-10-01T00:00:00Z',
        }, {
            id: 'gh-7', component: 'other', environment: 'prod', status: 'success', version: 'o', deployedAt: '2026-10-01T00:00:00Z',
        }];

        h.writeJson(ws, D, existing);
        h.writeJson(ws, C, { comp: 5 });

        const deployments = [dep(23, 'qa'), dep(22, 'prod', { sha: 'sNew' }), dep(21, 'prod', { sha: 'sNew' }), dep(20, 'test')];
        const routes = [
            { exact: `${BASE}/deployments/20/statuses?per_page=10`, body: [status('success', '2026-10-09T01:00:00Z', 'https://github.com/org/app/actions/runs/900')] },
            { exact: `${BASE}/deployments/21/statuses?per_page=10`, body: [status('success', '2026-10-09T02:00:00Z', 'https://github.com/org/app/actions/runs/900')] },
            { exact: `${BASE}/deployments/22/statuses?per_page=10`, body: [status('success', '2026-10-09T03:00:00Z')] },
            { exact: `${BASE}/deployments/23/statuses?per_page=10`, body: [status('success', '2026-10-09T04:00:00Z')] },
            { exact: `${BASE}/commits/s20`, status: 500, text: 'boom' },
            { exact: `${BASE}/commits/sNew`, body: { commit: { message: 'release' } } },
            { exact: `${BASE}/commits/s23`, body: {} },
            { exact: `${BASE}/compare/sOld...sNew`, body: {
                status: 'behind', total_commits: 300, commits: [{ commit: { message: 'fix(a): EVP-9 x' } }, { commit: {} }],
            } },
            { exact: `${BASE}/actions/runs/900`, status: 403, text: 'forbidden' },
            // Drift compare: qa (s23) vs test (none resolved -> skipped); prod (sNew) vs qa (s23) fails.
            { exact: `${BASE}/compare/sNew...s23`, status: 500, text: 'down' },
            { exact: 'https://api.github.com/users/alice', throw: 'network down' },
            ...listRoutes(deployments),
        ];
        const r = h.run(SCRIPT, ws, { env: baseEnv({ SIZE_WARNING_THRESHOLD_MB: '0' }), routes });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /could not determine commit range for deployment 20/);
        assert.match(r.out, /::warning::Compare sOld\.\.\.sNew has 300 commits but GitHub only returned 2/);
        assert.match(r.out, /could not determine trigger type for run 900/);
        assert.match(r.out, /could not resolve display name for "alice"/);
        assert.match(r.out, /could not compute drift for prod vs qa/);
        assert.match(r.out, /::warning::docs.data.deployments\.json is now/);

        const byId = Object.fromEntries(h.readJson(ws, D).map(x => [x.id, x]));

        assert.deepEqual(byId['gh-21'].rollback, { toRef: 'sOld' });
        assert.equal(byId['gh-21'].commitUrl, 'https://github.com/org/app/compare/sOld...sNew');
        assert.deepEqual(byId['gh-21'].relatedIssues, ['EVP-9']);
        // gh-22 is the same ref as gh-21: range reused instead of collapsing to an empty self-compare.
        assert.deepEqual(byId['gh-22'].rollback, { toRef: 'sOld' });
        assert.equal(byId['gh-22'].commitUrl, 'https://github.com/org/app/compare/sOld...sNew');
        assert.deepEqual(byId['gh-22'].relatedIssues, ['EVP-9']);
        assert.equal(byId['gh-20'].relatedIssues.length, 0);
        assert.equal(byId['gh-20'].manual, false);
        assert.equal(byId['gh-20'].deployedBy, 'alice');
        assert.equal(byId['gh-23'].version, 's23');
        assert.ok(!('driftBehind' in byId['gh-22']));
        assert.equal(h.readJson(ws, C).comp, 23);
    });

    test('drift between envs with the same version label but different commits is flagged sameVersion', () => {
        const mk = (laterVersion) => {
            const ws = h.workspace();

            h.writeJson(ws, D, [
                { id: 'gh-1', component: 'comp', environment: 'qa', status: 'success', version: 'v1.4.19', resolvedRef: 'a', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [] },
                { id: 'gh-2', component: 'comp', environment: 'prod', status: 'success', version: laterVersion, resolvedRef: 'b', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [] },
            ]);
            h.writeJson(ws, C, { comp: 2 });

            const r = h.run(SCRIPT, ws, { env: baseEnv(), routes: [...listRoutes([]), { exact: `${BASE}/compare/b...a`, body: { ahead_by: 417, behind_by: 325, commits: [] } }] });

            assert.equal(r.status, 0, r.out);

            return h.readJson(ws, D).find(x => x.id === 'gh-2').driftBehind;
        };

        assert.deepEqual(mk('v1.4.19'), { behindEnv: 'qa', commitCount: 417, untestedIn: 'qa', untestedCommitCount: 325, sameVersion: true, diff: { unknown: true } });
        assert.ok(!('sameVersion' in mk('v1.4.20')));
    });

    describe('tree comparison', () => {
        const blob = (p, sha) => ({ path: p, type: 'blob', sha });
        const mk = ({ treeA, treeB, listA, listB, ignore, env = {} }) => {
            const ws = h.workspace();

            h.writeJson(ws, D, [
                { id: 'gh-1', component: 'comp', environment: 'qa', status: 'success', version: 'v1.4.19', resolvedRef: 'a', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [] },
                { id: 'gh-2', component: 'comp', environment: 'prod', status: 'success', version: 'v1.4.19', resolvedRef: 'b', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [], driftBehind: { behindEnv: 'qa', commitCount: 1 } },
            ]);
            h.writeJson(ws, C, { comp: 2 });

            const routes = [...listRoutes([]), { exact: `${BASE}/compare/b...a`, body: { ahead_by: 417, behind_by: 325, commits: [] } }];

            if (treeA) routes.push({ exact: `${BASE}/commits/a`, body: { commit: { tree: { sha: treeA } } } });
            if (treeB) routes.push({ exact: `${BASE}/commits/b`, body: { commit: { tree: { sha: treeB } } } });
            if (listA) routes.push({ exact: `${BASE}/git/trees/${treeA}?recursive=1`, ...listA });
            if (listB) routes.push({ exact: `${BASE}/git/trees/${treeB}?recursive=1`, ...listB });

            const r = h.run(SCRIPT, ws, { env: baseEnv({ ...(ignore ? { DRIFT_IGNORE_PATHS: JSON.stringify(ignore) } : {}), ...env }), routes });

            return { r, drift: h.readJson(ws, D).find(x => x.id === 'gh-2').driftBehind };
        };

        test('an identical git tree reports no drift even though the histories diverged', () => {
            const { r, drift } = mk({ treeA: 't1', treeB: 't1' });

            assert.equal(r.status, 0, r.out);
            assert.equal(drift, undefined);
        });

        test('a real file difference is recorded as diff.files/paths alongside the raw history counts', () => {
            const { r, drift } = mk({
                treeA: 't1', treeB: 't2',
                listA: { body: { tree: [blob('a.js', '1'), blob('same.js', '5')] } },
                listB: { body: { tree: [blob('a.js', '2'), blob('same.js', '5'), blob('README.md', '7')] } },
            });

            assert.equal(r.status, 0, r.out);
            assert.deepEqual(drift, {
                behindEnv: 'qa', commitCount: 417, untestedIn: 'qa', untestedCommitCount: 325, sameVersion: true,
                diff: { files: 2, paths: ['README.md', 'a.js'], ignored: 0 },
            });
        });

        test('differences only in ignored paths mean no drift; mixed ones count the rest and report ignored', () => {
            const lists = (extra) => ({
                treeA: 't1', treeB: 't2',
                listA: { body: { tree: [blob('.github/ci.yml', '1'), blob('README.md', '1')] } },
                listB: { body: { tree: [blob('.github/ci.yml', '2'), blob('README.md', '2'), ...extra] } },
                ignore: ['.github/', 'README.md'],
            });

            assert.equal(mk(lists([])).drift, undefined);
            assert.deepEqual(mk(lists([blob('src/x.js', '3')])).drift.diff, { files: 1, paths: ['src/x.js'], ignored: 2 });
        });

        test('missing tree SHA, failed or truncated tree listing give diff.unknown (never "no difference")', () => {
            assert.deepEqual(mk({ treeA: 't1', treeB: null }).drift.diff, { unknown: true });
            assert.deepEqual(mk({ treeA: 't1', treeB: 't2', listA: { status: 500, text: 'x' }, listB: { body: { tree: [] } } }).drift.diff, { unknown: true });
            assert.deepEqual(mk({
                treeA: 't1', treeB: 't2',
                listA: { body: { tree: [blob('a', '1')], truncated: true } },
                listB: { body: { tree: [blob('a', '1')] } },
            }).drift.diff, { unknown: true });
        });

        test('an invalid DRIFT_IGNORE_PATHS fails the run before any API call', () => {
            const ws = h.workspace();
            const r = h.run(SCRIPT, ws, { env: baseEnv({ DRIFT_IGNORE_PATHS: '{"a":1}' }) });

            assert.equal(r.status, 1);
            assert.match(r.out, /DRIFT_IGNORE_PATHS/);
            assert.equal(r.calls.length, 0);
        });
    });

    describe('VERSION_FILE (deployment-branch trigger commits)', () => {
        const run = (fileRoute, env = { VERSION_FILE: 'trigger.properties' }) => {
            const ws = h.workspace();
            const routes = [
                ...listRoutes([dep(5, 'qa')], [{ name: 'v0.0.702', commit: { sha: 'real1' } }]),
                { exact: `${BASE}/deployments/5/statuses?per_page=10`, body: [status('success', '2026-10-08T10:00:00Z')] },
                { exact: `${BASE}/commits/s5`, body: { commit: { message: '[NO-ISSUE] v.0.0.702 - QA' } } },
                { exact: `${BASE}/commits/v0.0.702`, body: { commit: { message: 'feat: EVP-7 real change' } } },
                { exact: `${BASE}/commits/v0.0.9`, body: { sha: 'abc123', commit: { message: 'fix: EVP-8 untagged' } } },
                { exact: `${BASE}/commits/abc123`, body: { commit: { message: 'fix: EVP-8 untagged' } } },
                { exact: 'https://api.github.com/users/alice', body: { name: 'Alice A' } },
                ...fileRoute,
            ];
            const r = h.run(SCRIPT, ws, { env: baseEnv(env), routes });

            assert.equal(r.status, 0, r.out);

            return h.readJson(ws, D).find(x => x.id === 'gh-5');
        };
        const file = (body) => [{
            exact: `${BASE}/contents/trigger.properties?ref=s5`,
            body: { content: Buffer.from(body).toString('base64') },
        }];

        test('uses the ref named in the file (tag) for version, ref and issues instead of the trigger SHA', () => {
            const rec = run(file('# deploy\nversion=v0.0.702\n'));

            assert.equal(rec.version, 'v0.0.702');
            assert.equal(rec.resolvedRef, 'v0.0.702');
            assert.deepEqual(rec.relatedIssues, ['EVP-7']);
        });

        test('a non-tag ref is resolved to its commit SHA', () => {
            const rec = run(file('version=v0.0.9'));

            assert.equal(rec.version, 'v0.0.9');
            assert.equal(rec.resolvedRef, 'abc123');
            assert.deepEqual(rec.relatedIssues, ['EVP-8']);
        });

        test('missing file or ref falls back to the deployment commit', () => {
            for (const route of [
                [{ exact: `${BASE}/contents/trigger.properties?ref=s5`, status: 404, text: 'nope' }],
                file('nothing=here'),
                file('version=ghost'),
            ]) {
                const rec = run(route);

                assert.equal(rec.resolvedRef, 's5');
                assert.deepEqual(rec.relatedIssues, []);
            }
        });

        test('drift of legacy records (trigger SHAs) is computed from the refs their version files name', () => {
            const mk = (qaVersion, prodVersion, extraRoutes) => {
                const ws = h.workspace();

                h.writeJson(ws, D, [
                    { id: 'gh-1', component: 'comp', environment: 'qa', status: 'success', version: 'x', resolvedRef: 'q1', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [] },
                    { id: 'gh-2', component: 'comp', environment: 'prod', status: 'success', version: 'y', resolvedRef: 'p1', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [], driftBehind: { behindEnv: 'qa', commitCount: 95 } },
                ]);
                h.writeJson(ws, C, { comp: 2 });

                const routes = [
                    ...listRoutes([]),
                    { exact: `${BASE}/contents/trigger.properties?ref=q1`, body: { content: Buffer.from(`version=${qaVersion}`).toString('base64') } },
                    { exact: `${BASE}/contents/trigger.properties?ref=p1`, body: { content: Buffer.from(`version=${prodVersion}`).toString('base64') } },
                    { exact: `${BASE}/commits/v1`, body: { sha: 'new' } },
                    { exact: `${BASE}/commits/v0`, body: { sha: 'old' } },
                    ...extraRoutes,
                ];
                const r = h.run(SCRIPT, ws, { env: baseEnv({ VERSION_FILE: 'trigger.properties' }), routes });

                assert.equal(r.status, 0, r.out);

                return h.readJson(ws, D).find(x => x.id === 'gh-2').driftBehind;
            };

            assert.equal(mk('v1', 'v1', []), undefined);
            assert.deepEqual(
                mk('v1', 'v0', [{ exact: `${BASE}/compare/old...new`, body: { ahead_by: 3, behind_by: 0, commits: [] } }]),
                { behindEnv: 'qa', commitCount: 3, diff: { unknown: true } }
            );
        });

        test('without VERSION_FILE the file is never read', () => {
            const rec = run(file('version=v0.0.702'), {});

            assert.equal(rec.resolvedRef, 's5');
        });
    });

    test('a previously-detected drift survives a failed compare but is cleared by a clean one', () => {
        const mk = (compare) => {
            const ws = h.workspace();

            h.writeJson(ws, D, [
                { id: 'gh-1', component: 'comp', environment: 'qa', status: 'success', version: 'a', resolvedRef: 'a', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [] },
                { id: 'gh-2', component: 'comp', environment: 'prod', status: 'success', version: 'b', resolvedRef: 'b', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [], driftBehind: { behindEnv: 'qa', commitCount: 4 } },
            ]);
            h.writeJson(ws, C, { comp: 2 });

            const r = h.run(SCRIPT, ws, { env: baseEnv(), routes: [...listRoutes([]), { exact: `${BASE}/compare/b...a`, ...compare }] });

            assert.equal(r.status, 0, r.out);

            return h.readJson(ws, D).find(x => x.id === 'gh-2');
        };

        assert.deepEqual(mk({ status: 500, text: 'x' }).driftBehind, { behindEnv: 'qa', commitCount: 4 });
        assert.ok(!('driftBehind' in mk({ body: { ahead_by: 0, behind_by: 0 } })));
    });

    test('manual-run lookups are capped at 30 per run', () => {
        const ws = h.workspace();
        const deployments = Array.from({ length: 32 }, (_, i) => dep(32 - i, 'test'));
        const routes = [
            { re: `/deployments/(\\d+)/statuses`, body: [{ state: 'success', created_at: '2026-10-08T10:00:00Z', log_url: 'https://github.com/org/app/actions/runs/{$1}' }] },
            { re: `/commits/s(\\d+)`, body: { commit: { message: 'x' } } },
            { re: `/compare/`, body: { status: 'ahead', commits: [] } },
            { re: `/actions/runs/(\\d+)`, body: { event: 'workflow_dispatch' } },
            ...listRoutes(deployments),
        ];
        const r = h.run(SCRIPT, ws, { env: baseEnv(), routes });

        assert.equal(r.status, 0, r.out);
        assert.equal(r.calls.filter(c => c.url.includes('/actions/runs/')).length, 30);

        const recs = h.readJson(ws, D);

        assert.equal(recs.filter(x => x.manual === true).length, 30);
        assert.equal(recs.filter(x => x.manual === null || x.manual === false).length, 2);
    });
});

describe('retention', () => {
    test('trims old records but keeps latest-overall and latest-successful per component/env', () => {
        const ws = h.workspace();
        const rec = (id, component, environment, st, deployedAt) => ({ id, component, environment, status: st, version: id, deployedAt, relatedIssues: [] });

        h.writeJson(ws, D, [
            rec('a-old-ok', 'comp', 'prod', 'success', '2026-01-01T00:00:00Z'),
            rec('a-old-ok2', 'comp', 'prod', 'success', '2026-01-02T00:00:00Z'),
            rec('a-old-fail', 'comp', 'prod', 'failed', '2026-01-03T00:00:00Z'),
            rec('b-old', 'other', 'qa', 'success', '2026-01-01T00:00:00Z'),
            rec('b-old2', 'other', 'qa', 'success', '2026-01-05T00:00:00Z'),
            rec('b-new', 'other', 'qa', 'success', '2026-10-05T00:00:00Z'),
        ]);
        h.writeJson(ws, C, { comp: 99 });

        const r = h.run(SCRIPT, ws, { env: baseEnv({ RETENTION_DAYS: '30' }), routes: listRoutes([]) });

        assert.equal(r.status, 0, r.out);
        assert.deepEqual(h.readJson(ws, D).map(x => x.id).sort(), ['a-old-fail', 'a-old-ok2', 'b-new']);
        assert.equal(h.readJson(ws, S).components.comp.prod.current.id, 'a-old-ok2');
        assert.equal(h.readJson(ws, S).components.comp.prod.latestOverall.id, 'a-old-fail');
        // Backfills the never-trimmed history from the full current set.
        assert.equal(h.readJson(ws, C).comp, 99);
    });
});

describe('API resilience', () => {
    const oneDep = (extra = []) => [
        { exact: `${BASE}/deployments/1/statuses?per_page=10`, body: [status('success', '2026-10-08T10:00:00Z')] },
        { exact: `${BASE}/commits/s1`, body: { commit: { message: 'fix: EVP-1 y' } } },
        ...extra,
        ...listRoutes([dep(1, 'test')]),
    ];

    test('retries a 429 (retry-after), a primary 403 (reset header) and a bare-limit 403, then succeeds', () => {
        const ws = h.workspace();
        const reset = String(Math.floor(Date.parse(NOW) / 1000) + 5);
        const r = h.run(SCRIPT, ws, {
            env: baseEnv(),
            routes: [
                { exact: `${BASE}/deployments/1/statuses?per_page=10`, seq: [
                    { status: 429, headers: { 'retry-after': '1' }, text: 'slow down' },
                    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, text: 'limit' },
                    { status: 429, text: 'no headers' },
                    { body: [status('success', '2026-10-08T10:00:00Z')] },
                ] },
                { exact: `${BASE}/commits/s1`, body: { commit: { message: 'fix: EVP-1 y' } } },
                ...listRoutes([dep(1, 'test')]),
            ],
        });

        assert.equal(r.status, 0, r.out);
        assert.equal((r.out.match(/Rate limited on/g) || []).length, 3);
        assert.match(r.out, /waiting 1s before retry 2\/4/);
        assert.match(r.out, /waiting 30s before retry 4\/4/);
        assert.equal(h.readJson(ws, D).length, 1);
    });

    test('a secondary-limit 403 (retry-after only) is retried, a plain 403 is not', () => {
        const ws = h.workspace();
        const ok = h.run(SCRIPT, ws, {
            env: baseEnv(),
            routes: oneDep([]).map(rt => rt.exact && rt.exact.includes('/statuses')
                ? { ...rt, body: undefined, seq: [{ status: 403, headers: { 'retry-after': '2' }, text: 'secondary' }, { body: [status('success', '2026-10-08T10:00:00Z')] }] }
                : rt),
        });

        assert.equal(ok.status, 0, ok.out);
        assert.match(ok.out, /Rate limited on/);

        const ws2 = h.workspace();
        const bad = h.run(SCRIPT, ws2, {
            env: baseEnv(),
            routes: oneDep([]).map(rt => rt.exact && rt.exact.includes('/statuses') ? { exact: rt.exact, status: 403, text: 'forbidden' } : rt),
        });

        assert.equal(bad.status, 1);
        assert.match(bad.out, /GitHub API error on .*statuses.*403 forbidden/);
        assert.ok(!h.exists(ws2, D));
    });

    test('gives up after 4 rate-limited attempts and leaves live data untouched', () => {
        const ws = h.workspace();
        const r = h.run(SCRIPT, ws, {
            env: baseEnv(),
            routes: [{ exact: `${BASE}/deployments?per_page=100&page=1`, status: 429, headers: { 'retry-after': '1' }, text: 'x' }],
        });

        assert.equal(r.status, 1);
        assert.equal((r.out.match(/Rate limited on/g) || []).length, 3);
        assert.match(r.out, /GitHub API error/);
        assert.ok(!h.exists(ws, D));
    });

    test('unreadable page cache / ETag cache are ignored with a warning; partial page cache is resumed and deduped', () => {
        const ws = h.workspace();
        const etagDir = path.join(ws.dir, 'etags');

        fs.mkdirSync(etagDir);
        fs.writeFileSync(path.join(etagDir, 'shipscope-etags-comp.json'), '{not json');
        fs.writeFileSync(path.join(ws.runnerTemp, 'shipscope-pages-deployments-comp.json'), JSON.stringify([dep(1, 'test')]));

        const r = h.run(SCRIPT, ws, { env: baseEnv({ GITHUB_API_ETAG_CACHE_DIR: etagDir }), routes: oneDep() });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /could not read ETag cache/);
        assert.match(r.out, /Resuming "\/deployments\?per_page=100" from page 1 \(1 record\(s\) already fetched/);
        assert.equal(h.readJson(ws, D).length, 1);

        const ws2 = h.workspace();

        fs.writeFileSync(path.join(ws2.runnerTemp, 'shipscope-pages-deployments-comp.json'), '{broken');

        const r2 = h.run(SCRIPT, ws2, { env: baseEnv(), routes: oneDep() });

        assert.match(r2.out, /ignoring unreadable page cache/);
        assert.equal(h.readJson(ws2, D).length, 1);

        const ws3 = h.workspace();

        fs.writeFileSync(path.join(ws3.runnerTemp, 'shipscope-pages-deployments-comp.json'), '{"a":1}');

        const r3 = h.run(SCRIPT, ws3, { env: baseEnv(), routes: oneDep() });

        assert.equal(r3.status, 0, r3.out);
        assert.doesNotMatch(r3.out, /Resuming/);
    });

    test('an ETag-less response drops the cached entry; a corrupt retry cache is recomputed', () => {
        const ws = h.workspace();
        const etagDir = path.join(ws.dir, 'etags');
        const routes = [
            { exact: `${BASE}/deployments?per_page=100&page=1`, seq: [{ etag: '"e1"', body: [] }, { body: [] }] },
            { exact: `${BASE}/tags?per_page=100&page=1`, body: [] },
        ];
        const env = baseEnv({ GITHUB_API_ETAG_CACHE_DIR: etagDir });

        assert.equal(h.run(SCRIPT, ws, { env, routes }).status, 0);

        const cacheFile = path.join(etagDir, 'shipscope-etags-comp.json');

        assert.ok(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))[`${BASE}/deployments?per_page=100&page=1`]);

        const tmp2 = path.join(ws.dir, 'tmp2');

        fs.mkdirSync(tmp2);

        const r = h.run(SCRIPT, ws, { env: { ...env, RUNNER_TEMP: tmp2 }, routes: [{ exact: `${BASE}/deployments?per_page=100&page=1`, body: [] }] });

        assert.equal(r.status, 0, r.out);
        assert.equal(r.calls[0].headers['If-None-Match'], '"e1"');
        assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), {});

        fs.writeFileSync(path.join(tmp2, 'shipscope-sync-cache-deployments-comp.json'), '{trunc');

        const r2 = h.run(SCRIPT, ws, { env: { ...env, RUNNER_TEMP: tmp2 }, routes: [{ exact: `${BASE}/deployments?per_page=100&page=1`, body: [] }] });

        assert.match(r2.out, /ignoring unreadable retry cache/);
    });
});
