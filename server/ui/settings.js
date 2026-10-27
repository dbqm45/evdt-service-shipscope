// A workspace's settings page (/t/<tenantId>/settings): members and invitations, GitHub repositories, the Jira
// connection and its boards, feature-flag sources. Every change goes through the same JSON API a script would use;
// the server checks roles, this page only hides what a member can't do. Classic script after app-html.js (`html`,
// `raw`); each section renders from plain data (render* functions, unit-tested in server/test/settings-ui.test.js)
// and every button or form names its action in data-action, handled by one listener on the page.

const SETTINGS_TENANT_ID = (() => {
    const match = /^\/t\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/settings\/?$/i.exec(
        (typeof location !== 'undefined' && location.pathname) || ''
    );
    return match ? match[1] : null;
})();

const RHYTHMS = [
    ['auto', 'Auto-detect'],
    ['pi', 'Program increments (SAFe)'],
    ['sprint', 'Sprints (Scrum)'],
    ['release', 'Releases (Fix Version)'],
    ['flow', 'Monthly flow (Kanban)'],
];

class ApiError extends Error {
    constructor(message, status){
        super(message);
        this.status = status;
    }
}

/** One JSON API call; 204 is null, any non-2xx an ApiError carrying the server's `error` text. */
async function api(method, path, body){
    const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
        location.assign(`/auth/github/login?returnTo=${encodeURIComponent(location.pathname)}`);
        throw new ApiError('Not signed in', 401);
    }
    if (res.status === 204) {
        return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new ApiError(json.error || `Request failed (HTTP ${res.status})`, res.status);
    }
    return json;
}


/** Page state: what each section was last loaded with, plus one-time values (a new link or token) to show once. */
const settingsState = {
    tenantId: SETTINGS_TENANT_ID, me: null, tenant: null, features: { githubApp: false, jira: false },
    workspace: null, github: null, installationRepos: {}, trackPicker: false, editingRepo: null, jira: null, boards: null, flagFields: null, flags: null, flagList: null,
    once: {}, messages: {},
    // The "Read flags from code" helper: the form's draft, the files found in a repository, a preview of a reading.
    codeWizard: { draft: {}, found: null, preview: null },
    // "Test" of an endpoint source: which form asked (a source id, or 'new') and what each environment read.
    endpointTest: null,
    // The workspace's secret events (who showed or replaced a secret), for admins.
    secretEvents: null,
    // The workspace's audit log (who changed which setting), for admins.
    auditEvents: null,
};

const tenantPath = (suffix) => `/tenants/${settingsState.tenantId}${suffix}`;

const isAdmin = () => settingsState.tenant && settingsState.tenant.role === 'admin';

function fmtDateTime(value){
    if (!value) {
        return '—';
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
}

function sectionMessage(section){
    const msg = settingsState.messages[section];
    if (!msg) {
        return html``;
    }
    return html`<p class="${msg.error ? 'settings-error' : 'settings-ok'}" role="status">${msg.text}</p>`;
}

// Line icons (24×24, stroke = currentColor), already raw() so they go into `html` as they are.
const svg = (paths) => raw(`<svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`);
const SETTINGS_ICONS = {
    general: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
    members: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
    github: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6M18 11a6 6 0 0 1-6 6H9"/>'),
    jira: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>'),
    flags: svg('<path d="M5 21V4h11l-2 4 2 4H5"/>'),
    sources: svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
    danger: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
};

/** The settings pages, in the sidebar's groups; `section` is the loader (and message key) each one reads. */
const PAGES = [
    { group: 'Workspace', items: [{ id: 'general', label: 'General', section: 'workspace' }, { id: 'members', label: 'Members', section: 'workspace' }] },
    { group: 'Integrations', items: [{ id: 'github', label: 'GitHub', section: 'github' }, { id: 'jira', label: 'Jira', section: 'jira' }, { id: 'pdi', label: 'pdi', section: 'pdi' }] },
    { group: 'Feature flags', items: [{ id: 'flags', label: 'Flags', section: 'flags' }, { id: 'sources', label: 'Sources', section: 'flags' }] },
    { group: 'Other', items: [{ id: 'danger', label: 'Danger zone', section: 'workspace', admin: true }] },
];
// Links from before the pages (the dashboard's banner, bookmarks) still land somewhere sensible.
const PAGE_ALIASES = { workspace: 'general' };

/**
 * The page a URL hash opens: a known page, an old section name, or — without one — the checklist while an admin's
 * workspace still lacks what the dashboard needs, else General. A member never gets an admin-only page.
 *
 * @param {{ hash: string, admin: boolean, setupDone: boolean }} input
 * @returns {string} a page id from PAGES, or 'getting-started'
 */
function pageFromHash({ hash, admin, setupDone }){
    const name = (hash || '').replace(/^#/, '');
    const id = PAGE_ALIASES[name] || name;
    if (id === 'getting-started' && admin) {
        return id;
    }
    const page = PAGES.flatMap((g) => g.items).find((p) => p.id === id && (admin || !p.admin));
    if (page) {
        return page.id;
    }
    return admin && !setupDone ? 'getting-started' : 'general';
}

/** One settings page: its title and hint, an optional action on the right, the section's last message, the body. */
function Page({ id, section = id, title, hint, action = '', body }){
    return html`<section class="settings-page" id="${id}" data-section="${section}">
        <div class="settings-page-head"><div><h1>${title}</h1>${hint ? html`<p class="settings-page-hint">${hint}</p>` : ''}</div>${action}</div>
        ${sectionMessage(section)}${body}
    </section>`;
}

/** A panel inside a page; `title` optional. */
function Card({ title = '', body, cls = '' }){
    return html`<div class="${cls ? `settings-card ${cls}` : 'settings-card'}">${title ? html`<h2>${title}</h2>` : ''}${body}</div>`;
}

/** "eMobility Sparks" -> "ES", "enercity" -> "EN". */
function initials(name){
    const words = String(name || '').trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
    return letters.toUpperCase();
}

/** A repository's two-letter badge from what follows "service" in the usual "team-service-what" names, else its
 *  last word: "charger" -> CH, "frontend"/"backend" read as two words -> FE/BE. */
function repoBadge(fullName){
    const parts = String(fullName || '').split('/').pop().split(/[-_.]/).filter(Boolean);
    const at = parts.indexOf('service');
    const word = ((at >= 0 && parts[at + 1]) || parts[parts.length - 1] || '?').toLowerCase();
    const end = /^(front|back)end$/.exec(word);
    return (end ? `${end[1][0]}e` : word.slice(0, 2)).toUpperCase();
}

function SecretBox({ label, value, note }){
    return html`<div class="secret-box"><strong>${label}</strong><code>${value}</code>${note ? html`<span class="settings-hint">${note}</span>` : ''}
        <span><button type="button" class="btn" data-action="dismiss-once">Done, I copied it</button></span></div>`;
}

// ---- Getting started ---------------------------------------------------------------------------------------

const CHECKLIST_HIDDEN_KEY = 'shipscope.checklistHidden.';
const STEP_MARK = { done: '✓', waiting: '…', problem: '!', todo: '', unavailable: '–', loading: '' };

/**
 * The getting-started checklist, read off the sections already loaded (no request of its own). Each step is
 * `done`, `waiting` (set up, ShipScope waits for data), `problem`, `todo`, `unavailable` (off on this server) or
 * `loading`; GitHub's three steps are required, the rest optional.
 *
 * @param {{ features: object, github: object|null, jira: object|null, boards: object[]|{ error: string }|null, sources: object[]|{ error: string }|null, flagList: object[]|{ error: string }|null, workspace: object|null, now?: Date }} input
 * @returns {Array<{ id: string, title: string, state: string, optional: boolean, hint: string, href: string|null, cta: string|null }>}
 */
function onboardingSteps({ features, github, jira, boards, sources, flagList, workspace, now = new Date() }){
    const step = (id, title, optional, state, hint, href = null, cta = null) => ({ id, title, optional, state, hint, href, cta });
    const steps = [];
    const repos = (github && github.repos) || [];

    if (!features.githubApp) {
        steps.push(step('github-app', 'Install the GitHub App', false, 'unavailable', 'The GitHub App is not configured on this server (GITHUB_APP_* variables).'));
    } else if (!github) {
        steps.push(step('github-app', 'Install the GitHub App', false, 'loading', ''));
    } else if (github.installations.length) {
        steps.push(step('github-app', 'Install the GitHub App', false, 'done', `Installed on ${github.installations.map((i) => i.accountLogin).join(', ')}.`, '#github'));
    } else {
        steps.push(step('github-app', 'Install the GitHub App', false, 'todo',
            'Install it on the GitHub organization or account you deploy from; GitHub brings you back here.', tenantPath('/github/install'), 'Install'));
    }

    if (!features.githubApp || !github) {
        steps.push(step('repos', 'Choose repositories to track', false, features.githubApp ? 'loading' : 'unavailable', ''));
    } else if (repos.length) {
        steps.push(step('repos', 'Choose repositories to track', false, 'done', `${repos.length} tracked.`, '#github'));
    } else {
        steps.push(step('repos', 'Choose repositories to track', false, 'todo',
            github.installations.length ? 'Under GitHub, click Track next to each repository whose deployments you want to see.' : 'After installing the App.', '#github', 'Choose'));
    }

    const deployed = repos.filter((r) => r.deployments > 0);
    const failing = repos.filter((r) => r.lastSyncError && !r.deployments);
    if (!features.githubApp || !github) {
        steps.push(step('deployments', 'First deployments arrive', false, features.githubApp ? 'loading' : 'unavailable', ''));
    } else if (deployed.length) {
        steps.push(step('deployments', 'First deployments arrive', false, 'done', `Deployments from ${deployed.length} of ${repos.length} repositories so far.`, './', 'Open the dashboard'));
    } else if (!repos.length) {
        steps.push(step('deployments', 'First deployments arrive', false, 'todo', 'After choosing repositories.'));
    } else if (failing.length) {
        steps.push(step('deployments', 'First deployments arrive', false, 'problem', `The sync failed for ${failing.map((r) => r.fullName).join(', ')}: see the error under GitHub.`, '#github', 'See why'));
    } else if (repos.some((r) => r.rateLimitedUntil)) {
        steps.push(step('deployments', 'First deployments arrive', false, 'waiting', 'Paused by GitHub\'s rate limit; the sync resumes on its own.', '#github'));
    } else if (repos.some((r) => r.lastSyncedAt)) {
        steps.push(step('deployments', 'First deployments arrive', false, 'waiting',
            'Synced, but GitHub has no deployments for these repositories yet. ShipScope reads GitHub Deployments: a workflow job with "environment: test", "qa" or "prod" creates one each time it runs.'));
    } else {
        steps.push(step('deployments', 'First deployments arrive', false, 'waiting', 'The first sync runs within 15 minutes (or as soon as GitHub reports a deployment, with webhooks on).'));
    }

    const jiraReady = Boolean(jira && jira.connected && jira.site);
    if (!features.jira) {
        steps.push(step('jira', 'Connect Jira', true, 'unavailable', 'Jira is not configured on this server.'));
    } else if (!jira) {
        steps.push(step('jira', 'Connect Jira', true, 'loading', ''));
    } else if (jiraReady) {
        steps.push(step('jira', 'Connect Jira', true, 'done', `Connected to ${jira.site.name}.`, '#jira'));
    } else if (jira.connected) {
        steps.push(step('jira', 'Connect Jira', true, 'todo', 'Choose which Jira site to use.', '#jira', 'Choose'));
    } else {
        steps.push(step('jira', 'Connect Jira', true, 'todo', 'Shows each work item\'s release status next to your deployments. Read-only.', tenantPath('/jira/connect'), 'Connect'));
    }

    const selected = Array.isArray(boards) ? boards.filter((b) => b.selected) : [];
    if (!features.jira) {
        steps.push(step('boards', 'Choose Jira boards', true, 'unavailable', ''));
    } else if (!jiraReady) {
        steps.push(step('boards', 'Choose Jira boards', true, jira ? 'todo' : 'loading', jira ? 'After connecting Jira.' : ''));
    } else if (boards && boards.error) {
        steps.push(step('boards', 'Choose Jira boards', true, 'problem', boards.error, '#jira'));
    } else if (!boards) {
        steps.push(step('boards', 'Choose Jira boards', true, 'loading', ''));
    } else if (!selected.length) {
        steps.push(step('boards', 'Choose Jira boards', true, 'todo', 'Tick each team\'s board and save; its rhythm (PI, sprints, releases or flow) is detected.', '#jira', 'Choose'));
    } else if (jira.lastSyncedAt) {
        steps.push(step('boards', 'Choose Jira boards', true, 'done', `${selected.length} board(s), synced ${fmtDateTime(jira.lastSyncedAt)}.`, '#jira'));
    } else {
        steps.push(step('boards', 'Choose Jira boards', true, 'waiting', 'Selected; click Sync now or wait for the next sync.', '#jira', 'Sync now'));
    }

    if (sources === null || flagList === null) {
        steps.push(step('flags', 'Send feature flags', true, 'loading', ''));
    } else if (sources.error || flagList.error) {
        steps.push(step('flags', 'Send feature flags', true, 'problem', sources.error || flagList.error, '#sources'));
    } else if (flagList.length) {
        // Received, but a source whose every token has run out (or is about to) stops sending: say so before it does.
        const lapsing = sources.filter((src) => src.tokens.length && src.tokens.every((t) => tokenState(t, now) !== 'ok'));
        const lapsed = lapsing.filter((src) => src.tokens.every((t) => tokenState(t, now) === 'expired'));
        if (lapsed.length) {
            steps.push(step('flags', 'Send feature flags', true, 'problem',
                `The tokens of ${lapsed.map((src) => src.name).join(', ')} have expired: it can't send anything until it gets a new one.`, '#sources', 'New token'));
        } else if (lapsing.length) {
            steps.push(step('flags', 'Send feature flags', true, 'waiting',
                `The tokens of ${lapsing.map((src) => src.name).join(', ')} expire within ${TOKEN_WARNING_DAYS} days: create a new one and give it to the sender.`, '#sources', 'New token'));
        } else {
            steps.push(step('flags', 'Send feature flags', true, 'done', `${flagList.length} flag(s) received.`, '#flags'));
        }
    } else if (sources.some(sourceRefused)) {
        const refused = sources.filter(sourceRefused);
        steps.push(step('flags', 'Send feature flags', true, 'problem',
            `Message refused: ${refused.map((src) => `${src.name} — ${src.lastError.message}`).join('; ')}`, '#sources'));
    } else if (sources.some((src) => src.origin === 'code' && (src.environments || []).some((e) => e.state === 'error'))) {
        const failing = sources.filter((src) => src.origin === 'code' && (src.environments || []).some((e) => e.state === 'error'));
        steps.push(step('flags', 'Send feature flags', true, 'problem',
            `Could not read the flags file of ${failing.map((src) => src.name).join(', ')}: see the source for why.`, '#sources'));
    } else if (sources.some((src) => src.origin === 'endpoint' && (src.environments || []).some((e) => e.state === 'error'))) {
        const failing = sources.filter((src) => src.origin === 'endpoint' && (src.environments || []).some((e) => e.state === 'error'));
        steps.push(step('flags', 'Send feature flags', true, 'problem',
            `Could not read the endpoint of ${failing.map((src) => src.name).join(', ')}: see the source for why.`, '#sources'));
    } else if (sources.some((src) => src.origin === 'code')) {
        steps.push(step('flags', 'Send feature flags', true, 'waiting',
            `Waiting for a deployment: ${sources.filter((src) => src.origin === 'code').map((src) => src.name).join(', ')} is read at the next sync of its repository.`, '#sources'));
    } else if (sources.some((src) => src.origin === 'endpoint')) {
        steps.push(step('flags', 'Send feature flags', true, 'waiting',
            `Waiting for the first read: ShipScope reads the endpoint of ${sources.filter((src) => src.origin === 'endpoint').map((src) => src.name).join(', ')} within a minute.`, '#sources'));
    } else if (sources.some((src) => activeTokens(src, now).length)) {
        steps.push(step('flags', 'Send feature flags', true, 'waiting',
            `Waiting for the first message from ${sources.filter((src) => activeTokens(src, now).length).map((src) => src.name).join(', ')} (POST /api/flags/ingest with its token).`, '#sources'));
    } else {
        steps.push(step('flags', 'Send feature flags', true, 'todo', 'Add a source and give its token to your pipeline: the ShipScope flags adapter sends the state of your flags at each deployment. ShipScope can also read them itself, from your code or an endpoint, under Sources → Advanced sources.', '#sources', 'Add a source'));
    }

    if (!workspace) {
        steps.push(step('team', 'Invite your team', true, 'loading', ''));
    } else if (workspace.members.length > 1) {
        steps.push(step('team', 'Invite your team', true, 'done', `${workspace.members.length} members.`, '#members'));
    } else if (workspace.invitations && workspace.invitations.length) {
        steps.push(step('team', 'Invite your team', true, 'waiting', 'Invitation link created; waiting for it to be accepted.', '#members'));
    } else {
        steps.push(step('team', 'Invite your team', true, 'todo', 'Create an invitation link per person; members see everything, admins can change settings.', '#members', 'Invite'));
    }
    return steps;
}

/** Hidden by the admin for this workspace in this browser (the checklist can come back from the nav). */
function checklistHidden(){
    try {
        return localStorage.getItem(CHECKLIST_HIDDEN_KEY + settingsState.tenantId) === '1';
    } catch {
        return false;
    }
}

function setChecklistHidden(hidden){
    try {
        if (hidden) {
            localStorage.setItem(CHECKLIST_HIDDEN_KEY + settingsState.tenantId, '1');
        } else {
            localStorage.removeItem(CHECKLIST_HIDDEN_KEY + settingsState.tenantId);
        }
    } catch {
        // Storage blocked (private mode): the checklist simply stays visible.
    }
}

/** @param {{ steps: object[], hidden?: boolean }} props */
function renderGettingStarted({ steps, hidden = false }){
    const counted = steps.filter((st) => st.state !== 'unavailable');
    const done = counted.filter((st) => st.state === 'done').length;
    const requiredDone = steps.filter((st) => !st.optional && st.state !== 'unavailable').every((st) => st.state === 'done');
    const finished = counted.every((st) => st.state === 'done');
    if (hidden && requiredDone) {
        return html``;
    }
    const items = steps.map((st) => html`<li class="checklist-step ${st.state}">
        <span class="checklist-mark" aria-hidden="true">${STEP_MARK[st.state]}</span>
        <div><strong>${st.title}</strong>${st.optional ? html` <span class="state-tag">optional</span>` : ''}
            ${st.state === 'loading' ? html`<span class="settings-hint">checking…</span>` : st.hint ? html`<div class="settings-hint">${st.hint}</div>` : ''}</div>
        ${st.href && st.cta && st.state !== 'done' ? html`<a class="btn ${st.state === 'todo' ? 'btn-primary' : ''}" href="${st.href}">${st.cta}</a>` : ''}
    </li>`);
    const summary = finished
        ? 'All set: everything is connected.'
        : requiredDone ? `${done} of ${counted.length} done — the dashboard is ready; the optional steps add Jira, flags and your team.`
            : `${done} of ${counted.length} done.`;
    return Page({
        id: 'getting-started',
        title: 'Getting started',
        hint: summary,
        body: Card({ body: html`<ol class="checklist">${items}</ol>${requiredDone ? html`<div class="settings-actions"><a class="btn" href="./">Open the dashboard</a>
            <button type="button" class="btn" data-action="hide-checklist">Hide this checklist</button></div>` : ''}` }),
    });
}

// What the sidebar's Setup card says after a step's name, for the steps still open.
const STEP_SHORT = {
    'deployments.waiting': 'waiting for a GitHub Deployment',
    'boards.waiting': 'sync pending',
    'flags.waiting': 'waiting for the first message',
    'team.waiting': 'invitation not accepted yet',
};
const STATE_SHORT = { todo: 'to do', waiting: 'waiting', problem: 'needs attention' };

/**
 * The sidebar's Setup card: progress over the steps this server offers and the ones still open. Nothing once every
 * step is done, or when the admin hid the checklist after the required ones.
 *
 * @param {{ steps: object[], hidden?: boolean }} props
 */
function SetupCard({ steps, hidden = false }){
    const counted = steps.filter((st) => st.state !== 'unavailable');
    const done = counted.filter((st) => st.state === 'done').length;
    const requiredDone = steps.filter((st) => !st.optional && st.state !== 'unavailable').every((st) => st.state === 'done');
    const open = counted.filter((st) => ['todo', 'waiting', 'problem'].includes(st.state));
    if ((hidden && requiredDone) || done === counted.length) {
        return html``;
    }
    return html`<div class="settings-setup">
        <div class="settings-setup-head"><strong>Setup</strong><span><b>${done}</b> of ${counted.length} done</span></div>
        <div class="settings-progress" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="${counted.length}" aria-valuenow="${done}"><span style="width:${Math.round((done / counted.length) * 100)}%"></span></div>
        <ul>${open.map((st) => html`<li class="${st.state}">${st.title} — ${STEP_SHORT[`${st.id}.${st.state}`] || STATE_SHORT[st.state]}</li>`)}</ul>
        <a class="btn" href="#getting-started">View checklist</a>
    </div>`;
}

// Which checklist steps a sidebar entry answers for: its count turns amber while one of them waits on the admin
// (a step with a button), red when one has a problem.
const PAGE_STEPS = { members: ['team'], github: ['github-app', 'repos', 'deployments'], jira: ['jira', 'boards'], sources: ['flags'] };

/**
 * The sidebar: the workspace, the pages by group with their counts, and the Setup card for admins.
 *
 * @param {{ page: string, tenant: { name: string, role: string }, admin: boolean, counts: Object<string, number|undefined>, steps: object[], hidden?: boolean }} props
 */
function renderSidebar({ page, tenant, admin, counts, steps, hidden = false }){
    const tone = (id) => {
        const own = steps.filter((st) => (PAGE_STEPS[id] || []).includes(st.id));
        if (own.some((st) => st.state === 'problem')) {
            return 'fail';
        }
        return own.some((st) => st.state !== 'done' && st.href && st.cta) ? 'warn' : '';
    };
    const count = (id) => (typeof counts[id] === 'number'
        ? html`<span class="${tone(id) ? `settings-count ${tone(id)}` : 'settings-count'}">${counts[id]}</span>` : '');
    const groups = PAGES.map((g) => {
        const items = g.items.filter((p) => admin || !p.admin);
        if (!items.length) {
            return '';
        }
        return html`<div class="settings-nav-group"><div class="settings-nav-label">${g.group}</div>
            ${items.map((p) => html`<a href="#${p.id}" class="${p.id === page ? 'settings-nav-item active' : 'settings-nav-item'}" ${p.id === page ? raw('aria-current="page"') : ''}>${SETTINGS_ICONS[p.id]}<span>${p.label}</span>${count(p.id)}</a>`)}
        </div>`;
    });
    const members = counts.members;
    return html`<div class="settings-workspace">
            <span class="settings-avatar">${initials(tenant.name)}</span>
            <div><strong>${tenant.name}</strong><span>You are ${tenant.role}${typeof members === 'number' ? ` · ${members} member${members === 1 ? '' : 's'}` : ''}</span></div>
        </div>
        <nav class="settings-nav" aria-label="Settings">${groups}</nav>
        ${admin ? SetupCard({ steps, hidden }) : ''}`;
}

const MEMBER_HINT = 'You are a member: only admins can change settings.';

const EVENT_TYPE_LABELS = [['release.stage_changed', 'a planned flag moves to another rollout stage on PROD'], ['feature.released', 'every item of a release line is with users on PROD']];

/** Outgoing events (G1.5, admins): the addresses that get release events, their delivery state, and a form. */
function EventSubscriptions(subs){
    if (subs === null) {
        return '';
    }
    if (subs && subs.error) {
        return Card({ title: 'Outgoing events', body: html`<p class="settings-error">${subs.error}</p>` });
    }
    const rows = subs.map((s) => html`<li><strong class="mono">${s.url}</strong> <span class="settings-row-meta">${s.types.join(', ')}${s.pending ? ` · ${s.pending} waiting` : ''}${s.lastDeliveredAt ? html` · last delivered ${fmtDateTime(s.lastDeliveredAt)}` : ''}</span>
        ${s.lastError ? html`<div class="settings-error">${s.lastError}</div>` : ''}
        <button type="button" class="btn-link btn" data-action="remove-event-subscription" data-subscription-id="${s.id}">remove</button></li>`);
    return Card({
        title: 'Outgoing events',
        body: html`<p class="settings-hint">ShipScope posts release events (pdi contract 0.4.0) to these https addresses, signed with this workspace's signing secret
            (Settings → Sources): <span class="mono">X-ShipScope-Signature: v1=HMAC-SHA256(secret, "&lt;timestamp&gt;.&lt;body&gt;")</span>. A failed delivery is tried again for a few hours.</p>
            ${rows.length ? html`<ul class="settings-list">${rows}</ul>` : html`<p class="settings-hint">No address yet.</p>`}
            <form class="settings-form" data-action="add-event-subscription">
                <label>Address <input name="url" type="url" required maxlength="500" placeholder="https://pdi.example.com/hooks/shipscope"></label>
                ${EVENT_TYPE_LABELS.map(([type, label]) => html`<label class="inline"><input type="checkbox" name="types" value="${type}" checked> <span class="mono">${type}</span>: ${label}</label>`)}
                <button type="submit" class="btn">Subscribe</button>
            </form>`,
    });
}

/** Service tokens (F5, admins): read-only tokens other services (pdi, tf) use for the service API; a new one shown once. */
function ServiceTokens(tokens, once){
    if (tokens === null) {
        return '';
    }
    if (tokens && tokens.error) {
        return Card({ title: 'Service tokens', body: html`<p class="settings-error">${tokens.error}</p>` });
    }
    const rows = tokens.map((t) => html`<li><strong>${t.name}</strong> <span class="settings-row-meta">created ${fmtDateTime(t.createdAt)} · ${t.expiresAt ? html`expires ${fmtDateTime(t.expiresAt)}` : 'never expires'} · ${t.lastUsedAt ? html`last used ${fmtDateTime(t.lastUsedAt)}` : 'never used'}</span>
        <button type="button" class="btn-link btn" data-action="revoke-service-token" data-token-id="${t.id}">revoke</button></li>`);
    return Card({
        title: 'Service tokens',
        body: html`${once && once.serviceToken ? SecretBox({ label: 'Service token — shown only once', value: once.serviceToken, note: 'Give it to the service (pdi, tf); ShipScope keeps only its hash.' }) : ''}
            <p class="settings-hint">Read-only access for other services: an item's status per environment (<span class="mono">GET /api/service/v1/items/&lt;key&gt;</span>)
            and PROD metrics per day (<span class="mono">GET /api/service/v1/metrics?format=csv</span>), with <span class="mono">Authorization: Bearer &lt;token&gt;</span>.</p>
            ${rows.length ? html`<ul class="settings-list">${rows}</ul>` : html`<p class="settings-hint">No token yet.</p>`}
            <form class="settings-form" data-action="create-service-token">
                <label>Name <input name="name" required maxlength="100" placeholder="pdi"></label>
                <label>Valid for (days, empty = no end) <input name="lifetimeDays" type="number" min="1" max="730" value="365"></label>
                <button type="submit" class="btn">Create token</button>
            </form>`,
    });
}

/** `pdi`: the workspace is connected with pdi; outgoing events and service tokens belong to that layer (design-docs/PDI-GATE-PLAN.pl.md).
 * @param {{ workspace: { settings: object }|null, admin: boolean, auditEvents?: object[]|null|{ error: string }, eventSubscriptions?: object[]|null|{ error: string }, serviceTokens?: object[]|null|{ error: string }, once?: object, pdi?: boolean }} props */
function renderGeneral({ workspace, admin, auditEvents = null, eventSubscriptions = null, serviceTokens = null, once = {}, pdi = false }){
    const page = (body) => Page({ id: 'general', section: 'workspace', title: 'General', hint: admin ? 'How long ShipScope keeps this workspace\'s history, and whether the dashboard shows Insights.' : MEMBER_HINT, body });
    if (!workspace) {
        return page(html`<p class="settings-loading">Loading…</p>`);
    }
    const days = workspace.settings.deploymentRetentionDays;
    return page(html`${Card({
        title: 'Deployment history',
        body: admin
            ? html`<p class="settings-hint">Older deployments and flag changes are removed daily; each environment's latest and latest successful deployment, and each flag's latest change, always stay.</p>
                <form class="settings-form" data-action="save-retention">
                <label>Keep deployment history (days, 7–730) <input name="deploymentRetentionDays" type="number" min="7" max="730" required value="${days}"></label>
                <button type="submit" class="btn">Save</button></form>`
            : html`<p class="settings-hint">Deployment history is kept for ${days} days.</p>`,
    })}${Card({
        title: 'Insights',
        // A workspace setting (design-docs/CORE-SIMPLIFY-PLAN.pl.md, D2); ?insights=1 in the address still previews it.
        body: admin
            ? html`<p class="settings-hint">A dashboard tab with charts over the data ShipScope already has: release status per sprint and priority, lead time Done → PROD, stale flags, rollbacks and drift.</p>
                <form class="settings-form" data-action="save-insights">
                <label class="inline"><input name="insightsEnabled" type="checkbox" ${workspace.settings.insightsEnabled ? raw('checked') : ''}> Show Insights on the dashboard</label>
                <button type="submit" class="btn">Save</button></form>`
            : html`<p class="settings-hint">Insights: ${workspace.settings.insightsEnabled ? 'on' : 'off'}.</p>`,
    })}${admin && pdi ? EventSubscriptions(eventSubscriptions) : ''}${admin && pdi ? ServiceTokens(serviceTokens, once) : ''}${admin ? AuditEvents(auditEvents) : ''}`);
}

// ---- pdi ---------------------------------------------------------------------------------------------------

const PDI_STATE_LABELS = { none: 'Not connected', pending: 'Waiting for pdi', connected: 'Connected', degraded: 'Connected, with problems', disconnected: 'Disconnected' };
const PDI_CHECKS = {
    pdi_reads: { ok: 'pdi read ShipScope with its token', todo: 'pdi has not read ShipScope yet: set the three variables in pdi and start pdi-receiver or its MCP server' },
    reaches_pdi: { ok: 'ShipScope reached pdi', todo: 'ShipScope has not reached pdi yet: use Test once pdi-receiver runs at the address' },
};

/** One proof of the connection: done, waiting, or failing with pdi's answer. */
function PdiCheck(check){
    const text = PDI_CHECKS[check.id] || { ok: check.id, todo: check.id };
    const mark = check.ok ? '✓' : check.error ? '!' : '…';
    return html`<li><span class="state-tag">${mark}</span> ${check.ok ? text.ok : text.todo}${check.at ? html` <span class="settings-row-meta">· last ${fmtDateTime(check.at)}</span>` : ''}
        ${check.error ? html`<div class="settings-error">${check.error}</div>` : ''}</li>`;
}

/**
 * Settings → Integrations → pdi (design-docs/PDI-CONNECTION-PLAN.pl.md): connect with pdi's receiver address, the three
 * variables for pdi shown once, the state with its two proofs, Test and Disconnect. Members see the state only.
 *
 * @param {{ connection: { state: string, receiverUrl: string|null, connectedAt: string|null, checks: object[] }|null|{ error: string }, admin: boolean, once?: { pdiEnv?: Record<string, string> } }} props
 */
function renderPdi({ connection, admin, once = {} }){
    const page = (body) => Page({ id: 'pdi', section: 'pdi', title: 'pdi', hint: 'pdi keeps the decisions and problems behind your changes. Connected, it gets ShipScope\'s release events and reads release status for its trace and impact reviews.', body });
    if (!connection) {
        return page(html`<p class="settings-loading">Loading…</p>`);
    }
    if (connection.error) {
        return page(Card({ body: html`<p class="settings-error">${connection.error}</p>` }));
    }
    const env = once.pdiEnv ? Object.entries(once.pdiEnv).map(([k, v]) => `${k}=${v}`).join('\n') : null;
    const shown = env ? SecretBox({ label: 'Variables for pdi — shown only once', value: env, note: 'Put them in pdi\'s environment (pdi-receiver and its MCP server). ShipScope keeps only the token\'s hash and the secret sealed.' }) : '';
    const active = ['pending', 'connected', 'degraded'].includes(connection.state);
    if (!active) {
        const form = admin
            ? html`<form class="settings-form" data-action="connect-pdi">
                <label>pdi-receiver's address <input name="receiverUrl" type="url" required maxlength="500" placeholder="https://pdi.example.com"></label>
                <button type="submit" class="btn">Connect</button></form>`
            : html`<p class="settings-hint">${MEMBER_HINT}</p>`;
        return page(Card({
            title: PDI_STATE_LABELS[connection.state] || connection.state,
            body: html`<p class="settings-hint">Connecting creates a read-only service token for pdi and sends ShipScope's release events to <span class="mono">&lt;address&gt;/events/shipscope</span>, signed with a secret of their own.${connection.state === 'disconnected' ? html` Disconnected ${fmtDateTime(connection.disconnectedAt)}.` : ''}</p>${form}`,
        }));
    }
    const actions = admin
        ? html`<span><button type="button" class="btn" data-action="test-pdi">Test</button> <button type="button" class="btn btn-danger" data-action="disconnect-pdi">Disconnect</button></span>`
        : '';
    return page(html`${shown}${Card({
        title: PDI_STATE_LABELS[connection.state] || connection.state,
        body: html`<p class="settings-hint">pdi at <strong class="mono">${connection.receiverUrl}</strong>, connected ${fmtDateTime(connection.connectedAt)}.</p>
            <ul class="settings-list">${connection.checks.map(PdiCheck)}</ul>${actions}`,
    })}`);
}

/** @param {{ workspace: { members: object[], invitations: object[]|null }|null, admin: boolean, meId: string, once: object }} props */
function renderMembers({ workspace, admin, meId, once }){
    const page = (body) => Page({ id: 'members', section: 'workspace', title: 'Members', hint: admin ? 'Members see everything; admins can change settings.' : MEMBER_HINT, body });
    if (!workspace) {
        return page(html`<p class="settings-loading">Loading…</p>`);
    }
    const { members, invitations } = workspace;
    const memberRows = members.map((m) => {
        const self = m.userId === meId;
        const action = self
            ? html`<button type="button" class="btn btn-danger" data-action="remove-member" data-user-id="${m.userId}" data-self="1">Leave</button>`
            : admin ? html`<button type="button" class="btn btn-danger" data-action="remove-member" data-user-id="${m.userId}">Remove</button>` : '';
        return html`<tr><td><span class="settings-repo"><span class="settings-badge">${initials(m.githubLogin)}</span><span>${m.githubLogin}${self ? html` <span class="state-tag">you</span>` : ''}</span></span></td>
            <td>${m.role}</td><td class="actions">${action}</td></tr>`;
    });
    const inviteBlock = admin ? Card({
        title: 'Invitations',
        body: html`${once.inviteUrl ? SecretBox({ label: 'Invitation link — shown only once', value: once.inviteUrl, note: 'Send it to the person you invite; it works once and expires in 7 days.' }) : ''}
        <form class="settings-form" data-action="create-invitation">
            <label>Role <select name="role"><option value="member">member</option><option value="admin">admin</option></select></label>
            <button type="submit" class="btn">Create invitation link</button>
        </form>
        ${invitations && invitations.length ? html`<table class="settings-table"><thead><tr><th>Role</th><th>Created by</th><th>Expires</th><th></th></tr></thead><tbody>
            ${invitations.map((i) => html`<tr><td>${i.role}</td><td>${i.createdBy}</td><td>${fmtDateTime(i.expiresAt)}</td>
                <td class="actions"><button type="button" class="btn btn-danger" data-action="revoke-invitation" data-invitation-id="${i.id}">Revoke</button></td></tr>`)}
            </tbody></table>` : html`<p class="settings-hint">No pending invitations.</p>`}`,
    }) : '';
    return page(html`${Card({ cls: 'flush', body: html`<table class="settings-table"><thead><tr><th>GitHub user</th><th>Role</th><th></th></tr></thead><tbody>${memberRows}</tbody></table>` })}${inviteBlock}`);
}

/** The danger zone: deleting the workspace needs its name typed back (the server checks it too). Admins only. */
function renderDangerZone({ tenantName = '' }){
    return Page({
        id: 'danger',
        section: 'workspace',
        title: 'Danger zone',
        hint: 'Changes here cannot be undone.',
        body: Card({
            cls: 'danger',
            title: 'Delete workspace',
            body: html`<p class="settings-hint">Deletes this workspace and everything ShipScope holds for it: members, invitations, tracked
            repositories and their deployments, the Jira connection and its issues, flag sources and values. This cannot be undone.
            ShipScope's Jira webhook is removed; the GitHub App stays installed on GitHub — uninstall it there
            (organization or account Settings → GitHub Apps) if nothing else uses it.</p>
            <form class="settings-form" data-action="delete-workspace">
                <label>Type <strong>${tenantName}</strong> to confirm <input name="confirmName" required maxlength="200" autocomplete="off"></label>
                <button type="submit" class="btn btn-danger">Delete workspace</button>
            </form>`,
        }),
    });
}

/** A tracked repository's last sync: a coloured dot and when, or why not. */
function syncStatus(repo){
    if (repo.rateLimitedUntil) {
        return html`<span class="settings-sync warn" title="GitHub asked ShipScope to slow down for this installation; other workspaces are not affected">paused by GitHub's rate limit until ${fmtDateTime(repo.rateLimitedUntil)}</span>`;
    }
    if (repo.lastSyncError) {
        return html`<span class="settings-sync fail" title="${repo.lastSyncError}">sync failed</span>`;
    }
    return repo.lastSyncedAt ? html`<span class="settings-sync ok">${fmtDateTime(repo.lastSyncedAt)}</span>` : html`<span class="settings-sync warn">not synced yet</span>`;
}

/** GitHub's own page for an installation, where its owner picks repositories or uninstalls it. */
function installationSettingsUrl(inst){
    return inst.accountType === 'Organization'
        ? `https://github.com/organizations/${encodeURIComponent(inst.accountLogin)}/settings/installations/${Number(inst.installationId)}`
        : `https://github.com/settings/installations/${Number(inst.installationId)}`;
}

/** One installation: the account, how many of its repositories are tracked, how fast deployments arrive. */
function InstallationCard(inst, { tracked, webhooks, admin }){
    return html`<div class="settings-card settings-installation">
        <span class="settings-avatar">${initials(inst.accountLogin)}</span>
        <div class="settings-installation-text"><div><strong>${inst.accountLogin}</strong>${inst.accountType ? html`<span class="settings-muted"> · ${inst.accountType}</span>` : ''}</div>
            <div class="settings-row-meta">GitHub App installed · ${tracked} ${tracked === 1 ? 'repository' : 'repositories'} tracked · ${webhooks
                ? 'a deployment shows up within a minute' : 'new deployments arrive with the periodic sync (every 15 minutes by default)'}</div></div>
        <div class="settings-installation-actions">
            ${webhooks ? html`<span class="settings-pill ok">Instant updates on</span>`
                : html`<span class="settings-pill" title="Set GITHUB_APP_WEBHOOK_SECRET on the server for instant updates">Periodic sync</span>`}
            <a class="btn" href="${installationSettingsUrl(inst)}" target="_blank" rel="noopener">Manage on GitHub</a>
            ${admin ? html`<button type="button" class="btn btn-danger" data-action="unlink-installation" data-installation-id="${inst.installationId}">Unlink</button>` : ''}
        </div>
    </div>`;
}

/** "Track repository": each installation's repositories, tracked or not (loaded on opening). */
function TrackPicker(installations, installationRepos){
    const lists = installations.map((inst) => {
        const list = installationRepos[inst.installationId];
        let body = html`<p class="settings-loading">Loading repositories…</p>`;
        if (list && list.error) {
            body = html`<p class="settings-error">${list.error}</p>`;
        } else if (Array.isArray(list)) {
            body = list.length ? html`<table class="settings-table"><tbody>${list.map((r) => html`<tr><td>${r.fullName}${r.private ? html` <span class="state-tag">private</span>` : ''}</td>
                <td class="actions">${r.tracked
                    ? html`<button type="button" class="btn" data-action="untrack-repo" data-repo-id="${r.id}" data-installation-id="${inst.installationId}">Stop tracking</button>`
                    : html`<button type="button" class="btn btn-primary" data-action="track-repo" data-repo-id="${r.id}" data-installation-id="${inst.installationId}">Track</button>`}</td></tr>`)}</tbody></table>`
                : html`<p class="settings-hint">The App can't see any repository of this installation; choose repositories on GitHub.</p>`;
        }
        return html`<h3>${inst.accountLogin}</h3>${body}`;
    });
    return Card({
        cls: 'settings-picker',
        body: html`<div class="settings-card-head"><h2>Track a repository</h2>
            <button type="button" class="btn btn-icon" data-action="close-track-picker" aria-label="Close" title="Close">${SETTINGS_ICONS.close}</button></div>
            ${lists}<p class="settings-hint">Missing one? Give the App access to it on GitHub, or <a href="${tenantPath('/github/install')}">install the App on another account</a>.</p>`,
    });
}

/** The server's default rule for a GitHub environment name (lib/deployment-logic.js mapEnvironment()), for the form. */
function defaultEnvOf(name){
    const e = String(name || '').toLowerCase().trim();
    if (/pre[-_]?prod/.test(e)) {
        return null;
    }
    if (e.includes('prod')) {
        return 'prod';
    }
    if (e.includes('qa')) {
        return 'qa';
    }
    return e.includes('test') || e.includes('dev') ? 'test' : null;
}

/** One row per GitHub environment the sync has seen (or the map names): auto (the default rule), test, qa, prod, skip. */
function EnvironmentMapFields(r){
    const map = r.envMap || {};
    const names = [...(r.seenEnvironments || [])];
    for (const name of Object.keys(map)) {
        if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) {
            names.push(name);
        }
    }
    if (!names.length) {
        return html`<p class="settings-row-meta">Environments: none seen yet; they show up here after the first deployments are synced.</p>`;
    }
    const chosen = (name) => {
        const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? map[key] : 'auto';
    };
    return html`<fieldset class="settings-envs"><legend>GitHub environments</legend>${names.map((name, i) => {
        const auto = defaultEnvOf(name);
        const options = [['auto', `auto (${auto || 'skipped'})`], ['test', 'test'], ['qa', 'qa'], ['prod', 'prod'], ['skip', 'skip']];
        return html`<label class="inline"><input type="hidden" name="envName${i}" value="${name}">${name} <select name="envChoice${i}">${options.map(([value, label]) => html`<option value="${value}" ${value === chosen(name) ? raw('selected') : ''}>${label}</option>`)}</select></label>`;
    })}</fieldset>`;
}

/** The environment map from the form: only the names not left on auto. */
function envMapOf(values){
    const map = {};
    for (let i = 0; values[`envName${i}`] !== undefined; i += 1) {
        const choice = values[`envChoice${i}`];
        if (choice && choice !== 'auto') {
            map[values[`envName${i}`]] = choice;
        }
    }
    return map;
}

// Whether a repo uses feature flags (tracked_repos.flag_stance). A repo some flag source covers is tracked anyway;
// the dashboard then reads its flags, and "no flags" means deployed code is live.
const FLAG_STANCES = { unknown: 'not set', none: 'none' };
const FLAG_STANCE_CHOICES = { unknown: 'Not set (a flag source covers it, or not said yet)', none: 'This repository has no feature flags' };
// Whether a repo is a frontend or a backend (tracked_repos.service_role): the dashboard warns when an issue's flag is
// on in a frontend while a backend it needs has it off ("FE on, BE off").
const SERVICE_ROLE_CHOICES = { '': 'Not set', frontend: 'Frontend (what users see)', backend: 'Backend (APIs, services)' };

/** @param {{ enabled: boolean, webhooks: boolean, github: { installations: object[], repos: object[] }|null, installationRepos: object, admin: boolean, picker?: boolean, editing?: number|null }} props */
function renderGitHub({ enabled, webhooks, github, installationRepos, admin, picker = false, editing = null, sources = null, wizard = { draft: {}, found: null, preview: null }, pdi = false }){
    const hint = 'ShipScope reads deployments, releases and tags of the repositories you track, through the GitHub App.';
    const page = (body, action) => Page({ id: 'github', title: 'GitHub', hint, action, body });
    if (!enabled) {
        return page(html`<p class="settings-hint">The GitHub App is not configured on this server (GITHUB_APP_* variables).</p>`);
    }
    if (!github) {
        return page(html`<p class="settings-loading">Loading…</p>`);
    }
    let action = '';
    if (admin) {
        action = github.installations.length
            ? html`<button type="button" class="btn btn-primary btn-lg" data-action="open-track-picker">${SETTINGS_ICONS.plus}Track repository</button>`
            : html`<a class="btn btn-primary btn-lg" href="${tenantPath('/github/install')}">${SETTINGS_ICONS.plus}Install the GitHub App</a>`;
    }
    const cards = github.installations.map((inst) => InstallationCard(inst, {
        tracked: github.repos.filter((r) => r.installationId === inst.installationId).length, webhooks, admin,
    }));
    const rows = github.repos.map((r) => {
        const [owner, name] = r.fullName.includes('/') ? r.fullName.split('/') : ['', r.fullName];
        const row = html`<tr>
            <td><span class="settings-repo"><span class="settings-badge">${repoBadge(r.fullName)}</span><span><strong>${name}</strong><span class="settings-row-meta">${owner}</span></span></span></td>
            <td class="mono">${r.versionFile || '—'}</td>
            <td class="mono">${(r.driftIgnorePaths || []).join(', ') || '—'}</td>
            <td class="mono">${syncStatus(r)}${pdi && r.workItemsError ? html`<div><span class="settings-sync warn" title="${r.workItemsError}">changes folder: ${r.workItemsError.split('; ').length} problem${r.workItemsError.split('; ').length === 1 ? '' : 's'}</span></div>` : ''}</td>
            <td>${FLAG_STANCES[r.flagStance] || FLAG_STANCES.unknown}</td>
            ${admin ? html`<td class="actions">
                <button type="button" class="btn btn-icon" data-action="edit-repo" data-repo-id="${r.repoId}" aria-label="Edit ${r.fullName}" title="Version file, drift and flags">${SETTINGS_ICONS.edit}</button>
                <button type="button" class="btn btn-icon btn-danger" data-action="untrack-repo" data-repo-id="${r.repoId}" data-installation-id="${r.installationId}" aria-label="Stop tracking ${r.fullName}" title="Stop tracking">${SETTINGS_ICONS.close}</button>
            </td>` : ''}</tr>`;
        if (!admin || editing !== r.repoId) {
            return row;
        }
        return html`${row}<tr class="settings-edit-row"><td colspan="6"><form class="settings-form" data-action="save-repo-settings" data-repo-id="${r.repoId}" data-flag-stance="${r.flagStance || 'unknown'}" data-service-role="${r.serviceRole || ''}" data-env-map="${JSON.stringify(r.envMap || {})}">
            <label>Version file <input name="versionFile" placeholder="e.g. trigger.properties" value="${r.versionFile || ''}" maxlength="200"></label>
            <label>Paths not counted as drift (one per line) <textarea name="driftIgnorePaths" placeholder=".github/&#10;README.md">${(r.driftIgnorePaths || []).join('\n')}</textarea></label>
            ${EnvironmentMapFields(r)}
            <label>Feature flags <select name="flagStance">${Object.entries(FLAG_STANCE_CHOICES).map(([value, label]) => html`<option value="${value}" ${value === (r.flagStance || 'unknown') ? raw('selected') : ''}>${label}</option>`)}</select></label>
            <label>Role <select name="serviceRole">${Object.entries(SERVICE_ROLE_CHOICES).map(([value, label]) => html`<option value="${value}" ${value === (r.serviceRole || '') ? raw('selected') : ''}>${label}</option>`)}</select></label>
            <button type="submit" class="btn btn-primary">Save</button>
            <button type="button" class="btn" data-action="edit-repo" data-repo-id="${r.repoId}">Cancel</button></form>
            ${RepoFlagsCard({ r, sources, wizard })}</td></tr>`;
    });
    const table = rows.length
        ? Card({ cls: 'flush', body: html`<table class="settings-table settings-repos"><thead><tr><th>Repository</th><th>Version file</th><th>Ignored for drift</th><th>Last sync</th><th>Flags</th>${admin ? html`<th></th>` : ''}</tr></thead><tbody>${rows}</tbody></table>` })
        : Card({ body: html`<p class="settings-hint">No repository tracked yet.${admin && github.installations.length ? ' Click Track repository to choose one.' : ''}</p>` });
    return page(html`${cards.length ? cards : Card({ body: html`<p class="settings-hint">No installation linked yet.</p>` })}
        ${admin && picker && github.installations.length ? TrackPicker(github.installations, installationRepos) : ''}${table}`, action);
}

function BoardRow(board, admin){
    // The checkbox belongs to the selection form below the table (form="..."): the row's own rhythm form can't
    // sit inside another form.
    const select = admin ? html`<input type="checkbox" form="jiraBoardSelection" name="boardIds" value="${board.boardId}" ${board.selected ? raw('checked') : ''} aria-label="Sync ${board.name}">` : '';
    let rhythm = html``;
    if (board.selected) {
        const usesTemplate = board.rhythm === 'pi' || board.rhythm === 'auto';
        rhythm = admin ? html`<form class="settings-form" data-action="save-rhythm" data-board-id="${board.boardId}">
            <label>Rhythm <select name="rhythm" data-action-change="rhythm-changed">${RHYTHMS.map(([value, label]) => html`<option value="${value}" ${value === board.rhythm ? raw('selected') : ''}>${label}</option>`)}</select></label>
            <label>PI naming (optional) <input name="piTemplate" placeholder="PI {pi} / Iteration {n}" maxlength="100" value="${board.piTemplate || ''}" ${usesTemplate ? '' : raw('disabled')}></label>
            <button type="submit" class="btn">Save</button></form>`
            : html`<div class="settings-row-meta">Rhythm: ${(RHYTHMS.find(([v]) => v === board.rhythm) || [null, board.rhythm])[1]}</div>`;
        rhythm = html`${rhythm}<div class="settings-row-meta">Now: ${board.currentIncrement || 'not synced yet'}</div>`;
    }
    return html`<tr><td>${select}</td><td><strong>${board.name}</strong> <span class="state-tag">${board.type || 'board'}</span>
        <div class="settings-row-meta">${board.projectName || ''}${board.projectKey ? ` (${board.projectKey})` : ''}</div>${rhythm}</td></tr>`;
}

function webhookLine(webhooks, webhook){
    if (!webhooks || !webhook) {
        return html``;
    }
    if (webhook.active) {
        return html`<p class="settings-hint"><span class="state-tag ok">instant updates on</span> Issue changes show up within a minute.</p>`;
    }
    return html`<p class="settings-hint"><span class="state-tag warn">instant updates off</span> ${webhook.error || 'Turned on with the next sync of the selected boards.'}</p>`;
}

/** How the tenant's Jira issues name their feature flags: not at all, labels with a prefix, or a field. */
function FlagLinkForm(flagLink, fields){
    const type = flagLink ? flagLink.type : 'none';
    const option = (value, label) => html`<option value="${value}" ${value === type ? raw('selected') : ''}>${label}</option>`;
    let fieldSelect = html`<select name="id" ${type === 'field' ? '' : raw('disabled')}><option value="">Loading fields…</option></select>`;
    if (fields && fields.error) {
        fieldSelect = html`<span class="settings-error">${fields.error}</span>`;
    } else if (Array.isArray(fields)) {
        const selected = flagLink && flagLink.type === 'field' ? flagLink.id : '';
        fieldSelect = fields.length
            ? html`<select name="id" ${type === 'field' ? '' : raw('disabled')}>${fields.map((f) => html`<option value="${f.id}" ${f.id === selected ? raw('selected') : ''}>${f.name} (${f.type})</option>`)}</select>`
            : html`<span class="settings-hint">No text, labels or select field yet — a Jira admin can add one (e.g. "Feature flag").</span>`;
    }
    return html`<h3>Feature flags in Jira</h3>
        <p class="settings-hint">How your issues name the feature flags their work ships behind. ShipScope reads it with every sync, and the
        dashboard links each flag to those issues. A field is clearest for people working in Jira (a Jira admin adds it once, e.g. a
        "Feature flag" text or labels field, and puts it on the issue screens); labels need no admin (e.g. <span class="mono">flag:newCheckout</span>).</p>
        <form class="settings-form" data-action="save-flag-link">
            <label>Issues name flags <select name="type" data-action-change="flag-link-type">${option('none', 'Not at all')}${option('label', 'In labels with a prefix')}${option('field', 'In a field')}</select></label>
            <label>Label prefix <input name="prefix" maxlength="30" value="${flagLink && flagLink.type === 'label' ? flagLink.prefix : 'flag:'}" ${type === 'label' ? '' : raw('disabled')}></label>
            <label>Field ${fieldSelect}</label>
            <button type="submit" class="btn">Save</button>
        </form>`;
}

/** How the tenant's Jira issues name their release line R1…Rn (the Release plan tab): labels with a prefix (default
 *  release:), a fixVersion, a text or select field, or not at all. */
function ReleaseLinkForm(releaseLink, fields){
    const link = releaseLink || { type: 'none' };
    const option = (value, label) => html`<option value="${value}" ${value === link.type ? raw('selected') : ''}>${label}</option>`;
    const usable = Array.isArray(fields) ? fields.filter((f) => f.type !== 'labels') : fields;
    let fieldSelect = html`<select name="id" ${link.type === 'field' ? '' : raw('disabled')}><option value="">Loading fields…</option></select>`;
    if (usable && usable.error) {
        fieldSelect = html`<span class="settings-error">${usable.error}</span>`;
    } else if (Array.isArray(usable)) {
        fieldSelect = usable.length
            ? html`<select name="id" ${link.type === 'field' ? '' : raw('disabled')}>${usable.map((f) => html`<option value="${f.id}" ${link.type === 'field' && f.id === link.id ? raw('selected') : ''}>${f.name} (${f.type})</option>`)}</select>`
            : html`<span class="settings-hint">No text or select field yet.</span>`;
    }
    const prefixed = link.type === 'label' || link.type === 'fixVersion';
    return html`<h3>Release lines in Jira</h3>
        <p class="settings-hint">Which release line each issue belongs to: R1 is the MVP, then R2, R3… The Release plan tab shows each line with its
        issues' status on PROD. By default a label: <span class="mono">release:R1</span>. A fixVersion named <span class="mono">R1</span> works too,
        though fixVersions usually name deploy versions.</p>
        <form class="settings-form" data-action="save-release-link">
            <label>Issues name their line <select name="type" data-action-change="release-link-type">${option('label', 'In labels with a prefix')}${option('fixVersion', 'In a fixVersion')}${option('field', 'In a field')}${option('none', 'Not at all')}</select></label>
            <label>Prefix <input name="prefix" maxlength="30" value="${prefixed ? link.prefix : 'release:'}" ${prefixed ? '' : raw('disabled')}></label>
            <label>Field ${fieldSelect}</label>
            <button type="submit" class="btn">Save</button>
        </form>`;
}

/** @param {{ enabled: boolean, webhooks: boolean, jira: object|null, boards: object[]|null|{ error: string }, admin: boolean, flagFields?: object[]|null|{ error: string } }} props */
function renderJira({ enabled, webhooks, jira, boards, admin, flagFields = null, pdi = false }){
    const section = (body) => Page({ id: 'jira', title: 'Jira', hint: 'Read-only access through Atlassian: issues, boards and sprints of the boards you choose.', body: Card({ body }) });
    if (!enabled) {
        return section(html`<p class="settings-hint">Jira is not configured on this server (ATLASSIAN_* variables and TOKEN_ENCRYPTION_KEY).</p>`);
    }
    if (!jira) {
        return section(html`<p class="settings-loading">Loading…</p>`);
    }
    const connect = html`<a class="btn btn-primary" href="${tenantPath('/jira/connect')}">${jira.connected ? 'Reconnect Jira' : 'Connect Jira'}</a>`;
    if (!jira.connected) {
        return section(admin ? html`<p>${connect}</p>` : html`<p class="settings-hint">Jira is not connected; an admin can connect it.</p>`);
    }
    const status = html`<p>${jira.site ? html`Connected to <strong>${jira.site.name}</strong> <span class="settings-row-meta">${jira.site.url}</span>` : 'Connected — choose a site.'}
        ${jira.lastError ? html` <span class="state-tag fail">${jira.lastError}</span>` : ''}
        ${jira.rateLimitedUntil ? html` <span class="state-tag warn">sync paused by Atlassian's rate limit until ${fmtDateTime(jira.rateLimitedUntil)}</span>` : ''}</p>${jira.site ? webhookLine(webhooks, jira.webhook) : ''}`;
    if (!admin) {
        return section(status);
    }
    const site = !jira.site && jira.sites ? html`<form class="settings-form" data-action="choose-site">
        <label>Jira site <select name="cloudId">${jira.sites.map((s) => html`<option value="${s.cloudId}">${s.name} — ${s.url}</option>`)}</select></label>
        <button type="submit" class="btn btn-primary">Use this site</button></form>` : '';
    let boardBlock = html``;
    if (jira.site) {
        if (boards === null) {
            boardBlock = html`<p class="settings-loading">Loading boards…</p>`;
        } else if (boards.error) {
            boardBlock = html`<p class="settings-error">${boards.error}</p>`;
        } else {
            boardBlock = html`<h3>Boards</h3>
                <p class="settings-hint">Tick the boards to sync — each is one team. Saving the selection keeps the rhythm of boards that stay selected.</p>
                <table class="settings-table"><tbody>${boards.map((b) => BoardRow(b, admin))}</tbody></table>
                <form id="jiraBoardSelection" class="settings-actions" data-action="save-boards"><button type="submit" class="btn btn-primary">Save selection</button>
                <button type="button" class="btn" data-action="sync-jira">Sync now</button></form>
                ${FlagLinkForm(jira.flagLink || null, flagFields)}
                ${pdi ? ReleaseLinkForm(jira.releaseLink || null, flagFields) : ''}`;
        }
    }
    return section(html`${status}${site}${boardBlock}
        <div class="settings-actions">${connect}<button type="button" class="btn btn-danger" data-action="disconnect-jira">Disconnect</button></div>`);
}

/** True when a source's latest message was refused (nothing accepted since). */
function sourceRefused(source){
    return Boolean(source.lastError) && (!source.lastIngestAt || new Date(source.lastError.at) >= new Date(source.lastIngestAt));
}

/** A source's status: its latest message, accepted (with what it did) or refused (with why), or none yet. */
function SourceStatus(source){
    if (sourceRefused(source)) {
        return html`<span class="state-tag fail">last message refused ${fmtDateTime(source.lastError.at)}</span>
            <span class="settings-error-inline">${source.lastError.message}</span>`;
    }
    if (!source.lastIngestAt) {
        return html`<span class="state-tag warn">no message yet</span>`;
    }
    const n = source.lastIngest || { flags: 0, changed: 0, removed: 0, stale: 0 };
    return html`<span class="state-tag ok">received ${fmtDateTime(source.lastIngestAt)}</span>
        <span class="settings-row-meta">${n.flags} flag(s), ${n.changed} changed, ${n.removed} removed${n.stale ? `, ${n.stale} older than stored` : ''}${n.sender ? ` · from GitHub Actions of ${n.sender}` : ''}</span>`;
}

const FRESHNESS_LABELS = { fresh: 'confirmed', stale: 'not confirmed since', error: 'refused', unknown: 'not confirmed yet' };
const FRESHNESS_CLASS = { fresh: 'ok', stale: 'warn', error: 'fail', unknown: 'warn' };

/** Per environment, when the source last confirmed its full state (ADR-003) and how long that counts as current. */
function SourceFreshness(source){
    const envs = source.environments || [];
    const threshold = source.effectiveStaleAfterMinutes;
    const limit = threshold ? `stale after ${threshold >= 60 && threshold % 60 === 0 ? `${threshold / 60} h` : `${threshold} min`}` : 'never stale (build values change with a deployment)';
    if (!envs.length) {
        return html`<div class="settings-row-meta">No environment confirmed yet: a complete message (every flag of an environment) confirms it · ${limit}</div>`;
    }
    return html`<div class="settings-envs-state">${envs.map((e) => html`<span class="state-tag ${FRESHNESS_CLASS[e.state] || ''}" title="${e.observedAt ? `last full state ${fmtDateTime(e.observedAt)}` : 'no full state yet'}">${e.env}: ${FRESHNESS_LABELS[e.state] || e.state}${e.observedAt && e.state !== 'unknown' ? ` ${fmtDateTime(e.observedAt)}` : ''}</span>`)}
        <span class="settings-row-meta">${limit}</span></div>`;
}

/** The threshold field: minutes, empty = the kind's default. */
/**
 * A push source's GitHub Actions OIDC settings (lib/github-oidc.js): on or off, the branches/tags runs must be on, the
 * environments they may send; when on, what the workflow needs (`id-token: write`, the source reference).
 */
function OidcFields({ oidc, tenantId, sourceId, origin }){
    const envs = (oidc && oidc.environments) || ['test', 'qa', 'prod'];
    return html`<fieldset class="settings-envs"><legend>GitHub Actions without a token</legend>
        <label class="inline"><input type="checkbox" name="oidcEnabled" value="on" ${oidc ? raw('checked') : ''}> Runs of the services above may send with GitHub's OIDC token</label>
        <label>Only on (branches or tags, space separated; empty = any) <input name="oidcRefs" maxlength="2000" placeholder="refs/heads/main refs/tags/v*" value="${oidc && oidc.refs ? oidc.refs.join(' ') : ''}"></label>
        <span class="settings-row-meta">May send:</span> ${['test', 'qa', 'prod'].map((e) => html`<label class="inline"><input type="checkbox" name="oidcEnvironments" value="${e}" ${envs.includes(e) ? raw('checked') : ''}> ${e}</label>`)}
        ${oidc ? html`<p class="settings-hint">In the workflow: <code>permissions: id-token: write</code>, and the adapter with <code>oidc: true</code> and <code>source: ${tenantId}/${sourceId}</code> (no token secret). It asks GitHub for a token for ${origin}; ShipScope checks it comes from one of the services above.</p>` : ''}
    </fieldset>`;
}

/** The `oidc` field of a push source's form: null when off. */
function oidcOf(values){
    if (!(values.oidcEnabled || []).length) {
        return null;
    }
    const refs = String(values.oidcRefs || '').split(/[\s,]+/).filter(Boolean);
    const environments = values.oidcEnvironments || [];
    if (!environments.length) {
        throw new Error('Pick at least one environment GitHub Actions may send.');
    }
    return { refs: refs.length ? refs : null, environments: environments.length === 3 ? null : environments };
}

function StaleAfterInput(value){
    return html`<label>Stale after (minutes) <input name="staleAfterMinutes" type="number" min="5" max="43200" placeholder="default" value="${value ?? ''}"></label>`;
}

/** A code source's reading from its form: the fields shown, over what the API set besides (key list, env names). */
function codeOf(values, current){
    const code = { ...current, file: values.file.trim() };
    for (const field of ['path', 'prefix']) {
        const value = (values[field] || '').trim();
        if (value) {
            code[field] = value;
        } else {
            delete code[field];
        }
    }
    return code;
}

/** An endpoint source's reading from its form: the addresses and fields shown, over what the API set besides (key list, ...). */
function endpointOf(values, current = {}){
    const endpoint = { ...current, urls: {} };
    for (const env of ENVS) {
        const url = (values[`url_${env}`] || '').trim();
        if (url) {
            endpoint.urls[env] = url;
        }
    }
    for (const field of ['path', 'tokenHeader']) {
        const value = (values[field] || '').trim();
        if (value) {
            endpoint[field] = value;
        } else {
            delete endpoint[field];
        }
    }
    if (!Object.keys(endpoint.urls).length) {
        throw new Error('Give the https address of at least one environment.');
    }
    return endpoint;
}

/** '' -> null (every 5 minutes), else the number of minutes. */
function pollIntervalOf(value){
    return value === '' || value === undefined ? null : Number(value);
}

/** Which "read flags from code" form a button is in: the Sources page's or a repository's card on GitHub. */
function placeOf(el){
    return (el.form && el.form.dataset && el.form.dataset.place) || 'sources';
}

/** The draft fields of the "Read flags from code" form. */
function draftOf(values){
    return { name: values.name || '', repoId: Number(values.repoId), file: values.file || '', path: values.path || '', prefix: values.prefix || '' };
}

/** What a proposed file brought besides the form's fields (its environment names), while the form still names it. */
function wizardExtras(values){
    const draft = settingsState.codeWizard.draft || {};
    return draft.envNames && draft.file === values.file.trim() ? { envNames: draft.envNames } : {};
}

/** '' -> null (the kind's default), else the number of minutes. */
function staleAfterOf(value){
    return value === '' || value === undefined ? null : Number(value);
}

// A token is flagged this many days before it expires (Settings and the checklist), so its sender can be given a new one.
const TOKEN_WARNING_DAYS = 30;
const TOKEN_LIFETIMES = [['365', '1 year'], ['90', '90 days'], ['30', '30 days'], ['never', 'never expires']];

/** 'expired', 'expiring' (within TOKEN_WARNING_DAYS) or 'ok' (also: no expiry). */
function tokenState(token, now = new Date()){
    if (!token.expiresAt) {
        return 'ok';
    }
    const left = new Date(token.expiresAt).getTime() - now.getTime();
    return left <= 0 ? 'expired' : left <= TOKEN_WARNING_DAYS * 86_400_000 ? 'expiring' : 'ok';
}

/** The tokens a source can still send with. */
function activeTokens(source, now = new Date()){
    return source.tokens.filter((t) => tokenState(t, now) !== 'expired');
}

/** A token: when made and last used, when it expires (flagged when soon or past) and which environments it may send. */
function TokenLine(token, now){
    const state = tokenState(token, now);
    const expiry = !token.expiresAt ? 'never expires'
        : state === 'expired' ? html`<span class="state-tag fail">expired ${fmtDateTime(token.expiresAt)}</span>`
            : state === 'expiring' ? html`<span class="state-tag warn">expires ${fmtDateTime(token.expiresAt)}</span>` : `expires ${fmtDateTime(token.expiresAt)}`;
    return html`<span class="settings-token">created ${fmtDateTime(token.createdAt)}, last used ${fmtDateTime(token.lastUsedAt)}, ${expiry}${token.environments ? `, only ${token.environments.join(', ')}` : ''}
            <button type="button" class="btn-link btn" data-action="revoke-token" data-token-id="${token.id}">revoke</button></span>`;
}

/** Lifetime of a new token: a year unless the admin picks another, or none. */
function LifetimeSelect(name){
    return html`<label>Token expires <select name="${name}">${TOKEN_LIFETIMES.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select></label>`;
}

/** The form under each source that issues a new token: lifetime and the environments it may send. */
function NewTokenForm(source){
    return html`<form class="settings-form" data-action="new-token" data-source-id="${source.id}">
            ${LifetimeSelect('expiresInDays')}
            <fieldset class="settings-envs"><legend>May send</legend>${ENVS.map((env) => html`<label class="inline"><input type="checkbox" name="environments" value="${env}" checked> ${env}</label>`)}</fieldset>
            <button type="submit" class="btn">New token</button>
        </form>`;
}

/** @param {{ flags: object[]|null|{ error: string }, repos: object[], admin: boolean, once: object, origin: string, now?: Date }} props */
/**
 * The fields of a source read from code: the repository (a choice, or fixed on a repository's own card), the file, the
 * object with the flags and the key prefix.
 */
function CodeSourceFields({ repos, code = {}, repoId, fixedRepo = false }){
    const repoField = fixedRepo
        ? html`<input type="hidden" name="repoId" value="${repoId}">`
        : html`<label>Repository <select name="repoId" required>${repos.map((r) => html`<option value="${r.repoId}" ${repoId === r.repoId ? raw('selected') : ''}>${r.fullName}</option>`)}</select></label>`;
    return html`${repoField}
            <label>File <input name="file" required maxlength="200" placeholder="config/flags.{env}.json" value="${code.file || ''}"></label>
            <label>Object with the flags (optional) <input name="path" maxlength="100" placeholder="features" value="${code.path || ''}"></label>
            <label>Key prefix (needed for .env/.properties) <input name="prefix" maxlength="100" placeholder="FF_" value="${code.prefix || ''}"></label>`;
}

/** The buttons of the "read flags from code" form: find the files, preview a reading, add the source. */
const CODE_SOURCE_BUTTONS = raw('<button type="button" class="btn" data-action="find-flag-files">Find flags files</button>'
    + ' <button type="button" class="btn" data-action="preview-code-source">Preview</button>'
    + ' <button type="submit" class="btn btn-primary">Read from code</button>');

/**
 * A repository's flags, on its card in GitHub: the sources read from its code with each environment's state, the
 * sources that send flags for it, or the way to set one up here (find, preview, add) when there is none.
 */
function RepoFlagsCard({ r, sources, wizard }){
    if (sources && sources.error) {
        return html`<p class="settings-error">${sources.error}</p>`;
    }
    if (!Array.isArray(sources)) {
        return html`<p class="settings-loading">Loading flag sources…</p>`;
    }
    const covering = sources.filter((s) => (s.repoIds || []).includes(r.repoId));
    const fromCode = covering.filter((s) => s.origin === 'code');
    const pushed = covering.filter((s) => s.origin !== 'code' && s.origin !== 'endpoint');
    const polled = covering.filter((s) => s.origin === 'endpoint');
    const sent = html`${pushed.length ? html`<p class="settings-row-meta">Sent by ${pushed.map((s) => s.name).join(', ')} (Sources).</p>` : ''}${polled.length
        ? html`<p class="settings-row-meta">Read from the endpoint of ${polled.map((s) => s.name).join(', ')} (Sources).</p>` : ''}`;
    if (fromCode.length) {
        return html`<div class="settings-repo-flags"><strong>Feature flags</strong>
            ${fromCode.map((s) => html`<p class="settings-row-meta">${s.name}: ShipScope reads <code>${s.code.file}</code> at each deployment (edit it under <a href="#sources">Sources</a>).</p>${SourceFreshness(s)}`)}
            ${sent}</div>`;
    }
    if (r.flagStance === 'none') {
        return html`<div class="settings-repo-flags"><strong>Feature flags</strong>
            <p class="settings-row-meta">Declared without feature flags: deployed code is live code. Change it with Feature flags above.</p>${sent}</div>`;
    }
    const mine = wizard.place === 'github' && wizard.draft.repoId === r.repoId;
    const name = r.fullName.split('/').pop();
    return html`<div class="settings-repo-flags"><strong>Feature flags</strong>
        <p class="settings-hint">${pushed.length || polled.length ? 'Its runtime flags come from a source. ' : ''}Kept in a file in this repository? ShipScope can read it at every deployment.</p>
        <form class="settings-form" data-action="create-code-source" data-place="github" data-section="github">
            <label>Name <input name="name" required maxlength="100" value="${mine && wizard.draft.name ? wizard.draft.name : `${name} flags`}"></label>
            ${CodeSourceFields({ repos: [], code: mine ? wizard.draft : {}, repoId: r.repoId, fixedRepo: true })}
            ${CODE_SOURCE_BUTTONS}
        </form>
        ${mine ? CodeWizard(wizard) : ''}${sent}</div>`;
}

/** One flag state as a short word: on, off, or the rollout. */
function stateWord(v){
    return v.state === 'partial' ? (v.rollout !== undefined && v.rollout !== null ? `${v.rollout}%` : 'partial') : v.state;
}

/** Up to six flags and their states, then how many more. */
function FlagStates(flags){
    const entries = Object.entries(flags || {});
    const shown = entries.slice(0, 6).map(([key, v]) => `${key} ${stateWord(v)}`).join(', ');
    return html`${entries.length} flag(s)${entries.length ? html`: <span class="mono">${shown}</span>${entries.length > 6 ? ` and ${entries.length - 6} more` : ''}` : ''}`;
}

/** The files ShipScope proposes, each with how it reads, and the preview of the reading in the form. */
function CodeWizard(wizard){
    const found = wizard.found;
    const list = found ? html`<div class="settings-wizard">
        <p class="settings-row-meta">Looked at ${found.ref === 'HEAD' ? 'the default branch' : `the deployed commit ${found.ref.slice(0, 12)}`}${found.truncated ? ' (a very large repository: not every file was listed)' : ''}.</p>
        ${found.candidates.length ? html`<ul class="settings-list">${found.candidates.map((c, i) => html`<li>
            <code>${c.file}</code>${c.path ? html` · flags under <code>${c.path}</code>` : ''}
            ${c.error ? html`<span class="settings-error-inline">${c.error}</span>` : html`<span class="settings-row-meta">${FlagStates(c.flags)}</span>
            <button type="button" class="btn" data-action="use-flag-file" data-index="${i}">Use this</button>`}
        </li>`)}</ul>` : html`<p class="settings-hint">No file named like flags (flags.json, feature-flags.yaml, featureFlags.ts, ...). Name the file yourself.</p>`}
    </div>` : '';
    const preview = wizard.preview ? html`<div class="settings-wizard"><strong>Preview</strong><ul class="settings-list">${wizard.preview.map((e) => html`<li>
            <span class="state-tag ${e.error ? 'fail' : 'ok'}">${e.env}</span> <code>${e.file}</code>
            <span class="settings-row-meta">at ${e.ref === 'HEAD' ? 'the default branch' : e.ref.slice(0, 12)}</span>
            ${e.error ? html`<span class="settings-error-inline">${e.error}</span>` : html`<span class="settings-row-meta">${FlagStates(e.flags)}</span>`}
        </li>`)}</ul></div>` : '';
    return html`${list}${preview}`;
}

/**
 * The fields of a source ShipScope polls: an https address per environment, the object with the flags, where the token
 * goes, the read-only token (never shown back: empty keeps the stored one) and how often it is read.
 */
function EndpointSourceFields({ endpoint = {}, hasToken = false, pollIntervalMinutes = null }){
    const urls = endpoint.urls || {};
    return html`${ENVS.map((env) => html`<label>${env} address <input name="url_${env}" type="url" maxlength="500" placeholder="https://flags.example.com/api/flags?env=${env}" value="${urls[env] || ''}"></label>`)}
            <label>Object with the flags (optional) <input name="path" maxlength="100" placeholder="features" value="${endpoint.path || ''}"></label>
            <label>Token header (optional) <input name="tokenHeader" maxlength="64" placeholder="Authorization: Bearer" value="${endpoint.tokenHeader || ''}"></label>
            <label>Read-only token ${hasToken ? '(stored encrypted; empty keeps it)' : '(optional)'} <input name="endpointToken" type="password" autocomplete="off" maxlength="4096" value=""></label>
            ${hasToken ? html`<label class="inline"><input type="checkbox" name="clearToken" value="1"> remove the stored token</label>` : ''}
            <label>Read every (minutes) <input name="pollIntervalMinutes" type="number" min="2" max="1440" placeholder="5" value="${pollIntervalMinutes ?? ''}"></label>`;
}

/** The buttons of an endpoint form: read it now without saving, then save. */
function EndpointButtons(submitLabel){
    return html`<button type="button" class="btn" data-action="test-endpoint-source">Test</button> <button type="submit" class="btn${submitLabel === 'Save' ? '' : ' btn-primary'}">${submitLabel}</button>`;
}

// How Settings waits for a test the worker runs: every 1.5 s, for up to a minute.
const ENDPOINT_TEST_WAIT_MS = 1500;
const ENDPOINT_TEST_WAITS = 40;

/** What "Test" read: per environment its host and flags, or why not (never the answer itself). */
function EndpointTest(envs){
    return html`<div class="settings-wizard"><strong>Test</strong><ul class="settings-list">${envs.map((e) => html`<li>
            <span class="state-tag ${e.error ? 'fail' : 'ok'}">${e.env}</span> <code>${e.host}</code>
            ${e.error ? html`<span class="settings-error-inline">${e.error}</span>` : html`<span class="settings-row-meta">${FlagStates(e.flags)}</span>`}
        </li>`)}</ul></div>`;
}

/** When an endpoint source was read and will be next, and whether it is backing off. */
function EndpointSchedule(s){
    const every = s.effectivePollIntervalMinutes || 5;
    const backoff = s.pollFailures ? html` · <span class="state-tag warn">${s.pollFailures} failed read(s) in a row: waiting longer</span>` : '';
    return html`<p class="settings-row-meta">Read from its endpoint every ${every} min (and when someone opens the dashboard): last ${fmtDateTime(s.lastPolledAt)}, next ${s.nextPollAt ? fmtDateTime(s.nextPollAt) : 'within a minute'} · token ${s.hasEndpointToken ? 'stored encrypted' : 'none'}${backoff}</p>`;
}

/** What each audit event says after the actor's login (lib/audit-log.js AUDIT_EVENT_KINDS); the subject follows. */
const AUDIT_EVENT_LABELS = {
    signing_secret_viewed: 'showed the signing secret', signing_secret_rotated: 'replaced the signing secret',
    endpoint_token_set: 'set the endpoint token of', endpoint_token_removed: 'removed the endpoint token of',
    jira_connected: 'connected Jira', jira_disconnected: 'disconnected Jira',
    workspace_created: 'created the workspace', retention_changed: 'set deployment history to', insights_changed: 'turned Insights',
    invitation_created: 'created an invitation as', invitation_revoked: 'revoked an invitation as',
    member_joined: 'joined as', member_removed: 'removed the member', member_left: 'left the workspace',
    github_linked: 'connected the GitHub account', github_unlinked: 'disconnected the GitHub account',
    repo_tracked: 'started tracking', repo_untracked: 'stopped tracking', repo_settings_changed: 'changed version and drift settings of',
    repo_environments_changed: 'changed the environments of', repo_flag_stance_changed: 'changed whether flags are used in',
    repo_role_changed: 'changed the role of',
    flag_source_created: 'added the flag source', flag_source_updated: 'changed the flag source', flag_source_deleted: 'deleted the flag source',
    ingest_token_created: 'created a token for', ingest_token_revoked: 'revoked a token of',
    flag_details_changed: 'edited the flag', flag_link_accepted: 'linked the suggested issue', flag_link_dismissed: 'dismissed the suggested issue',
    jira_site_selected: 'chose the Jira site', jira_flag_link_changed: 'set how Jira names flags:', jira_release_link_changed: 'set how Jira names release lines:', event_subscription_added: 'subscribed an address to events:', event_subscription_removed: 'removed the event subscription of', service_token_created: 'created the service token', service_token_revoked: 'revoked the service token', pdi_connected: 'connected pdi at', pdi_disconnected: 'disconnected pdi at', jira_boards_changed: 'chose the Jira boards',
    jira_board_changed: 'changed the increments of the board',
};

/** One audit event as a list row: when, who, what (never a secret). */
function AuditEventRow(e){
    return html`<li><span class="settings-row-meta">${fmtDateTime(e.at)}</span> ${e.actor || 'someone no longer here'} ${AUDIT_EVENT_LABELS[e.kind] || e.kind}${e.subject ? html` <strong>${e.subject}</strong>` : ''}</li>`;
}

/** The workspace's audit log (Settings → General, admins): who changed which setting, and when. */
function AuditEvents(events){
    if (!Array.isArray(events)) {
        return events && events.error ? Card({ title: 'Settings activity', body: html`<p class="settings-error">${events.error}</p>` }) : '';
    }
    return Card({
        title: 'Settings activity',
        body: events.length
            ? html`<p class="settings-hint">The latest ${events.length} changes to members, repositories, flag sources, Jira and secrets.</p><ul class="settings-list">${events.map(AuditEventRow)}</ul>`
            : html`<p class="settings-hint">Nothing yet: every change to members, repositories, flag sources, Jira or secrets is listed here.</p>`,
    });
}

/** The audit log of the workspace's secrets: when, who, what (never a secret). */
function SecretEvents(events){
    if (!Array.isArray(events)) {
        return events && events.error ? html`<p class="settings-error">${events.error}</p>` : '';
    }
    return html`<h3>Secret activity</h3>${events.length ? html`<ul class="settings-list">${events.slice(0, 20).map(AuditEventRow)}</ul>` : html`<p class="settings-hint">Nothing yet: showing or replacing a secret, setting an endpoint token or connecting Jira is listed here.</p>`}`;
}

function renderSources({ flags, repos, once, origin, now = new Date(), wizard = { draft: {}, found: null, preview: null, place: 'sources' }, endpointTest = null }){
    if (flags === null) {
        return html`<p class="settings-loading">Loading…</p>`;
    }
    if (flags.error) {
        return html`<p class="settings-error">${flags.error}</p>`;
    }
    // The services a source covers. None checked: its flags are listed, but no service's state uses them.
    const services = (selected) => html`<fieldset class="settings-envs"><legend>Applies to</legend>${repos.length
        ? repos.map((r) => html`<label class="inline"><input type="checkbox" name="repoIds" value="${r.repoId}" ${selected.includes(r.repoId) ? raw('checked') : ''}> ${r.fullName}</label>`)
        : html`<span class="settings-row-meta">no tracked repository</span>`}</fieldset>`;
    const kindOptions = (selected) => ['build', 'runtime'].map((k) => html`<option value="${k}" ${k === selected ? raw('selected') : ''}>${k}</option>`);
    const repoName = (id) => (repos.find((r) => r.repoId === id) || {}).fullName || `repository ${id}`;
    // A source read from code: one repository, a file (with {env} for one per environment), and how to read it.
    const sourcesWizard = wizard.place === 'github' ? { draft: {}, found: null, preview: null } : wizard;
    const codeFields = (s, draft = {}) => CodeSourceFields({ repos, code: s ? s.code : draft, repoId: s ? (s.repoIds || [])[0] : draft.repoId });
    const codeRow = (s) => html`<tr><td>
        <form class="settings-form" data-action="save-source" data-source-id="${s.id}" data-origin="code">
            <label>Name <input name="name" required maxlength="100" value="${s.name}"></label>
            <label>Priority <input name="priority" type="number" min="0" max="1000" required value="${s.priority}"></label>
            ${codeFields(s)}
            <button type="submit" class="btn">Save</button>
        </form>
        <p class="settings-row-meta">Read from code: ShipScope reads <code>${s.code.file}</code> in ${repoName((s.repoIds || [])[0])} at each environment's latest successful deployment. No token, no workflow.</p>
        <div class="settings-source-status">${SourceStatus(s)}</div>
        ${SourceFreshness(s)}
        </td><td class="actions"><button type="button" class="btn btn-danger" data-action="delete-source" data-source-id="${s.id}">Delete</button></td></tr>`;
    const testFor = (place) => {
        if (!endpointTest || endpointTest.place !== place) {
            return '';
        }
        return endpointTest.pending ? html`<p class="settings-loading">Testing with the stored token: the worker reads it…</p>` : EndpointTest(endpointTest.envs);
    };
    const endpointRow = (s) => html`<tr><td>
        <form class="settings-form" data-action="save-source" data-source-id="${s.id}" data-origin="endpoint">
            <label>Name <input name="name" required maxlength="100" value="${s.name}"></label>
            <label>Priority <input name="priority" type="number" min="0" max="1000" required value="${s.priority}"></label>
            ${services(s.repoIds || [])}
            ${EndpointSourceFields({ endpoint: s.endpoint || {}, hasToken: s.hasEndpointToken, pollIntervalMinutes: s.pollIntervalMinutes })}
            ${StaleAfterInput(s.staleAfterMinutes)}
            ${EndpointButtons('Save')}
        </form>
        ${testFor(s.id)}
        ${EndpointSchedule(s)}
        <div class="settings-source-status">${SourceStatus(s)}</div>
        ${SourceFreshness(s)}
        </td><td class="actions"><button type="button" class="btn btn-danger" data-action="delete-source" data-source-id="${s.id}">Delete</button></td></tr>`;
    const rows = flags.map((s) => (s.origin === 'code' ? codeRow(s) : s.origin === 'endpoint' ? endpointRow(s) : html`<tr><td>
        <form class="settings-form" data-action="save-source" data-source-id="${s.id}">
            <label>Name <input name="name" required maxlength="100" value="${s.name}"></label>
            <label>Kind <select name="kind">${kindOptions(s.kind)}</select></label>
            <label>Priority <input name="priority" type="number" min="0" max="1000" required value="${s.priority}"></label>
            ${services(s.repoIds || [])}
            ${StaleAfterInput(s.staleAfterMinutes)}
            ${OidcFields({ oidc: s.oidc, tenantId: settingsState.tenantId, sourceId: s.id, origin })}
            <button type="submit" class="btn">Save</button>
        </form>
        ${(s.repoIds || []).length ? '' : html`<p class="settings-hint">Applies to no repository: its flags are listed, but no issue status on the dashboard uses them. Tick the services it covers.</p>`}
        <div class="settings-source-status">${SourceStatus(s)}</div>
        ${SourceFreshness(s)}
        <div class="settings-row-meta">Tokens: ${s.tokens.length ? s.tokens.map((t) => TokenLine(t, now)) : s.oidc ? 'none — only GitHub Actions send' : 'none — the source can\'t send anything'}</div>
        ${NewTokenForm(s)}
        </td><td class="actions"><button type="button" class="btn btn-danger" data-action="delete-source" data-source-id="${s.id}">Delete</button></td></tr>`));
    // One recommended path (design-docs/CORE-SIMPLIFY-PLAN.pl.md, D1): reading from code or an endpoint stays folded
    // until the workspace uses it or the admin is in the middle of setting one up.
    const advancedOpen = flags.some((s) => s.origin === 'code' || s.origin === 'endpoint')
        || Boolean(sourcesWizard.found || sourcesWizard.preview) || Boolean(endpointTest && endpointTest.place === 'new');
    return html`${once.token ? SecretBox({
        label: 'Ingest token — shown only once',
        value: once.token,
        note: `The source sends POST ${origin}/api/flags/ingest with the header "Authorization: Bearer <token>".`,
    }) : ''}${once.signing ? SecretBox({
        label: 'Signing secret of this workspace',
        value: once.signing.secret,
        note: `Every request ShipScope sends your endpoint carries X-ShipScope-Timestamp (Unix seconds) and X-ShipScope-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.GET.<the full URL>">. Recompute it with this secret and refuse a mismatch or a timestamp older than 5 minutes.`,
    }) : ''}
        ${rows.length ? html`<table class="settings-table"><tbody>${rows}</tbody></table>` : html`<p class="settings-hint">No flag source yet.</p>`}
        <h3>Add a source that sends its flags</h3>
        <p class="settings-hint">The recommended way: a source gets its own token, and your pipeline sends the full state of its flags with the ShipScope flags adapter (or GitHub Actions' OIDC token, no secret to keep).</p>
        <form class="settings-form" data-action="create-source">
            <label>Name <input name="name" required maxlength="100" placeholder="e.g. LaunchDarkly"></label>
            <label>Kind <select name="kind">${kindOptions('runtime')}</select></label>
            <label>Priority (optional) <input name="priority" type="number" min="0" max="1000"></label>
            ${services([])}
            ${StaleAfterInput(null)}
            ${LifetimeSelect('tokenExpiresInDays')}
            <button type="submit" class="btn btn-primary">Add source</button>
        </form>
        <details class="settings-advanced"${advancedOpen ? raw(' open') : ''}><summary>Advanced sources</summary>
        <p class="settings-hint">ShipScope reads the flags itself: from a file in your code at each deployment, or from an endpoint your backend serves.</p>
        <h3>Read flags from code</h3>
        <p class="settings-hint">For flags kept in a file in the repository (JSON, YAML, .properties, .env, TypeScript/JavaScript): ShipScope reads it at every new deployment. Nothing to set up in your pipelines.</p>
        ${repos.length ? html`<form class="settings-form" data-action="create-code-source" data-place="sources">
            <label>Name <input name="name" required maxlength="100" placeholder="e.g. Web flags" value="${sourcesWizard.draft.name || ''}"></label>
            ${codeFields(null, sourcesWizard.draft)}
            ${CODE_SOURCE_BUTTONS}
        </form>
        ${CodeWizard(sourcesWizard)}` : html`<p class="settings-hint">Track a repository first (GitHub).</p>`}
        <h3>Read flags from an endpoint</h3>
        <p class="settings-hint">For runtime flags your backend serves: ShipScope reads an https address per environment (JSON or YAML, a map of flags), with a read-only token if it needs one. Only public https addresses on port 443; no redirects.</p>
        <form class="settings-form" data-action="create-endpoint-source">
            <label>Name <input name="name" required maxlength="100" placeholder="e.g. Flags API"></label>
            ${services([])}
            ${EndpointSourceFields({})}
            ${StaleAfterInput(null)}
            ${EndpointButtons('Read from endpoint')}
        </form>
        ${testFor('new')}
        <p class="settings-row-meta">Requests are signed so your endpoint can tell ShipScope's calls from anyone else's. <button type="button" class="btn-link btn" data-action="show-endpoint-signing">Show the signing secret</button>
            · <button type="button" class="btn-link btn" data-action="rotate-endpoint-signing">Replace it</button></p>
        </details>`;
}

const ENVS = ['test', 'qa', 'prod'];
const LINK_ORIGINS = [['sender', 'from its source'], ['jira', 'from Jira'], ['commit', 'from commits (Flag:)'], ['manual', 'set here']];

/** One flag: state per environment, description, Jira links by origin; for admins the hand-set fields. */
function FlagRow(flag, { admin, jiraUrl }){
    const stateTag = (env) => {
        const slots = flag.states[env] || {};
        const v = slots['runtime-be'] || slots.build;
        if (!v) {
            return html`<span class="state-tag">${env}: —</span>`;
        }
        const label = v.state === 'partial' && v.rollout !== null ? `partial ${v.rollout}%` : v.state;
        return html`<span class="state-tag ${v.state === 'on' ? 'ok' : v.state === 'partial' ? 'warn' : ''}" title="${v.sourceName || ''}">${env}: ${label}</span>`;
    };
    const issue = (key) => (jiraUrl ? html`<a href="${jiraUrl}/browse/${key}" target="_blank" rel="noopener">${key}</a>` : html`${key}`);
    const links = LINK_ORIGINS.filter(([origin]) => (flag.links[origin] || []).length)
        .map(([origin, label]) => html`<span>${flag.links[origin].map((k, i) => html`${i ? ', ' : ''}${issue(k)}`)} <span class="settings-row-meta">(${label})</span></span>`);
    const edit = admin ? html`<form class="settings-form" data-action="save-flag" data-key="${flag.key}">
            <label>Description (shown instead of the source's) <input name="description" maxlength="500" value="${flag.manualDescription || ''}" placeholder="${flag.senderDescription || ''}"></label>
            <label>Jira issues linked here <input name="jiraKeys" value="${flag.links.manual.join(', ')}" placeholder="e.g. ABC-12, ABC-15"></label>
            <button type="submit" class="btn">Save</button></form>` : '';
    // Issues whose commits changed this flag in its flags file: an admin links one or dismisses it.
    const suggested = (flag.suggestions || []).length ? html`<div class="settings-row-meta">Suggested (its commits changed this flag): ${flag.suggestions.map((k, i) => html`${i ? ' · ' : ''}${issue(k)}${admin
        ? html` <button type="button" class="btn-link btn" data-action="accept-link-suggestion" data-key="${flag.key}" data-jira-key="${k}">link</button>
            <button type="button" class="btn-link btn" data-action="dismiss-link-suggestion" data-key="${flag.key}" data-jira-key="${k}">dismiss</button>` : ''}`)}</div>` : '';
    return html`<tr><td><strong class="mono">${flag.key}</strong> ${ENVS.map(stateTag)}
        <div>${flag.description || html`<span class="settings-hint">No description</span>`}</div>
        <div class="settings-row-meta">Jira: ${links.length ? links.map((l, i) => html`${i ? ' · ' : ''}${l}`) : 'not linked'}</div>
        ${suggested}
        ${edit}</td></tr>`;
}

/** @param {{ flagList: object[]|null|{ error: string }, admin: boolean, jiraUrl?: string|null }} props */
function renderFlags({ flagList, admin, jiraUrl = null }){
    let list = html`<p class="settings-loading">Loading…</p>`;
    if (flagList && flagList.error) {
        list = html`<p class="settings-error">${flagList.error}</p>`;
    } else if (Array.isArray(flagList)) {
        list = flagList.length
            ? html`<table class="settings-table"><tbody>${flagList.map((f) => FlagRow(f, { admin, jiraUrl }))}</tbody></table>`
            : html`<p class="settings-hint">No flags yet: a flag shows up once a source sends it.</p>`;
    }
    return Page({
        id: 'flags',
        title: 'Flags',
        hint: 'Each flag can be linked to Jira issues three ways, all shown on the dashboard: by its source, by your Jira issues themselves (see Jira → Feature flags in Jira), or here by hand.',
        body: Card({ cls: Array.isArray(flagList) && flagList.length ? 'flush' : '', body: list }),
    });
}

/** @param {{ sources: object[]|null|{ error: string }, repos: object[], admin: boolean, once: object, origin: string }} props */
function renderSourcesPage({ sources, repos, admin, once, origin, wizard, endpointTest = null, secretEvents = null }){
    return Page({
        id: 'sources',
        section: 'flags',
        title: 'Sources',
        hint: 'Where flags come from: a file in your code that ShipScope reads at each deployment, or a source (a flag service, a backend, a build step) that sends their full state to the ingest URL with its own token.',
        body: Card({ body: admin ? html`${renderSources({ flags: sources, repos, once, origin, wizard, endpointTest })}${SecretEvents(secretEvents)}` : html`<p class="settings-hint">Only admins manage flag sources.</p>` }),
    });
}

/** The page the hash names, and the sidebar beside it. */
function renderSettings(){
    const s = settingsState;
    const admin = isAdmin();
    const steps = admin ? onboardingSteps({ features: s.features, github: s.github, jira: s.jira, boards: s.boards, sources: s.flags, flagList: s.flagList, workspace: s.workspace }) : [];
    const hidden = admin && checklistHidden();
    const setupDone = steps.filter((st) => !st.optional && st.state !== 'unavailable').every((st) => st.state === 'done' || st.state === 'loading');
    const page = pageFromHash({ hash: typeof location !== 'undefined' ? location.hash : '', admin, setupDone });
    const repos = (s.github && s.github.repos) || [];
    // The pdi layer's settings show once the workspace is connected with pdi (design-docs/PDI-GATE-PLAN.pl.md).
    const pdi = Boolean(s.pdiConnection && ['connected', 'degraded'].includes(s.pdiConnection.state));
    const pages = {
        'getting-started': () => renderGettingStarted({ steps }),
        general: () => renderGeneral({ workspace: s.workspace, admin, auditEvents: s.auditEvents, eventSubscriptions: s.eventSubscriptions, serviceTokens: s.serviceTokens, once: s.once, pdi }),
        members: () => renderMembers({ workspace: s.workspace, admin, meId: s.me && s.me.user.id, once: s.once }),
        github: () => renderGitHub({ enabled: s.features.githubApp, webhooks: s.features.githubWebhooks, github: s.github, installationRepos: s.installationRepos, admin, picker: s.trackPicker, editing: s.editingRepo, sources: s.flags, wizard: s.codeWizard, pdi }),
        jira: () => renderJira({ enabled: s.features.jira, webhooks: s.features.jiraWebhooks, jira: s.jira, boards: s.boards, admin, flagFields: s.flagFields, pdi }),
        flags: () => renderFlags({ flagList: s.flagList, admin, jiraUrl: s.jira && s.jira.site ? s.jira.site.url : null }),
        sources: () => renderSourcesPage({ sources: s.flags, repos, admin, once: s.once, origin: location.origin, wizard: s.codeWizard, endpointTest: s.endpointTest, secretEvents: s.secretEvents }),
        pdi: () => renderPdi({ connection: s.pdiConnection, admin, once: s.once }),
        danger: () => renderDangerZone({ tenantName: s.tenant && s.tenant.name }),
    };
    const counts = {
        members: s.workspace ? s.workspace.members.length : undefined,
        github: s.github ? repos.length : undefined,
        jira: Array.isArray(s.boards) ? s.boards.filter((b) => b.selected).length : undefined,
        flags: Array.isArray(s.flagList) ? s.flagList.length : undefined,
        sources: Array.isArray(s.flags) ? s.flags.length : undefined,
    };
    return {
        page: pages[page](),
        sidebar: renderSidebar({ page, tenant: s.tenant, admin, counts, steps, hidden }),
    };
}

function rerender(){
    const root = document.getElementById('settingsRoot');
    const side = document.getElementById('settingsSidebar');
    if (root && side) {
        const { page, sidebar } = renderSettings();
        root.innerHTML = page;
        side.innerHTML = sidebar;
    }
}

// ---- Loading ---------------------------------------------------------------------------------------------

const loaders = {
    async workspace(){
        const [settings, { members }, invitations, eventSubscriptions, serviceTokens] = await Promise.all([
            api('GET', tenantPath('/settings')),
            api('GET', tenantPath('/members')),
            isAdmin() ? api('GET', tenantPath('/invitations')).then((r) => r.invitations) : Promise.resolve(null),
            // Outgoing events (G1.5), on General with the other workspace settings.
            isAdmin() ? api('GET', tenantPath('/event-subscriptions')).then((r) => r.subscriptions, (err) => ({ error: err.message })) : Promise.resolve(null),
            // Service tokens (F5), also on General.
            isAdmin() ? api('GET', tenantPath('/service-tokens')).then((r) => r.tokens, (err) => ({ error: err.message })) : Promise.resolve(null),
        ]);
        settingsState.workspace = { settings, members, invitations };
        settingsState.eventSubscriptions = eventSubscriptions;
        settingsState.serviceTokens = serviceTokens;
    },
    async github(){
        if (settingsState.features.githubApp) {
            settingsState.github = await api('GET', tenantPath('/github'));
        }
    },
    async jira(){
        if (!settingsState.features.jira) {
            return;
        }
        settingsState.jira = await api('GET', tenantPath('/jira'));
        settingsState.boards = null;
        if (isAdmin() && settingsState.jira.connected && settingsState.jira.site) {
            rerender();
            [settingsState.boards, settingsState.flagFields] = await Promise.all([
                api('GET', tenantPath('/jira/boards')).then((r) => r.boards, (err) => ({ error: err.message })),
                api('GET', tenantPath('/jira/flag-fields')).then((r) => r.fields, (err) => ({ error: err.message })),
            ]);
        }
    },
    async flags(){
        const [list, sources, events] = await Promise.all([
            api('GET', tenantPath('/flags')).then((r) => r.flags, (err) => ({ error: err.message })),
            isAdmin() ? api('GET', tenantPath('/flag-sources')).then((r) => r.sources, (err) => ({ error: err.message })) : Promise.resolve(null),
            isAdmin() ? api('GET', tenantPath('/secret-events')).then((r) => r.events, (err) => ({ error: err.message })) : Promise.resolve(null),
        ]);
        settingsState.flagList = list;
        settingsState.flags = sources;
        settingsState.secretEvents = events;
    },
    async pdi(){
        settingsState.pdiConnection = await api('GET', tenantPath('/pdi-connection')).then((r) => r.connection, (err) => ({ error: err.message }));
    },
    async activity(){
        settingsState.auditEvents = isAdmin()
            ? await api('GET', tenantPath('/audit-events')).then((r) => r.events, (err) => ({ error: err.message }))
            : null;
    },

};

/** Reloads sections (all by default), each failing on its own: one broken section never blanks the others. */
async function load(...sections){
    const names = sections.length ? sections : Object.keys(loaders);
    await Promise.all(names.map((name) => loaders[name]().catch((err) => {
        settingsState.messages[name] = { error: true, text: err.message };
    })));
    rerender();
}

// ---- Actions ---------------------------------------------------------------------------------------------

/** A form's named fields as strings (checkbox groups as arrays of the checked values). */
function formValues(form){
    const values = {};
    for (const el of Array.from(form.elements)) {
        if (!el.name) {
            continue;
        }
        if (el.type === 'checkbox') {
            values[el.name] = values[el.name] || [];
            if (el.checked) {
                values[el.name].push(el.value);
            }
        } else {
            values[el.name] = el.value;
        }
    }
    return values;
}

/** A lifetime select's value as the API takes it: days, or null for "never". */
function lifetimeOf(value){
    return value === 'never' ? null : Number(value || 365);
}

const confirmed = (text) => typeof confirm !== 'function' || confirm(text);

/** Each action: (element, its data-* values) -> the section to report on and reload, after doing the change. */
const actions = {
    'dismiss-once': async () => {
        settingsState.once = {};
        return { section: null };
    },
    'hide-checklist': async () => {
        setChecklistHidden(true);
        // Arriving via #getting-started (the dashboard's banner) would otherwise bring it straight back on reload.
        if (typeof location !== 'undefined' && location.hash === '#getting-started' && typeof history !== 'undefined') {
            history.replaceState(null, '', location.pathname + location.search);
        }
        return { section: null };
    },
    'save-insights': async (form) => {
        await api('PUT', tenantPath('/settings'), { insightsEnabled: formValues(form).insightsEnabled.length > 0 });
        return { section: 'workspace', ok: 'Saved.' };
    },
    'save-retention': async (form) => {
        await api('PUT', tenantPath('/settings'), { deploymentRetentionDays: Number(formValues(form).deploymentRetentionDays) });
        return { section: 'workspace', ok: 'Saved.' };
    },
    'delete-workspace': async (form) => {
        const confirmName = formValues(form).confirmName.trim();
        if (!confirmed(`Delete the workspace "${confirmName}" and all its data? This cannot be undone.`)) {
            return null;
        }
        await api('DELETE', tenantPath(''), { confirmName });
        location.assign('/');
        return null;
    },
    'add-event-subscription': async (form) => {
        const values = formValues(form);
        await api('POST', tenantPath('/event-subscriptions'), { url: values.url.trim(), types: values.types || [] });
        return { section: 'workspace', ok: 'Subscribed; release events go to it from now on (the first look only records the current state).' };
    },
    'connect-pdi': async (form) => {
        const values = formValues(form);
        const { env } = await api('POST', tenantPath('/pdi-connection'), { receiverUrl: values.receiverUrl.trim() });
        settingsState.once = { pdiEnv: env };
        return { section: 'pdi', ok: 'Connection created. Put the variables in pdi, then use Test.' };
    },
    'test-pdi': async () => {
        settingsState.pdiConnection = (await api('POST', tenantPath('/pdi-connection/test'))).connection;
        const reach = settingsState.pdiConnection.checks.find((c) => c.id === 'reaches_pdi');
        return reach && reach.ok ? { section: 'pdi', ok: 'pdi answered.' } : { section: 'pdi', error: true, ok: (reach && reach.error) || 'pdi did not answer.' };
    },
    'disconnect-pdi': async () => {
        if (!confirmed('Disconnect pdi? Its token stops working and release events stop at once.')) {
            return null;
        }
        await api('DELETE', tenantPath('/pdi-connection'));
        return { section: 'pdi', ok: 'Disconnected.' };
    },
    'create-service-token': async (form) => {
        const values = formValues(form);
        const days = String(values.lifetimeDays || '').trim();
        const { token } = await api('POST', tenantPath('/service-tokens'), { name: values.name.trim(), lifetimeDays: days ? Number(days) : null });
        settingsState.once = { serviceToken: token.token };
        return { section: 'workspace' };
    },
    'revoke-service-token': async (el, data) => {
        if (!confirmed('Revoke this token? A service using it loses access at once.')) {
            return null;
        }
        await api('DELETE', tenantPath(`/service-tokens/${data.tokenId}`));
        return { section: 'workspace', ok: 'Token revoked.' };
    },
    'remove-event-subscription': async (el, data) => {
        if (!confirmed('Stop sending events to this address? What is still waiting for it is dropped.')) {
            return null;
        }
        await api('DELETE', tenantPath(`/event-subscriptions/${data.subscriptionId}`));
        return { section: 'workspace', ok: 'Removed.' };
    },
    'remove-member': async (el, data) => {
        if (!confirmed(data.self ? 'Leave this workspace?' : 'Remove this member from the workspace?')) {
            return null;
        }
        await api('DELETE', tenantPath(`/members/${data.userId}`));
        if (data.self) {
            location.assign('/');
            return null;
        }
        return { section: 'workspace', ok: 'Member removed.' };
    },
    'create-invitation': async (form) => {
        const { url } = await api('POST', tenantPath('/invitations'), { role: formValues(form).role });
        settingsState.once = { inviteUrl: url };
        return { section: 'workspace' };
    },
    'revoke-invitation': async (el, data) => {
        await api('DELETE', tenantPath(`/invitations/${data.invitationId}`));
        return { section: 'workspace', ok: 'Invitation revoked.' };
    },
    'open-track-picker': async () => {
        settingsState.trackPicker = true;
        const ids = settingsState.github ? settingsState.github.installations.map((i) => i.installationId) : [];
        ids.forEach((id) => { settingsState.installationRepos[id] = 'loading'; });
        rerender();
        await Promise.all(ids.map(async (id) => {
            settingsState.installationRepos[id] = await api('GET', tenantPath(`/github/installations/${id}/repositories`))
                .then((r) => r.repositories, (err) => ({ error: err.message }));
        }));
        return { section: null };
    },
    'close-track-picker': async () => {
        settingsState.trackPicker = false;
        return { section: null };
    },
    'edit-repo': async (el, data) => {
        const id = Number(data.repoId);
        settingsState.editingRepo = settingsState.editingRepo === id ? null : id;
        return { section: null };
    },
    'track-repo': async (el, data) => {
        await api('PUT', tenantPath(`/github/repos/${data.repoId}`), { installationId: Number(data.installationId) });
        markTracked(data.installationId, data.repoId, true);
        return { section: 'github', ok: 'Repository tracked; its deployments arrive with the next sync (within 15 minutes).' };
    },
    'untrack-repo': async (el, data) => {
        if (!confirmed('Stop tracking this repository? Its deployments are removed from ShipScope.')) {
            return null;
        }
        await api('DELETE', tenantPath(`/github/repos/${data.repoId}`));
        markTracked(data.installationId, data.repoId, false);
        return { section: 'github', ok: 'Repository no longer tracked.' };
    },
    'unlink-installation': async (el, data) => {
        if (!confirmed('Unlink this installation and stop tracking its repositories? The App stays installed on GitHub.')) {
            return null;
        }
        await api('DELETE', tenantPath(`/github/installations/${data.installationId}`));
        delete settingsState.installationRepos[data.installationId];
        return { section: 'github', ok: 'Installation unlinked.' };
    },
    'save-repo-settings': async (form, data) => {
        const values = formValues(form);
        await api('PUT', tenantPath(`/github/repos/${data.repoId}/settings`), {
            versionFile: values.versionFile.trim() || null,
            driftIgnorePaths: [...new Set(values.driftIgnorePaths.split('\n').map((p) => p.trim()).filter(Boolean))],
        });
        if (values.flagStance && values.flagStance !== data.flagStance) {
            await api('PUT', tenantPath(`/github/repos/${data.repoId}/flag-stance`), { flagStance: values.flagStance });
        }
        if (values.serviceRole !== undefined && values.serviceRole !== (data.serviceRole || '')) {
            await api('PUT', tenantPath(`/github/repos/${data.repoId}/role`), { serviceRole: values.serviceRole || null });
        }
        const envMap = envMapOf(values);
        if (values.envName0 !== undefined && JSON.stringify(envMap) !== (data.envMap || '{}')) {
            await api('PUT', tenantPath(`/github/repos/${data.repoId}/environments`), { envMap });
        }
        settingsState.editingRepo = null;
        return { section: 'github', ok: 'Saved; drift is recomputed with the next sync.' };
    },
    'choose-site': async (form) => {
        await api('PUT', tenantPath('/jira/site'), { cloudId: formValues(form).cloudId });
        return { section: 'jira', ok: 'Site chosen; now pick the boards to sync.' };
    },
    'save-boards': async (form) => {
        const boardIds = (formValues(form).boardIds || []).map(Number);
        await api('PUT', tenantPath('/jira/boards'), { boardIds });
        return { section: 'jira', ok: `${boardIds.length} board(s) selected. Use "Sync now" or wait for the next sync.` };
    },
    'save-rhythm': async (form, data) => {
        const values = formValues(form);
        const usesTemplate = values.rhythm === 'pi' || values.rhythm === 'auto';
        await api('PUT', tenantPath(`/jira/boards/${data.boardId}`), {
            rhythm: values.rhythm,
            piTemplate: usesTemplate && values.piTemplate && values.piTemplate.trim() ? values.piTemplate.trim() : null,
        });
        return { section: 'jira', ok: 'Rhythm saved; the board is synced again from scratch with the next sync.' };
    },
    'save-flag-link': async (form) => {
        const values = formValues(form);
        const body = values.type === 'label' ? { type: 'label', prefix: values.prefix.trim() }
            : values.type === 'field' ? { type: 'field', id: values.id } : { type: 'none' };
        await api('PUT', tenantPath('/jira/flag-link'), body);
        return { section: 'jira', ok: 'Saved; issues are read this way from the next sync ("Sync now" to apply it right away).' };
    },
    'save-release-link': async (form) => {
        const values = formValues(form);
        const body = values.type === 'label' ? { type: 'label', prefix: values.prefix.trim() }
            : values.type === 'fixVersion' ? { type: 'fixVersion', prefix: (values.prefix || '').trimStart() }
                : values.type === 'field' ? { type: 'field', id: values.id } : { type: 'none' };
        await api('PUT', tenantPath('/jira/release-link'), body);
        return { section: 'jira', ok: 'Saved; release lines are read this way from the next sync ("Sync now" to apply it right away).' };
    },
    'save-flag': async (form, data) => {
        const values = formValues(form);
        const jiraKeys = [...new Set(values.jiraKeys.split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter(Boolean))];
        await api('PUT', tenantPath(`/flags/${encodeURIComponent(data.key)}`), { description: values.description.trim() || null, jiraKeys });
        return { section: 'flags', ok: `Saved ${data.key}.` };
    },
    'accept-link-suggestion': async (el, data) => {
        await api('POST', tenantPath(`/flags/${encodeURIComponent(data.key)}/suggestions`), { jiraKey: data.jiraKey, accept: true });
        return { section: 'flags', ok: `Linked ${data.jiraKey} to ${data.key}.` };
    },
    'dismiss-link-suggestion': async (el, data) => {
        await api('POST', tenantPath(`/flags/${encodeURIComponent(data.key)}/suggestions`), { jiraKey: data.jiraKey, accept: false });
        return { section: 'flags', ok: `${data.jiraKey} is no longer suggested for ${data.key}.` };
    },
    'sync-jira': async () => {
        const result = await api('POST', tenantPath('/jira/sync'));
        // Links named in Jira come with the sync: the flag list shows them right away.
        await loaders.flags().catch(() => {});
        return { section: 'jira', ok: `Synced ${result.boards} board(s), ${result.issues} issue(s); now: ${result.currentPi || 'nothing current'}.` };
    },
    'disconnect-jira': async () => {
        if (!confirmed('Disconnect Jira? Its boards and synced issues are removed from ShipScope.')) {
            return null;
        }
        await api('DELETE', tenantPath('/jira'));
        return { section: 'jira', ok: 'Jira disconnected.' };
    },
    'create-source': async (form) => {
        const values = formValues(form);
        const body = {
            name: values.name.trim(), kind: values.kind, repoIds: (values.repoIds || []).map(Number), tokenExpiresInDays: lifetimeOf(values.tokenExpiresInDays),
            staleAfterMinutes: staleAfterOf(values.staleAfterMinutes),
        };
        if (values.priority !== '') {
            body.priority = Number(values.priority);
        }
        const { token } = await api('POST', tenantPath('/flag-sources'), body);
        settingsState.once = { token: token.token };
        return { section: 'flags' };
    },
    'create-code-source': async (form) => {
        const values = formValues(form);
        if (!values.name.trim() || !values.file.trim()) {
            throw new Error('Name the source and its file (or find one with Find flags files).');
        }
        await api('POST', tenantPath('/flag-sources'), {
            name: values.name.trim(), kind: 'build', origin: 'code', repoIds: [Number(values.repoId)], code: codeOf(values, wizardExtras(values)),
        });
        settingsState.codeWizard = { draft: {}, found: null, preview: null };
        if (form.dataset && form.dataset.section === 'github') {
            // Added from the repository's card: the card shows the new source, and the message stays on GitHub.
            await load('flags');
            return { section: 'github', ok: 'Added: its flags are read at the next sync.' };
        }
        return { section: 'flags', ok: 'Added: its flags are read at the next sync.' };
    },
    'create-endpoint-source': async (form) => {
        const values = formValues(form);
        const body = {
            name: values.name.trim(), kind: 'runtime', origin: 'endpoint', repoIds: (values.repoIds || []).map(Number), endpoint: endpointOf(values),
            staleAfterMinutes: staleAfterOf(values.staleAfterMinutes), pollIntervalMinutes: pollIntervalOf(values.pollIntervalMinutes),
        };
        if (values.endpointToken) {
            body.endpointToken = values.endpointToken;
        }
        await api('POST', tenantPath('/flag-sources'), body);
        settingsState.endpointTest = null;
        return { section: 'flags', ok: 'Added: ShipScope reads it within a minute.' };
    },
    'test-endpoint-source': async (el) => {
        const values = formValues(el.form);
        const sourceId = el.form.dataset && el.form.dataset.sourceId;
        const current = sourceId && (Array.isArray(settingsState.flags) ? settingsState.flags : []).find((s) => s.id === sourceId);
        const body = { endpoint: endpointOf(values, (current && current.endpoint) || {}) };
        if (values.endpointToken) {
            body.endpointToken = values.endpointToken;
        } else if (sourceId && !(values.clearToken || []).length) {
            body.sourceId = sourceId;
        }
        const place = sourceId || 'new';
        const result = await api('POST', tenantPath('/flag-endpoint-test'), body);
        if (!result.pending) {
            settingsState.endpointTest = { place, envs: result.envs };
            return {};
        }
        // A stored token only the worker can read: it runs the test within seconds; this waits for its result.
        settingsState.endpointTest = { place, pending: true };
        rerender();
        for (let i = 0; i < ENDPOINT_TEST_WAITS; i++) {
            await new Promise((resolve) => setTimeout(resolve, settingsState.endpointTestWaitMs ?? ENDPOINT_TEST_WAIT_MS));
            const answer = await api('GET', tenantPath(`/flag-endpoint-test/${result.testId}`));
            if (answer.status === 'done') {
                settingsState.endpointTest = { place, envs: answer.envs };
                return {};
            }
        }
        settingsState.endpointTest = null;
        throw new Error('The worker did not run the test within a minute: is it running, with SECRETS_PRIVATE_KEY?');
    },
    'rotate-endpoint-signing': async () => {
        if (!confirmed('Replace the signing secret? The old one stops working at once: until your endpoint has the new one, it refuses ShipScope\'s reads (the flags stay as they are).')) {
            return null;
        }
        settingsState.once = { signing: await api('POST', tenantPath('/flag-endpoint-signing/rotate')) };
        return { section: 'flags', ok: 'Signing secret replaced: put the new one in your endpoint.' };
    },
    'show-endpoint-signing': async () => {
        settingsState.once = { signing: await api('GET', tenantPath('/flag-endpoint-signing')) };
        return { section: 'flags' };
    },
    'find-flag-files': async (el) => {
        const values = formValues(el.form);
        const repoId = Number(values.repoId);
        const found = await api('GET', tenantPath(`/github/repos/${repoId}/flag-files`));
        settingsState.codeWizard = { draft: { ...draftOf(values), repoId }, found, preview: null, place: placeOf(el) };
        return {};
    },
    'use-flag-file': async (el, data) => {
        const wizard = settingsState.codeWizard;
        const candidate = wizard.found && wizard.found.candidates[Number(data.index)];
        if (!candidate) {
            return null;
        }
        wizard.draft = { ...wizard.draft, file: candidate.file, path: candidate.path || '', prefix: '', envNames: candidate.envNames };
        wizard.preview = null;
        return {};
    },
    'preview-code-source': async (el) => {
        const values = formValues(el.form);
        if (!values.file.trim()) {
            throw new Error('Name the file to preview (or find one with Find flags files).');
        }
        const { envs } = await api('POST', tenantPath(`/github/repos/${Number(values.repoId)}/flag-preview`), { code: codeOf(values, wizardExtras(values)) });
        settingsState.codeWizard = { ...settingsState.codeWizard, draft: { ...settingsState.codeWizard.draft, ...draftOf(values) }, preview: envs, place: placeOf(el) };
        return {};
    },
    'save-source': async (form, data) => {
        const values = formValues(form);
        if (data.origin === 'code') {
            const current = (Array.isArray(settingsState.flags) ? settingsState.flags : []).find((s) => s.id === data.sourceId);
            await api('PUT', tenantPath(`/flag-sources/${data.sourceId}`), {
                name: values.name.trim(), kind: 'build', priority: Number(values.priority), repoIds: [Number(values.repoId)],
                code: codeOf(values, (current && current.code) || {}),
            });
            return { section: 'flags', ok: 'Saved; the file is read again at the next sync.' };
        }
        if (data.origin === 'endpoint') {
            const current = (Array.isArray(settingsState.flags) ? settingsState.flags : []).find((s) => s.id === data.sourceId);
            const body = {
                name: values.name.trim(), kind: 'runtime', priority: Number(values.priority), repoIds: (values.repoIds || []).map(Number),
                endpoint: endpointOf(values, (current && current.endpoint) || {}),
                staleAfterMinutes: staleAfterOf(values.staleAfterMinutes), pollIntervalMinutes: pollIntervalOf(values.pollIntervalMinutes),
            };
            if ((values.clearToken || []).length) {
                body.endpointToken = null;
            } else if (values.endpointToken) {
                body.endpointToken = values.endpointToken;
            }
            await api('PUT', tenantPath(`/flag-sources/${data.sourceId}`), body);
            settingsState.endpointTest = null;
            return { section: 'flags', ok: 'Saved; ShipScope reads it again within a minute.' };
        }
        await api('PUT', tenantPath(`/flag-sources/${data.sourceId}`), {
            name: values.name.trim(), kind: values.kind, priority: Number(values.priority), repoIds: (values.repoIds || []).map(Number),
            staleAfterMinutes: staleAfterOf(values.staleAfterMinutes), oidc: oidcOf(values),
        });
        return { section: 'flags', ok: 'Saved.' };
    },
    'new-token': async (form, data) => {
        const values = formValues(form);
        const environments = values.environments || ENVS;
        if (!environments.length) {
            throw new Error('Pick at least one environment the token may send.');
        }
        const { token } = await api('POST', tenantPath(`/flag-sources/${data.sourceId}/tokens`), {
            expiresInDays: lifetimeOf(values.expiresInDays),
            // Every environment ticked = no limit, so the token keeps working if the sender later adds one.
            environments: environments.length === ENVS.length ? null : environments,
        });
        settingsState.once = { token };
        return { section: 'flags' };
    },
    'revoke-token': async (el, data) => {
        if (!confirmed('Revoke this token? A source still using it gets 401 from then on.')) {
            return null;
        }
        await api('DELETE', tenantPath(`/ingest-tokens/${data.tokenId}`));
        return { section: 'flags', ok: 'Token revoked.' };
    },
    'delete-source': async (el, data) => {
        if (!confirmed('Delete this source with its tokens, flag values and history?')) {
            return null;
        }
        await api('DELETE', tenantPath(`/flag-sources/${data.sourceId}`));
        return { section: 'flags', ok: 'Source deleted.' };
    },
};

function markTracked(installationId, repoId, tracked){
    const list = settingsState.installationRepos[installationId];
    if (Array.isArray(list)) {
        settingsState.installationRepos[installationId] = list.map((r) => (String(r.id) === String(repoId) ? { ...r, tracked } : r));
    }
}

/** Runs an action and reloads the section it touched; an error is shown in the section it was meant for. */
async function runAction(name, el){
    const action = actions[name];
    if (!action) {
        return;
    }
    const data = { ...el.dataset };
    const page = el.closest && el.closest('section');
    const section = (page && ((page.dataset && page.dataset.section) || page.id)) || null;
    // Only the outcome of this action is shown; an earlier one's message would read as current.
    settingsState.messages = {};
    try {
        const result = await action(el, data);
        if (!result) {
            return;
        }
        if (result.section) {
            if (result.ok) {
                settingsState.messages[result.section] = { error: Boolean(result.error), text: result.ok };
            }
            // Every change an admin makes lands in the audit log, which General shows.
            await load(...(isAdmin() && result.section !== 'activity' ? [result.section, 'activity'] : [result.section]));
            return;
        }
        rerender();
    } catch (err) {
        if (section) {
            settingsState.messages[section] = { error: true, text: err.message };
        }
        rerender();
    }
}

function wireEvents(root){
    root.addEventListener('click', (event) => {
        const el = event.target.closest('button[data-action]');
        if (el && el.type !== 'submit') {
            event.preventDefault();
            runAction(el.dataset.action, el);
        }
    });
    root.addEventListener('submit', (event) => {
        const form = event.target.closest('form[data-action]');
        if (form) {
            event.preventDefault();
            runAction(form.dataset.action, form);
        }
    });
    // The PI naming only applies to the PI and auto rhythms.
    root.addEventListener('change', (event) => {
        if (event.target.matches('select[data-action-change="flag-link-type"]')) {
            const elements = event.target.form.elements;
            elements.namedItem('prefix').disabled = event.target.value !== 'label';
            const field = elements.namedItem('id');
            if (field) {
                field.disabled = event.target.value !== 'field';
            }
        }
        if (event.target.matches('select[data-action-change="release-link-type"]')) {
            const elements = event.target.form.elements;
            elements.namedItem('prefix').disabled = !['label', 'fixVersion'].includes(event.target.value);
            const field = elements.namedItem('id');
            if (field) {
                field.disabled = event.target.value !== 'field';
            }
        }
        if (event.target.matches('select[data-action-change="rhythm-changed"]')) {
            const input = event.target.form.elements.namedItem('piTemplate');
            input.disabled = !['pi', 'auto'].includes(event.target.value);
        }
    });
}

async function initSettings(){
    const root = document.getElementById('settingsRoot');
    try {
        const [me, features] = await Promise.all([api('GET', '/me'), api('GET', '/api/features')]);
        settingsState.me = me;
        settingsState.features = features;
        settingsState.tenant = me.tenants.find((t) => t.id === SETTINGS_TENANT_ID) || null;
    } catch (err) {
        root.innerHTML = html`<p class="settings-error">${err.message}</p>`;
        return;
    }
    if (!settingsState.tenant) {
        root.innerHTML = html`<p class="settings-error">You are not a member of this workspace.</p>`;
        return;
    }
    document.getElementById('tenantName').textContent = settingsState.tenant.name;
    document.title = `ShipScope — ${settingsState.tenant.name} settings`;
    wireEvents(document.getElementById('settingsApp'));
    // Each page is a hash (#github, ...): switching re-renders from what is loaded. Asking for the checklist (the
    // Setup card, the dashboard's "finish setting up") brings it back if it was hidden.
    const onHash = () => {
        if (location.hash === '#getting-started' && checklistHidden()) {
            setChecklistHidden(false);
        }
        settingsState.messages = {};
        rerender();
        window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    if (location.hash === '#getting-started') {
        setChecklistHidden(false);
    }
    rerender();
    await load();
}

if (typeof module !== 'undefined') {
    module.exports = { onboardingSteps, SourceStatus, tokenState, TokenLine, renderGettingStarted, SetupCard, renderSidebar, pageFromHash, repoBadge, initials, renderGeneral, AuditEvents, AUDIT_EVENT_LABELS, OidcFields, oidcOf, renderMembers, renderPdi, renderDangerZone, renderGitHub, renderJira, renderFlags, renderSourcesPage, FlagRow, formValues, actions, settingsState, runAction, load, api, ApiError };
} else if (SETTINGS_TENANT_ID) {
    initSettings();
}
