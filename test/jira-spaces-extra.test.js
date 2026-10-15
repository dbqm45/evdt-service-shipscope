const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TMP = path.join(__dirname, '.tmp-libs-spaces');
const SPACES = path.join(TMP, 'spaces.json');

fs.mkdirSync(TMP, { recursive: true });
process.env.SPACES_PATH = SPACES;
process.env.RUNNER_TEMP = TMP;
process.env.JIRA_BASE_URL = 'https://jira.example/api';

const {
    JiraSpacesConfigError,
    filterExistingProjectKeys,
    fetchAllProjects,
    readSpacesConfig,
    resolveSpacesConfig,
    buildBoardNamesByProjectName,
    buildTeamNamesByProjectName,
} = require('../scripts/lib/jira-spaces');

const realFetch = global.fetch;
const realLog = console.log;
const realWarn = console.warn;
let warns;

test.beforeEach(() => {
    warns = [];
    console.warn = m => warns.push(String(m));
    console.log = () => {};
    for (const f of fs.readdirSync(TMP)) {
        fs.rmSync(path.join(TMP, f), { force: true });
    }
});
test.afterEach(() => {
    global.fetch = realFetch;
    console.warn = realWarn;
    console.log = realLog;
});
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function resp(body, status = 200) {
    return { ok: status < 300, status, json: async () => body, text: async () => 'ERR' };
}

test('filterExistingProjectKeys: empty input short-circuits', async () => {
    global.fetch = async () => { throw new Error('no'); };
    assert.deepEqual(await filterExistingProjectKeys([], {}), []);
});

test('filterExistingProjectKeys: drops unknown keys, builds repeated keys= params', async () => {
    let url;
    global.fetch = async u => { url = u; return resp({ values: [{ key: 'EBO' }] }); };
    assert.deepEqual(await filterExistingProjectKeys(['EBO', 'ZZ'], {}), ['EBO']);
    assert.match(url, /keys=EBO&keys=ZZ&maxResults=2/);
    assert.match(warns[0], /ZZ/);
});

test('filterExistingProjectKeys: all valid, no values field, paginated warning', async () => {
    global.fetch = async () => resp({ values: [{ key: 'A' }], isLast: false });
    assert.deepEqual(await filterExistingProjectKeys(['A'], {}), ['A']);
    assert.match(warns[0], /paginated/);
    global.fetch = async () => resp({});
    assert.deepEqual(await filterExistingProjectKeys(['A'], {}), []);
});

test('filterExistingProjectKeys: non-ok proceeds unfiltered', async () => {
    global.fetch = async () => resp({}, 500);
    assert.deepEqual(await filterExistingProjectKeys(['A', 'B'], {}), ['A', 'B']);
    assert.match(warns[0], /500/);
});

test('fetchAllProjects paginates and throws on error', async () => {
    const urls = [];
    const pages = [{ values: [{ key: 'A' }, { key: 'B' }], isLast: false }, { values: [{ key: 'C' }] }, { values: [] }];
    global.fetch = async u => { urls.push(u); return resp(pages.shift()); };
    assert.deepEqual((await fetchAllProjects({})).map(p => p.key), ['A', 'B', 'C']);
    assert.match(urls[1], /startAt=2/);

    global.fetch = async () => resp({}, 401);
    await assert.rejects(() => fetchAllProjects({}), /401 ERR/);

    global.fetch = async () => resp({ isLast: true });
    assert.deepEqual(await fetchAllProjects({}), []);
});

function writeSpaces(content) {
    fs.writeFileSync(SPACES, typeof content === 'string' ? content : JSON.stringify(content));
}

test('readSpacesConfig: missing file, bad JSON, non-array spaces', () => {
    assert.deepEqual(readSpacesConfig(), []);
    writeSpaces('{not json');
    assert.deepEqual(readSpacesConfig(), []);
    assert.match(warns[0], /could not parse/);
    writeSpaces({ spaces: 'x' });
    assert.deepEqual(readSpacesConfig(), []);
});

test('readSpacesConfig: strings, objects, falsy filtered', () => {
    writeSpaces({ spaces: ['A', null, '', { name: 'B', boards: ['b', ''], teams: ['t'] }, { name: 'C', boards: ['x'] }, { name: 'D', teams: ['y'] }] });
    assert.deepEqual(readSpacesConfig(), [
        { name: 'A', boards: [], teams: [] },
        { name: 'B', boards: ['b'], teams: ['t'] },
        { name: 'C', boards: ['x'], teams: [] },
        { name: 'D', boards: [], teams: ['y'] },
    ]);
    assert.equal(warns.length, 0);
});

test('readSpacesConfig: schema violations throw JiraSpacesConfigError', () => {
    for (const [entry, re] of [
        [5, /string or an object, got number/],
        [{ boards: [] }, /missing a valid/],
        [{ name: '' }, /missing a valid/],
        [{ name: 3 }, /missing a valid/],
        [{ name: 'X', boards: 'b' }, /"boards" of type string/],
        [{ name: 'X', teams: 'Sparks' }, /"teams" of type string/],
    ]) {
        writeSpaces({ spaces: [entry] });
        assert.throws(() => readSpacesConfig(), e => e instanceof JiraSpacesConfigError && re.test(e.message));
    }
});

test('readSpacesConfig: object with empty boards/teams warns', () => {
    writeSpaces({ spaces: [{ name: 'X', boards: [] }, { name: 'Y', teams: [''] }, { name: 'Z' }] });
    const out = readSpacesConfig();
    assert.equal(out.length, 3);
    assert.equal(warns.length, 2);
    assert.match(warns[0], /::warning::.*"X"/);
});

test('resolveSpacesConfig: nothing configured', async () => {
    global.fetch = async () => { throw new Error('no'); };
    assert.deepEqual(await resolveSpacesConfig([], {}), { allowedProjectKeys: null, resolvedSpaces: [] });
});

test('resolveSpacesConfig: resolves case-insensitively with canonical name, warns on unknown and ambiguous', async () => {
    global.fetch = async () => resp({
        values: [
            { key: 'SP', name: 'eMobility Sparks' },
            { key: 'D1', name: 'Dup' },
            { key: 'D2', name: 'dup' },
        ],
        isLast: true,
    });
    const out = await resolveSpacesConfig([
        { name: 'EMOBILITY SPARKS', boards: ['b'], teams: ['t'] },
        { name: 'Nope', boards: [], teams: [] },
        { name: 'Dup', boards: [], teams: [] },
    ], {});
    assert.deepEqual([...out.allowedProjectKeys].sort(), ['D1', 'SP']);
    assert.deepEqual(out.resolvedSpaces, [
        { name: 'eMobility Sparks', projectKey: 'SP', boards: ['b'], teams: ['t'] },
        { name: 'Dup', projectKey: 'D1', boards: [], teams: [] },
    ]);
    assert.ok(warns.some(w => /"Nope"/.test(w)));
    assert.ok(warns.some(w => /more than one visible Jira project/.test(w)));
});

test('resolveSpacesConfig: none resolved logs "none"; projects cached across calls; failure throws', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return resp({ values: [], isLast: true }); };
    const out = await resolveSpacesConfig([{ name: 'X', boards: [], teams: [] }], {});
    assert.equal(out.allowedProjectKeys.size, 0);
    assert.deepEqual(out.resolvedSpaces, []);
    await resolveSpacesConfig([{ name: 'X', boards: [], teams: [] }], {});
    assert.equal(calls, 1);

    for (const f of fs.readdirSync(TMP)) {
        fs.rmSync(path.join(TMP, f), { force: true });
    }
    global.fetch = async () => resp({}, 503);
    await assert.rejects(() => resolveSpacesConfig([{ name: 'X', boards: [], teams: [] }], {}), /503/);
});

test('build*NamesByProjectName handle undefined input', () => {
    assert.deepEqual(buildBoardNamesByProjectName(undefined), {});
    assert.deepEqual(buildTeamNamesByProjectName(undefined), {});
    assert.deepEqual(buildBoardNamesByProjectName([{ name: 'A' }]), { A: [] });
    assert.deepEqual(buildTeamNamesByProjectName([{ name: 'A', boards: ['b'] }]), { A: ['b'] });
});
