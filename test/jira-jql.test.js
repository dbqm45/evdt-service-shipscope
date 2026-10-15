const test = require('node:test');
const assert = require('node:assert/strict');
const {
    deriveIssueKeysFromDeployments,
    projectKeyOf,
    buildJql,
    buildJqlForKeys,
    buildCurrentPiJql,
} = require('../scripts/lib/jira-jql');

test('deriveIssueKeysFromDeployments dedupes and drops malformed keys', () => {
    const keys = deriveIssueKeysFromDeployments([
        { relatedIssues: ['EBO-1', 'EBO-2', 'bad key'] },
        { relatedIssues: ['EBO-1', 'X-9'] },
        {},
    ]);

    assert.deepEqual(keys, ['EBO-1', 'EBO-2']);
});

test('projectKeyOf / buildJql / buildJqlForKeys', () => {
    assert.equal(projectKeyOf('EBO-123'), 'EBO');
    assert.equal(buildJql(['EBO']), 'project = EBO ORDER BY updated DESC');
    assert.equal(buildJql(['EBO', 'EVP']), 'project in (EBO, EVP) ORDER BY updated DESC');
    assert.equal(buildJqlForKeys(['EBO-1']), 'key = EBO-1 ORDER BY updated DESC');
    assert.equal(buildJqlForKeys(['EBO-1', 'EBO-2']), 'key in (EBO-1, EBO-2) ORDER BY updated DESC');
});

test('buildCurrentPiJql combines sprint ids and PI label per project', () => {
    const jql = buildCurrentPiJql([
        { projectKey: 'EBO', piNumbers: new Set(['27.3']), sprintIdsByPi: { '27.3': [1, 2] } },
        { projectKey: 'EVP', piNumbers: new Set(['27.3']) },
    ]);

    assert.equal(
        jql,
        '(project = EBO AND (sprint in (1,2) OR labels = "PI-27.3")) OR (project = EVP AND (labels = "PI-27.3"))'
    );
    assert.equal(buildCurrentPiJql([]), null);
});

test('buildCurrentPiJql never emits the invalid sprint ~ operator', () => {
    const jql = buildCurrentPiJql([{ projectKey: 'EBO', piNumbers: ['27.3'], sprintIdsByPi: {} }]);

    assert.ok(!jql.includes('~'));
});
