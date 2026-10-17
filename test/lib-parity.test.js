// Guards the two deliberate ports documented in CLAUDE.md ("Backend (server/)") and design-docs/REPORT_ARCH.md
// (Problem 3): server/ can't require from scripts/ (its own dependency boundary — see CLAUDE.md), so the
// rules behind tree-diff and GitHub-deployment resolution each live twice. The two copies are allowed to
// differ in file shape (scripts/lib/tree-diff.js parses DRIFT_IGNORE_PATHS from a JSON env var; the server
// reads it already-validated from a column — see that file's own header comment) — what must stay identical
// is *behavior* on the same input. This file never compares file content, only `deepStrictEqual` on outputs.
//
// Not covered here: trimOldRecords()/latestSuccessfulByEnv() (scripts/lib/deployment-records.js) have no
// counterpart in server/lib/deployment-logic.js — the server expresses that same retention rule as a SQL
// query in server/lib/retention.js (DISTINCT ON + DELETE), not as a pure JS function over an array, so there
// is nothing to call with the same fixture on both sides. A JS-vs-SQL parity test would mean re-implementing
// the SQL rule in JS just to compare it against itself, which proves nothing; if that ever changes (e.g. the
// server starts computing retention in JS before writing), this file is the place to add it.
const test = require('node:test');
const assert = require('node:assert/strict');

const scriptsTreeDiff = require('../scripts/lib/tree-diff');
const serverTreeDiff = require('../server/lib/tree-diff');
const scriptsDeploy = require('../scripts/lib/deployment-records');
const serverDeploy = require('../server/lib/deployment-logic');

const tree = (entries) => ({ tree: entries.map(([path, sha, type = 'blob']) => ({ path, sha, type })) });

test('diffTrees: identical on both ports — identical trees, modify, rename, add/remove, ignore patterns', () => {
    const cases = [
        [tree([['a.js', '1'], ['b.js', '2']]), tree([['a.js', '1'], ['b.js', '2']]), []],
        [tree([['a.js', '1']]), tree([['a.js', '2']]), []], // modified
        [tree([['old.js', '1']]), tree([['new.js', '1']]), []], // rename = two paths
        [tree([['a.js', '1']]), tree([['a.js', '1'], ['b.js', '2']]), []], // added
        [tree([['a.js', '1'], ['b.js', '2']]), tree([['a.js', '1']]), []], // removed
        [tree([['README.md', '1']]), tree([['README.md', '2']]), ['README.md']], // ignored by name
        [tree([['.github/x.yml', '1']]), tree([['.github/x.yml', '2']]), ['.github/']], // ignored by dir
        [tree([['src', 't1', 'tree'], ['src/a.js', '1']]), tree([['src', 't2', 'tree'], ['src/a.js', '9']]), []], // tree entries ignored
        [null, tree([]), []], // missing listing
        [{ truncated: true, tree: [] }, tree([]), []], // truncated listing
    ];

    for (const [a, b, ignore] of cases) {
        assert.deepEqual(serverTreeDiff.diffTrees(a, b, ignore), scriptsTreeDiff.diffTrees(a, b, ignore));
    }
});

test('mapEnvironment: identical on both ports — recognized envs, preprod guard, unrecognized, empty', () => {
    const inputs = ['production', 'prod', 'qa-env', 'test', 'dev', 'preprod', 'pre-prod', 'staging', 'uat', '', null, undefined, 'PROD'];

    for (const input of inputs) {
        assert.equal(serverDeploy.mapEnvironment(input), scriptsDeploy.mapEnvironment(input));
    }
});

test('extractIssueKeys: identical on both ports — multiple keys, dedup, none, empty/null text', () => {
    const inputs = ['fix(SHP-12): also touches SHP-12 and ABC-9', 'no keys here', '', null, undefined, 'lowercase-1 is not a key'];

    for (const input of inputs) {
        assert.deepEqual(serverDeploy.extractIssueKeys(input), scriptsDeploy.extractIssueKeys(input));
    }
});

test('extractCommitType: identical on both ports — feat/fix/chore, scoped, breaking, unrecognized', () => {
    const inputs = ['feat(SHP): x', 'fix: x', 'chore(release): x', 'feat!: x', 'docs: x', '', null, undefined];

    for (const input of inputs) {
        assert.equal(serverDeploy.extractCommitType(input), scriptsDeploy.extractCommitType(input));
    }
});

test('computeDeployDurationMs: identical on both ports — excludes inactive, needs 2+, null on too few', () => {
    const cases = [
        [{ state: 'queued', created_at: '2026-01-01T00:00:00Z' }, { state: 'success', created_at: '2026-01-01T00:05:00Z' }],
        [{ state: 'success', created_at: '2026-01-01T00:05:00Z' }, { state: 'inactive', created_at: '2026-01-01T01:00:00Z' }],
        [{ state: 'success', created_at: '2026-01-01T00:05:00Z' }],
        [],
        null,
    ];

    for (const statuses of cases) {
        assert.equal(serverDeploy.computeDeployDurationMs(statuses), scriptsDeploy.computeDeployDurationMs(statuses));
    }
});

test('pickLatestStatus: identical on both ports — terminal present, only inactive/pending, empty', () => {
    const cases = [
        [{ state: 'inactive', created_at: '2' }, { state: 'success', created_at: '1' }],
        [{ state: 'queued', created_at: '1' }, { state: 'inactive', created_at: '2' }],
        [{ state: 'failure', created_at: '1' }],
    ];

    for (const statuses of cases) {
        assert.deepEqual(serverDeploy.pickLatestStatus(statuses), scriptsDeploy.pickLatestStatus(statuses));
    }
});

test('computeNextCursor: identical on both ports — blocked caps it, otherwise highest processed id', () => {
    const cases = [
        [[{ id: 5 }, { id: 9 }], [], 1],
        [[{ id: 5 }, { id: 9 }], [7, 12], 1],
        [[], [], 42],
    ];

    for (const [deployments, blockedIds, lastSyncedId] of cases) {
        assert.equal(
            serverDeploy.computeNextCursor(deployments, blockedIds, lastSyncedId),
            scriptsDeploy.computeNextCursor(deployments, blockedIds, lastSyncedId)
        );
    }
});

// buildDeploymentPlan's two ports take genuinely different inputs by design: the scripts/ caller
// (sync-github-deployments.js) pre-resolves `latestStatusById` via pickLatestStatus() itself before calling
// in; the server's version takes the raw `statusesById` and calls pickLatestStatus() internally. Rebuilding
// `latestStatusById` here the same way the real caller does makes the two comparable on the same fixture.
test('buildDeploymentPlan: identical plan/blockedIds on both ports given the same deployments+statuses', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    const stuckMaxAgeHours = 48;
    const deployments = [
        { id: 1, environment: 'production', sha: 'aaa', created_at: '2026-05-01T00:00:00Z' },
        { id: 2, environment: 'qa', sha: 'bbb', created_at: '2026-05-02T00:00:00Z' },
        { id: 3, environment: 'staging', sha: 'ccc', created_at: '2026-05-03T00:00:00Z' }, // unrecognized env
        { id: 4, environment: 'prod', sha: 'ddd', created_at: '2026-05-30T23:00:00Z' }, // still pending, not stuck
        { id: 5, environment: 'prod', sha: 'eee', created_at: '2026-01-01T00:00:00Z' }, // stuck (no terminal status, way past 48h)
    ];
    const statusesById = {
        1: [{ state: 'success', created_at: '2026-05-01T00:10:00Z', log_url: 'https://x/1' }],
        2: [{ state: 'failure', created_at: '2026-05-02T00:10:00Z' }],
        3: [{ state: 'success', created_at: '2026-05-03T00:10:00Z' }],
        4: [{ state: 'queued', created_at: '2026-05-30T23:05:00Z' }],
        5: [{ state: 'in_progress', created_at: '2026-01-01T00:05:00Z' }],
    };

    const latestStatusById = Object.fromEntries(
        Object.entries(statusesById).map(([id, statuses]) => [id, scriptsDeploy.pickLatestStatus(statuses)])
    );

    const scriptsResult = scriptsDeploy.buildDeploymentPlan(deployments, latestStatusById, statusesById, { now, stuckMaxAgeHours });
    const serverResult = serverDeploy.buildDeploymentPlan(deployments, statusesById, { now, stuckMaxAgeHours });

    const normalize = (plan) => plan.map(({ dep, environment, status, statusCreatedAt, workflowRunUrl, durationMs, previousSha }) =>
        ({ depId: dep.id, environment, status, statusCreatedAt, workflowRunUrl, durationMs, previousSha }));

    assert.deepEqual(normalize(serverResult.plan), normalize(scriptsResult.plan));
    assert.deepEqual(serverResult.blockedIds.sort(), scriptsResult.blockedIds.sort());
});
