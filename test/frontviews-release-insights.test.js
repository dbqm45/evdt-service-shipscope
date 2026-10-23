// Unit + render tests for docs/app-release-notes.js and docs/app-insights.js, run in a vm with a small functional stub DOM and a
// frozen clock (FakeDate) so nothing depends on wall-clock time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', 'docs');
const FILES = ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model', 'app-product', 'app-technical', 'app-technical-matrix', 'app-technical-timeline', 'app-technical-flags', 'app-release-notes', 'app-insights'];
const NOW = Date.parse('2026-10-09T12:20:00.000Z');
const DAY = 86400000;
const EVIL = '<img src=x onerror=alert(1)>';
const ago = (minutes, days = 0) => new Date(NOW - minutes * 60000 - days * DAY).toISOString();

class El {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.listeners = {};
        this._html = '';
        this.value = '';
        this.checked = false;
        this.textContent = '';
        this.className = '';
        this.title = '';
        this.disabled = false;
        this.scrollTop = 0;
        this.clientHeight = 0;
        this.scrollHeight = 0;
        this.classes = new Set();
        this.classList = {
            add: (...c) => c.forEach(x => this.classes.add(x)),
            remove: (...c) => c.forEach(x => this.classes.delete(x)),
            toggle: (c, on) => {
                const want = on === undefined ? !this.classes.has(c) : !!on;

                if (want) this.classes.add(c); else this.classes.delete(c);

                return want;
            },
            contains: c => this.classes.has(c),
        };
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); if (this._html === '') this.children = []; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    fire(t, e = {}) { (this.listeners[t] || []).forEach(f => f.call(this, e)); }
    getBoundingClientRect() { return { height: 70 }; }
    getAttribute() { return null; }
    setAttribute() {}
    querySelectorAll(sel) { return this.qsa ? this.qsa(sel) : []; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function loadApp() {
    const els = {};
    class FakeDate extends Date {
        constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
        static now() { return NOW; }
    }
    const el = id => els[id] || (els[id] = new El());
    const ctx = {
        console, URLSearchParams, Date: FakeDate, Math, Map, Set, CSS: { escape: s => String(s) }, location: { search: '?insights=1' },
        localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }),
        document: {
            documentElement: new El(), body: new El(), getElementById: el, querySelector: () => null, querySelectorAll: () => [],
            addEventListener() {}, createElement: tag => new El(tag),
        },
    };

    vm.createContext(ctx);
    FILES.forEach(f => {
        const file = path.join(DOCS, `${f}.js`);

        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    });

    const ev = code => {
        const s = vm.runInContext(`JSON.stringify(${code})`, ctx);

        return s === undefined ? undefined : JSON.parse(s);
    };
    const run = code => vm.runInContext(code, ctx);
    const setState = o => run(`state = ${JSON.stringify({
        selectedPi: 'PI-27.3', selectedSprint: '', jiraIssues: [], deployments: [], flagsMeta: {}, flagStates: {}, flagStateHistory: [],
        issueDeployments: {}, issueStatusIndex: {}, componentsOrder: [], jiraBrowseUrl: 'https://jira.example/browse', jiraIndex: null, ...o,
    })}`);

    return { ctx, el, ev, run, setState, html: id => String(els[id].innerHTML) };
}

const dep = (o = {}) => ({ id: 1, component: 'svc', environment: 'prod', status: 'success', version: 'v1.0.0', deployedAt: ago(0), ...o });
const flagEntry = (enabled, changedAt = ago(0)) => ({ enabled, changedAt, changedBy: 'bot' });
const issue = (key, o = {}) => ({ key, type: 'Story', title: `T ${key}`, pi: 'PI-27.3', sprint: 'Sparks 27.3.1', priority: 'Major', status: 'In Progress', statusCategory: 'indeterminate', ...o });
const idx = (sprints, currentPi = 'PI-27.3') => ({ currentPi, pis: [{ pi: 'PI-27.3', file: 'x.json', sprints }] });
const inCtx = (ctx, name, value) => vm.runInContext(`${name} = ${JSON.stringify(value)}`, ctx);

const flagged = (n, state, extra = {}) => ({
    flagsMeta: { [`f${n}`]: { jiraKeys: [`K-${n}`], components: ['svc'] } },
    flagStates: { [`f${n}`]: { prod: { build: flagEntry(state) } } },
    ...extra,
});

function rnState(extra = {}) {
    return {
        jiraIndex: idx([]),
        jiraIssues: [
            issue('K-1', { sprint: 'Sparks 27.3.2', title: EVIL }), issue('K-2', { type: 'Bug', sprint: 'Sparks 27.3.2' }), issue('K-3', { sprint: 'Sparks 27.3.1' }),
            issue('K-4', { sprint: null }), issue('K-5', { sprint: 'Sparks 27.3.2', pi: '—' }), issue('K-6', { sprint: 'Sparks 27.3.1' }),
        ],
        flagsMeta: { f1: { jiraKeys: ['K-1', 'K-2'], components: ['svc'] }, f6: { jiraKeys: ['K-6'], components: ['svc'] } },
        flagStates: { f1: { prod: { build: flagEntry(true) } }, f6: { prod: { build: flagEntry(false) } } },
        deployments: [dep({ relatedIssues: ['K-1', 'K-2', 'K-3', 'K-4', 'K-5', 'K-6'], deployedAt: ago(0, 3) })],
        ...extra,
    };
}

function notesFilters(el, app = '', type = '') {
    el('filterNotesApp').value = app;
    el('filterNotesType').value = type;
}

test('releaseNotesModel: PI and sprint groups newest first, features and bugs split, last prod date', () => {
    const { ev, setState } = loadApp();

    setState(rnState({ jiraIndex: idx([{ name: 'Sparks 27.3.2', startDate: ago(0, 5), endDate: ago(0, -9) }]) }));
    const { reason, groups } = ev("releaseNotesModel({ app: '', type: '' })");

    assert.equal(reason, null);
    assert.deepEqual(groups.map(g => [g.pi, g.isCurrent, g.features, g.bugs]), [['PI-27.3', true, 3, 1]]);
    const sprints = groups[0].sprints;

    assert.deepEqual(sprints.map(sp => sp.sprint).filter(n => n !== 'Unassigned sprint'), ['Sparks 27.3.2', 'Sparks 27.3.1']);
    assert.ok(sprints.some(sp => sp.sprint === 'Unassigned sprint'), 'an issue without a sprint gets its own group');
    const current = sprints.find(sp => sp.sprint === 'Sparks 27.3.2');

    assert.equal(current.isCurrent, true);
    assert.equal(current.key, JSON.stringify(['PI-27.3', 'Sparks 27.3.2']));
    assert.deepEqual(current.features.map(i => i.issue.key), ['K-1']);
    assert.deepEqual(current.bugs.map(i => i.issue.key), ['K-2']);
    assert.equal(current.lastProdAt, Date.parse(ago(0, 3)));
    assert.deepEqual(sprints.find(sp => sp.sprint === 'Sparks 27.3.1').items.map(i => i.issue.key), ['K-3'], 'K-6 (flag off) is not released');
});

test('notesCountsText: items and bug fixes, singular and plural', () => {
    const { ev } = loadApp();

    assert.equal(ev("notesCountsText({ items: [1], bugs: [] })"), '1 item');
    assert.equal(ev("notesCountsText({ items: [1, 2, 3], bugs: [1] })"), '3 items · 1 bug fix');
    assert.equal(ev("notesCountsText({ items: [1, 2], bugs: [1, 2] })"), '2 items · 2 bug fixes');
});

test('renderReleaseNotes: empty state when nothing is synced', () => {
    const { run, setState, el, html } = loadApp();

    setState({});
    notesFilters(el);
    run('renderReleaseNotes()');
    assert.ok(html('releaseNotesBody').includes('No issues synced from Jira yet'));
});

test('renderReleaseNotes: stub-only issues explain the missing PI', () => {
    const { run, setState, el, html } = loadApp();

    setState({ jiraIssues: [issue('S-1', { pi: null }), issue('S-2', { pi: '—' })] });
    notesFilters(el);
    run('renderReleaseNotes()');
    assert.ok(html('releaseNotesBody').includes('Found 2 synced issue(s), but none have a real PI yet'));
});

test('renderReleaseNotes: filters that match nothing and real issues not yet on PROD', () => {
    const { run, setState, el, html } = loadApp();

    setState({ jiraIssues: [issue('N-1')] });
    notesFilters(el);
    run('renderReleaseNotes()');
    assert.ok(html('releaseNotesBody').includes('none are released to PROD yet'));

    notesFilters(el, 'Nope');
    run('renderReleaseNotes()');
    assert.ok(html('releaseNotesBody').includes('No results for the selected filters'));

    notesFilters(el, '', 'Epic');
    run('renderReleaseNotes()');
    assert.ok(html('releaseNotesBody').includes('No results for the selected filters'));
});

test('renderReleaseNotes: sprint list and the newest sprint\'s panel, escaped, with figures and sections', () => {
    const { run, setState, el, html } = loadApp();

    setState(rnState());
    notesFilters(el);
    run('renderReleaseNotes()');
    const out = html('releaseNotesBody');

    assert.ok(!out.includes(EVIL));
    assert.ok(out.includes('&lt;img'));
    assert.ok(out.indexOf('Sparks 27.3.2') < out.indexOf('Sparks 27.3.1'), 'newest sprint first');
    assert.ok(out.includes('Unassigned sprint'));
    assert.ok(!out.includes('K-5'), 'non-real PI issue is not listed');
    assert.match(out, /<button type="button" class="dn-sprint active" data-sprint-key="[^"]*Sparks 27.3.2[^"]*" aria-pressed="true">/);
    assert.ok(out.includes('2 items · 1 bug fix'));
    assert.ok(out.includes('<b>3</b> features · <b>1</b> bug<'));
    // the panel: Sparks 27.3.2 with K-1 (feature, flag on) and K-2 (bug, flag on)
    assert.match(out, /<h2 class="dn-panel-title">Sparks 27.3.2<\/h2>/);
    assert.ok(out.includes('data-copy-notes'));
    assert.match(out, /dn-stat-value[^"]*">2<[\s\S]*items on prod[\s\S]*dn-stat-value[^"]*">2<[\s\S]*released to users[\s\S]*dn-stat-value[^"]*">0<[\s\S]*code deployed, no flag[\s\S]*dn-stat-value[^"]*">1<[\s\S]*bugs fixed/);
    assert.ok(out.includes('Features &amp; improvements') && out.includes('Bug fixes'));
    assert.ok(out.includes('status-pill'));
    assert.ok(out.includes('browse/K-1'));
    assert.ok(out.includes(`on prod ${run(`fmtDateShort(${JSON.stringify(ago(0, 3))})`)}`));

    // a selected sprint stays selected while it is listed; the Bug filter drops it and the panel falls back
    run(`selectedNotesSprint = ${JSON.stringify(JSON.stringify(['PI-27.3', 'Sparks 27.3.1']))}`);
    run('renderReleaseNotes()');
    assert.match(html('releaseNotesBody'), /<h2 class="dn-panel-title">Sparks 27.3.1<\/h2>/);
    notesFilters(el, '', 'Bug');
    run('renderReleaseNotes()');
    const bugsOnly = html('releaseNotesBody');

    assert.match(bugsOnly, /<h2 class="dn-panel-title">Sparks 27.3.2<\/h2>/);
    assert.ok(bugsOnly.includes('Bug fixes') && !bugsOnly.includes('Features &amp; improvements'));
    assert.ok(bugsOnly.includes('1 item · 1 bug fix'));
});

test('releaseNotesMarkdown: the selected sprint as headings and lists, keys linked only to https', () => {
    const { run, setState, el } = loadApp();

    setState(rnState());
    notesFilters(el);
    const date = run(`fmtDateShort(${JSON.stringify(ago(0, 3))})`);

    assert.equal(run('releaseNotesMarkdown()'), [
        '## Sparks 27.3.2 (PI-27.3)', '',
        '### Features & improvements', '', `- [K-1](https://jira.example/browse/K-1) ${EVIL} (Released, on prod ${date})`, '',
        '### Bug fixes', '', `- [K-2](https://jira.example/browse/K-2) T K-2 (Released, on prod ${date})`, '',
    ].join('\n'));

    setState(rnState({ jiraBrowseUrl: null }));
    assert.ok(run('releaseNotesMarkdown()').includes('- K-1 '), 'unlinked without Jira');
    setState({});
    assert.equal(run('releaseNotesMarkdown()'), '');
});

test('renderReleaseNotes: sprint with only unreleased items is omitted, and PI with none too', () => {
    const { run, setState, el, html } = loadApp();

    setState(rnState({
        jiraIssues: [issue('K-1', { sprint: 'Sparks 27.3.2' }), issue('K-6', { sprint: 'Sparks 27.3.1' }), issue('K-8', { pi: 'PI-27.2', sprint: 'Sparks 27.2.1' })],
    }));
    notesFilters(el);
    run('renderReleaseNotes()');
    const out = html('releaseNotesBody');

    assert.ok(out.includes('Sparks 27.3.2'));
    assert.ok(!out.includes('Sparks 27.3.1'));
    assert.ok(!out.includes('PI-27.2'));
});

test('renderReleaseNotes: lists several PIs newest first', () => {
    const { run, setState, el, html } = loadApp();

    setState(rnState({
        jiraIssues: [issue('K-1', { sprint: 'Sparks 27.3.2' }), issue('K-9', { pi: 'PI-27.2', sprint: 'Sparks 27.2.1' })],
        flagsMeta: { f1: { jiraKeys: ['K-1', 'K-9'], components: ['svc'] } },
        deployments: [dep({ relatedIssues: ['K-1', 'K-9'], deployedAt: ago(0, 3) })],
    }));
    notesFilters(el);
    run('renderReleaseNotes()');
    const out = html('releaseNotesBody');

    assert.ok(out.indexOf('PI-27.3') < out.indexOf('PI-27.2'));
});

test('renderReleaseNotes: application filter narrows by component application', () => {
    const { run, setState, el, html } = loadApp();

    setState(rnState({
        componentsOrder: [{ name: 'svc', application: ['EBO'] }],
        jiraIssues: [issue('K-1', { sprint: 'Sparks 27.3.2' })],
    }));
    notesFilters(el, 'EBO');
    run('renderReleaseNotes()');
    assert.ok(html('releaseNotesBody').includes('dn-item'));
    notesFilters(el, 'EVP');
    run('renderReleaseNotes()');
    assert.ok(html('releaseNotesBody').includes('No results for the selected filters'));
});

test('renderReleaseNotes: item without a resolvable prod date omits the date', () => {
    const { run, setState, el, html } = loadApp();

    setState(rnState({ jiraIssues: [issue('K-1')], deployments: [dep({ relatedIssues: ['K-1'], deployedAt: null })] }));
    notesFilters(el);
    run('renderReleaseNotes()');
    const out = html('releaseNotesBody');

    assert.ok(out.includes('dn-item'));
    assert.ok(!out.includes('dn-item-date') && !out.includes('last on prod'), 'no date on the item, none in the panel note');
    assert.ok(out.includes('<b>—</b>'));
});

test('comparePriorityDesc ranks the org scheme then unknown names alphabetically', () => {
    const { ev } = loadApp();

    assert.deepEqual(ev("['Minor','Zeta','Blocker','Alpha','Medium','Critical','Major'].sort(comparePriorityDesc)"),
        ['Blocker', 'Critical', 'Major', 'Medium', 'Minor', 'Alpha', 'Zeta']);
    assert.equal(ev("comparePriorityDesc('Blocker','Mystery')"), -1);
    assert.equal(ev("comparePriorityDesc('Mystery','Blocker')"), 1);
});

test('sprintLabelFor extracts the PI.sprint label, else the sprint itself, or null without a sprint', () => {
    const { ev } = loadApp();

    assert.equal(ev("sprintLabelFor({ sprint: 'Sparks 27.3.3' })"), 'PI-27.3.3');
    assert.equal(ev("sprintLabelFor({ sprint: 'Sprint 42' })"), 'Sprint 42');
    assert.equal(ev("sprintLabelFor({ sprint: null })"), null);
    assert.equal(ev('sprintLabelFor({})'), null);
});

test('sprintReleaseStatusBreakdown buckets prod status per sprint, newest first', () => {
    const { ev, setState } = loadApp();

    setState({
        flagsMeta: { f1: { jiraKeys: ['R-1'], components: ['svc'] }, f2: { jiraKeys: ['H-1'], components: ['svc'] }, f3: { jiraKeys: ['P-1', 'P-2'], components: ['svc', 'other'] } },
        flagStates: { f1: { prod: { build: flagEntry(true) } }, f2: { prod: { build: flagEntry(false) } }, f3: { prod: { build: flagEntry(true) } } },
        deployments: [dep({ relatedIssues: ['R-1', 'H-1', 'C-1', 'P-1'] })],
        jiraIssues: [
            issue('R-1', { sprint: 'S 27.3.2' }), issue('H-1', { sprint: 'S 27.3.2' }), issue('C-1', { sprint: 'S 27.3.2' }),
            issue('N-1', { sprint: 'S 27.3.1' }), issue('P-1', { sprint: 'S 27.3.1' }), issue('X-1', { sprint: 'plain' }),
        ],
    });
    const rows = ev('sprintReleaseStatusBreakdown()');

    // A sprint not named after a PI (a team that doesn't work in PIs) is its own bucket, not dropped.
    assert.deepEqual(rows.map(r => r.label), ['PI-27.3.2', 'PI-27.3.1', 'plain']);
    assert.equal(rows[2].total, 1);
    assert.deepEqual(rows[0].counts, { none: 0, deployedHidden: 2, released: 1, partial: 0 });
    assert.equal(rows[0].total, 3);
    assert.equal(rows[1].counts.none, 1);
    assert.equal(rows[1].counts.partial, 1);
});

test('renderSprintStatusChart: empty state and bars with escaped labels', () => {
    const { run, setState, html } = loadApp();

    setState({});
    run('renderSprintStatusChart()');
    assert.ok(html('chartSprint').includes('No issues with a detectable sprint'));

    setState({
        ...flagged(1, true, { deployments: [dep({ relatedIssues: ['K-1'] })] }),
        jiraIssues: [issue('K-1', { sprint: 'S 27.3.2' }), issue('K-2', { sprint: 'S 27.3.2' })],
    });
    run('renderSprintStatusChart()');
    const out = html('chartSprint');

    assert.ok(out.includes('chart-legend'));
    assert.ok(out.includes('seg-released') && out.includes('seg-none'));
    assert.ok(out.includes('width:50.0%'));
    assert.ok(out.includes('PI-27.3.2'));
    assert.ok(!/>\s*,\s*</.test(out));
});

test('priorityReleaseStatusBreakdown skips stub PIs and missing priorities, ranks by org order', () => {
    const { ev, setState } = loadApp();

    setState({
        ...flagged(1, true, { deployments: [dep({ relatedIssues: ['K-1'] })] }),
        jiraIssues: [
            issue('K-1', { priority: 'Minor' }), issue('K-2', { priority: 'Blocker' }), issue('K-3', { priority: null }), issue('K-4', { pi: '—', priority: 'Major' }),
            issue('K-5', { priority: 'Zeta' }), issue('K-6', { priority: 'Blocker' }),
        ],
    });
    const rows = ev('priorityReleaseStatusBreakdown()');

    assert.deepEqual(rows.map(r => r.label), ['Blocker', 'Minor', 'Zeta']);
    assert.equal(rows[0].total, 2);
    assert.equal(rows[1].counts.released, 1);
});

test('renderPriorityStatusChart: empty state and rows', () => {
    const { run, setState, html } = loadApp();

    setState({});
    run('renderPriorityStatusChart()');
    assert.ok(html('chartPriority').includes('No issues with a priority set yet'));

    setState({ jiraIssues: [issue('K-1', { priority: EVIL })] });
    run('renderPriorityStatusChart()');
    const out = html('chartPriority');

    assert.ok(!out.includes(EVIL));
    assert.ok(out.includes('&lt;img'));
    assert.ok(out.includes('seg-none'));
    assert.ok(out.includes('width:100.0%'));
});

test('staleFlagDaysBreakdown lists only prod-ON flags, longest first, with the stale threshold', () => {
    const { ev, setState } = loadApp();

    setState({
        flagsMeta: { a: {}, b: {}, c: {}, d: {}, e: {} },
        flagStates: {
            a: { prod: { build: flagEntry(true, ago(0, 10)) } },
            b: { prod: { build: flagEntry(true, ago(0, 60)) } },
            c: { prod: { build: flagEntry(false, ago(0, 100)) } },
            d: { qa: { build: flagEntry(true, ago(0, 100)) } },
        },
    });
    assert.deepEqual(ev('staleFlagDaysBreakdown()'), [{ key: 'b', days: 60, stale: true }, { key: 'a', days: 10, stale: false }]);
});

test('renderStaleFlagsChart: empty state, bar widths and stale colouring', () => {
    const { run, setState, html } = loadApp();

    setState({});
    run('renderStaleFlagsChart()');
    assert.ok(html('chartStaleFlags').includes('No flags are currently ON in prod'));

    setState({
        flagsMeta: { [EVIL]: {}, fresh: {}, today: {} },
        flagStates: {
            [EVIL]: { prod: { build: flagEntry(true, ago(0, 100)) } },
            fresh: { prod: { build: flagEntry(true, ago(0, 50)) } },
            today: { prod: { build: flagEntry(true, ago(0)) } },
        },
    });
    run('renderStaleFlagsChart()');
    const out = html('chartStaleFlags');

    assert.ok(!out.includes(EVIL));
    assert.ok(out.includes('seg-stale') && out.includes('seg-deployed'));
    assert.ok(out.includes('width:100.0%'));
    assert.ok(out.includes('width:2.0%'));
    assert.ok(out.includes('100d'));
    assert.ok(out.includes('title="100 day(s) ON in prod"'));
});

test('earliestProdDeployedAt takes the minimum across live deployments and the never-trimmed history', () => {
    const { ev, setState } = loadApp();
    const t = d => Date.parse(ago(0, d));

    setState({
        deployments: [
            dep({ relatedIssues: ['K-1'], deployedAt: ago(0, 5) }), dep({ id: 2, relatedIssues: ['K-1'], deployedAt: ago(0, 9) }),
            dep({ id: 3, relatedIssues: ['K-1'], environment: 'qa', deployedAt: ago(0, 50) }), dep({ id: 4, relatedIssues: ['K-1'], status: 'failure', deployedAt: ago(0, 60) }),
            dep({ id: 5, deployedAt: ago(0, 70) }),
        ],
        issueDeployments: { 'K-1': { prod: { c: { deployedAt: ago(0, 30) } } }, 'K-2': { prod: { c: { deployedAt: ago(0, 8) } } }, 'K-3': {} },
    });
    assert.equal(ev("earliestProdDeployedAt({ key: 'K-1' })"), t(30));
    assert.equal(ev("earliestProdDeployedAt({ key: 'K-2' })"), t(8));
    assert.equal(ev("earliestProdDeployedAt({ key: 'K-3' })"), null);
    assert.equal(ev("earliestProdDeployedAt({ key: 'K-9' })"), null);
    assert.equal(ev("earliestProdDeployedAt({ key: 'K-9', subtaskKeys: ['K-1', 'K-2'] })"), t(30), 'its sub-tasks\' deployments count');
});

test('leadTimeToProdBySprint: median per sprint, clamping and exclusions', () => {
    const { ev, setState } = loadApp();

    setState({
        deployments: [dep({ relatedIssues: ['L-1', 'L-2', 'L-3', 'L-4', 'L-5', 'L-6'], deployedAt: ago(0, 10) })],
        jiraIssues: [
            issue('L-1', { sprint: 'S 27.3.2', resolvedAt: ago(0, 14) }),
            issue('L-2', { sprint: 'S 27.3.2', resolvedAt: ago(0, 20) }),
            issue('L-3', { sprint: 'S 27.3.2', resolvedAt: ago(0, 11) }),
            issue('L-4', { sprint: 'S 27.3.1', resolvedAt: ago(0, 2) }),
            issue('L-5', { sprint: 'S 27.3.1', resolvedAt: ago(0, 16) }),
            issue('L-6', { sprint: 'nosprint', resolvedAt: ago(0, 16) }),
            issue('L-7', { sprint: 'S 27.3.1', resolvedAt: ago(0, 16) }),
            issue('L-8', { sprint: 'S 27.3.1' }),
        ],
    });
    assert.deepEqual(ev('leadTimeToProdBySprint()'), [
        { label: 'PI-27.3.2', median: 4, count: 3 },
        { label: 'PI-27.3.1', median: 3, count: 2 },
        { label: 'nosprint', median: 6, count: 1 },
    ], 'a sprint not named after a PI is its own bucket');
});

test('renderLeadTimeChart: empty state and bars', () => {
    const { run, setState, html } = loadApp();

    setState({});
    run('renderLeadTimeChart()');
    assert.ok(html('chartLeadTime').includes('No resolved issues with a prod deployment yet'));

    setState({
        deployments: [dep({ relatedIssues: ['L-1', 'L-2'], deployedAt: ago(0, 10) })],
        jiraIssues: [issue('L-1', { sprint: 'S 27.3.2', resolvedAt: ago(0, 20) }), issue('L-2', { sprint: 'S 27.3.1', resolvedAt: ago(0, 10) })],
    });
    run('renderLeadTimeChart()');
    const out = html('chartLeadTime');

    assert.ok(out.includes('10d'));
    assert.ok(out.includes('0d'));
    assert.ok(out.includes('width:100.0%'));
    assert.ok(out.includes('width:2.0%'));
    assert.ok(out.includes('Median 10d over 1 issue(s)'));
});

test('rollbackDriftByMonth buckets by month inside the 12-month window, oldest first', () => {
    const { ev, setState } = loadApp();

    setState({ deployments: [
        dep({ id: 1, deployedAt: '2026-10-05T10:00:00Z', rollback: { toRef: 'x' } }),
        dep({ id: 2, deployedAt: '2026-10-06T10:00:00Z', driftBehind: { behindEnv: 'qa', commitCount: 2 } }),
        dep({ id: 3, deployedAt: '2026-10-07T10:00:00Z', driftBehind: { untestedIn: 'qa', untestedCommitCount: 1 } }),
        dep({ id: 4, deployedAt: '2026-10-08T10:00:00Z', driftBehind: { behindEnv: 'qa', commitCount: 0 } }),
        dep({ id: 5, deployedAt: '2026-07-15T10:00:00Z', rollback: { toRef: 'y' }, driftBehind: { commitCount: 1 } }),
        dep({ id: 6, deployedAt: '2024-01-15T10:00:00Z', rollback: { toRef: 'old' } }),
        dep({ id: 7, deployedAt: null, rollback: { toRef: 'none' } }),
    ] });
    const rows = ev('rollbackDriftByMonth()');

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => [r.rollback, r.drift]), [[1, 1], [1, 2]]);
});

test('renderRollbackDriftChart: empty states and columns', () => {
    const { run, setState, html } = loadApp();

    setState({});
    run('renderRollbackDriftChart()');
    assert.ok(html('chartRollbackDrift').includes('No rollbacks or drift detected'));

    setState({ deployments: [dep({ deployedAt: '2026-10-05T10:00:00Z' })] });
    run('renderRollbackDriftChart()');
    assert.ok(html('chartRollbackDrift').includes('No rollbacks or drift detected'));

    setState({ deployments: [
        dep({ id: 1, deployedAt: '2026-10-05T10:00:00Z', rollback: { toRef: 'x' } }),
        dep({ id: 2, deployedAt: '2026-08-05T10:00:00Z', driftBehind: { commitCount: 3 } }),
        dep({ id: 3, deployedAt: '2026-08-06T10:00:00Z', driftBehind: { commitCount: 3 } }),
        dep({ id: 4, deployedAt: '2026-08-07T10:00:00Z', driftBehind: { commitCount: 3 } }),
    ] });
    run('renderRollbackDriftChart()');
    const out = html('chartRollbackDrift');

    assert.equal(out.split('class="col-chart-col"').length - 1, 2);
    assert.ok(out.includes('Rollbacks: 1') && out.includes('Drift: 3'));
    assert.ok(out.includes("height:33.33"));
    assert.ok(out.includes('height:0px'));
    assert.ok(out.includes('height:100px'));
});

test('renderInsights renders all five charts without stray commas', () => {
    const { run, setState, html } = loadApp();

    setState(rnState({ issueDeployments: {} }));
    run('renderInsights()');
    for (const id of ['chartSprint', 'chartLeadTime', 'chartPriority', 'chartStaleFlags', 'chartRollbackDrift']) {
        assert.ok(html(id).length > 0, id);
        assert.ok(!/>\s*,\s*</.test(html(id)), id);
    }
});
