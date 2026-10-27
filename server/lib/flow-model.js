// Flow time of items and of changes from a repo (G3 step 1, design-docs/G3-FLOW-TIME-PLAN.pl.md): first commit to
// first PROD deployment. Pure: lib/service-api.js reads issue_deployments and work_items and calls flowTimes().

const DAY_MS = 86_400_000;

const iso = (d) => new Date(d).toISOString();
const days = (from, to) => Math.max(0, Math.round(((new Date(to) - new Date(from)) / DAY_MS) * 10) / 10);

/**
 * The middle value, or the mean of the two middle values; null for none.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

/**
 * Each item that has both a first commit and a first PROD deployment, the repo changes whose every slice (but dropped
 * ones) reached PROD, and their medians.
 *
 * @param {{ facts: Array<{ issue_key: string, environment: string, first_deployed_at: Date, first_commit_at: Date|null }>, workItems: Array<{ item_key: string, kind: 'change'|'task', parent_key: string|null, status: string|null }> }} input
 * @returns {{ items: Array<{ key: string, kind: 'change'|'task'|'issue', parentKey: string|null, firstCommitAt: string, firstProdAt: string, flowDays: number }>, changes: Array<{ key: string, tasks: number, startedAt: string, deliveredAt: string, flowDays: number }>, summary: { itemFlowDaysMedian: number|null, itemCount: number, changeFlowDaysMedian: number|null, changeCount: number, tasksPerChangeMedian: number|null } }}
 */
function flowTimes({ facts, workItems }) {
    const byKey = new Map();
    for (const f of facts) {
        const k = byKey.get(f.issue_key) ?? byKey.set(f.issue_key, { commit: null, prod: null }).get(f.issue_key);
        if (f.first_commit_at && (!k.commit || f.first_commit_at < k.commit)) k.commit = f.first_commit_at;
        if (f.environment === 'prod' && (!k.prod || f.first_deployed_at < k.prod)) k.prod = f.first_deployed_at;
    }
    const work = new Map(workItems.map((w) => [w.item_key, w]));
    const items = [];
    for (const [key, k] of byKey) {
        if (!k.commit || !k.prod) continue;
        const w = work.get(key);
        items.push({ key, kind: w ? w.kind : 'issue', parentKey: w ? w.parent_key : null, firstCommitAt: iso(k.commit), firstProdAt: iso(k.prod), flowDays: days(k.commit, k.prod) });
    }
    const changes = [];
    for (const change of workItems.filter((w) => w.kind === 'change')) {
        const tasks = workItems.filter((w) => w.kind === 'task' && w.parent_key === change.item_key && w.status !== 'dropped');
        if (!tasks.length) continue;
        const timed = tasks.map((t) => byKey.get(t.item_key));
        if (timed.some((k) => !k || !k.prod || !k.commit)) continue;
        const startedAt = new Date(Math.min(...timed.map((k) => k.commit)));
        const deliveredAt = new Date(Math.max(...timed.map((k) => k.prod)));
        changes.push({ key: change.item_key, tasks: tasks.length, startedAt: iso(startedAt), deliveredAt: iso(deliveredAt), flowDays: days(startedAt, deliveredAt) });
    }
    items.sort((a, b) => a.firstProdAt.localeCompare(b.firstProdAt) || a.key.localeCompare(b.key));
    changes.sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt) || a.key.localeCompare(b.key));
    return { items, changes, summary: flowSummary(items, changes) };
}

/**
 * Medians of a set of items and changes (also after narrowing them to a range).
 *
 * @param {Array<{ flowDays: number }>} items
 * @param {Array<{ flowDays: number, tasks: number }>} changes
 * @returns {{ itemFlowDaysMedian: number|null, itemCount: number, changeFlowDaysMedian: number|null, changeCount: number, tasksPerChangeMedian: number|null }}
 */
function flowSummary(items, changes) {
    return {
        itemFlowDaysMedian: median(items.map((i) => i.flowDays)),
        itemCount: items.length,
        changeFlowDaysMedian: median(changes.map((c) => c.flowDays)),
        changeCount: changes.length,
        tasksPerChangeMedian: median(changes.map((c) => c.tasks)),
    };
}

module.exports = { flowTimes, flowSummary, median };
