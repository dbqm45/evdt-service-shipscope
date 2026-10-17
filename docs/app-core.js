const ENVIRONMENT = Object.freeze({ TEST: 'test', QA: 'qa', PROD: 'prod' });
const ENVIRONMENTS = Object.freeze([ENVIRONMENT.TEST, ENVIRONMENT.QA, ENVIRONMENT.PROD]);
const SERVICE_TYPE = Object.freeze({ FE: 'FE', BE: 'BE' });
const ISSUE_TYPE = Object.freeze({ EPIC: 'Epic', STORY: 'Story', TASK: 'Task', BUG: 'Bug' });
// What issueStatusForEnv() reports for one issue on one environment (`.level`).
const RELEASE_LEVEL = Object.freeze({ NONE: 'none', DEPLOYED: 'deployed', DEPLOYED_CODE_ONLY: 'deployed_code_only', PARTIAL: 'partial', RELEASED: 'released' });

/** Light/dark toggle. Dark is the default — index.html's inline head script already applies a stored
 *  'light' preference before first paint, so this only has to wire up the button and persist a change. */
const THEME_STORAGE_KEY = 'shipscope-theme';

function initTheme() {
    const btn = document.getElementById('themeToggle');

    btn.onclick = () => {
        const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';

        document.documentElement.setAttribute('data-theme', next);
        btn.title = next === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
        btn.setAttribute('aria-label', btn.title);
        try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch (e) {}
    };

    btn.title = document.documentElement.getAttribute('data-theme') === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    btn.setAttribute('aria-label', btn.title);
}

initTheme();

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
    bug: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><ellipse cx="8" cy="9.2" rx="3.3" ry="4" stroke="currentColor" stroke-width="1.2"/><path d="M8 5.2V3M5.4 4.2 4.2 2.8M10.6 4.2l1.2-1.4M4 8.4H1.8M14.2 8.4H12M4.3 12 2.6 13.6M11.7 12l1.7 1.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    hourglass: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><path d="M4 2h8M4 14h8M4.6 2c0 2.3 1.1 3.8 3.4 5-2.3 1.2-3.4 2.7-3.4 5M11.4 2c0 2.3-1.1 3.8-3.4 5 2.3 1.2 3.4 2.7 3.4 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowRight: '<svg class="arrow-right" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
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
    const bars = [{ x: 0, y: 8, h: 8 }, { x: 7, y: 4, h: 12 }, { x: 14, y: 0, h: 16 }];
    const rects = bars.map((b, i) => {
        const lit = i < activeCount;

        return `<rect x="${b.x}" y="${b.y}" width="4" height="${b.h}" rx="2" fill="${lit ? '#ECEEF1' : '#33373D'}"/>`;
    }).join('');

    return `<svg class="stage-icon" width="18" height="16" viewBox="0 0 18 16" aria-hidden="true">${rects}</svg>`;
}

/** Compact 13x12 variant of barsIcon() for the Deployment history `.env-badge` pill (same colors and
 *  lit-bar rule, just the badge's own proportions). */
function envBadgeIcon(activeCount){
    const bars = [{ x: 0, y: 6, h: 6 }, { x: 5, y: 3, h: 9 }, { x: 10, y: 0, h: 12 }];
    const rects = bars.map((b, i) => `<rect x="${b.x}" y="${b.y}" width="3" height="${b.h}" rx="1" fill="${i < activeCount ? '#ECEEF1' : '#33373D'}"/>`).join('');

    return `<svg width="13" height="12" viewBox="0 0 13 12" aria-hidden="true">${rects}</svg>`;
}

// Which tab is active on load — set to 'product' to restore docs/index.html's own default (its `.tab.active`
// class on the Product view tab).
const DEFAULT_VIEW = 'tech';

// The Insights tab is a soft launch: removed from the page unless asked for with ?insights=1 (initTabs()). A next
// preview tab can be gated the same way.
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

/** A Jira issue's link on the tenant's own site (`state.jiraBrowseUrl`), or null — no Jira connected yet, or the
 *  sample data — and the key is shown unlinked. */
function jiraIssueUrl(key){
    const base = state && state.jiraBrowseUrl;
    return base ? `${base}/${key}` : null;
}

let expandedIssue = null;
const collapsedEpics = new Set();
const ISSUE_PAGE_SIZE = 20;
let visibleIssueCount = ISSUE_PAGE_SIZE;

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

    const sameDay = (a, b) => dayKey(a) === dayKey(b);
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

