// Smoke-renders migrated `html`-template views in Node (vm + stub DOM) with a hostile payload, so a
// forgotten raw()/join or an unescaped field shows up without a browser. No frontend test existed before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model', 'app-product', 'app-technical', 'app-technical-matrix', 'app-technical-timeline', 'app-technical-flags', 'app-release-notes', 'app-insights'];
const EVIL = '<img src=x onerror=alert(1)>';

function stubElement() {
    return new Proxy({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, dataset: {}, addEventListener() {},
        getAttribute() { return null; }, setAttribute() {}, appendChild() {}, getBoundingClientRect: () => ({ height: 70 }),
        querySelector: () => stubElement(), querySelectorAll: () => [] },
    { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
}

function loadApp() {
    const boxes = {};
    const created = [];
    const ctx = {
        console, URLSearchParams, Date, Math, Map, Set, location: { search: '?insights=1' },
        localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }),
        document: { documentElement: stubElement(), body: stubElement(), getElementById: id => boxes[id] || (boxes[id] = stubElement()),
            querySelector: () => stubElement(), querySelectorAll: () => [], addEventListener() {},
            createElement: () => { const el = stubElement(); created.push(el); return el; } },
    };

    vm.createContext(ctx);
    FILES.forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs', `${f}.js`), 'utf8'), ctx, { filename: f }));

    return { ctx, created, html: id => String(boxes[id].innerHTML) };
}

function seed(ctx) {
    vm.runInContext(`
    const mk = (n, extra) => ({ key: 'A-' + n, type: 'Story', title: '${EVIL}', pi: 'PI-27.3', sprint: 'Sparks 27.3.' + n,
        priority: n % 2 ? '${EVIL}' : 'Major', resolvedAt: '2026-01-01', ...extra });
    state = {
        selectedPi: 'PI-27.3',
        jiraIssues: [mk(1), mk(2), mk(3, { type: 'Bug' })],
        deployments: [{ environment: 'prod', status: 'success', component: 'c', relatedIssues: ['A-1', 'A-2', 'A-3'],
            deployedAt: new Date().toISOString(), rollback: { toRef: 'x' } }],
        flagsMeta: { 'k"<x': {}, k2: {} },
        flagStates: { 'k"<x': { prod: { build: { enabled: true, changedAt: '2026-01-01' } } }, k2: { prod: { build: { enabled: true, changedAt: '2026-02-01' } } } },
        issueDeployments: {}, flagStateHistory: [], components: [],
    };`, ctx);
}

test('Insights charts render several rows without stray commas and escape hostile fields', () => {
    const { ctx, html } = loadApp();

    seed(ctx);
    vm.runInContext('renderInsights()', ctx);

    for (const id of ['chartSprint', 'chartPriority', 'chartStaleFlags', 'chartLeadTime', 'chartRollbackDrift']) {
        const out = html(id);

        assert.ok(!out.includes(EVIL), `${id} contains an unescaped payload`);
        assert.ok(!/>\s*,\s*</.test(out), `${id} contains a stray comma between elements`);
    }
    assert.ok(html('chartStaleFlags').split('bar-row-count').length > 2, 'expected two stale-flag rows');
});

test('Release Notes render several rows without stray commas and escape hostile fields', () => {
    const { ctx, html } = loadApp();

    seed(ctx);
    vm.runInContext('renderReleaseNotes()', ctx);

    for (const id of ['releaseNotesBody', 'releaseNotesSummary', 'releaseNotesCount']) {
        const out = html(id);

        assert.ok(!out.includes(EVIL), `${id} contains an unescaped payload`);
        assert.ok(!/>\s*,\s*</.test(out), `${id} contains a stray comma between elements`);
    }
    assert.ok(html('releaseNotesBody').includes('release-note-item'), 'expected released items to be listed');
    assert.ok(html('releaseNotesBody').includes('&lt;img'), 'expected the title to appear escaped');
});

test('Technical view renders summary, matrix, timeline and flags without stray commas and escapes hostile fields', () => {
    const { ctx, html, created } = loadApp();

    seed(ctx);
    vm.runInContext(`
    const run = (id, extra) => ({ id, component: '${EVIL}', environment: 'prod', status: 'success', version: '${EVIL}',
        deployedAt: new Date().toISOString(), deployedBy: '${EVIL}', deployedByLogin: 'l"<', manual: true, durationMs: 65000,
        commitUrl: 'https://x/?a=1&b="2"', workflowRunUrl: 'https://x/run?a=1&b="2"', relatedIssues: ['${EVIL}', 'A-1'],
        resolvedFlags: { '${EVIL}': true }, rollback: { toRef: '${EVIL}' },
        driftBehind: { behindEnv: 'qa', commitCount: 2, untestedIn: 'test', untestedCommitCount: 1 }, ...extra });
    state.deployments = [run(3), run(2), run(1), run(4, { status: 'failure', version: 'v9' })];
    state.flagsMeta = { '${EVIL}': { description: '${EVIL}', source: 'build', jiraKeys: ['${EVIL}', 'A-1'], components: ['${EVIL}'], createdAt: '2026-01-01' }, k2: { source: 'runtime-be' } };
    state.flagStates = { '${EVIL}': { prod: { build: { enabled: true, changedAt: '2026-01-01', changedBy: '${EVIL}' } } }, k2: {} };
    state.issueStatusIndex = {};
    state.componentsOrder = [{ name: '${EVIL}', description: '${EVIL}', featureFlagsIncluded: false }];
    renderSummaryCards(); renderMatrix(); renderTimeline(); renderFlags();`, ctx);

    const outputs = {
        summaryGrid: html('summaryGrid'),
        timeline: html('timeline'),
        flags: html('flags'),
        matrix: created.map(el => String(el.innerHTML)).join('\n'),
        groupOpen: vm.runInContext(`String(renderDeployGroupCard(groupConsecutiveDeploys(state.deployments.map(d => ({ kind: 'deploy', at: d.deployedAt, data: d }))).find(g => g.kind === 'deploy-group'), {}, true))`, ctx),
    };

    for (const [id, out] of Object.entries(outputs)) {
        assert.ok(!out.includes(EVIL), `${id} contains an unescaped payload`);
        assert.ok(!/>\s*,\s*</.test(out), `${id} contains a stray comma between elements`);
        assert.ok(!/\[object Object\]/.test(out), `${id} contains a stringified object`);
    }
    assert.ok(outputs.timeline.includes('deploy-item'), 'expected deploy cards');
    assert.ok(outputs.timeline.includes('&lt;img'), 'expected hostile fields to appear escaped');
    assert.ok(outputs.timeline.includes('a=1&amp;b=&quot;2&quot;'), 'expected URLs to be attribute-escaped');
    assert.ok(outputs.groupOpen.includes('deploy-group-item'), 'expected the expanded group to list its runs');
    assert.ok(outputs.matrix.includes('comp-row') || outputs.matrix.includes('comp-name'), 'expected matrix rows');
    assert.equal(outputs.flags.split('class="ff-row"').length - 1, 2, 'expected one card per flag');
});

test('Product view renders summary, epics and rows (collapsed and expanded) without stray commas and escapes hostile fields', () => {
    const { ctx, html } = loadApp();

    seed(ctx);
    vm.runInContext(`
    const pm = (n, extra) => ({ key: 'P-' + n, type: 'Story', title: '${EVIL}', pi: 'PI-27.3', sprint: '${EVIL}', projectName: '${EVIL}',
        status: '${EVIL}', statusCategory: 'indeterminate', priority: 'Major', epicKey: 'E-1', epicTitle: '${EVIL}',
        subtasks: { done: 1, total: 2 }, ...extra });
    state.selectedSprint = SPRINT_ALL;
    state.issueStatusIndex = { 'P-1': { pi: '${EVIL}', statusCategory: 'new' } };
    state.jiraIssues = [
        pm(0, { key: 'E-1', type: 'Epic', epicKey: null, epicTitle: null }),
        pm(1, { dependencyBlocked: true, dependencyNote: '${EVIL}' }), pm(2, { type: 'Bug' }), pm(3, { epicKey: null, epicTitle: null }),
    ];
    state.deployments = [{ id: 1, environment: 'prod', status: 'success', component: '${EVIL}', relatedIssues: ['P-1', 'P-2'], deployedAt: new Date().toISOString() }];
    state.flagsMeta = { fl: { source: 'build', jiraKeys: ['P-1'], components: ['${EVIL}'] } };
    state.flagStates = { fl: { prod: { build: { enabled: true, changedAt: '2026-01-01' } } } };
    renderProductSummary(); renderIssues();
    expandedIssue = 'P-1'; renderIssues();`, ctx);

    for (const id of ['pvSummary', 'issueCount', 'issueBody']) {
        const out = html(id);

        assert.ok(!out.includes(EVIL), `${id} contains an unescaped payload`);
        assert.ok(!/>\s*,\s*</.test(out), `${id} contains a stray comma between elements`);
        assert.ok(!/\[object Object\]/.test(out), `${id} contains a stringified object`);
    }
    assert.ok(html('issueBody').includes('wi-epic-row'), 'expected an epic header');
    assert.ok(html('issueBody').includes('breakdown-table'), 'expected the expanded breakdown');
    assert.ok(html('issueBody').includes('Ungrouped'), 'expected the ungrouped section');
    assert.ok(html('issueBody').includes('&lt;img'), 'expected hostile fields to appear escaped');
});
