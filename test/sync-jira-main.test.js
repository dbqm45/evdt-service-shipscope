// End-to-end tests of scripts/sync-jira.js main(): the script is run as a child process (it executes
// main() on require) with a fetch-fixture preload from test/sync-harness.js, so there is no real network.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./sync-harness');

const h = createHarness('sync-jira');
const SCRIPT = 'scripts/sync-jira.js';
const JIRA = 'https://jira.test';
const ENV = { JIRA_BASE_URL: JIRA, JIRA_EMAIL: 'bot@example.com', JIRA_API_TOKEN: 'secret-token' };
const DIR = 'docs/data/jira-issues';

after(() => h.cleanup());

const FIELDS = [
    { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
    { id: 'customfield_10014', name: 'Epic Link', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
    { id: 'customfield_10003', name: 'Flagged' },
    { id: 'customfield_10001', name: 'Team' },
    { id: 'summary', name: 'Summary' },
];
const SPRINT = 'customfield_10020';
const EPIC_LINK = 'customfield_10014';
const FLAGGED = 'customfield_10003';
const TEAM = 'customfield_10001';

const fieldsRoute = { exact: `${JIRA}/rest/api/3/field`, body: FIELDS };
const projectsRoute = projs => ({ url: '/rest/api/3/project/search?maxResults=100', body: { values: projs, isLast: true } });
const verifyRoute = (keysQuery, keys, extra = {}) => ({ url: `/project/search?${keysQuery}`, body: { values: keys.map(key => ({ key })), isLast: true, ...extra } });
const boardRoute = (name, id) => ({ url: `/rest/agile/1.0/board?name=${name}&`, body: { values: [{ id, name }] } });
const sprintsRoute = (id, sprints) => ({ url: `/rest/agile/1.0/board/${id}/sprint?`, body: { values: sprints, isLast: true } });
const searchRoute = (match, issues, extra = {}) => ({ url: match, body: { issues, isLast: true, ...extra } });

function issue(key, type, project, f = {}) {
    return {
        key,
        fields: {
            summary: `Title ${key}`,
            issuetype: { name: type },
            project: { name: project },
            labels: [],
            status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            ...f,
        },
    };
}

const sprintObj = (id, name, state = 'active', startDate = '2026-09-28T00:00:00Z', endDate = '2026-10-12T00:00:00Z') => ({ id, name, state, startDate, endDate });

function run(ws, { env = {}, routes = [] } = {}) {
    return h.run(SCRIPT, ws, { env: { ...ENV, ...env }, routes });
}

function sparksWorld(ws, { spaces = [{ name: 'eMobility Sparks', boards: ['Sparks'] }] } = {}) {
    h.writeJson(ws, 'docs/jira-spaces.json', { spaces });
}

const sparksSprints = [sprintObj(10, 'Sparks 27.3.1', 'closed'), sprintObj(11, 'Sparks 27.3.2', 'active'), sprintObj(9, 'Sparks 27.2.3', 'closed')];
const sparksBase = () => [
    fieldsRoute,
    projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }]),
    boardRoute('Sparks', 7),
    sprintsRoute(7, sparksSprints),
];

function seedShards(ws, index, shards = {}) {
    h.writeJson(ws, `${DIR}/index.json`, index);
    Object.entries(shards).forEach(([file, value]) => h.writeJson(ws, `${DIR}/${file}`, value));
}

test('current-PI mode: scoped fetch, filters, epic rescue, shard + index + status-index', () => {
    const ws = h.workspace();

    sparksWorld(ws, { spaces: [{ name: 'emobility sparks', boards: ['Sparks'] }] });
    seedShards(ws, { currentPi: 'PI-26.5', pis: [{ pi: 'PI-26.5', file: 'PI-26.5.json', sprints: [] }] }, {
        'PI-26.5.json': [{ key: 'OLD-1', pi: 'PI-26.5', statusCategory: 'done' }],
    });

    const legacySprint = 'com.atlassian.greenhopper.service.sprint.Sprint@abc[id=11,rapidViewId=3,state=ACTIVE,name=Sparks 27.3.2,startDate=<null>,endDate=<null>]';
    const page1 = [
        issue('SPK-1', 'Story', 'eMobility Sparks', {
            [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')],
            parent: { key: 'SPK-100', fields: { summary: 'Big epic' } },
            priority: { name: 'Major' },
            [FLAGGED]: [{ value: 'Impediment' }],
            subtasks: [{ fields: { status: { statusCategory: { key: 'done' } } } }, { fields: { status: { statusCategory: { key: 'new' } } } }],
            issuelinks: [
                { type: { inward: 'is blocked by' }, inwardIssue: { key: 'SPK-50', fields: { summary: 'Dep', status: { statusCategory: { key: 'new' } } } } },
                { type: { inward: 'is blocked by' }, inwardIssue: { key: 'SPK-51', fields: { summary: 'Done dep', status: { statusCategory: { key: 'done' } } } } },
            ],
            created: '2026-09-01T00:00:00Z',
            resolutiondate: '2026-10-01T00:00:00Z',
        }),
        issue('SPK-2', 'Bug', 'eMobility Sparks', { [SPRINT]: [legacySprint], [EPIC_LINK]: 'SPK-300' }),
    ];
    const page2 = [
        issue('SPK-3', 'Task', 'eMobility Sparks', { labels: ['PI-27.3'] }),
        issue('SPK-100', 'Epic', 'eMobility Sparks', { labels: ['PI-27.3'] }),
        issue('SPK-4', 'Story', 'eMobility Sparks', { labels: ['PI-27.2'], [TEAM]: { name: 'Sparks' } }),
        issue('SPK-5', 'Bug', 'eMobility Sparks', { [TEAM]: { name: 'Rocket' } }),
        issue('SPK-6', 'Task', 'eMobility Sparks', { [TEAM]: [{ title: 'Sparks' }] }),
        issue('SPK-7', 'Sub-task', 'eMobility Sparks'),
        { key: 'SPK-8', fields: null },
    ];
    const routes1 = [
            { url: 'nextPageToken=tok2', body: { issues: page2, isLast: true, warningMessages: ['careful'] } },
            searchRoute('sprint in (10,11)', page1, { isLast: false, nextPageToken: 'tok2' }),
            searchRoute('key in (SPK-300)', [{ key: 'SPK-300', fields: { summary: 'Legacy epic' } }]),
            ...sparksBase(),
    ];
    const res = run(ws, { routes: routes1 });

    assert.equal(res.status, 0, res.out);
    assert.match(res.calls[0].headers.Authorization, /^Basic /);
    assert.equal(res.calls[0].headers['Accept-Language'], 'en-US');
    assert.match(res.out, /Jira returned warnings on page 2/);
    assert.match(res.out, /SPK-5 \(Rocket\)/);
    assert.match(res.out, /matched the current-PI query only via its PI label.*SPK-3/s);
    assert.match(res.out, /Dropped 1 issue\(s\) matched by the current-PI query/);
    assert.match(res.out, /1 issue\(s\) matched by this query had no PI-shaped/);

    const shard = h.readJson(ws, `${DIR}/PI-27.3.json`);

    assert.deepEqual(shard.map(i => i.key), ['SPK-1', 'SPK-2', 'SPK-100']);

    const spk1 = shard[0];

    assert.equal(spk1.impediment, true);
    assert.deepEqual(spk1.subtasks, { done: 1, total: 2 });
    assert.equal(spk1.dependencyBlocked, true);
    assert.equal(spk1.dependencyNote, 'Blocked by SPK-50: Dep');
    assert.equal(spk1.epicKey, 'SPK-100');
    assert.equal(spk1.epicTitle, 'Big epic');
    assert.equal(spk1.priority, 'Major');
    assert.equal(shard[1].epicTitle, 'Legacy epic');

    const index = h.readJson(ws, `${DIR}/index.json`);

    assert.equal(index.currentPi, 'PI-27.3');
    assert.deepEqual(index.pis.map(p => p.pi), ['PI-27.3', 'PI-26.5']);
    assert.deepEqual(index.pis[0].sprints, [{ name: 'Sparks 27.3.2', startDate: '2026-09-28T00:00:00Z', endDate: '2026-10-12T00:00:00Z' }]);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-26.5.json`), [{ key: 'OLD-1', pi: 'PI-26.5', statusCategory: 'done' }]);

    const status = h.readJson(ws, `${DIR}/status-index.json`);

    assert.deepEqual(status['SPK-1'], { pi: 'PI-27.3', statusCategory: 'indeterminate' });
    assert.deepEqual(status['OLD-1'], { pi: 'PI-26.5', statusCategory: 'done' });

    // Re-running against the same workspace is idempotent.
    const before = JSON.stringify([shard, index, status]);
    const res2 = run(ws, { routes: routes1 });

    assert.equal(res2.status, 0, res2.out);
    assert.equal(JSON.stringify([
        h.readJson(ws, `${DIR}/PI-27.3.json`), h.readJson(ws, `${DIR}/index.json`), h.readJson(ws, `${DIR}/status-index.json`),
    ]), before);
});

test('current-PI mode: boardless+teams supplement merges fail-closed results and survives a failing space', () => {
    const ws = h.workspace();

    sparksWorld(ws, {
        spaces: [
            { name: 'eMobility Sparks', boards: ['Sparks'] },
            { name: 'EV Product', teams: ['Sparks'] },
            { name: 'Other Team', teams: ['Nobody'] },
        ],
    });

    const res = run(ws, {
        routes: [
            searchRoute('project = EVP AND labels = "PI-27.3"', [
                issue('EVP-1', 'Story', 'EV Product', { labels: ['PI-27.3'], [TEAM]: { name: 'Sparks' } }),
                issue('EVP-2', 'Story', 'EV Product', { labels: ['PI-27.3'] }),
                issue('EVP-3', 'Story', 'EV Product', { labels: ['PI-27.3', 'sparks'] }),
                issue('SPK-1', 'Story', 'EV Product', { labels: ['PI-27.3'], [TEAM]: { name: 'Sparks' } }),
            ]),
            { url: 'project = OTH AND labels', status: 500, text: 'boom' },
            searchRoute('sprint in (10,11)', [issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')] })]),
            fieldsRoute,
            projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }, { key: 'EVP', name: 'EV Product' }, { key: 'OTH', name: 'Other Team' }]),
            boardRoute('Sparks', 7),
            sprintsRoute(7, sparksSprints),
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /EVP-2 \(no Team value\)/);
    assert.match(res.out, /supplement for space "Other Team" failed/);
    // The first (empty-array) OTH route wins, so no failure there; make sure ordering assumption holds.
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.3.json`).map(i => i.key), ['SPK-1', 'EVP-1', 'EVP-3']);
});

test('current-PI mode: boardless supplement failure is non-fatal', () => {
    const ws = h.workspace();

    sparksWorld(ws, { spaces: [{ name: 'eMobility Sparks', boards: ['Sparks'] }, { name: 'Other Team', teams: ['Nobody'] }] });

    const res = run(ws, {
        routes: [
            { url: 'project = OTH AND labels', status: 500, text: 'boom' },
            searchRoute('sprint in (10,11)', [issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')] })]),
            fieldsRoute,
            projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }, { key: 'OTH', name: 'Other Team' }]),
            boardRoute('Sparks', 7),
            sprintsRoute(7, sparksSprints),
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /supplement for space "Other Team" failed/);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.3.json`).map(i => i.key), ['SPK-1']);
});

test('current-PI mode: empty result leaves existing index and shards untouched', () => {
    const ws = h.workspace();

    sparksWorld(ws);
    seedShards(ws, { currentPi: 'PI-26.5', pis: [{ pi: 'PI-26.5', file: 'PI-26.5.json', sprints: [] }] }, { 'PI-26.5.json': [] });

    const res = run(ws, { routes: [searchRoute('sprint in (10,11)', []), ...sparksBase()] });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /returned no usable issues/);
    assert.equal(h.readJson(ws, `${DIR}/index.json`).currentPi, 'PI-26.5');
    assert.equal(h.exists(ws, `${DIR}/PI-27.3.json`), false);
});

test('current-PI mode: a pruned PI is not rewritten; a failing search fails the run', () => {
    const ws = h.workspace();

    sparksWorld(ws);
    seedShards(ws, { currentPi: 'PI-26.5', pis: [] });
    h.writeJson(ws, `${DIR}/pruned-pis.json`, ['PI-27.3']);

    const ok = run(ws, {
        routes: [searchRoute('sprint in (10,11)', [issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')] })]), ...sparksBase()],
    });

    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /Skipped \(re\)writing 1 PI shard/);
    assert.equal(h.exists(ws, `${DIR}/PI-27.3.json`), false);

    const ws2 = h.workspace();

    sparksWorld(ws2);

    const bad = run(ws2, { routes: [{ url: 'sprint in (10,11)', status: 500, text: 'down' }, ...sparksBase()] });

    assert.equal(bad.status, 1);
    assert.match(bad.out, /Jira API error on page 1: 500/);
});

test('board lookup soft-degrade variants, pagination, and 429 retry', () => {
    const ws = h.workspace();
    const boards = ['Gone', 'Twin', 'Denied', 'Down', 'Garbled', 'SprintDenied', 'SprintDown', 'Sparks'];

    sparksWorld(ws, { spaces: [{ name: 'eMobility Sparks', boards }] });

    const res = run(ws, {
        routes: [
            fieldsRoute,
            projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }]),
            { url: 'board?name=Gone&', body: { values: [{ id: 1, name: 'Other' }] } },
            { url: 'board?name=Twin&', body: { values: [{ id: 2, name: 'Twin' }, { id: 3, name: 'TWIN' }] } },
            { url: 'board?name=Denied&', status: 401, text: 'no' },
            { url: 'board?name=Down&', throw: 'socket hang up' },
            { url: 'board?name=Garbled&', text: 'oops' },
            { url: 'board?name=SprintDenied&', body: { values: [{ id: 31, name: 'SprintDenied' }] } },
            { url: 'board/31/sprint', status: 401, text: 'no' },
            { url: 'board?name=SprintDown&', body: { values: [{ id: 32, name: 'SprintDown' }] } },
            { url: 'board/32/sprint', throw: 'reset' },
            {
                url: 'board?name=Sparks&',
                seq: [{ status: 429, headers: { 'retry-after': '2' }, text: 'slow' }, { body: { values: [{ id: 7, name: 'Sparks' }] } }],
            },
            { url: 'board/7/sprint?startAt=50', body: { values: [sprintObj(11, 'Sparks 27.3.2')], isLast: true } },
            { url: 'board/7/sprint?startAt=0', body: { values: [sprintObj(10, 'Sparks 27.3.1', 'closed')], isLast: false } },
            searchRoute('sprint in (10,11)', [issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')] })]),
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /no board named "Gone"/);
    assert.match(res.out, /more than one board named "Twin"/);
    assert.match(res.out, /Agile API access or scope issue/);
    assert.match(res.out, /could not look up board "Down" \(socket hang up\)/);
    assert.match(res.out, /unexpected error resolving board "Garbled"/);
    assert.match(res.out, /could not fetch sprints for board 31 \(401\)/);
    assert.match(res.out, /could not fetch sprints for board 32 \(reset\)/);
    assert.match(res.out, /Rate limited \(429\)/);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.3.json`).map(i => i.key), ['SPK-1']);
});

test('board without an active sprint falls back to future, then closed; odd names and empty boards warn', () => {
    const ws = h.workspace();

    sparksWorld(ws, { spaces: [{ name: 'eMobility Sparks', boards: ['Fut', 'Clo', 'Non', 'Odd', 'Act'] }] });

    const res = run(ws, {
        routes: [
            fieldsRoute,
            projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }]),
            boardRoute('Fut', 50), boardRoute('Clo', 60), boardRoute('Non', 61), boardRoute('Odd', 70), boardRoute('Act', 80),
            sprintsRoute(50, [
                { id: 51, name: 'Fut 27.5.2', state: 'future', startDate: '2026-12-01T00:00:00Z' },
                { id: 50, name: 'Fut 27.5.1', state: 'future', startDate: '2026-11-01T00:00:00Z' },
            ]),
            sprintsRoute(60, [
                { id: 62, name: 'Clo 27.1.1', state: 'closed', endDate: '2026-01-01T00:00:00Z' },
                { id: 63, name: 'Clo 27.1.2', state: 'closed', endDate: '2026-02-01T00:00:00Z' },
            ]),
            sprintsRoute(61, []),
            sprintsRoute(70, [{ id: 71, name: 'Sprint 4', state: 'active' }]),
            sprintsRoute(80, [sprintObj(81, 'Act 27.3.1')]),
            searchRoute('sprint in (51,50)', [issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(50, 'Fut 27.5.1', 'future')] })]),
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /nearest future sprint "Fut 27.5.1"/);
    assert.match(res.out, /most recently closed sprint "Clo 27.1.2"/);
    assert.match(res.out, /no active, future, or closed sprint/);
    assert.match(res.out, /"Sprint 4" on board "Odd" doesn't match/);
    assert.ok(res.calls.some(c => decodeURIComponent(c.url).includes('labels = "PI-27.1"')));
    assert.equal(h.readJson(ws, `${DIR}/index.json`).currentPi, 'PI-27.5');
});

test('strict board lookup fails the run on any failed Agile call', () => {
    const cases = [
        { name: 'board http', routes: [{ url: 'board?name=Sparks&', status: 401, text: 'no' }], re: /Board lookup for "Sparks" failed with HTTP 401/ },
        { name: 'board throw', routes: [{ url: 'board?name=Sparks&', throw: 'boom' }], re: /Board lookup for "Sparks" failed: boom/ },
        { name: 'sprint http', routes: [boardRoute('Sparks', 7), { url: 'board/7/sprint', status: 500, text: 'x' }], re: /Sprint lookup for board 7 failed with HTTP 500/ },
        { name: 'sprint throw', routes: [boardRoute('Sparks', 7), { url: 'board/7/sprint', throw: 'eof' }], re: /Sprint lookup for board 7 failed: eof/ },
    ];

    for (const c of cases) {
        const ws = h.workspace();

        sparksWorld(ws);

        const res = run(ws, {
            env: { JIRA_BOARD_LOOKUP_STRICT: 'true' },
            routes: [projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }]), ...c.routes],
        });

        assert.equal(res.status, 1, c.name);
        assert.match(res.out, c.re, c.name);
    }
});

test('degraded fallback (boards configured, none resolved) uses partial-merge and never deletes', () => {
    const ws = h.workspace();

    sparksWorld(ws);
    h.writeJson(ws, 'docs/data/deployments.json', [{ relatedIssues: ['SPK-1', 'SPK-2'] }]);
    seedShards(ws, {
        currentPi: 'PI-27.3',
        pis: [
            { pi: 'PI-27.3', file: 'PI-27.3.json', sprints: [{ name: 'Sparks 27.3.1', startDate: 'a', endDate: 'b' }] },
            { pi: 'PI-27.2', file: 'PI-27.2.json', sprints: [] },
        ],
    }, { 'PI-27.3.json': [{ key: 'SPK-9', pi: 'PI-27.3' }], 'PI-27.2.json': [{ key: 'SPK-0', pi: 'PI-27.2' }] });
    h.writeJson(ws, `${DIR}/pruned-pis.json`, ['PI-27.2']);

    const res = run(ws, {
        routes: [
            searchRoute('key in (SPK-1, SPK-2)', [
                issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')] }),
                issue('SPK-2', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(5, 'Sparks 27.2.1')] }),
            ]),
            fieldsRoute,
            verifyRoute('keys=SPK&', ['SPK']),
            projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }]),
            { url: 'board?name=Sparks&', status: 401, text: 'no' },
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /degraded fallback and using 'partial-merge'/);
    assert.match(res.out, /Agile API access or scope issue/);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.3.json`).map(i => i.key).sort(), ['SPK-1', 'SPK-9']);

    const index = h.readJson(ws, `${DIR}/index.json`);

    assert.equal(index.currentPi, 'PI-27.3');
    assert.deepEqual(index.pis.map(p => p.pi), ['PI-27.3']);
    assert.deepEqual(index.pis[0].sprints.map(s => s.name), ['Sparks 27.3.1', 'Sparks 27.3.2']);
    assert.equal(h.exists(ws, `${DIR}/PI-27.2.json`), false);
    assert.match(res.out, /Skipped \(re\)writing 1 PI shard/);
});

test('partial-merge tolerates a corrupt existing shard', () => {
    const ws = h.workspace();

    sparksWorld(ws);
    h.writeJson(ws, 'docs/data/deployments.json', [{ relatedIssues: ['SPK-1'] }]);
    seedShards(ws, { currentPi: 'PI-27.3', pis: [{ pi: 'PI-27.3', file: 'PI-27.3.json', sprints: [] }] }, { 'PI-27.3.json': '{not json' });

    const res = run(ws, {
        routes: [
            searchRoute('key = SPK-1', [issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')] })]),
            fieldsRoute,
            verifyRoute('keys=SPK&', ['SPK']),
            projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }]),
            { url: 'board?name=Sparks&', throw: 'dns' },
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /could not parse existing shard/);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.3.json`).map(i => i.key), ['SPK-1']);
});

test('backfill mode: scoped by space, un-prunes, filters other PIs, keeps currentPi', () => {
    const ws = h.workspace();

    sparksWorld(ws, { spaces: ['eMobility Sparks'] });
    seedShards(ws, { currentPi: 'PI-27.3', pis: [] });
    h.writeJson(ws, `${DIR}/pruned-pis.json`, ['PI-27.1', 'PI-20.1']);

    const res = run(ws, {
        env: { BACKFILL_PIS: '27.1, pi-26.5 27.1' },
        routes: [
            searchRoute('(project = SPK AND (labels = "PI-27.1" OR labels = "PI-26.5"))', [
                issue('SPK-1', 'Story', 'eMobility Sparks', { labels: ['PI-27.1'], [SPRINT]: [sprintObj(3, 'Sparks 27.1.2', 'closed')] }),
                issue('SPK-2', 'Story', 'eMobility Sparks', { labels: ['PI-27.9'] }),
            ]),
            fieldsRoute,
            projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }]),
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /Backfilling PI\(s\): PI-27.1, PI-26.5/);
    assert.match(res.out, /Dropped 1 issue\(s\) matched by the backfill query/);
    assert.match(res.out, /No issues found for requested PI\(s\): PI-26.5/);
    assert.match(res.out, /Un-pruned PI-27.1/);
    assert.deepEqual(h.readJson(ws, `${DIR}/pruned-pis.json`), ['PI-20.1']);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.1.json`).map(i => i.key), ['SPK-1']);
    assert.equal(h.readJson(ws, `${DIR}/index.json`).currentPi, 'PI-27.3');
    assert.equal(h.readJson(ws, `${DIR}/status-index.json`)['SPK-1'].pi, 'PI-27.1');
});

test('backfill mode: unscoped warning, and explicit JIRA_PROJECT_KEY scoping', () => {
    const ws = h.workspace();
    const unscoped = run(ws, {
        env: { BACKFILL_PIS: 'PI-27.1' },
        routes: [searchRoute('(labels = "PI-27.1")', []), fieldsRoute],
    });

    assert.equal(unscoped.status, 0, unscoped.out);
    assert.match(unscoped.out, /no project scope configured/);
    assert.match(unscoped.out, /No issues found for requested PI/);
    assert.deepEqual(h.readJson(ws, `${DIR}/index.json`), { currentPi: null, pis: [] });

    const ws2 = h.workspace();
    const scoped = run(ws2, {
        env: { BACKFILL_PIS: 'PI-27.1', JIRA_PROJECT_KEY: 'SPK, RKT' },
        routes: [
            searchRoute('(project = SPK AND (labels = "PI-27.1")) OR (project = RKT AND (labels = "PI-27.1"))', [
                issue('RKT-1', 'Task', 'Rocket', { labels: ['PI-27.1'] }),
            ]),
            fieldsRoute,
        ],
    });

    assert.equal(scoped.status, 0, scoped.out);
    assert.deepEqual(h.readJson(ws2, `${DIR}/PI-27.1.json`).map(i => i.key), ['RKT-1']);
});

test('explicit JIRA_PROJECT_KEY: full scope deletes stale shards but never infrastructure files', () => {
    const ws = h.workspace();

    sparksWorld(ws);
    seedShards(ws, { currentPi: 'PI-20.1', pis: [{ pi: 'PI-20.1', file: 'PI-20.1.json', sprints: [] }] }, { 'PI-20.1.json': [{ key: 'X-1' }] });
    h.writeJson(ws, `${DIR}/pruned-pis.json`, ['PI-1.1']);
    h.writeJson(ws, 'docs/data/jira-issues.json', []);

    const res = run(ws, {
        env: { JIRA_PROJECT_KEY: 'SPK' },
        routes: [
            searchRoute('project = SPK ORDER BY updated DESC', [
                issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')] }),
                issue('SPK-8', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(12, 'Sparks 26.1.1', 'closed')] }),
            ]),
            fieldsRoute,
            verifyRoute('keys=SPK&', ['SPK']),
            ...sparksBase().slice(1),
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /Using project key\(s\): SPK/);
    assert.equal(h.exists(ws, `${DIR}/PI-20.1.json`), false);
    assert.equal(h.exists(ws, 'docs/data/jira-issues.json'), false);
    assert.deepEqual(h.readJson(ws, `${DIR}/pruned-pis.json`), ['PI-1.1']);
    assert.deepEqual(h.readJson(ws, `${DIR}/index.json`).pis.map(p => p.pi), ['PI-27.3', 'PI-26.1']);
    assert.equal(h.readJson(ws, `${DIR}/index.json`).currentPi, 'PI-27.3');
});

test('explicit JIRA_PROJECT_KEY: unscoped-space warning and allowlist intersection', () => {
    const ws = h.workspace();

    sparksWorld(ws, { spaces: ['eMobility Sparks'] });

    const res = run(ws, {
        env: { JIRA_PROJECT_KEY: 'SPK,RKT' },
        routes: [
            searchRoute('project = SPK ORDER BY updated DESC', [issue('SPK-1', 'Story', 'eMobility Sparks', { labels: ['PI-27.3'] })]),
            fieldsRoute,
            verifyRoute('keys=SPK&keys=RKT', ['SPK', 'RKT']),
            projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }]),
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /has no matching space with "boards"\/"teams"/);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.3.json`).map(i => i.key), ['SPK-1']);
});

test('explicit JIRA_PROJECT_KEY that resolves to nothing falls back to filtered deployment stubs', () => {
    const ws = h.workspace();

    sparksWorld(ws, { spaces: ['eMobility Sparks'] });
    h.writeJson(ws, 'docs/data/deployments.json', [
        { relatedIssues: ['SPK-1', 'ZZZ-2'], issueCommitTypes: { 'SPK-1': 'fix' } },
        { relatedIssues: ['SPK-1', 'SPK-3'], issueCommitTypes: { 'SPK-1': 'feat' } },
        {},
    ]);

    const res = run(ws, {
        env: { JIRA_PROJECT_KEY: 'ZZZ' },
        routes: [verifyRoute('keys=ZZZ&', []), projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }])],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /Could not determine any usable Jira issue.*allowed by/s);
    assert.match(res.out, /Derived 2 fallback issue stub/);

    const stubs = h.readJson(ws, `${DIR}/_.json`);

    assert.deepEqual(stubs.map(s => [s.key, s.type]), [['SPK-1', 'feat'], ['SPK-3', 'other']]);
});

test('explicit project plus another boarded space: current-PI supplement is merged, failures are best-effort', () => {
    const ws = h.workspace();

    sparksWorld(ws, { spaces: [{ name: 'eMobility Sparks', boards: ['Sparks'] }, { name: 'Rocket', boards: ['Rocket'] }] });

    const routes = [
        searchRoute('project = SPK ORDER BY updated DESC', [issue('SPK-1', 'Story', 'eMobility Sparks', { [SPRINT]: [sprintObj(11, 'Sparks 27.3.2')] })]),
        searchRoute('(project = RKT AND (sprint in (21)', [
            issue('RKT-1', 'Story', 'Rocket', { [SPRINT]: [sprintObj(21, 'Rocket 27.3.1')] }),
            issue('SPK-1', 'Story', 'Rocket', { [SPRINT]: [sprintObj(21, 'Rocket 27.3.1')] }),
        ]),
        fieldsRoute,
        verifyRoute('keys=SPK&', ['SPK']),
        projectsRoute([{ key: 'SPK', name: 'eMobility Sparks' }, { key: 'RKT', name: 'Rocket' }]),
        boardRoute('Sparks', 7), sprintsRoute(7, sparksSprints),
        boardRoute('Rocket', 8), sprintsRoute(8, [sprintObj(21, 'Rocket 27.3.1')]),
    ];
    const ok = run(ws, { env: { JIRA_PROJECT_KEY: 'SPK' }, routes });

    assert.equal(ok.status, 0, ok.out);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.3.json`).map(i => i.key), ['SPK-1', 'RKT-1']);

    const ws2 = h.workspace();

    sparksWorld(ws2, { spaces: [{ name: 'eMobility Sparks', boards: ['Sparks'] }, { name: 'Rocket', boards: ['Rocket'] }] });

    const bad = run(ws2, {
        env: { JIRA_PROJECT_KEY: 'SPK' },
        routes: [
            { url: 'project = SPK ORDER BY', status: 400, text: 'bad jql' },
            { url: '(project = RKT AND', status: 500, text: 'down' },
            ...routes.slice(2),
        ],
    });

    assert.equal(bad.status, 0, bad.out);
    assert.match(bad.out, /Primary Jira fetch failed/);
    assert.match(bad.out, /board-derived current-PI Jira fetch failed/);
    assert.match(bad.out, /Jira returned no usable issues/);
});

test('referenced-key fallback: verifies project keys, scopes JQL, derives currentPi from non-Epic issues', () => {
    const ws = h.workspace();

    h.writeJson(ws, 'docs/data/deployments.json', [{ relatedIssues: ['SPK-1', 'ZZZ-9', 'bad', 'SPK-2'] }]);
    seedShards(ws, { currentPi: 'PI-20.1', pis: [{ pi: 'PI-20.1', file: 'PI-20.1.json', sprints: [] }] }, { 'PI-20.1.json': [] });

    const res = run(ws, {
        routes: [
            searchRoute('key in (SPK-1, SPK-2)', [
                issue('SPK-1', 'Story', 'Any', { labels: ['PI-27.3'], parent: { key: 'SPK-2' } }),
                issue('SPK-2', 'Epik', 'Any', { labels: ['PI-28.1'] }),
                issue('SPK-4', 'Zadanie', 'Any', { labels: ['PI-27.3.1'] }),
            ]),
            { url: 'search/jql?maxResults=1&fields=summary', body: { issues: [{ key: 'SPK-2', fields: { summary: 'Epic two' } }] } },
            fieldsRoute,
            verifyRoute('keys=SPK&keys=ZZZ', ['SPK'], { isLast: false }),
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /Dropping project key\(s\) not found in this Jira instance: ZZZ/);
    assert.match(res.out, /paginated/);
    assert.match(res.out, /Using referenced issue key\(s\): SPK-1, SPK-2/);
    assert.equal(h.exists(ws, `${DIR}/PI-20.1.json`), false);

    const index = h.readJson(ws, `${DIR}/index.json`);

    assert.equal(index.currentPi, 'PI-27.3');
    assert.deepEqual(index.pis.map(p => p.pi), ['PI-28.1', 'PI-27.3']);
    assert.equal(h.readJson(ws, `${DIR}/PI-27.3.json`)[0].epicTitle, 'Epic two');
});

test('referenced-key fallback: project verification failure proceeds unfiltered', () => {
    const ws = h.workspace();

    h.writeJson(ws, 'docs/data/deployments.json', [{ relatedIssues: ['SPK-1'] }]);

    const res = run(ws, {
        routes: [
            searchRoute('key = SPK-1', [issue('SPK-1', 'Bug', 'Any', { labels: ['PI-27.3'] })]),
            fieldsRoute,
            { url: '/project/search?keys=SPK', status: 500, text: 'down' },
        ],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /could not verify project keys against Jira \(500\)/);
    assert.deepEqual(h.readJson(ws, `${DIR}/PI-27.3.json`).map(i => i.key), ['SPK-1']);
});

test('referenced-key fallback: nothing usable refuses to delete 2+ shards, and writes an empty index otherwise', () => {
    const ws = h.workspace();

    seedShards(ws, {
        currentPi: 'PI-27.3',
        pis: [{ pi: 'PI-27.3', file: 'PI-27.3.json', sprints: [] }, { pi: 'PI-27.2', file: 'PI-27.2.json', sprints: [] }],
    }, { 'PI-27.3.json': [{ key: 'A-1' }], 'PI-27.2.json': [{ key: 'A-2' }] });

    const res = run(ws);

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /Could not determine any usable Jira issue/);
    assert.match(res.out, /Refusing to delete 2 existing PI shard/);
    assert.equal(h.exists(ws, `${DIR}/PI-27.2.json`), true);
    assert.equal(h.readJson(ws, `${DIR}/index.json`).currentPi, 'PI-27.3');

    const ws2 = h.workspace();
    const res2 = run(ws2);

    assert.equal(res2.status, 0, res2.out);
    assert.deepEqual(h.readJson(ws2, `${DIR}/index.json`), { currentPi: null, pis: [] });
});

test('referenced-key fallback: zero usable Jira issues degrade to deployment stubs', () => {
    const ws = h.workspace();

    h.writeJson(ws, 'docs/data/deployments.json', [{ relatedIssues: ['SPK-1'], issueCommitTypes: { 'SPK-1': 'chore' } }]);

    const res = run(ws, {
        routes: [searchRoute('key = SPK-1', []), fieldsRoute, verifyRoute('keys=SPK&', ['SPK'])],
    });

    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /falling back to deployment-derived issue stubs/);
    assert.deepEqual(h.readJson(ws, `${DIR}/_.json`).map(s => [s.key, s.type, s.pi]), [['SPK-1', 'chore', '—']]);
});

test('Jira API failures that must fail the run', () => {
    const ws = h.workspace();

    h.writeJson(ws, 'docs/data/deployments.json', [{ relatedIssues: ['SPK-1'] }]);

    const noFields = run(ws, { routes: [{ exact: `${JIRA}/rest/api/3/field`, status: 403, text: 'forbidden' }, verifyRoute('keys=SPK&', ['SPK'])] });

    assert.equal(noFields.status, 1);
    assert.match(noFields.out, /Jira API error fetching fields: 403/);

    const ws2 = h.workspace();

    sparksWorld(ws2);

    const noProjects = run(ws2, { routes: [{ url: '/rest/api/3/project/search?maxResults=100', status: 500, text: 'down' }] });

    assert.equal(noProjects.status, 1);
    assert.match(noProjects.out, /Jira API error fetching projects: 500/);
});

test('jira-spaces.json: schema violations fail, unparsable degrades, warnings for odd entries', () => {
    const bad = [
        [{ name: 'X', teams: 'Sparks' }, /"teams" of type string/],
        [{ name: 'X', boards: 'Sparks' }, /"boards" of type string/],
        [{ boards: ['A'] }, /missing a valid, non-empty string "name"/],
        [42, /must be a string or an object/],
    ];

    for (const [entry, re] of bad) {
        const ws = h.workspace();

        h.writeJson(ws, 'docs/jira-spaces.json', { spaces: [entry] });

        const res = run(ws);

        assert.equal(res.status, 1);
        assert.match(res.out, re);
    }

    const ws = h.workspace();

    h.writeJson(ws, 'docs/jira-spaces.json', '{broken');

    const unparsable = run(ws);

    assert.equal(unparsable.status, 0, unparsable.out);
    assert.match(unparsable.out, /could not parse docs\/jira-spaces.json/);

    const ws2 = h.workspace();

    h.writeJson(ws2, 'docs/jira-spaces.json', { spaces: [null, 'Ghost', 'Twin Space', { name: 'Empty', boards: [] }] });

    const odd = run(ws2, {
        routes: [{
            url: '/rest/api/3/project/search?maxResults=100&startAt=0',
            body: { values: [{ key: 'A1', name: 'Twin Space' }], isLast: false },
        }, {
            url: '/rest/api/3/project/search?maxResults=100&startAt=1',
            body: { values: [{ key: 'A2', name: 'twin space' }, { key: 'A3', name: 'Empty' }], isLast: true },
        }],
    });

    assert.equal(odd.status, 0, odd.out);
    assert.match(odd.out, /lists space "Ghost", but no Jira project/);
    assert.match(odd.out, /more than one visible Jira project shares that name.*resolved to "A1"/s);
    assert.match(odd.out, /::warning::docs\/jira-spaces.json: space "Empty" is configured as an object/);
    assert.match(odd.out, /Restricting sync to space\(s\): Ghost, Twin Space, Empty/);
});
