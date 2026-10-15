const test = require('node:test');
const assert = require('node:assert/strict');
const {
    extractPiFromSprintName,
    extractPiFromLabel,
    pickRelevantSprintInfo,
    matchesBoardPrefix,
    comparePiDesc,
    safeFileSlug,
} = require('../scripts/lib/jira-pi');

test('extractPiFromSprintName pulls PI-X.Y out of a sprint name', () => {
    assert.equal(extractPiFromSprintName('Sparks 27.3.1'), 'PI-27.3');
    assert.equal(extractPiFromSprintName('Sprint 42'), null);
    assert.equal(extractPiFromSprintName(null), null);
});

test('extractPiFromLabel accepts plain and sprint-suffixed forms only', () => {
    assert.equal(extractPiFromLabel('PI-27.3'), 'PI-27.3');
    assert.equal(extractPiFromLabel('PI-27.3.1'), 'PI-27.3');
    assert.equal(extractPiFromLabel('pi27.3'), 'PI-27.3');
    assert.equal(extractPiFromLabel('PI-27'), null);
    assert.equal(extractPiFromLabel('release-PI-27.3'), null);
});

test('matchesBoardPrefix requires a word boundary after the board name', () => {
    assert.equal(matchesBoardPrefix('Sparks 27.3.1', 'Sparks'), true);
    assert.equal(matchesBoardPrefix('sparks 27.3.1', 'Sparks'), true);
    assert.equal(matchesBoardPrefix('Sparks', 'Sparks'), true);
    assert.equal(matchesBoardPrefix('Sparkle 27.3.1', 'Spark'), false);
    assert.equal(matchesBoardPrefix('Rocket 27.3.2', 'Sparks'), false);
});

test('pickRelevantSprintInfo prefers the active sprint, else the last one', () => {
    const sprints = [
        { id: 1, name: 'Sparks 27.2.3', state: 'closed' },
        { id: 2, name: 'Sparks 27.3.1', state: 'active', startDate: 'a', endDate: 'b' },
        { id: 3, name: 'Sparks 27.3.2', state: 'future' },
    ];

    assert.deepEqual(pickRelevantSprintInfo(sprints), {
        id: '2', name: 'Sparks 27.3.1', state: 'active', startDate: 'a', endDate: 'b',
    });
    assert.equal(pickRelevantSprintInfo(sprints.filter(s => s.state !== 'active')).name, 'Sparks 27.3.2');
});

test('pickRelevantSprintInfo scopes to allowed board names', () => {
    const sprints = [
        { name: 'Rocket 27.3.2', state: 'active' },
        { name: 'Sparks 27.3.1', state: 'closed' },
    ];

    assert.equal(pickRelevantSprintInfo(sprints, ['Sparks']).name, 'Sparks 27.3.1');
    assert.equal(pickRelevantSprintInfo(sprints, ['Nope']), null);
    assert.equal(pickRelevantSprintInfo(sprints, []).name, 'Rocket 27.3.2');
});

test('pickRelevantSprintInfo parses the legacy string encoding, mapping <null> to null', () => {
    const legacy = 'com.atlassian.greenhopper.service.sprint.Sprint@1[id=7,state=ACTIVE,name=Sparks 27.3.1,startDate=2026-01-01,endDate=<null>]';
    const info = pickRelevantSprintInfo([legacy]);

    assert.equal(info.id, '7');
    assert.equal(info.name, 'Sparks 27.3.1');
    assert.equal(info.startDate, '2026-01-01');
    assert.equal(info.endDate, null);
    assert.equal(pickRelevantSprintInfo(null), null);
    assert.equal(pickRelevantSprintInfo([]), null);
});

test('comparePiDesc sorts newest first, numerically', () => {
    assert.deepEqual(['PI-9.1', 'PI-27.3', 'PI-27.10', 'PI-27.2'].sort(comparePiDesc), ['PI-27.10', 'PI-27.3', 'PI-27.2', 'PI-9.1']);
    assert.equal(comparePiDesc('PI-1.1', 'PI-1.1'), 0);
});

test('safeFileSlug replaces unsafe characters', () => {
    assert.equal(safeFileSlug('PI-27.3'), 'PI-27.3');
    assert.equal(safeFileSlug('../x y'), '.._x_y');
    assert.equal(safeFileSlug('—'), '_');
});
