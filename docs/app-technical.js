/**
 * Orders by components.json's own array (fetched in loadData) instead of alphabetically — same file
 * onboarding a component already edits, so display order just follows it with nothing extra to keep in
 * sync. Any component missing from that list (or the list itself missing) sorts alphabetically instead.
 */
function orderedComponents(list){
    const order = (state.componentsOrder || []).map(c => c.name);
    const known = order.filter(c => list.includes(c));
    const unknown = list.filter(c => !order.includes(c)).sort();

    return [...known, ...unknown];
}

/** Metadata entry for a component name from components.json, or null if it's not listed there. */
function componentMeta(name){
    return (state.componentsOrder || []).find(c => c.name === name) || null;
}

/** Components an issue touches: via linked flags (issueLinks) AND via raw deployment relatedIssues, so
 *  flag-less issues (the deployed_code_only path in issueStatusForEnv) still resolve to a component. */
function componentsForIssue(issue){
    const fromLinks = issueLinks(issue).map(l => l.component);
    const fromDeploys = state.deployments
        .filter(d => (d.relatedIssues || []).includes(issue.key))
        .map(d => d.component);

    return [...new Set([...fromLinks, ...fromDeploys])];
}

/** Applications a component belongs to — `application` in components.json is an array, since a
 *  component can be shared across more than one application (e.g. a BFF used by two frontends). Falls
 *  back to the component's own name (a singleton group) when unset/empty (null/unconfirmed). */
function applicationsForComponent(name){
    const meta = componentMeta(name);

    return (meta && meta.application && meta.application.length) ? meta.application : [name];
}

function applicationsForIssue(issue){
    const comps = componentsForIssue(issue);

    return comps.length ? [...new Set(comps.flatMap(applicationsForComponent))] : ['Unassigned'];
}

/** Same ordering pattern as orderedComponents() above, but over application names derived from
 *  components.json's own array order, so onboarding order still drives display order. */
function orderedApplications(list){
    const order = [];

    (state.componentsOrder || []).forEach(c => {
        const apps = (c.application && c.application.length) ? c.application : [c.name];

        apps.forEach(app => {
            if (!order.includes(app)) {
                order.push(app);
            }
        });
    });

    const known = order.filter(a => list.includes(a));
    const unknown = list.filter(a => !order.includes(a)).sort();

    return [...known, ...unknown];
}

/** An issue is "released" once it's actually live on prod: `released` (deployed AND its flag is ON) or
 *  `deployed_code_only` (no flag exists to gate it, so deployment is as final as it gets). Anything
 *  `deployed` (flag off), `partial`, or `none` isn't live yet, regardless of what TEST/QA show. */
function issueIsReleasedToProd(issue){
    const level = issueStatusForEnv(issue, ENVIRONMENT.PROD).level;

    return level === RELEASE_LEVEL.RELEASED || level === RELEASE_LEVEL.DEPLOYED_CODE_ONLY;
}

/** Short 2-letter avatar tag for a component. Real components follow the "xxx-service-<role>" naming
 *  convention (host / frontend / bff / charger-infrastructure / sim-adapter) — pulls the word after
 *  "-service-" and shortens it, except literal fe/frontend -> "FE" and be/backend -> "BE". Falls back to
 *  the component name's own first two letters if the naming pattern doesn't match at all. */
function componentKind(comp){
    const m = comp.match(/-service-([a-z0-9]+)/i);
    const word = m ? m[1] : comp;

    if (/^(fe|frontend)$/i.test(word)) {
        return SERVICE_TYPE.FE;
    }
    if (/^(be|backend)$/i.test(word)) {
        return SERVICE_TYPE.BE;
    }

    return word.slice(0, 2).toUpperCase();
}

/** Whether a flag's effective state differs between its build (FE) and runtime-be (BE) entries for a
 *  given env — same check renderFlags()'s per-env divergence note already makes, factored out so the
 *  summary cards and the Feature flags panel header can both count it without duplicating the logic. */
function flagDivergesInEnv(key, env){
    const envEntry = state.flagStates[key] ? state.flagStates[key][env] : null;

    return !!(envEntry && envEntry.build && envEntry['runtime-be'] && envEntry.build.enabled !== envEntry['runtime-be'].enabled);
}

/* ---------- Rendering: technical view summary cards ---------- */
function renderSummaryCards(){
    const box = document.getElementById('summaryGrid');
    const components = orderedComponents([...new Set(state.deployments.map(d=> d.component))]);
    const total = components.length;

    const prodBehind = components.filter(comp => {
        const d = currentVersion(comp, ENVIRONMENT.PROD);

        return d && hasDrift(d.driftBehind) && driftComparedEnv(d.driftBehind) === ENVIRONMENT.QA;
    }).length;

    const today = new Date();
    const isToday = iso => {
        const d = new Date(iso);

        return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    };
    const deploysToday = state.deployments.filter(d => isToday(d.deployedAt));
    const failedToday = deploysToday.filter(d => d.status !== 'success').length;

    const divergingEnvs = new Set();
    const divergingFlagCount = Object.keys(state.flagsMeta).filter(key => {
        const diverges = ENVIRONMENTS.some(env => flagDivergesInEnv(key, env));

        if (diverges) {
            ENVIRONMENTS.forEach(env => { if (flagDivergesInEnv(key, env)) divergingEnvs.add(env); });
        }

        return diverges;
    }).length;

    const staleFlagCount = Object.entries(state.flagsMeta).filter(([key, f]) => flagStaleWarning(f, key)).length;

    const cards = [
        { label:'Services tracked', value:String(total), note:`across ${ENVIRONMENTS.length} stages` },
        { label:'Prod in sync with QA', value:`${total - prodBehind}/${total}`, note: prodBehind ? `${prodBehind} service${prodBehind===1?'':'s'} differ` : 'all services in sync', warn: !!prodBehind, ok: !prodBehind },
        { label:'Deploys today', value:String(deploysToday.length), note: failedToday ? `${failedToday} failed` : (deploysToday.length ? 'all succeeded' : 'no deploys yet'), warn: !!failedToday, ok: !failedToday && !!deploysToday.length },
        // Always phrased as a comparison against the build default — with a single diverging env
        // that's still "env ≠ build default", not a bare env name with nothing to compare it to.
        { label:'Flags diverging', value:String(divergingFlagCount), note: divergingEnvs.size ? `${[...divergingEnvs].map(e => e.toUpperCase()).join(', ')} ≠ build default` : 'all flags in sync', warn: !!divergingFlagCount, ok: !divergingFlagCount },
        { label:'Stale flags', value:String(staleFlagCount), note: staleFlagCount ? `ON ${STALE_FLAG_DAYS}+ days, all issues Done` : 'no cleanup candidates', warn: !!staleFlagCount, ok: !staleFlagCount },
    ];

    box.innerHTML = html`${cards.map(c => SummaryCard({ label: c.label, value: c.value, note: c.note, tone: c.warn ? 'warn' : (c.ok ? 'ok' : '') }))}`;
}

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

let visibleDeployCount = 20;
const DEPLOY_PAGE_SIZE = 20;

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
 * per flag/env/source (that's still what flagStates.json/effectiveFlagState hold, for *current* state).
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

/**
 * A flag whose jiraKeys span issues at different readiness levels is a "blast radius" hazard:
 * flipping it on releases every linked issue at once, including ones that aren't done yet.
 * Returns the not-done keys to call out, or null if there's nothing mixed to warn about.
 *
 * Reads `state.issueStatusIndex` (every PI's `statusCategory`, built server-side by sync-jira.js's
 * buildStatusIndex()) rather than `state.jiraIssues` (only the one PI currently loaded) — a flag's
 * jiraKeys can easily span more than one PI, and the Technical view's Flags panel this feeds has no PI
 * selector of its own for a user to pick the "right" one.
 */
function flagBlastRadius(f){
    const keys = f.jiraKeys || [];

    if (keys.length < 2) {
        return null;
    }

    const statusOf = k => state.issueStatusIndex[k] && state.issueStatusIndex[k].statusCategory;
    const doneCount = keys.filter(k => statusOf(k) === 'done').length;
    const notDoneKeys = keys.filter(k => statusOf(k) && statusOf(k) !== 'done');

    if (!doneCount || !notDoneKeys.length) {
        return null;
    }

    return notDoneKeys;
}

const STALE_FLAG_DAYS = 60;

/**
 * A flag that's been ON somewhere for a long time with every linked issue already Done is a
 * cleanup candidate — the flag-gated code path can probably be removed outright.
 *
 * Reads `state.issueStatusIndex` (every PI), same reasoning as `flagBlastRadius` above.
 */
function flagStaleWarning(f, key){
    const keys = f.jiraKeys || [];

    if (!keys.length) {
        return null;
    }

    const linked = keys.map(k => state.issueStatusIndex[k]).filter(Boolean);

    if (linked.length !== keys.length || !linked.every(i => i.statusCategory === 'done')) {
        return null;
    }

    let maxDays = 0;
    let staleEnv = null;

    ENVIRONMENTS.forEach(env=> {
        const envEntry = state.flagStates[key] ? state.flagStates[key][env] : null;
        const fs = effectiveFlagState(envEntry);

        if (!fs || !fs.enabled) {
            return;
        }

        const days = Math.floor((Date.now() - new Date(fs.changedAt).getTime()) / 86400000);

        if (days > maxDays) {
            maxDays = days;
            staleEnv = env;
        }
    });

    if (!staleEnv || maxDays < STALE_FLAG_DAYS) {
        return null;
    }

    return { env: staleEnv, days: maxDays };
}

/** Flags whose Details drawer is expanded in the Feature flags panel — survives re-renders (e.g. changing
 *  the type filter) so a filter change doesn't collapse what the user just opened. */
const openFlagDetails = new Set();

function renderFlags(){
    const box = document.getElementById('flags');
    const sourceFilter = document.getElementById('filterFlagSource').value;
    const entries = Object.entries(state.flagsMeta)
        .filter(([, f]) => !sourceFilter || f.source === sourceFilter)
        .sort((a,b) => a[0].localeCompare(b[0]));

    const divergeCount = entries.filter(([key]) => ENVIRONMENTS.some(env => flagDivergesInEnv(key, env))).length;

    document.getElementById('flagsDivergeNote').textContent = divergeCount ? `${divergeCount} diverge${divergeCount===1?'s':''}` : '';

    if (!entries.length) {
        box.innerHTML = EmptyState({ message: sourceFilter ? 'No flags match this filter' : 'No flags defined' });
        return;
    }

    box.innerHTML = html`
    ${FlagsColumnHeader({ labels: ENVIRONMENTS.map(env => env.toUpperCase()) })}
    ${entries.map(([key, f])=> {
        const blastRadius = flagBlastRadius(f);
        const staleInfo = flagStaleWarning(f, key);
        const open = openFlagDetails.has(key);

        const notes = html`
        ${staleInfo ? DriftNote({ text: '◷ Possibly stale' }) : ''}
        ${ENVIRONMENTS.map(env=> {
            if (!flagDivergesInEnv(key, env)) {
                return '';
            }

            const envEntry = state.flagStates[key][env];

            return DriftNote({
                text: `≠ ${env.toUpperCase()} diverges from build default`,
                title: `build=${envEntry.build.enabled ? 'ON' : 'OFF'} — would resurface if the runtime-be override is ever cleared`,
            });
        })}
        ${blastRadius ? BlastRadiusWarning({ keys: blastRadius }) : ''}`;

        const states = ENVIRONMENTS.map(env=> {
            const envEntry = state.flagStates[key] ? state.flagStates[key][env] : null;
            const fs = effectiveFlagState(envEntry);

            if (!fs) {
                return FlagStateText({ kind: 'missing', cls: 'ff-state' });
            }

            return FlagStateText({
                kind: fs.enabled ? 'on' : 'off',
                cls: 'ff-state',
                title: `[${fs.source}] changed ${relTime(fs.changedAt)} by ${fs.changedBy}`,
            });
        });

        return FlagRow({
            name: key,
            typeLabel: f.source === 'build' ? 'Build-time (FE)' : 'Runtime (BE)',
            open,
            notes,
            states,
            details: FlagDetails({
                description: f.description,
                issues: (f.jiraKeys || []).map(k => ({ key: k, href: jiraIssueUrl(k) })),
                components: f.components || [],
                added: f.createdAt ? fmtDateShort(f.createdAt) : '',
            }),
        });
    })}`;

    box.onclick = e => {
        const btn = e.target.closest('.deploy-group-toggle');
        const row = btn && btn.closest('.ff-row');

        if (!row) {
            return;
        }

        const key = row.dataset.flag;
        const nowOpen = !openFlagDetails.has(key);

        nowOpen ? openFlagDetails.add(key) : openFlagDetails.delete(key);
        btn.classList.toggle('open', nowOpen);
        btn.setAttribute('aria-expanded', String(nowOpen));
        btn.setAttribute('aria-label', `${nowOpen ? 'Hide' : 'Show'} details for ${key}`);
        row.querySelector('.ff-details').hidden = !nowOpen;
    };
}

