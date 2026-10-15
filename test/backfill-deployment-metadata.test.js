// End-to-end tests for scripts/backfill-deployment-metadata.js: run as a child process under the fetch
// fixture-router preload (test/sync-harness.js). No network, deterministic.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./sync-harness');

const SCRIPT = 'scripts/backfill-deployment-metadata.js';
const BASE = 'https://api.github.com/repos/org/app';
const D = 'docs/data/deployments.json';

let h;

before(() => { h = createHarness('sync-backfill'); });
after(() => { h.cleanup(); });

const baseEnv = (extra = {}) => ({ GITHUB_TOKEN: 'tok', APP_REPO: 'org/app', COMPONENT: 'comp', ...extra });
const commit = sha => `https://github.com/org/app/commit/${sha}`;
const st = (state, created_at, log_url) => ({ state, created_at, ...(log_url ? { log_url } : {}) });

describe('startup', () => {
    for (const [name, env, msg] of [
        ['GITHUB_TOKEN', { GITHUB_TOKEN: '' }, 'Missing GITHUB_TOKEN'],
        ['APP_REPO', { APP_REPO: '' }, 'Missing APP_REPO'],
        ['COMPONENT', { COMPONENT: '' }, 'Missing COMPONENT'],
    ]) {
        test(`fails without ${name}`, () => {
            const r = h.run(SCRIPT, h.workspace(), { env: baseEnv(env) });

            assert.equal(r.status, 1);
            assert.match(r.out, new RegExp(msg));
        });
    }

    test('fails when the data file does not exist', () => {
        const r = h.run(SCRIPT, h.workspace(), { env: baseEnv() });

        assert.equal(r.status, 1);
        assert.match(r.out, /does not exist — nothing to backfill/);
    });

    test('does nothing (and does not rewrite the file) when the component has no records', () => {
        const ws = h.workspace();

        h.writeJson(ws, D, [{ id: 'gh-1', component: 'other', environment: 'test', status: 'success' }]);

        const before = fs.readFileSync(path.join(ws.dir, D), 'utf8');
        const r = h.run(SCRIPT, ws, { env: baseEnv() });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /No deployment records found for component "comp"/);
        assert.equal(fs.readFileSync(path.join(ws.dir, D), 'utf8'), before);
        assert.equal(r.calls.length, 0);
    });

    test('an unparsable data file crashes with a non-zero exit', () => {
        const ws = h.workspace();

        h.writeJson(ws, D, '{broken');

        const r = h.run(SCRIPT, ws, { env: baseEnv() });

        assert.equal(r.status, 1);
    });
});

describe('full backfill', () => {
    const records = () => [
        { id: 'gh-101', component: 'comp', environment: 'test', status: 'success', deployedAt: '2026-10-01T10:00:00Z', commitUrl: commit('aaaaaaa1'), version: 'aaaaaaa1', deployedBy: 'alice', relatedIssues: [] },
        { id: 'gh-102', component: 'comp', environment: 'test', status: 'success', deployedAt: '2026-10-02T10:00:00Z', commitUrl: commit('bbbbbbb2'), version: 'bbbbbbb2', deployedBy: 'bob', relatedIssues: [] },
        { id: 'gh-103', component: 'comp', environment: 'qa', status: 'success', deployedAt: '2026-10-01T10:00:00Z', commitUrl: 'https://github.com/org/app/compare/0000000...ddddddd4', version: 'v1.0.0', resolvedRef: 'v1.0.0', relatedIssues: ['X-1'], issueCommitTypes: { 'X-1': 'fix' }, rollback: { toRef: 'zzzzzzz' }, manual: true, deployedBy: 'Q', deployedByLogin: 'q' },
        { id: 'gh-104', component: 'comp', environment: 'qa', status: 'success', deployedAt: '2026-10-01T11:00:00Z', commitUrl: commit('ddddddd4'), version: 'v1.0.0', resolvedRef: 'v1.0.0', relatedIssues: [], rollback: null, manual: false, deployedBy: 'Q', deployedByLogin: 'q' },
        { id: 'gh-105', component: 'comp', environment: 'prod', status: 'failed', deployedAt: '2026-10-03T10:00:00Z', commitUrl: commit('ccccccc3'), version: 'ccccccc3', deployedBy: 'unknown', relatedIssues: [] },
        { id: 'gh-106', component: 'comp', environment: 'prod', status: 'success', deployedAt: '2026-10-04T10:00:00Z', commitUrl: commit('eeeeeee5'), version: 'eeeeeee5', deployedBy: 'carol', relatedIssues: [] },
        { id: 'gh-107', component: 'comp', environment: 'prod', status: 'success', deployedAt: '2026-10-05T10:00:00Z', commitUrl: null, version: 'fffffff6', deployedBy: 'dave', relatedIssues: [] },
        { id: 'gh-108', component: 'comp', environment: 'prod', status: 'success', deployedAt: '2026-10-06T10:00:00Z', commitUrl: commit('9999999a'), version: 'v3.0.0', deployedBy: 'erin', relatedIssues: [] },
        { id: 'gh-109', component: 'comp', environment: 'test', status: 'success', deployedAt: '2026-10-07T10:00:00Z', commitUrl: commit('1111111b'), version: '1111111b', deployedBy: 'alice', relatedIssues: [] },
        { id: 'gh-900', component: 'other', environment: 'prod', status: 'success', deployedAt: '2026-10-07T10:00:00Z', commitUrl: commit('abcdef1'), version: 'abcdef1', deployedBy: 'zed' },
    ];
    const tags = [
        { name: 'v1', commit: { sha: 'aaaaaaa1' } },
        ...Array.from({ length: 99 }, (_, i) => ({ name: `filler-${i}`, commit: { sha: `f${i}` } })),
    ];
    const routes = () => [
        { exact: `${BASE}/deployments/102/statuses?per_page=10`, body: [st('inactive', '2026-10-02T12:00:00Z'), st('success', '2026-10-02T10:10:00Z', 'https://github.com/org/app/actions/runs/888'), st('queued', '2026-10-02T10:00:00Z')] },
        { exact: `${BASE}/deployments/101/statuses?per_page=10`, body: [st('success', '2026-10-01T10:05:00Z', 'https://github.com/org/app/actions/runs/777')] },
        { exact: `${BASE}/deployments/105/statuses?per_page=10`, body: [] },
        { exact: `${BASE}/deployments/106/statuses?per_page=10`, status: 500, text: 'boom' },
        { exact: `${BASE}/deployments/107/statuses?per_page=10`, body: [st('error', '2026-10-05T10:00:00Z', 'https://github.com/org/app/actions/runs/888')] },
        { exact: `${BASE}/deployments/108/statuses?per_page=10`, body: [st('success', '2026-10-06T10:00:00Z')] },
        { exact: `${BASE}/deployments/109/statuses?per_page=10`, body: [st('queued', '2026-10-07T10:00:00Z')] },
        { exact: `${BASE}/actions/runs/888`, body: { event: 'workflow_dispatch' } },
        { exact: `${BASE}/actions/runs/777`, status: 403, text: 'forbidden' },
        { exact: `${BASE}/tags?per_page=100&page=1`, body: tags },
        { exact: `${BASE}/tags?per_page=100&page=2`, body: [] },
        { exact: `${BASE}/releases?per_page=100&page=1`, body: [{ tag_name: 'v1' }, { tag_name: 'ghost' }] },
        { exact: `${BASE}/commits/bbbbbbb2`, body: { commit: { message: 'Release 2.0.0 now' } } },
        { exact: `${BASE}/commits/ccccccc3`, status: 500, text: 'boom' },
        { exact: `${BASE}/commits/eeeeeee5`, body: { commit: { message: 'nothing special' } } },
        { exact: `${BASE}/commits/1111111b`, body: {} },
        { exact: `${BASE}/compare/aaaaaaa1...bbbbbbb2`, body: { status: 'behind' } },
        { exact: `${BASE}/compare/bbbbbbb2...1111111b`, status: 500, text: 'down' },
        { exact: `${BASE}/compare/eeeeeee5...9999999a`, body: { status: 'ahead' } },
        { exact: 'https://api.github.com/users/alice', body: { name: 'Alice A' } },
        { exact: 'https://api.github.com/users/bob', status: 404, text: 'nope' },
        { exact: 'https://api.github.com/users/carol', body: { name: 'Carol C' } },
        { exact: 'https://api.github.com/users/dave', throw: 'net' },
        { exact: 'https://api.github.com/users/erin', body: { name: null } },
    ];

    test('backfills every phase, only touches this component, and a rerun is a no-op on data', () => {
        const ws = h.workspace();

        h.writeJson(ws, D, records());

        const r = h.run(SCRIPT, ws, { env: baseEnv(), routes: routes() });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /fixed 1 duplicate-release gap\(s\)/);
        assert.match(r.out, /upgraded 3 link\(s\) to commit ranges/);
        assert.match(r.out, /could not backfill run metadata for deployment gh-106/);
        assert.match(r.out, /could not determine trigger type for run 777/);
        assert.match(r.out, /could not backfill version for deployment gh-105/);
        assert.match(r.out, /could not check rollback status for deployment gh-109/);
        assert.match(r.out, /\(1 flagged as rollbacks\)/);
        assert.doesNotMatch(r.out, /Rerun to continue/);

        const by = Object.fromEntries(h.readJson(ws, D).map(x => [x.id, x]));

        // Duplicate-release repair copies the donor's range onto its sibling.
        assert.equal(by['gh-104'].commitUrl, by['gh-103'].commitUrl);
        assert.deepEqual(by['gh-104'].relatedIssues, ['X-1']);
        assert.deepEqual(by['gh-104'].issueCommitTypes, { 'X-1': 'fix' });
        assert.deepEqual(by['gh-104'].rollback, { toRef: 'zzzzzzz' });
        // Compare links.
        assert.equal(by['gh-102'].commitUrl, 'https://github.com/org/app/compare/aaaaaaa1...bbbbbbb2');
        assert.equal(by['gh-108'].commitUrl, 'https://github.com/org/app/compare/eeeeeee5...9999999a');
        assert.equal(by['gh-109'].commitUrl, 'https://github.com/org/app/compare/bbbbbbb2...1111111b');
        assert.equal(by['gh-101'].commitUrl, commit('aaaaaaa1'));
        // Run metadata.
        assert.equal(by['gh-102'].manual, true);
        assert.equal(by['gh-102'].workflowRunUrl, 'https://github.com/org/app/actions/runs/888');
        assert.equal(by['gh-102'].durationMs, 600000);
        assert.equal(by['gh-101'].manual, false);
        assert.equal(by['gh-105'].workflowRunUrl, null);
        assert.equal(by['gh-105'].manual, false);
        assert.equal(by['gh-106'].manual, false);
        assert.equal(by['gh-106'].workflowRunUrl, null);
        assert.equal(by['gh-107'].manual, true);
        assert.equal(by['gh-109'].durationMs, null);
        // Versions.
        assert.equal(by['gh-101'].version, 'v1');
        assert.equal(by['gh-101'].resolvedRef, 'v1');
        assert.equal(by['gh-102'].version, '2.0.0');
        assert.equal(by['gh-102'].resolvedRef, 'bbbbbbb2');
        assert.equal(by['gh-105'].version, 'ccccccc3');
        assert.equal(by['gh-106'].version, 'eeeeeee5');
        assert.equal(by['gh-107'].version, 'fffffff6');
        assert.equal(by['gh-108'].version, 'v3.0.0');
        // Rollbacks.
        assert.deepEqual(by['gh-102'].rollback, { toRef: 'aaaaaaa1' });
        assert.equal(by['gh-108'].rollback, null);
        assert.equal(by['gh-109'].rollback, null);
        assert.equal(by['gh-107'].rollback, null);
        // Display names.
        assert.equal(by['gh-101'].deployedBy, 'Alice A');
        assert.equal(by['gh-101'].deployedByLogin, 'alice');
        assert.equal(by['gh-102'].deployedBy, 'bob');
        assert.equal(by['gh-105'].deployedByLogin, null);
        assert.equal(by['gh-106'].deployedBy, 'Carol C');
        assert.equal(by['gh-107'].deployedBy, 'dave');
        assert.equal(by['gh-108'].deployedBy, 'erin');
        // Other components are untouched.
        assert.deepEqual(by['gh-900'], records().find(x => x.id === 'gh-900'));
        assert.equal(r.calls.filter(c => c.url.endsWith('/users/alice')).length, 1);
        assert.equal(r.calls.filter(c => c.url.includes('/actions/runs/888')).length, 1);

        const after1 = fs.readFileSync(path.join(ws.dir, D), 'utf8');
        const r2 = h.run(SCRIPT, ws, { env: baseEnv(), routes: routes() });

        assert.equal(r2.status, 0, r2.out);
        assert.match(r2.out, /fixed 0 duplicate-release gap\(s\), upgraded 0 link\(s\)/);
        assert.match(r2.out, /resolved run metadata for 0 deployment\(s\)/);
        assert.match(r2.out, /checked rollback status for 0 deployment\(s\)/);
        assert.match(r2.out, /resolved display name for 0 deployment\(s\)/);
        assert.equal(fs.readFileSync(path.join(ws.dir, D), 'utf8'), after1);
        // Still-unresolved raw-SHA versions are retried, but nothing else hits the API.
        assert.ok(!r2.calls.some(c => c.url.includes('/statuses')));
        assert.ok(!r2.calls.some(c => c.url.includes('/compare/')));
        assert.ok(!r2.calls.some(c => c.url.includes('/users/')));
    });

    test('MAX_RECORDS_PER_RUN caps each phase and the log says to rerun', () => {
        const ws = h.workspace();

        h.writeJson(ws, D, records());

        const r = h.run(SCRIPT, ws, { env: baseEnv({ MAX_RECORDS_PER_RUN: '2' }), routes: routes() });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /run-metadata deployment\(s\) still pending/);
        assert.match(r.out, /version deployment\(s\) still pending/);
        assert.match(r.out, /rollback-check deployment\(s\) still pending/);
        assert.match(r.out, /display-name deployment\(s\) still pending/);
        assert.match(r.out, /Rerun to continue\./);

        const withManual = h.readJson(ws, D).filter(x => x.component === 'comp' && 'manual' in x).length;

        // 2 of the 7 pending got processed on top of gh-103/gh-104 which already had the field.
        assert.equal(withManual, 4);
    });
});

describe('duplicate-release repair edge cases', () => {
    test('no donor leaves the group alone; a donor missing optional fields yields empty defaults', () => {
        const ws = h.workspace();
        const base = { component: 'comp', status: 'success', manual: false, rollback: null, deployedBy: 'u', deployedByLogin: 'u' };

        h.writeJson(ws, D, [
            { ...base, id: 'gh-1', environment: 'test', deployedAt: '2026-10-01T00:00:00Z', commitUrl: commit('aaaaaaa1'), version: 'v1.0.0' },
            { ...base, id: 'gh-2', environment: 'test', deployedAt: '2026-10-01T01:00:00Z', commitUrl: commit('aaaaaaa1'), version: 'v1.0.0' },
            { ...base, id: 'gh-3', environment: 'qa', deployedAt: '2026-10-01T00:00:00Z', commitUrl: 'https://github.com/org/app/compare/aaaaaaa...bbbbbbb', version: 'v2' },
            { ...base, id: 'gh-4', environment: 'qa', deployedAt: '2026-10-01T01:00:00Z', commitUrl: commit('bbbbbbb'), version: 'v2' },
            { ...base, id: 'gh-5', environment: 'qa', deployedAt: '2026-10-01T02:00:00Z', commitUrl: 'https://github.com/org/app/compare/aaaaaaa...bbbbbbb', version: 'v2' },
        ]);

        const r = h.run(SCRIPT, ws, { env: baseEnv(), routes: [] });

        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /fixed 1 duplicate-release gap\(s\)/);

        const by = Object.fromEntries(h.readJson(ws, D).map(x => [x.id, x]));

        assert.equal(by['gh-2'].commitUrl, commit('aaaaaaa1'));
        assert.equal(by['gh-4'].commitUrl, 'https://github.com/org/app/compare/aaaaaaa...bbbbbbb');
        assert.deepEqual(by['gh-4'].relatedIssues, []);
        assert.deepEqual(by['gh-4'].issueCommitTypes, {});
        assert.equal(by['gh-4'].rollback, null);
        assert.equal(r.calls.length, 0);
    });
});
