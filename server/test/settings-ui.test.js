const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ui/settings.js is a classic browser script after docs/app-html.js; in Node it exports its functions and finds
// `html`/`raw` as globals, like in the page.
Object.assign(global, require(path.join(__dirname, '..', '..', 'docs', 'app-html.js')));
global.document = { getElementById: () => null };
const ui = require('../ui/settings.js');

const TENANT = '11111111-2222-3333-4444-555555555555';
const str = (h) => String(h);

/** A fake fetch answering from `routes` ("METHOD /path" -> body or (body) => body), recording every call. */
function fakeFetch(routes = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method, url, body });
        const answer = routes[`${init.method} ${url}`];
        if (answer instanceof Error) return new Response(JSON.stringify({ error: answer.message }), { status: 409 });
        if (answer === null) return new Response(null, { status: 204 });
        const value = typeof answer === 'function' ? answer(body) : answer ?? {};
        return new Response(JSON.stringify(value), { status: 200 });
    };
    return { fn, calls };
}

/** A fake form: `fields` as [name, value] or [name, value, checked] for checkboxes. */
const form = (fields, dataset = {}, section = 'jira') => ({
    dataset,
    elements: fields.map(([name, value, checked]) => ({ name, value, type: checked === undefined ? 'text' : 'checkbox', checked })),
    closest: () => ({ id: section }),
});
const button = (dataset, section) => ({ dataset, closest: () => ({ id: section }) });

test('settings page: the workspace section -- admins invite and remove, members only leave; every value escaped', () => {
    const workspace = {
        settings: { deploymentRetentionDays: 90 },
        members: [{ userId: 'u1', githubLogin: 'alice', role: 'admin' }, { userId: 'u2', githubLogin: '<img src=x onerror=alert(1)>', role: 'member' }],
        invitations: [{ id: 'i1', role: 'member', createdBy: 'alice', expiresAt: '2026-10-20T10:00:00Z' }],
    };
    const admin = str(ui.renderWorkspace({ workspace, admin: true, meId: 'u1', once: {} }));
    assert.match(admin, /data-action="remove-member" data-user-id="u1" data-self="1">Leave/);
    assert.match(admin, /data-action="remove-member" data-user-id="u2">Remove/);
    assert.match(admin, /data-action="create-invitation"/);
    assert.match(admin, /data-action="revoke-invitation" data-invitation-id="i1"/);
    assert.match(admin, /name="deploymentRetentionDays" type="number" min="7" max="730" required value="90"/);
    assert.ok(!admin.includes('<img'), 'a GitHub login is escaped');
    assert.match(admin, /&lt;img src=x/);

    const danger = str(ui.renderWorkspace({ workspace, admin: true, meId: 'u1', once: {}, tenantName: 'Acme <Corp>' }));
    assert.match(danger, /data-action="delete-workspace"/);
    assert.match(danger, /Type <strong>Acme &lt;Corp&gt;<\/strong> to confirm <input name="confirmName" required/, 'the name to type, escaped');
    const member = str(ui.renderWorkspace({ workspace: { ...workspace, invitations: null }, admin: false, meId: 'u2', once: {}, tenantName: 'Acme' }));
    assert.ok(!/delete-workspace/.test(member), 'only admins can delete the workspace');
    assert.match(member, /only admins can change settings/);
    assert.match(member, /kept for 90 days/);
    assert.ok(!/create-invitation|data-user-id="u1"|deploymentRetentionDays/.test(member), 'a member sees no admin controls');
    assert.match(member, /data-user-id="u2" data-self="1">Leave/);

    const once = str(ui.renderWorkspace({ workspace, admin: true, meId: 'u1', once: { inviteUrl: 'https://x/invitations/abc"><b>' } }));
    assert.match(once, /shown only once/);
    assert.ok(once.includes('https://x/invitations/abc&quot;&gt;&lt;b&gt;'));
    assert.match(str(ui.renderWorkspace({ workspace: null, admin: true, meId: 'u1', once: {} })), /Loading/);
});

test('settings page: the GitHub section -- installations, their repositories to track, and per-repo settings', () => {
    assert.match(str(ui.renderGitHub({ enabled: false, admin: true })), /not configured on this server/);
    assert.match(str(ui.renderGitHub({ enabled: true, github: null, admin: true })), /Loading/);
    const github = {
        installations: [{ installationId: 7, accountLogin: 'acme', accountType: 'Organization' }, { installationId: 8, accountLogin: 'solo', accountType: 'User' }],
        repos: [{ repoId: 101, fullName: 'acme/web', installationId: 7, lastSyncedAt: null, lastSyncError: 'boom "quoted"', versionFile: 'trigger.properties', driftIgnorePaths: ['.github/', 'README.md'] }],
    };
    const installationRepos = { 7: [{ id: 101, fullName: 'acme/web', private: true, tracked: true }, { id: 102, fullName: 'acme/api', private: false, tracked: false }], 8: 'loading' };
    const admin = str(ui.renderGitHub({ enabled: true, github, installationRepos, admin: true }));
    assert.match(admin, new RegExp(`href="/tenants/${'null'}/github/install"|href="/tenants/[^/]+/github/install"`));
    assert.match(admin, /data-action="track-repo" data-repo-id="102" data-installation-id="7">Track/);
    assert.match(admin, /data-action="untrack-repo" data-repo-id="101" data-installation-id="7">Stop tracking/);
    assert.match(admin, /Loading repositories/);
    assert.match(admin, /name="versionFile" placeholder="e.g. trigger.properties" value="trigger.properties"/);
    assert.match(admin, />\.github\/\nREADME\.md<\/textarea>/);
    assert.match(admin, /title="boom &quot;quoted&quot;">sync failed/);
    assert.match(admin, /data-action="unlink-installation" data-installation-id="8"/);
    const paused = { ...github, repos: [{ ...github.repos[0], rateLimitedUntil: '2026-10-16T12:10:00.000Z' }] };
    assert.match(str(ui.renderGitHub({ enabled: true, github: paused, installationRepos: {}, admin: false })),
        /class="state-tag warn" title="GitHub asked ShipScope to slow down[^"]*">paused by GitHub's rate limit until /, 'a pause, not a failure');

    assert.match(admin, /every 15 minutes by default/);
    assert.match(str(ui.renderGitHub({ enabled: true, webhooks: true, github, installationRepos: {}, admin: true })), /instant updates on/);
    const member = str(ui.renderGitHub({ enabled: true, github, installationRepos: {}, admin: false }));
    assert.ok(!/data-action=|github\/install/.test(member), 'read-only for members');
    assert.match(member, /Version file: trigger\.properties · Ignored for drift: \.github\/, README\.md/);
});

test('settings page: the Jira section -- connect, choose a site, pick boards and set each one\'s rhythm', () => {
    assert.match(str(ui.renderJira({ enabled: false, admin: true })), /not configured on this server/);
    assert.match(str(ui.renderJira({ enabled: true, jira: { connected: false }, admin: true })), /\/jira\/connect">Connect Jira/);
    assert.match(str(ui.renderJira({ enabled: true, jira: { connected: false }, admin: false })), /an admin can connect it/);

    const pick = str(ui.renderJira({ enabled: true, jira: { connected: true, site: null, sites: [{ cloudId: 'c1', name: 'acme', url: 'https://acme.atlassian.net' }] }, boards: null, admin: true }));
    assert.match(pick, /data-action="choose-site"/);
    assert.match(pick, /<option value="c1">acme — https:\/\/acme\.atlassian\.net<\/option>/);

    const jira = { connected: true, site: { cloudId: 'c1', name: 'acme', url: 'https://acme.atlassian.net' }, lastError: 'Jira sync failed: <x>' };
    const boards = [
        { boardId: 10, name: 'Sparks', type: 'scrum', projectKey: 'ABC', projectName: 'Sparks', selected: true, rhythm: 'sprint', piTemplate: null, currentIncrement: 'Sprint 7' },
        { boardId: 12, name: 'Support', type: 'kanban', projectKey: 'SUP', projectName: 'Support', selected: true, rhythm: 'auto', piTemplate: 'PI {pi}', currentIncrement: null },
        { boardId: 13, name: 'Labs', type: 'simple', projectKey: null, projectName: null, selected: false },
    ];
    const admin = str(ui.renderJira({ enabled: true, jira, boards, admin: true }));
    assert.match(admin, /Jira sync failed: &lt;x&gt;/);
    assert.ok(!/rate limit/.test(admin));
    assert.match(str(ui.renderJira({ enabled: true, jira: { ...jira, lastError: null, rateLimitedUntil: '2026-10-16T12:10:00.000Z' }, boards, admin: false })),
        /class="state-tag warn">sync paused by Atlassian's rate limit until /);
    assert.match(admin, /type="checkbox" form="jiraBoardSelection" name="boardIds" value="10" checked/);
    assert.match(admin, /name="boardIds" value="13"  aria-label/, 'unselected boards are not checked');
    assert.match(admin, /<form id="jiraBoardSelection" class="settings-actions" data-action="save-boards">/);
    assert.ok(!/<form[^>]*>(?:(?!<\/form>).)*<form/s.test(admin), 'no form inside another form');
    assert.match(admin, /data-board-id="10">[\s\S]*?<option value="sprint" selected>Sprints \(Scrum\)/);
    assert.match(admin, /placeholder="PI \{pi\} \/ Iteration \{n\}" maxlength="100" value="" disabled>/, 'no PI naming in the sprint rhythm');
    assert.match(admin, /value="PI \{pi\}" >/, 'auto keeps it editable');
    assert.match(admin, /Now: Sprint 7/);
    assert.match(admin, /Now: not synced yet/);
    assert.ok(!/data-board-id="13"/.test(admin), 'a board not selected has no rhythm form');
    assert.match(admin, /data-action="sync-jira"/);
    assert.match(admin, /data-action="disconnect-jira"/);

    assert.match(str(ui.renderJira({ enabled: true, jira, boards: { error: 'Jira request failed' }, admin: true })), /settings-error">Jira request failed/);
    assert.ok(!/instant updates/.test(admin), 'no webhook line when the server has no Jira webhooks');
    const live = { ...jira, webhook: { active: true, expiresAt: '2026-11-15T00:00:00Z', error: null } };
    assert.match(str(ui.renderJira({ enabled: true, webhooks: true, jira: live, boards: [], admin: true })), /instant updates on/);
    const off = { ...jira, webhook: { active: false, expiresAt: null, error: 'Reconnect Jira <now>' } };
    assert.match(str(ui.renderJira({ enabled: true, webhooks: true, jira: off, boards: [], admin: true })), /instant updates off<\/span> Reconnect Jira &lt;now&gt;/);
    const member = str(ui.renderJira({ enabled: true, jira, boards: null, admin: false }));
    assert.ok(!/data-action=|boardIds/.test(member));
    assert.match(member, /Connected to <strong>acme<\/strong>/);
});

test('settings page: the flags section -- each flag with its state and Jira links by origin; sources for admins', () => {
    const repos = [{ repoId: 101, fullName: 'acme/web' }];
    const flagList = [{
        key: 'newCheckout', description: 'New checkout', senderDescription: 'from LD', manualDescription: 'New checkout',
        links: { sender: ['ABC-1'], manual: ['ABC-3'], jira: ['ABC-2'] },
        states: { prod: { 'runtime-be': { state: 'partial', rollout: 25, sourceName: 'LD' } }, test: { build: { state: 'on', rollout: null, sourceName: 'CI' } } },
        components: ['web'],
    }, { key: 'x"y', description: '', senderDescription: null, manualDescription: null, links: { sender: [], manual: [], jira: [] }, states: {}, components: [] }];
    const member = str(ui.renderFlags({ flagList, sources: null, repos, admin: false, once: {}, origin: 'https://s', jiraUrl: 'https://acme.atlassian.net' }));
    assert.match(member, /Only admins manage flag sources/);
    assert.match(member, /<strong class="mono">newCheckout<\/strong>/);
    assert.match(member, /state-tag warn" title="LD">prod: partial 25%/);
    assert.match(member, /state-tag ok" title="CI">test: on/);
    assert.match(member, /qa: —/);
    assert.match(member, /href="https:\/\/acme\.atlassian\.net\/browse\/ABC-1"[^>]*>ABC-1<\/a> <span class="settings-row-meta">\(from its source\)/);
    assert.match(member, />ABC-2<\/a> <span class="settings-row-meta">\(from Jira\)/);
    assert.match(member, />ABC-3<\/a> <span class="settings-row-meta">\(set here\)/);
    assert.match(member, /Jira: not linked/);
    assert.match(member, /x&quot;y/, 'a flag key is escaped');
    assert.ok(!/data-action="save-flag"/.test(member), 'members read only');

    const admin = str(ui.renderFlags({ flagList, sources: [], repos, admin: true, once: {}, origin: 'https://s' }));
    assert.match(admin, /data-action="save-flag" data-key="newCheckout"/);
    assert.match(admin, /name="description" maxlength="500" value="New checkout" placeholder="from LD"/);
    assert.match(admin, /name="jiraKeys" value="ABC-3"/);
    assert.match(admin, /ABC-1 <span/, 'without a Jira site URL, keys are plain text');
    assert.match(admin, /No flag source yet/);
    assert.match(str(ui.renderFlags({ flagList: [], sources: [], repos, admin: true, once: {}, origin: 'https://s' })), /No flags yet/);
    assert.match(str(ui.renderFlags({ flagList: { error: 'boom' }, sources: [], repos, admin: true, once: {}, origin: 'https://s' })), /settings-error">boom/);

    assert.match(str(ui.renderFlags({ flagList: [], sources: null, repos, admin: true, once: {}, origin: 'https://s' })), /Sources<\/h3><p class="settings-loading">Loading/);
    const sources = [{ id: 's1', name: 'LaunchDarkly', kind: 'runtime', priority: 100, repoId: 101, tokens: [{ id: 't1', createdAt: '2026-10-01T10:00:00Z', lastUsedAt: null }] },
        { id: 's2', name: 'Build "files"', kind: 'build', priority: 0, repoId: null, tokens: [] }];
    const out = str(ui.renderFlags({ flagList: [], sources, repos, admin: true, once: { token: 'sst_secret' }, origin: 'https://s' }));
    assert.match(out, /<code>sst_secret<\/code>/);
    assert.match(out, /POST https:\/\/s\/api\/flags\/ingest/);
    assert.match(out, /data-source-id="s1"[\s\S]*?<option value="runtime" selected>runtime[\s\S]*?<option value="101" selected>acme\/web/);
    assert.match(out, /value="Build &quot;files&quot;"/);
    assert.match(out, /data-action="revoke-token" data-token-id="t1"/);
    assert.match(out, /none — the source can&#39;t send anything/);
    assert.match(out, /data-action="create-source"/);
    assert.match(str(ui.renderFlags({ flagList: [], sources: { error: 'nope' }, repos, admin: true, once: {}, origin: 'https://s' })), /settings-error">nope/);
});

test('settings page: the Jira section offers the flag convention -- none, prefixed labels, or a field', () => {
    const jira = { connected: true, site: { cloudId: 'c1', name: 'acme', url: 'https://acme.atlassian.net' }, lastError: null, flagLink: null };
    const fields = [{ id: 'customfield_10050', name: 'Feature flag', type: 'text' }, { id: 'customfield_10051', name: 'Flags <x>', type: 'labels' }];
    const none = str(ui.renderJira({ enabled: true, jira, boards: [], admin: true, flagFields: fields }));
    assert.match(none, /data-action="save-flag-link"/);
    assert.match(none, /<option value="none" selected>Not at all/);
    assert.match(none, /name="prefix" maxlength="30" value="flag:" disabled/);
    assert.match(none, /<select name="id" disabled><option value="customfield_10050" >Feature flag \(text\)/);
    assert.match(none, /Flags &lt;x&gt; \(labels\)/);
    const byField = str(ui.renderJira({ enabled: true, jira: { ...jira, flagLink: { type: 'field', id: 'customfield_10051', name: 'Flags' } }, boards: [], admin: true, flagFields: fields }));
    assert.match(byField, /<option value="field" selected>/);
    assert.match(byField, /<select name="id" ><option value="customfield_10050" >[\s\S]*<option value="customfield_10051" selected>/);
    const byLabel = str(ui.renderJira({ enabled: true, jira: { ...jira, flagLink: { type: 'label', prefix: 'ff-' } }, boards: [], admin: true, flagFields: [] }));
    assert.match(byLabel, /name="prefix" maxlength="30" value="ff-" >/);
    assert.match(byLabel, /No text, labels or select field yet/);
    assert.match(str(ui.renderJira({ enabled: true, jira, boards: [], admin: true, flagFields: null })), /Loading fields/);
    assert.match(str(ui.renderJira({ enabled: true, jira, boards: [], admin: true, flagFields: { error: 'Jira request failed' } })), /settings-error">Jira request failed/);
    assert.ok(!/save-flag-link/.test(str(ui.renderJira({ enabled: true, jira, boards: null, admin: false }))), 'members don\'t');
});

test('getting started: each step read off the loaded sections -- todo, waiting, problem, done, or off on this server', () => {
    ui.settingsState.tenantId = TENANT;
    const features = { githubApp: true, jira: true };
    const empty = { features, github: { installations: [], repos: [] }, jira: { connected: false }, boards: null, sources: [], flagList: [], workspace: { members: [{}], invitations: [] } };
    const states = (input) => Object.fromEntries(ui.onboardingSteps(input).map((st) => [st.id, st.state]));
    const byId = (input) => Object.fromEntries(ui.onboardingSteps(input).map((st) => [st.id, st]));

    assert.deepStrictEqual(states(empty), { 'github-app': 'todo', repos: 'todo', deployments: 'todo', jira: 'todo', boards: 'todo', flags: 'todo', team: 'todo' });
    assert.deepStrictEqual(ui.onboardingSteps(empty).filter((st) => !st.optional).map((st) => st.id), ['github-app', 'repos', 'deployments'], 'GitHub is what a dashboard needs');
    assert.strictEqual(byId(empty)['github-app'].href, `/tenants/${TENANT}/github/install`);
    assert.strictEqual(byId(empty).jira.href, `/tenants/${TENANT}/jira/connect`);
    assert.deepStrictEqual(states({ ...empty, github: null, jira: null, sources: null, workspace: null }),
        { 'github-app': 'loading', repos: 'loading', deployments: 'loading', jira: 'loading', boards: 'loading', flags: 'loading', team: 'loading' });
    assert.deepStrictEqual(states({ ...empty, features: { githubApp: false, jira: false } }), { 'github-app': 'unavailable', repos: 'unavailable', deployments: 'unavailable', jira: 'unavailable', boards: 'unavailable', flags: 'todo', team: 'todo' });

    const repo = (extra) => ({ fullName: 'acme/web', deployments: 0, lastSyncedAt: null, lastSyncError: null, rateLimitedUntil: null, ...extra });
    const gh = (...repos) => ({ installations: [{ accountLogin: 'acme' }], repos });
    const dep = (github) => byId({ ...empty, github }).deployments;
    assert.match(dep(gh(repo())).hint, /first sync runs within 15 minutes/);
    assert.strictEqual(dep(gh(repo())).state, 'waiting');
    assert.match(dep(gh(repo({ lastSyncedAt: '2026-10-16T10:00:00Z' }))).hint, /GitHub has no deployments .* "environment: test"/, 'synced but nothing deployed: how deployments come to exist');
    assert.deepStrictEqual([dep(gh(repo({ lastSyncError: 'boom' }))).state, dep(gh(repo({ lastSyncError: 'boom' }))).hint], ['problem', 'The sync failed for acme/web: see the error under GitHub.']);
    assert.match(dep(gh(repo({ rateLimitedUntil: '2026-10-16T12:00:00Z' }))).hint, /rate limit/);
    assert.deepStrictEqual([dep(gh(repo({ deployments: 4 }), repo({ fullName: 'acme/api' }))).state, dep(gh(repo({ deployments: 4 }), repo({ fullName: 'acme/api' }))).hint],
        ['done', 'Deployments from 1 of 2 repositories so far.']);

    const site = { name: 'acme', url: 'https://acme.atlassian.net' };
    const boards = (input) => byId({ ...empty, ...input }).boards;
    assert.deepStrictEqual([byId({ ...empty, jira: { connected: true, site: null } }).jira.hint], ['Choose which Jira site to use.']);
    assert.strictEqual(boards({ jira: { connected: true, site }, boards: null }).state, 'loading');
    assert.strictEqual(boards({ jira: { connected: true, site }, boards: { error: 'Jira says no' } }).state, 'problem');
    assert.strictEqual(boards({ jira: { connected: true, site }, boards: [{ selected: false }] }).state, 'todo');
    assert.strictEqual(boards({ jira: { connected: true, site, lastSyncedAt: null }, boards: [{ selected: true }] }).state, 'waiting');
    assert.strictEqual(boards({ jira: { connected: true, site, lastSyncedAt: '2026-10-16T10:00:00Z' }, boards: [{ selected: true }] }).state, 'done');

    const flags = (input) => byId({ ...empty, ...input }).flags;
    assert.match(flags({ sources: [{ name: 'LD', tokens: [{}] }, { name: 'Unused', tokens: [] }] }).hint, /first message from LD \(/);
    assert.strictEqual(flags({ sources: [{ name: 'LD', tokens: [] }] }).state, 'todo', 'a source without a token can\'t send anything');
    assert.strictEqual(flags({ sources: [{ name: 'LD', tokens: [{}] }], flagList: [{ key: 'a' }] }).state, 'done');
    assert.strictEqual(flags({ sources: { error: 'nope' } }).state, 'problem');
    assert.strictEqual(byId({ ...empty, workspace: { members: [{}], invitations: [{}] } }).team.state, 'waiting');
    assert.strictEqual(byId({ ...empty, workspace: { members: [{}, {}], invitations: null } }).team.state, 'done');
});

test('getting started: the checklist renders progress; once GitHub is done it can be hidden, and comes back on request', async () => {
    ui.settingsState.tenantId = TENANT;
    const step = (id, state, optional = false, extra = {}) => ({ id, title: `Step ${id}`, state, optional, hint: `<b>${id}</b>`, href: '#x', cta: 'Do it', ...extra });
    const fresh = str(ui.renderGettingStarted({ steps: [step('a', 'done'), step('b', 'todo'), step('c', 'waiting', true), step('d', 'unavailable', true)] }));
    assert.match(fresh, /id="getting-started"/);
    assert.match(fresh, /1 of 3 done\./, 'steps off on this server are not counted');
    assert.match(fresh, /<li class="checklist-step todo">[\s\S]*?<a class="btn btn-primary" href="#x">Do it<\/a>/);
    assert.ok(!/<li class="checklist-step done">[^]*?Do it[^]*?<\/li>\s*<li class="checklist-step todo"/.test(fresh), 'a done step has no button');
    assert.match(fresh, /&lt;b&gt;a&lt;\/b&gt;/, 'hints are escaped');
    assert.ok(!/hide-checklist/.test(fresh), 'not hideable before the dashboard has data');

    const ready = [step('a', 'done'), step('b', 'done'), step('c', 'todo', true)];
    const readyHtml = str(ui.renderGettingStarted({ steps: ready }));
    assert.match(readyHtml, /2 of 3 done — the dashboard is ready/);
    assert.match(readyHtml, /data-action="hide-checklist"/);
    assert.strictEqual(str(ui.renderGettingStarted({ steps: ready, hidden: true })), '');
    assert.match(str(ui.renderGettingStarted({ steps: [step('a', 'todo')], hidden: true })), /id="getting-started"/, 'hidden only once GitHub is done');
    assert.match(str(ui.renderGettingStarted({ steps: [step('a', 'done'), step('c', 'done', true)] })), /All set/);

    const stored = {};
    global.localStorage = { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } };
    try {
        await ui.runAction('hide-checklist', button({}, 'getting-started'));
        assert.deepStrictEqual(stored, { [`shipscope.checklistHidden.${TENANT}`]: '1' }, 'per workspace, in this browser');
    } finally {
        delete global.localStorage;
    }
});

test('invitation page: what an invitee sees -- join, already a member, or a link that no longer works', () => {
    const { invitationView } = require('../ui/invite.js');
    const tenant = { id: 't1', name: 'Acme <Corp>' };
    assert.deepStrictEqual(invitationView({ tenant, role: 'member', status: 'pending', alreadyMember: false }),
        { title: 'Join Acme <Corp>', text: 'You are invited to join Acme <Corp> on ShipScope as a member (you see everything; admins change settings).', accept: true, open: null });
    assert.match(invitationView({ tenant, role: 'admin', status: 'pending', alreadyMember: false }).text, /as an admin/);
    assert.deepStrictEqual(invitationView({ tenant, role: 'member', status: 'pending', alreadyMember: true }),
        { title: 'Acme <Corp>', text: 'You are already a member of Acme <Corp>.', accept: false, open: '/t/t1/' });
    for (const [status, text] of [['accepted', /already been used/], ['revoked', /withdrawn/], ['expired', /expired/]]) {
        const view = invitationView({ tenant, role: 'member', status, alreadyMember: false });
        assert.deepStrictEqual([view.accept, view.open], [false, null], status);
        assert.match(view.text, text);
        assert.match(view.text, /Ask an admin of Acme <Corp> for a new link/);
    }
});

test('settings page: form values, including a group of checkboxes', () => {
    assert.deepStrictEqual(ui.formValues(form([['boardIds', '10', true], ['boardIds', '11', false], ['boardIds', '12', true], ['note', 'x'], ['', 'ignored']])),
        { boardIds: ['10', '12'], note: 'x' });
    assert.deepStrictEqual(ui.formValues(form([['boardIds', '10', false]])), { boardIds: [] });
});

test('settings page: actions send what the API expects, then reload their section', async (t) => {
    ui.settingsState.tenantId = TENANT;
    ui.settingsState.tenant = { id: TENANT, role: 'admin' };
    ui.settingsState.features = { githubApp: true, jira: true };
    const base = `/tenants/${TENANT}`;
    const { fn, calls } = fakeFetch({
        [`POST ${base}/invitations`]: { url: 'https://s/invitations/tok' },
        [`POST ${base}/flag-sources`]: { source: { id: 's9' }, token: { id: 't9', token: 'sst_new' } },
        [`POST ${base}/jira/sync`]: { boards: 2, issues: 9, currentPi: '@now' },
        [`DELETE ${base}`]: null,
        [`GET ${base}/jira`]: { connected: false },
        [`GET ${base}/github`]: { installations: [], repos: [] },
        [`PUT ${base}/jira/boards/13`]: new Error('A PI template only applies to the "pi" or "auto" rhythm'),
    });
    t.mock.method(global, 'fetch', fn);

    await ui.runAction('save-boards', form([['boardIds', '10', true], ['boardIds', '13', true], ['boardIds', '14', false]]));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/jira/boards`, body: { boardIds: [10, 13] } });
    assert.deepStrictEqual(ui.settingsState.messages.jira, { error: false, text: '2 board(s) selected. Use "Sync now" or wait for the next sync.' });
    assert.ok(calls.some((c) => c.method === 'GET' && c.url === `${base}/jira`), 'the section is reloaded');

    calls.length = 0;
    await ui.runAction('save-rhythm', form([['rhythm', 'sprint'], ['piTemplate', 'PI {pi}']], { boardId: '10' }));
    assert.deepStrictEqual(calls[0].body, { rhythm: 'sprint', piTemplate: null }, 'a template only goes with pi/auto');
    calls.length = 0;
    await ui.runAction('save-rhythm', form([['rhythm', 'pi'], ['piTemplate', '  PI {pi} / Iteration {n} ']], { boardId: '10' }));
    assert.deepStrictEqual(calls[0].body, { rhythm: 'pi', piTemplate: 'PI {pi} / Iteration {n}' });

    await ui.runAction('save-rhythm', form([['rhythm', 'pi'], ['piTemplate', 'x']], { boardId: '13' }));
    assert.deepStrictEqual(ui.settingsState.messages.jira, { error: true, text: 'A PI template only applies to the "pi" or "auto" rhythm' }, 'the server\'s error, in its section');

    await ui.runAction('sync-jira', button({}, 'jira'));
    assert.strictEqual(ui.settingsState.messages.jira.text, 'Synced 2 board(s), 9 issue(s); now: @now.');

    calls.length = 0;
    await ui.runAction('save-repo-settings', form([['versionFile', '  '], ['driftIgnorePaths', ' .github/\n\nREADME.md\n.github/ ']], { repoId: '101' }, 'github'));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/github/repos/101/settings`, body: { versionFile: null, driftIgnorePaths: ['.github/', 'README.md'] } });

    ui.settingsState.installationRepos[7] = [{ id: 102, fullName: 'acme/api', tracked: false }];
    calls.length = 0;
    await ui.runAction('track-repo', button({ repoId: '102', installationId: '7' }, 'github'));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/github/repos/102`, body: { installationId: 7 } });
    assert.strictEqual(ui.settingsState.installationRepos[7][0].tracked, true);

    calls.length = 0;
    await ui.runAction('create-source', form([['name', ' LD '], ['kind', 'runtime'], ['priority', ''], ['repoId', '']], {}, 'flags'));
    assert.deepStrictEqual(calls[0].body, { name: 'LD', kind: 'runtime', repoId: null }, 'an empty priority takes the server default');
    assert.deepStrictEqual(ui.settingsState.once, { token: 'sst_new' });
    calls.length = 0;
    await ui.runAction('save-source', form([['name', 'LD'], ['kind', 'build'], ['priority', '5'], ['repoId', '101']], { sourceId: 's9' }, 'flags'));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/flag-sources/s9`, body: { name: 'LD', kind: 'build', priority: 5, repoId: 101 } });

    // Deleting the workspace: asks first, sends the typed name, then leaves for / (another workspace, or /start).
    global.location = { pathname: `/t/${TENANT}/settings`, assign: (url) => { global.location.assigned = url; } };
    global.confirm = () => false;
    calls.length = 0;
    await ui.runAction('delete-workspace', form([['confirmName', ' Acme ']], {}, 'workspace'));
    assert.deepStrictEqual(calls, [], 'cancelled: nothing sent');
    global.confirm = () => true;
    await ui.runAction('delete-workspace', form([['confirmName', ' Acme ']], {}, 'workspace'));
    assert.deepStrictEqual(calls[0], { method: 'DELETE', url: base, body: { confirmName: 'Acme' } });
    assert.strictEqual(global.location.assigned, '/');
    delete global.location;
    delete global.confirm;

    calls.length = 0;
    await ui.runAction('save-flag-link', form([['type', 'label'], ['prefix', ' flag: '], ['id', 'customfield_1']]));
    await ui.runAction('save-flag-link', form([['type', 'field'], ['prefix', 'flag:'], ['id', 'customfield_10050']]));
    await ui.runAction('save-flag-link', form([['type', 'none'], ['prefix', 'flag:']]));
    assert.deepStrictEqual(calls.filter((c) => c.method === 'PUT').map((c) => [c.url, c.body]), [
        [`${base}/jira/flag-link`, { type: 'label', prefix: 'flag:' }],
        [`${base}/jira/flag-link`, { type: 'field', id: 'customfield_10050' }],
        [`${base}/jira/flag-link`, { type: 'none' }],
    ], 'only what the chosen convention needs');
    calls.length = 0;
    await ui.runAction('save-flag', form([['description', '  '], ['jiraKeys', 'abc-1, ABC-2;abc-1  ']], { key: 'new.Checkout' }, 'flags'));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/flags/new.Checkout`, body: { description: null, jiraKeys: ['ABC-1', 'ABC-2'] } });
    assert.deepStrictEqual(ui.settingsState.messages.flags, { error: false, text: 'Saved new.Checkout.' });

    await ui.runAction('create-invitation', form([['role', 'admin']], {}, 'workspace'));
    assert.deepStrictEqual(ui.settingsState.once, { inviteUrl: 'https://s/invitations/tok' });
    await ui.runAction('dismiss-once', button({}, 'workspace'));
    assert.deepStrictEqual(ui.settingsState.once, {});

    // Destructive actions ask first; "no" sends nothing.
    global.confirm = () => false;
    calls.length = 0;
    await ui.runAction('disconnect-jira', button({}, 'jira'));
    await ui.runAction('delete-source', button({ sourceId: 's9' }, 'flags'));
    assert.deepStrictEqual(calls, []);
    global.confirm = () => true;
    await ui.runAction('revoke-token', button({ tokenId: 't9' }, 'flags'));
    assert.deepStrictEqual(calls[0], { method: 'DELETE', url: `${base}/ingest-tokens/t9`, body: undefined });
    delete global.confirm;
});

test('settings page: an API error carries the server\'s message; 401 goes through sign-in', async (t) => {
    t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ error: 'Tenant not found' }), { status: 404 }));
    await assert.rejects(ui.api('GET', '/x'), (err) => err instanceof ui.ApiError && err.status === 404 && err.message === 'Tenant not found');
    t.mock.method(global, 'fetch', async () => new Response('not json', { status: 500 }));
    await assert.rejects(ui.api('GET', '/x'), /Request failed \(HTTP 500\)/);
    const assigned = [];
    global.location = { pathname: `/t/${TENANT}/settings`, assign: (url) => assigned.push(url) };
    t.mock.method(global, 'fetch', async () => new Response('{}', { status: 401 }));
    await assert.rejects(ui.api('GET', '/x'), (err) => err.status === 401);
    assert.deepStrictEqual(assigned, [`/auth/github/login?returnTo=${encodeURIComponent(`/t/${TENANT}/settings`)}`]);
    delete global.location;
});

test('settings assets: only the listed ui/ files are ever read, whatever else the directory holds', (t) => {
    const fs = require('fs');
    const os = require('os');
    const { loadUiAssets } = require('../lib/dashboard-assets');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of ['settings.js', 'secret.js', '.env', 'settings.html', 'invite.html', 'invite.js', 'notes.md']) fs.writeFileSync(path.join(dir, name), name);
    const shared = new Map([['style.css', { body: 'css', type: 'text/css' }], ['app-data.js', { body: 'x', type: 'text/javascript' }]]);
    assert.deepStrictEqual([...loadUiAssets(dir, shared).keys()].sort(), ['invite.html', 'invite.js', 'settings.html', 'settings.js', 'style.css']);
    assert.deepStrictEqual([...loadUiAssets(path.join(dir, 'missing'), shared).keys()], ['style.css']);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, signInWithRedirect } = require('./helpers/auth');

const USERS = { alice: { id: 860_000_001, login: 'alice' }, bob: { id: 860_000_002, login: 'bob' }, mallory: { id: 860_000_003, login: 'mallory' } };

async function setup(t, options = {}) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub(USERS), ...options });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    return { app, alice, tenantId };
}

test('invitation link: a browser gets the page to join, other clients the JSON; signed out it goes through sign-in and back', async (t) => {
    const { app, alice, tenantId } = await setup(t);
    const link = new URL((await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice }, payload: { role: 'member' } })).json().url).pathname;
    const browser = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

    const anonymous = await app.inject({ method: 'GET', url: link, headers: browser });
    assert.strictEqual(anonymous.headers.location, `/auth/github/login?returnTo=${encodeURIComponent(link)}`);
    assert.strictEqual((await signInWithRedirect(app, 'bob', anonymous.headers.location)).location, link, 'back to the invitation after sign-in');

    const bob = await signIn(app, 'bob');
    const page = await app.inject({ method: 'GET', url: link, headers: browser, cookies: { sid: bob } });
    assert.strictEqual(page.statusCode, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.strictEqual(page.headers['referrer-policy'], 'same-origin', 'the token in the URL never leaves the site');
    assert.match(page.body, /<script src="\/ui\/invite\.js"><\/script>/);
    assert.ok(!page.body.includes('Acme'), 'the page itself holds nothing of the invitation; it asks for it');

    const json = await app.inject({ method: 'GET', url: link, headers: { accept: 'application/json' }, cookies: { sid: bob } });
    assert.deepStrictEqual(json.json(), { tenant: { id: tenantId, name: 'Acme' }, role: 'member', status: 'pending', alreadyMember: false });
    assert.strictEqual((await app.inject({ method: 'GET', url: link, cookies: { sid: bob } })).json().status, 'pending', 'no accept header: JSON');
    const accepted = await app.inject({ method: 'POST', url: `${link}/accept`, headers: { accept: 'application/json' }, cookies: { sid: bob } });
    assert.strictEqual(accepted.statusCode, 201);
    assert.deepStrictEqual(accepted.json(), { tenant: { id: tenantId, name: 'Acme' }, role: 'member' });

    // An unknown link: the page loads and then says so (it reads the 404 below).
    const unknown = `/invitations/${'A'.repeat(32)}`;
    assert.strictEqual((await app.inject({ method: 'GET', url: unknown, headers: browser, cookies: { sid: bob } })).statusCode, 200);
    assert.strictEqual((await app.inject({ method: 'GET', url: unknown, headers: { accept: 'application/json' }, cookies: { sid: bob } })).statusCode, 404);
});

test('settings page route: members only (any role), signed-out users go through sign-in and come back', async (t) => {
    const { app, alice, tenantId } = await setup(t);
    const page = `/t/${tenantId}/settings`;
    const anonymous = await app.inject({ method: 'GET', url: page });
    assert.strictEqual(anonymous.headers.location, `/auth/github/login?returnTo=${encodeURIComponent(page)}`);
    assert.strictEqual((await signInWithRedirect(app, 'alice', anonymous.headers.location)).location, page);

    const res = await app.inject({ method: 'GET', url: page, cookies: { sid: alice } });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.match(res.body, /<script src="\/ui\/settings\.js"><\/script>/);

    const bob = await signIn(app, 'bob');
    const link = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice }, payload: { role: 'member' } })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    assert.strictEqual((await app.inject({ method: 'GET', url: page, cookies: { sid: bob } })).statusCode, 200, 'members see it read-only');
    const mallory = await signIn(app, 'mallory');
    assert.strictEqual((await app.inject({ method: 'GET', url: page, cookies: { sid: mallory } })).statusCode, 404);
});

test('settings assets: only the page\'s own scripts and styles, plus the dashboard files they reuse', async (t) => {
    const { app } = await setup(t);
    for (const [name, type] of [['settings.js', /javascript/], ['start.js', /javascript/], ['invite.js', /javascript/], ['theme.js', /javascript/], ['settings.css', /css/], ['style.css', /css/], ['app-html.js', /javascript/], ['favicon.svg', /svg/]]) {
        const res = await app.inject({ method: 'GET', url: `/ui/${name}` });
        assert.strictEqual(res.statusCode, 200, name);
        assert.match(res.headers['content-type'], type, name);
    }
    for (const url of ['/ui/settings.html', '/ui/app-data.js', '/ui/web.js', '/ui/package.json', '/ui/..%2Fweb.js', '/ui/%2e%2e%2fweb.js']) {
        const res = await app.inject({ method: 'GET', url });
        assert.ok([400, 404].includes(res.statusCode), `${url} -> ${res.statusCode}`);
        assert.ok(!/module\.exports = \{ buildApp|"dependencies"/.test(res.body), `${url} leaked a file`);
    }
});

test('get started: someone without a workspace lands on /start and creates one; features say what this server has', async (t) => {
    const { app } = await setup(t);
    const mallory = await signIn(app, 'mallory');
    assert.strictEqual((await app.inject({ method: 'GET', url: '/', cookies: { sid: mallory } })).headers.location, '/start');
    const start = await app.inject({ method: 'GET', url: '/start', cookies: { sid: mallory } });
    assert.strictEqual(start.statusCode, 200);
    assert.match(start.body, /id="createTenant"/);
    const anonymous = await app.inject({ method: 'GET', url: '/start' });
    assert.strictEqual(anonymous.headers.location, '/auth/github/login?returnTo=%2Fstart');
    assert.strictEqual((await signInWithRedirect(app, 'mallory', anonymous.headers.location)).location, '/start');

    assert.deepStrictEqual((await app.inject({ method: 'GET', url: '/api/features' })).json(), { githubApp: false, jira: false, githubWebhooks: false, jiraWebhooks: false });
    const full = buildApp({ pool: null, auth: AUTH, githubApp: { appId: 1, slug: 's', privateKey: 'k' }, atlassian: { clientId: 'a', clientSecret: 'b', encryptionKey: Buffer.alloc(32) } });
    t.after(() => full.close());
    assert.deepStrictEqual((await full.inject({ method: 'GET', url: '/api/features' })).json(), { githubApp: true, jira: true, githubWebhooks: false, jiraWebhooks: false });
});
