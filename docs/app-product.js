let activeStatusTile = null;

/** Product view summary row (§4.1): a "Current PI" snapshot card + 4 status tiles that double as a
 *  PROD-status filter for the table below (see `activeStatusTile`, read by renderIssues()). */
function renderProductSummary(){
    const box = document.getElementById('pvSummary');
    const targetPi = state.selectedPi;
    const showCurrentTag = !!targetPi && targetPi === currentPi();
    const { counts, total } = piWorkItemCounts();
    const onProd = counts.released + counts.code;
    const pct = n => total ? (n / total * 100) : 0;

    // Single fill (the overall "on prod" share) per §4.1 — the per-status breakdown lives in the 4
    // tiles below instead of a multi-segment bar.
    const piCardHtml = PiCard({ name: targetPi && incrementLabel(targetPi), isCurrent: showCurrentTag, total, onProd, onProdPct: pct(onProd) });

    const tiles = [
        { key: 'released', label: 'Released', color: 'var(--nd-released)', value: counts.released },
        { key: 'code', label: 'Code deployed', color: 'var(--nd-code)', value: counts.code },
        { key: 'partial', label: 'Partial', color: 'var(--nd-warn)', value: counts.partial },
        { key: 'none', label: 'Not deployed', color: 'var(--nd-fg-4)', value: counts.none },
    ];

    // Not clickable for now (see activeStatusTile/prodStatusBucket in renderIssues, kept in place so
    // this is a one-line revert — just re-add the .pv-tile click wiring below to turn tile-click
    // filtering back on): plain <div>s instead of <button>s, so they don't look/focus like controls.
    const tilesHtml = tiles.map(t => StatusTile({
        tileKey: t.key, label: t.label, color: t.color, value: t.value,
        percent: total ? Math.round(t.value/total*100) : 0, active: activeStatusTile === t.key,
    }));

    box.innerHTML = html`${piCardHtml}${tilesHtml}`;
}

/** Reads the Product view filter controls and applies them (plus the PI/sprint scope) to `state.jiraIssues`.
 *  Pure data selection — no HTML. Returns the filtered list, the per-Epic children used by the rollup badge,
 *  and whether rows should carry a sprint badge. */
function selectProductIssues(){
    const typeFilter = document.getElementById('filterType').value;
    const priorityFilter = document.getElementById('filterPriority').value;
    const hideTasks = document.getElementById('filterHideTasks').checked;
    const fromVal = document.getElementById('filterFrom').value;
    const toVal = document.getElementById('filterTo').value;
    const from = fromVal ? new Date(fromVal) : null;
    const to = toVal ? new Date(new Date(toVal).getTime()+86400000) : null;
    // `state.jiraIssues` already only holds the currently-selected PI's issues (see `state.selectedPi`);
    // issuesInSprintScope() narrows that further to the selected sprint (or leaves it alone for "All
    // sprints") — just the date range is left to filter here.
    const passesDate = i => {
        const last = issueLastChange(i);

        if (from && (!last || last < from)) {
            return false;
        }
        if (to && last && last > to) {
            return false;
        }

        return true;
    };

    const sprintScoped = issuesInSprintScope(state.jiraIssues);

    // Shown only for "All sprints" and the Gap B hybrid — both mix items from more than one sprint, so
    // the per-row badge is what tells them apart. Hidden once the Sprint select is scoped to one
    // specific sprint (a literal name, including "Current sprint (X)"), since every row would just repeat
    // whatever the select above already says.
    const showSprintBadge = state.selectedSprint === SPRINT_ALL || state.selectedSprint === SPRINT_CURRENT_PLUS_UNRESOLVED;

    // Deliberately date-filtered but NOT type/priority/status-tile-filtered — an Epic's rollup badge
    // should still reflect its real children even when Type, Priority, or a status tile hides them from
    // `allIssues` below.
    const rollupChildrenByEpicKey = new Map();

    sprintScoped.filter(passesDate).forEach(i => {
        if (i.type === ISSUE_TYPE.EPIC || !i.epicKey) {
            return;
        }
        if (!rollupChildrenByEpicKey.has(i.epicKey)) {
            rollupChildrenByEpicKey.set(i.epicKey, []);
        }

        rollupChildrenByEpicKey.get(i.epicKey).push(i);
    });

    const allIssues = sprintScoped.filter(i =>
        passesDate(i)
        && (!typeFilter || i.type === typeFilter)
        && (!priorityFilter || i.priority === priorityFilter)
        && (!activeStatusTile || prodStatusBucket(i) === activeStatusTile)
        && (!hideTasks || i.type !== ISSUE_TYPE.TASK)
    );

    return { allIssues, rollupChildrenByEpicKey, showSprintBadge };
}

/** The expanded per-component code/flag breakdown shown under an open issue row. */
function issueBreakdownHtml(issue){
    const rows = issueLinks(issue).map(l => ({
        component: l.component,
        flagKey: l.flagKey,
        envs: ENVIRONMENTS.map(env => linkStatus(l, issue.key, env)),
    }));
    const anyCodeDeployed = ENVIRONMENTS.some(env => statusLabel(issueStatusForEnv(issue, env).level) === 'Code deployed');

    return IssueBreakdown({
        issueKey: issue.key,
        rows,
        noFlagReason: anyCodeDeployed ? 'code found in deployment history, but no flag tracks it yet' : 'check flags-meta.json (jiraKeys)',
        dependency: issue.dependencyBlocked ? { note: issue.dependencyNote || 'unresolved' } : null,
    });
}

/** One work-item row (plus its breakdown when expanded). `indent` = child of an Epic vs. ungrouped. */
function issueRowHtml(issue, indent, showSprintBadge){
    const test = issueStatusForEnv(issue, ENVIRONMENT.TEST);
    const qa = issueStatusForEnv(issue, ENVIRONMENT.QA);
    const prod = issueStatusForEnv(issue, ENVIRONMENT.PROD);
    const ghost = ghostFlagAge(issue, ENVIRONMENT.PROD);
    const testDate = issueEnvDate(issue, ENVIRONMENT.TEST);
    const qaDate = issueEnvDate(issue, ENVIRONMENT.QA);
    const prodDate = issueEnvDate(issue, ENVIRONMENT.PROD);
    const isOpen = expandedIssue === issue.key;
    const envCell = (env, status, date) => StatusCell({
        pill: StatusPill({ cls: statusClass(status.level), label: statusLabel(status.level), title: statusLabelTooltip(status.level) }),
        dateText: date ? relTime(date.toISOString()) : '—',
    });
    const prodCell = prod.blocked
        ? StatusCell({
            pill: StatusPill({ cls: 'st-dependency', label: 'Dependency', title: 'Feature held back — waiting on another, unfinished dependency' }),
            dateText: issue.dependencyNote || 'blocked by a dependency',
        })
        : envCell(ENVIRONMENT.PROD, prod, prodDate);
    const badges = html`
          ${jiraStatusTagHtml(issue.status, issue.impediment)}
          ${subtasksTagHtml(issue.subtasks)}
          ${ghost ? Tag({ text: `Prod ${ghost.days}d · flag OFF`, cls: 'tag-ghost-flag', title: `Deployed to prod with its flag still off/partial for ${GHOST_FLAG_DAYS}+ days`, icon: ICONS.hourglass }) : ''}
          ${issue.projectName ? Tag({ text: issue.projectName, title: 'Jira project' }) : ''}
          ${showSprintBadge && issue.sprint ? SprintTag({ sprint: issue.sprint }) : ''}
          ${piContinuationBadge(issue.key)}`;

    return IssueRow({
        rowClass: indent ? 'wi-child-row' : 'wi-ungrouped-row',
        issueKey: issue.key,
        href: `${JIRA_BASE_URL}/${issue.key}`,
        title: issue.title && issue.title !== '—' ? issue.title : '',
        type: issue.type,
        badges,
        cells: html`${envCell(ENVIRONMENT.TEST, test, testDate)}${envCell(ENVIRONMENT.QA, qa, qaDate)}${prodCell}`,
        breakdown: isOpen ? issueBreakdownHtml(issue) : '',
    });
}

/** An Epic section header: title, badges and the "N/M released to PROD" rollup over `epicChildren`. */
function epicHeaderHtml(group, epicChildren, showSprintBadge){
    const rollup = epicRollup(epicChildren);
    const ghostCount = epicChildren.filter(c => ghostFlagAge(c, ENVIRONMENT.PROD)).length;
    const hasOpenBug = epicHasOpenBug(epicChildren);
    // Explicit, binary signal — not just the progress bar below reaching 100% — for "every one of
    // this epic's in-scope children is released to prod" (Product view gap analysis).
    // Deliberately not extended to a Story's own sub-tasks the same way: a Story's own flag/deploy
    // status and its sub-tasks' Jira completion are different signals, and gating one on the other
    // would make a feature that's genuinely already live for users read as "not released" over
    // unrelated Jira housekeeping.
    const fullyReleased = !!rollup && rollup.total > 0 && rollup.released === rollup.total;
    const sprintHtml = showSprintBadge && group.epicIssue && group.epicIssue.sprint ? SprintTag({ sprint: group.epicIssue.sprint }) : '';
    const statusHtml = group.epicIssue ? jiraStatusTagHtml(group.epicIssue.status, group.epicIssue.impediment) : '';
    const badges = html`
            ${statusHtml}
            ${fullyReleased ? Tag({ text: 'Fully released', cls: 'tag-status-done', title: 'Every in-scope child of this epic is released to prod', icon: ICONS.check }) : ''}
            ${hasOpenBug ? Tag({ text: 'Open bug', cls: 'tag-status-blocked', title: "At least one open Bug among this epic's in-scope work items", icon: ICONS.bug }) : ''}
            ${ghostCount ? Tag({ text: `${ghostCount} ghost flag${ghostCount===1?'':'s'}`, cls: 'tag-ghost-flag', title: `${ghostCount} work item${ghostCount===1?'':'s'} deployed to prod with its flag still off/partial for ${GHOST_FLAG_DAYS}+ days`, icon: ICONS.hourglass }) : ''}
            ${subtasksTagHtml(group.epicIssue && group.epicIssue.subtasks)}
            ${sprintHtml}`;

    return EpicHeader({
        epicKey: group.epicKey,
        href: `${JIRA_BASE_URL}/${group.epicKey}`,
        title: group.epicTitle || group.epicKey,
        hasChildren: group.children.length > 0,
        collapsed: collapsedEpics.has(group.epicKey),
        badges,
        progress: rollup,
    });
}

/** Click handlers: a row toggles its breakdown, an Epic header toggles collapse. */
function bindIssueRowHandlers(body){
    body.querySelectorAll('.wi-child-row, .wi-ungrouped-row').forEach(row=> {
        row.onclick = ()=> {
            const key = row.dataset.key;
            expandedIssue = expandedIssue === key ? null : key;
            renderIssues();
        };
    });

    body.querySelectorAll('.wi-epic-row[data-epic-key]:not(.wi-epic-row-empty)').forEach(row=> {
        row.onclick = ()=> {
            const epicKey = row.dataset.epicKey;

            if (collapsedEpics.has(epicKey)) {
                collapsedEpics.delete(epicKey);
            } else {
                collapsedEpics.add(epicKey);
            }

            renderIssues();
        };
    });
}

function renderIssues(){
    const { allIssues, rollupChildrenByEpicKey, showSprintBadge } = selectProductIssues();

    document.getElementById('issueCount').innerHTML = ItemCount({ count: allIssues.length });

    const body = document.getElementById('issueBody');

    document.getElementById('productPanelBody').classList.toggle('wi-body-empty', !allIssues.length);

    if (!allIssues.length) {
        body.innerHTML = EmptyState({ message: 'No results for the selected filters' });
        return;
    }

    const issues = allIssues.slice(0, visibleIssueCount);
    const { groups, ungrouped } = groupIssuesByEpic(issues);
    const groupsHtml = groups.map(group => html`${epicHeaderHtml(group, rollupChildrenByEpicKey.get(group.epicKey) || [], showSprintBadge)}${collapsedEpics.has(group.epicKey) ? '' : group.children.map(c => issueRowHtml(c, true, showSprintBadge))}`);
    const ungroupedHtml = ungrouped.length
        ? html`${UngroupedLabelRow()}${ungrouped.map(issue => issueRowHtml(issue, false, showSprintBadge))}`
        : '';

    body.innerHTML = html`${groupsHtml}${ungroupedHtml}`;

    if (visibleIssueCount < allIssues.length) {
        body.innerHTML += LoadMoreSentinel({ id: 'issueLoadMore' });
    }

    bindIssueRowHandlers(body);
}

function resetIssuePagination(){
    visibleIssueCount = ISSUE_PAGE_SIZE;
    renderIssues();
}

/**
 * Repopulates the Sprint scope `<select>` from whichever PI is currently loaded (`index.json`'s `sprints`
 * for that PI) and resets `state.selectedSprint` to this PI's default — the literal current sprint's name
 * when one can be resolved, else "All sprints" (never the Gap B hybrid option below — that one is opt-in
 * only, never a default). Called once at init and again on every PI switch
 * (`initGlobalPiSelect()`); deliberately **not** called from the Sprint/Type/Priority "Clear" button,
 * since the sprint scope is a scope control like the global PI select, not an ordinary filter — clearing
 * filters shouldn't silently widen it back out to "All sprints".
 */
function refreshSprintSelect(){
    const sel = document.getElementById('filterSprint');
    const sprints = sprintsForSelectedPi();
    const currentNames = currentSprintNames();

    sel.innerHTML = '';

    if (!sprints.length) {
        sel.innerHTML = '<option value="">All sprints</option>';
        sel.disabled = true;
        sel.title = 'No sprint data for this PI';
        state.selectedSprint = SPRINT_ALL;

        return;
    }

    sel.disabled = false;
    sel.title = '';

    const allOpt = document.createElement('option');

    allOpt.value = SPRINT_ALL;
    allOpt.textContent = 'All sprints';
    sel.appendChild(allOpt);

    const sortedSprints = sprints.slice()
        .sort((a, b) => (a.startDate && b.startDate) ? new Date(b.startDate) - new Date(a.startDate) : compareVersionDesc(a.name, b.name));

    // Current sprint(s) right after "All sprints" — labeled "Current sprint (name)" rather than
    // "name (current)" so it reads as its own distinct choice at a glance, not a modifier tacked onto a
    // sprint name buried further down the list.
    sortedSprints.filter(s => currentNames.includes(s.name)).forEach(s => {
        const o = document.createElement('option');

        o.value = s.name;
        o.textContent = `Current sprint (${s.name})`;
        sel.appendChild(o);
    });

    // Gap B's hybrid option — only offered when a current sprint actually resolves (a past PI has none,
    // by currentSprintNames()'s own definition, so the hybrid would degenerate into "every unreleased
    // issue in the PI," which isn't what this option is for). Placed right after the current sprint
    // option(s) above, before the remaining (non-current) sprint names, per the implementation plan.
    // Not the default selection — see below.
    if (currentNames.length) {
        const hybridOpt = document.createElement('option');

        hybridOpt.value = SPRINT_CURRENT_PLUS_UNRESOLVED;
        hybridOpt.textContent = 'Current sprint + unresolved';
        sel.appendChild(hybridOpt);
    }

    // Remaining (non-current) sprints, newest-first.
    sortedSprints.filter(s => !currentNames.includes(s.name)).forEach(s => {
        const o = document.createElement('option');

        o.value = s.name;
        o.textContent = s.name;
        sel.appendChild(o);
    });

    // Multiple sprints can legitimately be "current" at once (more than one active board) — picking the
    // first (newest-started) one as the actual default selection is a deliberate simplification; "All
    // sprints" remains one click away for anyone who wants every current sprint together.
    state.selectedSprint = currentNames[0] || SPRINT_ALL;
    sel.value = state.selectedSprint;
}

/**
 * Repopulates the Type/Priority filter *options* from whichever PI is currently loaded — both are derived
 * from `state.jiraIssues`, which only ever holds one PI's worth of data now (see `state.selectedPi`), so
 * these can't just be set once at init any more; called again on every PI switch (`initGlobalPiSelect()`).
 */
function refreshProductViewFilterOptions(){
    const typeGroup = document.getElementById('filterTypeGroup');

    typeGroup.querySelectorAll('.segmented-btn:not([data-value=""])').forEach(b => b.remove());

    // Epic, Bug, Story, Task — same order the ideation session wants Bugs surfaced in within an epic
    // (see WORK_ITEM_TYPE_ORDER/groupIssuesByEpic()), applied here too for one consistent type ordering
    // across the whole Product view, not just within an expanded epic.
    const types = [...new Set(state.jiraIssues.map(i=> i.type))].sort((a, b) => typeSortRank(a) - typeSortRank(b));

    types.forEach(type => {
        const b = document.createElement('button');

        b.type = 'button';
        b.className = 'segmented-btn';
        b.dataset.value = type;
        b.textContent = type;
        typeGroup.appendChild(b);
    });

    const prioritySel = document.getElementById('filterPriority');

    prioritySel.querySelectorAll('option:not([value=""])').forEach(o => o.remove());

    const priorities = [...new Set(state.jiraIssues.map(i=> i.priority).filter(Boolean))].sort(comparePriorityDesc);

    priorities.forEach(priority => {
        const o = document.createElement('option');

        o.value = priority;
        o.textContent = priority;
        prioritySel.appendChild(o);
    });
}

function initProductView(){
    refreshProductViewFilterOptions();

    const typeGroup = document.getElementById('filterTypeGroup');
    const typeInput = document.getElementById('filterType');
    const prioritySel = document.getElementById('filterPriority');
    const sprintSel = document.getElementById('filterSprint');

    sprintSel.addEventListener('change', () => {
        state.selectedSprint = sprintSel.value;
        renderProductSummary();
        resetIssuePagination();
    });

    typeGroup.addEventListener('click', e => {
        const btn = e.target.closest('.segmented-btn');

        if (!btn) {
            return;
        }

        typeGroup.querySelectorAll('.segmented-btn').forEach(b=> b.classList.remove('active'));
        btn.classList.add('active');
        typeInput.value = btn.dataset.value;
        resetIssuePagination();
    });

    prioritySel.addEventListener('input', resetIssuePagination);

    // Gap E: an independent exclusion layered on top of the Type single-select (not a 5th segmented
    // option) — picking "Task" there while this is also on just yields an empty list, same as any other
    // impossible filter combination elsewhere in this view; no special-casing needed.
    document.getElementById('filterHideTasks').addEventListener('change', resetIssuePagination);

    ['filterFrom','filterTo'].forEach(id=> document.getElementById(id).addEventListener('input', resetIssuePagination));
    document.getElementById('btnClearFilters').onclick = ()=> {
        typeGroup.querySelectorAll('.segmented-btn').forEach(b=> b.classList.remove('active'));
        typeGroup.querySelector('.segmented-btn[data-value=""]').classList.add('active');
        typeInput.value='';
        prioritySel.value='';
        document.getElementById('filterFrom').value='';
        document.getElementById('filterTo').value='';
        document.getElementById('filterHideTasks').checked = false;
        activeStatusTile = null;
        renderProductSummary();
        resetIssuePagination();
    };

    document.getElementById('productPanelBody').addEventListener('scroll', function(){
        if (this.scrollTop + this.clientHeight >= this.scrollHeight - 100) {
            const savedScroll = this.scrollTop;

            visibleIssueCount += ISSUE_PAGE_SIZE;
            renderIssues();
            this.scrollTop = savedScroll;
        }
    });
}

/**
 * Repopulates the Service/Type filter *options* from whichever PI is currently loaded — both are derived
 * from `state.jiraIssues`, which only ever holds one PI's worth of data now (see `state.selectedPi`), so
 * these can't just be set once at init any more; called again on every PI switch (`initGlobalPiSelect()`).
 * Leaves the "All" option/button (never removed) and whatever's currently selected alone — callers that
 * want a fresh start after a PI switch reset the actual filter values themselves.
 */
function refreshReleaseNotesFilterOptions(){
    const allRealPiIssues = state.jiraIssues.filter(i => isRealPi(i.pi));

    const appSel = document.getElementById('filterNotesApp');

    appSel.querySelectorAll('option:not([value=""])').forEach(o => o.remove());

    const apps = orderedApplications([...new Set(allRealPiIssues.flatMap(applicationsForIssue))]);

    apps.forEach(app => {
        const o = document.createElement('option');

        o.value = app;
        o.textContent = app;
        appSel.appendChild(o);
    });

    const typeGroup = document.getElementById('filterNotesTypeGroup');

    typeGroup.querySelectorAll('.segmented-btn:not([data-value=""])').forEach(b => b.remove());

    // Same order as Product view's own Type filter (WORK_ITEM_TYPE_ORDER/typeSortRank), not a plain
    // alphabetical sort, so the two tabs' filters read consistently.
    const types = [...new Set(allRealPiIssues.map(i => i.type))].sort((a, b) => typeSortRank(a) - typeSortRank(b));

    types.forEach(type => {
        const b = document.createElement('button');

        b.type = 'button';
        b.className = 'segmented-btn';
        b.dataset.value = type;
        b.textContent = type;
        typeGroup.appendChild(b);
    });
}

function initReleaseNotesFilters(){
    refreshReleaseNotesFilterOptions();

    const appSel = document.getElementById('filterNotesApp');
    const typeGroup = document.getElementById('filterNotesTypeGroup');
    const typeInput = document.getElementById('filterNotesType');

    typeGroup.addEventListener('click', e => {
        const btn = e.target.closest('.segmented-btn');

        if (!btn) {
            return;
        }

        typeGroup.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        typeInput.value = btn.dataset.value;
        renderReleaseNotes();
    });

    appSel.addEventListener('input', renderReleaseNotes);
    document.getElementById('btnClearNotesFilters').onclick = () => {
        appSel.value = '';
        typeGroup.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
        typeGroup.querySelector('.segmented-btn[data-value=""]').classList.add('active');
        typeInput.value = '';
        renderReleaseNotes();
    };
}

