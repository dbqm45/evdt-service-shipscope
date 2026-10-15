const test = require('node:test');
const assert = require('node:assert/strict');
const {
    mapEnvironment,
    trimOldRecords,
    buildSummary,
    mergeIssueDeploymentHistory,
    computeDeployDurationMs,
    buildDeploymentPlan,
    seedLastResolvedRangeByEnv,
    pickLatestStatus,
    computeNextCursor,
    applyDrift,
} = require('../scripts/lib/deployment-records');

const NOW = Date.parse('2026-10-09T00:00:00Z');
const daysAgo = d => new Date(NOW - d * 86400000).toISOString();
const rec = (id, environment, status, ageDays, extra = {}) =>
    ({ id, component: 'c', environment, status, deployedAt: daysAgo(ageDays), ...extra });

test('mapEnvironment never maps pre-prod to prod and drops unknown envs', () => {
    assert.equal(mapEnvironment('production'), 'prod');
    assert.equal(mapEnvironment('preprod'), null);
    assert.equal(mapEnvironment('pre-prod'), null);
    assert.equal(mapEnvironment('dev'), 'test');
    assert.equal(mapEnvironment('QA-1'), 'qa');
    assert.equal(mapEnvironment('staging'), null);
});

test('trimOldRecords drops old records but keeps latest-overall and latest-success per component/env', () => {
    const records = [
        rec('old-ok', 'prod', 'success', 200),
        rec('newer-ok', 'prod', 'success', 150), // latest success, old
        rec('newest-fail', 'prod', 'failed', 120), // latest overall, old
        rec('ancient', 'prod', 'success', 300),
        rec('recent', 'qa', 'success', 5),
    ];
    const { records: kept, latestOverall, latestSuccess } = trimOldRecords(records, { retentionDays: 90, now: NOW });

    assert.deepEqual(kept.map(r => r.id).sort(), ['newer-ok', 'newest-fail', 'recent']);
    assert.equal(latestOverall.get('c::prod').id, 'newest-fail');
    assert.equal(latestSuccess.get('c::prod').id, 'newer-ok');
});

test('buildSummary gives every env entry both keys', () => {
    const { records, latestOverall, latestSuccess } = trimOldRecords([rec('f', 'test', 'failed', 1)], { retentionDays: 90, now: NOW });
    const summary = buildSummary(latestOverall, latestSuccess);

    assert.equal(records.length, 1);
    assert.equal(summary.components.c.test.latestOverall.id, 'f');
    assert.equal(summary.components.c.test.current, null);
});

test('mergeIssueDeploymentHistory only adds first sightings of successful deploys and is idempotent', () => {
    const history = {};
    const records = [
        rec('a', 'prod', 'success', 2, { relatedIssues: ['X-1'], commitUrl: 'u1' }),
        rec('b', 'prod', 'success', 1, { relatedIssues: ['X-1'], commitUrl: 'u2' }),
        rec('c2', 'prod', 'failed', 1, { relatedIssues: ['X-2'] }),
    ];

    assert.equal(mergeIssueDeploymentHistory(history, records), true);
    assert.equal(history['X-1'].prod.c.commitUrl, 'u1');
    assert.equal(history['X-2'], undefined);
    assert.equal(mergeIssueDeploymentHistory(history, records), false);
});

test('computeDeployDurationMs ignores the trailing inactive marker', () => {
    const statuses = [
        { state: 'inactive', created_at: '2026-10-09T12:00:00Z' },
        { state: 'success', created_at: '2026-10-09T00:05:00Z' },
        { state: 'in_progress', created_at: '2026-10-09T00:00:00Z' },
    ];

    assert.equal(computeDeployDurationMs(statuses), 5 * 60000);
    assert.equal(computeDeployDurationMs([statuses[1]]), null);
});

test('pickLatestStatus skips inactive to the real outcome, falls back to newest when none terminal', () => {
    assert.equal(pickLatestStatus([{ state: 'inactive' }, { state: 'failure' }]).state, 'failure');
    assert.equal(pickLatestStatus([{ state: 'queued' }, { state: 'in_progress' }]).state, 'queued');
});

test('buildDeploymentPlan: blocks fresh pending deploys, permanently skips stuck ones, drops unknown envs', () => {
    const iso = h => new Date(NOW - h * 3600000).toISOString();
    const deployments = [
        { id: 1, environment: 'prod', sha: 'a', created_at: iso(100) }, // stuck
        { id: 2, environment: 'prod', sha: 'b', created_at: iso(1) },   // pending, fresh
        { id: 3, environment: 'staging', sha: 'c', created_at: iso(1) }, // unknown env
        { id: 4, environment: 'prod', sha: 'd', created_at: iso(2) },
        { id: 5, environment: 'prod', sha: 'e', created_at: iso(1) },
    ];
    const latest = {
        4: { state: 'success', created_at: iso(2) },
        5: { state: 'failure', created_at: iso(1) },
    };
    const { plan, blockedIds } = buildDeploymentPlan(deployments, latest, {}, { now: NOW, stuckMaxAgeHours: 48 });

    assert.deepEqual(blockedIds, [2]);
    assert.deepEqual(plan.map(p => p.dep.id), [4, 5]);
    assert.equal(plan[0].previousSha, null);
    assert.equal(plan[1].previousSha, 'd');
    assert.equal(plan[1].status, 'failed');
});

test('computeNextCursor never advances past a blocked id', () => {
    const batch = [{ id: 10 }, { id: 11 }, { id: 12 }];

    assert.equal(computeNextCursor(batch, [11], 5), 10);
    assert.equal(computeNextCursor(batch, [], 5), 12);
    assert.equal(computeNextCursor([], [], 5), 5);
});

test('applyDrift sets, clears, and leaves driftBehind alone when the compare failed', () => {
    const latestByEnv = {
        qa: { driftBehind: { behindEnv: 'test', commitCount: 1 } },
        prod: { driftBehind: { behindEnv: 'qa', commitCount: 2 } },
        test: {},
    };

    applyDrift(latestByEnv, { test: { untestedIn: 'x', untestedCommitCount: 3 } }, new Set(['prod']));

    assert.deepEqual(latestByEnv.test.driftBehind, { untestedIn: 'x', untestedCommitCount: 3 });
    assert.equal('driftBehind' in latestByEnv.qa, false);
    assert.deepEqual(latestByEnv.prod.driftBehind, { behindEnv: 'qa', commitCount: 2 });
});

test('seedLastResolvedRangeByEnv only treats a /compare/ commitUrl as a real range', () => {
    const seeded = seedLastResolvedRangeByEnv([
        rec('a', 'prod', 'success', 3, { version: 'v1', commitUrl: 'https://github.com/o/r/commit/abc' }),
        rec('b', 'prod', 'success', 1, { version: 'v2', resolvedRef: 'v2', commitUrl: 'https://github.com/o/r/compare/v1...abc', relatedIssues: ['X-1'] }),
    ]);

    assert.equal(seeded.prod.ref, 'v2');
    assert.equal(seeded.prod.compareUrl, 'https://github.com/o/r/compare/v1...abc');
    assert.deepEqual(seeded.prod.relatedIssues, ['X-1']);
});
