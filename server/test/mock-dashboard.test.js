const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mockDataEnabled, loadMockDashboard } = require('../lib/mock-dashboard');

const DOCS = path.join(__dirname, '..', '..', 'docs');

test('mockDataEnabled: only SHIPSCOPE_MOCK_DATA=1, and only on localhost outside production', () => {
    assert.equal(mockDataEnabled({}), false);
    assert.equal(mockDataEnabled({ SHIPSCOPE_MOCK_DATA: 'true', PUBLIC_BASE_URL: 'http://localhost:3000' }), false);
    assert.equal(mockDataEnabled({ SHIPSCOPE_MOCK_DATA: '1', PUBLIC_BASE_URL: 'http://localhost:3000' }), true);
    assert.equal(mockDataEnabled({ SHIPSCOPE_MOCK_DATA: '1', PUBLIC_BASE_URL: 'http://127.0.0.1:3001' }), true);
    for (const env of [
        { SHIPSCOPE_MOCK_DATA: '1', PUBLIC_BASE_URL: 'https://shipscope.example.com' },
        { SHIPSCOPE_MOCK_DATA: '1' },
        { SHIPSCOPE_MOCK_DATA: '1', PUBLIC_BASE_URL: 'http://localhost:3000', NODE_ENV: 'production' },
    ]) {
        assert.throws(() => mockDataEnabled(env), /local development only/);
    }
});

test('loadMockDashboard: the sample dataset in the dashboard-data shape, issues per increment', () => {
    const { data, issuesByPi } = loadMockDashboard(DOCS);
    assert.equal(data.mock, true);
    assert.equal(data.jiraBrowseUrl, null);
    assert.ok(data.deployments.length > 10);
    assert.ok(Object.keys(data.flagsMeta).length > 0);
    assert.equal(data.jiraIndex.currentPi, data.jiraIndex.pis[0].pi);
    for (const { pi } of data.jiraIndex.pis) assert.ok(Array.isArray(issuesByPi[pi]) && issuesByPi[pi].length > 0, pi);
    assert.ok(!('jiraIssuesByPi' in data));
    assert.ok(!Number.isNaN(Date.parse(data.lastSyncedAt)));
});
