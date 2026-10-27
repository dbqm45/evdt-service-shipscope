// Flow time of changes and slices (G3 step 1, design-docs/G3-FLOW-TIME-PLAN.pl.md): first commit → first PROD.
const { test } = require('node:test');
const assert = require('node:assert');
const { flowTimes } = require('../lib/flow-model');

const fact = (key, environment, firstDeployedAt, firstCommitAt = null, repoId = 1) => ({ issue_key: key, environment, repo_id: repoId, first_deployed_at: new Date(firstDeployedAt), first_commit_at: firstCommitAt && new Date(firstCommitAt) });
const item = (key, kind, parentKey = null, status = 'done') => ({ item_key: key, kind, parent_key: parentKey, status });

test('an item\'s flow: its earliest first commit anywhere to its first PROD deployment, in days', () => {
    const { items } = flowTimes({
        facts: [
            fact('TSK-57', 'qa', '2026-10-03T00:00:00Z', '2026-10-01T00:00:00Z'),
            fact('TSK-57', 'prod', '2026-10-04T12:00:00Z', '2026-10-02T00:00:00Z', 2),
            fact('PAY-1', 'prod', '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'),
            fact('PAY-2', 'prod', '2026-10-05T00:00:00Z'),
            fact('PAY-3', 'qa', '2026-10-05T00:00:00Z', '2026-10-01T00:00:00Z'),
        ],
        workItems: [item('CHG-12', 'change'), item('TSK-57', 'task', 'CHG-12')],
    });
    assert.deepStrictEqual(items, [
        { key: 'TSK-57', kind: 'task', parentKey: 'CHG-12', firstCommitAt: '2026-10-01T00:00:00.000Z', firstProdAt: '2026-10-04T12:00:00.000Z', flowDays: 3.5 },
        { key: 'PAY-1', kind: 'issue', parentKey: null, firstCommitAt: '2026-10-06T00:00:00.000Z', firstProdAt: '2026-10-05T00:00:00.000Z', flowDays: 0 },
    ], 'PAY-2 has no first commit, PAY-3 never reached PROD; never negative');
});

test('a change is delivered once every slice but dropped ones is on PROD: first commit of any slice to the last on PROD', () => {
    const facts = [
        fact('TSK-57', 'prod', '2026-10-04T00:00:00Z', '2026-10-01T00:00:00Z'),
        fact('TSK-58', 'prod', '2026-10-08T00:00:00Z', '2026-10-03T00:00:00Z'),
        fact('TSK-61', 'prod', '2026-10-09T00:00:00Z', '2026-10-08T00:00:00Z'),
    ];
    const workItems = [
        item('CHG-12', 'change'), item('TSK-57', 'task', 'CHG-12'), item('TSK-58', 'task', 'CHG-12'), item('TSK-59', 'task', 'CHG-12', 'dropped'),
        item('CHG-13', 'change'), item('TSK-61', 'task', 'CHG-13'), item('TSK-62', 'task', 'CHG-13', 'in_progress'),
        item('CHG-14', 'change'),
    ];
    const { changes, summary } = flowTimes({ facts, workItems });
    assert.deepStrictEqual(changes, [
        { key: 'CHG-12', tasks: 2, startedAt: '2026-10-01T00:00:00.000Z', deliveredAt: '2026-10-08T00:00:00.000Z', flowDays: 7 },
    ], 'CHG-13 waits for TSK-62, CHG-14 has no slices');
    assert.deepStrictEqual(summary, { itemFlowDaysMedian: 3, itemCount: 3, changeFlowDaysMedian: 7, changeCount: 1, tasksPerChangeMedian: 2 });
    assert.deepStrictEqual(flowTimes({ facts: [], workItems: [] }).summary, { itemFlowDaysMedian: null, itemCount: 0, changeFlowDaysMedian: null, changeCount: 0, tasksPerChangeMedian: null });
});
