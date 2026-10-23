/**
 * Delivery summary (the code keeps the old name, Release Notes): real (non-fallback-stub) Jira issues released to
 * prod (`issueIsReleasedToProd()`), as a list of sprints on the left and the selected sprint on the right —
 * figures, then "Features & improvements" and "Bug fixes". Narrowed by the Service (application, via
 * `state.componentsOrder`) and Type filters. Purely derived from `state` — no data file or request of its own
 * beyond what loadData() already fetches.
 */

/** The sprint shown on the right, as its `sprintKey`; null (or one the filters no longer list) = the newest one. */
let selectedNotesSprint = null;

const NO_SPRINT = 'Unassigned sprint';

/** A sprint's identity across increments (two PIs can have sprints of the same name). */
function notesSprintKey(pi, sprint){
    return JSON.stringify([pi, sprint]);
}

/**
 * What the tab shows, from `state` and the two filters: per increment (newest first) its sprints (newest first)
 * with their released items, split into features and bugs, and the last time any of them reached PROD. `reason`
 * says why there is nothing to show: `none` (no issues synced), `stubs` (only fallback stubs, no real PI),
 * `filtered` (filters match nothing), `unreleased` (nothing on PROD yet); null when there is something.
 *
 * @param {{ app: string, type: string }} filters
 * @returns {{ reason: string|null, groups: Array<{ pi: string, isCurrent: boolean, features: number, bugs: number,
 *   sprints: Array<{ key: string, pi: string, sprint: string, isCurrent: boolean, items: object[], features: object[], bugs: object[], lastProdAt: number|null }> }> }}
 */
function releaseNotesModel({ app, type }){
    const realPi = state.jiraIssues.filter(i => isRealPi(i.pi));
    const filtered = realPi.filter(i => (!app || applicationsForIssue(i).includes(app)) && (!type || i.type === type));
    const released = filtered.filter(issueIsReleasedToProd);
    let reason = null;

    if (!state.jiraIssues.length) {
        reason = 'none';
    } else if (!realPi.length) {
        reason = 'stubs';
    } else if (!filtered.length) {
        reason = 'filtered';
    } else if (!released.length) {
        reason = 'unreleased';
    }

    const currentSprints = currentSprintNames();
    const byPi = new Map();

    released.forEach(issue => {
        const sprint = issue.sprint || NO_SPRINT;
        const sprints = byPi.get(issue.pi) || byPi.set(issue.pi, new Map()).get(issue.pi);

        (sprints.get(sprint) || sprints.set(sprint, []).get(sprint)).push(issue);
    });

    const groups = [...byPi.keys()].sort(compareVersionDesc).map(pi => {
        const sprints = [...byPi.get(pi).keys()].sort(compareVersionDesc).map(sprint => {
            const items = byPi.get(pi).get(sprint).map(issue => ({
                issue,
                level: issueStatusForEnv(issue, ENVIRONMENT.PROD).level,
                prodAt: earliestProdDeployedAt(issue),
            }));
            const times = items.map(i => i.prodAt).filter(t => t !== null);

            return {
                key: notesSprintKey(pi, sprint),
                pi,
                sprint,
                isCurrent: pi === currentPi() && currentSprints.includes(sprint),
                items,
                features: items.filter(i => i.issue.type !== ISSUE_TYPE.BUG),
                bugs: items.filter(i => i.issue.type === ISSUE_TYPE.BUG),
                lastProdAt: times.length ? Math.max(...times) : null,
            };
        });

        return {
            pi,
            isCurrent: pi === currentPi(),
            features: sprints.reduce((n, s) => n + s.features.length, 0),
            bugs: sprints.reduce((n, s) => n + s.bugs.length, 0),
            sprints,
        };
    });

    return { reason, groups };
}

/** The sprint the right-hand panel shows: the selected one if it is still listed, else the newest. */
function selectedNotesSprintOf(groups){
    const sprints = groups.flatMap(g => g.sprints);

    return sprints.find(s => s.key === selectedNotesSprint) || sprints[0] || null;
}

const EMPTY_NOTES_MESSAGES = {
    none: () => 'No issues synced from Jira yet',
    // "Synced, but every issue is a commit-derived stub" (no title/PI/status) is a different, more actionable thing to
    // tell someone than "nothing here".
    stubs: () => `Found ${state.jiraIssues.length} synced issue(s), but none have a real PI yet — this usually means the Jira sync couldn't reach Jira and fell back to commit-derived stubs (no title/PI/status). See FAQ.md → "Where do the Epic/Story/Task numbers come from?".`,
    filtered: () => 'No results for the selected filters',
    unreleased: () => 'Found real-PI issues, but none are released to PROD yet.',
};

/** "7 items · 1 bug fix". */
function notesCountsText(sprint){
    const bugs = sprint.bugs.length;

    return `${sprint.items.length} item${sprint.items.length === 1 ? '' : 's'}${bugs ? ` · ${bugs} bug fix${bugs === 1 ? '' : 'es'}` : ''}`;
}

function renderReleaseNotes(){
    const box = document.getElementById('releaseNotesBody');
    const { reason, groups } = releaseNotesModel({
        app: document.getElementById('filterNotesApp').value,
        type: document.getElementById('filterNotesType').value,
    });

    if (reason) {
        box.innerHTML = EmptyState({ message: EMPTY_NOTES_MESSAGES[reason](), panel: true });
        return;
    }

    const selected = selectedNotesSprintOf(groups);
    const groupsHtml = groups.map(g => DeliverySprintGroup({
        label: incrementLabel(g.pi),
        isCurrent: g.isCurrent,
        features: g.features,
        bugs: g.bugs,
        cards: g.sprints.map(s => {
            const at = s.lastProdAt === null ? null : new Date(s.lastProdAt);

            return DeliverySprintCard({
                sprintKey: s.key,
                day: at ? String(at.getDate()).padStart(2, '0') : '—',
                month: at ? at.toLocaleDateString('en-US', { month: 'short' }).toUpperCase() : '',
                title: s.sprint,
                isCurrent: s.isCurrent,
                countsText: notesCountsText(s),
                active: s === selected,
            });
        }),
    }));

    // The PROD pill stays on every row: issueIsReleasedToProd folds `released` (a flag confirms it is visible) and
    // `deployed_code_only` (code shipped, no flag to confirm against) together, and nothing else here tells them apart.
    const itemHtml = ({ issue, level, prodAt }) => DeliveryItem({
        href: jiraIssueUrl(issue.key),
        title: issue.title,
        type: issue.type,
        issueKey: issue.key,
        pill: StatusPill({ cls: statusClass(level), label: statusLabel(level), title: statusLabelTooltip(level) }),
        dateText: prodAt ? fmtDateShort(prodAt) : '',
    });
    const released = selected.items.filter(i => i.level === RELEASE_LEVEL.RELEASED).length;
    const last = selected.lastProdAt === null ? '' : `last on prod ${fmtDateShort(selected.lastProdAt)}`;

    box.innerHTML = DeliveryLayout({
        groups: groupsHtml,
        panel: DeliverySprintPanel({
            note: [selected.isCurrent ? 'Current sprint' : '', last].filter(Boolean).join(' · '),
            title: selected.sprint,
            stats: [
                DeliveryStat({ value: selected.items.length, label: 'items on prod' }),
                DeliveryStat({ value: released, label: 'released to users', tone: 'released' }),
                DeliveryStat({ value: selected.items.length - released, label: 'code deployed, no flag', tone: 'code' }),
                DeliveryStat({ value: selected.bugs.length, label: 'bugs fixed' }),
            ],
            sections: [
                selected.features.length ? DeliverySection({ label: 'Features & improvements', tone: 'feature', items: selected.features.map(itemHtml) }) : '',
                selected.bugs.length ? DeliverySection({ label: 'Bug fixes', tone: 'bug', items: selected.bugs.map(itemHtml) }) : '',
            ],
        }),
    });
}

/**
 * The selected sprint as Markdown, for pasting into a release announcement: a heading, then one list per
 * section, each item with its Jira key (linked when Jira is connected), title, PROD status and first prod date.
 *
 * @returns {string} '' when there is nothing to copy
 */
function releaseNotesMarkdown(){
    const { reason, groups } = releaseNotesModel({
        app: document.getElementById('filterNotesApp').value,
        type: document.getElementById('filterNotesType').value,
    });
    const sprint = reason ? null : selectedNotesSprintOf(groups);

    if (!sprint) {
        return '';
    }

    const line = ({ issue, level, prodAt }) => {
        const url = jiraIssueUrl(issue.key);
        const key = isSafeHttpsUrl(url) ? `[${issue.key}](${url})` : issue.key;

        return `- ${key} ${issue.title} (${statusLabel(level)}${prodAt ? `, on prod ${fmtDateShort(prodAt)}` : ''})`;
    };
    const section = (label, items) => (items.length ? [`### ${label}`, '', ...items.map(line), ''] : []);

    return [
        `## ${sprint.sprint} (${incrementLabel(sprint.pi)})`, '',
        ...section('Features & improvements', sprint.features),
        ...section('Bug fixes', sprint.bugs),
    ].join('\n').trimEnd() + '\n';
}

/** Back to all services, all types and the newest sprint — after a PI switch (initGlobalPiSelect()). */
function resetReleaseNotesFilters(){
    const typeGroup = document.getElementById('filterNotesTypeGroup');

    document.getElementById('filterNotesApp').value = '';
    typeGroup.querySelectorAll('.segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.value === ''));
    document.getElementById('filterNotesType').value = '';
    selectedNotesSprint = null;
    renderReleaseNotes();
}

/**
 * Repopulates the Service/Type filter *options* from whichever PI is currently loaded — both are derived
 * from `state.jiraIssues`, which holds only the selected PI (`state.selectedPi`), so this runs again on every
 * PI switch (`initGlobalPiSelect()`).
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

    // A sprint card selects that sprint; Copy as Markdown puts the selected one on the clipboard.
    document.getElementById('releaseNotesBody').addEventListener('click', e => {
        const card = e.target.closest('[data-sprint-key]');

        if (card) {
            selectedNotesSprint = card.dataset.sprintKey;
            renderReleaseNotes();
            return;
        }

        const copy = e.target.closest('[data-copy-notes]');

        if (copy && typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(releaseNotesMarkdown()).then(() => {
                copy.classList.add('copied');
                setTimeout(() => copy.classList.remove('copied'), 1500);
            }, () => {});
        }
    });
}
