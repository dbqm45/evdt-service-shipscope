/* ---------- Rendering: Insights ---------- */

const CHART_STATUS_ORDER = [
    { key: 'released', label: 'Released', cls: 'seg-released' },
    { key: 'deployedHidden', label: 'Deployed (hidden)', cls: 'seg-deployed' },
    { key: 'partial', label: 'Partial', cls: 'seg-partial' },
    { key: 'none', label: 'Not deployed', cls: 'seg-none' },
];

// This Jira instance's actual priority scheme, highest first — not Jira's "standard" Highest/High/Medium/
// Low/Lowest naming, which this org doesn't use. An issue whose priority isn't one of these just sorts
// after all of them, alphabetically.
const PRIORITY_ORDER = ['Blocker', 'Critical', 'Major', 'Medium', 'Minor'];

function comparePriorityDesc(a, b){
    const ai = PRIORITY_ORDER.indexOf(a);
    const bi = PRIORITY_ORDER.indexOf(b);

    if (ai === -1 && bi === -1) {
        return a.localeCompare(b);
    }
    if (ai === -1) {
        return 1;
    }
    if (bi === -1) {
        return -1;
    }

    return ai - bi;
}

/** Derives a "PI-27.3.3"-style label for an issue's sprint: the PI prefix plus the trailing sprint-within-
 *  PI number, both pulled straight out of the raw sprint name (e.g. "Sparks 27.3.3") via the same
 *  PI.sprint numbering convention `extractPiFromSprintName` already assumes on the sync side. `null` for
 *  an issue with no sprint, or a sprint name that doesn't match the convention (e.g. a label-derived `pi`
 *  with no real sprint behind it) — there's no sprint number to show in that case. */
function sprintLabelFor(issue){
    if (!issue.sprint) {
        return null;
    }

    const m = issue.sprint.match(/(\d+\.\d+)\.(\d+)/);

    // A sprint not named after a PI (a team that doesn't work in PIs) is its own bucket.
    return m ? `PI-${m[1]}.${m[2]}` : issue.sprint;
}

/** PROD status counts of `issues`, one bucket per `keyOf(issue)` (issues with no key are skipped), as rows
 *  `{ label, counts, total }` sorted by `compare`. `deployed` and `deployed_code_only` share one bucket
 *  ("Deployed (hidden)") — at this rolled-up level, "code shipped but flag confirmed off" and "code shipped,
 *  no flag to check" both mean the same practical thing: shipped, visibility unconfirmed. */
function releaseStatusBreakdown(issues, keyOf, compare){
    const byKey = new Map();

    issues.forEach(issue => {
        const key = keyOf(issue);

        if (!key) {
            return;
        }

        if (!byKey.has(key)) {
            byKey.set(key, { none: 0, deployedHidden: 0, released: 0, partial: 0 });
        }

        const level = issueStatusForEnv(issue, ENVIRONMENT.PROD).level;
        const counts = byKey.get(key);

        if (level === RELEASE_LEVEL.RELEASED) {
            counts.released++;
        } else if (level === RELEASE_LEVEL.DEPLOYED || level === RELEASE_LEVEL.DEPLOYED_CODE_ONLY) {
            counts.deployedHidden++;
        } else if (level === RELEASE_LEVEL.PARTIAL) {
            counts.partial++;
        } else {
            counts.none++;
        }
    });

    return [...byKey.keys()].sort(compare).map(label => {
        const counts = byKey.get(label);

        return { label, counts, total: counts.none + counts.deployedHidden + counts.released + counts.partial };
    });
}

/** One stacked bar per row of a releaseStatusBreakdown(), or `emptyMessage` when there are none. */
function renderReleaseStatusChart(boxId, rows, emptyMessage){
    const box = document.getElementById(boxId);

    if (!rows.length) {
        box.innerHTML = EmptyState({ message: emptyMessage });
        return;
    }

    const legend = ChartLegend({ items: CHART_STATUS_ORDER });
    const rowsHtml = rows.map(({ label, counts, total }) => {
        const segments = CHART_STATUS_ORDER.map(s => {
            const n = counts[s.key];

            if (!n) {
                return '';
            }

            return BarSegment({ cls: s.cls, widthPct: n / total * 100, title: `${s.label}: ${n}` });
        });

        return BarRow({ label, valueText: total, segments });
    });

    box.innerHTML = html`${legend}${rowsHtml}`;
}

/** Chart 1's data: every issue's PROD status (via the same issueStatusForEnv the Product view table
 *  already reads row-by-row), bucketed per sprint (`sprintLabelFor()`) rather than per PI — a finer-grained
 *  view of the same rollup. */
function sprintReleaseStatusBreakdown(){
    return releaseStatusBreakdown(state.jiraIssues, sprintLabelFor, compareVersionDesc);
}

function renderSprintStatusChart(){
    renderReleaseStatusChart('chartSprint', sprintReleaseStatusBreakdown(), 'No issues with a detectable sprint to chart yet');
}

/** Same rollup, bucketed by Jira `priority` instead — answers "how many Highest/High-priority issues are still
 *  not released," not just "how many total." Issues with no priority set (an older sync, or a Jira instance
 *  that doesn't use it) are excluded rather than lumped into an "unknown" bucket. */
function priorityReleaseStatusBreakdown(){
    return releaseStatusBreakdown(state.jiraIssues.filter(i => isRealPi(i.pi)), i => i.priority, comparePriorityDesc);
}

function renderPriorityStatusChart(){
    renderReleaseStatusChart('chartPriority', priorityReleaseStatusBreakdown(), 'No issues with a priority set yet');
}

/** Chart 2's data: every flag currently ON in prod (via the same effectiveFlagState() resolution used
 *  everywhere else), with days since that state's changedAt — not gated on every linked issue being Done
 *  like flagStaleWarning() is, just the raw "how long has this been on" per flag, sorted longest-first.
 *  Reuses flagStaleWarning's STALE_FLAG_DAYS threshold purely to color bars past it, not its full gate. */
function staleFlagDaysBreakdown(){
    return Object.keys(state.flagsMeta).map(key => {
        const envEntry = state.flagStates[key] ? state.flagStates[key].prod : null;
        const fs = effectiveFlagState(envEntry);

        if (!fs || !fs.enabled) {
            return null;
        }

        const days = Math.floor((Date.now() - new Date(fs.changedAt).getTime()) / 86400000);

        return { key, days, stale: days >= STALE_FLAG_DAYS };
    }).filter(Boolean).sort((a, b) => b.days - a.days);
}

function renderStaleFlagsChart(){
    const box = document.getElementById('chartStaleFlags');
    const rows = staleFlagDaysBreakdown();

    if (!rows.length) {
        box.innerHTML = EmptyState({ message: 'No flags are currently ON in prod' });
        return;
    }

    const max = Math.max(rows[0].days, 1);

    box.innerHTML = html`${rows.map(({ key, days, stale }) => BarRow({
        label: key,
        valueText: `${days}d`,
        segments: BarSegment({ cls: stale ? 'seg-stale' : 'seg-deployed', widthPct: Math.max(days / max * 100, 2), title: `${days} day(s) ON in prod` }),
    }))}`;
}

/** Earliest known successful prod deployment referencing this issue or one of its sub-tasks, across both the live
 *  `state.deployments` (may have aged out of retention) and the never-trimmed
 *  `state.issueDeployments` fallback — see issueDeployedOnComponent()'s own comment for why both are
 *  checked. An issue can ship via more than one component, so this takes the minimum across all of them,
 *  not just one. */
function earliestProdDeployedAt(issue){
    const keys = issueKeys(issue);
    const liveTimes = state.deployments
        .filter(d => d.environment === ENVIRONMENT.PROD && d.status === 'success' && deploymentNamesAny(d, keys))
        .map(d => new Date(d.deployedAt).getTime());
    const historicalTimes = keys.flatMap(k => Object.values(state.issueDeployments[k]?.prod || {}))
        .map(h => new Date(h.deployedAt).getTime());
    const all = [...liveTimes, ...historicalTimes];

    return all.length ? Math.min(...all) : null;
}
/** Median days from Jira resolution (`resolvedAt`) to the first successful prod deployment referencing
 *  that issue key — "how long after Done did this actually reach users," bucketed per sprint
 *  (`sprintLabelFor()`, same "PI-27.3.3"-style label as chart 1) rather than per PI, for the same
 *  finer-grained reason. Only counts issues that are both resolved and have a detectable sprint and have
 *  shipped to prod at least once; a negative gap (code already on prod before the ticket was marked Done
 *  — a "deploy first, close after verifying" workflow) is clamped to 0 rather than shown as negative. */
function leadTimeToProdBySprint(){
    const bySprint = new Map();

    state.jiraIssues.filter(i => i.resolvedAt).forEach(issue => {
        const label = sprintLabelFor(issue);

        if (!label) {
            return;
        }

        const firstProdAt = earliestProdDeployedAt(issue);

        if (!firstProdAt) {
            return;
        }

        const days = Math.max(0, Math.floor((firstProdAt - new Date(issue.resolvedAt).getTime()) / 86400000));

        if (!bySprint.has(label)) {
            bySprint.set(label, []);
        }

        bySprint.get(label).push(days);
    });

    return [...bySprint.keys()].sort(compareVersionDesc).map(label => {
        const values = bySprint.get(label).sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        const median = values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);

        return { label, median, count: values.length };
    });
}

function renderLeadTimeChart(){
    const box = document.getElementById('chartLeadTime');
    const rows = leadTimeToProdBySprint();

    if (!rows.length) {
        box.innerHTML = EmptyState({ message: 'No resolved issues with a prod deployment yet' });
        return;
    }

    const max = Math.max(...rows.map(r => r.median), 1);

    box.innerHTML = html`${rows.map(({ label, median, count }) => BarRow({
        label,
        valueText: `${median}d`,
        segments: BarSegment({ cls: 'seg-deployed', widthPct: Math.max(median / max * 100, 2), title: `Median ${median}d over ${count} issue(s)` }),
    }))}`;
}

/** Chart 3's data: deployments from the last 12 calendar months only, bucketed by month of `deployedAt`,
 *  counting how many carry `rollback` and how many carry a `driftBehind` that actually flags something
 *  (`commitCount` — this env fell behind an earlier one — or `untestedCommitCount` — this env has commits
 *  no earlier one ever saw, i.e. skipped the normal promotion path). Both fields are already computed by
 *  the server's deployment sync; this is a pure rollup, sorted chronologically (oldest first) since it's a
 *  trend, unlike the ranked snapshots in the other charts. The 12-month window is a display cap only — it
 *  doesn't touch the stored deployments, just what this one chart renders. */
function rollbackDriftByMonth(){
    const buckets = new Map();
    const cutoff = new Date();

    cutoff.setMonth(cutoff.getMonth() - 12);

    state.deployments.forEach(d => {
        if (!d.deployedAt) {
            return;
        }

        const date = new Date(d.deployedAt);

        if (date < cutoff) {
            return;
        }

        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

        if (!buckets.has(monthKey)) {
            buckets.set(monthKey, { date: new Date(date.getFullYear(), date.getMonth(), 1), rollback: 0, drift: 0 });
        }

        const bucket = buckets.get(monthKey);

        if (d.rollback) {
            bucket.rollback++;
        }
        if (d.driftBehind && (d.driftBehind.commitCount || d.driftBehind.untestedCommitCount)) {
            bucket.drift++;
        }
    });

    return [...buckets.values()].sort((a, b) => a.date - b.date);
}

function renderRollbackDriftChart(){
    const box = document.getElementById('chartRollbackDrift');
    const months = rollbackDriftByMonth();

    if (!months.length || !months.some(m => m.rollback || m.drift)) {
        box.innerHTML = EmptyState({ message: 'No rollbacks or drift detected in this data' });
        return;
    }

    const max = Math.max(...months.map(m => Math.max(m.rollback, m.drift)), 1);
    const cols = months.map(m => ColumnChartColumn({
        label: m.date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        bars: [
            { cls: 'seg-rollback', height: m.rollback ? Math.max(m.rollback / max * 100, 4) : 0, title: `Rollbacks: ${m.rollback}` },
            { cls: 'seg-drift', height: m.drift ? Math.max(m.drift / max * 100, 4) : 0, title: `Drift: ${m.drift}` },
        ],
    }));

    box.innerHTML = html`${ChartLegend({ items: [{ cls: 'seg-rollback', label: 'Rollback' }, { cls: 'seg-drift', label: 'Drift' }] })}${ColumnChart({ columns: cols })}`;
}

function renderInsights(){
    renderSprintStatusChart();
    renderLeadTimeChart();
    renderPriorityStatusChart();
    renderStaleFlagsChart();
    renderRollbackDriftChart();
}

