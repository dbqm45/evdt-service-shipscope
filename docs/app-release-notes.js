/**
 * Groups real (non-fallback-stub) Jira issues by application (via components.json) then by PI, and shows
 * whether each PI's work is fully released to prod for that application yet. Purely derived from `state` —
 * no new data file, no server round-trip beyond what loadData() already fetches.
 */
/** Release Notes summary row: always the *current* PI's released counts — deliberately ignoring
 *  whatever PI/Service/Type filters are active below, so this stays one unambiguous statement
 *  ("what actually shipped this PI") instead of shifting meaning as someone filters the list. */
function renderReleaseNotesSummary(){
    const box = document.getElementById('releaseNotesSummary');
    // `state.selectedPi`, not `currentPi()` — the two can legitimately differ (browsing a past PI via the
    // global PI selector while the org has already moved on to a newer one), and `state.jiraIssues` only
    // ever holds `selectedPi`'s issues, so filtering by `currentPi()` here would silently find nothing.
    const pi = state.selectedPi;
    const inScope = selectedIncrements();
    const released = state.jiraIssues.filter(i => i.type !== ISSUE_TYPE.EPIC && inScope.includes(i.pi) && issueIsReleasedToProd(i));
    const features = released.filter(i => i.type !== ISSUE_TYPE.BUG).length;
    const bugs = released.filter(i => i.type === ISSUE_TYPE.BUG).length;
    const piNote = pi ? `in ${incrementLabel(pi)}${pi === currentPi() ? ' (current PI)' : ''}` : 'no PI selected';

    const cards = [
        { label: 'Features & improvements released', value: String(features) },
        { label: 'Bugs fixed', value: String(bugs) },
    ];

    box.innerHTML = html`${cards.map(c => SummaryCard({ label: c.label, value: c.value, note: piNote }))}`;
}

function renderReleaseNotes(){
    renderReleaseNotesSummary();
    const box = document.getElementById('releaseNotesBody');
    const appFilter = document.getElementById('filterNotesApp').value;
    const typeFilter = document.getElementById('filterNotesType').value;

    // `state.jiraIssues` already only holds the currently-selected PI's issues (see `state.selectedPi`) —
    // Service/Type are the only filters left to narrow which PI/sprint *groups* are considered at all;
    // grouping still uses every real-PI issue in a matching group (not just released ones) so the "Fully
    // released to PROD"/"In progress" badge below stays meaningful, even though only released issues are
    // actually listed as rows.
    const allRealPiIssues = state.jiraIssues.filter(i => isRealPi(i.pi));
    const filteredIssues = allRealPiIssues.filter(i => {
        if (appFilter && !applicationsForIssue(i).includes(appFilter)) {
            return false;
        }

        return !typeFilter || i.type === typeFilter;
    });
    const releasedCount = filteredIssues.filter(issueIsReleasedToProd).length;

    document.getElementById('releaseNotesCount').innerHTML = ItemCount({ count: releasedCount });

    if (!releasedCount) {
        // Distinguish "nothing synced at all" / "synced, but every issue is a commit-derived stub" (no
        // title/PI/status — see FAQ.md → "Where do the Epic/Story/Task numbers come from?") / "filters
        // matched nothing" / "real data exists, but nothing here is live on PROD yet" — each is a
        // different, more actionable thing to tell someone staring at an empty tab than one generic message.
        // Also carries `.panel` — unlike every other `.empty` use in this file, #releaseNotesBody has no
        // panel-styled ancestor of its own (not wrapped in a `.panel`/`.wi-table`/`.dh-panel`), so without
        // it this would render as unstyled bare text instead of a proper card.
        if (!state.jiraIssues.length) {
            box.innerHTML = EmptyState({ message: 'No issues synced from Jira yet', panel: true });
        } else if (!allRealPiIssues.length) {
            box.innerHTML = EmptyState({ message: `Found ${state.jiraIssues.length} synced issue(s), but none have a real PI yet — this usually means the Jira sync couldn't reach Jira and fell back to commit-derived stubs (no title/PI/status). See FAQ.md → "Where do the Epic/Story/Task numbers come from?".`, panel: true });
        } else if (!filteredIssues.length) {
            box.innerHTML = EmptyState({ message: 'No results for the selected filters', panel: true });
        } else {
            box.innerHTML = EmptyState({ message: 'Found real-PI issues, but none are released to PROD yet.', panel: true });
        }
        return;
    }

    // Flat PI → Sprint grouping, deliberately not split by application/service any more — the Service
    // filter above still narrows *which* issues are in `filteredIssues` to begin with, this just stops
    // partitioning the result into one panel per app once it's in.
    const byPi = new Map();

    filteredIssues.forEach(issue => {
        if (!byPi.has(issue.pi)) {
            byPi.set(issue.pi, new Map());
        }

        const bySprint = byPi.get(issue.pi);
        const sprintLabel = issue.sprint || 'Unassigned sprint';

        if (!bySprint.has(sprintLabel)) {
            bySprint.set(sprintLabel, []);
        }

        bySprint.get(sprintLabel).push(issue);
    });

    // TEST/QA breakdown still isn't shown here — "released" already implies "live on PROD" (see
    // issueIsReleasedToProd above), so those two pills would just be redundant noise. The PROD pill
    // itself is still worth showing, though: issueIsReleasedToProd folds two different real states
    // together — `released` (a flag confirms it's visible) vs. `deployed_code_only` (code shipped, but
    // there's no flag to confirm against) — and a reader here has no other way to tell which one a given
    // item actually is.
    const renderIssueRow = issue => {
        const prodLevel = issueStatusForEnv(issue, ENVIRONMENT.PROD).level;
        const prodAt = earliestProdDeployedAt(issue.key);

        return ReleaseNoteItem({
            type: issue.type,
            href: `${JIRA_BASE_URL}/${issue.key}`,
            title: issue.title,
            pill: StatusPill({ cls: statusClass(prodLevel), label: statusLabel(prodLevel), title: statusLabelTooltip(prodLevel) }),
            issueKey: issue.key,
            dateText: prodAt ? fmtDateShort(prodAt) : '',
        });
    };

    // Splits a sprint's released issues into labeled sub-sections. Jira has no separate "Improvement"
    // type to key off of, so this only reliably splits on Bug vs. everything else (Epic/Story/Task).
    // A category with no issues renders nothing.
    const renderCategorySections = releasedIssues => {
        const categories = [
            { label: 'Features & Improvements', list: releasedIssues.filter(i => i.type !== ISSUE_TYPE.BUG) },
            { label: 'Bug Fixes', list: releasedIssues.filter(i => i.type === ISSUE_TYPE.BUG) },
        ];

        return categories.filter(c => c.list.length).map(c => ReleaseNotesCategory({ label: c.label, items: c.list.map(renderIssueRow) }));
    };

    const pis = [...byPi.keys()].sort(compareVersionDesc);

    // Every row rendered here already passed issueIsReleasedToProd (see releasedSprintIssues below) — a
    // PI/sprint only shows up at all once it has at least one released issue, so there's no "still in
    // progress" state left to call out: what's listed is, by definition, already live on prod.
    const piSections = pis.map(pi => {
        const bySprint = byPi.get(pi);
        const sprints = [...bySprint.keys()].sort(compareVersionDesc);

        const sprintSections = sprints.map(sprint => {
            const releasedSprintIssues = bySprint.get(sprint).filter(issueIsReleasedToProd);

            if (!releasedSprintIssues.length) {
                return '';
            }

            return ReleaseNotesSprint({ title: sprint, categories: renderCategorySections(releasedSprintIssues) });
        }).filter(Boolean);

        if (!sprintSections.length) {
            return '';
        }

        return ReleaseNotesPi({ pi, sprints: sprintSections });
    }).filter(Boolean);

    box.innerHTML = PanelBody({ children: piSections });
}

