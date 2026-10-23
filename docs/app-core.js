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

