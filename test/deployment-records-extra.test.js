const { test } = require('node:test');
const assert = require('node:assert');
const dr = require('../scripts/lib/deployment-records');

test('mapEnvironment', () => {
    assert.strictEqual(dr.mapEnvironment('Production'), 'prod');
    assert.strictEqual(dr.mapEnvironment('preprod'), null);
    assert.strictEqual(dr.mapEnvironment('pre-prod'), null);
    assert.strictEqual(dr.mapEnvironment(' QA '), 'qa');
    assert.strictEqual(dr.mapEnvironment('dev'), 'test');
    assert.strictEqual(dr.mapEnvironment('test'), 'test');
    assert.strictEqual(dr.mapEnvironment('staging'), null);
    assert.strictEqual(dr.mapEnvironment(undefined), null);
});

test('extractIssueKeys / extractCommitType / extractPromotedVersion / extractRunId', () => {
    assert.deepStrictEqual(dr.extractIssueKeys('EBO-1 fix EBO-1 and AB-22'), ['EBO-1', 'AB-22']);
    assert.deepStrictEqual(dr.extractIssueKeys(null), []);
    assert.strictEqual(dr.extractCommitType('feat(x)!: hi'), 'feat');
    assert.strictEqual(dr.extractCommitType('docs: hi'), null);
    assert.strictEqual(dr.extractCommitType(), null);
    assert.strictEqual(dr.extractPromotedVersion('Release v1.2.3 now'), 'v1.2.3');
    assert.strictEqual(dr.extractPromotedVersion('nothing'), null);
    assert.strictEqual(dr.extractPromotedVersion(), null);
    assert.strictEqual(dr.extractRunId('https://x/actions/runs/123/job/4'), '123');
    assert.strictEqual(dr.extractRunId('nope'), null);
    assert.strictEqual(dr.extractRunId(), null);
});

const rec = (id, env, status, at, extra = {}) => ({ id, component: 'c', environment: env, status, deployedAt: at, ...extra });

test('latestSuccessfulByEnv picks newest success per env', () => {
    const out = dr.latestSuccessfulByEnv([
        rec('a', 'qa', 'success', '2026-01-01'),
        rec('b', 'qa', 'success', '2026-02-01'),
        rec('c', 'qa', 'success', '2025-01-01'),
        rec('d', 'qa', 'failed', '2026-03-01'),
        rec('e', 'prod', 'success', '2026-01-01'),
    ]);
    assert.strictEqual(out.qa.id, 'b');
    assert.strictEqual(out.prod.id, 'e');
});

test('trimOldRecords keeps latest overall/success regardless of age and recent ones', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    const records = [
        rec('old-ok', 'qa', 'success', '2025-01-01T00:00:00Z'),
        rec('older-ok', 'qa', 'success', '2024-01-01T00:00:00Z'),
        rec('old-fail', 'qa', 'failed', '2025-06-01T00:00:00Z'),
        rec('older-fail', 'qa', 'failed', '2024-06-01T00:00:00Z'),
        rec('recent', 'test', 'failed', '2026-05-30T00:00:00Z'),
        rec('ancient', 'test', 'failed', '2020-01-01T00:00:00Z'),
    ];
    const out = dr.trimOldRecords(records, { retentionDays: 90, now });
    assert.deepStrictEqual(out.records.map(r => r.id).sort(), ['old-fail', 'old-ok', 'recent']);
    assert.strictEqual(out.latestOverall.get('c::qa').id, 'old-fail');
    assert.strictEqual(out.latestSuccess.get('c::qa').id, 'old-ok');
    assert.strictEqual(out.latestSuccess.has('c::test'), false);
});

test('trimOldRecords defaults now to Date.now()', () => {
    const fresh = rec('x', 'qa', 'success', new Date().toISOString());
    assert.strictEqual(dr.trimOldRecords([fresh], { retentionDays: 1 }).records.length, 1);
});

test('buildSummary fills missing keys with null', () => {
    const a = rec('a', 'qa', 'failed', '2026-01-01');
    const b = rec('b', 'prod', 'success', '2026-01-01');
    const out = dr.buildSummary([a], [b, { ...a, id: 'z', status: 'success' }]);
    assert.strictEqual(out.components.c.qa.latestOverall.id, 'a');
    assert.strictEqual(out.components.c.qa.current.id, 'z');
    assert.strictEqual(out.components.c.prod.latestOverall, null);
    assert.strictEqual(out.components.c.prod.current.id, 'b');
    const only = dr.buildSummary([a], []);
    assert.strictEqual(only.components.c.qa.current, null);
});

test('mergeIssueDeploymentHistory adds only first sighting, idempotent', () => {
    const h = {};
    const recs = [
        rec('a', 'qa', 'success', '1', { relatedIssues: ['X-1'], commitUrl: 'u' }),
        rec('b', 'qa', 'success', '2', { relatedIssues: ['X-1'] }),
        rec('c', 'prod', 'success', '3', { relatedIssues: ['X-1', 'X-2'] }),
        rec('d', 'prod', 'failed', '4', { relatedIssues: ['X-9'] }),
        rec('e', 'prod', 'success', '5'),
    ];
    assert.strictEqual(dr.mergeIssueDeploymentHistory(h, recs), true);
    assert.deepStrictEqual(h['X-1'].qa.c, { deployedAt: '1', commitUrl: 'u' });
    assert.strictEqual(h['X-1'].prod.c.commitUrl, null);
    assert.ok(!h['X-9']);
    assert.strictEqual(dr.mergeIssueDeploymentHistory(h, recs), false);
});

test('computeDeployDurationMs', () => {
    assert.strictEqual(dr.computeDeployDurationMs(undefined), null);
    assert.strictEqual(dr.computeDeployDurationMs([{ state: 'success', created_at: '2026-01-01T00:00:10Z' }]), null);
    assert.strictEqual(dr.computeDeployDurationMs([
        { state: 'inactive', created_at: '2027-01-01T00:00:00Z' },
        { state: 'success', created_at: '2026-01-01T00:01:00Z' },
        { state: 'in_progress', created_at: '2026-01-01T00:00:00Z' },
    ]), 60000);
});

test('buildDeploymentPlan: unknown env, blocked, stuck, ordering and previousSha', () => {
    const warn = console.warn;
    const warns = [];
    console.warn = m => warns.push(m);
    try {
        const now = Date.parse('2026-01-10T00:00:00Z');
        const deps = [
            { id: 1, environment: 'staging', sha: 's1' },
            { id: 2, environment: 'qa', sha: 's2', created_at: '2026-01-09T23:00:00Z' },
            { id: 3, environment: 'qa', sha: 's3', created_at: '2026-01-01T00:00:00Z' },
            { id: 4, environment: 'qa', sha: 's4', created_at: '2026-01-09T01:00:00Z' },
            { id: 5, environment: 'qa', sha: 's5', created_at: '2026-01-09T02:00:00Z' },
            { id: 6, environment: 'qa', sha: 's6', created_at: '2026-01-09T03:00:00Z' },
        ];
        const latest = {
            2: { state: 'queued' },
            4: { state: 'success', created_at: '2026-01-09T05:00:00Z', log_url: 'L' },
            5: { state: 'failure', created_at: '2026-01-09T04:00:00Z' },
            6: { state: 'error', created_at: '2026-01-09T06:00:00Z' },
        };
        const out = dr.buildDeploymentPlan(deps, latest, { 4: [{ state: 'success', created_at: '2026-01-09T05:00:00Z' }] }, { now, stuckMaxAgeHours: 48 });
        assert.deepStrictEqual(out.blockedIds, [2]);
        assert.deepStrictEqual(out.plan.map(p => p.dep.id), [5, 4, 6]);
        assert.deepStrictEqual(out.plan.map(p => p.previousSha), [null, null, 's4']);
        assert.deepStrictEqual(out.plan.map(p => p.status), ['failed', 'success', 'failed']);
        assert.strictEqual(out.plan[1].workflowRunUrl, 'L');
        assert.strictEqual(out.plan[0].workflowRunUrl, null);
        assert.strictEqual(warns.length, 2);
    } finally {
        console.warn = warn;
    }
});

test('buildDeploymentPlan defaults now', () => {
    const out = dr.buildDeploymentPlan([{ id: 1, environment: 'qa', created_at: new Date().toISOString() }], {}, {}, { stuckMaxAgeHours: 48 });
    assert.deepStrictEqual(out.blockedIds, [1]);
});

test('buildRecord with full and minimal entries', () => {
    const full = dr.buildRecord({
        dep: { id: 7, sha: 'abcdefabcdefabcdef' }, environment: 'qa', status: 'success', statusCreatedAt: 't',
        workflowRunUrl: 'w', durationMs: 5, manual: true, compareUrl: 'cmp', rollback: { toRef: 'r' },
        deployedByLogin: 'bob', deployedByName: 'Bob B',
    }, 'comp', ['A-1'], 'org/repo', 'v1.0.0', { 'A-1': 'fix' }, 'ref');
    assert.deepStrictEqual(full, {
        id: 'gh-7', component: 'comp', environment: 'qa', version: 'v1.0.0', commitUrl: 'cmp', workflowRunUrl: 'w',
        durationMs: 5, manual: true, rollback: { toRef: 'r' }, deployedAt: 't', deployedBy: 'Bob B', deployedByLogin: 'bob',
        status: 'success', relatedIssues: ['A-1'], issueCommitTypes: { 'A-1': 'fix' }, resolvedRef: 'ref',
    });

    const min = dr.buildRecord({ dep: { id: 8, sha: 'abcdefabcdefabcdef' }, environment: 'test', status: 'failed', statusCreatedAt: 't' }, 'c', [], 'org/repo');
    assert.strictEqual(min.version, 'abcdefabcdef');
    assert.strictEqual(min.commitUrl, 'https://github.com/org/repo/commit/abcdefabcdefabcdef');
    assert.strictEqual(min.deployedBy, 'unknown');
    assert.strictEqual(min.manual, false);
    assert.strictEqual(min.rollback, null);
    assert.strictEqual(min.workflowRunUrl, null);
    assert.strictEqual(min.durationMs, null);
    assert.deepStrictEqual(min.issueCommitTypes, {});
    assert.strictEqual(min.resolvedRef, null);

    const noSha = dr.buildRecord({ dep: { id: 9, ref: 'main' }, environment: 'test', status: 'failed', statusCreatedAt: 't', deployedByLogin: 'l' }, 'c', [], null);
    assert.strictEqual(noSha.version, 'main');
    assert.strictEqual(noSha.commitUrl, null);
    assert.strictEqual(noSha.deployedBy, 'l');
    assert.strictEqual(dr.buildRecord({ dep: { id: 1 }, environment: 'qa', status: 's', statusCreatedAt: 't' }, 'c', [], 'r').version, '');
});

test('seedLastResolvedRefByEnv / seedLastResolvedRangeByEnv', () => {
    const recs = [
        rec('a', 'qa', 'success', '2026-01-01', { version: 'v1', commitUrl: 'https://x/compare/a...b', relatedIssues: ['I-1'], issueCommitTypes: { 'I-1': 'fix' }, rollback: { toRef: 'r' } }),
        rec('b', 'qa', 'success', '2026-02-01', { version: 'v2', resolvedRef: 'R2' }),
        rec('c', 'qa', 'success', '2025-01-01', { version: 'v0' }),
        rec('d', 'qa', 'failed', '2027-01-01', { version: 'v9' }),
        rec('e', 'prod', 'success', '2026-01-01', { version: 'v5', commitUrl: 'https://x/commit/1' }),
    ];
    assert.deepStrictEqual(dr.seedLastResolvedRefByEnv(recs), { qa: 'R2', prod: 'v5' });
    const range = dr.seedLastResolvedRangeByEnv(recs);
    assert.deepStrictEqual(range.qa, { ref: 'R2', compareUrl: null, relatedIssues: [], issueCommitTypes: {}, rollback: null });
    assert.strictEqual(range.prod.compareUrl, null);
    const r1 = dr.seedLastResolvedRangeByEnv([recs[0]]);
    assert.deepStrictEqual(r1.qa, { ref: 'v1', compareUrl: 'https://x/compare/a...b', relatedIssues: ['I-1'], issueCommitTypes: { 'I-1': 'fix' }, rollback: { toRef: 'r' } });
});

test('pickLatestStatus / computeNextCursor / applyDrift', () => {
    assert.deepStrictEqual(dr.pickLatestStatus([{ state: 'inactive' }, { state: 'success' }]), { state: 'success' });
    assert.deepStrictEqual(dr.pickLatestStatus([{ state: 'queued' }]), { state: 'queued' });
    assert.strictEqual(dr.pickLatestStatus([]), undefined);

    assert.strictEqual(dr.computeNextCursor([{ id: 5 }, { id: 9 }], [], 3), 9);
    assert.strictEqual(dr.computeNextCursor([], [], 3), 3);
    assert.strictEqual(dr.computeNextCursor([{ id: 20 }], [12, 15], 3), 11);

    const latest = { test: { driftBehind: 'old' }, qa: { driftBehind: 'keep' }, prod: { driftBehind: 'gone' } };
    dr.applyDrift(latest, { test: { n: 1 } }, new Set(['qa']));
    assert.deepStrictEqual(latest.test.driftBehind, { n: 1 });
    assert.strictEqual(latest.qa.driftBehind, 'keep');
    assert.ok(!('driftBehind' in latest.prod));
});

test('constants exported', () => {
    assert.deepStrictEqual(dr.ENV_ORDER, ['test', 'qa', 'prod']);
    assert.strictEqual(dr.STATE_MAP.error, 'failed');
});
