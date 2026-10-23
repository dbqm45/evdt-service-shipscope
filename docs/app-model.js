/* ---------- Derived lookups ---------- */
function flagsForIssue(issueKey){
    return Object.entries(state.flagsMeta)
        .filter(([key, meta]) => (meta.jiraKeys || []).includes(issueKey))
        .map(([key, meta]) => ({ key, ...meta }));
}
function componentDeployments(component, environment){
    return state.deployments.filter(d=> d.component === component && d.environment === environment && d.status==='success');
}
function currentVersion(component, environment){
    const list = componentDeployments(component, environment).sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt));

    return list[0] || null;
}
/** The keys a deployment may name an issue by: its own and its sub-tasks' (`subtaskKeys`, from the Jira sync;
 *  absent on issues synced before the field existed, which then match on their own key only). */
function issueKeys(issue){
    return [issue.key, ...(Array.isArray(issue.subtaskKeys) ? issue.subtaskKeys : [])];
}
/** True when a deployment's `relatedIssues` names any of `keys`. */
function deploymentNamesAny(d, keys){
    return (d.relatedIssues || []).some(k => keys.includes(k));
}
/** Falls back to state.issueDeployments (never trimmed, unlike state.deployments — see
 *  the server's issue_deployments table) when the live record has aged out of
 *  retention. The synthesized stand-in only carries what callers actually read off a real record
 *  here (deployedAt/commitUrl) — enough for release-status joins and ghostFlagAge's own deployedAt read. */
function issueDeployedOnComponent(component, issue, env) {
    const keys = issueKeys(issue);
    const live = componentDeployments(component, env).find(d => deploymentNamesAny(d, keys));

    if (live) {
        return live;
    }

    const key = keys.find(k => state.issueDeployments[k]?.[env]?.[component]);
    const historical = key && state.issueDeployments[key][env][component];

    return historical ? { ...historical, relatedIssues: [key], component, environment: env, status: 'success' } : null;
}
/** Any successful deployment (on any component) that references this issue or one of its sub-tasks, ignoring
 *  flags entirely. */
function anyDeploymentForIssue(issue, env){
    const keys = issueKeys(issue);
    const live = state.deployments.some(d =>
        d.environment === env && d.status === 'success' && deploymentNamesAny(d, keys)
    );

    return live || keys.some(k => !!state.issueDeployments[k]?.[env]);
}
/** True when an issue with no deployment of its own is blocked by issues (`blockedByKeys`, from the Jira sync) that
 *  are all deployed on `env` — its code shipped in what blocks it (a bug fixed in a Story's sub-task). One level
 *  only; a blocker is matched on its own key plus its sub-tasks' when it is among the loaded issues. */
function deployedViaBlockers(issue, env){
    const keys = Array.isArray(issue.blockedByKeys) ? issue.blockedByKeys : [];

    return keys.length > 0 && keys.every(key => {
        const blocker = (state.jiraIssues || []).find(i => i.key === key) || { key };

        return anyDeploymentForIssue(blocker, env);
    });
}
function issueLinks(issue){
    const flags = flagsForIssue(issue.key);
    const pairs = [];

    flags.forEach(f => (f.components || []).forEach(c => pairs.push({component:c, flagKey:f.key})));

    return pairs;
}
function linkStatus(link, issue, env){
    const dep = issueDeployedOnComponent(link.component, issue, env);
    const envEntry = state.flagStates[link.flagKey] ? state.flagStates[link.flagKey][env] : null;
    const fs = effectiveFlagState(envEntry);
    const flagOn = fs ? !!fs.enabled : false;
    const deployed = !!dep;
    const released = deployed && flagOn;

    return { deployed, released, deployment: dep, flagOn, flagChangedAt: fs ? fs.changedAt : null };
}
function issueStatusForEnv(issue, env){
    const pairs = issueLinks(issue);

    if (!pairs.length) {
        // No flag is linked to this issue (either nobody has wired jiraKeys
        // yet, or — for deployment-derived fallback stubs — there's no flag
        // to link at all). Rather than reporting a blanket "not deployed",
        // fall back to raw deployment presence: did any component's code
        // referencing this issue actually ship to this environment? This is
        // strictly less precise (we can't know if a flag is hiding it), but
        // far more honest than always showing "none".
        const deployedHere = anyDeploymentForIssue(issue, env) || deployedViaBlockers(issue, env);

        return { level: deployedHere ? RELEASE_LEVEL.DEPLOYED_CODE_ONLY : RELEASE_LEVEL.NONE, blocked:false, results:[] };
    }

    const results = pairs.map(l => ({
        ...linkStatus(l, issue, env),
        component: l.component,
        flagKey: l.flagKey
    }));
    const allDeployed = results.every(r=> r.deployed);
    const noneDeployed = results.every(r=> !r.deployed);
    const allReleased = results.every(r=> r.released);
    const noneReleased = results.every(r=> !r.released);
    let level;

    if (noneDeployed) {
        level = RELEASE_LEVEL.NONE;
    } else if (allReleased) {
        level = RELEASE_LEVEL.RELEASED;
    } else if (allDeployed && noneReleased) {
        level = RELEASE_LEVEL.DEPLOYED;
    } else {
        level = RELEASE_LEVEL.PARTIAL;
    }

    let blocked = false;

    if (env === ENVIRONMENT.PROD && issue.dependencyBlocked && level === RELEASE_LEVEL.RELEASED){
        level = RELEASE_LEVEL.DEPLOYED;
        blocked = true;
    }

    return { level, blocked, results };
}
function statusLabel(level){
    return { [RELEASE_LEVEL.NONE]: 'Not deployed', [RELEASE_LEVEL.DEPLOYED]: 'Deployed (hidden)', [RELEASE_LEVEL.RELEASED]: 'Released', [RELEASE_LEVEL.PARTIAL]: 'Partial', [RELEASE_LEVEL.DEPLOYED_CODE_ONLY]: 'Code deployed' }[level];
}
function statusClass(level){
    return { [RELEASE_LEVEL.NONE]: 'st-none', [RELEASE_LEVEL.DEPLOYED]: 'st-deployed', [RELEASE_LEVEL.RELEASED]: 'st-released', [RELEASE_LEVEL.PARTIAL]: 'st-partial', [RELEASE_LEVEL.DEPLOYED_CODE_ONLY]: 'st-deployed' }[level];
}
/** Human, jargon-free ("flag"-free) explanation of a status pill, for a plain `title="..."` tooltip —
 *  these feed `innerHTML`-built markup directly as fixed developer-authored constants (same as
 *  `statusLabel`/`statusClass` right above), so no `escapeHtml()` call is needed here. */
function statusLabelTooltip(level){
    return {
        [RELEASE_LEVEL.NONE]: 'Not deployed to this environment yet',
        [RELEASE_LEVEL.DEPLOYED]: 'Code is deployed, but the feature is not yet visible to users',
        [RELEASE_LEVEL.RELEASED]: 'The feature is visible to users',
        [RELEASE_LEVEL.PARTIAL]: 'Partially visible — some components or environments already show it, others don’t yet',
        [RELEASE_LEVEL.DEPLOYED_CODE_ONLY]: 'Code is deployed, but there is no flag to confirm whether users can see it',
    }[level] || '';
}

/** Plain-language `title="..."` tooltip for a `.drift-note` in renderMatrix() — same "fixed,
 *  developer-authored constant" treatment as statusLabelTooltip() above, no escapeHtml() needed.
 *  `env` is already one of the fixed ENVIRONMENTS values (test/qa/prod), never user/Jira-sourced text. */
function driftNoteTooltip(kind, env){
    return {
        files: `Files whose content differs between this environment's deployed commit and ${env}'s (compared as git trees). Differences in paths the component marks as ignorable (deployment plumbing such as workflows or READMEs) are not counted.`,
        unknown: 'The code of the two environments could not be compared reliably (GitHub API error, or the repository is too large to list in one call), so a difference can neither be confirmed nor ruled out.',
        history: 'Raw Git history between the two deployed commits. It counts commits, not code: with separate deployment branches, merges and squashes create new commits for identical code, so a large number does not mean a large difference.',
        historySameVersion: 'Raw Git history between the two deployed commits. Both show the same version name, but the commits differ — the name isn\'t tied to a Git tag or Release, so the builds probably come from different branches. The counts measure commits, not code.',
        scope: 'Compares the repository\'s files only. It does not confirm that the deployments are otherwise identical (configuration, environment variables, images, feature flags).',
    }[kind] || '';
}

/** Border color for the raw Jira status tag (renderIssueRow/renderEpicHeader) — matched by status text
 *  since Jira workflow status names are project-specific free text, not a fixed enum like
 *  `statusCategory`. Anything unrecognized (a status name from a workflow we haven't seen) just keeps
 *  the default neutral tag border instead of guessing. */
function jiraStatusTagClass(status){
    if (!status) {
        return '';
    }

    const s = status.toLowerCase();

    if (s === 'done' || s === 'ready for prod') {
        return 'tag-status-done';
    }
    if (s === 'in development' || s === 'in progress' || s === 'in test') {
        return 'tag-status-inprogress';
    }
    if (s === 'blocked') {
        return 'tag-status-blocked';
    }

    return '';
}

/** The raw Jira status tag, colored by status text (jiraStatusTagClass) — with Jira's own "Flagged"
 *  impediment marker folded into the same badge (the same flag SVG used for the "flags not tracked"
 *  warning in Technical view — see comp-name rendering — rather than a separate one, and rather than the
 *  base `.tag`'s plain block layout), since an issue can be flagged as an impediment regardless of what
 *  its current status text says. `null`/no status (fallback stub) renders nothing at all, flagged or not. */
function jiraStatusTagHtml(status, impediment){
    if (!status) {
        return '';
    }

    const cls = jiraStatusTagClass(status);

    if (!impediment) {
        return Tag({ text: status, cls, title: 'Jira status' });
    }

    return Tag({ text: status, cls, title: 'Jira status (flagged as impediment)', icon: ICONS.flag });
}

/** Sub-task completion — surfaces exactly the gap a parent issue's own status can hide (a Story can read
 *  "In Test" or even "Done" while open sub-tasks/bugs remain, the case that prompted adding this).
 *  `null` (no sub-tasks at all) renders nothing; fully done gets the same green border as the "Done"
 *  status tag, anything still in flight gets the same blue as an in-progress status. */
function subtasksTagHtml(subtasks){
    if (!subtasks) {
        return '';
    }

    const cls = subtasks.done === subtasks.total ? 'tag-status-done' : 'tag-status-inprogress';

    return Tag({ text: `${subtasks.done}/${subtasks.total} sub-tasks`, cls, title: 'Sub-tasks' });
}

function issueEnvDate(issue, env){
    let latest = null;
    const consider = (isoStr) => {
        if (!isoStr) return;

        const t = new Date(isoStr);

        if (!latest || t > latest) {
            latest = t;
        }
    };

    issueLinks(issue).forEach(l => {
        const dep = issueDeployedOnComponent(l.component, issue, env);

        if (dep) {
            consider(dep.deployedAt);
        }

        const fs = effectiveFlagState(state.flagStates[l.flagKey] ? state.flagStates[l.flagKey][env] : null);

        if (fs) {
            consider(fs.changedAt);
        }
    });

    // For flag-less (fallback-derived) issues, fall back to raw deployment dates too.
    if (!issueLinks(issue).length) {
        state.deployments
            .filter(d => d.environment === env && d.status === 'success' && deploymentNamesAny(d, issueKeys(issue)))
            .forEach(d => consider(d.deployedAt));
    }

    return latest;
}
function issueLastChange(issue){
    const dates = [issueEnvDate(issue, ENVIRONMENT.TEST), issueEnvDate(issue, ENVIRONMENT.QA), issueEnvDate(issue, ENVIRONMENT.PROD)].filter(Boolean);

    if (!dates.length) {
        return null;
    }

    return dates.reduce((latest, d) => (d > latest ? d : latest));
}

/** True for a real increment -- a SAFe PI ("PI-24.4") or, for a team that doesn't work in PIs, a sprint ("PAY Sprint
 *  1") -- and false for a placeholder like "—" or nothing at all. */
function isRealPi(pi){
    return !!pi && pi !== '—';
}

/** Sorts PI labels ("PI-27.2") and sprint names (any string with a "27.2.3"-shaped run of numbers in it,
 *  same numeric shape the server's extractPiFromSprintName looks for) newest-first, e.g. 27.2 before
 *  26.5, and 27.2.3 before 27.2.2. Falls back to a plain descending string compare when neither string has
 *  that shape, so an odd/unassigned label still sorts deterministically instead of throwing. */
function compareVersionDesc(a, b){
    const numsOf = s => (s.match(/\d+/g) || []).map(Number);
    const na = numsOf(a);
    const nb = numsOf(b);

    // A label with no digits at all (e.g. the "Unassigned sprint" fallback) has nothing to compare
    // numerically — always push it after any label that does have digits, rather than let it tie-break
    // against one arbitrarily via string comparison.
    if (!na.length || !nb.length) {
        if (na.length !== nb.length) {
            return na.length ? -1 : 1;
        }
    } else {
        const len = Math.min(na.length, nb.length);

        for (let i = 0; i < len; i++) {
            const diff = nb[i] - na[i];

            if (diff !== 0) {
                return diff;
            }
        }

        // Shared numeric prefix is identical but one label has extra trailing digit groups (e.g. a PI-only
        // "Sprint 27.2" alongside a fully-qualified "27.2.3 Sprint") — there's no principled way to say
        // which is "newer" from the numbers alone, so fall through to the same string tiebreak below
        // instead of defaulting the shorter one to always lose.
    }

    return b.localeCompare(a);
}

/* ---------- Rendering: Product / PI view ---------- */

/** Work-item type display order for Product view — Bugs first (per the ideation session: a Bug sitting
 *  under an Epic is the one thing most likely to need attention, so it should never be buried below
 *  Stories/Tasks), then Story, then Task (the type product people care about least). `Epic` only matters
 *  here for the Type filter's own option order (`refreshProductViewFilterOptions()`) — it's never a
 *  member of a `children`/`ungrouped` list sorted by this, since an Epic is always its own group header. */
const WORK_ITEM_TYPE_ORDER = [ISSUE_TYPE.EPIC, ISSUE_TYPE.BUG, ISSUE_TYPE.STORY, ISSUE_TYPE.TASK];
function typeSortRank(type){
    const idx = WORK_ITEM_TYPE_ORDER.indexOf(type);

    return idx === -1 ? WORK_ITEM_TYPE_ORDER.length : idx;
}

/** Groups a filtered issue list by Epic — Epic-type issues become pure group headers (never their own
 *  row, since an Epic never has a deployment of its own to show a status for), Story/Task/Bug group under
 *  their resolved `epicKey`. Anything with neither (no epicKey and not itself an Epic) falls into
 *  `ungrouped`, so nothing silently disappears. Group order follows first-encounter order in `issues`. */
function groupIssuesByEpic(issues){
    const groups = new Map();
    const order = [];
    const ungrouped = [];

    const ensureGroup = (epicKey, epicTitle) => {
        if (!groups.has(epicKey)) {
            groups.set(epicKey, { epicKey, epicTitle: epicTitle || null, epicIssue: null, children: [] });
            order.push(epicKey);
        }

        const group = groups.get(epicKey);

        if (epicTitle && !group.epicTitle) {
            group.epicTitle = epicTitle;
        }

        return group;
    };

    issues.forEach(issue => {
        if (issue.type === ISSUE_TYPE.EPIC) {
            ensureGroup(issue.key, issue.title).epicIssue = issue;
        } else if (issue.epicKey) {
            ensureGroup(issue.epicKey, issue.epicTitle).children.push(issue);
        } else {
            ungrouped.push(issue);
        }
    });

    const groupList = order.map(key => groups.get(key));

    // Bug, then Story, then Task within each epic (and within "Ungrouped") — a stable sort, so items of
    // the same type keep whatever relative order they already had (date/pagination order from the caller).
    groupList.forEach(g => g.children.sort((a, b) => typeSortRank(a.type) - typeSortRank(b.type)));
    ungrouped.sort((a, b) => typeSortRank(a.type) - typeSortRank(b.type));

    return { groups: groupList, ungrouped };
}

/** How many of an Epic's (filtered) children are strictly `released` on prod (flag confirmed on) — the
 *  same bucket the summary tiles/`prodStatusBucket()` count as "Released", not the broader
 *  `issueIsReleasedToProd()` (which also counts `deployed_code_only`, i.e. code shipped with no flag to
 *  confirm against). Deliberately the stricter of the two: conflating "code deployed, unconfirmed" into
 *  this badge's "released" count would hide exactly the signal that should prompt someone to go check the
 *  actual flag state for that environment, and would make this badge disagree with the tiles rendered
 *  right above it for the same PI. `null` when there are no children to roll up (e.g. a Type filter hid
 *  them all, leaving just the Epic itself). `code` (shipped to prod but flag off / no flag to confirm) is
 *  returned alongside only so the progress bar can show it as a layer under `released` — the
 *  "N/M released" label and badge still use `released` alone. */
function epicRollup(children){
    if (!children.length) {
        return null;
    }

    return {
        released: children.filter(c => prodStatusBucket(c) === 'released').length,
        code: children.filter(c => prodStatusBucket(c) === 'code').length,
        total: children.length,
    };
}

/** Buckets an issue's PROD status into the 4 summary-row/status-tile buckets: released, code (shipped
 *  but hidden behind a flag, or shipped with no flag to check at all — same "shipped, visibility
 *  unconfirmed" grouping the Insights chart already uses), partial, or none. */
function prodStatusBucket(issue){
    const level = issueStatusForEnv(issue, ENVIRONMENT.PROD).level;

    if (level === RELEASE_LEVEL.RELEASED) {
        return 'released';
    }
    if (level === RELEASE_LEVEL.DEPLOYED || level === RELEASE_LEVEL.DEPLOYED_CODE_ONLY) {
        return 'code';
    }
    if (level === RELEASE_LEVEL.PARTIAL) {
        return 'partial';
    }

    return 'none';
}

/** Gap A — "ghost flag" aging: code deployed to an env but its flag has been left off (or only
 *  partially on) for too long — SAFe calls this unconsumed value accumulating as risk with zero benefit
 *  to users. Threshold is in days, not sprints, since sprint length isn't guaranteed uniform across
 *  boards/teams (Product view gap analysis, Gap A). Mirrors flagStaleWarning()'s
 *  days-since-changedAt arithmetic in the opposite direction (OFF, not ON) — but scoped to a single
 *  issue/env via issueStatusForEnv()'s own link resolution, so this always agrees with whatever status
 *  pill the row is already showing instead of re-deriving link status from scratch. */
const GHOST_FLAG_DAYS = 30;
function ghostFlagAge(issue, env){
    const status = issueStatusForEnv(issue, env);

    if (status.level !== RELEASE_LEVEL.DEPLOYED && status.level !== RELEASE_LEVEL.PARTIAL) {
        return null;
    }

    const stuckLinks = status.results.filter(r => r.deployed && !r.released && r.deployment && r.deployment.deployedAt);

    if (!stuckLinks.length) {
        return null;
    }

    const since = Math.min(...stuckLinks.map(r => {
        const deployedAt = new Date(r.deployment.deployedAt).getTime();
        const flagChangedAt = r.flagChangedAt ? new Date(r.flagChangedAt).getTime() : deployedAt;

        return Math.max(deployedAt, flagChangedAt);
    }));
    const days = Math.floor((Date.now() - since) / 86400000);

    return days >= GHOST_FLAG_DAYS ? { days } : null;
}

/** Gap D — a Bug among an Epic's in-scope children that isn't resolved yet signals the Epic isn't really
 *  ready for business sign-off even if its Stories look fine — surfaced regardless of which env/status
 *  the Bug itself is at, since even a Bug still "In Progress" on Test is a reason to hold off. */
function epicHasOpenBug(children){
    return children.some(c => c.type === ISSUE_TYPE.BUG && c.statusCategory !== 'done');
}

/** The PI the team is presumed to be working in right now — resolved server-side (server/lib/jira-model.js) (from a
 *  configured board's active sprint, falling back to the highest PI seen among synced non-Epic issues —
 *  see CLAUDE.md's Jira issues section) and shipped in `jiraIndex`; `state.jiraIssues` holds
 *  only the selected PI (`state.selectedPi`), so it can't be found client-side. */
function currentPi(){
    return (state.jiraIndex && state.jiraIndex.currentPi) || null;
}

/** The index entry of an increment (`jiraIndex.pis`), or null. */
function incrementEntry(pi){
    return ((state.jiraIndex && state.jiraIndex.pis) || []).find(e => e.pi === pi) || null;
}

/** How an increment is shown: its label when the index gives one (the server's "Now" entry), else its name. */
function incrementLabel(pi){
    const entry = incrementEntry(pi);

    return (entry && entry.label) || pi;
}

/** The real increments the selected one stands for: itself, or -- for the server's "Now" entry, which joins every
 *  team's current increment (a SAFe PI next to a Scrum team's sprint) -- each of those. */
function selectedIncrements(){
    const entry = incrementEntry(state.selectedPi);

    return entry && Array.isArray(entry.includes) ? entry.includes : [state.selectedPi];
}

/** The one sentinel `state.selectedSprint` value — anything else is a literal sprint name (`issue.sprint`,
 *  e.g. "Sparks 27.3.1") to filter down to directly. `''` ("All sprints") is Product view's long-standing
 *  default scope (the whole PI). Deliberately no separate "current sprint" sentinel, for the same reason
 *  the global PI `<select>` doesn't have one either: the current sprint is just a literal option, marked
 *  "(current)" and preselected by default (see `refreshSprintSelect()`) — one way to pick "the current
 *  one," not two. */
const SPRINT_ALL = '';

/** Gap B's hybrid scope sentinel (Product view gap analysis) — a third,
 *  explicit option next to "All sprints"/a literal sprint name (not a replacement for either): the
 *  current sprint's items regardless of status, plus older-sprint items in the same PI that aren't yet
 *  `released`, so an Epic spanning several sprints still shows its real completion state instead of
 *  burying still-open work from a prior sprint. Value is deliberately not a plausible real Jira sprint
 *  name, so it can never collide with one. */
const SPRINT_CURRENT_PLUS_UNRESOLVED = '__current_plus_unresolved__';

/** The sprint objects (`{name, startDate, endDate}`) `jiraIndex` carries for whichever PI is currently
 *  loaded — the same list the server rolls up from the raw Jira Sprint field, at zero extra fetch
 *  cost (see CLAUDE.md's Jira issues section). */
function sprintsForSelectedPi(){
    const entry = (state.jiraIndex && state.jiraIndex.pis || []).find(e => e.pi === state.selectedPi);

    return (entry && entry.sprints) || [];
}

/** Sprint name(s) covering *today* for the currently-loaded PI, used to scope the view — every match
 *  rather than collapsing to one (a board can legitimately have more than one sprint
 *  active). Only meaningful for the org's real current PI — a past PI the org has already moved on from
 *  has no "current sprint" of its own, by definition. Falls back to the most recently *started* sprint
 *  when none covers today (a gap between sprints) so switching into the current PI right after one sprint
 *  ends and before the next starts still lands somewhere sensible; returns `[]` when nothing can be
 *  resolved at all (no sprint-date data for this PI), in which case callers treat that like "All sprints"
 *  rather than showing nothing. */
function currentSprintNames(){
    if (!state.selectedPi || state.selectedPi !== currentPi()) {
        return [];
    }

    const withDates = sprintsForSelectedPi().filter(s => s.startDate && s.endDate);
    const now = Date.now();
    const active = withDates.filter(s => new Date(s.startDate).getTime() <= now && now <= new Date(s.endDate).getTime());

    if (active.length) {
        return active.map(s => s.name);
    }

    const mostRecent = withDates.slice().sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0];

    return mostRecent ? [mostRecent.name] : [];
}

/** Resolves `state.selectedSprint` to the sprint name to filter issues down to, or `null` for "no filter"
 *  (All sprints). */
function selectedSprintNames(){
    return state.selectedSprint ? [state.selectedSprint] : null;
}

/** Narrows an issue list to the current sprint scope — a pure display filter layered on top of the
 *  PI scope `state.jiraIssues` already is (see CLAUDE.md's Jira issues section: Product view always lists
 *  a whole PI's data client-side; this never changes which PI's shard is loaded, only which of its issues
 *  are shown). Epics typically have no `sprint` of their own in Jira, so a specific-sprint scope quietly
 *  excludes them from this list — `groupIssuesByEpic()` already copes with an Epic header that has no
 *  `epicIssue` of its own (built instead from a child that *does* pass), so a child in-scope still shows
 *  up grouped correctly even though its Epic's own row didn't pass this filter. */
function issuesInSprintScope(issues){
    if (state.selectedSprint === SPRINT_CURRENT_PLUS_UNRESOLVED) {
        const currentNames = currentSprintNames();

        return issues.filter(i => currentNames.includes(i.sprint) || (isRealPi(i.pi) && prodStatusBucket(i) !== 'released'));
    }

    const names = selectedSprintNames();

    return names ? issues.filter(i => names.includes(i.sprint)) : issues;
}

/** `state.issueStatusIndex` (cross-PI, from the server's buildJiraIndex()) knows
 *  which PI an issue key belongs to *right now*, independent of whichever PI shard happens to be loaded
 *  into `state.jiraIssues`. An issue that moved to a different PI since the currently-selected PI's shard
 *  was last synced would otherwise just sit there showing a status frozen at that last-sync moment, with
 *  no indication it's stale — this small badge is the only signal of that on the row itself. */
function piContinuationBadge(issueKey){
    const entry = state.issueStatusIndex[issueKey];

    if (!entry || !entry.pi || selectedIncrements().includes(entry.pi)) {
        return '';
    }

    return Tag({ text: `Continued in ${entry.pi}`, cls: 'tag-pi-continued', title: `This item moved to PI ${entry.pi} — its status may have changed since` });
}

/** Non-Epic issue counts for the currently-loaded PI *and sprint scope*, bucketed by PROD status — epics
 *  are never counted directly (per the Product view summary row spec), only their children. */
function piWorkItemCounts(){
    const counts = { released: 0, code: 0, partial: 0, none: 0 };
    const items = issuesInSprintScope(state.jiraIssues).filter(i => i.type !== ISSUE_TYPE.EPIC);

    items.forEach(i => { counts[prodStatusBucket(i)]++; });

    return { counts, total: items.length };
}

