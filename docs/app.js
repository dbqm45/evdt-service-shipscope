const ENVIRONMENTS = ['test','qa','prod'];
const JIRA_BASE_URL = 'https://circlek.atlassian.net/browse';

/** Small inline SVGs reused across env/deployment badges — kept tiny, same spirit as the header's own
 *  logo mark. `external`/`manual`/`chevron` use stroke/fill:currentColor so they inherit whatever color
 *  context they're placed in; the environment "bars" icon is the one exception (see barsIcon() below) —
 *  its lit bars are always literal white, everywhere it's used, so it can't be recolored by context. */
const ICONS = {
    external: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><path d="M6.5 3H4A1.5 1.5 0 0 0 2.5 4.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5V9M9.5 2.5H13v3.5M13 2.5 7.5 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    manual: '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M3 1.5l9.5 4.2-3.6.9 2.4 4.1-1.7 1-2.4-4.1-2.6 2.7z"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" aria-hidden="true"><path d="M5.5 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevronDown: '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" aria-hidden="true"><path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M8 2.3 14.3 13a1 1 0 0 1-.87 1.5H2.57A1 1 0 0 1 1.7 13L8 2.3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6.5v3.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.9" fill="currentColor"/></svg>',
    flag: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M3.5 2v12M3.5 2.8h8l-2 2.7 2 2.7h-8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="5.1" r="0.9" fill="currentColor"/></svg>',
    rewind: '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M8 4 3 8l5 4V4Z"/><path d="M13.5 4 8.5 8l5 4V4Z"/></svg>',
};

/** How many of the 3 ascending bars are lit for a given environment — test/qa/prod map to stage 1/2/3
 *  of the promotion chain, so the icon reads as "how far along" at a glance. Used everywhere an
 *  environment is labeled (env card titles, deployment env badges, Product view column headers) so the
 *  same environment always shows the same bar count. */
const ENV_BAR_COUNT = { test: 1, qa: 2, prod: 3 };

/** Builds the 3-bar environment icon with `activeCount` bars lit. Lit bars are always literal white
 *  (#ECEEF1), empty bars always #33373D — per design, the bars never take on the surrounding
 *  badge/text color, unlike every other icon in ICONS above. */
function barsIcon(activeCount){
    const bars = [{ x: 1, y: 9, h: 6 }, { x: 6.5, y: 5, h: 10 }, { x: 12, y: 1, h: 14 }];
    const rects = bars.map((b, i) => {
        const lit = i < activeCount;

        return `<rect x="${b.x}" y="${b.y}" width="3" height="${b.h}" rx="1" fill="${lit ? '#ECEEF1' : '#33373D'}"/>`;
    }).join('');

    return `<svg class="stage-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">${rects}</svg>`;
}

// Product view is enabled (clickable), but Technical view stays the default landing tab for now —
// see DEFAULT_VIEW below. Flip this back to false to disable+hide the tab again (shown, in its usual
// first position, just unclickable) without touching docs/index.html.
const PRODUCT_VIEW_ENABLED = true;

// Which tab is active on load, independent of PRODUCT_VIEW_ENABLED — set to 'product' to restore
// docs/index.html's own default (its `.tab.active` class on the Product view tab).
const DEFAULT_VIEW = 'tech';

// Release Notes has graduated to always-on (hardcoded true), but the *mechanism* — fully removing a tab
// from the DOM when disabled, rather than just shown-but-unclickable like PRODUCT_VIEW_ENABLED's pattern —
// is kept as-is so the next soft-launched preview tab can reuse the same on/off switch: copy this constant
// and the matching blocks in initTabs()/init() below, wire its condition to whatever gate it needs (a
// query param, an env-baked flag, etc.), and flip it to false until that tab is ready to reveal.
const RELEASE_NOTES_ENABLED = true;

// First reuse of the RELEASE_NOTES_ENABLED pattern described above: hidden unless explicitly requested via
// ?insights=1 in the URL, so it never shows up for anyone who doesn't already know to ask for it — same
// soft-launch shape Release Notes used before it graduated to always-on.
const INSIGHTS_ENABLED = new URLSearchParams(location.search).get('insights') === '1';

function effectiveFlagState(envEntry){
    if (!envEntry) {
        return null;
    }
    if (envEntry['runtime-be']) {
        return { ...envEntry['runtime-be'], source: 'runtime-be' };
    }
    if (envEntry.build) {
        return { ...envEntry.build, source: 'build' };
    }

    return null;
}
let state = null;
let expandedIssue = null;
let visibleIssueCount = 20;
const collapsedEpics = new Set();
const ISSUE_PAGE_SIZE = 20;

function fmtDateShort(iso){
    return new Date(iso).toLocaleDateString('pl-PL',{day:'2-digit',month:'2-digit',year:'numeric'});
}
function fmtTime(iso){
    return new Date(iso).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});
}
/** Calendar-day identity for grouping (day headers, consecutive-deploy collapsing) — deliberately not
 *  ISO/UTC-based, so "today"/"yesterday" match the viewer's own local calendar day. */
function dayKey(iso){
    const d = new Date(iso);

    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
/** "Today · Friday, 28.09.2026" / "Yesterday · ..." / "Wednesday, 17.09.2026" — weekday name is
 *  deliberately English regardless of the rest of the app's pl-PL date formatting, matching the design. */
function dayHeadLabel(iso){
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date();

    yesterday.setDate(today.getDate() - 1);

    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
    const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

    if (sameDay(d, today)) {
        return `Today · ${weekday}, ${dateStr}`;
    }
    if (sameDay(d, yesterday)) {
        return `Yesterday · ${weekday}, ${dateStr}`;
    }

    return `${weekday}, ${dateStr}`;
}
function relTime(iso){
    const s = Math.floor((Date.now() - new Date(iso).getTime())/1000);

    if (s < 60) {
        return 'just now';
    }
    if (s < 3600) {
        return Math.floor(s/60) + ' min ago';
    }
    if (s < 86400) {
        return Math.floor(s/3600) + ' hr ago';
    }

    const days = Math.floor(s/86400);

    return days + (days === 1 ? ' day ago' : ' days ago');
}
function fmtDuration(ms){
    if (!ms) return null;

    const totalSeconds = Math.round(ms/1000);
    const m = Math.floor(totalSeconds/60);
    const s = totalSeconds % 60;

    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/* ---------- Data loading: real files first, embedded fallback for standalone preview ----------
 * Opening docs/index.html directly (double-click, or drag into a browser — no server, no deploy)
 * makes every `fetch()` below fail (browsers block fetching relative files over file://), so
 * loadData()'s catch block returns this FALLBACK object instead. That's the built-in "preview
 * without a file server" path CLAUDE.md already documents — this dataset just exists to exercise
 * it: every visual state currently in the app (grouped consecutive deploys, a manual-partial group,
 * drift-behind warnings, a rollback, a build/runtime-be diverging flag, a brand-new flag, a
 * dependency-blocked issue, an epic that's fully released vs. one that's partial vs. one that's
 * empty, an ungrouped issue, deployed_code_only vs. flag-hidden statuses) shows up somewhere,
 * without needing real synced data or a deploy to check a styling change.
 */
function buildFallbackData(){
    const now = Date.now();
    const HOUR = 3600000, DAY = 86400000;
    const hrsAgo = h => new Date(now - h * HOUR).toISOString();
    const daysAgo = d => new Date(now - d * DAY).toISOString();
    const buildState = (enabled, changedAt, changedBy) => ({ build: { enabled, changedAt, changedBy } });
    const beState = (enabled, changedAt, changedBy) => ({ 'runtime-be': { enabled, changedAt, changedBy } });

    const FE = 'evapl-service-frontend';
    const CH = 'evnm-service-charger-infrastructure';
    const BO = 'evboweb-service-frontend';
    const BF = 'evboweb-service-bff';
    const SI = 'evsim-service-sim-adapter';
    const HO = 'evam-service-host';
    const ALL = [FE, CH, BO, BF, SI, HO];

    const deployments = [
        // TEST
        { id: 'd1', component: FE, environment: 'test', version: 'v0.13.0', deployedAt: hrsAgo(4), deployedBy: 'Maciej Piasecki', status: 'success', durationMs: 95000, workflowRunUrl: '#', relatedIssues: ['EBO-16964'], resolvedFlags: { assetNuvoloIntegrationEnabled: true } },
        { id: 'd2', component: CH, environment: 'test', version: 'v1.4.6', deployedAt: hrsAgo(2), deployedBy: 'Maciej Piasecki', status: 'success', durationMs: 72000, workflowRunUrl: '#', relatedIssues: ['EBO-16955', 'EBO-16702', 'EBO-17001'], resolvedFlags: { triggerMessageManualEnabled: true, ocppDeviationBadgeEnabled: true } },
        { id: 'd3', component: BO, environment: 'test', version: 'v0.0.699', deployedAt: daysAgo(14), deployedBy: 'ci-bot', status: 'success', relatedIssues: [] },
        { id: 'd4', component: BF, environment: 'test', version: 'v1.1.41', deployedAt: daysAgo(1), deployedBy: 'Kacper Jóźwiak', status: 'success', relatedIssues: ['EBO-16702'], resolvedFlags: { ocppDeviationBadgeBffEnabled: true } },
        { id: 'd5', component: SI, environment: 'test', version: 'v1.0.19', deployedAt: daysAgo(2), deployedBy: 'ci-bot', status: 'success', relatedIssues: ['EBO-16981'] },
        { id: 'd6', component: HO, environment: 'test', version: 'v1.0.25', deployedAt: daysAgo(2), deployedBy: 'ci-bot', status: 'success', relatedIssues: [] },
        // QA — d7/d8/d9 are consecutive same-version deploys of the same service, so they collapse
        // into one grouped card ("3 deploys", manual count 2 of 3); d10 stays a normal single card.
        { id: 'd7', component: BF, environment: 'qa', version: 'v1.1.41', deployedAt: hrsAgo(3), deployedBy: 'Maciej Piasecki', status: 'success', manual: true, durationMs: 132000, workflowRunUrl: '#' },
        { id: 'd8', component: BF, environment: 'qa', version: 'v1.1.41', deployedAt: hrsAgo(2.4), deployedBy: 'Maciej Piasecki', status: 'success', manual: true, durationMs: 111000, workflowRunUrl: '#' },
        { id: 'd9', component: BF, environment: 'qa', version: 'v1.1.41', deployedAt: hrsAgo(1.7), deployedBy: 'Maciej Piasecki', status: 'success', durationMs: 125000, workflowRunUrl: '#' },
        { id: 'd10', component: CH, environment: 'qa', version: 'v1.4.6', deployedAt: hrsAgo(1), deployedBy: 'Maciej Piasecki', status: 'success', manual: true, durationMs: 72000, workflowRunUrl: '#', relatedIssues: ['EBO-16955', 'EBO-16702', 'EBO-17001'], resolvedFlags: { triggerMessageManualEnabled: true, ocppDeviationBadgeEnabled: true } },
        { id: 'd11', component: FE, environment: 'qa', version: 'v0.8.2', deployedAt: daysAgo(8), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: 'test', commitCount: 8 }, relatedIssues: ['EBO-16964'], resolvedFlags: { assetNuvoloIntegrationEnabled: false } },
        { id: 'd12', component: BO, environment: 'qa', version: 'v0.0.699', deployedAt: hrsAgo(5), deployedBy: 'ci-bot', status: 'success' },
        { id: 'd13', component: SI, environment: 'qa', version: 'v1.0.14', deployedAt: daysAgo(44), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: 'test', commitCount: 6 }, relatedIssues: ['EBO-16820'] },
        { id: 'd14', component: HO, environment: 'qa', version: 'v1.0.21', deployedAt: daysAgo(44), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: 'test', commitCount: 5 } },
        // PROD
        { id: 'd15', component: FE, environment: 'prod', version: 'v0.8.0', deployedAt: daysAgo(11), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: 'qa', commitCount: 2 }, relatedIssues: ['EBO-16964', 'EBO-16955'], resolvedFlags: { assetNuvoloIntegrationEnabled: false } },
        { id: 'd16', component: CH, environment: 'prod', version: 'v1.3.302', deployedAt: daysAgo(8), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: 'qa', commitCount: 13 }, relatedIssues: ['EBO-16970', 'EBO-17001'], resolvedFlags: { triggerRetryEnabled: true } },
        { id: 'd17', component: BO, environment: 'prod', version: 'v0.0.694', deployedAt: daysAgo(24), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: 'qa', commitCount: 5 } },
        { id: 'd18', component: BF, environment: 'prod', version: 'v1.1.39', deployedAt: daysAgo(2), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: 'qa', commitCount: 2 }, rollback: { toRef: 'v1.1.39' } },
        { id: 'd19', component: SI, environment: 'prod', version: 'v1.0.14', deployedAt: daysAgo(44), deployedBy: 'ci-bot', status: 'success', relatedIssues: ['EBO-16820'] },
        { id: 'd20', component: HO, environment: 'prod', version: 'v1.0.21', deployedAt: daysAgo(44), deployedBy: 'ci-bot', status: 'success' },
    ];

    const flagsMeta = {
        allowEvseNameEdit: { description: 'Allow inline EVSE name editing', source: 'build', jiraKeys: [], components: ALL, createdAt: daysAgo(90) },
        // Diverges in prod on purpose: build default is ON, but the runtime-be override turned it OFF —
        // shows the "≠ PROD diverges from build default" note and counts toward "Flags diverging".
        assetNuvoloIntegrationEnabled: { description: 'Nuvolo integration for asset visibility', source: 'build', jiraKeys: ['EBO-16964'], components: [FE], createdAt: daysAgo(70) },
        availabilityActionsEnabled: { description: 'Bulk availability actions', source: 'build', jiraKeys: [], components: ALL, createdAt: daysAgo(80) },
        b2cCustomersEnabled: { description: 'B2C customers module', source: 'build', jiraKeys: [], components: [BO, BF], createdAt: daysAgo(75) },
        changeCpmsAllowed: { description: 'Ability to change CPMS — controlled by BE', source: 'runtime-be', jiraKeys: [], components: [CH], createdAt: daysAgo(85) },
        chargerBaseEditEnabled: { description: 'Charger base data editing', source: 'build', jiraKeys: [], components: [CH], createdAt: daysAgo(85) },
        triggerMessageManualEnabled: { description: 'Manual trigger message from connector level', source: 'build', jiraKeys: ['EBO-16955'], components: [CH], createdAt: daysAgo(30) },
        ocppDeviationBadgeEnabled: { description: 'Deviation badge in the OCPP templates list (charger side)', source: 'build', jiraKeys: ['EBO-16702'], components: [CH], createdAt: daysAgo(15) },
        ocppDeviationBadgeBffEnabled: { description: 'Deviation badge in the OCPP templates list (BFF side)', source: 'build', jiraKeys: ['EBO-16702'], components: [BF], createdAt: daysAgo(15) },
        triggerRetryEnabled: { description: 'Automatic retry for failed trigger messages', source: 'build', jiraKeys: ['EBO-16970'], components: [CH], createdAt: daysAgo(10) },
        // No flagStates entry below — a flag this fresh (created a few hours ago) hasn't had its state
        // resolved anywhere yet, which is exactly what makes it show up as a "New flag" timeline card.
        transactionB2CPaymentDetailsEnabled: { description: 'Show B2C payment details on the transaction', source: 'build', jiraKeys: [], components: [FE], createdAt: hrsAgo(3.2) },
    };

    const flagStates = {
        allowEvseNameEdit: { test: buildState(true, daysAgo(90), 'ci-bot'), qa: buildState(true, daysAgo(90), 'ci-bot'), prod: buildState(true, daysAgo(90), 'ci-bot') },
        assetNuvoloIntegrationEnabled: {
            test: buildState(true, daysAgo(60), 'a.kowalska'),
            qa: buildState(false, daysAgo(60), 'a.kowalska'),
            prod: { build: { enabled: true, changedAt: daysAgo(60), changedBy: 'a.kowalska' }, 'runtime-be': { enabled: false, changedAt: hrsAgo(20), changedBy: 'm.nowak (BE)' } },
        },
        availabilityActionsEnabled: { test: buildState(true, daysAgo(80), 'ci-bot'), qa: buildState(true, daysAgo(80), 'ci-bot'), prod: buildState(true, daysAgo(80), 'ci-bot') },
        b2cCustomersEnabled: { test: buildState(true, daysAgo(75), 'ci-bot'), qa: buildState(false, daysAgo(75), 'ci-bot'), prod: buildState(false, daysAgo(75), 'ci-bot') },
        changeCpmsAllowed: { test: beState(true, daysAgo(85), 'm.nowak (BE)'), qa: beState(true, daysAgo(85), 'm.nowak (BE)'), prod: beState(true, daysAgo(85), 'm.nowak (BE)') },
        chargerBaseEditEnabled: { test: buildState(true, daysAgo(85), 'ci-bot'), qa: buildState(true, daysAgo(85), 'ci-bot'), prod: buildState(true, daysAgo(85), 'ci-bot') },
        triggerMessageManualEnabled: { test: buildState(true, daysAgo(30), 'ci-bot'), qa: buildState(true, daysAgo(30), 'ci-bot'), prod: buildState(true, daysAgo(30), 'ci-bot') },
        ocppDeviationBadgeEnabled: { test: buildState(true, hrsAgo(1), 'Maciej Piasecki'), qa: buildState(true, hrsAgo(1), 'Maciej Piasecki'), prod: buildState(false, daysAgo(15), 'ci-bot') },
        ocppDeviationBadgeBffEnabled: { test: buildState(true, daysAgo(1), 'Kacper Jóźwiak'), qa: buildState(false, daysAgo(15), 'ci-bot'), prod: buildState(false, daysAgo(15), 'ci-bot') },
        triggerRetryEnabled: { test: buildState(true, daysAgo(10), 'ci-bot'), qa: buildState(true, daysAgo(10), 'ci-bot'), prod: buildState(true, daysAgo(10), 'ci-bot') },
    };

    const flagStateHistory = [
        { key: 'triggerMessageManualEnabled', env: 'qa', source: 'build', enabled: true, changedAt: hrsAgo(1), changedBy: 'Maciej Piasecki' },
        { key: 'ocppDeviationBadgeEnabled', env: 'qa', source: 'build', enabled: true, changedAt: hrsAgo(1), changedBy: 'Maciej Piasecki' },
        { key: 'assetNuvoloIntegrationEnabled', env: 'prod', source: 'runtime-be', enabled: false, changedAt: hrsAgo(20), changedBy: 'm.nowak (BE)' },
    ];

    const jiraIssues = [
        { key: 'EVP-4288', type: 'Epic', title: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Development' },
        { key: 'EBO-16955', type: 'Story', title: 'FE + BE: trigger message from connector level', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'Done', statusCategory: 'done', subtasks: { done: 3, total: 3 }, priority: 'High', resolvedAt: daysAgo(13) },
        { key: 'EBO-16964', type: 'Task', title: 'Persist last trigger payload for retries', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Progress', statusCategory: 'indeterminate', priority: 'Medium' },
        { key: 'EBO-16970', type: 'Bug', title: 'Trigger button double-submits on slow network', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: true, dependencyNote: 'Waits on EVP-5102 — connector firmware update', status: 'Blocked', statusCategory: 'indeterminate', impediment: true, priority: 'Highest' },
        // No flag anywhere links to this key (see flagsMeta below), yet it's deployed to test/qa/prod
        // (d2/d10/d16 above) — deliberately mirrors a real case we hit: Jira still shows it "In Test"
        // with open sub-tasks/bugs, while every env's pill says "Code deployed" since there's no flag to
        // confirm against. Exercises both the Jira-status tag and the sub-task ratio added to
        // renderIssueRow specifically so this mismatch is visible at a glance instead of only inside the
        // expanded breakdown.
        { key: 'EBO-17001', type: 'Story', title: 'FE + BE: retry queue viewer for failed trigger messages', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Test', statusCategory: 'indeterminate', subtasks: { done: 2, total: 6 }, priority: 'Medium' },
        { key: 'EVP-5406', type: 'Epic', title: '[Sparks][ARCH] Document all existing scopes in Swagger Hub', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', status: 'Ready for Prod' },
        { key: 'EBO-16820', type: 'Task', title: 'PH1 — documentation of scopes of the token', epicKey: 'EVP-5406', epicTitle: '[Sparks][ARCH] Document all existing scopes in Swagger Hub', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'Done', statusCategory: 'done', priority: 'Low', resolvedAt: daysAgo(46) },
        { key: 'EVP-5111', type: 'Epic', title: 'OCPP templates improvements — deviation visibility in Templates list', pi: 'PI-27.2', sprint: 'Sparks 27.2.4', projectName: 'eMobility Sparks', status: 'In Development' },
        { key: 'EBO-16702', type: 'Story', title: 'Show deviation badge in the OCPP templates list', epicKey: 'EVP-5111', epicTitle: 'OCPP templates improvements — deviation visibility in Templates list', pi: 'PI-27.2', sprint: 'Sparks 27.2.4', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Test', statusCategory: 'indeterminate', priority: 'High' },
        { key: 'EBO-16981', type: 'Bug', title: 'Fix stale cache on environment switch', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'To Do', statusCategory: 'new', priority: 'Medium' },
        // No child issues resolve `epicKey` to this one — exercises the empty-epic row (dash instead of
        // a chevron, not expandable) in Product view.
        { key: 'EVP-5522', type: 'Epic', title: 'Explore multi-connector charge scheduling', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', status: 'Backlog' },
    ];

    const componentsOrder = [
        { name: FE, description: 'EV Admin Panel — frontend', serviceType: 'FE', featureFlagsIncluded: true, application: ['EVAPL'] },
        { name: CH, description: 'Charger infrastructure management', serviceType: 'BE', featureFlagsIncluded: true, application: ['EVNM'] },
        { name: BO, description: 'Back-office web — frontend', serviceType: 'FE', featureFlagsIncluded: true, application: ['EBO'] },
        // false (not null) on purpose — shows the ⚑? "flags not tracked here" icon next to this row.
        { name: BF, description: 'Back-office web — BFF', serviceType: 'BE', featureFlagsIncluded: false, application: ['EBO'] },
        { name: SI, description: 'SIM adapter service', serviceType: 'BE', featureFlagsIncluded: null, application: ['EVSIM'] },
        { name: HO, description: 'Asset management host', serviceType: 'BE', featureFlagsIncluded: null, application: ['EVAM'] },
    ];

    // Release Notes-only history: a batch of already-released issues across several PIs/sprints, purely
    // to populate that tab in the fallback preview. Each (pi, sprint) group gets ONE synthetic prod
    // deployment carrying every issue key in that group as `relatedIssues` — that's enough for
    // issueIsReleasedToProd()'s deployed_code_only path (no flag needed) to mark them all released,
    // the same way a single release commonly ships many tickets at once. Deployed far enough in the past
    // (200+ days) that they never outrank the "current version" deploys set up above for the same
    // components in the Technical view.
    const releaseNotesSeed = [
        { pi: 'PI-27.3', sprint: 'Sparks 27.3.2', items: [
            ['Task', 'PH 1 Documentation of scopes of the token'],
            ['Task', 'Delete com4 related code from evboweb-bff'],
            ['Bug', 'Get on charger variant models returns 500 status due to index out of bounds exception'],
            ['Bug', 'Can\'t delete a template that shows 0 in the "total chargers" column on QA environment; an error toast says chargers are assigned'],
        ] },
        { pi: 'PI-27.3', sprint: 'Sparks 27.3.1', items: [
            ['Task', 'Remove deprecated code'],
            ['Task', 'Add additional logic to fill the connectionType field on charger'],
            ['Story', '[Not meeting DoR] OCPP configuration improvements'],
            ['Bug', 'Multiply same error message'],
            ['Bug', 'Invalid GET stalls query parameter added in request'],
            ['Bug', 'On the Add pool screen, clicking the Add pool button repeatedly creates duplicate records.'],
            ['Bug', 'Issue with DECOMMISSIONING a ROAMING Charger multiple times in a row.'],
        ] },
        { pi: 'PI-27.2', sprint: 'Sparks 27.2.5', items: [
            ['Story', 'FE: Refactor RQL library in EVA'],
            ['Story', 'FE: Restrict charger add/edit actions to network manager role'],
            ['Task', 'Remove rabbitmq settings from task-definitions'],
            ['Task', 'EVNM- Create additional alerts and statistics to prevent production incidents'],
            ['Task', 'Fe: Remake the data usage view in admin portal for new API'],
            ['Task', 'Enable switching of Outbox integration for evse status updates'],
            ['Story', 'BE+ FE - Export template chargers to CSV (with optional filters)'],
            ['Bug', 'Display name field covers button on Edit pool screen'],
            ['Bug', 'Not all chargers other than Roaming in all environments have Connection_type: cellular added.'],
            ['Bug', 'Lack of chargerIsProvisioned event when synchronized to CK CPMS'],
            ['Bug', 'Authentication methods are not selected by default per business branch in the Admin portal'],
            ['Bug', '[ocpp config] cyclical auto fetch should also work for chargers with no existing ocpp config'],
            ['Bug', 'Chargers cannot be switched back from CKPMS to Driivz via eBO/EVA cpms change'],
            ['Bug', 'Prevent decommissioning new charger with the same identity key as decommissioning charger'],
            ['Bug', 'Reports for roaming chargers on Mac with the Safari browser generate incorrect file formats.'],
            ['Bug', 'Manual template creation does not work on QA environment'],
            ['Bug', 'Showing that the Fetch config is clicked on OCPP keys when other sync is being done'],
            ['Bug', '"Create template" on ocpp keys sidepanel does not work properly'],
            ['Bug', 'BE + FE: Stalls list - No default DESC sorting on the "Label" column'],
        ] },
        { pi: 'PI-27.2', sprint: 'Sparks 27.2.4', items: [
            ['Story', 'PoC for Sparks Deployment Tracker'],
            ['Story', 'EVNM - critical user journey metric for statuses processing - time of statuses processing'],
            ['Story', 'Create a page with all feature flags for internal users, where feature flags statuses could be visible and modified'],
            ['Story', 'FE + BE- Template chargers side panel (view, filter, fetch latest config)'],
            ['Bug', '[PROD] Charger Displays CK_CPMS While All Charging Sessions Route Through Driivz'],
            ['Bug', 'In response for API for EVAPL FE → /internal/evapl/api/v1/chargers when validation fails a 500 error code is returned, which is misleading for the user'],
        ] },
        { pi: 'PI-27.2', sprint: 'Sparks 27.2.3', items: [
            ['Task', 'BE: Change lock handling of domain refresh process when there is shutdown of service'],
            ['Task', 'Update dependencies in projects'],
            ['Bug', 'White screen after log in to EVA'],
            ['Bug', 'Block the option to create a transit charger from EVA if there is no Transit Location'],
        ] },
        { pi: 'PI-27.2', sprint: 'Sparks 27.2.2', items: [
            ['Story', 'FE + BE: Extend Stall single view with data about charger assigned'],
        ] },
        { pi: 'PI-27.2', sprint: null, items: [
            ['Epic', 'OCPP templates improvements - deviation visibility in Templates list'],
            ['Epic', '[Driivz exit] OCPP templates and configurations improvements (placeholder)'],
            ['Epic', 'OCPP templates: Fix N/A handlig and deviation accuracy'],
        ] },
        { pi: 'PI-27.1', sprint: 'Sparks PI-27.1.5', items: [
            ['Task', '[security] migrate to ministack'],
        ] },
        { pi: 'PI-27.1', sprint: 'Sparks PI-27.1.4', items: [
            ['Task', 'Ugrade Spring to 4.x to reduce technical debt'],
            ['Task', 'Add slack notifications for failed main builds/deployments on our products'],
            ['Bug', 'Issue with lack of failed requests and logs on BFF'],
        ] },
        { pi: 'PI-27.1', sprint: null, items: [
            ['Epic', '[driivz exit] Creation of stall-based chargers in Admin portal on CK-CPMS (Greenfield only)'],
            ['Epic', '[1CP][M4][Sparks] [PLACEHOLDER] Performance improvements based on tests results + needed adjustments'],
            ['Epic', 'Bulk Editing of Stall Configurations'],
        ] },
        { pi: 'PI-26.5', sprint: 'Sparks PI-26.5.3', items: [
            ['Task', 'Improve evtools logging library - adapt to standard'],
        ] },
    ];

    let relKeyCounter = 6000;

    releaseNotesSeed.forEach((group, gi) => {
        const keysInGroup = [];

        group.items.forEach(([type, title]) => {
            relKeyCounter++;

            const key = `EVP-${relKeyCounter}`;
            const issue = { key, type, title, pi: group.pi, projectName: 'eMobility Sparks', dependencyBlocked: false };

            if (group.sprint) {
                issue.sprint = group.sprint;
            }

            keysInGroup.push(key);
            jiraIssues.push(issue);
        });

        deployments.push({
            id: `relnotes-${gi}`,
            component: ALL[gi % ALL.length],
            environment: 'prod',
            version: `rel-${(group.sprint || group.pi).replace(/\s+/g, '-')}`,
            deployedAt: daysAgo(200 + gi * 5),
            deployedBy: 'ci-bot',
            status: 'success',
            relatedIssues: keysInGroup,
        });
    });

    // Mirrors sync-jira.js's own per-PI sharding (see CLAUDE.md's Jira issues section): group the flat
    // seed list above by `pi`, and build the same `{ currentPi, pis: [{ pi, sprints }] }` shape
    // index.json carries, so the fallback path can be driven through the exact same loadJiraIssuesForPi()
    // as the real data instead of a separate offline-only code path.
    const jiraIssuesByPi = new Map();

    jiraIssues.forEach(issue => {
        if (!jiraIssuesByPi.has(issue.pi)) jiraIssuesByPi.set(issue.pi, []);
        jiraIssuesByPi.get(issue.pi).push(issue);
    });

    const sprintsByPi = new Map();

    jiraIssues.forEach(issue => {
        if (!issue.sprint) return;
        if (!sprintsByPi.has(issue.pi)) sprintsByPi.set(issue.pi, new Map());

        const bySprint = sprintsByPi.get(issue.pi);

        if (!bySprint.has(issue.sprint)) bySprint.set(issue.sprint, { name: issue.sprint, startDate: null, endDate: null });
    });

    const piEntries = [...jiraIssuesByPi.keys()].sort(compareVersionDesc).map(pi => ({
        pi,
        sprints: [...(sprintsByPi.get(pi)?.values() || [])],
    }));
    const jiraIndex = { currentPi: piEntries[0]?.pi || null, pis: piEntries };

    return { deployments, flagsMeta, flagStates, flagStateHistory, jiraIssuesByPi, jiraIndex, componentsOrder };
}

const FALLBACK = buildFallbackData();

async function loadData(){
    try {
        const [deployments, flagsMeta, flagStates, jiraIndex] = await Promise.all([
            fetch('data/deployments.json').then(r=>{ if(!r.ok) throw new Error(); return r.json(); }),
            fetch('data/flags-meta.json').then(r=>{ if(!r.ok) throw new Error(); return r.json(); }),
            fetch('data/flag-states.json').then(r=>{ if(!r.ok) throw new Error(); return r.json(); }),
            fetch('data/jira-issues/index.json').then(r=>{ if(!r.ok) throw new Error(); return r.json(); }),
        ]);
        document.getElementById('statusBadge').classList.remove('fallback');
        document.getElementById('statusBadge').title = '';
        document.getElementById('statusBadgeLabel').textContent = 'Live';

        // Best-effort: this file is newer than the other four, and losing the flag audit trail
        // shouldn't take down the rest of the dashboard if it's ever missing.
        const flagStateHistory = await fetch('data/flag-state-history.json')
            .then(r => r.ok ? r.json() : [])
            .catch(() => []);

        // Best-effort: only used to order the Technical view's component rows the way they were
        // onboarded instead of alphabetically — missing/unreachable just falls back to alphabetical.
        const componentsOrder = await fetch('components.json')
            .then(r => r.ok ? r.json() : null)
            .then(json => (json && json.components) || [])
            .catch(() => []);

        // Best-effort: written only by the branch of orchestrate-full-sync.yml that syncs every tracked
        // component (cron safety net, manual run, or an unknown/malformed dispatch), never by a
        // single-component repository_dispatch — so this is "all data last confirmed against the real
        // state," not just "something changed." Missing/unreachable just hides the line below the tag.
        const syncMeta = await fetch('data/sync-meta.json')
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);

        document.getElementById('statusBadgeTime').textContent = syncMeta && syncMeta.lastFullSync
            ? `synced ${new Date(syncMeta.lastFullSync).toLocaleTimeString('pl-PL', {hour:'2-digit', minute:'2-digit'})} · source: data/*.json`
            : 'source: data/*.json';

        return { deployments, flagsMeta, flagStates, jiraIndex, flagStateHistory, componentsOrder, isFallback: false };
    } catch(e) {
        document.getElementById('statusBadge').classList.add('fallback');
        document.getElementById('statusBadge').title = 'Built-in fallback data — preview without a file server';
        document.getElementById('statusBadgeLabel').textContent = 'Fallback';
        document.getElementById('statusBadgeTime').textContent = 'source: data/*.json (mock)';

        return { ...FALLBACK, isFallback: true };
    }
}

/** Fetches one PI's Jira issues — the per-PI shard named in `state.jiraIndex.pis` (or, in fallback mode,
 *  the matching slice of the embedded seed data) — and returns a plain array. Called once up front for
 *  the initial PI (see init()) and again whenever the global PI select changes. Never touches
 *  `state.jiraIssues` itself, so callers can swap it in only once the fetch actually resolves. */
async function loadJiraIssuesForPi(pi){
    if (!pi) return [];

    if (state.isFallback) {
        return FALLBACK.jiraIssuesByPi.get(pi) || [];
    }

    const entry = state.jiraIndex.pis.find(e => e.pi === pi);

    if (!entry) return [];

    return fetch(`data/jira-issues/${entry.file}`).then(r => r.ok ? r.json() : []).catch(() => []);
}

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
function issueDeployedOnComponent(component, issueKey, env) {
    return componentDeployments(component, env).find(d => (d.relatedIssues || []).includes(issueKey)) || null;
}
/** Any successful deployment (on any component) that references this issue key, ignoring flags entirely. */
function anyDeploymentForIssue(issueKey, env){
    return state.deployments.some(d =>
        d.environment === env && d.status === 'success' && (d.relatedIssues || []).includes(issueKey)
    );
}
function issueLinks(issue){
    const flags = flagsForIssue(issue.key);
    const pairs = [];

    flags.forEach(f => (f.components || []).forEach(c => pairs.push({component:c, flagKey:f.key})));

    return pairs;
}
function linkStatus(link, issueKey, env){
    const dep = issueDeployedOnComponent(link.component, issueKey, env);
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
        const deployedHere = anyDeploymentForIssue(issue.key, env);

        return { level: deployedHere ? 'deployed_code_only' : 'none', blocked:false, results:[] };
    }

    const results = pairs.map(l => ({
        ...linkStatus(l, issue.key, env),
        component: l.component,
        flagKey: l.flagKey
    }));
    const allDeployed = results.every(r=> r.deployed);
    const noneDeployed = results.every(r=> !r.deployed);
    const allReleased = results.every(r=> r.released);
    const noneReleased = results.every(r=> !r.released);
    let level;

    if (noneDeployed) {
        level = 'none';
    } else if (allReleased) {
        level = 'released';
    } else if (allDeployed && noneReleased) {
        level = 'deployed';
    } else {
        level = 'partial';
    }

    let blocked = false;

    if (env === 'prod' && issue.dependencyBlocked && level === 'released'){
        level = 'deployed';
        blocked = true;
    }

    return { level, blocked, results };
}
function statusLabel(level){
    return { none:'Not deployed', deployed:'Deployed (hidden)', released:'Released', partial:'Partial', deployed_code_only:'Code deployed' }[level];
}
function statusClass(level){
    return { none:'st-none', deployed:'st-deployed', released:'st-released', partial:'st-partial', deployed_code_only:'st-deployed' }[level];
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
        return `<span class="tag ${cls}" title="Jira status">${status}</span>`;
    }

    return `<span class="tag tag-flagged ${cls}" title="Jira status (flagged as impediment)">${ICONS.flag}<span>${status}</span></span>`;
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

    return `<span class="tag ${cls}" title="Sub-tasks">${subtasks.done}/${subtasks.total} sub-tasks</span>`;
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
        const dep = issueDeployedOnComponent(l.component, issue.key, env);

        if (dep) {
            consider(dep.deployedAt);
        }

        const fs = state.flagStates[l.flagKey] ? state.flagStates[l.flagKey][env] : null;

        if (fs) {
            consider(fs.changedAt);
        }
    });

    // For flag-less (fallback-derived) issues, fall back to raw deployment dates too.
    if (!issueLinks(issue).length) {
        state.deployments
            .filter(d => d.environment === env && d.status === 'success' && (d.relatedIssues || []).includes(issue.key))
            .forEach(d => consider(d.deployedAt));
    }

    return latest;
}
function issueLastChange(issue){
    const dates = [issueEnvDate(issue, 'test'), issueEnvDate(issue, 'qa'), issueEnvDate(issue, 'prod')].filter(Boolean);

    if (!dates.length) {
        return null;
    }

    return dates.reduce((latest, d) => (d > latest ? d : latest));
}

/** True if this looks like a real PI value (e.g. "PI-24.4"), not a placeholder like "—". */
function isRealPi(pi){
    return !!pi && pi !== '—' && /PI-?\d+\.\d+/i.test(pi);
}

/** Sorts PI labels ("PI-27.2") and sprint names (any string with a "27.2.3"-shaped run of numbers in it,
 *  same numeric shape sync-jira.js's extractPiFromSprintName looks for) newest-first, e.g. 27.2 before
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
        if (issue.type === 'Epic') {
            ensureGroup(issue.key, issue.title).epicIssue = issue;
        } else if (issue.epicKey) {
            ensureGroup(issue.epicKey, issue.epicTitle).children.push(issue);
        } else {
            ungrouped.push(issue);
        }
    });

    return { groups: order.map(key => groups.get(key)), ungrouped };
}

/** How many of an Epic's (filtered) children are strictly `released` on prod (flag confirmed on) — the
 *  same bucket the summary tiles/`prodStatusBucket()` count as "Released", not the broader
 *  `issueIsReleasedToProd()` (which also counts `deployed_code_only`, i.e. code shipped with no flag to
 *  confirm against). Deliberately the stricter of the two: conflating "code deployed, unconfirmed" into
 *  this badge's "released" count would hide exactly the signal that should prompt someone to go check the
 *  actual flag state for that environment, and would make this badge disagree with the tiles rendered
 *  right above it for the same PI. `null` when there are no children to roll up (e.g. a Type filter hid
 *  them all, leaving just the Epic itself). */
function epicRollup(children){
    if (!children.length) {
        return null;
    }

    return { released: children.filter(c => prodStatusBucket(c) === 'released').length, total: children.length };
}

/** Buckets an issue's PROD status into the 4 summary-row/status-tile buckets: released, code (shipped
 *  but hidden behind a flag, or shipped with no flag to check at all — same "shipped, visibility
 *  unconfirmed" grouping the Insights chart already uses), partial, or none. */
function prodStatusBucket(issue){
    const level = issueStatusForEnv(issue, 'prod').level;

    if (level === 'released') {
        return 'released';
    }
    if (level === 'deployed' || level === 'deployed_code_only') {
        return 'code';
    }
    if (level === 'partial') {
        return 'partial';
    }

    return 'none';
}

/** The PI the team is presumed to be working in right now — resolved server-side by sync-jira.js (from a
 *  configured board's active sprint, falling back to the highest PI seen among synced non-Epic issues —
 *  see CLAUDE.md's Jira issues section) and shipped in `data/jira-issues/index.json`, since `state.jiraIssues`
 *  itself only ever holds one PI's worth of data now (whichever is currently selected — see
 *  `state.selectedPi`), not every PI, so there's nothing to scan client-side any more. */
function currentPi(){
    return (state.jiraIndex && state.jiraIndex.currentPi) || null;
}

/** Non-Epic issue counts for the currently-loaded PI, bucketed by PROD status — epics are never counted
 *  directly (per the Product view summary row spec), only their children. `state.jiraIssues` already only
 *  ever holds one PI's issues (see `state.selectedPi`), so there's no `pi` to filter by any more. */
function piWorkItemCounts(){
    const counts = { released: 0, code: 0, partial: 0, none: 0 };
    const items = state.jiraIssues.filter(i => i.type !== 'Epic');

    items.forEach(i => { counts[prodStatusBucket(i)]++; });

    return { counts, total: items.length };
}

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
    const barHtml = `<div class="pv-pi-bar">
        ${onProd ? `<div class="pv-pi-bar-seg" style="width:${pct(onProd)}%"></div>` : ''}
      </div>`;

    const piCardHtml = `
    <div class="pv-pi-card">
      <div class="pv-pi-top">
        <span class="pv-pi-name">${targetPi || '—'}</span>
        ${showCurrentTag ? `<span class="pv-pi-current-tag">current PI</span>` : ''}
      </div>
      ${barHtml}
      <div class="pv-pi-meta"><span><b>${total}</b> item${total===1?'':'s'}</span><span class="deploy-meta-dot"></span><span><b>${onProd}/${total}</b> on prod</span></div>
    </div>`;

    const tiles = [
        { key: 'released', label: 'Released', color: 'var(--nd-released)', value: counts.released },
        { key: 'code', label: 'Code deployed', color: 'var(--nd-code)', value: counts.code },
        { key: 'partial', label: 'Partial', color: 'var(--nd-warn)', value: counts.partial },
        { key: 'none', label: 'Not deployed', color: 'var(--nd-fg-4)', value: counts.none },
    ];

    // Not clickable for now (see activeStatusTile/prodStatusBucket in renderIssues, kept in place so
    // this is a one-line revert — just re-add the .pv-tile click wiring below to turn tile-click
    // filtering back on): plain <div>s instead of <button>s, so they don't look/focus like controls.
    const tilesHtml = tiles.map(t => `
      <div class="pv-tile${activeStatusTile === t.key ? ' active' : ''}" data-tile-key="${t.key}">
        <div class="pv-tile-top"><span class="pv-tile-swatch" style="background:${t.color}"></span><span class="pv-tile-label">${t.label}</span></div>
        <div class="pv-tile-bottom"><span class="pv-tile-value">${t.value}</span><span class="pv-tile-total">${total ? Math.round(t.value/total*100) : 0}% of items</span></div>
      </div>`).join('');

    box.innerHTML = piCardHtml + tilesHtml;
}

function renderIssues(){
    const typeFilter = document.getElementById('filterType').value;
    const priorityFilter = document.getElementById('filterPriority').value;
    const fromVal = document.getElementById('filterFrom').value;
    const toVal = document.getElementById('filterTo').value;
    const from = fromVal ? new Date(fromVal) : null;
    const to = toVal ? new Date(new Date(toVal).getTime()+86400000) : null;
    // `state.jiraIssues` already only holds the currently-selected PI's issues (see `state.selectedPi`) —
    // just the date range is left to filter here.
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

    // Deliberately date-filtered but NOT type/priority/status-tile-filtered — an Epic's rollup badge
    // should still reflect its real children even when Type, Priority, or a status tile hides them from
    // `allIssues` below.
    const rollupChildrenByEpicKey = new Map();

    state.jiraIssues.filter(passesDate).forEach(i => {
        if (i.type === 'Epic' || !i.epicKey) {
            return;
        }
        if (!rollupChildrenByEpicKey.has(i.epicKey)) {
            rollupChildrenByEpicKey.set(i.epicKey, []);
        }

        rollupChildrenByEpicKey.get(i.epicKey).push(i);
    });

    let allIssues = state.jiraIssues.filter(i =>
        passesDate(i)
        && (!typeFilter || i.type === typeFilter)
        && (!priorityFilter || i.priority === priorityFilter)
        && (!activeStatusTile || prodStatusBucket(i) === activeStatusTile)
    );

    document.getElementById('issueCount').innerHTML = `<span class="pv-count-num">${allIssues.length}</span> item${allIssues.length===1?'':'s'}`;

    const body = document.getElementById('issueBody');

    if (!allIssues.length) {
        body.innerHTML = '<div class="empty">No results for the selected filters</div>';
        return;
    }

    const issues = allIssues.slice(0, visibleIssueCount);

    const renderIssueRow = (issue, indent) => {
        const test = issueStatusForEnv(issue, 'test');
        const qa = issueStatusForEnv(issue, 'qa');
        const prod = issueStatusForEnv(issue, 'prod');
        const testDate = issueEnvDate(issue, 'test');
        const qaDate = issueEnvDate(issue, 'qa');
        const prodDate = issueEnvDate(issue, 'prod');
        const isOpen = expandedIssue === issue.key;
        const titleHtml = issue.title && issue.title !== '—'
            ? issue.title
            : '<span style="color:var(--nd-fg-4); font-style:italic; font-weight:400;">title unavailable (Jira access pending)</span>';
        const rowClass = indent ? 'wi-child-row' : 'wi-ungrouped-row';

        return `
    <div class="wi-row ${rowClass}" data-key="${issue.key}">
      <div>
        <a class="wi-title wi-child-title" href="${JIRA_BASE_URL}/${issue.key}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${titleHtml}</a>
        <div class="wi-child-meta">
          <span class="wi-type">${issue.type}</span>
          <span class="tag mono">${issue.key}</span>
          ${jiraStatusTagHtml(issue.status, issue.impediment)}
          ${subtasksTagHtml(issue.subtasks)}
          ${issue.projectName ? `<span class="tag" title="Jira project">${issue.projectName}</span>` : ''}
          ${isRealPi(issue.pi) ? `<span class="pi-tag">${issue.pi}</span>` : ''}
        </div>
      </div>
      <div>
        <span class="status-pill ${statusClass(test.level)}">${statusLabel(test.level)}</span>
        <div class="status-date">${testDate ? relTime(testDate.toISOString()) : '—'}</div>
      </div>
      <div>
        <span class="status-pill ${statusClass(qa.level)}">${statusLabel(qa.level)}</span>
        <div class="status-date">${qaDate ? relTime(qaDate.toISOString()) : '—'}</div>
      </div>
      <div>
        ${prod.blocked
            ? `<span class="status-pill st-dependency">Dependency</span>
               <div class="status-date">${issue.dependencyNote || 'blocked by a dependency'}</div>`
            : `<span class="status-pill ${statusClass(prod.level)}">${statusLabel(prod.level)}</span>
               <div class="status-date">${prodDate ? relTime(prodDate.toISOString()) : '—'}</div>`}
      </div>
    </div>
    ${isOpen ? `<div class="breakdown">
        ${issueLinks(issue).length ? `
        <table class="breakdown-table">
          <thead><tr><th>Component</th><th>Flag</th><th>TEST code</th><th>TEST flag</th><th>QA code</th><th>QA flag</th><th>PROD code</th><th>PROD flag</th></tr></thead>
          <tbody>
          ${issueLinks(issue).map(l=>{
            const tr_ = linkStatus(l, issue.key, 'test'); const qr = linkStatus(l, issue.key, 'qa'); const pr = linkStatus(l, issue.key, 'prod');
            const yes = '<span class="dot-yes">●</span>', no = '<span class="dot-no">○</span>';
            return `<tr>
              <td><b>${l.component}</b></td>
              <td class="mono">${l.flagKey}</td>
              <td>${tr_.deployed ? yes+' deployed' : no+' <span class="muted-label">not found</span>'}</td>
              <td>${tr_.flagOn ? yes+' ON' : no+' <span class="muted-label">OFF</span>'}</td>
              <td>${qr.deployed ? yes+' deployed' : no+' <span class="muted-label">not found</span>'}</td>
              <td>${qr.flagOn ? yes+' ON' : no+' <span class="muted-label">OFF</span>'}</td>
              <td>${pr.deployed ? yes+' deployed' : no+' <span class="muted-label">not found</span>'}</td>
              <td>${pr.flagOn ? yes+' ON' : no+' <span class="muted-label">OFF</span>'}</td>
            </tr>`;
        }).join('')}
          </tbody>
        </table>
        <div class="breakdown-hint">"Not found" means no successful deployment of that component carried a commit referencing ${issue.key} yet.</div>
        ` : `<div class="breakdown-row" style="justify-content:flex-start;">No flag linked to ${issue.key} — ${statusLabel(issueStatusForEnv(issue,'test').level)==='Code deployed' || statusLabel(issueStatusForEnv(issue,'qa').level)==='Code deployed' || statusLabel(issueStatusForEnv(issue,'prod').level)==='Code deployed' ? 'code found in deployment history, but no flag tracks it yet' : 'check flags-meta.json (jiraKeys)'}</div>`}
        ${issue.dependencyBlocked ? `<div class="breakdown-row"><span>Blocking dependency</span><span style="color:var(--blocked)">${issue.dependencyNote||'unresolved'}</span></div>` : ''}
    </div>` : ''}
    `;
    };

    const renderEpicHeader = group => {
        const rollup = epicRollup(rollupChildrenByEpicKey.get(group.epicKey) || []);
        const piHtml = group.epicIssue && isRealPi(group.epicIssue.pi) ? `<span class="pi-tag">${group.epicIssue.pi}</span>` : '';
        const statusHtml = group.epicIssue ? jiraStatusTagHtml(group.epicIssue.status, group.epicIssue.impediment) : '';
        const collapsed = collapsedEpics.has(group.epicKey);
        const hasChildren = group.children.length > 0;
        const barColor = !rollup ? null : rollup.released === rollup.total ? 'var(--nd-released)' : 'var(--nd-warn)';
        const labelColor = !rollup ? 'var(--nd-fg-3)' : rollup.released === rollup.total ? 'var(--nd-released)' : rollup.released ? 'var(--nd-warn)' : 'var(--nd-fg-3)';

        return `
    <div class="wi-row wi-epic-row${hasChildren ? '' : ' wi-epic-row-empty'}" data-epic-key="${group.epicKey}">
      <div class="wi-epic-cell">
        ${hasChildren ? `<span class="wi-epic-chevron${collapsed ? '' : ' open'}">${ICONS.chevron}</span>` : `<span class="wi-epic-chevron-empty" title="No linked work items">–</span>`}
        <div class="wi-epic-stack">
          <a class="wi-title wi-epic-title" href="${JIRA_BASE_URL}/${group.epicKey}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${group.epicTitle || group.epicKey}</a>
          <div class="wi-epic-badges">
            <span class="wi-type">Epic</span>
            <span class="tag mono">${group.epicKey}</span>
            ${statusHtml}
            ${subtasksTagHtml(group.epicIssue && group.epicIssue.subtasks)}
            ${piHtml}
          </div>
        </div>
      </div>
      ${rollup ? `
      <div class="wi-epic-progress">
        <div class="wi-epic-bar"><div class="wi-epic-bar-fill" style="width:${(rollup.released/rollup.total*100).toFixed(1)}%; background:${barColor}"></div></div>
        <div class="wi-epic-progress-label"><b style="color:${labelColor}">${rollup.released}/${rollup.total}</b> released to prod</div>
      </div>` : `<div class="wi-epic-progress"></div>`}
    </div>`;
    };

    const { groups, ungrouped } = groupIssuesByEpic(issues);
    const groupsHtml = groups.map(group => renderEpicHeader(group) + (collapsedEpics.has(group.epicKey) ? '' : group.children.map(c => renderIssueRow(c, true)).join(''))).join('');
    const ungroupedHtml = ungrouped.length
        ? `<div class="wi-ungrouped-label-row">Ungrouped</div>${ungrouped.map(issue => renderIssueRow(issue, false)).join('')}`
        : '';

    body.innerHTML = groupsHtml + ungroupedHtml;

    if (visibleIssueCount < allIssues.length) {
        body.innerHTML += `<div class="load-more-sentinel" id="issueLoadMore">Loading more…</div>`;
    }

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

function resetIssuePagination(){
    visibleIssueCount = ISSUE_PAGE_SIZE;
    renderIssues();
}

/**
 * Repopulates the Type/Priority filter *options* from whichever PI is currently loaded — both are derived
 * from `state.jiraIssues`, which only ever holds one PI's worth of data now (see `state.selectedPi`), so
 * these can't just be set once at init any more; called again on every PI switch (`initGlobalPiSelect()`).
 */
function refreshProductViewFilterOptions(){
    const typeGroup = document.getElementById('filterTypeGroup');

    typeGroup.querySelectorAll('.segmented-btn:not([data-value=""])').forEach(b => b.remove());

    const types = [...new Set(state.jiraIssues.map(i=> i.type))].sort();

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

    ['filterFrom','filterTo'].forEach(id=> document.getElementById(id).addEventListener('input', resetIssuePagination));
    document.getElementById('btnClearFilters').onclick = ()=> {
        typeGroup.querySelectorAll('.segmented-btn').forEach(b=> b.classList.remove('active'));
        typeGroup.querySelector('.segmented-btn[data-value=""]').classList.add('active');
        typeInput.value='';
        prioritySel.value='';
        document.getElementById('filterFrom').value='';
        document.getElementById('filterTo').value='';
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

    const types = [...new Set(allRealPiIssues.map(i => i.type))].sort();

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
    const level = issueStatusForEnv(issue, 'prod').level;

    return level === 'released' || level === 'deployed_code_only';
}

/** Short 2-letter avatar tag for a component. Real components follow the "xxx-service-<role>" naming
 *  convention (host / frontend / bff / charger-infrastructure / sim-adapter) — pulls the word after
 *  "-service-" and shortens it, except literal fe/frontend -> "FE" and be/backend -> "BE". Falls back to
 *  the component name's own first two letters if the naming pattern doesn't match at all. */
function componentKind(comp){
    const m = comp.match(/-service-([a-z0-9]+)/i);
    const word = m ? m[1] : comp;

    if (/^(fe|frontend)$/i.test(word)) {
        return 'FE';
    }
    if (/^(be|backend)$/i.test(word)) {
        return 'BE';
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
        const d = currentVersion(comp, 'prod');

        return d && d.driftBehind && d.driftBehind.commitCount && d.driftBehind.behindEnv === 'qa';
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

    const cards = [
        { label:'Services tracked', value:String(total), note:`across ${ENVIRONMENTS.length} stages` },
        { label:'Prod in sync with QA', value:`${total - prodBehind}/${total}`, note: prodBehind ? `${prodBehind} service${prodBehind===1?'':'s'} behind` : 'all services in sync', warn: !!prodBehind, ok: !prodBehind },
        { label:'Deploys today', value:String(deploysToday.length), note: failedToday ? `${failedToday} failed` : (deploysToday.length ? 'all succeeded' : 'no deploys yet'), warn: !!failedToday, ok: !failedToday && !!deploysToday.length },
        // Always phrased as a comparison against the build default — with a single diverging env
        // that's still "env ≠ build default", not a bare env name with nothing to compare it to.
        { label:'Flags diverging', value:String(divergingFlagCount), note: divergingEnvs.size ? `${[...divergingEnvs].map(e => e.toUpperCase()).join(', ')} ≠ build default` : 'all flags in sync', warn: !!divergingFlagCount, ok: !divergingFlagCount },
    ];

    box.innerHTML = cards.map(c => `
    <div class="summary-card">
      <div class="summary-label">${c.label}</div>
      <div class="summary-value">${c.value} <span class="summary-note${c.warn ? ' summary-note-warn' : (c.ok ? ' summary-note-ok' : '')}">${c.note}</span></div>
    </div>`).join('');
}

/* ---------- Rendering: technical view ---------- */
function renderMatrix(){
    const m = document.getElementById('matrix');
    const components = orderedComponents([...new Set(state.deployments.map(d=> d.component))]);
    const flagEntries = Object.entries(state.flagsMeta).sort((a,b) => a[0].localeCompare(b[0]));

    m.innerHTML = '';

    const flagsScrollEls = [];

    ENVIRONMENTS.forEach((env, envIndex)=>{
        const card = document.createElement('div');
        card.className = 'env-card';

        // First env has nothing "before" it to be behind — everything else compares against the
        // previous stage in the promotion chain (test -> qa -> prod), same chain driftBehind already
        // walks in sync-github-deployments.js.
        const prevEnv = ENVIRONMENTS[envIndex - 1];
        const behindCount = prevEnv
            ? components.filter(comp => {
                const d = currentVersion(comp, env);

                return d && d.driftBehind && d.driftBehind.commitCount && d.driftBehind.behindEnv === prevEnv;
            }).length
            : 0;
        const rightNoteHtml = !prevEnv
            ? `<span class="env-status-note">latest builds</span>`
            : behindCount
                ? `<span class="env-status-note env-status-warn">${behindCount} behind ${prevEnv.toUpperCase()}</span>`
                : `<span class="env-status-note">in sync with ${prevEnv.toUpperCase()}</span>`;

        card.innerHTML = `
      <div class="env-title-row">
        <div class="env-title">${barsIcon(ENV_BAR_COUNT[env])}${env}<span class="env-count">${components.length} service${components.length===1?'':'s'}</span></div>
        ${rightNoteHtml}
      </div>`;

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
            // the row-height alignment pass below (and misaligns the flags rows further down).
            components.forEach(comp=>{
                const d = currentVersion(comp, env);
                const row = document.createElement('div');
                const meta = componentMeta(comp);
                const nameTitle = meta && meta.description ? ` title="${meta.description}"` : '';
                // Explicitly false (not just missing/unconfirmed) means: this component has feature
                // flags, but ShipScope doesn't track them yet — call that out so an empty-looking Flags
                // panel below isn't mistaken for "this component has no flags at all".
                const flagsNotTrackedIcon = meta && meta.featureFlagsIncluded === false
                    ? `<span class="flags-not-tracked-icon" title="Feature flags for this component aren't tracked in the Flags panel below yet — check with the owning team directly.">${ICONS.flag}<span class="flags-not-tracked-mark">?</span></span>`
                    : '';
                // .comp-name is the flex row: avatar on the left, then a plain block "stack" to its
                // right holding the name (and, once there's a deploy, the version underneath it as a
                // separate block line) — the avatar never becomes part of that stack, so the version
                // lines up under the name's own left edge, not under the avatar.
                const nameLineHtml = `${comp}${flagsNotTrackedIcon}`;

                row.className = 'comp-row';

                if (!d) {
                    row.style.cursor = 'default';
                    row.innerHTML = `
        <div class="comp-name"${nameTitle}>
          <span class="comp-avatar">${componentKind(comp)}</span>
          <div class="comp-name-stack">${nameLineHtml}</div>
        </div>
        <div class="comp-meta"><div class="rel-time">not deployed</div></div>`;
                } else {
                    const versionHtml = d.commitUrl
                        ? `<a href="${d.commitUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${d.version}</a>`
                        : d.version;
                    const looksLikeVersion = /^v?\d+\.\d+\.\d+/.test(d.version);

                    row.dataset.status = d.status;
                    row.innerHTML = `
        <div class="comp-name"${nameTitle}>
          <span class="comp-avatar">${componentKind(comp)}</span>
          <div class="comp-name-stack">${nameLineHtml}${looksLikeVersion ? `<div class="rel-time">${d.version}</div>` : ''}</div>
        </div>
        <div class="comp-meta">
          <div class="version"><span class="status-dot status-${d.status}"></span>${versionHtml}</div>
          <div class="rel-time">${relTime(d.deployedAt)}</div>
          ${d.driftBehind && d.driftBehind.commitCount ? `<div class="drift-note">${ICONS.warn} ${d.driftBehind.commitCount} behind ${d.driftBehind.behindEnv.toUpperCase()}</div>` : ''}
          ${d.driftBehind && d.driftBehind.untestedCommitCount ? `<div class="drift-note">${ICONS.warn} ${d.driftBehind.untestedCommitCount} commit(s) skipped ${d.driftBehind.untestedIn.toUpperCase()}</div>` : ''}
        </div>`;
                    row.onclick = ()=> {
                        document.getElementById('filterEnv').value = env;
                        document.getElementById('filterComponent').value = comp;
                        // The matrix always shows the single latest record regardless of age (see
                        // renderTimeline()'s cutoff comment) — clear any active date-range filter so
                        // jumping here from the matrix can never land on an empty "No activity" list.
                        document.getElementById('filterDeployRange').value = '';
                        resetDeployPagination();
                    };
                }

                deployedContent.appendChild(row);
            });
        }

        card.appendChild(deployedContent);

        const flagsLabel = document.createElement('div');

        flagsLabel.className = 'snapshot-section-label snapshot-flags-label';
        flagsLabel.innerHTML = `Flags · Effective <span class="info-tip" title="Effective value per environment — when a flag is set on both FE and BE, the BE value wins.">${ICONS.info}</span>`;
        card.appendChild(flagsLabel);

        const flagsList = document.createElement('div');

        flagsList.className = 'env-flags-scroll';
        flagEntries.forEach(([key, f])=> {
            const envEntry = state.flagStates[key] ? state.flagStates[key][env] : null;
            const fs = effectiveFlagState(envEntry);
            const row = document.createElement('div');

            row.className = 'flag-row';
            row.dataset.flagKey = key;

            let stateHtml, stateClass;

            if (!fs) {
                stateHtml = '—';
                stateClass = 'flag-missing-text';
                row.title = '';
            } else {
                const on = !!fs.enabled;

                stateHtml = on ? 'ON' : 'OFF';
                stateClass = on ? 'flag-on-text' : 'flag-off-text';
                row.title = `[${fs.source}] changed ${relTime(fs.changedAt)} by ${fs.changedBy}`;
            }
            row.innerHTML = `<span class="flag-row-name">${key}</span><span class="flag-row-state ${stateClass}">${stateHtml}</span>`;
            flagsList.appendChild(row);
        });

        card.appendChild(flagsList);
        flagsScrollEls.push(flagsList);

        m.appendChild(card);
    });

    let syncingFlagsScroll = false;

    flagsScrollEls.forEach(el => {
        el.addEventListener('scroll', ()=>{
            if (syncingFlagsScroll) {
                return;
            }

            syncingFlagsScroll = true;
            flagsScrollEls.forEach(other => {
                if (other !== el) {
                    other.scrollTop = el.scrollTop;
                }
            });
            syncingFlagsScroll = false;
        });
    });

    if (!m.dataset.hoverBound) {
        m.dataset.hoverBound = '1';
        m.addEventListener('mouseover', (e)=>{
            const row = e.target.closest('.flag-row');

            if (!row || !row.dataset.flagKey) {
                return;
            }

            m.querySelectorAll(`.flag-row[data-flag-key="${CSS.escape(row.dataset.flagKey)}"]`).forEach(r=> r.classList.add('flag-row-highlight'));
        });
        m.addEventListener('mouseout', (e)=>{
            const row = e.target.closest('.flag-row');

            if (!row || !row.dataset.flagKey) {
                return;
            }

            m.querySelectorAll(`.flag-row[data-flag-key="${CSS.escape(row.dataset.flagKey)}"]`).forEach(r=> r.classList.remove('flag-row-highlight'));
        });
    }
}

let visibleDeployCount = 20;
const DEPLOY_PAGE_SIZE = 20;

/** Joins the pieces of a .deploy-meta line (time / author / duration / "N deploys" toggle, ...) with a
 *  `.deploy-meta-dot` separator instead of a plain "·" character — falsy parts are dropped first so a
 *  missing duration doesn't leave a dangling dot. */
function joinMeta(parts){
    return parts.filter(Boolean).map((p, i) => (i === 0 ? p : `<span class="deploy-meta-dot"></span>${p}`)).join('');
}

/** Ticket + flag-flip chips, shared between a single deploy card and a grouped-deploy card (where the
 *  chips are the union across every run in the group). Returns '' when there's nothing to show. */
function renderChipsRow(relatedIssues, flagBadges){
    const issueChips = (relatedIssues || []).map(k=>`<a class="issue-badge" href="${JIRA_BASE_URL}/${k}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${k}</a>`).join('');
    const flagChips = Object.entries(flagBadges || {}).map(([k,v])=>`<span class="resolved-flag-badge ${v ? 'rf-on' : 'rf-off'}">${k}: ${v?'ON':'OFF'}</span>`).join('');

    if (!issueChips && !flagChips) {
        return '';
    }

    return `<div class="deploy-chips">${issueChips}${flagChips}</div>`;
}

function renderDeployCard(d, attachedFlips){
    const flagBadges = { ...(d.resolvedFlags || {}) };

    (attachedFlips || []).forEach(f => { flagBadges[f.key] = f.enabled; });

    return `
    <div class="deploy-item">
      <div class="deploy-top">
        <div class="deploy-left">
          <span class="comp-avatar">${componentKind(d.component)}</span>
          <span class="status-dot status-${d.status}"></span>
          <span class="deploy-comp">${d.component}</span>
          <span class="version-arrow">→</span>
          <span class="version">${d.commitUrl ? `<a href="${d.commitUrl}" target="_blank" rel="noopener noreferrer">${d.version}</a>` : d.version}</span>
        </div>
        <div class="deploy-right">
          <span class="deploy-env-tag">${barsIcon(ENV_BAR_COUNT[d.environment])}${d.environment.toUpperCase()}</span>
          ${d.manual ? `<span class="manual-badge">${ICONS.manual}Manual</span>` : ''}
          ${d.rollback ? `<span class="rollback-badge" title="moved this environment back to an earlier commit (${d.rollback.toRef})">${ICONS.rewind} rollback</span>` : ''}
          ${d.workflowRunUrl ? `<a class="run-badge" href="${d.workflowRunUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="View workflow run">${ICONS.external}</a>` : ''}
        </div>
      </div>
      <div class="deploy-meta">${joinMeta([
          `<span class="mono">${fmtTime(d.deployedAt)}</span>`,
          d.deployedByLogin && d.deployedByLogin !== d.deployedBy ? `<span title="@${d.deployedByLogin}">${d.deployedBy}</span>` : d.deployedBy,
          fmtDuration(d.durationMs) ? `<span class="mono">${fmtDuration(d.durationMs)}</span>` : null,
      ])}</div>
      ${renderChipsRow(d.relatedIssues, flagBadges)}
    </div>`;
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
        ? `<span class="manual-badge">${ICONS.manual}Manual</span>`
        : manualCount > 0
            ? `<span class="manual-badge">${ICONS.manual}Manual · ${manualCount} of ${group.runs.length}</span>`
            : '';
    const { relatedIssues, flagBadges } = unionChips(group.runs, attachedFlips);

    return `
    <div class="deploy-item">
      <div class="deploy-top">
        <div class="deploy-left">
          <span class="comp-avatar">${componentKind(group.component)}</span>
          <span class="status-dot status-${latest.status}"></span>
          <span class="deploy-comp">${group.component}</span>
          <span class="version-arrow">→</span>
          <span class="version">${latest.commitUrl ? `<a href="${latest.commitUrl}" target="_blank" rel="noopener noreferrer">${group.version}</a>` : group.version}</span>
        </div>
        <div class="deploy-right">
          <span class="deploy-env-tag">${barsIcon(ENV_BAR_COUNT[group.env])}${group.env.toUpperCase()}</span>
          ${manualBadge}
          ${latest.rollback ? `<span class="rollback-badge" title="moved this environment back to an earlier commit (${latest.rollback.toRef})">${ICONS.rewind} rollback</span>` : ''}
          ${latest.workflowRunUrl ? `<a class="run-badge" href="${latest.workflowRunUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="View workflow run">${ICONS.external}</a>` : ''}
        </div>
      </div>
      <div class="deploy-meta">${joinMeta([
          `<span class="mono">${fmtTime(oldest.deployedAt)}–${fmtTime(latest.deployedAt)}</span>`,
          latest.deployedBy,
          `<button type="button" class="deploy-group-toggle${isOpen ? ' open' : ''}" data-group-key="${group.key}">${group.runs.length} deploys ${ICONS.chevronDown}</button>`,
      ])}</div>
      ${isOpen ? `<div class="deploy-group-list">${group.runs.map(r => `
        <div class="deploy-group-item">
          <span class="status-dot status-${r.status}"></span>${fmtTime(r.deployedAt)}
          ${fmtDuration(r.durationMs) ? `· ${fmtDuration(r.durationMs)}` : ''}
          ${r.manual ? `<span class="manual-badge">Manual</span>` : ''}
          ${r.workflowRunUrl ? `<a class="run-badge" href="${r.workflowRunUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="View workflow run">${ICONS.external}</a>` : ''}
        </div>`).join('')}</div>` : ''}
      ${renderChipsRow(relatedIssues, flagBadges)}
    </div>`;
}

function renderFlagAddedCard(f){
    return `
    <div class="flag-added-item">
      <div class="deploy-top">
        <div class="deploy-left">
          <span class="flag-event-icon">${ICONS.flag}</span>
          <span class="flag-new-name">${f.key}</span>
          <span class="flag-new-pill">New flag</span>
        </div>
      </div>
      <div class="deploy-meta">${joinMeta([
          `<span class="mono">${fmtTime(f.createdAt)}</span>`,
          'first discovered — no earlier state for this flag exists',
      ])}</div>
      ${(f.components || []).length ? `<div class="deploy-chips">${(f.components || []).map(c=>`<span class="manual-badge">${c}</span>`).join('')}</div>` : ''}
    </div>`;
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

    const dhSub = document.getElementById('dhSub');

    dhSub.textContent = rangeDays ? `last ${rangeDays} days` : '';
    dhSub.style.display = rangeDays ? 'inline' : 'none';

    const allList = [...deployEvents, ...addedEvents]
        .filter(e=> (!filter || !e.env || e.env === filter) && eventMatchesComponent(e, componentFilter) && (!cutoff || new Date(e.at).getTime() >= cutoff))
        .sort((a,b) => new Date(b.at) - new Date(a.at));

    if (!allList.length){
        box.innerHTML = '<div class="empty">No activity to show</div>';
        return;
    }

    const grouped = groupConsecutiveDeploys(allList);
    const list = grouped.slice(0, visibleDeployCount);

    let lastDay = null;
    const rowsHtml = list.map(e => {
        const key = dayKey(e.at);
        const dayHtml = key !== lastDay ? `<div class="dh-day-head">${dayHeadLabel(e.at)}</div>` : '';

        lastDay = key;

        if (e.kind === 'deploy') {
            return dayHtml + renderDeployCard(e.data, attachedFlips[e.data.id]);
        }
        if (e.kind === 'deploy-group') {
            // A "group" of exactly one run is just a normal deploy — the range/author/toggle line
            // ("11:04–11:04 · Name · 1 deploys") only earns its keep once there's actually more than
            // one run to summarize.
            return dayHtml + (e.runs.length > 1
                ? renderDeployGroupCard(e, attachedFlips, expandedDeployGroups.has(e.key))
                : renderDeployCard(e.runs[0], attachedFlips[e.runs[0].id]));
        }

        return dayHtml + renderFlagAddedCard(e.data);
    }).join('');

    box.innerHTML = rowsHtml;

    if (visibleDeployCount < grouped.length) {
        box.innerHTML += `<div class="load-more-sentinel" id="deployLoadMore">Loading more…</div>`;
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
 */
function flagBlastRadius(f){
    const keys = f.jiraKeys || [];

    if (keys.length < 2) {
        return null;
    }

    const linked = keys.map(k => state.jiraIssues.find(i => i.key === k)).filter(Boolean);
    const done = linked.filter(i => i.statusCategory === 'done');
    const notDone = linked.filter(i => i.statusCategory && i.statusCategory !== 'done');

    if (!done.length || !notDone.length) {
        return null;
    }

    return notDone.map(i => i.key);
}

const STALE_FLAG_DAYS = 60;

/**
 * A flag that's been ON somewhere for a long time with every linked issue already Done is a
 * cleanup candidate — the flag-gated code path can probably be removed outright.
 */
function flagStaleWarning(f, key){
    const keys = f.jiraKeys || [];

    if (!keys.length) {
        return null;
    }

    const linked = keys.map(k => state.jiraIssues.find(i => i.key === k)).filter(Boolean);

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

function renderFlags(){
    const box = document.getElementById('flags');
    const sourceFilter = document.getElementById('filterFlagSource').value;
    const entries = Object.entries(state.flagsMeta)
        .filter(([, f]) => !sourceFilter || f.source === sourceFilter)
        .sort((a,b) => a[0].localeCompare(b[0]));

    const divergeCount = entries.filter(([key]) => ENVIRONMENTS.some(env => flagDivergesInEnv(key, env))).length;

    document.getElementById('flagsDivergeNote').textContent = divergeCount ? `${divergeCount} diverge${divergeCount===1?'s':''}` : '';

    if (!entries.length) {
        box.innerHTML = `<div class="empty">${sourceFilter ? 'No flags match this filter' : 'No flags defined'}</div>`;
        return;
    }

    box.innerHTML = entries.map(([key, f])=> {
        const isBuild = f.source === 'build';
        const blastRadius = flagBlastRadius(f);
        const staleInfo = flagStaleWarning(f, key);

        return `
    <div class="flag-item">
      <div class="flag-name">${key}<span class="flag-source ${isBuild ? 'src-build' : 'src-runtime'}">${isBuild ? 'BUILD-TIME (FE)' : 'RUNTIME (BE)'}</span></div>
      ${staleInfo ? `<div class="drift-note">◷ Possibly stale</div>` : ''}
      <div class="flag-desc">${f.description} · issue: ${(f.jiraKeys || []).join(', ') || '—'} · components: ${(f.components || []).join(', ') || '—'}${f.createdAt ? ` · added ${fmtDateShort(f.createdAt)}` : ''}</div>
      ${blastRadius ? `<div class="blast-radius-warning">⚠ shares this flag with unfinished work (${blastRadius.join(', ')}) — enabling it releases those too</div>` : ''}
      <div class="flag-envs">
        ${ENVIRONMENTS.map(env=> {
            const envEntry = state.flagStates[key] ? state.flagStates[key][env] : null;
            const fs = effectiveFlagState(envEntry);
            const on = fs ? !!fs.enabled : false;
            const changedInfo = fs ? `title="[${fs.source}] changed ${relTime(fs.changedAt)} by ${fs.changedBy}"` : '';

            return `<div class="flag-pill ${on ? 'flag-on' : 'flag-off'}" ${changedInfo}>${env.toUpperCase()}: ${on ? 'ON' : 'OFF'}</div>`;
        }).join('')}
      </div>
      ${ENVIRONMENTS.map(env=> {
          if (!flagDivergesInEnv(key, env)) {
              return '';
          }

          const envEntry = state.flagStates[key][env];

          return `<div class="drift-note" title="build=${envEntry.build.enabled ? 'ON' : 'OFF'} — would resurface if the runtime-be override is ever cleared">≠ ${env.toUpperCase()} diverges from build default</div>`;
      }).join('')}
    </div>`;
    }).join('');
}

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
    const released = state.jiraIssues.filter(i => i.type !== 'Epic' && i.pi === pi && issueIsReleasedToProd(i));
    const features = released.filter(i => i.type !== 'Bug').length;
    const bugs = released.filter(i => i.type === 'Bug').length;
    const piNote = pi ? `in ${pi}${pi === currentPi() ? ' (current PI)' : ''}` : 'no PI selected';

    const cards = [
        { label: 'Features & improvements released', value: String(features) },
        { label: 'Bugs fixed', value: String(bugs) },
    ];

    box.innerHTML = cards.map(c => `
    <div class="summary-card">
      <div class="summary-label">${c.label}</div>
      <div class="summary-value">${c.value} <span class="summary-note">${piNote}</span></div>
    </div>`).join('');
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

    document.getElementById('releaseNotesCount').innerHTML = `<span class="pv-count-num">${releasedCount}</span> item${releasedCount === 1 ? '' : 's'}`;

    if (!releasedCount) {
        // Distinguish "nothing synced at all" / "synced, but every issue is a commit-derived stub" (no
        // title/PI/status — see FAQ.md → "Where do the Epic/Story/Task numbers come from?") / "filters
        // matched nothing" / "real data exists, but nothing here is live on PROD yet" — each is a
        // different, more actionable thing to tell someone staring at an empty tab than one generic message.
        if (!state.jiraIssues.length) {
            box.innerHTML = '<div class="empty">No issues synced from Jira yet</div>';
        } else if (!allRealPiIssues.length) {
            box.innerHTML = `<div class="empty">Found ${state.jiraIssues.length} synced issue(s), but none have a real PI yet — this usually means the Jira sync couldn't reach Jira and fell back to commit-derived stubs (no title/PI/status). See FAQ.md → "Where do the Epic/Story/Task numbers come from?".</div>`;
        } else if (!filteredIssues.length) {
            box.innerHTML = '<div class="empty">No results for the selected filters</div>';
        } else {
            box.innerHTML = '<div class="empty">Found real-PI issues, but none are released to PROD yet.</div>';
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

    // A released item's TEST/QA/PROD breakdown isn't shown here — "released" already means "live on
    // PROD" (see issueIsReleasedToProd above), so the per-env pills would just be redundant noise.
    const renderIssueRow = issue => `
        <div class="release-note-item">
          <span class="issue-type">${issue.type}</span>
          <a class="release-note-title" href="${JIRA_BASE_URL}/${issue.key}" target="_blank" rel="noopener noreferrer">${issue.title}</a>
        </div>`;

    // Splits a sprint's released issues into labeled sub-sections. Jira has no separate "Improvement"
    // type to key off of, so this only reliably splits on Bug vs. everything else (Epic/Story/Task).
    // A category with no issues renders nothing.
    const renderCategorySections = releasedIssues => {
        const categories = [
            { label: 'Features & Improvements', list: releasedIssues.filter(i => i.type !== 'Bug') },
            { label: 'Bug Fixes', list: releasedIssues.filter(i => i.type === 'Bug') },
        ];

        return categories.filter(c => c.list.length).map(c => `
          <div class="release-notes-category">
            <div class="release-notes-category-label">${c.label}</div>
            ${c.list.map(renderIssueRow).join('')}
          </div>`).join('');
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

            return `
        <div class="release-notes-sprint">
          <div class="release-notes-sprint-head">
            <span class="release-notes-sprint-title">${sprint}</span>
          </div>
          ${renderCategorySections(releasedSprintIssues)}
        </div>`;
        }).filter(Boolean).join('');

        if (!sprintSections) {
            return '';
        }

        return `
      <div class="release-notes-pi">
        <div class="release-notes-pi-head">
          <h2>${pi}</h2>
        </div>
        ${sprintSections}
      </div>`;
    }).filter(Boolean).join('');

    box.innerHTML = `
    <div class="panel">
      <div class="panel-body">${piSections}</div>
    </div>`;
}

/* ---------- Rendering: Insights ---------- */

const CHART_STATUS_ORDER = [
    { key: 'released', label: 'Released', cls: 'seg-released' },
    { key: 'deployedHidden', label: 'Deployed (hidden)', cls: 'seg-deployed' },
    { key: 'partial', label: 'Partial', cls: 'seg-partial' },
    { key: 'none', label: 'Not deployed', cls: 'seg-none' },
];

// Jira's standard priority names, highest first — an issue whose priority isn't one of these (a custom
// scheme on this instance) just sorts after all of them, alphabetically.
const PRIORITY_ORDER = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

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

    return m ? `PI-${m[1]}.${m[2]}` : null;
}

/** Chart 1's data: every issue's PROD status (via the same issueStatusForEnv the Product view table
 *  already reads row-by-row), bucketed per sprint (`sprintLabelFor()`) rather than per PI — a finer-grained
 *  view of the same rollup. `deployed` and `deployed_code_only` share one bucket ("Deployed (hidden)") —
 *  at this rolled-up level, "code shipped but flag confirmed off" and "code shipped, no flag to check"
 *  both mean the same practical thing: shipped, visibility unconfirmed. */
function sprintReleaseStatusBreakdown(){
    const bySprint = new Map();

    state.jiraIssues.forEach(issue => {
        const label = sprintLabelFor(issue);

        if (!label) {
            return;
        }

        if (!bySprint.has(label)) {
            bySprint.set(label, { none: 0, deployedHidden: 0, released: 0, partial: 0 });
        }

        const level = issueStatusForEnv(issue, 'prod').level;
        const counts = bySprint.get(label);

        if (level === 'released') {
            counts.released++;
        } else if (level === 'deployed' || level === 'deployed_code_only') {
            counts.deployedHidden++;
        } else if (level === 'partial') {
            counts.partial++;
        } else {
            counts.none++;
        }
    });

    return [...bySprint.keys()].sort(compareVersionDesc).map(label => {
        const counts = bySprint.get(label);

        return { label, counts, total: counts.none + counts.deployedHidden + counts.released + counts.partial };
    });
}

function renderSprintStatusChart(){
    const box = document.getElementById('chartSprint');
    const rows = sprintReleaseStatusBreakdown();

    if (!rows.length) {
        box.innerHTML = '<div class="empty">No issues with a detectable sprint to chart yet</div>';
        return;
    }

    const legend = CHART_STATUS_ORDER.map(s => `<span><span class="chart-legend-swatch ${s.cls}"></span>${s.label}</span>`).join('');
    const rowsHtml = rows.map(({ label, counts, total }) => {
        const segments = CHART_STATUS_ORDER.map(s => {
            const n = counts[s.key];

            if (!n) {
                return '';
            }

            return `<div class="bar-segment ${s.cls}" style="width:${(n / total * 100).toFixed(1)}%" title="${s.label}: ${n}"></div>`;
        }).join('');

        return `
        <div class="bar-row">
          <div class="bar-row-label" title="${label}">${label}</div>
          <div class="bar-track">${segments}</div>
          <div class="bar-row-count">${total}</div>
        </div>`;
    }).join('');

    box.innerHTML = `<div class="chart-legend">${legend}</div>${rowsHtml}`;
}

/** Same rollup as `sprintReleaseStatusBreakdown()`, bucketed by Jira `priority` instead — answers "how
 *  many Highest/High-priority issues are still not released," not just "how many total." Issues with no
 *  priority set (an older sync, or a Jira instance that doesn't use it) are excluded rather than lumped
 *  into an "unknown" bucket. */
function priorityReleaseStatusBreakdown(){
    const byPriority = new Map();

    state.jiraIssues.filter(i => isRealPi(i.pi) && i.priority).forEach(issue => {
        if (!byPriority.has(issue.priority)) {
            byPriority.set(issue.priority, { none: 0, deployedHidden: 0, released: 0, partial: 0 });
        }

        const level = issueStatusForEnv(issue, 'prod').level;
        const counts = byPriority.get(issue.priority);

        if (level === 'released') {
            counts.released++;
        } else if (level === 'deployed' || level === 'deployed_code_only') {
            counts.deployedHidden++;
        } else if (level === 'partial') {
            counts.partial++;
        } else {
            counts.none++;
        }
    });

    return [...byPriority.keys()].sort(comparePriorityDesc).map(priority => {
        const counts = byPriority.get(priority);

        return { priority, counts, total: counts.none + counts.deployedHidden + counts.released + counts.partial };
    });
}

function renderPriorityStatusChart(){
    const box = document.getElementById('chartPriority');
    const rows = priorityReleaseStatusBreakdown();

    if (!rows.length) {
        box.innerHTML = '<div class="empty">No issues with a priority set yet</div>';
        return;
    }

    const legend = CHART_STATUS_ORDER.map(s => `<span><span class="chart-legend-swatch ${s.cls}"></span>${s.label}</span>`).join('');
    const rowsHtml = rows.map(({ priority, counts, total }) => {
        const segments = CHART_STATUS_ORDER.map(s => {
            const n = counts[s.key];

            if (!n) {
                return '';
            }

            return `<div class="bar-segment ${s.cls}" style="width:${(n / total * 100).toFixed(1)}%" title="${s.label}: ${n}"></div>`;
        }).join('');

        return `
        <div class="bar-row">
          <div class="bar-row-label" title="${priority}">${priority}</div>
          <div class="bar-track">${segments}</div>
          <div class="bar-row-count">${total}</div>
        </div>`;
    }).join('');

    box.innerHTML = `<div class="chart-legend">${legend}</div>${rowsHtml}`;
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
        box.innerHTML = '<div class="empty">No flags are currently ON in prod</div>';
        return;
    }

    const max = Math.max(rows[0].days, 1);

    box.innerHTML = rows.map(({ key, days, stale }) => `
        <div class="bar-row">
          <div class="bar-row-label" title="${key}">${key}</div>
          <div class="bar-track">
            <div class="bar-segment ${stale ? 'seg-stale' : 'seg-deployed'}" style="width:${Math.max(days / max * 100, 2).toFixed(1)}%" title="${days} day(s) ON in prod"></div>
          </div>
          <div class="bar-row-count">${days}d</div>
        </div>`).join('');
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

        const firstProdAt = state.deployments
            .filter(d => d.environment === 'prod' && d.status === 'success' && (d.relatedIssues || []).includes(issue.key))
            .map(d => new Date(d.deployedAt).getTime())
            .sort((a, b) => a - b)[0];

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
        box.innerHTML = '<div class="empty">No resolved issues with a prod deployment yet</div>';
        return;
    }

    const max = Math.max(...rows.map(r => r.median), 1);

    box.innerHTML = rows.map(({ label, median, count }) => `
        <div class="bar-row">
          <div class="bar-row-label" title="${label}">${label}</div>
          <div class="bar-track">
            <div class="bar-segment seg-deployed" style="width:${Math.max(median / max * 100, 2).toFixed(1)}%" title="Median ${median}d over ${count} issue(s)"></div>
          </div>
          <div class="bar-row-count">${median}d</div>
        </div>`).join('');
}

/** Chart 3's data: deployments from the last 12 calendar months only, bucketed by month of `deployedAt`,
 *  counting how many carry `rollback` and how many carry a `driftBehind` that actually flags something
 *  (`commitCount` — this env fell behind an earlier one — or `untestedCommitCount` — this env has commits
 *  no earlier one ever saw, i.e. skipped the normal promotion path). Both fields are already computed by
 *  sync-github-deployments.js; this is a pure rollup, sorted chronologically (oldest first) since it's a
 *  trend, unlike the ranked snapshots in the other charts. The 12-month window is a display cap only — it
 *  doesn't touch `deployments.json` itself, just what this one chart renders. */
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
        box.innerHTML = '<div class="empty">No rollbacks or drift detected in this data</div>';
        return;
    }

    const max = Math.max(...months.map(m => Math.max(m.rollback, m.drift)), 1);
    const cols = months.map(m => `
      <div class="col-chart-col">
        <div class="col-chart-bars">
          <div class="col-bar seg-rollback" style="height:${m.rollback ? Math.max(m.rollback / max * 100, 4) : 0}px" title="Rollbacks: ${m.rollback}"></div>
          <div class="col-bar seg-drift" style="height:${m.drift ? Math.max(m.drift / max * 100, 4) : 0}px" title="Drift: ${m.drift}"></div>
        </div>
        <div class="col-chart-label">${m.date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</div>
      </div>`).join('');

    box.innerHTML = `
    <div class="chart-legend">
      <span><span class="chart-legend-swatch seg-rollback"></span>Rollback</span>
      <span><span class="chart-legend-swatch seg-drift"></span>Drift</span>
    </div>
    <div class="col-chart">${cols}</div>`;
}

function renderInsights(){
    renderSprintStatusChart();
    renderLeadTimeChart();
    renderPriorityStatusChart();
    renderStaleFlagsChart();
    renderRollbackDriftChart();
}

function switchToTab(view){
    document.querySelectorAll('.tab').forEach(t=> t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=> v.classList.remove('active'));
    document.querySelector(`.tab[data-view="${view}"]`).classList.add('active');
    document.getElementById('view-' + view).classList.add('active');
    // Technical view has nothing scoped per-PI (component × environment matrix, deployment timeline, flat
    // flag list) — the global PI selector would be a dead control there, so it's hidden rather than shown
    // but inert.
    document.getElementById('globalPiSelectWrap').style.display = view === 'tech' ? 'none' : '';
}

/**
 * Populates and wires the one PI selector shared by Product view, Release Notes, and Insights (see
 * CLAUDE.md's Jira issues section — all three now render "one PI at a time"). Options come from
 * `state.jiraIndex.pis` (already sorted newest-first, same order sync-jira.js wrote them in); the
 * server-resolved `currentPi()` gets a visible marker so switching away and back is obvious. On change,
 * fetches the newly-selected PI's shard, swaps it into `state.jiraIssues`/`state.selectedPi`, then
 * refreshes+resets both tabs' filters (reusing their own Clear buttons, so there's exactly one place
 * that knows how to reset each tab's filter UI) before re-rendering everything that reads `state.jiraIssues`.
 */
function initGlobalPiSelect(){
    const sel = document.getElementById('globalPiSelect');

    (state.jiraIndex.pis || []).forEach(entry => {
        const o = document.createElement('option');

        o.value = entry.pi;
        o.textContent = entry.pi === currentPi() ? `${entry.pi} (current)` : entry.pi;
        sel.appendChild(o);
    });

    sel.value = state.selectedPi || '';

    sel.addEventListener('change', async () => {
        state.jiraIssues = await loadJiraIssuesForPi(sel.value);
        state.selectedPi = sel.value;

        refreshProductViewFilterOptions();
        document.getElementById('btnClearFilters').click();

        if (RELEASE_NOTES_ENABLED) {
            refreshReleaseNotesFilterOptions();
            document.getElementById('btnClearNotesFilters').click();
        }

        if (INSIGHTS_ENABLED) {
            renderInsights();
        }
    });
}

function initTabs(){
    if (!PRODUCT_VIEW_ENABLED) {
        const productTab = document.querySelector('.tab[data-view="product"]');

        productTab.classList.add('tab-disabled');
        productTab.title = "Product view isn't ready yet";
    }

    switchToTab(DEFAULT_VIEW);

    if (!RELEASE_NOTES_ENABLED) {
        document.querySelector('.tab[data-view="notes"]').remove();
    }

    if (!INSIGHTS_ENABLED) {
        document.querySelector('.tab[data-view="insights"]').remove();
    } else {
        document.querySelector('.tab[data-view="insights"]').style.display = '';
    }

    document.querySelectorAll('.tab').forEach(tab=>{
        if (tab.classList.contains('tab-disabled')) {
            return;
        }

        tab.onclick = ()=> switchToTab(tab.dataset.view);
    });
}

async function init(){
    initTabs();
    state = await loadData();

    state.selectedPi = state.jiraIndex.currentPi
        || (state.jiraIndex.pis[0] && state.jiraIndex.pis[0].pi)
        || null;
    state.jiraIssues = await loadJiraIssuesForPi(state.selectedPi);

    initGlobalPiSelect();
    initProductView();

    const sel = document.getElementById('filterEnv');

    ENVIRONMENTS.forEach(env=> {
        const o=document.createElement('option');
        o.value = env;
        o.textContent = env.toUpperCase();
        sel.appendChild(o);
    });
    sel.onchange = resetDeployPagination;

    const compSel = document.getElementById('filterComponent');

    [...new Set(state.deployments.map(d=> d.component))].sort().forEach(comp=> {
        const o=document.createElement('option');
        o.value = comp;
        o.textContent = comp;
        compSel.appendChild(o);
    });
    compSel.onchange = resetDeployPagination;

    const rangeSel = document.getElementById('filterDeployRange');

    rangeSel.onchange = resetDeployPagination;

    document.getElementById('btnClearDeployFilters').onclick = () => {
        compSel.value = '';
        sel.value = '';
        rangeSel.value = '';
        resetDeployPagination();
    };

    document.getElementById('filterFlagSource').onchange = renderFlags;

    document.getElementById('timeline').addEventListener('scroll', function(){
        if (this.scrollTop + this.clientHeight >= this.scrollHeight - 100) {
            const savedScroll = this.scrollTop;

            visibleDeployCount += DEPLOY_PAGE_SIZE;
            renderTimeline();
            this.scrollTop = savedScroll;
        }
    });

    renderSummaryCards();
    renderMatrix();
    renderTimeline();
    renderFlags();
    renderProductSummary();
    renderIssues();

    if (RELEASE_NOTES_ENABLED) {
        initReleaseNotesFilters();
        renderReleaseNotes();
    }

    if (INSIGHTS_ENABLED) {
        renderInsights();
    }
}
init();