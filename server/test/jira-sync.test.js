const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { piOfSprint, currentPiOf, previousPiOf, issueType, mapIssue, comparePiDesc, compileTemplate, rhythmOf, RhythmTemplateError } = require('../lib/jira-model');

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
        priority: 'Major', created: '2026-09-01T10:00:00.000+0000', resolvedAt: null, dependencyNote: 'Blocked by XYZ-9: API first',
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
const { syncAllJira } = require('../lib/jira-sync');

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
            { id: 12, name: 'Support', type: 'kanban' },
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

async function setup(t, { sites = [SITE_A], pageSize = 50 } = {}) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const jira = { 'cloud-a': siteData(), 'cloud-b': { boards: [{ id: 77, name: 'Labs', type: 'scrum' }], sprints: {}, fields: [], issues: [] } };
    const atlassian = fakeAtlassian({ codes: { c1: sites }, jira, pageSize });
    const github = fakeGitHub(USERS);
    const fetch = (url, init) => (/^https:\/\/(auth|api)\.atlassian\.com\//.test(url) ? atlassian.handler(url, init) : github(url, init));
    const app = buildApp({ pool, auth: AUTH, atlassian: ATLASSIAN, fetch });
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
    return { pool, app, alice, tenantId, call, api, rows, jira, atlassian, fetch };
}

test('FR-008: admins see every board of the site with its type and choose which to sync; kanban boards and unknown ids are refused', async (t) => {
    const { app, tenantId, call } = await setup(t, { pageSize: 1 });
    const boards = await call('GET', '/jira/boards');
    assert.strictEqual(boards.statusCode, 200, boards.body);
    assert.deepStrictEqual(boards.json().boards, [
        { boardId: 10, name: 'Sparks', type: 'scrum', projectKey: 'ABC', projectName: 'eMobility Sparks', selected: false },
        { boardId: 11, name: 'Rocket', type: 'scrum', projectKey: 'ABC', projectName: 'eMobility Sparks', selected: false },
        { boardId: 12, name: 'Support', type: 'kanban', projectKey: null, projectName: null, selected: false },
        { boardId: 13, name: 'Labs board', type: 'simple', projectKey: 'LAB', projectName: 'Labs', selected: false },
        { boardId: 14, name: 'Ops board', type: 'simple', projectKey: 'OPS', projectName: 'Ops', selected: false },
    ], 'team-managed (simple) boards are listed too: filtering on type=scrum hid them');

    assert.strictEqual((await call('PUT', '/jira/boards', { boardIds: [10] })).statusCode, 200);
    assert.deepStrictEqual((await call('GET', '/jira/boards')).json().boards.filter((b) => b.selected).map((b) => b.boardId), [10]);
    const kanban = await call('PUT', '/jira/boards', { boardIds: [10, 12] });
    assert.match(kanban.json().error, /kanban board: it has no sprints/);
    for (const [payload, code] of [[{ boardIds: [12] }, 400], [{ boardIds: [999] }, 400], [{ boardIds: ['10'] }, 400], [{ boardIds: [10, 10] }, 400], [{}, 400]]) {
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
    assert.deepStrictEqual(sync.json(), { boards: 1, issues: 6, currentPi: 'PI-27.3' }, 'PI-27.3: ABC-1, ABC-2, Epic ABC-10; PI-27.2: ABC-1, ABC-3, Epic ABC-10');

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
    assert.deepStrictEqual((await call('POST', '/jira/sync')).json(), { boards: 1, issues: 2, currentPi: 'PI-27.3' });
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
    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch }), { tenants: 1, issues: 6, failed: 0 });

    // Jira answers the issue search with an error: recorded on the connection, nothing stored is lost.
    const failing = fakeAtlassian({ jira, fail: { '/search/jql': 500 } });
    const log = [];
    const failingFetch = (url, init) => (url.includes('/search/jql') ? failing.handler(url, init) : fetch(url, init));
    assert.deepStrictEqual(await syncAllJira({ pool, atlassian: ATLASSIAN, fetch: failingFetch, log: (m) => log.push(m) }), { tenants: 1, issues: 0, failed: 1 });
    assert.match(log[0], new RegExp(`tenant ${tenantId}: Jira sync failed`));
    assert.match((await call('GET', '/jira')).json().lastError, /Jira sync failed: GET \/ex\/jira\/cloud-a\/rest\/api\/3\/search\/jql failed with HTTP 500/);
    assert.strictEqual((await rows('SELECT * FROM jira_issues')).length, 6);

    assert.strictEqual((await pool.query('SELECT * FROM jira_issues')).rows.length, 0, 'RLS: unscoped reads see nothing');
});

test('FR-009: a team-managed board with sprints syncs by sprint; one with sprints turned off adds nothing and fails nothing', async (t) => {
    const { call, api } = await setup(t);
    assert.strictEqual((await call('PUT', '/jira/boards', { boardIds: [13, 14] })).statusCode, 200);
    const sync = await call('POST', '/jira/sync');
    assert.strictEqual(sync.statusCode, 200, sync.body);
    assert.deepStrictEqual(sync.json(), { boards: 2, issues: 1, currentPi: 'Sprint 7' }, 'sprints not named after a PI are their own increment; the previous one (Sprint 6) is empty');
    assert.deepStrictEqual((await api('/jira-issues?pi=Sprint 7')).map((i) => [i.key, i.sprint]), [['LAB-1', 'Sprint 7']]);
    assert.strictEqual((await call('GET', '/jira')).json().lastError, null);
});

test('mixed rhythms: a SAFe board and a Scrum board open together on "Now"; each issue keeps its own increment', async (t) => {
    const { call, api } = await setup(t);
    await call('PUT', '/jira/boards', { boardIds: [10, 13] });
    assert.deepStrictEqual((await call('POST', '/jira/sync')).json(), { boards: 2, issues: 7, currentPi: '@now' });

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

