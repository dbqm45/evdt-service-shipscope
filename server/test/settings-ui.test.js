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
// A button on a page whose section differs from its id (Members, Sources, ...): the message goes to the section.
const pageButton = (dataset, page, section) => ({ dataset, closest: () => ({ id: page, dataset: { section } }) });

test('settings page: General, Members and Danger zone -- admins invite and remove, members only leave; every value escaped', () => {
    const workspace = {
        settings: { deploymentRetentionDays: 90 },
        members: [{ userId: 'u1', githubLogin: 'alice', role: 'admin' }, { userId: 'u2', githubLogin: '<img src=x onerror=alert(1)>', role: 'member' }],
        invitations: [{ id: 'i1', role: 'member', createdBy: 'alice', expiresAt: '2026-10-20T10:00:00Z' }],
    };
    const general = str(ui.renderGeneral({ workspace, admin: true }));
    assert.match(general, /<section class="settings-page" id="general" data-section="workspace">/);
    assert.match(general, /name="deploymentRetentionDays" type="number" min="7" max="730" required value="90"/);
    const memberGeneral = str(ui.renderGeneral({ workspace, admin: false }));
    assert.match(memberGeneral, /only admins can change settings/);
    assert.match(memberGeneral, /kept for 90 days/);
    assert.ok(!/deploymentRetentionDays/.test(memberGeneral));
    assert.match(str(ui.renderGeneral({ workspace: null, admin: true })), /Loading/);

    // G1.5: outgoing events, for admins: the subscriptions with their state, a form, the signing secret it uses.
    const subs = [{ id: 's1', url: 'https://pdi.acme.io/hooks', types: ['feature.released'], lastError: 'pdi.acme.io answered HTTP 500', lastDeliveredAt: null, pending: 2 }];
    const withEvents = str(ui.renderGeneral({ workspace, admin: true, eventSubscriptions: subs }));
    assert.match(withEvents, /Outgoing events/);
    assert.match(withEvents, /https:\/\/pdi\.acme\.io\/hooks/);
    assert.match(withEvents, /2 waiting/);
    assert.match(withEvents, /settings-error">pdi\.acme\.io answered HTTP 500/);
    assert.match(withEvents, /data-action="remove-event-subscription" data-subscription-id="s1"/);
    assert.match(withEvents, /data-action="add-event-subscription"/);
    assert.match(withEvents, /name="types" value="release\.stage_changed" checked/);
    assert.match(withEvents, /signing secret/);
    assert.ok(!/Outgoing events/.test(str(ui.renderGeneral({ workspace, admin: false, eventSubscriptions: subs }))), 'admins only');

    // F5: service tokens, for admins: listed without the token, a form, revoke; a new token shown once.
    const tokens = [{ id: 't1', name: '<b>pdi</b>', createdAt: '2026-10-26T10:00:00Z', expiresAt: '2027-10-26T10:00:00Z', lastUsedAt: null }];
    const withTokens = str(ui.renderGeneral({ workspace, admin: true, serviceTokens: tokens, once: {} }));
    assert.match(withTokens, /Service tokens/);
    assert.match(withTokens, /&lt;b&gt;pdi&lt;\/b&gt;/, 'the name is escaped');
    assert.match(withTokens, /never used/);
    assert.match(withTokens, /data-action="revoke-service-token" data-token-id="t1"/);
    assert.match(withTokens, /data-action="create-service-token"/);
    assert.match(withTokens, /name="lifetimeDays"/);
    assert.match(withTokens, /\/api\/service\/v1\/items\//);
    const fresh = str(ui.renderGeneral({ workspace, admin: true, serviceTokens: tokens, once: { serviceToken: 'shps_abc' } }));
    assert.match(fresh, /Service token — shown only once[\s\S]*shps_abc/);
    assert.ok(!/Service tokens/.test(str(ui.renderGeneral({ workspace, admin: false, serviceTokens: tokens, once: {} }))), 'admins only');
    assert.match(str(ui.renderGeneral({ workspace, admin: true, serviceTokens: { error: 'boom' }, once: {} })), /settings-error">boom/);

    const admin = str(ui.renderMembers({ workspace, admin: true, meId: 'u1', once: {} }));
    assert.match(admin, /id="members" data-section="workspace"/);
    assert.match(admin, /data-action="remove-member" data-user-id="u1" data-self="1">Leave/);
    assert.match(admin, /data-action="remove-member" data-user-id="u2">Remove/);
    assert.match(admin, /data-action="create-invitation"/);
    assert.match(admin, /data-action="revoke-invitation" data-invitation-id="i1"/);
    assert.ok(!admin.includes('<img'), 'a GitHub login is escaped');
    assert.match(admin, /&lt;img src=x/);
    const member = str(ui.renderMembers({ workspace: { ...workspace, invitations: null }, admin: false, meId: 'u2', once: {} }));
    assert.match(member, /only admins can change settings/);
    assert.ok(!/create-invitation|data-user-id="u1"/.test(member), 'a member sees no admin controls');
    assert.match(member, /data-user-id="u2" data-self="1">Leave/);
    const once = str(ui.renderMembers({ workspace, admin: true, meId: 'u1', once: { inviteUrl: 'https://x/invitations/abc"><b>' } }));
    assert.match(once, /shown only once/);
    assert.ok(once.includes('https://x/invitations/abc&quot;&gt;&lt;b&gt;'));
    assert.match(str(ui.renderMembers({ workspace: null, admin: true, meId: 'u1', once: {} })), /Loading/);

    const danger = str(ui.renderDangerZone({ tenantName: 'Acme <Corp>' }));
    assert.match(danger, /id="danger" data-section="workspace"/);
    assert.match(danger, /data-action="delete-workspace"/);
    assert.match(danger, /Type <strong>Acme &lt;Corp&gt;<\/strong> to confirm <input name="confirmName" required/, 'the name to type, escaped');
});

test('settings page: GitHub -- installations, the tracked repositories table, the track picker and per-repo settings', () => {
    assert.match(str(ui.renderGitHub({ enabled: false, admin: true })), /not configured on this server/);
    assert.match(str(ui.renderGitHub({ enabled: true, github: null, admin: true })), /Loading/);
    const github = {
        installations: [{ installationId: 7, accountLogin: 'acme', accountType: 'Organization' }, { installationId: 8, accountLogin: 'solo', accountType: 'User' }],
        repos: [{ repoId: 101, fullName: 'acme/web-service-frontend', installationId: 7, lastSyncedAt: null, lastSyncError: 'boom "quoted"', versionFile: 'trigger.properties', driftIgnorePaths: ['.github/', 'README.md'] }],
    };
    const installationRepos = { 7: [{ id: 101, fullName: 'acme/web', private: true, tracked: true }, { id: 102, fullName: 'acme/api', private: false, tracked: false }], 8: 'loading' };
    const admin = str(ui.renderGitHub({ enabled: true, github, installationRepos, admin: true }));
    assert.match(admin, /data-action="open-track-picker">[\s\S]*Track repository<\/button>/);
    assert.match(admin, /<strong>acme<\/strong><span class="settings-muted"> · Organization<\/span>/);
    assert.match(admin, /GitHub App installed · 1 repository tracked · new deployments arrive with the periodic sync/);
    assert.match(admin, /href="https:\/\/github\.com\/organizations\/acme\/settings\/installations\/7"/);
    assert.match(admin, /href="https:\/\/github\.com\/settings\/installations\/8"/, 'a user account\'s installation');
    assert.match(admin, /data-action="unlink-installation" data-installation-id="8"/);
    assert.match(admin, /<span class="settings-badge">FE<\/span><span><strong>web-service-frontend<\/strong><span class="settings-row-meta">acme<\/span>/);
    assert.match(admin, /<td class="mono">trigger\.properties<\/td>\s*<td class="mono">\.github\/, README\.md<\/td>/);
    assert.match(admin, /class="settings-sync fail" title="boom &quot;quoted&quot;">sync failed/);
    // F1: a changes folder that could not be read shows under the sync state, with what failed.
    const withItems = str(ui.renderGitHub({ enabled: true, github: { ...github, repos: [{ ...github.repos[0], lastSyncError: null, workItemsError: 'docs/project/changes/CHG-14/plan.md: no YAML header' }] }, installationRepos, admin: true }));
    assert.match(withItems, /class="settings-sync warn" title="docs\/project\/changes\/CHG-14\/plan\.md: no YAML header">changes folder: 1 problem/);
    assert.match(admin, /data-action="edit-repo" data-repo-id="101"/);
    assert.match(admin, /data-action="untrack-repo" data-repo-id="101" data-installation-id="7" aria-label="Stop tracking acme\/web-service-frontend"/);
    assert.ok(!/save-repo-settings|data-action="track-repo"/.test(admin), 'no edit form or picker until asked');

    const picker = str(ui.renderGitHub({ enabled: true, github, installationRepos, admin: true, picker: true }));
    assert.match(picker, /data-action="track-repo" data-repo-id="102" data-installation-id="7">Track/);
    assert.match(picker, /data-action="untrack-repo" data-repo-id="101" data-installation-id="7">Stop tracking/);
    assert.match(picker, /Loading repositories/);
    assert.match(picker, /data-action="close-track-picker"/);
    assert.match(picker, /href="\/tenants\/[^/]+\/github\/install">install the App on another account/);

    const editing = str(ui.renderGitHub({ enabled: true, github, installationRepos: {}, admin: true, editing: 101 }));
    assert.match(editing, /name="versionFile" placeholder="e.g. trigger.properties" value="trigger.properties"/);
    assert.match(editing, />\.github\/\nREADME\.md<\/textarea>/);
    assert.ok(!/<form[^>]*>(?:(?!<\/form>).)*<form/s.test(editing), 'no form inside another form');
    assert.match(editing, /data-flag-stance="unknown"[\s\S]*<select name="flagStance"><option value="unknown" selected>Not set[\s\S]*<option value="none" >This repository has no feature flags/);
    assert.match(editing, /data-service-role=""[\s\S]*<select name="serviceRole"><option value="" selected>Not set<\/option><option value="frontend" >Frontend/, "the role: frontend or backend, for the dashboard's FE on, BE off warning");
    assert.match(editing, /Environments: none seen yet/);
    const withEnvs = str(ui.renderGitHub({ enabled: true, github: { ...github, repos: [{ ...github.repos[0], seenEnvironments: ['staging', 'Production'], envMap: { Staging: 'qa' } }] }, installationRepos: {}, admin: true, editing: 101 }));
    assert.match(withEnvs, /name="envName0" value="staging">staging <select name="envChoice0"><option value="auto" >auto \(skipped\)[\s\S]*<option value="qa" selected>qa/);
    assert.match(withEnvs, /name="envName1" value="Production">Production <select name="envChoice1"><option value="auto" selected>auto \(prod\)/);
    assert.match(withEnvs, /data-env-map="\{&quot;Staging&quot;:&quot;qa&quot;\}"/);
    assert.match(admin, /<th>Flags<\/th>/);
    assert.match(admin, /<td>not set<\/td>/);
    assert.match(str(ui.renderGitHub({ enabled: true, github: { ...github, repos: [{ ...github.repos[0], flagStance: 'none' }] }, installationRepos: {}, admin: false })), /<td>none<\/td>/);

    // The repository's card also holds its flags: set up from here when nothing reads them yet.
    const card = (extra) => str(ui.renderGitHub({ enabled: true, github, installationRepos: {}, admin: true, editing: 101, ...extra }));
    assert.match(card({ sources: null }), /Loading flag sources/);
    assert.match(card({ sources: { error: 'nope' } }), /settings-error">nope/);
    const unread = card({ sources: [] });
    assert.match(unread, /<form class="settings-form" data-action="create-code-source" data-place="github" data-section="github">/);
    assert.match(unread, /name="name" required maxlength="100" value="web-service-frontend flags"/);
    assert.match(unread, /<input type="hidden" name="repoId" value="101">/);
    assert.match(unread, /data-action="find-flag-files"[\s\S]*data-action="preview-code-source"/);
    const codeSource = { id: 's3', name: 'Web code', origin: 'code', repoIds: [101], code: { file: 'src/flags.ts' }, environments: [{ env: 'prod', state: 'fresh', observedAt: '2026-10-01T10:00:00Z' }], effectiveStaleAfterMinutes: null };
    const covered = card({ sources: [codeSource, { id: 's4', name: 'LaunchDarkly', origin: 'push', repoIds: [101] }, { id: 's5', name: 'Other', origin: 'code', repoIds: [102], code: { file: 'x.json' } }] });
    assert.match(covered, /Web code: ShipScope reads <code>src\/flags.ts<\/code> at each deployment/);
    assert.match(covered, /prod: confirmed/);
    assert.match(covered, /Sent by LaunchDarkly \(Sources\)/);
    assert.doesNotMatch(covered, /x\.json|data-place="github"/, 'another repo\'s source, and no set-up form when one reads it');
    assert.match(str(ui.renderGitHub({ enabled: true, github: { ...github, repos: [{ ...github.repos[0], flagStance: 'none' }] }, installationRepos: {}, admin: true, editing: 101, sources: [] })), /Declared without feature flags/);
    const wizardHere = { draft: { repoId: 101, name: 'Web', file: 'flags.json' }, found: { ref: 'a'.repeat(40), truncated: false, candidates: [{ file: 'flags.json', flags: { a: { state: 'on' } }, readFrom: 'flags.json' }] }, preview: null, place: 'github' };
    assert.match(card({ sources: [], wizard: wizardHere }), /value="flags.json"[\s\S]*data-action="use-flag-file" data-index="0"/);
    assert.doesNotMatch(str(ui.renderSourcesPage({ sources: [], repos: [{ repoId: 101, fullName: 'acme/web' }], admin: true, once: {}, origin: 'https://s', wizard: wizardHere })), /use-flag-file/, 'the helper shows on the form it was started from');

    const paused = { ...github, repos: [{ ...github.repos[0], rateLimitedUntil: '2026-10-16T12:10:00.000Z' }] };
    assert.match(str(ui.renderGitHub({ enabled: true, github: paused, installationRepos: {}, admin: false })),
        /class="settings-sync warn" title="GitHub asked ShipScope to slow down[^"]*">paused by GitHub's rate limit until /, 'a pause, not a failure');
    const live = str(ui.renderGitHub({ enabled: true, webhooks: true, github, installationRepos: {}, admin: true }));
    assert.match(live, /Instant updates on/);
    assert.match(live, /a deployment shows up within a minute/);
    const none = str(ui.renderGitHub({ enabled: true, github: { installations: [], repos: [] }, installationRepos: {}, admin: true }));
    assert.match(none, /href="\/tenants\/[^/]+\/github\/install">[\s\S]*Install the GitHub App<\/a>/, 'nothing to track from yet: install first');
    const member = str(ui.renderGitHub({ enabled: true, github, installationRepos: {}, admin: false }));
    assert.ok(!/data-action=|github\/install/.test(member), 'read-only for members');
    assert.match(member, /trigger\.properties/);
});

test('settings page: repository badges and workspace initials', () => {
    assert.deepStrictEqual(['enercity/evapl-service-frontend', 'enercity/evnm-service-charger-infrastructure', 'x/evboweb-service-bff', 'x/evsim-service-sim-adapter', 'x/backend', 'x/api', 'web']
        .map(ui.repoBadge), ['FE', 'CH', 'BF', 'SI', 'BE', 'AP', 'WE']);
    assert.deepStrictEqual(['eMobility Sparks', 'enercity', 'a-b'].map(ui.initials), ['ES', 'EN', 'AB']);
});

test('settings page: the hash picks the page; old links and members land somewhere sensible', () => {
    const page = (hash, admin = true, setupDone = true) => ui.pageFromHash({ hash, admin, setupDone });
    assert.strictEqual(page('#github'), 'github');
    assert.strictEqual(page('#workspace'), 'general', 'the old section name');
    assert.strictEqual(page('#getting-started'), 'getting-started');
    assert.strictEqual(page('#getting-started', false), 'general', 'members have no checklist');
    assert.strictEqual(page('#danger', false), 'general', 'nor a danger zone');
    assert.strictEqual(page(''), 'general');
    assert.strictEqual(page('', true, false), 'getting-started', 'an admin without a working dashboard starts with the checklist');
    assert.strictEqual(page('#nope', false, false), 'general');
});

test('settings page: the sidebar -- pages by group with counts, the open one marked, the Setup card for admins', () => {
    const steps = [
        { id: 'github-app', state: 'done', optional: false, title: 'Install the GitHub App', href: '#github', cta: null },
        { id: 'deployments', state: 'waiting', optional: false, title: 'First deployments arrive', href: null, cta: null },
        { id: 'boards', state: 'waiting', optional: true, title: 'Choose Jira boards', href: '#jira', cta: 'Sync now' },
        { id: 'flags', state: 'problem', optional: true, title: 'Send <flags>', href: '#sources', cta: null },
        { id: 'team', state: 'unavailable', optional: true, title: 'Off', href: null, cta: null },
    ];
    const admin = str(ui.renderSidebar({ page: 'github', tenant: { name: 'eMobility <Sparks>', role: 'admin' }, admin: true, counts: { members: 3, github: 6, jira: 1, sources: 2 }, steps }));
    assert.match(admin, /<span class="settings-avatar">ES<\/span>/);
    assert.match(admin, /<strong>eMobility &lt;Sparks&gt;<\/strong><span>You are admin · 3 members<\/span>/);
    assert.match(admin, /href="#github" class="settings-nav-item active" aria-current="page">[\s\S]*?<span class="settings-count">6<\/span>/, 'waiting on GitHub, not on the admin: a plain count');
    assert.match(admin, /href="#jira"[\s\S]*?<span class="settings-count warn">1<\/span>/, 'a step waiting on the admin');
    assert.match(admin, /href="#sources"[\s\S]*?<span class="settings-count fail">2<\/span>/);
    assert.match(admin, /href="#flags" class="settings-nav-item" >[\s\S]*?Flags<\/span><\/a>/, 'no count before the list is loaded');
    assert.match(admin, /href="#danger"/);
    assert.match(admin, /<b>1<\/b> of 4 done/, 'steps off on this server are not counted');
    assert.match(admin, /<li class="waiting">First deployments arrive — waiting for a GitHub Deployment<\/li>/);
    assert.match(admin, /<li class="waiting">Choose Jira boards — sync pending<\/li>/);
    assert.match(admin, /<li class="problem">Send &lt;flags&gt; — needs attention<\/li>/);
    assert.match(admin, /href="#getting-started">View checklist/);

    const member = str(ui.renderSidebar({ page: 'general', tenant: { name: 'Acme', role: 'member' }, admin: false, counts: { members: 1 }, steps: [] }));
    assert.match(member, /You are member · 1 member</);
    assert.ok(!/#danger|settings-setup|>Other</.test(member), 'no danger zone (nor its empty group) or setup card for members');

    assert.strictEqual(str(ui.SetupCard({ steps: steps.map((st) => ({ ...st, state: st.state === 'unavailable' ? st.state : 'done' })) })), '', 'all done: no card');
    assert.strictEqual(str(ui.SetupCard({ steps: [{ ...steps[0] }, { ...steps[2], state: 'todo' }], hidden: true })), '', 'hidden after the required steps');
    assert.match(str(ui.SetupCard({ steps: [{ ...steps[0], state: 'todo' }], hidden: true })), /settings-setup/, 'hidden only once GitHub is done');
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
    const member = str(ui.renderFlags({ flagList, admin: false, jiraUrl: 'https://acme.atlassian.net' }));
    assert.match(str(ui.renderSourcesPage({ sources: null, repos, admin: false, once: {}, origin: 'https://s' })), /Only admins manage flag sources/);
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

    const admin = str(ui.renderFlags({ flagList, admin: true }));
    assert.match(admin, /data-action="save-flag" data-key="newCheckout"/);
    assert.match(admin, /name="description" maxlength="500" value="New checkout" placeholder="from LD"/);
    assert.match(admin, /name="jiraKeys" value="ABC-3"/);
    assert.match(admin, /ABC-1 <span/, 'without a Jira site URL, keys are plain text');
    const sourcesPage = (sources, once = {}) => str(ui.renderSourcesPage({ sources, repos, admin: true, once, origin: 'https://s' }));
    assert.match(sourcesPage([]), /No flag source yet/);
    assert.match(sourcesPage([]), /id="sources" data-section="flags"/, 'its messages are the flags section\'s');
    assert.match(str(ui.renderFlags({ flagList: [], admin: true })), /No flags yet/);
    assert.match(str(ui.renderFlags({ flagList: { error: 'boom' }, admin: true })), /settings-error">boom/);

    assert.match(sourcesPage(null), /<p class="settings-loading">Loading/);
    const sources = [{ id: 's1', name: 'LaunchDarkly', kind: 'runtime', priority: 100, repoIds: [101], repoId: 101, tokens: [{ id: 't1', createdAt: '2026-10-01T10:00:00Z', lastUsedAt: null }] },
        { id: 's2', name: 'Build "files"', kind: 'build', priority: 0, repoIds: [], repoId: null, tokens: [] }];
    const out = sourcesPage(sources, { token: 'sst_secret' });
    assert.match(out, /<code>sst_secret<\/code>/);
    assert.match(out, /POST https:\/\/s\/api\/flags\/ingest/);
    assert.match(out, /data-source-id="s1"[\s\S]*?<option value="runtime" selected>runtime[\s\S]*?<legend>Applies to<\/legend><label class="inline"><input type="checkbox" name="repoIds" value="101" checked> acme\/web/);
    assert.match(out, /data-source-id="s2"[\s\S]*?name="repoIds" value="101" > acme\/web[\s\S]*?Applies to no repository/, 'a source covering nothing says so');
    assert.doesNotMatch(out.slice(0, out.indexOf('data-source-id="s2"')), /Applies to no repository/);
    assert.match(out, /value="Build &quot;files&quot;"/);
    assert.match(out, /data-action="revoke-token" data-token-id="t1"/);
    assert.match(out, /none — the source can&#39;t send anything/);
    assert.match(out, /data-action="create-source"/);
    assert.match(sourcesPage({ error: 'nope' }), /settings-error">nope/);

    // Freshness per environment, and how long a confirmation counts.
    const fresh = sourcesPage([{ ...sources[0], staleAfterMinutes: 90, effectiveStaleAfterMinutes: 90, environments: [
        { env: 'prod', state: 'fresh', observedAt: '2026-10-01T10:00:00Z' }, { env: 'qa', state: 'stale', observedAt: '2026-09-01T10:00:00Z' },
        { env: 'test', state: 'error', observedAt: null },
    ] }]);
    assert.match(fresh, /<span class="state-tag ok" title="last full state [^"]+">prod: confirmed \S/);
    assert.match(fresh, /<span class="state-tag warn"[^>]*>qa: not confirmed since \S/);
    assert.match(fresh, /<span class="state-tag fail" title="no full state yet">test: refused<\/span>/);
    assert.match(fresh, /stale after 90 min/);
    assert.match(fresh, /name="staleAfterMinutes" type="number" min="5" max="43200" placeholder="default" value="90"/);
    assert.match(sourcesPage([{ ...sources[0], effectiveStaleAfterMinutes: 1440, environments: [] }]), /No environment confirmed yet[\s\S]*stale after 24 h/);
    assert.match(sourcesPage([{ ...sources[1], effectiveStaleAfterMinutes: null, environments: [] }]), /never stale/);

    // A source read from code: its file and repository instead of tokens; a form to add one.
    const fromCode = sourcesPage([{ id: 's3', name: 'Web code', kind: 'build', priority: 0, origin: 'code', repoIds: [101], code: { file: 'config/flags.{env}.json', path: 'features' }, tokens: [], environments: [], effectiveStaleAfterMinutes: null }]);
    assert.match(fromCode, /data-action="save-source" data-source-id="s3" data-origin="code"/);
    assert.match(fromCode, /name="file" required maxlength="200" placeholder="config\/flags.\{env\}.json" value="config\/flags.\{env\}.json"/);
    assert.match(fromCode, /name="path" maxlength="100" placeholder="features" value="features"/);
    assert.match(fromCode, /ShipScope reads <code>config\/flags.\{env\}.json<\/code> in acme\/web at each environment's latest successful deployment/);
    assert.doesNotMatch(fromCode, /data-source-id="s3"[\s\S]*data-action="new-token" data-source-id="s3"/, 'no token for it');
    assert.match(fromCode, /data-action="create-code-source"/);
    assert.match(str(ui.renderSourcesPage({ sources: [], repos: [], admin: true, once: {}, origin: 'https://s' })), /Track a repository first/);
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

test('settings page: the Jira section offers the release-line convention -- release: labels by default, a fixVersion, a field', () => {
    const jira = { connected: true, site: { cloudId: 'c1', name: 'acme', url: 'https://acme.atlassian.net' }, lastError: null, flagLink: null, releaseLink: { type: 'label', prefix: 'release:' } };
    const fields = [{ id: 'customfield_10050', name: 'Release line', type: 'options' }, { id: 'customfield_10051', name: 'Flags', type: 'labels' }];
    const byLabel = str(ui.renderJira({ enabled: true, jira, boards: [], admin: true, flagFields: fields }));
    assert.match(byLabel, /data-action="save-release-link"/);
    assert.match(byLabel, /<option value="label" selected>In labels with a prefix/);
    assert.match(byLabel, /name="prefix" maxlength="30" value="release:" >/);
    assert.match(byLabel, /release:R1/, 'the convention is explained with an example');
    assert.doesNotMatch(byLabel.split('save-release-link')[1], /Flags \(labels\)/, 'a labels field can\'t hold one line');
    const byVersion = str(ui.renderJira({ enabled: true, jira: { ...jira, releaseLink: { type: 'fixVersion', prefix: '' } }, boards: [], admin: true, flagFields: fields }));
    assert.match(byVersion, /<option value="fixVersion" selected>/);
    assert.ok(!/save-release-link/.test(str(ui.renderJira({ enabled: true, jira, boards: [], admin: false }))), 'members don\'t');
});

test('flag source status: none yet, accepted with what it did, refused with why (until a later message is accepted)', () => {
    const src = (extra) => ({ lastIngestAt: null, lastIngest: null, lastError: null, ...extra });
    assert.match(str(ui.SourceStatus(src())), /state-tag warn">no message yet/);
    const ok = str(ui.SourceStatus(src({ lastIngestAt: '2026-10-16T10:00:00Z', lastIngest: { flags: 3, changed: 1, removed: 2, stale: 1 } })));
    assert.match(ok, /state-tag ok">received /);
    assert.match(ok, /3 flag\(s\), 1 changed, 2 removed, 1 older than stored/);
    const error = { at: '2026-10-16T11:00:00Z', message: 'body/observations/0/env must be <one of>' };
    const refused = str(ui.SourceStatus(src({ lastIngestAt: '2026-10-16T10:00:00Z', lastIngest: { flags: 3, changed: 0, removed: 0, stale: 0 }, lastError: error })));
    assert.match(refused, /state-tag fail">last message refused /);
    assert.match(refused, /must be &lt;one of&gt;/, 'the reason is escaped');
    assert.match(str(ui.SourceStatus(src({ lastIngestAt: '2026-10-16T12:00:00Z', lastIngest: { flags: 3, changed: 0, removed: 0, stale: 0 }, lastError: error }))),
        /received /, 'an older refusal is history');
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

    // A source read from code: waiting for its first read, or a file it could not read.
    const code = (environments) => ({ name: 'Web code', origin: 'code', tokens: [], environments, lastError: null });
    assert.deepStrictEqual([byId({ ...empty, sources: [code([])] }).flags.state, byId({ ...empty, sources: [code([])] }).flags.hint],
        ['waiting', 'Waiting for a deployment: Web code is read at the next sync of its repository.']);
    assert.deepStrictEqual([byId({ ...empty, sources: [code([{ env: 'prod', state: 'error' }])] }).flags.state, byId({ ...empty, sources: [code([{ env: 'prod', state: 'error' }])] }).flags.hint],
        ['problem', 'Could not read the flags file of Web code: see the source for why.']);
    // A source read from an endpoint: waiting for its first read, or an endpoint it could not read.
    const endpoint = (environments) => ({ name: 'Flags API', origin: 'endpoint', tokens: [], environments, lastError: null });
    assert.deepStrictEqual([byId({ ...empty, sources: [endpoint([])] }).flags.state, byId({ ...empty, sources: [endpoint([])] }).flags.hint],
        ['waiting', 'Waiting for the first read: ShipScope reads the endpoint of Flags API within a minute.']);
    assert.deepStrictEqual([byId({ ...empty, sources: [endpoint([{ env: 'qa', state: 'error' }])] }).flags.state, byId({ ...empty, sources: [endpoint([{ env: 'qa', state: 'error' }])] }).flags.hint],
        ['problem', 'Could not read the endpoint of Flags API: see the source for why.']);
    assert.match(byId(empty).flags.hint, /flags file in your code/);

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
    const refused = { name: 'LD', tokens: [{}], lastIngestAt: null, lastError: { at: '2026-10-16T10:00:00Z', message: 'conflicting values for a.prod' } };
    assert.deepStrictEqual([flags({ sources: [refused] }).state, flags({ sources: [refused] }).hint], ['problem', 'Message refused: LD — conflicting values for a.prod']);
    assert.strictEqual(flags({ sources: [{ ...refused, lastIngestAt: '2026-10-16T11:00:00Z' }] }).state, 'waiting', 'accepted since: no longer a problem');
    assert.strictEqual(byId({ ...empty, workspace: { members: [{}], invitations: [{}] } }).team.state, 'waiting');
    assert.strictEqual(byId({ ...empty, workspace: { members: [{}, {}], invitations: null } }).team.state, 'done');
});

test('tokens: expiry and scope shown on each token; the checklist warns before a source\'s last token runs out', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    const tok = (expiresAt, environments = null) => ({ id: 't1', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, expiresAt, environments });
    assert.strictEqual(ui.tokenState(tok(null), now), 'ok');
    assert.strictEqual(ui.tokenState(tok('2027-01-01T00:00:00Z'), now), 'ok');
    assert.strictEqual(ui.tokenState(tok('2026-11-10T00:00:00Z'), now), 'expiring');
    assert.strictEqual(ui.tokenState(tok('2026-10-24T11:59:00Z'), now), 'expired');
    assert.match(str(ui.TokenLine(tok(null), now)), /never expires/);
    assert.match(str(ui.TokenLine(tok('2026-11-10T00:00:00Z', ['qa', 'test']), now)), /state-tag warn">expires [^<]+<\/span>, only qa, test/);
    assert.match(str(ui.TokenLine(tok('2026-10-01T00:00:00Z'), now)), /state-tag fail">expired /);

    const page = str(ui.renderSourcesPage({ sources: [{ id: 's1', name: 'CI', kind: 'build', priority: 0, repoId: null, tokens: [tok(null)] }], repos: [], admin: true, once: {}, origin: 'https://s' }));
    assert.match(page, /<form class="settings-form" data-action="new-token" data-source-id="s1">[\s\S]*?<option value="365">1 year[\s\S]*?<option value="never">never expires[\s\S]*?name="environments" value="prod" checked/);
    assert.match(page, /data-action="create-source">[\s\S]*?name="tokenExpiresInDays"/);

    const steps = (tokens) => Object.fromEntries(ui.onboardingSteps({
        features: { githubApp: false, jira: false }, github: null, jira: null, boards: null, workspace: { members: [{}, {}], invitations: [] },
        sources: [{ name: 'CI', tokens }], flagList: [{ key: 'a' }], now,
    }).map((st) => [st.id, st]));
    assert.strictEqual(steps([tok(null)]).flags.state, 'done');
    assert.deepStrictEqual([steps([tok('2026-11-10T00:00:00Z')]).flags.state, steps([tok('2026-11-10T00:00:00Z')]).flags.cta], ['waiting', 'New token']);
    assert.strictEqual(steps([tok('2026-11-10T00:00:00Z'), tok(null)]).flags.state, 'done', 'another token keeps the source going');
    assert.strictEqual(steps([tok('2026-10-01T00:00:00Z')]).flags.state, 'problem');
    assert.match(steps([tok('2026-10-01T00:00:00Z')]).flags.hint, /tokens of CI have expired/);
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
        [`POST ${base}/flag-sources/s9/tokens`]: { id: 't10', token: 'sst_tok', expiresAt: null, environments: null },
        [`POST ${base}/jira/sync`]: { boards: 2, issues: 9, currentPi: '@now' },
        [`DELETE ${base}`]: null,
        [`GET ${base}/jira`]: { connected: false },
        [`GET ${base}/github`]: { installations: [], repos: [] },
        [`PUT ${base}/jira/boards/13`]: new Error('A PI template only applies to the "pi" or "auto" rhythm'),
        [`DELETE ${base}/ingest-tokens/t8`]: new Error('Token not found'),
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

    ui.settingsState.github = { installations: [{ installationId: 7 }], repos: [] };
    const { fn: picked } = fakeFetch({ [`GET ${base}/github/installations/7/repositories`]: { repositories: [{ id: 102, fullName: 'acme/api', tracked: false }] } });
    global.fetch = picked;
    await ui.runAction('open-track-picker', button({}, 'github'));
    assert.strictEqual(ui.settingsState.trackPicker, true);
    assert.deepStrictEqual(ui.settingsState.installationRepos[7], [{ id: 102, fullName: 'acme/api', tracked: false }], 'every installation\'s repositories, loaded on opening');
    await ui.runAction('close-track-picker', button({}, 'github'));
    assert.strictEqual(ui.settingsState.trackPicker, false);
    global.fetch = fn;
    await ui.runAction('edit-repo', button({ repoId: '101' }, 'github'));
    assert.strictEqual(ui.settingsState.editingRepo, 101);

    calls.length = 0;
    await ui.runAction('save-repo-settings', form([['versionFile', '  '], ['driftIgnorePaths', ' .github/\n\nREADME.md\n.github/ ']], { repoId: '101' }, 'github'));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/github/repos/101/settings`, body: { versionFile: null, driftIgnorePaths: ['.github/', 'README.md'] } });
    assert.ok(!calls.some((c) => c.url.endsWith('/flag-stance')), 'no flags field: the stance is left alone');
    calls.length = 0;
    await ui.runAction('save-repo-settings', form([['versionFile', ''], ['driftIgnorePaths', ''], ['flagStance', 'unknown']], { repoId: '101', flagStance: 'unknown' }, 'github'));
    assert.ok(!calls.some((c) => c.url.endsWith('/flag-stance')), 'unchanged: not sent');
    calls.length = 0;
    await ui.runAction('save-repo-settings', form([['versionFile', ''], ['driftIgnorePaths', ''], ['flagStance', 'none']], { repoId: '101', flagStance: 'unknown' }, 'github'));
    assert.deepStrictEqual(calls[1], { method: 'PUT', url: `${base}/github/repos/101/flag-stance`, body: { flagStance: 'none' } });
    calls.length = 0;
    await ui.runAction('save-repo-settings', form([['versionFile', ''], ['driftIgnorePaths', ''], ['serviceRole', '']], { repoId: '101', serviceRole: '' }, 'github'));
    assert.ok(!calls.some((c) => c.url.endsWith('/role')), 'role unchanged: not sent');
    await ui.runAction('save-repo-settings', form([['versionFile', ''], ['driftIgnorePaths', ''], ['serviceRole', 'frontend']], { repoId: '101', serviceRole: '' }, 'github'));
    assert.deepStrictEqual(calls.find((c) => c.url.endsWith('/role')), { method: 'PUT', url: `${base}/github/repos/101/role`, body: { serviceRole: 'frontend' } });
    calls.length = 0;
    await ui.runAction('save-repo-settings', form([['versionFile', ''], ['driftIgnorePaths', ''], ['serviceRole', '']], { repoId: '101', serviceRole: 'backend' }, 'github'));
    assert.deepStrictEqual(calls.find((c) => c.url.endsWith('/role')).body, { serviceRole: null }, '"Not set" clears it');
    calls.length = 0;
    const envForm = (choices) => form([['versionFile', ''], ['driftIgnorePaths', ''], ...choices.flatMap(([name, choice], i) => [[`envName${i}`, name], [`envChoice${i}`, choice]])], { repoId: '101', envMap: '{"staging":"qa"}' }, 'github');
    await ui.runAction('save-repo-settings', envForm([['staging', 'qa'], ['Production', 'auto']]));
    assert.ok(!calls.some((c) => c.url.endsWith('/environments')), 'unchanged: not sent');
    await ui.runAction('save-repo-settings', envForm([['staging', 'auto'], ['Production', 'skip']]));
    assert.deepStrictEqual(calls.find((c) => c.url.endsWith('/environments')), { method: 'PUT', url: `${base}/github/repos/101/environments`, body: { envMap: { Production: 'skip' } } });
    assert.strictEqual(ui.settingsState.editingRepo, null, 'saved: the row closes');

    ui.settingsState.installationRepos[7] = [{ id: 102, fullName: 'acme/api', tracked: false }];
    calls.length = 0;
    await ui.runAction('track-repo', button({ repoId: '102', installationId: '7' }, 'github'));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/github/repos/102`, body: { installationId: 7 } });
    assert.strictEqual(ui.settingsState.installationRepos[7][0].tracked, true);

    calls.length = 0;
    await ui.runAction('create-source', form([['name', ' LD '], ['kind', 'runtime'], ['priority', ''], ['repoIds', '101', false], ['tokenExpiresInDays', '365']], {}, 'flags'));
    assert.deepStrictEqual(calls[0].body, { name: 'LD', kind: 'runtime', repoIds: [], tokenExpiresInDays: 365, staleAfterMinutes: null }, 'an empty priority takes the server default');
    assert.deepStrictEqual(ui.settingsState.once, { token: 'sst_new' });
    calls.length = 0;
    await ui.runAction('create-source', form([['name', 'Never'], ['kind', 'build'], ['priority', ''], ['tokenExpiresInDays', 'never']], {}, 'flags'));
    assert.strictEqual(calls[0].body.tokenExpiresInDays, null, '"never" is no expiry');

    // A new token: its lifetime, and the environments it may send (all ticked = no limit; none = refused here).
    const tokenForm = (expires, envs) => form([['expiresInDays', expires], ...['test', 'qa', 'prod'].map((e) => ['environments', e, envs.includes(e)])], { sourceId: 's9' }, 'flags');
    calls.length = 0;
    await ui.runAction('new-token', tokenForm('90', ['qa', 'prod']));
    assert.deepStrictEqual(calls[0], { method: 'POST', url: `${base}/flag-sources/s9/tokens`, body: { expiresInDays: 90, environments: ['qa', 'prod'] } });
    assert.deepStrictEqual(ui.settingsState.once, { token: 'sst_tok' });
    calls.length = 0;
    await ui.runAction('new-token', tokenForm('never', ['test', 'qa', 'prod']));
    assert.deepStrictEqual(calls[0].body, { expiresInDays: null, environments: null });
    calls.length = 0;
    await ui.runAction('new-token', tokenForm('30', []));
    assert.deepStrictEqual(calls, [], 'no environment: nothing sent');
    assert.deepStrictEqual(ui.settingsState.messages.flags, { error: true, text: 'Pick at least one environment the token may send.' });
    calls.length = 0;
    await ui.runAction('save-source', form([['name', 'LD'], ['kind', 'build'], ['priority', '5'], ['repoIds', '101', true], ['repoIds', '102', true], ['repoIds', '103', false], ['staleAfterMinutes', '30']], { sourceId: 's9' }, 'flags'));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/flag-sources/s9`, body: { name: 'LD', kind: 'build', priority: 5, repoIds: [101, 102], staleAfterMinutes: 30, oidc: null } });

    // A source read from code: added with its file; saved keeping what the API set besides the form's fields.
    calls.length = 0;
    await ui.runAction('create-code-source', form([['name', ' Web code '], ['repoId', '101'], ['file', ' config/flags.json '], ['path', ''], ['prefix', '']], {}, 'flags'));
    assert.deepStrictEqual(calls[0], { method: 'POST', url: `${base}/flag-sources`, body: { name: 'Web code', kind: 'build', origin: 'code', repoIds: [101], code: { file: 'config/flags.json' } } });
    ui.settingsState.flags = [{ id: 's7', code: { file: 'old.json', keys: ['a'], envNames: { prod: 'production' }, path: 'old' } }];
    calls.length = 0;
    await ui.runAction('save-source', form([['name', 'Web code'], ['priority', '0'], ['repoId', '101'], ['file', 'new.yaml'], ['path', ''], ['prefix', 'ff_']], { sourceId: 's7', origin: 'code' }, 'flags'));
    assert.deepStrictEqual(calls[0].body, { name: 'Web code', kind: 'build', priority: 0, repoIds: [101], code: { file: 'new.yaml', keys: ['a'], envNames: { prod: 'production' }, prefix: 'ff_' } });

    // Reading flags from code with help: find the files, use one (its env names come along), preview, then add.
    const repos = [{ repoId: 101, fullName: 'acme/web' }];
    const codeForm = (fields) => form([['name', 'Web flags'], ['repoId', '101'], ['file', ''], ['path', ''], ['prefix', ''], ...fields], {}, 'flags');
    const found = { ref: 'a'.repeat(40), truncated: false, candidates: [
        { file: 'config/flags.{env}.json', envNames: { prod: 'production' }, path: 'features', flags: { newCheckout: { state: 'on' } }, readFrom: 'config/flags.production.json' },
        { file: 'ui/feature-flags.json', error: 'ui/feature-flags.json: flag dbUrl is not on, off or a rollout percentage', readFrom: 'ui/feature-flags.json' },
    ] };
    const preview = [{ env: 'prod', ref: 'b'.repeat(40), file: 'config/flags.production.json', flags: { newCheckout: { state: 'on' }, beta: { state: 'partial', rollout: 30 } } },
        { env: 'qa', ref: 'c'.repeat(40), file: 'config/flags.qa.json', error: 'config/flags.qa.json is not in acme/web at cccccccccccc' }];
    const { fn: wizardFetch, calls: wizardCalls } = fakeFetch({
        [`GET ${base}/github/repos/101/flag-files`]: found,
        [`POST ${base}/github/repos/101/flag-preview`]: { envs: preview },
        [`POST ${base}/flag-sources`]: { source: { id: 's8' }, token: null },
    });
    global.fetch = wizardFetch;
    ui.settingsState.codeWizard = { draft: {}, found: null, preview: null };
    await ui.runAction('find-flag-files', { dataset: {}, form: codeForm([]), closest: () => ({ id: 'flags' }) });
    assert.deepStrictEqual(wizardCalls.map((c) => [c.method, c.url]), [['GET', `${base}/github/repos/101/flag-files`]]);
    let page = str(ui.renderSourcesPage({ sources: [], repos, admin: true, once: {}, origin: 'https://s', wizard: ui.settingsState.codeWizard }));
    assert.match(page, /the deployed commit aaaaaaaaaaaa/);
    assert.match(page, /<code>config\/flags.\{env\}.json<\/code> · flags under <code>features<\/code>[\s\S]*1 flag\(s\): <span class="mono">newCheckout on<\/span>[\s\S]*data-action="use-flag-file" data-index="0"/);
    assert.match(page, /flag dbUrl is not on, off/);
    assert.doesNotMatch(page, /data-index="1"/, 'nothing to use in a file that does not read');
    await ui.runAction('use-flag-file', { dataset: { index: '0' }, closest: () => ({ id: 'flags' }) });
    page = str(ui.renderSourcesPage({ sources: [], repos, admin: true, once: {}, origin: 'https://s', wizard: ui.settingsState.codeWizard }));
    assert.match(page, /name="file" required maxlength="200" placeholder="config\/flags.\{env\}.json" value="config\/flags.\{env\}.json"/);
    assert.match(page, /name="path" maxlength="100" placeholder="features" value="features"/);
    assert.match(page, /name="name" required maxlength="100" placeholder="e.g. Web flags" value="Web flags"/, 'the name typed before stays');

    const filled = [['file', 'config/flags.{env}.json'], ['path', 'features']];
    wizardCalls.length = 0;
    await ui.runAction('preview-code-source', { dataset: {}, form: codeForm(filled), closest: () => ({ id: 'flags' }) });
    assert.deepStrictEqual(wizardCalls[0].body, { code: { file: 'config/flags.{env}.json', envNames: { prod: 'production' }, path: 'features' } }, 'the proposed environment names come along');
    page = str(ui.renderSourcesPage({ sources: [], repos, admin: true, once: {}, origin: 'https://s', wizard: ui.settingsState.codeWizard }));
    assert.match(page, /<span class="state-tag ok">prod<\/span> <code>config\/flags.production.json<\/code>[\s\S]*2 flag\(s\): <span class="mono">newCheckout on, beta 30%<\/span>/);
    assert.match(page, /<span class="state-tag fail">qa<\/span>[\s\S]*is not in acme\/web at cccccccccccc/);
    wizardCalls.length = 0;
    await ui.runAction('create-code-source', codeForm(filled));
    assert.deepStrictEqual(wizardCalls[0].body, { name: 'Web flags', kind: 'build', origin: 'code', repoIds: [101], code: { file: 'config/flags.{env}.json', envNames: { prod: 'production' }, path: 'features' } });
    assert.deepStrictEqual(ui.settingsState.codeWizard, { draft: {}, found: null, preview: null }, 'added: the helper starts over');
    wizardCalls.length = 0;
    await ui.runAction('preview-code-source', { dataset: {}, form: codeForm([]), closest: () => ({ id: 'flags' }) });
    assert.deepStrictEqual(wizardCalls, [], 'no file: nothing asked');
    assert.match(ui.settingsState.messages.flags.text, /Name the file to preview/);
    global.fetch = fn;

    // Added from a repository's card on GitHub: the flags are reloaded and the message stays on GitHub.
    const { fn: cardFetch, calls: cardCalls } = fakeFetch({ [`POST ${base}/flag-sources`]: { source: { id: 's9' }, token: null }, [`GET ${base}/flag-sources`]: { sources: [] } });
    global.fetch = cardFetch;
    const cardForm = { ...form([['name', 'web flags'], ['repoId', '101'], ['file', 'src/flags.ts'], ['path', ''], ['prefix', '']], { place: 'github', section: 'github' }, 'github') };
    await ui.runAction('create-code-source', cardForm);
    assert.deepStrictEqual(cardCalls[0].method, 'POST');
    assert.ok(cardCalls.some((c) => c.method === 'GET' && c.url === `${base}/flag-sources`), 'the sources are reloaded for the card');
    assert.deepStrictEqual(ui.settingsState.messages.github, { error: false, text: 'Added: its flags are read at the next sync.' });
    global.fetch = fn;

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
    await ui.runAction('add-event-subscription', form([['url', ' https://pdi.acme.io/hooks '], ['types', 'release.stage_changed', false], ['types', 'feature.released', true]], {}, 'general'));
    assert.deepStrictEqual(calls.filter((c) => c.method === 'POST')[0], { method: 'POST', url: `${base}/event-subscriptions`, body: { url: 'https://pdi.acme.io/hooks', types: ['feature.released'] } });
    global.confirm = () => true;
    await ui.runAction('remove-event-subscription', button({ subscriptionId: 's1' }, 'general'));
    delete global.confirm;
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === `${base}/event-subscriptions/s1`));
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
    await ui.runAction('save-release-link', form([['type', 'label'], ['prefix', ' release: '], ['id', 'customfield_1']]));
    await ui.runAction('save-release-link', form([['type', 'fixVersion'], ['prefix', '']]));
    await ui.runAction('save-release-link', form([['type', 'field'], ['prefix', 'release:'], ['id', 'customfield_10050']]));
    await ui.runAction('save-release-link', form([['type', 'none'], ['prefix', 'release:']]));
    assert.deepStrictEqual(calls.filter((c) => c.method === 'PUT').map((c) => [c.url, c.body]), [
        [`${base}/jira/release-link`, { type: 'label', prefix: 'release:' }],
        [`${base}/jira/release-link`, { type: 'fixVersion', prefix: '' }],
        [`${base}/jira/release-link`, { type: 'field', id: 'customfield_10050' }],
        [`${base}/jira/release-link`, { type: 'none' }],
    ]);
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
    await ui.runAction('revoke-token', pageButton({ tokenId: 't8' }, 'sources', 'flags'));
    assert.deepStrictEqual(ui.settingsState.messages, { flags: { error: true, text: 'Token not found' } }, 'an error on the Sources page shows in its section');
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
    assert.match(res.headers['content-security-policy'], /script-src 'self';/);
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

test('Sources: reading flags from an endpoint -- addresses per environment, a token never shown back, Test, the signing secret', async () => {
    ui.settingsState.tenantId = TENANT;
    const base = `/tenants/${TENANT}`;
    const repos = [{ repoId: 101, fullName: 'acme/api' }];
    const endpointSource = {
        id: 's5', name: 'Flags <API>', kind: 'runtime', priority: 100, origin: 'endpoint', repoIds: [101], tokens: [],
        endpoint: { urls: { prod: 'https://flags.acme.io/f?env=prod' }, path: 'features', keys: ['a'] }, hasEndpointToken: true,
        pollIntervalMinutes: null, effectivePollIntervalMinutes: 5, lastPolledAt: '2026-10-25T10:00:00Z', nextPollAt: '2026-10-25T10:05:00Z', pollFailures: 2,
        environments: [{ env: 'prod', state: 'error', observedAt: null }],
    };
    const page = (extra = {}) => str(ui.renderSourcesPage({ sources: [endpointSource], repos, admin: true, once: {}, origin: 'https://s', ...extra }));
    const shown = page();
    assert.match(shown, /data-action="save-source" data-source-id="s5" data-origin="endpoint"/);
    assert.match(shown, /value="https:\/\/flags.acme.io\/f\?env=prod"/);
    assert.match(shown, /Flags &lt;API&gt;/);
    assert.match(shown, /stored encrypted; empty keeps it/);
    assert.match(shown, /name="endpointToken" type="password" autocomplete="off" maxlength="4096" value=""/, 'the token field is always empty');
    assert.match(shown, /every 5 min .*token stored encrypted .*2 failed read\(s\) in a row/s);
    assert.doesNotMatch(shown, /data-action="new-token" data-source-id="s5"/, 'no ingest tokens for an endpoint source');
    assert.match(shown, /<form class="settings-form" data-action="create-endpoint-source">/);
    assert.match(shown, /data-action="show-endpoint-signing"/);
    assert.match(page({ endpointTest: { place: 's5', envs: [{ env: 'prod', host: 'flags.acme.io', flags: { newCheckout: { state: 'on' } } }, { env: 'qa', host: 'flags.acme.io', error: 'flags.acme.io answered HTTP 401' }] } }),
        /<strong>Test<\/strong>.*newCheckout on.*answered HTTP 401/s);
    assert.match(page({ once: { signing: { secret: 'ab'.repeat(32) } } }), new RegExp(`Signing secret of this workspace</strong><code>${'ab'.repeat(32)}</code>.*X-ShipScope-Signature`, 's'));

    const card = str(ui.renderGitHub({ enabled: true, webhooks: true, admin: true, installationRepos: {}, editing: 101, sources: [endpointSource],
        github: { installations: [], repos: [{ repoId: 101, fullName: 'acme/api', installationId: 7, flagStance: 'unknown' }] } }));
    assert.match(card, /Read from the endpoint of Flags &lt;API&gt; \(Sources\)/);

    const { fn, calls } = fakeFetch({ [`POST ${base}/flag-endpoint-test`]: { envs: [{ env: 'prod', host: 'flags.acme.io', flags: {} }] }, [`GET ${base}/flag-endpoint-signing`]: { secret: 'cd'.repeat(32) } });
    global.fetch = fn;
    const fields = (extra = []) => [['name', ' Flags API '], ['repoIds', '101', true], ['url_test', ''], ['url_qa', ' https://flags.acme.io/f?env=qa '], ['url_prod', 'https://flags.acme.io/f?env=prod'],
        ['path', 'features'], ['tokenHeader', ''], ['endpointToken', ''], ['pollIntervalMinutes', ''], ['staleAfterMinutes', ''], ...extra];
    await ui.runAction('create-endpoint-source', form(fields([['endpointToken', 'cust-1']]), {}, 'flags'));
    assert.deepStrictEqual(calls[0], { method: 'POST', url: `${base}/flag-sources`, body: {
        name: 'Flags API', kind: 'runtime', origin: 'endpoint', repoIds: [101], endpoint: { urls: { qa: 'https://flags.acme.io/f?env=qa', prod: 'https://flags.acme.io/f?env=prod' }, path: 'features' },
        staleAfterMinutes: null, pollIntervalMinutes: null, endpointToken: 'cust-1',
    } });
    calls.length = 0;
    await ui.runAction('create-endpoint-source', form([['name', 'X'], ['url_test', ''], ['url_qa', ''], ['url_prod', '']], {}, 'flags'));
    assert.deepStrictEqual(calls, [], 'no address: nothing sent');
    assert.deepStrictEqual(ui.settingsState.messages.flags, { error: true, text: 'Give the https address of at least one environment.' });

    // Saving: the API's other fields kept; an empty token keeps the stored one, the box removes it.
    ui.settingsState.flags = [endpointSource];
    calls.length = 0;
    await ui.runAction('save-source', form([...fields([['priority', '90'], ['pollIntervalMinutes', '15']])], { sourceId: 's5', origin: 'endpoint' }, 'flags'));
    assert.deepStrictEqual(calls[0].body, {
        name: 'Flags API', kind: 'runtime', priority: 90, repoIds: [101], endpoint: { urls: { qa: 'https://flags.acme.io/f?env=qa', prod: 'https://flags.acme.io/f?env=prod' }, path: 'features', keys: ['a'] },
        staleAfterMinutes: null, pollIntervalMinutes: 15,
    });
    ui.settingsState.flags = [endpointSource];
    calls.length = 0;
    await ui.runAction('save-source', form([...fields([['priority', '90'], ['clearToken', '1', true]])], { sourceId: 's5', origin: 'endpoint' }, 'flags'));
    assert.strictEqual(calls[0].body.endpointToken, null);

    // Test: a saved source with its stored token; a typed token instead; the new-source form without one.
    const testButton = (dataset, extra = []) => ({ dataset: {}, form: form(fields(extra), dataset, 'flags'), closest: () => ({ id: 'flags' }) });
    ui.settingsState.flags = [endpointSource];
    calls.length = 0;
    await ui.runAction('test-endpoint-source', testButton({ sourceId: 's5', origin: 'endpoint' }));
    assert.deepStrictEqual(calls[0].body, { endpoint: { urls: { qa: 'https://flags.acme.io/f?env=qa', prod: 'https://flags.acme.io/f?env=prod' }, path: 'features', keys: ['a'] }, sourceId: 's5' });
    assert.deepStrictEqual(ui.settingsState.endpointTest, { place: 's5', envs: [{ env: 'prod', host: 'flags.acme.io', flags: {} }] });
    calls.length = 0;
    await ui.runAction('test-endpoint-source', testButton({ sourceId: 's5' }, [['endpointToken', 'typed']]));
    assert.deepStrictEqual([calls[0].body.endpointToken, calls[0].body.sourceId], ['typed', undefined]);
    calls.length = 0;
    await ui.runAction('test-endpoint-source', testButton({}));
    assert.deepStrictEqual([calls[0].body.sourceId, calls[0].body.endpointToken, ui.settingsState.endpointTest.place], [undefined, undefined, 'new']);

    calls.length = 0;
    await ui.runAction('show-endpoint-signing', pageButton({}, 'sources', 'flags'));
    assert.deepStrictEqual(ui.settingsState.once, { signing: { secret: 'cd'.repeat(32) } });
});


test('Flags: suggested links (issues whose commits changed the flag) with link and dismiss for admins', async () => {
    ui.settingsState.tenantId = TENANT;
    const base = `/tenants/${TENANT}`;
    const flag = { key: 'beta', description: 'Beta', links: { sender: [], manual: [], jira: [] }, suggestions: ['EBO-7'], states: {}, components: [] };
    const page = (admin) => str(ui.renderFlags({ flagList: [flag], admin, jiraUrl: 'https://acme.atlassian.net' }));
    assert.match(page(true), /Suggested \(its commits changed this flag\): <a href="https:\/\/acme.atlassian.net\/browse\/EBO-7"[^>]*>EBO-7<\/a> <button type="button" class="btn-link btn" data-action="accept-link-suggestion" data-key="beta" data-jira-key="EBO-7">link<\/button>/);
    assert.match(page(true), /data-action="dismiss-link-suggestion" data-key="beta" data-jira-key="EBO-7"/);
    assert.doesNotMatch(page(false), /accept-link-suggestion/, 'members see the suggestion, admins answer it');
    assert.doesNotMatch(str(ui.renderFlags({ flagList: [{ ...flag, suggestions: [] }], admin: true })), /Suggested/);

    const { fn, calls } = fakeFetch();
    global.fetch = fn;
    await ui.runAction('accept-link-suggestion', pageButton({ key: 'beta', jiraKey: 'EBO-7' }, 'flags', 'flags'));
    assert.deepStrictEqual(calls[0], { method: 'POST', url: `${base}/flags/beta/suggestions`, body: { jiraKey: 'EBO-7', accept: true } });
    calls.length = 0;
    await ui.runAction('dismiss-link-suggestion', pageButton({ key: 'beta', jiraKey: 'EBO-7' }, 'flags', 'flags'));
    assert.deepStrictEqual(calls[0].body, { jiraKey: 'EBO-7', accept: false });
});

test('Sources: GitHub Actions without a token -- the switch, branches and environments, and what the workflow needs', async () => {
    ui.settingsState.tenantId = TENANT;
    const base = `/tenants/${TENANT}`;
    const push = { id: 's1', name: 'CI', kind: 'build', priority: 0, repoIds: [101], tokens: [], origin: 'push' };
    let page = str(ui.renderSourcesPage({ sources: [push], repos: [{ repoId: 101, fullName: 'acme/web' }], admin: true, once: {}, origin: 'https://s' }));
    assert.match(page, /name="oidcEnabled" value="on" >/, 'off');
    assert.match(page, /the source can\S+t send anything/);
    const on = { ...push, oidc: { refs: ['refs/heads/main', 'refs/tags/v*'], environments: ['prod'] }, lastIngestAt: '2026-10-25T10:00:00Z', lastIngest: { flags: 2, changed: 1, removed: 0, stale: 0, sender: 'acme/web@refs/heads/main' } };
    page = str(ui.renderSourcesPage({ sources: [on], repos: [{ repoId: 101, fullName: 'acme/web' }], admin: true, once: {}, origin: 'https://s' }));
    assert.match(page, /name="oidcEnabled" value="on" checked>/);
    assert.match(page, /name="oidcRefs"[^>]*value="refs\/heads\/main refs\/tags\/v\*"/);
    assert.match(page, /value="prod" checked>/);
    assert.match(page, /value="test" >/);
    assert.match(page, new RegExp(`id-token: write.*source: ${TENANT}/s1`, 's'));
    assert.match(page, /none — only GitHub Actions send/);
    assert.match(page, /from GitHub Actions of acme\/web@refs\/heads\/main/);

    const { fn, calls } = fakeFetch({ [`PUT ${base}/flag-sources/s1`]: {}, [`GET ${base}/flags`]: { flags: [] }, [`GET ${base}/flag-sources`]: { sources: [] }, [`GET ${base}/secret-events`]: { events: [] } });
    global.fetch = fn;
    const fields = (extra) => [['name', 'CI'], ['kind', 'build'], ['priority', '0'], ['repoIds', '101', true], ['staleAfterMinutes', ''], ...extra];
    await ui.runAction('save-source', form(fields([['oidcEnabled', 'on', true], ['oidcRefs', ' refs/heads/main, refs/tags/v* '], ['oidcEnvironments', 'test', false], ['oidcEnvironments', 'qa', true], ['oidcEnvironments', 'prod', true]]), { sourceId: 's1' }, 'flags'));
    assert.deepStrictEqual(calls[0].body.oidc, { refs: ['refs/heads/main', 'refs/tags/v*'], environments: ['qa', 'prod'] });
    calls.length = 0;
    await ui.runAction('save-source', form(fields([['oidcEnabled', 'on', true], ['oidcRefs', ''], ['oidcEnvironments', 'test', true], ['oidcEnvironments', 'qa', true], ['oidcEnvironments', 'prod', true]]), { sourceId: 's1' }, 'flags'));
    assert.deepStrictEqual(calls[0].body.oidc, { refs: null, environments: null }, 'any branch, every environment');
    calls.length = 0;
    await ui.runAction('save-source', form(fields([['oidcEnabled', 'on', true], ['oidcEnvironments', 'prod', false]]), { sourceId: 's1' }, 'flags'));
    assert.deepStrictEqual(calls, [], 'no environment: nothing sent');
    assert.deepStrictEqual(ui.settingsState.messages.flags, { error: true, text: 'Pick at least one environment GitHub Actions may send.' });
});

test('General: admins see the settings activity, escaped; a change an admin makes reloads it', async () => {
    const workspace = { settings: { deploymentRetentionDays: 90 }, members: [], invitations: [] };
    const events = [{ at: '2026-10-25T10:00:00Z', kind: 'repo_tracked', subject: '<acme/web>', actor: 'alice' },
        { at: '2026-10-25T09:00:00Z', kind: 'member_left', subject: null, actor: null }];
    const page = str(ui.renderGeneral({ workspace, admin: true, auditEvents: events }));
    assert.match(page, /Settings activity.*alice started tracking <strong>&lt;acme\/web&gt;<\/strong>.*someone no longer here left the workspace/s);
    assert.match(str(ui.renderGeneral({ workspace, admin: true, auditEvents: [] })), /Settings activity.*Nothing yet/s);
    assert.match(str(ui.renderGeneral({ workspace, admin: true, auditEvents: { error: 'Boom' } })), /settings-error">Boom/);
    assert.ok(!/Settings activity/.test(str(ui.renderGeneral({ workspace, admin: false, auditEvents: events }))), 'members never see it');
    assert.deepStrictEqual(Object.keys(ui.AUDIT_EVENT_LABELS).sort(), [...require('../lib/audit-log').AUDIT_EVENT_KINDS].sort(), 'a label for every kind');

    ui.settingsState.tenantId = TENANT;
    ui.settingsState.tenant = { id: TENANT, role: 'admin' };
    const base = `/tenants/${TENANT}`;
    const { fn, calls } = fakeFetch({ [`GET ${base}/members`]: { members: [] }, [`GET ${base}/invitations`]: { invitations: [] }, [`GET ${base}/audit-events`]: { events } });
    global.fetch = fn;
    await ui.runAction('save-retention', form([['deploymentRetentionDays', '30']], { action: 'save-retention' }, 'general'));
    assert.deepStrictEqual(calls[0], { method: 'PUT', url: `${base}/settings`, body: { deploymentRetentionDays: 30 } });
    assert.ok(calls.some((c) => c.url === `${base}/audit-events`), 'the activity is reloaded');
    assert.deepStrictEqual(ui.settingsState.auditEvents, events);
});

test('Sources: replacing the signing secret asks first; the secret activity lists who did what, escaped', async () => {
    ui.settingsState.tenantId = TENANT;
    const base = `/tenants/${TENANT}`;
    const events = [{ at: '2026-10-25T10:00:00Z', kind: 'signing_secret_rotated', subject: null, actor: 'alice' },
        { at: '2026-10-25T09:00:00Z', kind: 'endpoint_token_set', subject: '<API>', actor: null }];
    const page = str(ui.renderSourcesPage({ sources: [], repos: [], admin: true, once: {}, origin: 'https://s', secretEvents: events }));
    assert.match(page, /data-action="rotate-endpoint-signing">Replace it/);
    assert.match(page, /<h3>Secret activity<\/h3>.*alice replaced the signing secret.*someone no longer here set the endpoint token of <strong>&lt;API&gt;<\/strong>/s);
    assert.match(str(ui.renderSourcesPage({ sources: [], repos: [], admin: true, once: {}, origin: 'https://s', secretEvents: [] })), /Nothing yet/);

    const { fn, calls } = fakeFetch({ [`POST ${base}/flag-endpoint-signing/rotate`]: { secret: 'ef'.repeat(32) } });
    global.fetch = fn;
    global.confirm = () => false;
    await ui.runAction('rotate-endpoint-signing', pageButton({}, 'sources', 'flags'));
    assert.deepStrictEqual(calls, [], 'not confirmed: nothing replaced');
    global.confirm = () => true;
    await ui.runAction('rotate-endpoint-signing', pageButton({}, 'sources', 'flags'));
    delete global.confirm;
    assert.deepStrictEqual(calls[0], { method: 'POST', url: `${base}/flag-endpoint-signing/rotate`, body: undefined });
    assert.deepStrictEqual(ui.settingsState.once, { signing: { secret: 'ef'.repeat(32) } });
});

test('Sources: Test with a token only the worker can read waits for the worker\'s result', async () => {
    ui.settingsState.tenantId = TENANT;
    const base = `/tenants/${TENANT}`;
    let polls = 0;
    const { fn, calls } = fakeFetch({
        [`POST ${base}/flag-endpoint-test`]: { pending: true, testId: 't1' },
        [`GET ${base}/flag-endpoint-test/t1`]: () => (++polls < 2 ? { status: 'pending' } : { status: 'done', envs: [{ env: 'prod', host: 'flags.acme.io', flags: {} }] }),
    });
    global.fetch = fn;
    ui.settingsState.endpointTestWaitMs = 0;
    ui.settingsState.flags = [{ id: 's5', endpoint: { urls: { prod: 'https://flags.acme.io/f' } } }];
    const fields = [['url_test', ''], ['url_qa', ''], ['url_prod', 'https://flags.acme.io/f'], ['path', ''], ['tokenHeader', ''], ['endpointToken', '']];
    await ui.runAction('test-endpoint-source', { dataset: {}, form: form(fields, { sourceId: 's5' }, 'flags'), closest: () => ({ id: 'flags' }) });
    assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST ${base}/flag-endpoint-test`, `GET ${base}/flag-endpoint-test/t1`, `GET ${base}/flag-endpoint-test/t1`]);
    assert.deepStrictEqual(ui.settingsState.endpointTest, { place: 's5', envs: [{ env: 'prod', host: 'flags.acme.io', flags: {} }] });
    assert.match(str(ui.renderSourcesPage({ sources: [{ ...ui.settingsState.flags[0], name: 'API', kind: 'runtime', priority: 100, origin: 'endpoint', repoIds: [], tokens: [] }], repos: [], admin: true, once: {}, origin: 'https://s', endpointTest: { place: 's5', pending: true } })),
        /the worker reads it/);
    delete ui.settingsState.endpointTestWaitMs;
});

test('pdi: connect with the receiver\'s address, the variables shown once, the two proofs, Test and Disconnect; members only see', async () => {
    ui.settingsState.tenantId = TENANT;
    const base = `/tenants/${TENANT}`;
    const none = str(ui.renderPdi({ connection: { state: 'none', checks: [] }, admin: true }));
    assert.match(none, /Not connected/);
    assert.match(none, /<form class="settings-form" data-action="connect-pdi">/);
    assert.doesNotMatch(str(ui.renderPdi({ connection: { state: 'none', checks: [] }, admin: false })), /data-action="connect-pdi"/, 'admins only');
    assert.match(str(ui.renderPdi({ connection: null, admin: true })), /Loading/);

    const pending = { state: 'pending', receiverUrl: 'https://pdi.<x>.com', connectedAt: '2026-10-27T10:00:00Z', checks: [
        { id: 'pdi_reads', ok: true, at: '2026-10-27T10:05:00Z', error: null }, { id: 'reaches_pdi', ok: false, at: null, error: 'pdi.example.com answered HTTP 404' },
    ] };
    const env = { PDI_SHIPSCOPE_URL: 'https://s', PDI_SHIPSCOPE_TOKEN: `shps_${'a'.repeat(43)}`, PDI_SHIPSCOPE_SIGNING_SECRET: 'b'.repeat(43) };
    const shown = str(ui.renderPdi({ connection: pending, admin: true, once: { pdiEnv: env } }));
    assert.match(shown, /Variables for pdi — shown only once<\/strong><code>PDI_SHIPSCOPE_URL=https:\/\/s\nPDI_SHIPSCOPE_TOKEN=shps_a+\nPDI_SHIPSCOPE_SIGNING_SECRET=b+<\/code>/);
    assert.match(shown, /Waiting for pdi/);
    assert.match(shown, /pdi\.&lt;x&gt;\.com/);
    assert.match(shown, /✓<\/span> pdi read ShipScope with its token/);
    assert.match(shown, /!<\/span> ShipScope has not reached pdi yet.*answered HTTP 404/s);
    assert.match(shown, /data-action="test-pdi".*data-action="disconnect-pdi"/s);
    const member = str(ui.renderPdi({ connection: { ...pending, state: 'connected' }, admin: false }));
    assert.match(member, /Connected/);
    assert.doesNotMatch(member, /data-action="(test|disconnect)-pdi"/);

    const connected = { ...pending, state: 'connected', checks: pending.checks.map((c) => ({ ...c, ok: true, error: null })) };
    const { fn, calls } = fakeFetch({
        [`POST ${base}/pdi-connection`]: { connection: pending, env },
        [`GET ${base}/pdi-connection`]: { connection: pending },
        [`POST ${base}/pdi-connection/test`]: { connection: connected },
        [`DELETE ${base}/pdi-connection`]: null,
        [`GET ${base}/audit-events`]: { events: [] },
    });
    global.fetch = fn;
    await ui.runAction('connect-pdi', form([['receiverUrl', ' https://pdi.example.com ']], {}, 'pdi'));
    assert.deepStrictEqual(calls[0], { method: 'POST', url: `${base}/pdi-connection`, body: { receiverUrl: 'https://pdi.example.com' } });
    assert.deepStrictEqual(ui.settingsState.once, { pdiEnv: env });
    await ui.runAction('test-pdi', button({}, 'pdi'));
    assert.deepStrictEqual(ui.settingsState.messages.pdi, { error: false, text: 'pdi answered.' });
    await ui.runAction('disconnect-pdi', button({}, 'pdi'));
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === `${base}/pdi-connection`));
});
