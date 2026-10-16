const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
    piOfSprint, currentPiOf, previousPiOf, issueType, mapIssue, comparePiDesc, compileTemplate, rhythmOf, RhythmTemplateError,
    releaseName, currentReleaseOf, previousReleaseOf, flowMonth, releaseJql, flowJql, extractFlagKeys, issueFields,
} = require('../lib/jira-model');

const FIELD_IDS = { sprintFieldId: 'customfield_10020', epicLinkFieldId: 'customfield_10014', flaggedFieldId: 'customfield_10021' };
const sp = (id, name, state, startDate = null, endDate = null) => ({ id, name, state, startDate, endDate });
const TYPES = { Story: { name: 'Story', hierarchyLevel: 0 }, Bug: { name: 'Bug', hierarchyLevel: 0 }, Task: { name: 'Task', hierarchyLevel: 0 }, Epic: { name: 'Epic', hierarchyLevel: 1 }, Sub: { name: 'Sub-task', subtask: true, hierarchyLevel: -1 } };
/** A raw /search/jql issue. */
const raw = (key, type, sprints = [], fields = {}) => ({
    key,
    fields: {
        summary: `${key} title`, issuetype: TYPES[type], status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        priority: { name: 'Major' }, created: '2026-09-01T10:00:00.000+0000', resolutiondate: null, project: { name: 'eMobility Sparks' },
        customfield_10020: sprints, ...fields,
    },
});

test('jira model: PIs from sprint names (or the sprint itself), the current PI, the previous one', () => {
    assert.strictEqual(piOfSprint('Sparks 27.3.2'), 'PI-27.3');
    assert.strictEqual(piOfSprint('Sprint 42'), 'Sprint 42', 'teams without PI naming: the sprint is the increment');
    assert.deepStrictEqual(['PI-27.2', 'PI-27.10', 'PI-27.3'].sort(comparePiDesc), ['PI-27.10', 'PI-27.3', 'PI-27.2']);

    const sprints = [sp(1, 'S 27.2.3', 'closed', null, '2026-07-01'), sp(2, 'S 27.3.1', 'closed', null, '2026-08-01'), sp(3, 'S 27.3.2', 'active'), sp(4, 'S 27.4.1', 'future', '2026-11-01')];
    assert.strictEqual(currentPiOf(sprints), 'PI-27.3');
    // Between sprints: the next to start, else the last that ended.
    assert.strictEqual(currentPiOf(sprints.map((s) => (s.state === 'active' ? { ...s, state: 'closed', endDate: '2026-09-01' } : s))), 'PI-27.4');
    assert.strictEqual(currentPiOf([sp(1, 'S 27.2.3', 'closed', null, '2026-07-01'), sp(2, 'S 27.3.1', 'closed', null, '2026-08-01')]), 'PI-27.3');
    assert.strictEqual(currentPiOf([]), null);
    assert.strictEqual(previousPiOf(sprints, 'PI-27.3'), 'PI-27.2');
    assert.strictEqual(previousPiOf(sprints, 'PI-27.2'), null);
});

test('jira model: rhythms -- SAFe PIs, every sprint on its own, auto-detected, or the admin\'s own PI naming', () => {
    const safe = [sp(1, 'Sparks 27.3.1', 'active')];
    const scrum = [sp(2, 'PAY Sprint 9', 'closed', '2026-08-01'), sp(3, 'PAY Sprint 10', 'active', '2026-09-01')];
    assert.strictEqual(rhythmOf({ rhythm: 'auto', piTemplate: null }, safe).kind, 'pi');
    assert.strictEqual(rhythmOf({ rhythm: 'auto', piTemplate: null }, scrum).kind, 'sprint');
    assert.strictEqual(rhythmOf({ rhythm: 'sprint', piTemplate: null }, safe).kind, 'sprint', 'an admin can opt a PI-named board out');
    assert.strictEqual(piOfSprint('Sparks 27.3.1', rhythmOf({ rhythm: 'sprint', piTemplate: null }, safe)), 'Sparks 27.3.1');
    // Sprint order is by time, not by name: "Sprint 10" follows "Sprint 9".
    assert.strictEqual(previousPiOf(scrum, 'PAY Sprint 10', { kind: 'sprint' }), 'PAY Sprint 9');
    // Names need not contain numbers or sort in time order at all.
    const named = [sp(5, 'Apple', 'closed', '2026-08-01'), sp(6, 'Banana', 'active', '2026-09-01')];
    assert.strictEqual(previousPiOf(named, 'Banana', { kind: 'sprint' }), 'Apple');
    assert.strictEqual(previousPiOf(named, 'Apple', { kind: 'sprint' }), null);

    const own = rhythmOf({ rhythm: 'auto', piTemplate: 'Release {pi} (week {n})' }, [sp(4, 'Team A Release 2026.4 (Week 2)', 'active')]);
    assert.strictEqual(own.kind, 'pi');
    assert.strictEqual(piOfSprint('Team A Release 2026.4 (Week 2)', own), 'PI-2026.4', 'case-insensitive, literal parentheses');
    assert.strictEqual(piOfSprint('Hotfix week', own), 'Hotfix week', 'a sprint without the naming is its own increment');
    assert.match(compileTemplate('a.b {pi} * c+').source, /^a\\\.b\\s\+/, 'regex characters are literal');
    for (const bad of ['', 'no placeholder', '{pi} and {pi}', 'x'.repeat(101)]) assert.throws(() => compileTemplate(bad), RhythmTemplateError, bad);
    // A template can't be turned into a slow pattern: its parts are fixed, bounded fragments.
    const t0 = Date.now();
    compileTemplate('*{pi}*'.repeat(1) + '*'.repeat(40)).test('9'.repeat(5000) + 'x');
    assert.ok(Date.now() - t0 < 1000);
});

test('jira model: boards without sprints -- releases by fixVersion, or Kanban flow by calendar month', () => {
    const auto = { rhythm: 'auto', piTemplate: null };
    const v = (id, name, released, releaseDate = null, startDate = null) => ({ id, name, released, releaseDate, startDate });
    assert.strictEqual(rhythmOf(auto, [], [v('1', '1.0', false)]).kind, 'release', 'no sprints, an unreleased version: releases');
    assert.strictEqual(rhythmOf(auto, [], [v('1', '1.0', true)]).kind, 'flow', 'only past releases: nothing to follow but the flow');
    assert.strictEqual(rhythmOf(auto, []).kind, 'flow');
    assert.strictEqual(rhythmOf(auto, [sp(1, 'Sprint 1', 'active')], [v('1', '1.0', false)]).kind, 'sprint', 'sprints win over versions');
    assert.strictEqual(rhythmOf({ rhythm: 'release', piTemplate: null }, [sp(1, 'Sparks 27.3.1', 'active')]).kind, 'release');
    assert.strictEqual(rhythmOf({ rhythm: 'flow', piTemplate: null }, []).kind, 'flow');

    const versions = [v('10', '1.0', true, '2026-07-01'), v('11', '1.1', true, '2026-09-01'), v('13', '2.0', false), v('12', '1.2', false, '2026-11-01')];
    assert.strictEqual(currentReleaseOf(versions).name, '1.2', 'the unreleased one due first; one without a date after it');
    assert.strictEqual(previousReleaseOf(versions, currentReleaseOf(versions)).name, '1.1', 'the newest released');
    const shipped = versions.filter((x) => x.released);
    assert.strictEqual(currentReleaseOf(shipped).name, '1.1', 'everything released: the last one');
    assert.strictEqual(previousReleaseOf(shipped, currentReleaseOf(shipped)).name, '1.0');
    assert.strictEqual(previousReleaseOf(shipped, shipped[0]), null);
    assert.strictEqual(currentReleaseOf([v('1', 'Beta', false), v('2', 'Alpha', false)]).name, 'Alpha', 'undated: by name');
    assert.strictEqual(currentReleaseOf([v('1', '2.5', false), v('2', '3.0', false, '2026-11-01')]).name, '3.0', 'a due date comes before name order');
    assert.strictEqual(currentReleaseOf([]), null);
    assert.deepStrictEqual([releaseName('PAY', '1.2'), releaseName('PAY', 'pay-2026.10')], ['PAY 1.2', 'pay-2026.10']);

    assert.deepStrictEqual(flowMonth(new Date('2026-10-16T12:00:00Z')), { name: 'Flow 2026-10', start: '2026-10-01', end: '2026-11-01' });
    assert.deepStrictEqual(flowMonth(new Date('2026-01-31T23:00:00Z'), -1), { name: 'Flow 2025-12', start: '2025-12-01', end: '2026-01-01' });
    assert.deepStrictEqual(flowMonth(new Date('2026-12-05T00:00:00Z')).end, '2027-01-01');
    const month = flowMonth(new Date('2026-10-16T12:00:00Z'));
    assert.strictEqual(flowJql('SUP', month, true), 'project = "SUP" AND (statusCategory = "In Progress" OR resolved >= "2026-10-01" AND resolved < "2026-11-01") ORDER BY key');
    assert.strictEqual(flowJql('SUP', month, false), 'project = "SUP" AND (resolved >= "2026-10-01" AND resolved < "2026-11-01") ORDER BY key');
    assert.strictEqual(releaseJql('PAY', '10012'), 'project = "PAY" AND fixVersion = 10012 ORDER BY key');
    for (const bad of [() => releaseJql('PAY" OR x', '1'), () => releaseJql('PAY', '1 OR 1=1'), () => flowJql('sup', month, true)]) assert.throws(bad);

    const issue = mapIssue(raw('SUP-1', 'Task'), FIELD_IDS, { pi: 'Flow 2026-10', sprintsInScope: new Map(), sprint: 'Flow 2026-10' });
    assert.strictEqual(issue.sprint, 'Flow 2026-10', 'a release or a flow month is its own sprint');
});

test('jira model: feature flags an issue names -- in a field (text, labels, options) or in prefixed labels', () => {
    const field = { type: 'field', id: 'customfield_10050' };
    assert.deepStrictEqual(extractFlagKeys({ customfield_10050: 'newCheckout, darkMode;beta.v2  newCheckout' }, field), ['newCheckout', 'darkMode', 'beta.v2'], 'text, any separators, deduplicated');
    assert.deepStrictEqual(extractFlagKeys({ customfield_10050: ['newCheckout', 'darkMode'] }, field), ['newCheckout', 'darkMode'], 'a labels field');
    assert.deepStrictEqual(extractFlagKeys({ customfield_10050: [{ value: 'newCheckout' }, { value: 'darkMode' }] }, field), ['newCheckout', 'darkMode'], 'multi-select options');
    assert.deepStrictEqual(extractFlagKeys({ customfield_10050: { value: 'newCheckout' } }, field), ['newCheckout'], 'single select');
    assert.deepStrictEqual(extractFlagKeys({ customfield_10050: null }, field), []);
    assert.deepStrictEqual(extractFlagKeys({ customfield_10050: '<script> 1bad ok_one' }, field), ['ok_one'], 'only valid flag keys');
    assert.deepStrictEqual(extractFlagKeys({ customfield_10050: Array.from({ length: 30 }, (_, i) => `f${i}`).join(' ') }, field).length, 20, 'bounded');

    const label = { type: 'label', prefix: 'flag:' };
    assert.deepStrictEqual(extractFlagKeys({ labels: ['flag:newCheckout', 'FLAG:darkMode', 'team-sparks', 'flag:', 'flagged'] }, label), ['newCheckout', 'darkMode']);
    assert.deepStrictEqual(extractFlagKeys({ labels: ['flag:newCheckout'] }, null), [], 'no convention: nothing');
    assert.deepStrictEqual(extractFlagKeys({}, label), []);

    assert.ok(issueFields({ flagLink: field }).includes('customfield_10050'), 'the flag field is fetched');
    assert.ok(!issueFields({ flagLink: label }).some((f) => f.startsWith('customfield_')), 'labels are fetched anyway');
    const issue = mapIssue(raw('ABC-9', 'Story', [], { labels: ['flag:newCheckout'] }), { ...FIELD_IDS, flagLink: label }, { pi: 'PI-27.3', sprintsInScope: new Map() });
    assert.deepStrictEqual(issue.featureFlags, ['newCheckout']);
});

test('jira model: an issue mapped to the dashboard shape, its sprint taken from the board being synced', () => {
    const scope = { pi: 'PI-27.3', sprintsInScope: new Map([[2, sp(2, 'Sparks 27.3.1', 'closed')], [3, sp(3, 'Sparks 27.3.2', 'active')]]) };
    const issue = mapIssue(raw('ABC-1', 'Story', [{ id: 2, name: 'Sparks 27.3.1' }, { id: 3, name: 'Sparks 27.3.2' }, { id: 99, name: 'Rocket 27.3.9' }], {
        parent: { key: 'ABC-10', fields: { summary: 'The epic' } },
        subtasks: [{ fields: { status: { statusCategory: { key: 'done' } } } }, { fields: { status: { statusCategory: { key: 'new' } } } }],
        issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'XYZ-9', fields: { summary: 'API first', status: { statusCategory: { key: 'indeterminate' } } } } }],
        customfield_10021: [{ value: 'Impediment' }],
    }), FIELD_IDS, scope);
    assert.deepStrictEqual(issue, {
        key: 'ABC-1', type: 'Story', title: 'ABC-1 title', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', status: 'In Progress', statusCategory: 'indeterminate',
        dependencyBlocked: true, projectName: 'eMobility Sparks', epicKey: 'ABC-10', epicTitle: 'The epic', impediment: true, subtasks: { done: 1, total: 2 },
        priority: 'Major', created: '2026-09-01T10:00:00.000+0000', resolvedAt: null, featureFlags: [], dependencyNote: 'Blocked by XYZ-9: API first',
    });
    assert.strictEqual(mapIssue(raw('ABC-2', 'Bug', [{ id: 99, name: 'Rocket 27.3.9' }]), FIELD_IDS, scope).sprint, null, 'another board\'s sprint is not this issue\'s here');
    assert.strictEqual(mapIssue(raw('ABC-3', 'Task', [], { customfield_10014: 'ABC-11' }), FIELD_IDS, scope).epicKey, 'ABC-11', 'legacy Epic Link');
    assert.strictEqual(mapIssue(raw('ABC-4', 'Sub'), FIELD_IDS, scope), null, 'sub-tasks are counted on their parent');
    assert.strictEqual(mapIssue(raw('not a key', 'Story'), FIELD_IDS, scope), null);
    assert.strictEqual(mapIssue({ key: 'ABC-5' }, FIELD_IDS, scope), null);
    assert.deepStrictEqual(['Epik', 'Historyjka', 'Błąd', 'Zadanie', 'Spike'].map((name) => issueType({ name, hierarchyLevel: name === 'Epik' ? 1 : 0 })), ['Epic', 'Story', 'Bug', 'Task', 'Task']);
    assert.strictEqual(issueType({ name: 'Initiative', hierarchyLevel: 2 }), null);
    assert.strictEqual(issueType({ name: 'Bug', subtask: true, hierarchyLevel: -1 }), null, 'a sub-task type named like a standard one is still a sub-task');
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { fakeAtlassian } = require('./helpers/atlassian');
const { withScope } = require('../lib/scope');
const { syncAllJira, syncTenant, WEBHOOK_RECONNECT } = require('../lib/jira-sync');

const USERS = { alice: { id: 890_000_001, login: 'alice' }, bob: { id: 890_000_002, login: 'bob' } };
const ATLASSIAN = { clientId: 'atl-client', clientSecret: 'atl-secret', encryptionKey: crypto.randomBytes(32) };
const SITE_A = { id: 'cloud-a', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] };
const SITE_B = { id: 'cloud-b', url: 'https://acme-labs.atlassian.net', name: 'labs', scopes: ['read:jira-work'] };

/**
 * Site A: Sparks (scrum, 10), Rocket (scrum, 11), a kanban board (12), and two team-managed (`simple`) boards: Labs
 * with sprints not named after a PI (13) and Ops with sprints turned off (14). PI-27.3 is current on Sparks.
 */
function siteData() {
    return {
        boards: [
            { id: 10, name: 'Sparks', type: 'scrum', location: { projectKey: 'ABC', projectName: 'eMobility Sparks' } },
            { id: 11, name: 'Rocket', type: 'scrum', location: { projectKey: 'ABC', projectName: 'eMobility Sparks' } },
            { id: 12, name: 'Support', type: 'kanban', location: { projectKey: 'SUP', projectName: 'Support' } },
            { id: 13, name: 'Labs board', type: 'simple', location: { projectKey: 'LAB', projectName: 'Labs' } },
            { id: 14, name: 'Ops board', type: 'simple', location: { projectKey: 'OPS', projectName: 'Ops' } },
        ],
        sprints: {
            10: [sp(101, 'Sparks 27.2.3', 'closed', '2026-06-01', '2026-07-01'), sp(102, 'Sparks 27.3.1', 'closed', '2026-08-01', '2026-08-15'),
                sp(103, 'Sparks 27.3.2', 'active', '2026-08-15', '2026-09-01'), sp(104, 'Sparks 27.4.1', 'future', '2026-11-01')],
            11: [sp(201, 'Rocket 27.3.1', 'active')],
            13: [sp(301, 'Sprint 6', 'closed', '2026-09-01', '2026-09-15'), sp(302, 'Sprint 7', 'active', '2026-09-15', '2026-09-29')],
        },
        fields: [
            { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
            { id: 'customfield_10021', name: 'Flagged', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes' } },
        ],
        issues: [
            raw('ABC-1', 'Story', [{ id: 101, name: 'Sparks 27.2.3' }, { id: 103, name: 'Sparks 27.3.2' }], { parent: { key: 'ABC-10', fields: { summary: 'Checkout' } } }),
            raw('ABC-2', 'Bug', [{ id: 102, name: 'Sparks 27.3.1' }], { status: { name: 'Done', statusCategory: { key: 'done' } } }),
            raw('ABC-3', 'Task', [{ id: 101, name: 'Sparks 27.2.3' }]),
            raw('ABC-4', 'Story', [{ id: 201, name: 'Rocket 27.3.1' }]),
            raw('ABC-5', 'Sub', [{ id: 103, name: 'Sparks 27.3.2' }]),
            raw('ABC-10', 'Epic'),
            raw('LAB-1', 'Story', [{ id: 302, name: 'Sprint 7' }]),
        ],
    };
}

async function setup(t, { sites = [SITE_A], pageSize = 50, scope, webhookUrl = null, fail = {} } = {}) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const jira = { 'cloud-a': siteData(), 'cloud-b': { boards: [{ id: 77, name: 'Labs', type: 'scrum' }], sprints: {}, fields: [], issues: [] } };
    const atlassian = fakeAtlassian({ codes: { c1: sites, c2: sites }, jira, pageSize, fail, ...(scope ? { scope } : {}) });
    const github = fakeGitHub(USERS);
    const fetch = (url, init) => (/^https:\/\/(auth|api)\.atlassian\.com\//.test(url) ? atlassian.handler(url, init) : github(url, init));
    const config = { ...ATLASSIAN, webhookUrl };
    const app = buildApp({ pool, auth: AUTH, atlassian: config, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const start = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/connect`, cookies: { sid: alice } });
    const state = new URL(start.headers.location).searchParams.get('state');
    const cookie = start.cookies.find((c) => c.name === 'jira_connect').value;
    assert.strictEqual((await app.inject({ method: 'GET', url: `/auth/atlassian/callback?code=c1&state=${state}`, cookies: { sid: alice, jira_connect: cookie } })).statusCode, 302);

    const call = (method, url, payload, sid = alice) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid }, payload });
    const api = async (url) => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}${url}`, cookies: { sid: alice } })).json();
    const rows = (sql) => withScope(pool, { tenantId }, async (c) => (await c.query(sql)).rows);
    return { pool, app, alice, tenantId, call, api, rows, jira, atlassian, fetch, config };
}

test('FR-008: admins see every board of the site with its type and choose which to sync (kanban too); unknown ids are refused', async (t) => {
    const { app, tenantId, call } = await setup(t, { pageSize: 1 });
    const boards = await call('GET', '/jira/boards');
    assert.strictEqual(boards.statusCode, 200, boards.body);
    assert.deepStrictEqual(boards.json().boards, [
        { boardId: 10, name: 'Sparks', type: 'scrum', projectKey: 'ABC', projectName: 'eMobility Sparks', selected: false },
        { boardId: 11, name: 'Rocket', type: 'scrum', projectKey: 'ABC', projectName: 'eMobility Sparks', selected: false },
        { boardId: 12, name: 'Support', type: 'kanban', projectKey: 'SUP', projectName: 'Support', selected: false },
        { boardId: 13, name: 'Labs board', type: 'simple', projectKey: 'LAB', projectName: 'Labs', selected: false },
        { boardId: 14, name: 'Ops board', type: 'simple', projectKey: 'OPS', projectName: 'Ops', selected: false },
    ], 'team-managed (simple) boards are listed too: filtering on type=scrum hid them');

    assert.strictEqual((await call('PUT', '/jira/boards', { boardIds: [10] })).statusCode, 200);
    assert.deepStrictEqual((await call('GET', '/jira/boards')).json().boards.filter((b) => b.selected).map((b) => b.boardId), [10]);
    assert.strictEqual((await call('PUT', '/jira/boards', { boardIds: [10, 12] })).statusCode, 200, 'a kanban board syncs as a flow');
    assert.match((await call('PUT', '/jira/boards', { boardIds: [10, 999] })).json().error, /Board 999 is not on the connected Jira site/);
    for (const [payload, code] of [[{ boardIds: [999] }, 400], [{ boardIds: ['10'] }, 400], [{ boardIds: [10, 10] }, 400], [{}, 400]]) {
        assert.strictEqual((await call('PUT', '/jira/boards', payload)).statusCode, code, JSON.stringify(payload));
    }

    const bob = await signIn(app, 'bob');
    const link = (await call('POST', '/invitations', { role: 'member' })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    assert.strictEqual((await call('GET', '/jira/boards', undefined, bob)).statusCode, 403);
    assert.strictEqual((await call('PUT', '/jira/boards', { boardIds: [11] }, bob)).statusCode, 403);
    assert.strictEqual((await call('POST', '/jira/sync', undefined, bob)).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/jira-issues?pi=PI-27.3`, cookies: { sid: bob } })).statusCode, 200, 'members read issues');
});

test('FR-009: the current PI of each board (plus the previous one on its first sync) lands in the dashboard shapes', async (t) => {
    const { call, api, jira } = await setup(t, { pageSize: 1 });
    await call('PUT', '/jira/boards', { boardIds: [10] });
    const sync = await call('POST', '/jira/sync');
    assert.strictEqual(sync.statusCode, 200, sync.body);
    assert.deepStrictEqual(sync.json(), { boards: 1, issues: 6, currentPi: 'PI-27.3', partial: false }, 'PI-27.3: ABC-1, ABC-2, Epic ABC-10; PI-27.2: ABC-1, ABC-3, Epic ABC-10');

    const data = await api('/dashboard-data');
    assert.deepStrictEqual(data.jiraIndex, {
        currentPi: 'PI-27.3',
        pis: [
            { pi: 'PI-27.3', kind: 'pi', file: 'PI-27.3.json', sprints: [
                { name: 'Sparks 27.3.1', startDate: '2026-08-01', endDate: '2026-08-15' },
                { name: 'Sparks 27.3.2', startDate: '2026-08-15', endDate: '2026-09-01' },
            ] },
            { pi: 'PI-27.2', kind: 'pi', file: 'PI-27.2.json', sprints: [{ name: 'Sparks 27.2.3', startDate: '2026-06-01', endDate: '2026-07-01' }] },
        ],
    });
    // ABC-1 was in PI-27.2 too (its sprint history), but its newest PI wins in the status index.
    assert.deepStrictEqual(data.issueStatusIndex, {
        'ABC-1': { pi: 'PI-27.3', statusCategory: 'indeterminate' }, 'ABC-2': { pi: 'PI-27.3', statusCategory: 'done' },
        'ABC-10': { pi: 'PI-27.3', statusCategory: 'indeterminate' }, 'ABC-3': { pi: 'PI-27.2', statusCategory: 'indeterminate' },
    });

    const current = await api('/jira-issues?pi=PI-27.3');
    assert.deepStrictEqual(current.map((i) => [i.key, i.type, i.sprint, i.epicKey]), [
        ['ABC-1', 'Story', 'Sparks 27.3.2', 'ABC-10'], ['ABC-10', 'Epic', null, null], ['ABC-2', 'Bug', 'Sparks 27.3.1', null],
    ], 'the sub-task is not listed, the Rocket board\'s ABC-4 is not synced, the Epic is fetched for its header');
    assert.deepStrictEqual((await api('/jira-issues?pi=PI-27.2')).map((i) => [i.key, i.sprint]), [['ABC-1', 'Sparks 27.2.3'], ['ABC-10', null], ['ABC-3', 'Sparks 27.2.3']],
        'carried over from PI-27.2: the dashboard shows it as continued in PI-27.3 (issueStatusIndex)');

    // Next pass: ABC-2 moved to the next PI, ABC-3 (a past PI) changed in Jira.
    const issues = jira['cloud-a'].issues;
    issues.find((i) => i.key === 'ABC-2').fields.customfield_10020 = [{ id: 104, name: 'Sparks 27.4.1' }];
    issues.find((i) => i.key === 'ABC-3').fields.summary = 'renamed later';
    assert.deepStrictEqual((await call('POST', '/jira/sync')).json(), { boards: 1, issues: 2, currentPi: 'PI-27.3', partial: false });
    assert.deepStrictEqual((await api('/jira-issues?pi=PI-27.3')).map((i) => i.key), ['ABC-1', 'ABC-10'], 'gone from the PI it left');
    assert.strictEqual((await api('/jira-issues?pi=PI-27.2')).find((i) => i.key === 'ABC-3').title, 'ABC-3 title', 'a past PI is the snapshot taken while it was current');
    assert.ok((await call('GET', '/jira')).json().lastSyncedAt);
});

test('FR-009: deselecting a board removes its issues; switching sites starts over', async (t) => {
    const { call, api, rows } = await setup(t, { sites: [SITE_A, SITE_B] });
    assert.strictEqual((await call('PUT', '/jira/site', { cloudId: 'cloud-a' })).statusCode, 200);
    await call('PUT', '/jira/boards', { boardIds: [10, 11] });
    assert.strictEqual((await call('POST', '/jira/sync')).json().issues, 7, 'Sparks: 3 + 3 in the previous PI; Rocket: ABC-4');
    await call('PUT', '/jira/boards', { boardIds: [10] });
    assert.ok(!(await api('/jira-issues?pi=PI-27.3')).some((i) => i.key === 'ABC-4'));

    await call('PUT', '/jira/site', { cloudId: 'cloud-b' });
    assert.deepStrictEqual([await rows('SELECT * FROM jira_boards'), await rows('SELECT * FROM jira_issues'), await rows('SELECT * FROM jira_pis')], [[], [], []]);
    assert.deepStrictEqual((await api('/dashboard-data')).jiraIndex, { currentPi: null, pis: [] });
});

test('FR-009: the worker syncs every connected tenant; a failing one is recorded and the pass goes on', async (t) => {
    const { pool, call, tenantId, fetch, jira, rows } = await setup(t);
    await call('PUT', '/jira/boards', { boardIds: [10] });
    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch }), { tenants: 1, issues: 6, failed: 0, deferred: 0 });

    // Jira answers the issue search with an error: recorded on the connection, nothing stored is lost.
    const failing = fakeAtlassian({ jira, fail: { '/search/jql': 500 } });
    const log = [];
    const failingFetch = (url, init) => (url.includes('/search/jql') ? failing.handler(url, init) : fetch(url, init));
    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch: failingFetch, log: (m) => log.push(m) }), { tenants: 1, issues: 0, failed: 1, deferred: 0 });
    assert.match(log[0], new RegExp(`tenant ${tenantId}: Jira sync failed`));
    assert.match((await call('GET', '/jira')).json().lastError, /Jira sync failed: GET \/ex\/jira\/cloud-a\/rest\/api\/3\/search\/jql failed with HTTP 500/);
    assert.strictEqual((await rows('SELECT * FROM jira_issues')).length, 6);

    assert.strictEqual((await pool.query('SELECT * FROM jira_issues')).rows.length, 0, 'RLS: unscoped reads see nothing');
});

test('FR-009: a team-managed board with sprints syncs by sprint; one with sprints turned off is a (here empty) flow and fails nothing', async (t) => {
    const { call, api } = await setup(t);
    assert.strictEqual((await call('PUT', '/jira/boards', { boardIds: [13, 14] })).statusCode, 200);
    const sync = await call('POST', '/jira/sync');
    assert.strictEqual(sync.statusCode, 200, sync.body);
    assert.deepStrictEqual(sync.json(), { boards: 2, issues: 1, currentPi: 'Sprint 7', partial: false },
        'sprints not named after a PI are their own increment; the previous one (Sprint 6) is empty; an empty flow month is not "now"');
    assert.deepStrictEqual((await api('/jira-issues?pi=Sprint 7')).map((i) => [i.key, i.sprint]), [['LAB-1', 'Sprint 7']]);
    assert.strictEqual((await call('GET', '/jira')).json().lastError, null);
});

test('mixed rhythms: a SAFe board and a Scrum board open together on "Now"; each issue keeps its own increment', async (t) => {
    const { call, api } = await setup(t);
    await call('PUT', '/jira/boards', { boardIds: [10, 13] });
    assert.deepStrictEqual((await call('POST', '/jira/sync')).json(), { boards: 2, issues: 7, currentPi: '@now', partial: false });

    const { jiraIndex } = await api('/dashboard-data');
    assert.strictEqual(jiraIndex.currentPi, '@now');
    assert.deepStrictEqual(jiraIndex.pis.map((p) => [p.pi, p.kind]), [['@now', 'now'], ['PI-27.3', 'pi'], ['PI-27.2', 'pi'], ['Sprint 7', 'sprint']]);
    assert.deepStrictEqual([jiraIndex.pis[0].label, jiraIndex.pis[0].includes], ['Now: PI-27.3, Sprint 7', ['PI-27.3', 'Sprint 7']]);
    assert.deepStrictEqual(jiraIndex.pis[0].sprints.map((x) => x.name), ['Sparks 27.3.1', 'Sparks 27.3.2', 'Sprint 7'], 'the sprints of every joined increment');

    const now = await api('/jira-issues?pi=@now');
    assert.deepStrictEqual(now.map((i) => [i.key, i.pi]), [['ABC-1', 'PI-27.3'], ['ABC-10', 'PI-27.3'], ['ABC-2', 'PI-27.3'], ['LAB-1', 'Sprint 7']]);
    assert.deepStrictEqual((await call('GET', '/jira')).json().currentPi, '@now');
});

test('board rhythm: an admin sets it per board (with an own PI naming); a change re-syncs the board from scratch', async (t) => {
    const { app, call, api, rows } = await setup(t);
    await call('PUT', '/jira/boards', { boardIds: [10, 13] });
    await call('POST', '/jira/sync');

    // The Scrum team's sprints are named "Sprint 7": the admin says they are PI 7.
    const put = (boardId, payload, sid) => call('PUT', `/jira/boards/${boardId}`, payload, sid);
    assert.deepStrictEqual((await put(13, { rhythm: 'pi', piTemplate: 'Sprint {pi}' })).json(), { boardId: 13, rhythm: 'pi', piTemplate: 'Sprint {pi}' });
    assert.deepStrictEqual(await rows('SELECT key FROM jira_issues WHERE board_id = 13'), [], 'dropped until the next sync');
    await call('POST', '/jira/sync');
    let index = (await api('/dashboard-data')).jiraIndex;
    assert.deepStrictEqual(index.pis.filter((p) => p.pi.startsWith('PI-') && p.pi !== 'PI-27.3' && p.pi !== 'PI-27.2').map((p) => [p.pi, p.kind]), [['PI-7', 'pi']],
        'PI-6 (Sprint 6) was synced too, but has no issues, so the dashboard does not list it');
    assert.deepStrictEqual(index.pis[0].includes, ['PI-27.3', 'PI-7']);

    // The SAFe board switched to plain sprints: its increments become its sprints.
    await put(10, { rhythm: 'sprint', piTemplate: null });
    await call('POST', '/jira/sync');
    index = (await api('/dashboard-data')).jiraIndex;
    assert.ok(index.pis.some((p) => p.pi === 'Sparks 27.3.2' && p.kind === 'sprint'));
    assert.deepStrictEqual((await call('GET', '/jira/boards')).json().boards.filter((b) => b.selected).map((b) => [b.boardId, b.rhythm, b.currentIncrement]),
        [[10, 'sprint', 'Sparks 27.3.2'], [13, 'pi', 'PI-7']]);

    for (const [boardId, payload] of [
        [13, { rhythm: 'pi', piTemplate: 'no placeholder' }],
        [13, { rhythm: 'sprint', piTemplate: 'Sprint {pi}' }],
        [13, { rhythm: 'release', piTemplate: 'Sprint {pi}' }],
        [13, { rhythm: 'flow', piTemplate: 'Sprint {pi}' }],
        [11, { rhythm: 'pi', piTemplate: null }],
        [13, { rhythm: 'weekly', piTemplate: null }],
        [13, { rhythm: 'pi' }],
    ]) {
        assert.strictEqual((await put(boardId, payload)).statusCode, 400, JSON.stringify([boardId, payload]));
    }
    const bob = await signIn(app, 'bob');
    const link = (await call('POST', '/invitations', { role: 'member' })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    assert.strictEqual((await put(13, { rhythm: 'auto', piTemplate: null }, bob)).statusCode, 403);
});


test('releases: a board in the release rhythm syncs its project\'s current fixVersion (and the last released one, first time)', async (t) => {
    const { call, api, jira } = await setup(t);
    const site = jira['cloud-a'];
    const version = (id, name, released, releaseDate, archived = false) => ({ id, name, released, releaseDate, archived, self: 'x' });
    site.versions = { ABC: [version('10', '1.0', true, '2026-07-01'), version('11', '1.1', true, '2026-09-01'), version('12', '1.2', false, '2026-11-01'),
        version('9', '1.3', false, '2026-10-20', true)] };
    const fix = (id) => ({ fixVersions: [{ id }], project: { key: 'ABC', name: 'eMobility Sparks' } });
    site.issues.push(raw('ABC-20', 'Story', [], fix('12')), raw('ABC-21', 'Bug', [], fix('11')), raw('ABC-22', 'Task', [], fix('10')), raw('ABC-23', 'Task', [], fix('9')));

    await call('PUT', '/jira/boards', { boardIds: [11] });
    assert.strictEqual((await call('PUT', '/jira/boards/11', { rhythm: 'release', piTemplate: null })).statusCode, 200);
    assert.deepStrictEqual((await call('POST', '/jira/sync')).json(), { boards: 1, issues: 2, currentPi: 'ABC 1.2', partial: false }, 'the archived 1.3 is not a release to follow');

    const { jiraIndex } = await api('/dashboard-data');
    assert.deepStrictEqual(jiraIndex.pis.map((p) => [p.pi, p.kind, p.sprints]), [
        ['ABC 1.2', 'release', [{ name: 'ABC 1.2', startDate: null, endDate: '2026-11-01' }]],
        ['ABC 1.1', 'release', [{ name: 'ABC 1.1', startDate: null, endDate: '2026-09-01' }]],
    ]);
    assert.deepStrictEqual((await api('/jira-issues?pi=ABC 1.2')).map((i) => [i.key, i.pi, i.sprint]), [['ABC-20', 'ABC 1.2', 'ABC 1.2']]);

    // 1.2 ships: the next one due is current; the board has issues, so the previous release is not fetched again.
    site.versions.ABC[2].released = true;
    site.versions.ABC.push(version('14', '1.4', false, '2026-12-01'));
    site.issues.push(raw('ABC-24', 'Story', [], fix('14')));
    assert.deepStrictEqual((await call('POST', '/jira/sync')).json(), { boards: 1, issues: 1, currentPi: 'ABC 1.4', partial: false });
});

test('flow: a kanban board syncs by calendar month -- resolved in it, plus what is in progress now -- and joins the others on "Now"', async (t) => {
    const { call, api, jira } = await setup(t);
    const site = jira['cloud-a'];
    const thisMonth = flowMonth(new Date());
    const lastMonth = flowMonth(new Date(), -1);
    const twoAgo = flowMonth(new Date(), -2);
    const sup = (key, status, resolutiondate = null) => raw(key, 'Task', [], {
        project: { key: 'SUP', name: 'Support' }, resolutiondate,
        status: { name: status, statusCategory: { key: { Done: 'done', 'In Progress': 'indeterminate', 'To Do': 'new' }[status] } },
    });
    site.issues.push(sup('SUP-1', 'In Progress'), sup('SUP-2', 'Done', `${thisMonth.start}T10:00:00.000+0000`), sup('SUP-3', 'Done', `${lastMonth.start}T10:00:00.000+0000`),
        sup('SUP-4', 'To Do'), sup('SUP-5', 'Done', `${twoAgo.start}T10:00:00.000+0000`));

    await call('PUT', '/jira/boards', { boardIds: [10, 12] });
    const sync = (await call('POST', '/jira/sync')).json();
    assert.deepStrictEqual(sync, { boards: 2, issues: 9, currentPi: '@now', partial: false }, 'PI-27.3 (3) + PI-27.2 (3) + this month (SUP-1, SUP-2) + last month (SUP-3)');

    const { jiraIndex } = await api('/dashboard-data');
    assert.deepStrictEqual(jiraIndex.pis.filter((p) => p.kind === 'flow').map((p) => [p.pi, p.sprints]), [
        [thisMonth.name, [{ name: thisMonth.name, startDate: `${thisMonth.start}T00:00:00.000Z`, endDate: `${thisMonth.end}T00:00:00.000Z` }]],
        [lastMonth.name, [{ name: lastMonth.name, startDate: `${lastMonth.start}T00:00:00.000Z`, endDate: `${lastMonth.end}T00:00:00.000Z` }]],
    ]);
    assert.deepStrictEqual(jiraIndex.pis[0].includes, [thisMonth.name, 'PI-27.3']);
    assert.deepStrictEqual((await api(`/jira-issues?pi=${thisMonth.name}`)).map((i) => [i.key, i.sprint]), [['SUP-1', thisMonth.name], ['SUP-2', thisMonth.name]]);
    assert.deepStrictEqual((await api(`/jira-issues?pi=${lastMonth.name}`)).map((i) => i.key), ['SUP-3']);
});

test('webhooks: the sync registers one for the selected boards\' projects, re-registers when they change, refreshes before 30 days', async (t) => {
    const url = 'https://shipscope.example/webhooks/jira';
    const { pool, call, tenantId, atlassian, fetch, config } = await setup(t, { scope: 'read:jira-work manage:jira-webhook offline_access', webhookUrl: url });
    const events = ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'];
    await call('PUT', '/jira/boards', { boardIds: [10] });
    await call('POST', '/jira/sync');
    assert.deepStrictEqual(atlassian.webhookCalls.map((c) => [c.cloudId, c.method, c.body]), [['cloud-a', 'POST', { url, webhooks: [{ events, jqlFilter: 'project in ("ABC")' }] }]]);
    const { webhook } = (await call('GET', '/jira')).json();
    assert.deepStrictEqual([webhook.active, webhook.error], [true, null]);
    assert.ok(Date.parse(webhook.expiresAt) - Date.now() > 29 * 24 * 3600_000);

    await call('POST', '/jira/sync');
    assert.strictEqual(atlassian.webhookCalls.length, 1, 'nothing to do while it is fresh and the projects are the same');

    await call('PUT', '/jira/boards', { boardIds: [10, 11, 12] });
    await call('POST', '/jira/sync');
    assert.deepStrictEqual(atlassian.webhookCalls.slice(1).map((c) => [c.method, c.body]), [
        ['DELETE', { webhookIds: [1000] }],
        ['POST', { url, webhooks: [{ events, jqlFilter: 'project in ("ABC", "SUP")' }] }],
    ], 'one webhook per tenant, over every selected board\'s project (ABC once)');

    await syncTenant(pool, { tenantId, atlassian: config, fetch, now: new Date(Date.now() + 25 * 24 * 3600_000) });
    assert.deepStrictEqual(atlassian.webhookCalls.slice(3).map((c) => [c.method, c.path, c.body]), [['PUT', '/rest/api/3/webhook/refresh', { webhookIds: [1001] }]]);
    assert.strictEqual((await call('GET', '/jira')).json().webhook.expiresAt, '2026-12-01T00:00:00.000Z');

    // A delivery names the tenant by its webhook, its cloud or its site; nothing else syncs it.
    for (const [keys, tenants] of [[['webhook:1001'], 1], [['cloud:cloud-a'], 1], [['site:https://acme.atlassian.net'], 1], [['webhook:1000'], 0], [['site:https://other.atlassian.net'], 0]]) {
        assert.strictEqual((await syncAllJira({ pool, atlassian: config, fetch, keys })).tenants, tenants, JSON.stringify(keys));
    }
});

test('webhooks: off without the scope (an older connection) or a public URL; a refused registration never fails the sync', async (t) => {
    const scoped = 'read:jira-work manage:jira-webhook offline_access';
    {
        const { call, atlassian } = await setup(t, { webhookUrl: 'https://shipscope.example/webhooks/jira' });
        await call('PUT', '/jira/boards', { boardIds: [10] });
        assert.strictEqual((await call('POST', '/jira/sync')).statusCode, 200);
        assert.deepStrictEqual((await call('GET', '/jira')).json().webhook, { active: false, expiresAt: null, error: WEBHOOK_RECONNECT });
        assert.deepStrictEqual(atlassian.webhookCalls, []);
    }
    {
        const { call, atlassian } = await setup(t, { scope: scoped });
        await call('PUT', '/jira/boards', { boardIds: [10] });
        await call('POST', '/jira/sync');
        assert.deepStrictEqual((await call('GET', '/jira')).json().webhook, { active: false, expiresAt: null, error: null }, 'no https URL to be called on');
        assert.deepStrictEqual(atlassian.webhookCalls, []);
    }
    {
        const { call } = await setup(t, { scope: scoped, webhookUrl: 'https://shipscope.example/webhooks/jira', fail: { '/rest/api/3/webhook': 403 } });
        await call('PUT', '/jira/boards', { boardIds: [10] });
        const sync = await call('POST', '/jira/sync');
        assert.deepStrictEqual(sync.json(), { boards: 1, issues: 6, currentPi: 'PI-27.3', partial: false }, 'the issues still synced');
        const { webhook, lastError } = (await call('GET', '/jira')).json();
        assert.strictEqual(webhook.active, false);
        assert.match(webhook.error, /^Instant updates are off: POST \/ex\/jira\/cloud-a\/rest\/api\/3\/webhook failed with HTTP 403$/);
        assert.strictEqual(lastError, null, 'a webhook problem is not a sync error');
    }
});

test('fairness: past the tenant\'s time budget no further board starts; the next pass begins with the boards that waited', async (t) => {
    const { pool, call, rows, fetch } = await setup(t);
    await call('PUT', '/jira/boards', { boardIds: [10, 13] });
    const pass = (now) => syncAllJira({ pool, atlassian: ATLASSIAN, fetch, now, clock: () => 1_000, tenantBudgetMs: 0 });
    const synced = async () => (await rows('SELECT board_id, last_synced_at FROM jira_boards ORDER BY board_id')).map((r) => [Number(r.board_id), r.last_synced_at && r.last_synced_at.toISOString()]);

    const log = [];
    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch, now: new Date('2026-09-20T10:00:00Z'), clock: () => 1_000, tenantBudgetMs: 0, log: (m) => log.push(m) }),
        { tenants: 1, issues: 6, failed: 0, deferred: 1 }, 'one board, the first by id since neither has synced');
    assert.match(log[0], /1 Jira board\(s\) synced, the rest next pass \(time budget\)/);
    assert.deepStrictEqual(await synced(), [[10, '2026-09-20T10:00:00.000Z'], [13, null]]);
    assert.strictEqual((await call('GET', '/jira')).json().currentPi, 'PI-27.3', 'what is synced is usable at once');

    assert.deepStrictEqual(await pass(new Date('2026-09-20T10:15:00Z')), { tenants: 1, issues: 1, failed: 0, deferred: 1 }, 'the board that waited goes first');
    assert.deepStrictEqual(await synced(), [[10, '2026-09-20T10:00:00.000Z'], [13, '2026-09-20T10:15:00.000Z']]);
    assert.strictEqual((await call('GET', '/jira')).json().currentPi, '@now', 'both boards\' increments together');
    await pass(new Date('2026-09-20T10:30:00Z'));
    assert.deepStrictEqual(await synced(), [[10, '2026-09-20T10:30:00.000Z'], [13, '2026-09-20T10:15:00.000Z']], 'and round they go');

    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch }), { tenants: 1, issues: 4, failed: 0, deferred: 0 }, 'with the default budget: both (current increments only: neither is a first sync any more)');
});

test('fairness: Atlassian\'s rate limit pauses the connection until its Retry-After -- not an error, no other tenant affected', async (t) => {
    const { pool, call, fetch, rows } = await setup(t);
    await call('PUT', '/jira/boards', { boardIds: [10] });
    let jiraCalls = 0;
    const limited = (url, init) => {
        if (url.includes('/ex/jira/')) jiraCalls += 1;
        if (url.includes('/search/jql')) return new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
        return fetch(url, init);
    };
    const log = [];
    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch: limited, log: (m) => log.push(m) }), { tenants: 1, issues: 0, failed: 0, deferred: 1 });
    assert.match(log[0], /Atlassian rate limit, Jira sync paused until/);
    const conn = (await call('GET', '/jira')).json();
    assert.strictEqual(conn.lastError, null, 'nothing for the admin to fix');
    assert.ok(Math.abs(Date.parse(conn.rateLimitedUntil) - (Date.now() + 120_000)) < 10_000, 'paused for Retry-After');
    const [row] = await rows('SELECT last_attempt_at FROM jira_connections');
    assert.ok(row.last_attempt_at);

    jiraCalls = 0;
    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch: limited }), { tenants: 0, issues: 0, failed: 0, deferred: 1 });
    assert.strictEqual(jiraCalls, 0, 'not asked again while paused');

    const later = Date.now() + 130_000;
    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch, clock: () => later }), { tenants: 1, issues: 6, failed: 0, deferred: 0 });
    await rows("UPDATE jira_connections SET rate_limited_until = now() - interval '1 second'");
    assert.strictEqual((await call('GET', '/jira')).json().rateLimitedUntil, null, 'a pause that is over is not shown');
});

test('fairness: the Jira connection that waited longest syncs first', async (t) => {
    const { app, pool, call, fetch, tenantId } = await setup(t);
    await call('PUT', '/jira/boards', { boardIds: [10] });
    // A second workspace on the same site, syncing another board.
    const bob = await signIn(app, 'bob');
    const other = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: bob }, payload: { name: 'Labs' } })).json().tenant.id;
    const start = await app.inject({ method: 'GET', url: `/tenants/${other}/jira/connect`, cookies: { sid: bob } });
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await app.inject({ method: 'GET', url: `/auth/atlassian/callback?code=c2&state=${state}`, cookies: { sid: bob, jira_connect: start.cookies.find((c) => c.name === 'jira_connect').value } });
    assert.strictEqual(cb.statusCode, 302, cb.body);
    const put = await app.inject({ method: 'PUT', url: `/tenants/${other}/jira/boards`, cookies: { sid: bob }, payload: { boardIds: [13] } });
    assert.strictEqual(put.statusCode, 200, put.body);

    const order = async () => {
        const boards = [];
        await syncAllJira({ pool, atlassian: ATLASSIAN, fetch: (url, init) => {
            const m = url.match(/\/board\/(\d+)\/sprint/);
            if (m && !boards.includes(m[1])) boards.push(m[1]);
            return fetch(url, init);
        } });
        return boards;
    };
    assert.deepStrictEqual(await order(), ['10', '13'], 'never tried: in the order the workspaces were created');
    const setAttempt = (id, ago) => withScope(pool, { tenantId: id }, (c) => c.query(`UPDATE jira_connections SET last_attempt_at = now() - interval '${ago}'`));
    await setAttempt(tenantId, '1 minute');
    await setAttempt(other, '1 hour');
    assert.deepStrictEqual(await order(), ['13', '10'], 'Labs waited longer');
});
