// Technical view: deployment history timeline (grouping, flag-flip attachment, pagination). Split out
// of app-technical.js (design-docs/REPORT_ARCH.md, Problem 5 / priority H) -- uses the shared helpers
// (componentKind, ...) that stay in app-technical.js itself.

const DEPLOY_PAGE_SIZE = 20;
let visibleDeployCount = DEPLOY_PAGE_SIZE;

/** Ticket + flag-flip chips, shared between a single deploy card and a grouped-deploy card (where the
 *  chips are the union across every run in the group). Returns '' when there's nothing to show. */
function renderChipsRow(relatedIssues, flagBadges){
    return DeployChips({
        issues: (relatedIssues || []).map(k => ({ key: k, href: jiraIssueUrl(k) })),
        flagBadges: flagBadges || {},
    });
}

function renderDeployCard(d, attachedFlips){
    const flagBadges = { ...(d.resolvedFlags || {}) };

    (attachedFlips || []).forEach(f => { flagBadges[f.key] = f.enabled; });

    return DeployCard({
        left: DeployCardTitle({
            kind: componentKind(d.component),
            status: d.status,
            component: d.component,
            version: VersionLink({ version: d.version, url: d.commitUrl }),
        }),
        right: html`
          ${EnvBadge({ env: d.environment, icon: envBadgeIcon(ENV_BAR_COUNT[d.environment]) })}
          ${d.manual ? ManualBadge({ withIcon: true }) : ''}
          ${d.rollback ? RollbackBadge({ toRef: d.rollback.toRef }) : ''}
          ${d.workflowRunUrl ? RunBadge({ url: d.workflowRunUrl }) : ''}`,
        meta: joinMeta([
            MonoText({ text: fmtTime(d.deployedAt) }),
            AuthorLabel({ name: d.deployedBy, login: d.deployedByLogin }),
            fmtDuration(d.durationMs) ? MonoText({ text: fmtDuration(d.durationMs) }) : null,
        ]),
        chips: renderChipsRow(d.relatedIssues, flagBadges),
    });
}

/** Union of every run's tickets/resolved-flags in a grouped-deploy card — a flag flip attached to any
 *  one run in the run (via attachedFlips, keyed by deploy id) still surfaces on the group. */
function unionChips(runs, attachedFlips){
    const relatedIssues = new Set();
    const flagBadges = {};

    runs.forEach(run => {
        (run.relatedIssues || []).forEach(k => relatedIssues.add(k));
        Object.entries(run.resolvedFlags || {}).forEach(([k, v]) => { flagBadges[k] = v; });
        (attachedFlips[run.id] || []).forEach(f => { flagBadges[f.key] = f.enabled; });
    });

    return { relatedIssues: [...relatedIssues], flagBadges };
}

/** A collapsed run of consecutive successful same-service/version/env deploys (see
 *  groupConsecutiveDeploys). `group.runs` is newest-first (matching the overall timeline order); the
 *  header shows the oldest→newest time range, badges/status come from the newest run. */
function renderDeployGroupCard(group, attachedFlips, isOpen){
    const latest = group.runs[0];
    const oldest = group.runs[group.runs.length - 1];
    const manualCount = group.runs.filter(r => r.manual).length;
    const manualBadge = manualCount === group.runs.length
        ? ManualBadge({ withIcon: true })
        : manualCount > 0
            ? ManualBadge({ text: `Manual · ${manualCount} of ${group.runs.length}`, withIcon: true })
            : '';
    const { relatedIssues, flagBadges } = unionChips(group.runs, attachedFlips);

    return DeployCard({
        left: DeployCardTitle({
            kind: componentKind(group.component),
            status: latest.status,
            component: group.component,
            version: VersionLink({ version: group.version, url: latest.commitUrl }),
        }),
        right: html`
          ${EnvBadge({ env: group.env, icon: envBadgeIcon(ENV_BAR_COUNT[group.env]) })}
          ${manualBadge}
          ${latest.rollback ? RollbackBadge({ toRef: latest.rollback.toRef }) : ''}
          ${latest.workflowRunUrl ? RunBadge({ url: latest.workflowRunUrl }) : ''}`,
        meta: joinMeta([
            MonoText({ text: `${fmtTime(oldest.deployedAt)}–${fmtTime(latest.deployedAt)}` }),
            AuthorLabel({ name: latest.deployedBy, login: latest.deployedByLogin }),
            DeployGroupToggle({ groupKey: group.key, count: group.runs.length, open: isOpen }),
        ]),
        extra: isOpen ? DeployGroupList({
            items: group.runs.map(r => ({
                status: r.status,
                timeText: fmtTime(r.deployedAt),
                durationText: fmtDuration(r.durationMs),
                manual: !!r.manual,
                runUrl: r.workflowRunUrl || '',
            })),
        }) : '',
        chips: renderChipsRow(relatedIssues, flagBadges),
    });
}

function renderFlagAddedCard(f){
    return FlagAddedCard({ name: f.key, timeText: fmtTime(f.createdAt), components: f.components || [] });
}

/** When a flag was first scaffolded into flags-meta.json — not tied to any one environment. */
function flagAddedEvents(){
    return Object.entries(state.flagsMeta || {})
        .filter(([, f]) => f.createdAt)
        .map(([key, f]) => ({ key, createdAt: f.createdAt, components: f.components || [] }));
}

/**
 * Full audit trail from flag-state-history.json — every flip ever recorded, not just the latest
 * per flag/env/source (that's what flag-states.json/effectiveFlagState hold, for *current* state).
 * Entries only exist from the point this log was introduced onward; older flips were never captured.
 */
function flagChangeEvents(){
    return (state.flagStateHistory || []).map(entry => ({
        key: entry.key,
        env: entry.env,
        source: entry.source,
        enabled: !!entry.enabled,
        changedAt: entry.changedAt,
        changedBy: entry.changedBy,
    }));
}

/**
 * flag-added events aren't tied to one component the way a deployment is — a flag can gate several
 * components at once (flagsMeta[key].components). Matches if the filter is empty, or the deploy's own
 * component matches, or the flag's component list includes it.
 */
function eventMatchesComponent(e, componentFilter){
    if (!componentFilter) {
        return true;
    }
    if (e.kind === 'deploy') {
        return e.data.component === componentFilter;
    }

    return (e.data.components || []).includes(componentFilter);
}

/**
 * A flag flip isn't its own deploy — it's attached, as a badge, to the nearest earlier deploy on the
 * same environment (and, if the flag only gates specific components, matching one of those) instead of
 * getting its own timeline row, the same way a deploy's own resolvedFlags already render. A flip with no
 * earlier matching deploy to attach to (nothing shipped yet on that env/component) is dropped — there's
 * no card on screen for it to attach to.
 */
function attachFlagFlipsToDeploys(){
    const attached = {};

    flagChangeEvents().forEach(flip => {
        const meta = state.flagsMeta[flip.key];
        const eligibleComponents = meta && meta.components && meta.components.length ? meta.components : null;

        const candidates = state.deployments.filter(d =>
            d.environment === flip.env &&
            new Date(d.deployedAt) <= new Date(flip.changedAt) &&
            (!eligibleComponents || eligibleComponents.includes(d.component))
        );

        if (!candidates.length) {
            return;
        }

        candidates.sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt));
        const targetId = candidates[0].id;

        (attached[targetId] = attached[targetId] || []).push({ key: flip.key, enabled: flip.enabled });
    });

    return attached;
}

/** Collapses consecutive *successful* deploys of the same service+version+environment, on the same
 *  calendar day, into one group — a pipeline that redeployed the same commit a few times in a row
 *  (retries, manual re-runs) shouldn't read as N separate ships. Failed/rolled-back deploys and
 *  flag-added events never join a group; they just break the run. `events` is already sorted newest
 *  first, so a run's `runs` array ends up newest-first too. */
function groupConsecutiveDeploys(events){
    const grouped = [];

    events.forEach(e => {
        if (e.kind !== 'deploy' || e.data.status !== 'success') {
            grouped.push(e);
            return;
        }

        const last = grouped[grouped.length - 1];
        const sameRun = last && last.kind === 'deploy-group'
            && last.component === e.data.component
            && last.version === e.data.version
            && last.env === e.data.environment
            && dayKey(last.runs[last.runs.length - 1].deployedAt) === dayKey(e.at);

        if (sameRun) {
            last.runs.push(e.data);
        } else {
            grouped.push({
                kind: 'deploy-group',
                at: e.at,
                component: e.data.component,
                version: e.data.version,
                env: e.data.environment,
                key: `${e.data.component}|${e.data.version}|${e.data.environment}|${dayKey(e.at)}|${e.data.id}`,
                runs: [e.data],
            });
        }
    });

    return grouped;
}

const expandedDeployGroups = new Set();

function renderTimeline(){
    const filter = document.getElementById('filterEnv').value;
    const componentFilter = document.getElementById('filterComponent').value;
    const rangeDays = Number(document.getElementById('filterDeployRange').value) || null;
    const box = document.getElementById('timeline');
    const attachedFlips = attachFlagFlipsToDeploys();

    const deployEvents = state.deployments.map(d => ({ kind: 'deploy', env: d.environment, at: d.deployedAt, data: d }));
    // Not tied to an environment (it's a flags-meta.json event, not a flag-states.json one) — always
    // shown regardless of the environment filter below.
    const addedEvents = flagAddedEvents().map(f => ({ kind: 'flag-added', env: null, at: f.createdAt, data: f }));

    // Display-only cutoff (same spirit as the Insights "Rollbacks & drift" chart's 12-month window) —
    // never trims state.deployments itself, just what's rendered here, so "current version"/drift/
    // rollback detection (which always need the single latest record per component/env, however old)
    // keep working regardless of which range the user is currently looking at.
    const cutoff = rangeDays ? Date.now() - rangeDays * 86400000 : null;

    const allList = [...deployEvents, ...addedEvents]
        .filter(e=> (!filter || !e.env || e.env === filter) && eventMatchesComponent(e, componentFilter) && (!cutoff || new Date(e.at).getTime() >= cutoff))
        .sort((a,b) => new Date(b.at) - new Date(a.at));

    if (!allList.length){
        box.innerHTML = EmptyState({ message: 'No activity to show' });
        return;
    }

    const grouped = groupConsecutiveDeploys(allList);
    const list = grouped.slice(0, visibleDeployCount);

    let lastDay = null;
    const rowsHtml = list.map(e => {
        const key = dayKey(e.at);
        const dayHtml = key !== lastDay ? DayHead({ label: dayHeadLabel(e.at) }) : '';

        lastDay = key;

        if (e.kind === 'deploy') {
            return html`${dayHtml}${renderDeployCard(e.data, attachedFlips[e.data.id])}`;
        }
        if (e.kind === 'deploy-group') {
            // A "group" of exactly one run is just a normal deploy — the range/author/toggle line
            // ("11:04–11:04 · Name · 1 deploys") only earns its keep once there's actually more than
            // one run to summarize.
            return html`${dayHtml}${e.runs.length > 1
                ? renderDeployGroupCard(e, attachedFlips, expandedDeployGroups.has(e.key))
                : renderDeployCard(e.runs[0], attachedFlips[e.runs[0].id])}`;
        }

        return html`${dayHtml}${renderFlagAddedCard(e.data)}`;
    });

    box.innerHTML = html`${rowsHtml}`;

    if (visibleDeployCount < grouped.length) {
        box.innerHTML += LoadMoreSentinel({ id: 'deployLoadMore' });
    }

    box.querySelectorAll('.deploy-group-toggle').forEach(btn => {
        btn.onclick = () => {
            const key = btn.dataset.groupKey;

            if (expandedDeployGroups.has(key)) {
                expandedDeployGroups.delete(key);
            } else {
                expandedDeployGroups.add(key);
            }

            renderTimeline();
        };
    });
}

function resetDeployPagination(){
    visibleDeployCount = DEPLOY_PAGE_SIZE;
    renderTimeline();
}
