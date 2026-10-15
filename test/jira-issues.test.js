const test = require('node:test');
const assert = require('node:assert/strict');
const {
    pickBestType,
    buildFallbackIssuesFromDeployments,
    extractTeamName,
    extractTeamNames,
    fetchAndMapIssuesForJql,
} = require('../scripts/lib/jira-issues');

test('pickBestType follows feat > fix > chore', () => {
    assert.equal(pickBestType(['chore', 'fix']), 'fix');
    assert.equal(pickBestType(['chore', 'feat']), 'feat');
    assert.equal(pickBestType(['docs']), 'docs');
    assert.equal(pickBestType([]), 'other');
});

test('extractTeamName(s) normalize the Team field shapes', () => {
    assert.equal(extractTeamName(' Sparks '), 'Sparks');
    assert.equal(extractTeamName({ name: 'Sparks' }), 'Sparks');
    assert.equal(extractTeamName({ title: 'T' }), 'T');
    assert.equal(extractTeamName(null), null);
    assert.equal(extractTeamName([]), null);
    assert.deepEqual(extractTeamNames([{ name: 'A' }, 'B', null, '']), ['A', 'B']);
    assert.deepEqual(extractTeamNames('A'), ['A']);
    assert.deepEqual(extractTeamNames(undefined), []);
});

test('buildFallbackIssuesFromDeployments honours the project allowlist', () => {
    const issues = buildFallbackIssuesFromDeployments(
        [{ relatedIssues: ['EBO-2', 'FOO-1'], issueCommitTypes: { 'EBO-2': 'fix' } }],
        new Set(['EBO'])
    );

    assert.deepEqual(issues.map(i => [i.key, i.type, i.pi]), [['EBO-2', 'fix', '—']]);
});

// --- fetchAndMapIssuesForJql, with global fetch mocked ---------------------------------------------------

const SPRINT = 'customfield_sprint';
const TEAM = 'customfield_team';

function rawIssue({ key, type = 'Story', project = 'eMobility Sparks', sprint, labels = [], team, parent }) {
    return {
        key,
        fields: {
            summary: `Title ${key}`,
            issuetype: { name: type },
            project: { name: project },
            labels,
            status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            [SPRINT]: sprint,
            [TEAM]: team,
            parent,
        },
    };
}

async function run(issues, ctx) {
    const realFetch = global.fetch;
    const realLog = console.log;
    const realWarn = console.warn;

    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ issues, isLast: true }) });
    console.log = () => {};
    console.warn = () => {};

    try {
        return await fetchAndMapIssuesForJql('project = X', {}, {
            sprintFieldId: SPRINT,
            teamFieldId: TEAM,
            boardNamesByProjectName: {},
            teamNamesByProjectName: {},
            ...ctx,
        });
    } finally {
        global.fetch = realFetch;
        console.log = realLog;
        console.warn = realWarn;
    }
}

test('maps an issue and records sprint dates', async () => {
    const { issues, sprintDates } = await run(
        [rawIssue({ key: 'EBO-1', sprint: [{ id: 5, name: 'Sparks 27.3.1', state: 'active', startDate: 's', endDate: 'e' }] })],
        {}
    );

    assert.equal(issues.length, 1);
    assert.equal(issues[0].pi, 'PI-27.3');
    assert.equal(issues[0].sprint, 'Sparks 27.3.1');
    assert.deepEqual(sprintDates, { 'Sparks 27.3.1': { startDate: 's', endDate: 'e' } });
});

test('drops issues with an unknown type or no PI', async () => {
    const { issues } = await run(
        [rawIssue({ key: 'EBO-1', type: 'Sub-task', labels: ['PI-27.3'] }), rawIssue({ key: 'EBO-2' })],
        {}
    );

    assert.deepEqual(issues, []);
});

test('Team-field mismatch drops an issue unless a label or own-board sprint rescues it', async () => {
    const ctx = {
        boardNamesByProjectName: { 'eMobility Sparks': ['Sparks'] },
        teamNamesByProjectName: { 'eMobility Sparks': ['Sparks'] },
    };
    const wrongTeam = { name: 'Rocket' };
    const { issues } = await run([
        rawIssue({ key: 'A-1', labels: ['PI-27.3'], team: wrongTeam }),
        rawIssue({ key: 'A-2', labels: ['PI-27.3', 'Sparks'], team: wrongTeam }),
        rawIssue({ key: 'A-3', team: wrongTeam, sprint: [{ name: 'Sparks 27.3.1', state: 'active' }] }),
    ], ctx);

    assert.deepEqual(issues.map(i => i.key).sort(), ['A-2', 'A-3']);
});

test('boardless space with teams configured fails closed without team evidence', async () => {
    const ctx = { teamNamesByProjectName: { 'eMobility Sparks': ['Sparks'] } };
    const { issues } = await run([
        rawIssue({ key: 'A-1', labels: ['PI-27.3'] }),
        rawIssue({ key: 'A-2', labels: ['PI-27.3'], team: 'Sparks' }),
    ], ctx);

    assert.deepEqual(issues.map(i => i.key), ['A-2']);
});

test('label-only match is dropped, except an Epic with an in-scope child', async () => {
    const ctx = {
        boardNamesByProjectName: { 'eMobility Sparks': ['Sparks'] },
        teamNamesByProjectName: { 'eMobility Sparks': ['Sparks'] },
        sprintIdsByProjectName: { 'eMobility Sparks': { '27.3': [10] } },
    };
    const { issues } = await run([
        rawIssue({ key: 'S-1', sprint: [{ id: 10, name: 'Sparks 27.3.1', state: 'active' }], parent: { key: 'E-1', fields: { summary: 'Epic' } } }),
        rawIssue({ key: 'E-1', type: 'Epic', labels: ['PI-27.3'] }),
        rawIssue({ key: 'E-2', type: 'Epic', labels: ['PI-27.3'] }),
        rawIssue({ key: 'S-2', labels: ['PI-27.3'] }),
    ], ctx);

    assert.deepEqual(issues.map(i => i.key).sort(), ['E-1', 'S-1']);
});

test('paginates and throws on a non-ok response', async () => {
    const realFetch = global.fetch;
    const realLog = console.log;

    console.log = () => {};
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });

    try {
        await assert.rejects(() => fetchAndMapIssuesForJql('x', {}, { boardNamesByProjectName: {}, teamNamesByProjectName: {} }), /Jira API error on page 1: 500/);
    } finally {
        global.fetch = realFetch;
        console.log = realLog;
    }
});
