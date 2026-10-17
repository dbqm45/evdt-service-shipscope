// Technical view: component × environment matrix (row-height equalization across env cards) + the per-cell
// drift modal. Split out of app-technical.js (design-docs/REPORT_ARCH.md, Problem 5 / priority H) --
// uses the shared helpers (componentMeta, componentKind, ...) that stay in app-technical.js itself.

/* ---------- Rendering: technical view ---------- */
/** True when a record's `driftBehind` says its code differs from the previous stage. New records carry `diff`
 *  (tree comparison, see sync-github-deployments.js); records written before it existed only carry the raw
 *  commit counts, which still count as drift so older data keeps showing the marker. */
function hasDrift(drift){
    return !!(drift && (drift.diff || drift.commitCount || drift.untestedCommitCount));
}

/** The earlier env (lower-case) a `driftBehind` entry was compared against — both count fields name the same one. */
function driftComparedEnv(drift){
    return (drift && (drift.behindEnv || drift.untestedIn)) || '';
}

/** The title row of one env card: bars icon, env name, service count, and a "latest builds" / "N differ from X" /
 *  "in sync with X" note — every env after the first compares against the previous stage in the promotion
 *  chain (test -> qa -> prod), same chain driftBehind already walks in sync-github-deployments.js. */
function envCardHeaderHtml(env, envIndex, components){
    const prevEnv = ENVIRONMENTS[envIndex - 1];
    const behindCount = prevEnv
        ? components.filter(comp => {
            const d = currentVersion(comp, env);

            return d && hasDrift(d.driftBehind) && driftComparedEnv(d.driftBehind) === prevEnv;
        }).length
        : 0;
    const rightNoteHtml = !prevEnv
        ? EnvStatusNote({ text: 'latest builds' })
        : behindCount
            ? EnvStatusNote({ text: `${behindCount} differ from ${prevEnv.toUpperCase()}`, warn: true })
            : EnvStatusNote({ text: `in sync with ${prevEnv.toUpperCase()}` });

    return EnvCardHeader({ env, icon: barsIcon(ENV_BAR_COUNT[env]), serviceCount: components.length, note: rightNoteHtml });
}

/** One `.comp-row` for a component in one env card: name + avatar, and — when there's a deploy — version,
 *  relative time and drift notes; clicking it jumps to that component/env in the deployment history. */
function buildComponentRow(comp, env){
    const d = currentVersion(comp, env);
    const row = document.createElement('div');
    const meta = componentMeta(comp);
    // Explicitly false (not just missing/unconfirmed) means: this component has feature
    // flags, but ShipScope doesn't track them yet — call that out so an empty-looking Flags
    // panel below isn't mistaken for "this component has no flags at all".
    const nameProps = {
        name: comp,
        kind: componentKind(comp),
        description: meta && meta.description ? meta.description : '',
        flagsNotTracked: !!meta && meta.featureFlagsIncluded === false,
    };

    row.className = 'comp-row';

    if (!d) {
        row.style.cursor = 'default';
        row.innerHTML = html`${ComponentName(nameProps)}${ComponentNotDeployedMeta()}`;

        return row;
    }

    row.dataset.status = d.status;
    row.innerHTML = html`${ComponentName({ ...nameProps, subline: RelTime({ text: relTime(d.deployedAt) }) })}${ComponentDeployedMeta({
        status: d.status,
        version: VersionLink({ version: d.version, url: d.commitUrl, stopClick: true }),
        driftNote: driftNotesHtml(d.driftBehind),
    })}`;
    row.onclick = (e)=> {
        const infoBtn = e && e.target && e.target.closest ? e.target.closest('.drift-info-btn') : null;

        if (infoBtn) {
            // The icon opens its own modal — it must not also jump the timeline filter.
            openDriftModal({ ...infoBtn.dataset, cellEnv: env, component: comp });

            return;
        }

        document.getElementById('filterEnv').value = env;
        document.getElementById('filterComponent').value = comp;
        // The matrix always shows the single latest record regardless of age (see
        // renderTimeline()'s cutoff comment) — clear any active date-range filter so
        // jumping here from the matrix can never land on an empty "No activity" list.
        document.getElementById('filterDeployRange').value = '';
        resetDeployPagination();
    };

    return row;
}

/** Drift marker for one matrix cell — at most ONE control, always the same short label ("Diff to TEST"): the
 *  count of differing files and every other detail live in openDriftModal(), not on the card. `data-*` carries
 *  what the modal needs (row.onclick reads it back); `data-diff` is the JSON of `driftBehind.diff` (absent on
 *  records written before the tree comparison existed). */
function driftNotesHtml(drift){
    if (!hasDrift(drift)) {
        return '';
    }

    const env = driftComparedEnv(drift).toUpperCase();

    return DriftNoteButton({
        env,
        behind: drift.commitCount || 0,
        skipped: drift.untestedCommitCount || 0,
        sameVersion: !!drift.sameVersion,
        diffJson: JSON.stringify(drift.diff || null),
    });
}

/** Modal (native `<dialog>`, built once on first use) for one matrix cell's "Diff to ENV": the file-level result
 *  of the tree comparison first (what the card's marker is based on), then the raw commit history between the
 *  two deployed commits — kept for context only, since its size says nothing about how much code differs. */
function openDriftModal({ env, behind, skipped, sameVersion, diff, cellEnv, component }){
    let dlg = document.getElementById('driftModal');

    if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'driftModal';
        dlg.className = 'drift-modal';
        // Click on the backdrop (the dialog element itself, outside its content box) closes it.
        dlg.addEventListener('click', e => { if (e.target === dlg) { dlg.close(); } });
        document.body.appendChild(dlg);
    }

    let parsed = null;

    try {
        parsed = diff ? JSON.parse(diff) : null;
    } catch (e) {
        parsed = null;
    }

    const sections = [];

    if (!parsed) {
        // Legacy record (synced before the file comparison existed): nothing to say about files, only Git history.
    } else if (parsed.unknown) {
        sections.push({
            title: `Diff to ${env}`,
            counts: 'Unknown',
            text: driftNoteTooltip('unknown', env),
        });
    } else {
        const ignoredText = parsed.ignored ? ` (${parsed.ignored} more ignored by the component's driftIgnorePaths)` : '';
        const more = parsed.files - (parsed.paths || []).length;

        sections.push({
            title: `Diff to ${env}`,
            counts: `${parsed.files} file${parsed.files === 1 ? '' : 's'} differ${parsed.files === 1 ? 's' : ''}${ignoredText}`,
            text: driftNoteTooltip('files', env),
            paths: parsed.paths || [],
            more: more > 0 ? more : 0,
        });
    }

    const history = [];

    if (Number(behind) > 0) {
        history.push(`${behind} commit(s) on ${env} that ${cellEnv ? String(cellEnv).toUpperCase() : 'this environment'} doesn't have`);
    }
    if (Number(skipped) > 0) {
        history.push(`${skipped} commit(s) ${cellEnv ? `on ${String(cellEnv).toUpperCase()}` : 'here'} that ${env} doesn't have`);
    }
    if (history.length) {
        sections.push({
            title: 'Git history',
            counts: history.join(' · '),
            text: driftNoteTooltip(sameVersion ? 'historySameVersion' : 'history', env),
        });
    }

    sections.push({ title: 'What this does not show', counts: '', text: driftNoteTooltip('scope', env), cls: 'drift-modal-scope' });

    const headTitle = `${cellEnv ? `${String(cellEnv).toUpperCase()} - diff` : 'Diff'} to ${env}`;

    dlg.innerHTML = DriftModalContent({ headTitle, component, sections });
    dlg.showModal();
}

/** One `.flag-row` (flag name + effective ON/OFF/— state) in one env card's flags list. */
function buildFlagRow(key, env){
    const envEntry = state.flagStates[key] ? state.flagStates[key][env] : null;
    const fs = effectiveFlagState(envEntry);
    const row = document.createElement('div');

    row.className = 'flag-row';
    row.dataset.flagKey = key;

    let kind = 'missing';

    if (!fs) {
        row.title = '';
    } else {
        kind = fs.enabled ? 'on' : 'off';
        row.title = `[${fs.source}] changed ${relTime(fs.changedAt)} by ${fs.changedBy}`;
    }
    row.innerHTML = FlagRowContent({ name: key, state: FlagStateText({ kind }) });

    return row;
}

/** Builds one env card (header, one row per component, flags list). Returns the card plus the pieces
 *  renderMatrix() needs to align things across cards afterwards. */
function buildEnvCard(env, envIndex, components, flagEntries){
    const card = document.createElement('div');
    const compRows = new Map();

    card.className = 'env-card';
    card.innerHTML = envCardHeaderHtml(env, envIndex, components);

    const deployedContent = document.createElement('div');

    deployedContent.className = 'deployed-content';

    if (!components.length) {
        deployedContent.classList.add('deployed-empty');
        const empty = document.createElement('div');
        empty.className = 'rel-time';
        empty.textContent = 'no deployments';
        deployedContent.appendChild(empty);
    } else {
        // Always render one row per component, even when this env has no deployment for it —
        // otherwise row N can be a different component in each env card, which defeats
        // the row-height alignment pass (and misaligns the flags rows further down).
        components.forEach(comp => {
            const row = buildComponentRow(comp, env);

            deployedContent.appendChild(row);
            compRows.set(comp, row);
        });
    }

    card.appendChild(deployedContent);

    const flagsLabel = document.createElement('div');

    flagsLabel.className = 'snapshot-section-label snapshot-flags-label';
    flagsLabel.innerHTML = html`Flags · Effective ${InfoTip({ text: 'Effective value per environment — when a flag is set on both FE and BE, the BE value wins.' })}`;
    card.appendChild(flagsLabel);

    const flagsList = document.createElement('div');

    flagsList.className = 'env-flags-scroll';
    flagEntries.forEach(([key]) => flagsList.appendChild(buildFlagRow(key, env)));
    card.appendChild(flagsList);

    return { card, compRows, flagsList };
}

/** Rows are already in the DOM — measure each component's natural row height across every env card and
 *  snap every one of that component's rows to the tallest, so e.g. a QA row that grew to 90px because of
 *  a two-line drift note pulls its TEST/PROD counterparts to the same 90px instead of leaving them at the
 *  70px minimum. `.comp-row`'s height is a CSS min-height, not a fixed one, so without this the three env
 *  cards drift out of row-for-row alignment the moment any single row outgrows it. */
function equalizeComponentRowHeights(compRowsByComponent){
    compRowsByComponent.forEach(rows => {
        if (rows.length < 2) {
            return;
        }

        const maxHeight = Math.max(...rows.map(row => row.getBoundingClientRect().height));

        rows.forEach(row => { row.style.height = `${maxHeight}px`; });
    });
}

/** Keeps every env card's flags list scrolled to the same position. */
function syncFlagsScroll(flagsScrollEls){
    let syncing = false;

    flagsScrollEls.forEach(el => {
        el.addEventListener('scroll', ()=>{
            if (syncing) {
                return;
            }

            syncing = true;
            flagsScrollEls.forEach(other => {
                if (other !== el) {
                    other.scrollTop = el.scrollTop;
                }
            });
            syncing = false;
        });
    });
}

/** Highlights the same flag's row in every env card while hovering one of them (bound once per matrix). */
function bindFlagRowHover(m){
    if (m.dataset.hoverBound) {
        return;
    }

    m.dataset.hoverBound = '1';

    const setHighlight = (e, on) => {
        const row = e.target.closest('.flag-row');

        if (!row || !row.dataset.flagKey) {
            return;
        }

        m.querySelectorAll(`.flag-row[data-flag-key="${CSS.escape(row.dataset.flagKey)}"]`).forEach(r=> r.classList.toggle('flag-row-highlight', on));
    };

    m.addEventListener('mouseover', e => setHighlight(e, true));
    m.addEventListener('mouseout', e => setHighlight(e, false));
}

function renderMatrix(){
    const m = document.getElementById('matrix');
    const components = orderedComponents([...new Set(state.deployments.map(d=> d.component))]);
    const flagEntries = Object.entries(state.flagsMeta).sort((a,b) => a[0].localeCompare(b[0]));
    const flagsScrollEls = [];
    const compRowsByComponent = new Map(components.map(comp => [comp, []]));

    m.innerHTML = '';

    ENVIRONMENTS.forEach((env, envIndex)=>{
        const { card, compRows, flagsList } = buildEnvCard(env, envIndex, components, flagEntries);

        compRows.forEach((row, comp) => compRowsByComponent.get(comp).push(row));
        flagsScrollEls.push(flagsList);
        m.appendChild(card);
    });

    equalizeComponentRowHeights(compRowsByComponent);
    syncFlagsScroll(flagsScrollEls);
    bindFlagRowHover(m);
}
