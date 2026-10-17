// Technical view: shared helpers (component/application ordering and lookup, release-status check) used by
// this file's own renderSummaryCards() and by app-technical-{matrix,timeline,flags}.js (design-docs/
// REPORT_ARCH.md, Problem 5 / priority H) -- kept here, loaded right before them, instead of moving into a
// fourth file, since nothing outside this group of four needs them at load time.

/**
 * Orders by `state.componentsOrder` (the workspace's tracked repos, as the dashboard data lists them) instead of
 * alphabetically. Any component missing from that list sorts alphabetically after it.
 */
function orderedComponents(list){
    const order = (state.componentsOrder || []).map(c => c.name);
    const known = order.filter(c => list.includes(c));
    const unknown = list.filter(c => !order.includes(c)).sort();

    return [...known, ...unknown];
}

/** Metadata entry for a component name from `state.componentsOrder`, or null if it's not listed there. */
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

/** Applications a component belongs to — `application` on a `componentsOrder` entry is an array, since a
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
 *  `state.componentsOrder`'s order. */
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

    const today = dayKey(new Date());
    const deploysToday = state.deployments.filter(d => dayKey(d.deployedAt) === today);
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
