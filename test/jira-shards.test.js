const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// JIRA_ISSUES_DIR is read at require time and must be a safe *relative* path.
const DIR = path.join('test', '.tmp-shards');

process.env.JIRA_ISSUES_DIR = DIR;

const shards = require('../scripts/lib/jira-shards');

const issue = (key, pi, sprint = null, statusCategory = 'new') => ({ key, pi, sprint, statusCategory });
const read = name => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

function write(issues, opts, sprintDates = {}) {
    const { issuesByPi, sprintsByPi } = shards.groupIssuesByPi(issues, sprintDates);
    const realLog = console.log;
    const realWarn = console.warn;

    console.log = () => {};
    console.warn = () => {};

    try {
        shards.writePiShards(issuesByPi, sprintsByPi, opts);
    } finally {
        console.log = realLog;
        console.warn = realWarn;
    }
}

test.beforeEach(() => fs.rmSync(DIR, { recursive: true, force: true }));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('groupIssuesByPi groups issues and collects distinct sprints with dates', () => {
    const { issuesByPi, sprintsByPi } = shards.groupIssuesByPi(
        [issue('A-1', 'PI-1.1', 'S1'), issue('A-2', 'PI-1.1', 'S1'), issue('A-3', 'PI-1.2')],
        { S1: { startDate: 'x', endDate: 'y' } }
    );

    assert.equal(issuesByPi.get('PI-1.1').length, 2);
    assert.deepEqual([...sprintsByPi.get('PI-1.1').values()], [{ name: 'S1', startDate: 'x', endDate: 'y' }]);
    assert.equal(sprintsByPi.has('PI-1.2'), false);
});

test('full scope writes shards sorted newest-first and deletes stale ones', () => {
    write([issue('A-1', 'PI-1.1'), issue('A-2', 'PI-1.2')], { scope: 'full', currentPi: 'PI-1.2' });
    write([issue('A-2', 'PI-1.2')], { scope: 'full', currentPi: 'PI-1.2' });

    assert.deepEqual(fs.readdirSync(DIR).sort(), ['PI-1.2.json', 'index.json']);
    assert.deepEqual(read('index.json').pis.map(p => p.pi), ['PI-1.2']);
});

test('full scope refuses to wipe 2+ shards when the run resolved nothing', () => {
    write([issue('A-1', 'PI-1.1'), issue('A-2', 'PI-1.2')], { scope: 'full', currentPi: 'PI-1.2' });
    write([], { scope: 'full', currentPi: null });

    assert.deepEqual(fs.readdirSync(DIR).sort(), ['PI-1.1.json', 'PI-1.2.json', 'index.json']);
    assert.equal(read('index.json').currentPi, 'PI-1.2');
});

test('full scope never deletes pruned-pis.json or status-index.json', () => {
    write([issue('A-1', 'PI-1.1')], { scope: 'full', currentPi: 'PI-1.1' });
    shards.writePrunedPis(['PI-0.9']);
    shards.buildStatusIndex();
    write([issue('A-1', 'PI-1.1')], { scope: 'full', currentPi: 'PI-1.1' });

    assert.ok(fs.existsSync(path.join(DIR, 'pruned-pis.json')));
    assert.ok(fs.existsSync(path.join(DIR, 'status-index.json')));
});

test('partial scope replaces its PI and leaves others alone; undefined currentPi preserves it', () => {
    write([issue('A-1', 'PI-1.1'), issue('A-2', 'PI-1.2')], { scope: 'full', currentPi: 'PI-1.2' });
    write([issue('A-3', 'PI-1.1')], { scope: 'partial' });

    assert.deepEqual(read('PI-1.1.json').map(i => i.key), ['A-3']);
    assert.deepEqual(read('PI-1.2.json').map(i => i.key), ['A-2']);
    assert.equal(read('index.json').currentPi, 'PI-1.2');
});

test('partial-merge upserts issues by key and sprints by name', () => {
    write([issue('A-1', 'PI-1.1', 'S1'), issue('A-2', 'PI-1.1', 'S1')], { scope: 'full', currentPi: 'PI-1.1' });
    write([{ ...issue('A-2', 'PI-1.1', 'S2'), statusCategory: 'done' }], { scope: 'partial-merge' });

    const keys = read('PI-1.1.json');

    assert.deepEqual(keys.map(i => i.key).sort(), ['A-1', 'A-2']);
    assert.equal(keys.find(i => i.key === 'A-2').statusCategory, 'done');
    assert.deepEqual(read('index.json').pis[0].sprints.map(s => s.name).sort(), ['S1', 'S2']);
});

test('a pruned PI is not rewritten, unless explicitly backfilled (which un-prunes it)', () => {
    write([issue('A-1', 'PI-1.1'), issue('A-2', 'PI-1.2')], { scope: 'full', currentPi: 'PI-1.2' });
    fs.unlinkSync(path.join(DIR, 'PI-1.1.json'));
    shards.writePrunedPis(['PI-1.1']);

    write([issue('A-9', 'PI-1.1')], { scope: 'partial' });
    assert.equal(fs.existsSync(path.join(DIR, 'PI-1.1.json')), false);
    assert.deepEqual(read('index.json').pis.map(p => p.pi), ['PI-1.2']);

    write([issue('A-9', 'PI-1.1')], { scope: 'partial', isExplicitBackfill: true });
    assert.deepEqual(read('PI-1.1.json').map(i => i.key), ['A-9']);
    assert.deepEqual(shards.readPrunedPis(), []);
});

test('index.json drops entries whose shard file is missing', () => {
    write([issue('A-1', 'PI-1.1'), issue('A-2', 'PI-1.2')], { scope: 'full', currentPi: 'PI-1.2' });
    fs.unlinkSync(path.join(DIR, 'PI-1.1.json'));
    write([issue('A-2', 'PI-1.2')], { scope: 'partial' });

    assert.deepEqual(read('index.json').pis.map(p => p.pi), ['PI-1.2']);
});

test('buildStatusIndex keeps the first (newest-PI) sighting of a key', () => {
    write([issue('A-1', 'PI-1.1', null, 'indeterminate'), issue('A-1', 'PI-1.2', null, 'done')], { scope: 'full', currentPi: 'PI-1.2' });
    shards.buildStatusIndex();

    assert.deepEqual(read('status-index.json'), { 'A-1': { pi: 'PI-1.2', statusCategory: 'done' } });
});

test('readPrunedPis / readExistingIndex tolerate malformed files', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'pruned-pis.json'), '{nope');
    fs.writeFileSync(path.join(DIR, 'index.json'), '{nope');

    const realWarn = console.warn;

    console.warn = () => {};

    try {
        assert.deepEqual(shards.readPrunedPis(), []);
        assert.deepEqual(shards.readExistingIndex(), { currentPi: null, pis: [] });
    } finally {
        console.warn = realWarn;
    }
});

test('isWithinJiraIssuesDir rejects paths escaping the directory', () => {
    assert.equal(shards.isWithinJiraIssuesDir(path.join(DIR, 'PI-1.1.json')), true);
    assert.equal(shards.isWithinJiraIssuesDir(path.join(DIR, '..', 'x.json')), false);
});
