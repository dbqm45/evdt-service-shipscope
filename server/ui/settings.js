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
    workspace: null, github: null, installationRepos: {}, jira: null, boards: null, flags: null,
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

function Section({ id, title, hint, body }){
    return html`<section class="panel settings-section" id="${id}">
        <div class="panel-head"><h2>${title}</h2></div>
        <div class="settings-body">${hint ? html`<p class="settings-hint">${hint}</p>` : ''}${sectionMessage(id)}${body}</div>
    </section>`;
}

function SecretBox({ label, value, note }){
    return html`<div class="secret-box"><strong>${label}</strong><code>${value}</code>${note ? html`<span class="settings-hint">${note}</span>` : ''}
        <span><button type="button" class="btn" data-action="dismiss-once">Done, I copied it</button></span></div>`;
}

/** @param {{ workspace: { settings: object, members: object[], invitations: object[]|null }, admin: boolean, meId: string, once: object, tenantName?: string }} props */
function renderWorkspace({ workspace, admin, meId, once, tenantName = '' }){
    if (!workspace) {
        return Section({ id: 'workspace', title: 'Workspace', body: html`<p class="settings-loading">Loading…</p>` });
    }
    const { settings, members, invitations } = workspace;
    const memberRows = members.map((m) => {
        const self = m.userId === meId;
        const action = self
            ? html`<button type="button" class="btn btn-danger" data-action="remove-member" data-user-id="${m.userId}" data-self="1">Leave</button>`
            : admin ? html`<button type="button" class="btn btn-danger" data-action="remove-member" data-user-id="${m.userId}">Remove</button>` : '';
        return html`<tr><td>${m.githubLogin}${self ? html` <span class="state-tag">you</span>` : ''}</td><td>${m.role}</td><td class="actions">${action}</td></tr>`;
    });
    const retention = admin
        ? html`<form class="settings-form" data-action="save-retention">
            <label>Keep deployment history (days, 7–730) <input name="deploymentRetentionDays" type="number" min="7" max="730" required value="${settings.deploymentRetentionDays}"></label>
            <button type="submit" class="btn">Save</button></form>`
        : html`<p class="settings-hint">Deployment history is kept for ${settings.deploymentRetentionDays} days.</p>`;
    const inviteBlock = admin ? html`<h3>Invitations</h3>
        ${once.inviteUrl ? SecretBox({ label: 'Invitation link — shown only once', value: once.inviteUrl, note: 'Send it to the person you invite; it works once and expires in 7 days.' }) : ''}
        <form class="settings-form" data-action="create-invitation">
            <label>Role <select name="role"><option value="member">member</option><option value="admin">admin</option></select></label>
            <button type="submit" class="btn">Create invitation link</button>
        </form>
        ${invitations && invitations.length ? html`<table class="settings-table"><thead><tr><th>Role</th><th>Created by</th><th>Expires</th><th></th></tr></thead><tbody>
            ${invitations.map((i) => html`<tr><td>${i.role}</td><td>${i.createdBy}</td><td>${fmtDateTime(i.expiresAt)}</td>
                <td class="actions"><button type="button" class="btn btn-danger" data-action="revoke-invitation" data-invitation-id="${i.id}">Revoke</button></td></tr>`)}
            </tbody></table>` : html`<p class="settings-hint">No pending invitations.</p>`}` : '';
    return Section({
        id: 'workspace',
        title: 'Workspace',
        hint: admin ? null : 'You are a member: only admins can change settings.',
        body: html`${retention}<h3>Members</h3>
            <table class="settings-table"><thead><tr><th>GitHub user</th><th>Role</th><th></th></tr></thead><tbody>${memberRows}</tbody></table>
            ${inviteBlock}${admin ? DeleteWorkspace(tenantName) : ''}`,
    });
}

/** The danger zone: deleting the workspace needs its name typed back (the server checks it too). */
function DeleteWorkspace(tenantName){
    return html`<h3>Delete workspace</h3>
        <p class="settings-hint">Deletes this workspace and everything ShipScope holds for it: members, invitations, tracked
        repositories and their deployments, the Jira connection and its issues, flag sources and values. This cannot be undone.
        ShipScope's Jira webhook is removed; the GitHub App stays installed on GitHub — uninstall it there
        (organization or account Settings → GitHub Apps) if nothing else uses it.</p>
        <form class="settings-form" data-action="delete-workspace">
            <label>Type <strong>${tenantName}</strong> to confirm <input name="confirmName" required maxlength="200" autocomplete="off"></label>
            <button type="submit" class="btn btn-danger">Delete workspace</button>
        </form>`;
}

function syncTag(repo){
    if (repo.lastSyncError) {
        return html`<span class="state-tag fail" title="${repo.lastSyncError}">sync failed</span>`;
    }
    return repo.lastSyncedAt ? html`<span class="state-tag ok">synced ${fmtDateTime(repo.lastSyncedAt)}</span>` : html`<span class="state-tag warn">not synced yet</span>`;
}

/** @param {{ enabled: boolean, webhooks: boolean, github: { installations: object[], repos: object[] }|null, installationRepos: object, admin: boolean }} props */
function renderGitHub({ enabled, webhooks, github, installationRepos, admin }){
    if (!enabled) {
        return Section({ id: 'github', title: 'GitHub', body: html`<p class="settings-hint">The GitHub App is not configured on this server (GITHUB_APP_* variables).</p>` });
    }
    if (!github) {
        return Section({ id: 'github', title: 'GitHub', body: html`<p class="settings-loading">Loading…</p>` });
    }
    const install = admin ? html`<p><a class="btn btn-primary" href="${tenantPath('/github/install')}">Install the GitHub App on an account or organization</a></p>` : '';
    const installations = github.installations.map((inst) => {
        const list = installationRepos[inst.installationId];
        let repos = html``;
        if (list === 'loading') {
            repos = html`<p class="settings-loading">Loading repositories…</p>`;
        } else if (list && list.error) {
            repos = html`<p class="settings-error">${list.error}</p>`;
        } else if (Array.isArray(list)) {
            repos = list.length ? html`<table class="settings-table"><tbody>${list.map((r) => html`<tr><td>${r.fullName}${r.private ? html` <span class="state-tag">private</span>` : ''}</td>
                <td class="actions">${r.tracked
                    ? html`<button type="button" class="btn" data-action="untrack-repo" data-repo-id="${r.id}" data-installation-id="${inst.installationId}">Stop tracking</button>`
                    : html`<button type="button" class="btn btn-primary" data-action="track-repo" data-repo-id="${r.id}" data-installation-id="${inst.installationId}">Track</button>`}</td></tr>`)}</tbody></table>`
                : html`<p class="settings-hint">The App can't see any repository of this installation; choose repositories on GitHub.</p>`;
        }
        return html`<tr><td>${inst.accountLogin} <span class="settings-row-meta">${inst.accountType || ''}</span>${repos}</td>
            <td class="actions">${admin ? html`<button type="button" class="btn" data-action="load-installation-repos" data-installation-id="${inst.installationId}">Repositories</button>
                <button type="button" class="btn btn-danger" data-action="unlink-installation" data-installation-id="${inst.installationId}">Unlink</button>` : ''}</td></tr>`;
    });
    const tracked = github.repos.map((r) => html`<tr><td><strong>${r.fullName}</strong> ${syncTag(r)}
        ${admin ? html`<form class="settings-form" data-action="save-repo-settings" data-repo-id="${r.repoId}">
            <label>Version file <input name="versionFile" placeholder="e.g. trigger.properties" value="${r.versionFile || ''}" maxlength="200"></label>
            <label>Paths not counted as drift (one per line) <textarea name="driftIgnorePaths" placeholder=".github/&#10;README.md">${(r.driftIgnorePaths || []).join('\n')}</textarea></label>
            <button type="submit" class="btn">Save</button></form>`
        : html`<div class="settings-row-meta">Version file: ${r.versionFile || '—'} · Ignored for drift: ${(r.driftIgnorePaths || []).join(', ') || '—'}</div>`}</td>
        <td class="actions">${admin ? html`<button type="button" class="btn btn-danger" data-action="untrack-repo" data-repo-id="${r.repoId}" data-installation-id="${r.installationId}">Stop tracking</button>` : ''}</td></tr>`);
    return Section({
        id: 'github',
        title: 'GitHub',
        hint: 'ShipScope reads deployments, releases and tags of the repositories you track, through the GitHub App.',
        body: html`<p class="settings-hint">${webhooks
            ? html`<span class="state-tag ok">instant updates on</span> A deployment shows up within a minute of finishing.`
            : 'New deployments arrive with the periodic sync (every 15 minutes by default); set GITHUB_APP_WEBHOOK_SECRET for instant updates.'}</p>
            ${install}<h3>Installations</h3>
            ${installations.length ? html`<table class="settings-table"><tbody>${installations}</tbody></table>` : html`<p class="settings-hint">No installation linked yet.</p>`}
            <h3>Tracked repositories</h3>
            ${tracked.length ? html`<table class="settings-table"><tbody>${tracked}</tbody></table>` : html`<p class="settings-hint">No repository tracked yet.</p>`}`,
    });
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

/** @param {{ enabled: boolean, webhooks: boolean, jira: object|null, boards: object[]|null|{ error: string }, admin: boolean }} props */
function renderJira({ enabled, webhooks, jira, boards, admin }){
    const section = (body, hint) => Section({ id: 'jira', title: 'Jira', hint, body });
    if (!enabled) {
        return section(html`<p class="settings-hint">Jira is not configured on this server (ATLASSIAN_* variables and TOKEN_ENCRYPTION_KEY).</p>`);
    }
    if (!jira) {
        return section(html`<p class="settings-loading">Loading…</p>`);
    }
    const connect = html`<a class="btn btn-primary" href="${tenantPath('/jira/connect')}">${jira.connected ? 'Reconnect Jira' : 'Connect Jira'}</a>`;
    if (!jira.connected) {
        return section(admin ? html`<p>${connect}</p>` : html`<p class="settings-hint">Jira is not connected; an admin can connect it.</p>`,
            'Read-only access through Atlassian: issues, boards and sprints of the boards you choose.');
    }
    const status = html`<p>${jira.site ? html`Connected to <strong>${jira.site.name}</strong> <span class="settings-row-meta">${jira.site.url}</span>` : 'Connected — choose a site.'}
        ${jira.lastError ? html` <span class="state-tag fail">${jira.lastError}</span>` : ''}</p>${jira.site ? webhookLine(webhooks, jira.webhook) : ''}`;
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
                <button type="button" class="btn" data-action="sync-jira">Sync now</button></form>`;
        }
    }
    return section(html`${status}${site}${boardBlock}
        <div class="settings-actions">${connect}<button type="button" class="btn btn-danger" data-action="disconnect-jira">Disconnect</button></div>`);
}

/** @param {{ flags: object[]|null|{ error: string }, repos: object[], admin: boolean, once: object, origin: string }} props */
function renderFlags({ flags, repos, admin, once, origin }){
    const section = (body) => Section({
        id: 'flags',
        title: 'Feature flags',
        hint: 'ShipScope never reads your flags: each source (a build step, a flag service, a cron job) sends their full state to the ingest URL with its own token.',
        body,
    });
    if (!admin) {
        return section(html`<p class="settings-hint">Only admins manage flag sources.</p>`);
    }
    if (flags === null) {
        return section(html`<p class="settings-loading">Loading…</p>`);
    }
    if (flags.error) {
        return section(html`<p class="settings-error">${flags.error}</p>`);
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
        <div class="settings-row-meta">Tokens: ${s.tokens.length ? s.tokens.map((t) => html`<span class="settings-token">created ${fmtDateTime(t.createdAt)}, last used ${fmtDateTime(t.lastUsedAt)}
            <button type="button" class="btn-link btn" data-action="revoke-token" data-token-id="${t.id}">revoke</button></span>`) : 'none — the source can\'t send anything'}</div>
        </td><td class="actions"><button type="button" class="btn" data-action="new-token" data-source-id="${s.id}">New token</button>
        <button type="button" class="btn btn-danger" data-action="delete-source" data-source-id="${s.id}">Delete</button></td></tr>`);
    return section(html`${once.token ? SecretBox({
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
        </form>`);
}

function renderSettings(){
    const s = settingsState;
    const admin = isAdmin();
    return html`${renderWorkspace({ workspace: s.workspace, admin, meId: s.me && s.me.user.id, once: s.once, tenantName: s.tenant && s.tenant.name })}
        ${renderGitHub({ enabled: s.features.githubApp, webhooks: s.features.githubWebhooks, github: s.github, installationRepos: s.installationRepos, admin })}
        ${renderJira({ enabled: s.features.jira, webhooks: s.features.jiraWebhooks, jira: s.jira, boards: s.boards, admin })}
        ${renderFlags({ flags: s.flags, repos: (s.github && s.github.repos) || [], admin, once: s.once, origin: location.origin })}`;
}

function rerender(){
    const root = document.getElementById('settingsRoot');
    if (root) {
        root.innerHTML = renderSettings();
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
            settingsState.boards = await api('GET', tenantPath('/jira/boards')).then((r) => r.boards, (err) => ({ error: err.message }));
        }
    },
    async flags(){
        if (isAdmin()) {
            settingsState.flags = await api('GET', tenantPath('/flag-sources')).then((r) => r.sources, (err) => ({ error: err.message }));
        }
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
    'load-installation-repos': async (el, data) => {
        const id = data.installationId;
        settingsState.installationRepos[id] = 'loading';
        rerender();
        settingsState.installationRepos[id] = await api('GET', tenantPath(`/github/installations/${id}/repositories`))
            .then((r) => r.repositories, (err) => ({ error: err.message }));
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
    'sync-jira': async () => {
        const result = await api('POST', tenantPath('/jira/sync'));
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
    const section = (el.closest && el.closest('section') && el.closest('section').id) || null;
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
    document.getElementById('tenantName').textContent = `${settingsState.tenant.name} · Settings`;
    document.title = `ShipScope — ${settingsState.tenant.name} settings`;
    wireEvents(root);
    rerender();
    await load();
    if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) {
            target.scrollIntoView();
        }
    }
}

if (typeof module !== 'undefined') {
    module.exports = { renderWorkspace, renderGitHub, renderJira, renderFlags, formValues, actions, settingsState, runAction, load, api, ApiError };
} else if (SETTINGS_TENANT_ID) {
    initSettings();
}
