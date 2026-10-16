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

test('settings page: the flag sources section -- sources, their tokens, a new token shown once', () => {
    const repos = [{ repoId: 101, fullName: 'acme/web' }];
    assert.match(str(ui.renderFlags({ flags: [], repos, admin: false, once: {}, origin: 'https://s' })), /Only admins manage flag sources/);
    assert.match(str(ui.renderFlags({ flags: null, repos, admin: true, once: {}, origin: 'https://s' })), /Loading/);
    const flags = [{ id: 's1', name: 'LaunchDarkly', kind: 'runtime', priority: 100, repoId: 101, tokens: [{ id: 't1', createdAt: '2026-10-01T10:00:00Z', lastUsedAt: null }] },
        { id: 's2', name: 'Build "files"', kind: 'build', priority: 0, repoId: null, tokens: [] }];
    const out = str(ui.renderFlags({ flags, repos, admin: true, once: { token: 'sst_secret' }, origin: 'https://s' }));
    assert.match(out, /<code>sst_secret<\/code>/);
    assert.match(out, /POST https:\/\/s\/api\/flags\/ingest/);
    assert.match(out, /data-source-id="s1"[\s\S]*?<option value="runtime" selected>runtime[\s\S]*?<option value="101" selected>acme\/web/);
    assert.match(out, /value="Build &quot;files&quot;"/);
    assert.match(out, /data-action="revoke-token" data-token-id="t1"/);
    assert.match(out, /none — the source can&#39;t send anything/);
    assert.match(out, /data-action="create-source"/);
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
    for (const name of ['settings.js', 'secret.js', '.env', 'settings.html', 'notes.md']) fs.writeFileSync(path.join(dir, name), name);
    const shared = new Map([['style.css', { body: 'css', type: 'text/css' }], ['app-data.js', { body: 'x', type: 'text/javascript' }]]);
    assert.deepStrictEqual([...loadUiAssets(dir, shared).keys()].sort(), ['settings.html', 'settings.js', 'style.css']);
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
    for (const [name, type] of [['settings.js', /javascript/], ['start.js', /javascript/], ['theme.js', /javascript/], ['settings.css', /css/], ['style.css', /css/], ['app-html.js', /javascript/], ['favicon.svg', /svg/]]) {
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
