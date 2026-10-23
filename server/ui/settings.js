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
    { group: 'Integrations', items: [{ id: 'github', label: 'GitHub', section: 'github' }, { id: 'jira', label: 'Jira', section: 'jira' }] },
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
 * @param {{ features: object, github: object|null, jira: object|null, boards: object[]|{ error: string }|null, sources: object[]|{ error: string }|null, flagList: object[]|{ error: string }|null, workspace: object|null }} input
 * @returns {Array<{ id: string, title: string, state: string, optional: boolean, hint: string, href: string|null, cta: string|null }>}
 */
function onboardingSteps({ features, github, jira, boards, sources, flagList, workspace }){
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
        steps.push(step('flags', 'Send feature flags', true, 'done', `${flagList.length} flag(s) received.`, '#flags'));
    } else if (sources.some(sourceRefused)) {
        const refused = sources.filter(sourceRefused);
        steps.push(step('flags', 'Send feature flags', true, 'problem',
            `Message refused: ${refused.map((src) => `${src.name} — ${src.lastError.message}`).join('; ')}`, '#sources'));
    } else if (sources.some((src) => src.tokens.length)) {
        steps.push(step('flags', 'Send feature flags', true, 'waiting',
            `Waiting for the first message from ${sources.filter((src) => src.tokens.length).map((src) => src.name).join(', ')} (POST /api/flags/ingest with its token).`, '#sources'));
    } else {
        steps.push(step('flags', 'Send feature flags', true, 'todo', 'Name where your flags live (a build step, a flag service) and give it a token; it then pushes their state.', '#sources', 'Add a source'));
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

/** @param {{ workspace: { settings: object }|null, admin: boolean }} props */
function renderGeneral({ workspace, admin }){
    const page = (body) => Page({ id: 'general', section: 'workspace', title: 'General', hint: admin ? 'How long ShipScope keeps this workspace\'s history.' : MEMBER_HINT, body });
    if (!workspace) {
        return page(html`<p class="settings-loading">Loading…</p>`);
    }
    const days = workspace.settings.deploymentRetentionDays;
    return page(Card({
        title: 'Deployment history',
        body: admin
            ? html`<p class="settings-hint">Older deployments are removed daily; each environment's latest and latest successful deployment always stay.</p>
                <form class="settings-form" data-action="save-retention">
                <label>Keep deployment history (days, 7–730) <input name="deploymentRetentionDays" type="number" min="7" max="730" required value="${days}"></label>
                <button type="submit" class="btn">Save</button></form>`
            : html`<p class="settings-hint">Deployment history is kept for ${days} days.</p>`,
    }));
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

/** @param {{ enabled: boolean, webhooks: boolean, github: { installations: object[], repos: object[] }|null, installationRepos: object, admin: boolean, picker?: boolean, editing?: number|null }} props */
function renderGitHub({ enabled, webhooks, github, installationRepos, admin, picker = false, editing = null }){
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
            <td class="mono">${syncStatus(r)}</td>
            ${admin ? html`<td class="actions">
                <button type="button" class="btn btn-icon" data-action="edit-repo" data-repo-id="${r.repoId}" aria-label="Edit ${r.fullName}" title="Version file and drift">${SETTINGS_ICONS.edit}</button>
                <button type="button" class="btn btn-icon btn-danger" data-action="untrack-repo" data-repo-id="${r.repoId}" data-installation-id="${r.installationId}" aria-label="Stop tracking ${r.fullName}" title="Stop tracking">${SETTINGS_ICONS.close}</button>
            </td>` : ''}</tr>`;
        if (!admin || editing !== r.repoId) {
            return row;
        }
        return html`${row}<tr class="settings-edit-row"><td colspan="5"><form class="settings-form" data-action="save-repo-settings" data-repo-id="${r.repoId}">
            <label>Version file <input name="versionFile" placeholder="e.g. trigger.properties" value="${r.versionFile || ''}" maxlength="200"></label>
            <label>Paths not counted as drift (one per line) <textarea name="driftIgnorePaths" placeholder=".github/&#10;README.md">${(r.driftIgnorePaths || []).join('\n')}</textarea></label>
            <button type="submit" class="btn btn-primary">Save</button>
            <button type="button" class="btn" data-action="edit-repo" data-repo-id="${r.repoId}">Cancel</button></form></td></tr>`;
    });
    const table = rows.length
        ? Card({ cls: 'flush', body: html`<table class="settings-table settings-repos"><thead><tr><th>Repository</th><th>Version file</th><th>Ignored for drift</th><th>Last sync</th>${admin ? html`<th></th>` : ''}</tr></thead><tbody>${rows}</tbody></table>` })
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

/** @param {{ enabled: boolean, webhooks: boolean, jira: object|null, boards: object[]|null|{ error: string }, admin: boolean, flagFields?: object[]|null|{ error: string } }} props */
function renderJira({ enabled, webhooks, jira, boards, admin, flagFields = null }){
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
                ${FlagLinkForm(jira.flagLink || null, flagFields)}`;
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
        <span class="settings-row-meta">${n.flags} flag(s), ${n.changed} changed, ${n.removed} removed${n.stale ? `, ${n.stale} older than stored` : ''}</span>`;
}

/** @param {{ flags: object[]|null|{ error: string }, repos: object[], admin: boolean, once: object, origin: string }} props */
function renderSources({ flags, repos, once, origin }){
    if (flags === null) {
        return html`<p class="settings-loading">Loading…</p>`;
    }
    if (flags.error) {
        return html`<p class="settings-error">${flags.error}</p>`;
    }
    const repoOptions = (selected) => html`<option value="">— any component —</option>${repos.map((r) => html`<option value="${r.repoId}" ${r.repoId === selected ? raw('selected') : ''}>${r.fullName}</option>`)}`;
    const kindOptions = (selected) => ['build', 'runtime'].map((k) => html`<option value="${k}" ${k === selected ? raw('selected') : ''}>${k}</option>`);
    const rows = flags.map((s) => html`<tr><td>
        <form class="settings-form" data-action="save-source" data-source-id="${s.id}">
            <label>Name <input name="name" required maxlength="100" value="${s.name}"></label>
            <label>Kind <select name="kind">${kindOptions(s.kind)}</select></label>
            <label>Priority <input name="priority" type="number" min="0" max="1000" required value="${s.priority}"></label>
            <label>Component <select name="repoId">${repoOptions(s.repoId)}</select></label>
            <button type="submit" class="btn">Save</button>
        </form>
        <div class="settings-source-status">${SourceStatus(s)}</div>
        <div class="settings-row-meta">Tokens: ${s.tokens.length ? s.tokens.map((t) => html`<span class="settings-token">created ${fmtDateTime(t.createdAt)}, last used ${fmtDateTime(t.lastUsedAt)}
            <button type="button" class="btn-link btn" data-action="revoke-token" data-token-id="${t.id}">revoke</button></span>`) : 'none — the source can\'t send anything'}</div>
        </td><td class="actions"><button type="button" class="btn" data-action="new-token" data-source-id="${s.id}">New token</button>
        <button type="button" class="btn btn-danger" data-action="delete-source" data-source-id="${s.id}">Delete</button></td></tr>`);
    return html`${once.token ? SecretBox({
        label: 'Ingest token — shown only once',
        value: once.token,
        note: `The source sends POST ${origin}/api/flags/ingest with the header "Authorization: Bearer <token>".`,
    }) : ''}
        ${rows.length ? html`<table class="settings-table"><tbody>${rows}</tbody></table>` : html`<p class="settings-hint">No flag source yet.</p>`}
        <h3>Add a source</h3>
        <form class="settings-form" data-action="create-source">
            <label>Name <input name="name" required maxlength="100" placeholder="e.g. LaunchDarkly"></label>
            <label>Kind <select name="kind">${kindOptions('runtime')}</select></label>
            <label>Priority (optional) <input name="priority" type="number" min="0" max="1000"></label>
            <label>Component <select name="repoId">${repoOptions(null)}</select></label>
            <button type="submit" class="btn btn-primary">Add source</button>
        </form>`;
}

const ENVS = ['test', 'qa', 'prod'];
const LINK_ORIGINS = [['sender', 'from its source'], ['jira', 'from Jira'], ['manual', 'set here']];

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
    const links = LINK_ORIGINS.filter(([origin]) => flag.links[origin].length)
        .map(([origin, label]) => html`<span>${flag.links[origin].map((k, i) => html`${i ? ', ' : ''}${issue(k)}`)} <span class="settings-row-meta">(${label})</span></span>`);
    const edit = admin ? html`<form class="settings-form" data-action="save-flag" data-key="${flag.key}">
            <label>Description (shown instead of the source's) <input name="description" maxlength="500" value="${flag.manualDescription || ''}" placeholder="${flag.senderDescription || ''}"></label>
            <label>Jira issues linked here <input name="jiraKeys" value="${flag.links.manual.join(', ')}" placeholder="e.g. ABC-12, ABC-15"></label>
            <button type="submit" class="btn">Save</button></form>` : '';
    return html`<tr><td><strong class="mono">${flag.key}</strong> ${ENVS.map(stateTag)}
        <div>${flag.description || html`<span class="settings-hint">No description</span>`}</div>
        <div class="settings-row-meta">Jira: ${links.length ? links.map((l, i) => html`${i ? ' · ' : ''}${l}`) : 'not linked'}</div>
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
function renderSourcesPage({ sources, repos, admin, once, origin }){
    return Page({
        id: 'sources',
        section: 'flags',
        title: 'Sources',
        hint: 'ShipScope never reads your flags: each source (a build step, a flag service, a cron job) sends their full state to the ingest URL with its own token.',
        body: Card({ body: admin ? renderSources({ flags: sources, repos, once, origin }) : html`<p class="settings-hint">Only admins manage flag sources.</p>` }),
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
    const pages = {
        'getting-started': () => renderGettingStarted({ steps }),
        general: () => renderGeneral({ workspace: s.workspace, admin }),
        members: () => renderMembers({ workspace: s.workspace, admin, meId: s.me && s.me.user.id, once: s.once }),
        github: () => renderGitHub({ enabled: s.features.githubApp, webhooks: s.features.githubWebhooks, github: s.github, installationRepos: s.installationRepos, admin, picker: s.trackPicker, editing: s.editingRepo }),
        jira: () => renderJira({ enabled: s.features.jira, webhooks: s.features.jiraWebhooks, jira: s.jira, boards: s.boards, admin, flagFields: s.flagFields }),
        flags: () => renderFlags({ flagList: s.flagList, admin, jiraUrl: s.jira && s.jira.site ? s.jira.site.url : null }),
        sources: () => renderSourcesPage({ sources: s.flags, repos, admin, once: s.once, origin: location.origin }),
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
        const [settings, { members }, invitations] = await Promise.all([
            api('GET', tenantPath('/settings')),
            api('GET', tenantPath('/members')),
            isAdmin() ? api('GET', tenantPath('/invitations')).then((r) => r.invitations) : Promise.resolve(null),
        ]);
        settingsState.workspace = { settings, members, invitations };
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
        const [list, sources] = await Promise.all([
            api('GET', tenantPath('/flags')).then((r) => r.flags, (err) => ({ error: err.message })),
            isAdmin() ? api('GET', tenantPath('/flag-sources')).then((r) => r.sources, (err) => ({ error: err.message })) : Promise.resolve(null),
        ]);
        settingsState.flagList = list;
        settingsState.flags = sources;
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
    'save-flag': async (form, data) => {
        const values = formValues(form);
        const jiraKeys = [...new Set(values.jiraKeys.split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter(Boolean))];
        await api('PUT', tenantPath(`/flags/${encodeURIComponent(data.key)}`), { description: values.description.trim() || null, jiraKeys });
        return { section: 'flags', ok: `Saved ${data.key}.` };
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
        const body = { name: values.name.trim(), kind: values.kind, repoId: values.repoId ? Number(values.repoId) : null };
        if (values.priority !== '') {
            body.priority = Number(values.priority);
        }
        const { token } = await api('POST', tenantPath('/flag-sources'), body);
        settingsState.once = { token: token.token };
        return { section: 'flags' };
    },
    'save-source': async (form, data) => {
        const values = formValues(form);
        await api('PUT', tenantPath(`/flag-sources/${data.sourceId}`), {
            name: values.name.trim(), kind: values.kind, priority: Number(values.priority), repoId: values.repoId ? Number(values.repoId) : null,
        });
        return { section: 'flags', ok: 'Saved.' };
    },
    'new-token': async (el, data) => {
        const { token } = await api('POST', tenantPath(`/flag-sources/${data.sourceId}/tokens`));
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
                settingsState.messages[result.section] = { error: false, text: result.ok };
            }
            await load(result.section);
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
    module.exports = { onboardingSteps, SourceStatus, renderGettingStarted, SetupCard, renderSidebar, pageFromHash, repoBadge, initials, renderGeneral, renderMembers, renderDangerZone, renderGitHub, renderJira, renderFlags, renderSourcesPage, FlagRow, formValues, actions, settingsState, runAction, load, api, ApiError };
} else if (SETTINGS_TENANT_ID) {
    initSettings();
}
