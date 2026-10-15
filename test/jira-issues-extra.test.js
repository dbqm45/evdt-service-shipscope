const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JIRA_BASE_URL = 'https://jira.example/api';

const {
    pickBestType,
    buildFallbackIssuesFromDeployments,
    findSpecialFieldIds,
    extractTeamName,
    extractTeamNames,
    resolveEpicTitles,
    fillMissingEpicTitles,
    fetchAndMapIssuesForJql,
} = require('../scripts/lib/jira-issues');

const realFetch = global.fetch;
const realLog = console.log;
const realWarn = console.warn;
let logs;
let warns;

function quiet() {
    logs = [];
    warns = [];
    console.log = m => logs.push(m);
    console.warn = (...a) => warns.push(a.join(' '));
}

test.afterEach(() => {
    global.fetch = realFetch;
    console.log = realLog;
    console.warn = realWarn;
});

function resp(body, status = 200) {
    return { ok: status < 300, status, json: async () => body, text: async () => 'ERR' };
}

test('buildFallbackIssuesFromDeployments: no allowlist, sorted, missing commit types', () => {
    const out = buildFallbackIssuesFromDeployments([
        { relatedIssues: ['B-2', 'A-1'], issueCommitTypes: { 'B-2': 'chore', 'A-1': 'feat' } },
        { relatedIssues: ['B-2'], issueCommitTypes: { 'B-2': 'fix' } },
        { relatedIssues: ['C-3'] },
        {},
    ], null);
    assert.deepEqual(out.map(i => [i.key, i.type]), [['A-1', 'feat'], ['B-2', 'fix'], ['C-3', 'other']]);
    assert.equal(pickBestType(['x']), 'x');
});

test('extractTeamName edge shapes', () => {
    assert.equal(extractTeamName(5), null);
    assert.equal(extractTeamName('  '), null);
    assert.equal(extractTeamName({ value: 'V' }), 'V');
    assert.equal(extractTeamName({ displayName: 'D' }), 'D');
    assert.equal(extractTeamName({ name: 5 }), null);
    assert.equal(extractTeamName({ name: '  ' }), null);
    assert.equal(extractTeamName({}), null);
    assert.deepEqual(extractTeamNames(5), []);
});

test('findSpecialFieldIds: all fields found', async () => {
    quiet();
    global.fetch = async () => resp([
        { id: 'cf1', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
        { id: 'cf2', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
        { id: 'cf3', name: 'Flagged' },
        { id: 'cf4', name: 'team' },
        { id: 'cf5' },
    ]);
    assert.deepEqual(await findSpecialFieldIds({}), {
        sprintFieldId: 'cf1', epicLinkFieldId: 'cf2', flaggedFieldId: 'cf3', teamFieldId: 'cf4',
    });
    assert.equal(logs.length, 4);
});

test('findSpecialFieldIds: none found warns; non-ok throws', async () => {
    quiet();
    global.fetch = async () => resp([]);
    assert.deepEqual(await findSpecialFieldIds({}), {
        sprintFieldId: null, epicLinkFieldId: null, flaggedFieldId: null, teamFieldId: null,
    });
    assert.match(warns[0], /gh-sprint/);
    global.fetch = async () => resp({}, 500);
    await assert.rejects(() => findSpecialFieldIds({}), /500 ERR/);
});

test('resolveEpicTitles: empty, ok, capped, non-ok', async () => {
    quiet();
    assert.deepEqual(await resolveEpicTitles([], {}), {});

    let url;
    global.fetch = async u => { url = u; return resp({ issues: [{ key: 'E-1', fields: { summary: 'One' } }, { key: 'E-2' }] }); };
    assert.deepEqual(await resolveEpicTitles(['E-1', 'E-2'], {}), { 'E-1': 'One', 'E-2': null });
    assert.match(url, /maxResults=2/);

    const many = Array.from({ length: 150 }, (_, i) => `E-${i}`);
    global.fetch = async u => { url = u; return resp({}); };
    assert.deepEqual(await resolveEpicTitles(many, {}), {});
    assert.match(url, /maxResults=100/);

    global.fetch = async () => resp({}, 403);
    assert.deepEqual(await resolveEpicTitles(['E-1'], {}), {});
    assert.match(warns[0], /403/);
});

test('fillMissingEpicTitles', async () => {
    quiet();
    let calls = 0;
    global.fetch = async () => { calls++; return resp({ issues: [{ key: 'E-1', fields: { summary: 'One' } }] }); };
    const issues = [
        { epicKey: 'E-1', epicTitle: null },
        { epicKey: 'E-1', epicTitle: null },
        { epicKey: 'E-2', epicTitle: null },
        { epicKey: 'E-3', epicTitle: 'Has' },
        { epicKey: null },
    ];
    await fillMissingEpicTitles(issues, {});
    assert.equal(issues[0].epicTitle, 'One');
    assert.equal(issues[1].epicTitle, 'One');
    assert.equal(issues[2].epicTitle, null);
    assert.equal(issues[3].epicTitle, 'Has');
    assert.equal(calls, 1);

    await fillMissingEpicTitles([{ epicKey: 'E-3', epicTitle: 'x' }], {});
    assert.equal(calls, 1);
});

const SPRINT = 'cf_sprint';
const TEAM = 'cf_team';
const EPIC = 'cf_epic';
const FLAG = 'cf_flag';

function issue(key, fields = {}) {
    return {
        key,
        fields: {
            summary: `T ${key}`,
            issuetype: { name: 'Story' },
            project: { name: 'P' },
            labels: ['PI-27.3'],
            ...fields,
        },
    };
}

async function mapAll(issues, ctx = {}) {
    quiet();
    global.fetch = async () => resp({ issues, isLast: true });
    return fetchAndMapIssuesForJql('project = X', {}, ctx);
}

test('fetchAndMapIssuesForJql: pagination, warnings, field list', async () => {
    quiet();
    const urls = [];
    const pages = [
        { issues: [issue('A-1')], nextPageToken: 'tok 1', warningMessages: ['careful'] },
        { issues: undefined, isLast: true },
    ];
    global.fetch = async u => { urls.push(u); return resp(pages.shift()); };
    const out = await fetchAndMapIssuesForJql('project = X', {}, {
        sprintFieldId: SPRINT, epicLinkFieldId: EPIC, flaggedFieldId: FLAG, teamFieldId: TEAM,
    });
    assert.equal(out.issues.length, 1);
    assert.equal(urls.length, 2);
    assert.match(urls[0], new RegExp(`${SPRINT},${EPIC},${FLAG},${TEAM}`));
    assert.match(urls[1], /nextPageToken=tok%201/);
    assert.ok(warns.some(w => /careful/.test(w)));
});

test('fetchAndMapIssuesForJql: stops without nextPageToken even if isLast missing; http error throws', async () => {
    quiet();
    global.fetch = async () => resp({ issues: [] });
    const out = await fetchAndMapIssuesForJql('j', {}, {});
    assert.deepEqual(out.issues, []);

    global.fetch = async () => resp({}, 400);
    await assert.rejects(() => fetchAndMapIssuesForJql('j', {}, {}), /page 1: 400 ERR/);
});

test('mapRawIssue: malformed issues skipped', async () => {
    const out = await mapAll([{ key: 'X-1' }, { key: 'X-2', fields: {} }]);
    assert.deepEqual(out.issues, []);
});

test('mapRawIssue: blockers, flagged, subtasks, legacy epic link, priority, dates', async () => {
    const out = await mapAll([
        issue('A-1', {
            issuelinks: [
                { type: { inward: 'is blocked by' }, inwardIssue: { key: 'B-1', fields: { summary: 'Blocker', status: { statusCategory: { key: 'done' } } } } },
                { type: { inward: 'is blocked by' }, inwardIssue: { key: 'B-2', fields: { summary: 'Open', status: { statusCategory: { key: 'new' } } } } },
                { type: { inward: 'relates' }, inwardIssue: { key: 'B-3', fields: {} } },
                { type: { inward: 'is blocked by' } },
            ],
            [FLAG]: [{ value: 'Impediment' }],
            subtasks: [{ fields: { status: { statusCategory: { key: 'done' } } } }, { fields: {} }],
            [EPIC]: 'E-9',
            priority: { name: 'Major' },
            created: 'c',
            resolutiondate: 'r',
            status: { name: 'Done', statusCategory: { key: 'done' } },
        }),
        issue('A-2', { parent: { key: 'E-1', fields: { summary: 'Epic title' } } }),
        issue('A-3', { parent: { key: 'E-2' } }),
        issue('E-1', { issuetype: { name: 'Epik' }, [EPIC]: 'ignored', parent: { key: 'Z' } }),
        issue('A-4', { issuetype: { name: 'Zadanie' }, [FLAG]: [] }),
    ], { epicLinkFieldId: EPIC, flaggedFieldId: FLAG });
    const by = Object.fromEntries(out.issues.map(i => [i.key, i]));

    assert.equal(by['A-1'].dependencyBlocked, true);
    assert.equal(by['A-1'].dependencyNote, 'Blocked by B-2: Open');
    assert.equal(by['A-1'].impediment, true);
    assert.deepEqual(by['A-1'].subtasks, { done: 1, total: 2 });
    assert.equal(by['A-1'].epicKey, 'E-9');
    assert.equal(by['A-1'].epicTitle, null);
    assert.equal(by['A-1'].priority, 'Major');
    assert.equal(by['A-1'].created, 'c');
    assert.equal(by['A-1'].resolvedAt, 'r');
    assert.equal(by['A-1'].status, 'Done');
    assert.equal(by['A-1'].statusCategory, 'done');
    assert.equal(by['A-2'].epicTitle, 'Epic title');
    assert.equal(by['A-3'].epicTitle, null);
    assert.equal(by['A-3'].epicKey, 'E-2');
    assert.equal(by['E-1'].type, 'Epic');
    assert.equal(by['E-1'].epicKey, null);
    assert.equal(by['A-4'].type, 'Task');
    assert.equal(by['A-4'].impediment, false);
    assert.equal(by['A-4'].subtasks, null);
    assert.equal(by['A-4'].dependencyBlocked, false);
    assert.equal(by['A-4'].status, null);
    assert.ok(!('dependencyNote' in by['A-4']));
});

test('mapRawIssue: no project, legacy string sprint, sprint dates recorded once', async () => {
    const out = await mapAll([
        issue('A-1', { project: undefined, labels: [], [SPRINT]: ['com.x.Sprint@1[id=5,state=ACTIVE,name=Sparks 27.3.1,startDate=2026-01-01,endDate=<null>]'] }),
        issue('A-2', { labels: [], [SPRINT]: [{ id: 6, name: 'Sparks 27.3.1', state: 'active', startDate: 'other' }] }),
    ], { sprintFieldId: SPRINT });
    assert.equal(out.issues[0].projectName, null);
    assert.equal(out.issues[0].pi, 'PI-27.3');
    assert.deepEqual(out.sprintDates, { 'Sparks 27.3.1': { startDate: '2026-01-01', endDate: null } });
});

test('Team evidence: multi-value positive, label positive, no team field in instance', async () => {
    const ctx = {
        sprintFieldId: SPRINT,
        teamFieldId: TEAM,
        boardNamesByProjectName: { P: [] },
        teamNamesByProjectName: { P: ['Sparks'] },
    };
    const out = await mapAll([
        issue('A-1', { [TEAM]: [{ name: 'Other' }, { name: 'sparks' }] }),
        issue('A-2', { [TEAM]: [{ name: 'Other' }] }),
        issue('A-3', { labels: ['PI-27.3', 'SPARKS'] }),
        issue('A-4', {}),
    ], ctx);
    assert.deepEqual(out.issues.map(i => i.key), ['A-1', 'A-3']);
    assert.ok(warns[0].includes('A-2 (Other)'));
    assert.ok(warns[0].includes('A-4 (no Team value)'));

    const noTeamField = await mapAll([issue('B-1', { [TEAM]: 'Zzz' })], { ...ctx, teamFieldId: null, boardNamesByProjectName: {} });
    assert.deepEqual(noTeamField.issues, []);
});

test('Team mismatch on boarded space with no team value passes (lenient fallback)', async () => {
    const out = await mapAll([issue('A-1', {})], {
        boardNamesByProjectName: { P: ['Sparks'] },
        teamNamesByProjectName: { P: ['Sparks'] },
    });
    assert.deepEqual(out.issues.map(i => i.key), ['A-1']);
});

test('label-only drop, epic rescue, sprint-id match and no-PI warning', async () => {
    const ctx = {
        sprintFieldId: SPRINT,
        boardNamesByProjectName: { P: ['Sparks'] },
        teamNamesByProjectName: { P: ['Sparks'] },
        sprintIdsByProjectName: { P: { '27.3': [10, 11] } },
    };
    const out = await mapAll([
        issue('S-1', { labels: [], [SPRINT]: [{ id: 10, name: 'Sparks 27.3.1', state: 'active' }], parent: { key: 'E-1' } }),
        issue('S-2', { labels: [], [SPRINT]: [{ id: 99, name: 'Sparks 27.3.2', state: 'active' }] }),
        issue('S-3', { labels: [], [SPRINT]: [{ name: 'Sparks 27.3.2', state: 'active' }] }),
        issue('S-4', { labels: ['PI-27.3', 'Sparks'] }),
        issue('S-5', { labels: [] }),
        issue('E-1', { issuetype: { name: 'Epic' } }),
        issue('E-2', { issuetype: { name: 'Epic' } }),
    ], ctx);
    assert.deepEqual(out.issues.map(i => i.key).sort(), ['E-1', 'S-1', 'S-4']);
    assert.ok(!out.issues.find(i => i.key === 'E-1').__droppedForLabelOnlyNoEvidence);
    assert.ok(warns.some(w => /dropped — matched the current-PI query only via its PI label.*S-2, S-3.*E-2/.test(w)));
    assert.ok(warns.some(w => /1 issue\(s\) matched by this query had no PI/.test(w)));
});
