const { test } = require('node:test');
const assert = require('node:assert');
const {
    mapEnvironment, extractIssueKeys, extractCommitType, pickLatestStatus, computeDeployDurationMs,
    buildDeploymentPlan, computeNextCursor, issuesFromMessages,
} = require('../lib/deployment-logic');

// Same cases as the file-based sync's test/deployment-records.test.js, which these functions were ported from.

test('mapEnvironment: never maps pre-prod to prod, drops unknown environments', () => {
    assert.strictEqual(mapEnvironment('production'), 'prod');
    assert.strictEqual(mapEnvironment(' PROD-eu '), 'prod');
    assert.strictEqual(mapEnvironment('qa'), 'qa');
    assert.strictEqual(mapEnvironment('dev'), 'test');
    for (const env of ['preprod', 'pre-prod', 'pre_prod', 'staging', '', undefined]) assert.strictEqual(mapEnvironment(env), null, String(env));
});

test('issue keys and commit types from messages', () => {
    assert.deepStrictEqual(extractIssueKeys('ABC-1 and ABC-1, X-2, DEF-33'), ['ABC-1', 'DEF-33']);
    assert.strictEqual(extractCommitType('feat(web)!: x'), 'feat');
    assert.strictEqual(extractCommitType('docs: x'), null);
    assert.deepStrictEqual(issuesFromMessages(['feat: ABC-1', 'fix: ABC-2 and ABC-1', 'ABC-3']), {
        keys: ['ABC-1', 'ABC-2', 'ABC-3'],
        typesByKey: { 'ABC-1': 'fix', 'ABC-2': 'fix' },
    });
});

test('pickLatestStatus skips inactive to the real outcome; computeDeployDurationMs ignores inactive', () => {
    const statuses = [
        { state: 'inactive', created_at: '2026-10-01T12:00:00Z' },
        { state: 'success', created_at: '2026-10-01T10:05:00Z' },
        { state: 'in_progress', created_at: '2026-10-01T10:00:00Z' },
    ];
    assert.strictEqual(pickLatestStatus(statuses).state, 'success');
    assert.strictEqual(pickLatestStatus([{ state: 'queued' }]).state, 'queued');
    assert.strictEqual(pickLatestStatus([]), undefined);
    assert.strictEqual(computeDeployDurationMs(statuses), 5 * 60_000);
    assert.strictEqual(computeDeployDurationMs([statuses[1]]), null);
});

test('buildDeploymentPlan: blocks fresh pending deploys, skips stuck ones and unknown envs, orders by status time', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    const deployments = [
        { id: 1, environment: 'prod', sha: 'a', created_at: '2026-10-10T10:00:00Z' },
        { id: 2, environment: 'prod', sha: 'b', created_at: '2026-10-10T09:00:00Z' },
        { id: 3, environment: 'qa', sha: 'c', created_at: '2026-10-10T11:00:00Z' },        // pending, fresh
        { id: 4, environment: 'qa', sha: 'd', created_at: '2026-10-07T11:00:00Z' },        // pending, 3 days
        { id: 5, environment: 'staging', sha: 'e', created_at: '2026-10-10T11:00:00Z' },
    ];
    const statusesById = {
        1: [{ state: 'success', created_at: '2026-10-10T10:01:00Z' }],
        2: [{ state: 'error', created_at: '2026-10-10T09:01:00Z' }],
        3: [{ state: 'in_progress', created_at: '2026-10-10T11:00:00Z' }],
    };
    const { plan, blockedIds, skipped } = buildDeploymentPlan(deployments, statusesById, { now, stuckMaxAgeHours: 48, previousShaByEnv: { prod: 'z' } });
    assert.deepStrictEqual(plan.map((p) => [p.dep.id, p.status, p.previousSha]), [[2, 'failed', 'z'], [1, 'success', 'z']]);
    assert.deepStrictEqual(blockedIds, [3]);
    assert.deepStrictEqual(skipped, [{ id: 4, reason: 'stuck' }, { id: 5, reason: 'environment' }]);
});

test('computeNextCursor never advances past a blocked id', () => {
    assert.strictEqual(computeNextCursor([{ id: 11 }, { id: 12 }, { id: 13 }], [12], 10), 11);
    assert.strictEqual(computeNextCursor([{ id: 11 }, { id: 13 }], [], 10), 13);
    assert.strictEqual(computeNextCursor([], [], 10), 10);
});
