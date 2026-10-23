const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Local development only (`npm run dev:mock`): the dashboard API answers with the frontend's own sample dataset
 * (buildFallbackData() in docs/app-data.js, what the page shows over file://) instead of the tenant's data, so a
 * change to the dashboard can be checked against every visual state without real GitHub or Jira data. The
 * dataset is built once, by running the dashboard scripts that define it in a sandbox; there is only one copy of
 * the sample data. Sign-in, tenants and settings stay real.
 */

// The scripts buildFallbackData() needs, in docs/index.html order.
const SCRIPTS = ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model'];

// What the scripts' load-time code (e.g. the theme button in app-core.js) touches; nothing is rendered.
const stubElement = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
});

/**
 * Whether mock data is on (SHIPSCOPE_MOCK_DATA=1). Refused unless the server runs on localhost: on a real
 * deployment every tenant would see sample data as its own.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 * @throws {Error} mock data asked for outside localhost
 */
function mockDataEnabled(env) {
    if (env.SHIPSCOPE_MOCK_DATA !== '1') return false;
    let host = '';
    try {
        host = new URL(env.PUBLIC_BASE_URL || '').hostname;
    } catch { /* reported below */ }
    if (!['localhost', '127.0.0.1'].includes(host) || env.NODE_ENV === 'production') {
        throw new Error('Invalid configuration: SHIPSCOPE_MOCK_DATA=1 is for local development only (PUBLIC_BASE_URL must be http://localhost)');
    }
    return true;
}

/**
 * @param {string} dashboardDir the docs/ directory
 * @returns {{ data: object, issuesByPi: Record<string, object[]> }} `data` in the dashboard-data shape (plus
 *   `mock: true`), `issuesByPi` what /api/tenants/:id/jira-issues answers per increment
 */
function loadMockDashboard(dashboardDir) {
    const context = vm.createContext({
        console,
        URLSearchParams,
        location: { search: '', pathname: '/' },
        localStorage: { getItem: () => null, setItem() {} },
        document: { getElementById: stubElement, documentElement: stubElement() },
        fetch: () => Promise.reject(new Error('no network in the mock sandbox')),
    });
    for (const name of SCRIPTS) {
        const file = path.join(dashboardDir, `${name}.js`);
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
    // JSON round trip: plain objects of this realm, Maps turned into entries first.
    const built = vm.runInContext(
        'JSON.stringify((() => { const f = buildFallbackData(); return { ...f, jiraIssuesByPi: [...f.jiraIssuesByPi] }; })())',
        context
    );
    const { jiraIssuesByPi, ...data } = JSON.parse(built);
    return {
        data: { ...data, lastSyncedAt: new Date().toISOString(), jiraBrowseUrl: null, mock: true },
        issuesByPi: Object.fromEntries(jiraIssuesByPi),
    };
}

module.exports = { mockDataEnabled, loadMockDashboard };
