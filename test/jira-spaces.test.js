const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SPACES = path.join('test', '.tmp-spaces.json');

process.env.SPACES_PATH = SPACES;

const { readSpacesConfig, JiraSpacesConfigError, buildBoardNamesByProjectName, buildTeamNamesByProjectName } = require('../scripts/lib/jira-spaces');

test.after(() => fs.rmSync(SPACES, { force: true }));

function withConfig(config, fn) {
    fs.writeFileSync(SPACES, typeof config === 'string' ? config : JSON.stringify(config));

    const realWarn = console.warn;
    const warnings = [];

    console.warn = msg => warnings.push(String(msg));

    try {
        return fn(warnings);
    } finally {
        console.warn = realWarn;
    }
}

test('board/team name maps combine boards and teams', () => {
    const spaces = [{ name: 'A', boards: ['b'], teams: ['t'] }, { name: 'B' }];

    assert.deepEqual(buildBoardNamesByProjectName(spaces), { A: ['b'], B: [] });
    assert.deepEqual(buildTeamNamesByProjectName(spaces), { A: ['b', 't'], B: [] });
    assert.deepEqual(buildBoardNamesByProjectName(null), {});
});

test('readSpacesConfig accepts plain-string entries without warning', () => {
    withConfig({ spaces: ['eMobility Sparks'] }, warnings => {
        const config = readSpacesConfig();

        assert.ok(config);
        assert.deepEqual(warnings, []);
    });
});

test('readSpacesConfig throws JiraSpacesConfigError for a wrongly-typed teams field', () => {
    withConfig({ spaces: [{ name: 'X', teams: 'Sparks' }] }, () => {
        assert.throws(() => readSpacesConfig(), JiraSpacesConfigError);
    });
});

test('readSpacesConfig warns for an object entry with empty boards and teams', () => {
    withConfig({ spaces: [{ name: 'X', boards: [] }] }, warnings => {
        readSpacesConfig();
        assert.ok(warnings.some(w => w.includes('X')));
    });
});
