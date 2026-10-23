// Unit + render tests for docs/app-technical.js, run in a vm with a small functional stub DOM and a
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
        this.attrs = {};
        this._html = '';
        this.value = '';
        this.checked = false;
        this.textContent = '';
        this.className = '';
        this.title = '';
        this.height = 70;
        this.scrollTop = 0;
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
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    fire(t, e = {}) { (this.listeners[t] || []).forEach(f => f.call(this, e)); }
    getBoundingClientRect() { return { height: this.height }; }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
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

const dep = (o = {}) => ({ id: 1, component: 'evapl-service-frontend', environment: 'prod', status: 'success', version: 'v1.0.0', deployedAt: ago(0), deployedBy: 'Ann', ...o });
const flagEntry = (enabled, changedAt = ago(0)) => ({ enabled, changedAt, changedBy: 'bot' });
// Objects must be created inside the vm realm for instanceof/Array.isArray checks; JSON round trip does that.
const inCtx = (ctx, name, value) => vm.runInContext(`${name} = ${JSON.stringify(value)}`, ctx);

test('orderedComponents / componentMeta / applications helpers', () => {
    const { ev, setState } = loadApp();

    setState({ componentsOrder: [
        { name: 'b', application: ['EBO', 'EVP'] }, { name: 'a', application: [] }, { name: 'c', application: ['EBO'] }, { name: 'z' },
    ] });
    assert.deepEqual(ev("orderedComponents(['z','c','x','a','b','y'])"), ['b', 'a', 'c', 'z', 'x', 'y']);
    assert.equal(ev("componentMeta('c').application[0]"), 'EBO');
    assert.equal(ev("componentMeta('nope')"), null);
    assert.deepEqual(ev("applicationsForComponent('b')"), ['EBO', 'EVP']);
    assert.deepEqual(ev("applicationsForComponent('a')"), ['a']);
    assert.deepEqual(ev("applicationsForComponent('unknown')"), ['unknown']);
    assert.deepEqual(ev("orderedApplications(['q','EVP','a','EBO','z'])"), ['EBO', 'EVP', 'a', 'z', 'q']);

    setState({});
    assert.deepEqual(ev("orderedComponents(['b','a'])"), ['a', 'b']);
    assert.equal(ev("componentMeta('a')"), null);
    assert.deepEqual(ev("orderedApplications(['b','a'])"), ['a', 'b']);
});

test('componentsForIssue / applicationsForIssue combine flag links and deployment relatedIssues', () => {
    const { ev, setState } = loadApp();

    setState({
        componentsOrder: [{ name: 'fe', application: ['EBO'] }, { name: 'be' }],
        flagsMeta: { f: { jiraKeys: ['A-1'], components: ['fe'] } },
        deployments: [dep({ component: 'be', relatedIssues: ['A-1'] }), dep({ id: 2, component: 'fe' }), dep({ id: 3, component: 'fe', relatedIssues: ['A-1'] })],
    });
    assert.deepEqual(ev("componentsForIssue({ key: 'A-1' })").sort(), ['be', 'fe']);
    assert.deepEqual(ev("applicationsForIssue({ key: 'A-1' })").sort(), ['EBO', 'be']);
    assert.deepEqual(ev("componentsForIssue({ key: 'A-9' })"), []);
    assert.deepEqual(ev("componentsForIssue({ key: 'A-8', subtaskKeys: ['A-1'] })"), ['be', 'fe'], 'a sub-task\'s deployments count');
    assert.deepEqual(ev("applicationsForIssue({ key: 'A-9' })"), ['Unassigned']);
});

test('issueIsReleasedToProd reflects released and code-only levels only', () => {
    const { ev, setState } = loadApp();

    setState({
        flagsMeta: { on: { jiraKeys: ['R-1'], components: ['c'] }, off: { jiraKeys: ['H-1'], components: ['c'] } },
        flagStates: { on: { prod: { build: flagEntry(true) } }, off: { prod: { build: flagEntry(false) } } },
        deployments: [dep({ component: 'c', relatedIssues: ['R-1', 'H-1', 'C-1'] })],
    });
    assert.equal(ev("issueIsReleasedToProd({ key: 'R-1' })"), true);
    assert.equal(ev("issueIsReleasedToProd({ key: 'H-1' })"), false);
    assert.equal(ev("issueIsReleasedToProd({ key: 'C-1' })"), true);
    assert.equal(ev("issueIsReleasedToProd({ key: 'N-1' })"), false);
});

test('componentKind derives a two-letter avatar from the naming convention', () => {
    const { ev } = loadApp();
    const kind = c => ev(`componentKind(${JSON.stringify(c)})`);

    assert.equal(kind('evapl-service-frontend'), 'FE');
    assert.equal(kind('x-service-FE'), 'FE');
    assert.equal(kind('x-service-backend'), 'BE');
    assert.equal(kind('x-service-be'), 'BE');
    assert.equal(typeof kind('evboweb-service-bff'), 'string');
    assert.equal(typeof kind('plainname'), 'string');
});

test('flagDivergesInEnv only fires when build and runtime-be disagree', () => {
    const { ev, setState } = loadApp();

    setState({ flagStates: {
        d: { prod: { build: flagEntry(true), 'runtime-be': flagEntry(false) } },
        s: { prod: { build: flagEntry(true), 'runtime-be': flagEntry(true) } },
        o: { prod: { build: flagEntry(true) } },
    } });
    assert.equal(ev("flagDivergesInEnv('d','prod')"), true);
    assert.equal(ev("flagDivergesInEnv('s','prod')"), false);
    assert.equal(ev("flagDivergesInEnv('o','prod')"), false);
    assert.equal(ev("flagDivergesInEnv('d','qa')"), false);
    assert.equal(ev("flagDivergesInEnv('missing','prod')"), false);
});

test('renderSummaryCards: empty data', () => {
    const { run, setState, html } = loadApp();

    setState({});
    run('renderSummaryCards()');
    const out = html('summaryGrid');

    assert.ok(out.includes('Services tracked'));
    assert.ok(!/>\s*,\s*</.test(out));
});

test('renderSummaryCards: behind prod, failed deploys today and diverging flags', () => {
    const { run, setState, html } = loadApp();

    setState({
        deployments: [
            dep({ id: 1, component: 'a', driftBehind: { behindEnv: 'qa', commitCount: 2 } }),
            dep({ id: 2, component: 'b', environment: 'test', status: 'failure' }),
            dep({ id: 3, component: 'c', deployedAt: ago(0, 3) }),
        ],
        flagsMeta: { f1: {}, f2: {} },
        flagStates: { f1: { prod: { build: flagEntry(true), 'runtime-be': flagEntry(false) } }, f2: { qa: { build: flagEntry(true) } } },
    });
    run('renderSummaryCards()');
    const out = html('summaryGrid');

    assert.ok(out.includes('1 service differ'));
    assert.ok(out.includes('1 failed'));
});

test('renderSummaryCards: plural behind note', () => {
    const { run, setState, html } = loadApp();
    const behind = { behindEnv: 'qa', commitCount: 1 };

    setState({
        deployments: [dep({ id: 1, component: 'a', driftBehind: behind }), dep({ id: 2, component: 'b', driftBehind: behind })],
    });
    run('renderSummaryCards()');
    assert.ok(html('summaryGrid').includes('2 services differ'));
});

test('envCardHeaderHtml: first env, behind and in-sync notes', () => {
    const { run, setState } = loadApp();

    setState({ deployments: [
        dep({ id: 1, component: 'a', environment: 'qa', driftBehind: { behindEnv: 'test', commitCount: 3 } }),
        dep({ id: 2, component: 'b', environment: 'qa' }),
        dep({ id: 3, component: 'a', environment: 'test' }),
    ] });
    const head = (env, i, comps) => String(run(`envCardHeaderHtml('${env}', ${i}, ${JSON.stringify(comps)})`));

    assert.ok(head('test', 0, ['a']).includes('latest builds'));
    assert.ok(head('qa', 1, ['a', 'b']).includes('1 differ from TEST'));
    assert.ok(head('qa', 1, ['b']).includes('in sync with TEST'));
    assert.ok(head('prod', 2, []).includes('in sync with QA'));
});

test('buildComponentRow: not deployed row escapes name, description and shows the flags-not-tracked icon', () => {
    const { run, setState } = loadApp();

    setState({ componentsOrder: [{ name: 'x-service-frontend', description: `d"${EVIL}`, featureFlagsIncluded: false }] });
    const row = run("buildComponentRow('x-service-frontend', 'qa')");

    assert.equal(row.className, 'comp-row');
    assert.ok(row.innerHTML.includes('not deployed'));
    assert.ok(!row.innerHTML.includes(EVIL));

    setState({ componentsOrder: [{ name: 'p', featureFlagsIncluded: null }] });
    const plain = run("buildComponentRow('p', 'qa')");

    assert.ok(plain.innerHTML.includes('not deployed'));
    assert.ok(!plain.innerHTML.includes(EVIL));
    assert.ok(row.innerHTML.length > plain.innerHTML.length);
});

test('buildComponentRow: deployed row with link, drift notes and click handler', () => {
    const { run, setState, el } = loadApp();

    setState({ deployments: [dep({
        component: 'c', version: `v1.2.3${EVIL}`, commitUrl: 'https://x/?a=1&b="2"', environment: 'qa', status: 'success',
        driftBehind: { behindEnv: 'test', commitCount: 2, untestedIn: 'test', untestedCommitCount: 4 },
    })] });
    const row = run("buildComponentRow('c', 'qa')");

    assert.ok(row.innerHTML.includes('href="https://x/?a=1&amp;b=&quot;2&quot;"'));
    assert.ok(!row.innerHTML.includes(EVIL));
    // One control with the same short label whatever the numbers; counts ride along in data-* for the modal only.
    assert.ok(row.innerHTML.includes('Diff to TEST'));
    assert.ok(!row.innerHTML.includes('behind TEST'));
    assert.ok(row.innerHTML.includes('drift-info-btn drift-note'));
    assert.ok(row.innerHTML.includes('data-behind="2"'));
    assert.ok(row.innerHTML.includes('data-skipped="4"'));
    assert.ok(row.innerHTML.includes('data-diff="null"'));
    assert.equal(row.innerHTML.split('<button').length - 1, 1);

    el('filterDeployRange').value = '7';
    row.onclick();
    assert.equal(el('filterEnv').value, 'qa');
    assert.equal(el('filterComponent').value, 'c');
    assert.equal(el('filterDeployRange').value, '');
    assert.ok(String(el('timeline').innerHTML).includes('deploy-item'));
});

test('buildComponentRow: same version label on different commits still shows the plain "Diff to" button', () => {
    const { run, setState } = loadApp();

    setState({ deployments: [dep({
        component: 'c', version: 'v1.4.19', environment: 'prod', status: 'success',
        driftBehind: { behindEnv: 'qa', commitCount: 417, untestedIn: 'qa', untestedCommitCount: 325, sameVersion: true },
    })] });

    const row = run("buildComponentRow('c', 'prod')");

    assert.ok(row.innerHTML.includes('drift-info-btn'));
    assert.ok(row.innerHTML.includes('Diff to QA'));
    assert.ok(row.innerHTML.includes('data-same-version="1"'));
    assert.ok(row.innerHTML.includes('data-behind="417"'));
    assert.ok(row.innerHTML.includes('data-skipped="325"'));
    assert.ok(!row.innerHTML.includes('417 / 325'));
});

test('buildComponentRow: a record with a file diff shows only "Diff to ENV" and clicking opens the modal', () => {
    const { run, setState, el } = loadApp();
    let shown = 0;

    setState({ deployments: [dep({
        component: 'c', version: 'v1.4.19', environment: 'prod', status: 'success',
        driftBehind: { behindEnv: 'qa', commitCount: 417, untestedIn: 'qa', untestedCommitCount: 325, sameVersion: true, diff: { files: 3, paths: ['a.js'], ignored: 0 } },
    })] });
    el('driftModal').showModal = () => { shown++; };
    el('filterComponent').value = 'untouched';

    const row = run("buildComponentRow('c', 'prod')");

    assert.ok(row.innerHTML.includes('Diff to QA'));
    assert.ok(!row.innerHTML.includes('3 file'));
    row.onclick({ target: { closest: () => ({ dataset: { env: 'QA', behind: '417', skipped: '325', sameVersion: '1', diff: JSON.stringify({ files: 3, paths: ['a.js'], ignored: 0 }) } }) } });

    assert.equal(shown, 1);
    assert.equal(el('filterComponent').value, 'untouched');
    assert.ok(el('driftModal').innerHTML.includes('3 files differ'));
    assert.ok(el('driftModal').innerHTML.includes('417 commit(s) on QA that PROD doesn'));
    assert.ok(el('driftModal').innerHTML.includes('325 commit(s) on PROD that QA doesn'));
    assert.ok(el('driftModal').innerHTML.includes('PROD - diff to QA') && el('driftModal').innerHTML.includes('<span class="drift-modal-service">c</span>'));
});

test('openDriftModal: unknown and legacy states, singular file, ignored note and truncated path list', () => {
    const { run, el } = loadApp();
    const open = o => { run(`openDriftModal(${JSON.stringify(o)})`); return String(el('driftModal').innerHTML); };

    el('driftModal').showModal = () => {};

    let out = open({ env: 'TEST', diff: JSON.stringify({ unknown: true }) });
    assert.ok(out.includes('Unknown'));
    assert.ok(out.includes('What this does not show'));

    out = open({ env: 'TEST', behind: '2' });
    assert.ok(!out.includes('File comparison not available') && !out.includes('Diff to TEST</h4>'));

    out = open({ env: 'TEST', diff: JSON.stringify({ files: 1, paths: ['src/a.js'], ignored: 4 }) });
    assert.ok(out.includes('1 file differs'));
    assert.ok(out.includes('4 more ignored'));
    assert.ok(out.includes('src/a.js'));
    assert.ok(!out.includes('Git history'));

    out = open({ env: 'TEST', diff: JSON.stringify({ files: 30, paths: ['a', 'b'], ignored: 0 }) });
    assert.ok(out.includes('… and 28 more'));

    out = open({ env: 'TEST', diff: '{not json' });
    assert.ok(!out.includes('File comparison not available') && !out.includes('Diff to TEST</h4>'));
});

test('buildComponentRow: non-version text, no commit URL and no drift', () => {
    const { run, setState } = loadApp();

    setState({ deployments: [dep({ component: 'c', version: 'abc1234', environment: 'test' })] });
    const row = run("buildComponentRow('c', 'test')");

    assert.ok(!row.innerHTML.includes('<a href'));
    assert.ok(!row.innerHTML.includes('drift-note'));
});

test('buildFlagRow shows ON/OFF/missing with runtime-be precedence', () => {
    const { run, setState } = loadApp();

    setState({ flagStates: {
        on: { prod: { build: flagEntry(true) } },
        off: { prod: { build: flagEntry(true), 'runtime-be': flagEntry(false) } },
    } });
    const on = run("buildFlagRow('on', 'prod')");
    const off = run("buildFlagRow('off', 'prod')");
    const missing = run("buildFlagRow('on', 'qa')");
    const unknown = run("buildFlagRow('ghost<b>', 'qa')");

    assert.ok(on.innerHTML.includes('flag-on-text'));
    assert.match(on.title, /^\[build\]/);
    assert.ok(off.innerHTML.includes('flag-off-text'));
    assert.match(off.title, /^\[runtime-be\]/);
    assert.equal(on.dataset.flagKey, 'on');
    assert.ok(missing.innerHTML.includes('flag-missing-text'));
    assert.equal(missing.title, '');
    assert.ok(unknown.innerHTML.includes('ghost&lt;b&gt;'));
});

test('buildEnvCard: empty components show a placeholder, otherwise one row per component and flag', () => {
    const { run, setState } = loadApp();

    setState({ deployments: [dep({ component: 'a', environment: 'test' })], flagStates: {} });
    const empty = run("buildEnvCard('test', 0, [], [])");

    assert.equal(empty.compRows.size, 0);

    const full = run("buildEnvCard('test', 0, ['a', 'b'], [['k1', {}], ['k2', {}]])");

    assert.equal(full.compRows.size, 2);
    assert.equal(full.flagsList.children.length, 2);
});

test('renderMatrix builds three env cards, orders flags and binds hover once', () => {
    const { run, setState, el } = loadApp();

    setState({
        componentsOrder: [{ name: 'b' }, { name: 'a' }],
        deployments: [dep({ component: 'a', environment: 'test' }), dep({ id: 2, component: 'b', environment: 'prod' })],
        flagsMeta: { zeta: {}, alpha: {} },
        flagStates: { alpha: { prod: { build: flagEntry(true) } } },
    });
    run('renderMatrix()');
    const m = el('matrix');

    assert.equal(m.children.length, 3);
    m.children.forEach(card => {
        assert.equal(card.children[0].children.length, 2);
        assert.deepEqual(card.children[2].children.map(r => r.dataset.flagKey), ['alpha', 'zeta']);
        card.children[0].children.forEach(r => assert.equal(r.style.height, '70px'));
    });
    assert.equal(m.dataset.hoverBound, '1');
    assert.equal(m.listeners.mouseover.length, 1);
    run('renderMatrix()');
    assert.equal(m.listeners.mouseover.length, 1);
});

test('renderMatrix with no data renders empty cards', () => {
    const { run, setState, el } = loadApp();

    setState({});
    run('renderMatrix()');
    assert.equal(el('matrix').children.length, 3);
});

test('equalizeComponentRowHeights snaps rows to the tallest and skips single-row components', () => {
    const { run, ctx } = loadApp();
    const mk = h => { const r = new El(); r.height = h; return r; };
    const [a, b, c, solo] = [mk(70), mk(90), mk(80), mk(55)];

    ctx.map = new Map([['x', [a, b, c]], ['y', [solo]]]);
    run('equalizeComponentRowHeights(map)');
    assert.deepEqual([a, b, c].map(r => r.style.height), ['90px', '90px', '90px']);
    assert.equal(solo.style.height, undefined);
});

test('syncFlagsScroll mirrors scrollTop to siblings and ignores re-entrant events', () => {
    const { run, ctx } = loadApp();
    const mk = () => {
        const e = new El();
        let top = 0;

        Object.defineProperty(e, 'scrollTop', { get: () => top, set: v => { top = v; e.sets = (e.sets || 0) + 1; e.fire('scroll'); } });

        return e;
    };
    const [a, b, c] = [mk(), mk(), mk()];

    ctx.list = [a, b, c];
    run('syncFlagsScroll(list)');
    a.scrollTop = 40;
    assert.equal(b.scrollTop, 40);
    assert.equal(c.scrollTop, 40);
    assert.equal(b.sets, 1);
    assert.equal(c.sets, 1);
});

test('bindFlagRowHover highlights the same flag everywhere and ignores other targets', () => {
    const { run, ctx } = loadApp();
    const m = new El();
    const rows = [new El(), new El()];
    let selector = null;

    m.qsa = sel => { selector = sel; return rows; };
    ctx.m = m;
    run('bindFlagRowHover(m)');
    run('bindFlagRowHover(m)');
    assert.equal(m.listeners.mouseover.length, 1);

    const target = new El();

    target.dataset.flagKey = 'k1';
    target.closest = () => target;
    m.fire('mouseover', { target });
    assert.equal(selector, '.flag-row[data-flag-key="k1"]');
    assert.ok(rows.every(r => r.classes.has('flag-row-highlight')));
    m.fire('mouseout', { target });
    assert.ok(rows.every(r => !r.classes.has('flag-row-highlight')));

    selector = null;
    m.fire('mouseover', { target: { closest: () => null } });
    m.fire('mouseover', { target: { closest: () => ({ dataset: {} }) } });
    assert.equal(selector, null);
});

test('joinMeta drops falsy parts, separates the rest and escapes plain strings', () => {
    const { run } = loadApp();
    const out = String(run(`joinMeta([html\`<b>x</b>\`, null, '${EVIL}', '', html\`<i>y</i>\`])`));

    assert.equal(out.split('deploy-meta-dot').length - 1, 2);
    assert.ok(out.includes('&lt;img'));
    assert.equal(String(run('joinMeta([null])')), '');
});

test('renderChipsRow renders issue links and flag badges, or nothing', () => {
    const { run, setState } = loadApp();

    setState({});

    assert.equal(String(run('renderChipsRow([], {})')), '');
    assert.equal(String(run('renderChipsRow()')), '');

    const out = String(run(`renderChipsRow(['A-1', '${EVIL}'], { f1: true, f2: false })`));

    assert.ok(out.includes('browse/A-1"'));
    assert.ok(out.includes('f1: ON'));
    assert.ok(out.includes('f2: OFF'));
    assert.ok(!out.includes(EVIL));
    assert.ok(String(run("renderChipsRow(['A-1'])")).includes('issue-badge'));
    assert.ok(String(run("renderChipsRow(null, { f: true })")).includes('resolved-flag-badge'));
});

test('renderDeployCard: full record escapes hostile fields and merges attached flips', () => {
    const { run, ctx } = loadApp();

    inCtx(ctx, 'd', dep({
        component: EVIL, version: EVIL, deployedBy: EVIL, deployedByLogin: 'l"x', commitUrl: 'https://c/?a=1&b=2', manual: true,
        rollback: { toRef: EVIL }, workflowRunUrl: 'https://r/?x="1"', durationMs: 65000, relatedIssues: ['A-1'], resolvedFlags: { rf: true },
    }));
    const out = String(run("renderDeployCard(d, [{ key: 'flip', enabled: false }])"));

    assert.ok(!out.includes(EVIL));
    assert.ok(out.includes('1m 5s'));
    assert.ok(out.includes('rf: ON') && out.includes('flip: OFF'));
    assert.ok(out.includes('href="https://c/?a=1&amp;b=2"'));
});

test('renderDeployCard: minimal record has no optional badges', () => {
    const { run, ctx } = loadApp();

    inCtx(ctx, 'd', dep({ deployedByLogin: 'Ann' }));
    const out = String(run('renderDeployCard(d)'));

    assert.ok(!out.includes('rollback-badge') && !out.includes('run-badge'));
    assert.ok(!out.includes('deploy-chips'));
});

test('unionChips merges issues and flags across runs including flips', () => {
    const { ev, ctx } = loadApp();

    inCtx(ctx, 'runs', [
        dep({ id: 1, relatedIssues: ['A-1'], resolvedFlags: { f: true } }), dep({ id: 2, relatedIssues: ['A-1', 'A-2'] }), dep({ id: 3 }),
    ]);
    inCtx(ctx, 'flips', { 3: [{ key: 'g', enabled: true }, { key: 'f', enabled: false }] });
    const out = ev('unionChips(runs, flips)');

    assert.deepEqual(out.relatedIssues, ['A-1', 'A-2']);
    assert.equal(out.flagBadges.g, true);
});

test('renderDeployGroupCard: manual badge variants, open list and escaping', () => {
    const { run, ctx } = loadApp();
    const group = manual => ({
        kind: 'deploy-group', component: EVIL, version: EVIL, env: 'prod', key: 'k"1',
        runs: [
            dep({ id: 2, deployedBy: EVIL, deployedByLogin: 'login', manual: manual[0], rollback: { toRef: 'r' }, workflowRunUrl: 'https://w/', commitUrl: 'https://c/', relatedIssues: ['A-1'], durationMs: 5000 }),
            dep({ id: 1, manual: manual[1], deployedAt: ago(5) }),
        ],
    });
    const render = (g, open) => { inCtx(ctx, 'g', g); ctx.open = open; return String(run('renderDeployGroupCard(g, {}, open)')); };

    const all = render(group([true, true]), true);

    assert.ok(all.includes('deploy-group-list') && all.includes('deploy-group-item'));
    assert.ok(all.includes('2 deploys'));
    assert.ok(!all.includes(EVIL));
    assert.ok(all.includes('data-group-key="k&quot;1"'));

    const some = render(group([true, false]), false);

    assert.ok(some.includes('1 of 2'));
    assert.ok(!some.includes('deploy-group-list'));

    const none = render(group([false, false]), false);

    assert.ok(!none.includes('manual-badge'));
});

test('renderFlagAddedCard escapes the key and components', () => {
    const { run, ctx } = loadApp();

    inCtx(ctx, 'f', { key: EVIL, createdAt: ago(0), components: [EVIL, 'c2'] });
    const out = String(run('renderFlagAddedCard(f)'));

    assert.ok(!out.includes(EVIL));
    assert.ok(out.includes('c2'));
    inCtx(ctx, 'f', { key: 'k', createdAt: ago(0) });
    assert.ok(String(run('renderFlagAddedCard(f)')).includes('k'));
});

test('flagAddedEvents / flagChangeEvents / eventMatchesComponent', () => {
    const { ev, setState } = loadApp();

    setState({
        flagsMeta: { a: { createdAt: '2026-01-01', components: ['c'] }, b: {}, c: { createdAt: '2026-02-01' } },
        flagStateHistory: [{ key: 'a', env: 'prod', source: 'build', enabled: 1, changedAt: 't', changedBy: 'u', extra: 1 }],
    });
    assert.equal(ev('flagAddedEvents()').length, 2);
    assert.equal(ev('flagChangeEvents()').length, 1);
    setState({ flagsMeta: undefined, flagStateHistory: undefined });
    assert.deepEqual(ev('flagAddedEvents()'), []);
    assert.deepEqual(ev('flagChangeEvents()'), []);

    assert.equal(ev("eventMatchesComponent({ kind: 'deploy', data: { component: 'x' } }, '')"), true);
    assert.equal(ev("eventMatchesComponent({ kind: 'deploy', data: { component: 'x' } }, 'x')"), true);
    assert.equal(ev("eventMatchesComponent({ kind: 'deploy', data: { component: 'x' } }, 'y')"), false);
    assert.equal(ev("eventMatchesComponent({ kind: 'flag-added', data: { components: ['x'] } }, 'x')"), true);
    assert.equal(ev("eventMatchesComponent({ kind: 'flag-added', data: {} }, 'x')"), false);
});

test('attachFlagFlipsToDeploys attaches flips to nearby matching deploys', () => {
    const { ev, setState } = loadApp();

    setState({
        deployments: [
            dep({ id: 1, component: 'a', deployedAt: ago(0, 5) }), dep({ id: 2, component: 'a', deployedAt: ago(0, 2) }),
            dep({ id: 3, component: 'b', deployedAt: ago(0, 1) }), dep({ id: 4, component: 'a', environment: 'qa', deployedAt: ago(0, 1) }),
        ],
        flagsMeta: { scoped: { components: ['a'] }, anywhere: {} },
        flagStateHistory: [
            { key: 'scoped', env: 'prod', enabled: true, changedAt: ago(0) },
            { key: 'anywhere', env: 'prod', enabled: false, changedAt: ago(0) },
            { key: 'early', env: 'prod', enabled: true, changedAt: ago(0, 30) },
            { key: 'unknownmeta', env: 'qa', enabled: true, changedAt: ago(0) },
        ],
    });
    const out = ev('attachFlagFlipsToDeploys()');

    assert.ok(out && typeof out === 'object');
    assert.ok(Object.keys(out).length >= 2);
});

test('groupConsecutiveDeploys groups same service/version/env on one day and breaks on failures', () => {
    const { ev, ctx } = loadApp();
    const e = (id, o = {}) => ({ kind: 'deploy', at: o.deployedAt || ago(id), data: dep({ id, deployedAt: ago(id), ...o }) });

    inCtx(ctx, 'events', [
        e(1), e(2), e(3, { status: 'failure' }), e(4), e(5, { version: 'v2' }), e(6, { environment: 'qa' }), { kind: 'flag-added', at: ago(7), data: {} },
        e(8, { deployedAt: ago(0, 2) }), e(9, { deployedAt: ago(0, 2) }),
    ]);
    const out = ev('groupConsecutiveDeploys(events)');

    assert.ok(out.some(g => g.kind === 'deploy-group' && g.runs.length === 2));
    assert.ok(out.some(g => g.kind === 'deploy'));
    assert.ok(out.some(g => g.kind === 'flag-added'));
});

test('renderTimeline: empty state', () => {
    const { run, setState, html } = loadApp();

    setState({});
    run('renderTimeline()');
    assert.ok(html('timeline').includes('No activity to show'));
});

test('renderTimeline: day headers, flag-added cards, filters and range cutoff', () => {
    const { run, setState, html, el } = loadApp();

    setState({
        deployments: [
            dep({ id: 1, component: 'a', version: 'v1', deployedAt: ago(1) }), dep({ id: 2, component: 'b', environment: 'qa', version: 'v2', deployedAt: ago(2) }),
            dep({ id: 3, component: 'a', version: 'old', deployedAt: ago(0, 20) }),
        ],
        flagsMeta: { fresh: { createdAt: ago(3), components: ['a'] } },
        flagStateHistory: [{ key: 'fresh', env: 'prod', enabled: true, changedAt: ago(0) }],
    });
    run('renderTimeline()');
    let out = html('timeline');

    assert.ok(out.includes('deploy-item'));
    assert.ok(out.includes('v1') && out.includes('v2') && out.includes('old'));

    el('filterEnv').value = 'qa';
    run('renderTimeline()');
    out = html('timeline');
    assert.ok(out.includes('v2') && !out.includes('>v1<'));

    el('filterEnv').value = '';
    el('filterComponent').value = 'a';
    run('renderTimeline()');
    out = html('timeline');
    assert.ok(out.includes('v1') && !out.includes('>v2<'));

    el('filterComponent').value = '';
    el('filterDeployRange').value = '7';
    run('renderTimeline()');
    out = html('timeline');
    assert.ok(out.includes('v1') && !out.includes('>old<'));
});

test('renderTimeline: multi-run groups toggle open/closed via the button handler', () => {
    const { run, setState, html, el } = loadApp();
    const btn = new El('button');

    setState({ deployments: [
        dep({ id: 1, version: 'v1', deployedAt: ago(1) }), dep({ id: 2, version: 'v1', deployedAt: ago(5) }), dep({ id: 3, version: 'v0', deployedAt: ago(8) }),
    ] });
    el('timeline').qsa = sel => (sel === '.deploy-group-toggle' ? [btn] : []);
    run('renderTimeline()');
    const out = html('timeline');

    assert.ok(out.includes('2 deploys'));
    assert.ok(!out.includes('deploy-group-list'));

    btn.dataset.groupKey = out.match(/data-group-key="([^"]*)"/)[1];
    btn.onclick();
    assert.ok(html('timeline').includes('deploy-group-list'));
    btn.onclick();
    assert.ok(!html('timeline').includes('deploy-group-list'));
});

test('renderTimeline pagination: sentinel appears and resetDeployPagination restores the page size', () => {
    const { run, setState, html } = loadApp();

    setState({ deployments: [dep({ id: 1, version: 'a' }), dep({ id: 2, version: 'b', deployedAt: ago(5) }), dep({ id: 3, version: 'c', deployedAt: ago(10) })] });
    run('visibleDeployCount = 2; renderTimeline()');
    assert.ok(html('timeline').includes('deployLoadMore'));
    run('visibleDeployCount = 99; renderTimeline()');
    assert.ok(!html('timeline').includes('deployLoadMore'));
    run('visibleDeployCount = 1; resetDeployPagination()');
    assert.ok(run('visibleDeployCount') > 1);
});

test('flagBlastRadius lists unfinished keys only when work is mixed', () => {
    const { ev, setState } = loadApp();
    const cat = c => ({ statusCategory: c });

    setState({ issueStatusIndex: { 'A-1': cat('done'), 'A-2': cat('indeterminate'), 'A-3': cat('new') } });
    assert.deepEqual(ev("flagBlastRadius({ jiraKeys: ['A-1', 'A-2', 'A-3'] })"), ['A-2', 'A-3']);
    assert.equal(ev("flagBlastRadius({ jiraKeys: ['A-1'] })"), null);
    assert.equal(ev('flagBlastRadius({})'), null);
    assert.equal(ev("flagBlastRadius({ jiraKeys: ['A-2', 'A-3'] })"), null);
});

test('flagStaleWarning requires every linked issue Done and a long-ON flag', () => {
    const { ev, setState } = loadApp();
    const done = { statusCategory: 'done' };

    setState({
        issueStatusIndex: { 'A-1': done, 'A-2': done, 'A-3': { statusCategory: 'new' } },
        flagStates: {
            old: { prod: { build: flagEntry(true, ago(0, 100)) }, qa: { build: flagEntry(true, ago(0, 70)) } },
            recent: { prod: { build: flagEntry(true, ago(0, 10)) } },
            off: { prod: { build: flagEntry(false, ago(0, 100)) } },
        },
    });
    const w = ev("flagStaleWarning({ jiraKeys: ['A-1', 'A-2'] }, 'old')");

    assert.equal(w.env, 'prod');
    assert.equal(w.days, 100);
    assert.equal(ev("flagStaleWarning({ jiraKeys: ['A-1'] }, 'recent')"), null);
    assert.equal(ev("flagStaleWarning({ jiraKeys: ['A-1'] }, 'off')"), null);
    assert.equal(ev("flagStaleWarning({ jiraKeys: ['A-1'] }, 'nostate')"), null);
    assert.equal(ev("flagStaleWarning({ jiraKeys: ['A-1', 'A-3'] }, 'old')"), null);
    assert.equal(ev("flagStaleWarning({}, 'old')"), null);
});

test('renderFlags: empty states and source filter', () => {
    const { run, setState, html, el } = loadApp();

    setState({});
    run('renderFlags()');
    assert.ok(html('flags').includes('No flags defined'));

    setState({ flagsMeta: { k: { source: 'build' } } });
    el('filterFlagSource').value = 'runtime-be';
    run('renderFlags()');
    assert.ok(html('flags').includes('No flags match this filter'));
    el('filterFlagSource').value = 'build';
    run('renderFlags()');
    assert.ok(html('flags').includes("ff-row"));
});

test('renderFlags: full cards with blast radius, divergence, stale and escaping', () => {
    const { run, setState, html, el } = loadApp();

    setState({
        issueStatusIndex: { 'D-1': { statusCategory: 'done' }, 'D-2': { statusCategory: 'done' }, 'W-1': { statusCategory: 'new' } },
        flagsMeta: {
            [EVIL]: { source: 'runtime-be', description: EVIL, jiraKeys: ['D-1', 'D-2'], components: [EVIL], createdAt: ago(0, 3) },
            blast: { source: 'build', description: 'b', jiraKeys: ['D-1', 'W-1'] },
            bare: { source: 'build' },
        },
        flagStates: {
            [EVIL]: { prod: { build: flagEntry(true, ago(0, 90)), 'runtime-be': flagEntry(false, ago(0, 90)) } },
            blast: { test: { build: flagEntry(true) } },
        },
    });
    run('renderFlags()');
    const out = html('flags');

    assert.ok(!out.includes(EVIL));
    assert.equal(out.split('class="ff-row"').length - 1, 3);
    assert.ok(out.includes('W-1'));
    assert.ok(el('flagsDivergeNote').textContent.includes('diverge'));

    setState({
        issueStatusIndex: { 'D-1': { statusCategory: 'done' } },
        flagsMeta: { s: { source: 'build', jiraKeys: ['D-1'] }, t: {}, u: {} },
        flagStates: { s: { prod: { build: flagEntry(true, ago(0, 90)) } }, t: { qa: { build: flagEntry(false), 'runtime-be': flagEntry(true) } }, u: { qa: { build: flagEntry(true), 'runtime-be': flagEntry(false) } } },
    });
    run('renderFlags()');
    assert.ok(html('flags').includes('stale') || html('flags').includes('Stale'));
    assert.ok(el('flagsDivergeNote').textContent.startsWith('2'));
});

test('renderFlags: sticky-header columns, ON/OFF pills, details drawer and none-badges', () => {
    const { run, setState, html } = loadApp();

    setState({
        flagsMeta: {
            full: { source: 'build', description: 'does things', jiraKeys: ['D-1'], components: ['svc-a', 'svc-b'], createdAt: ago(0, 3) },
            bare: { source: 'runtime-be' },
        },
        flagStates: { full: { test: { build: flagEntry(true) }, qa: { build: flagEntry(false) } } },
    });
    run('openFlagDetails.clear()');
    run('renderFlags()');

    const out = html('flags');

    assert.ok(out.includes('class="ff-cols"'));
    assert.ok(['Flag', 'TEST', 'QA', 'PROD'].every(c => out.includes(`<span>${c}</span>`)));
    assert.ok(out.includes('Build-time (FE)') && out.includes('Runtime (BE)'));
    assert.ok(out.includes('flag-row-state flag-on-text'));
    assert.ok(out.includes('flag-row-state flag-off-text'));
    assert.ok(out.includes('flag-row-state flag-missing-text'));
    assert.ok(out.includes('does things') && out.includes('svc-a, svc-b'));
    assert.ok(out.includes('Not linked') && out.includes('Not used in any component'));
    assert.ok(out.includes('No description provided'));
    // closed by default
    assert.equal(out.split('aria-expanded="false"').length - 1, 2);
    assert.ok(!out.includes('aria-expanded="true"'));

    // an open drawer survives a re-render
    run("openFlagDetails.add('full')");
    run('renderFlags()');

    const reopened = html('flags');

    assert.equal(reopened.split('aria-expanded="true"').length - 1, 1);
    assert.equal(reopened.split('aria-expanded="false"').length - 1, 1);
});

test('renderSummaryCards: Stale flags card counts cleanup candidates', () => {
    const { run, setState, html } = loadApp();

    setState({
        deployments: [],
        issueStatusIndex: { 'D-1': { statusCategory: 'done' }, 'W-1': { statusCategory: 'new' } },
        flagsMeta: { old: { source: 'build', jiraKeys: ['D-1'] }, fresh: { source: 'build', jiraKeys: ['D-1'] }, open: { source: 'build', jiraKeys: ['W-1'] } },
        flagStates: {
            old: { prod: { build: flagEntry(true, ago(0, 90)) } },
            fresh: { prod: { build: flagEntry(true, ago(0, 1)) } },
            open: { prod: { build: flagEntry(true, ago(0, 90)) } },
        },
    });
    run('renderSummaryCards()');

    const out = html('summaryGrid');

    assert.ok(out.includes('Stale flags'));
    assert.match(out, /Stale flags<\/div>\s*<div class="summary-value">1 /);

    setState({ deployments: [], issueStatusIndex: {}, flagsMeta: {}, flagStates: {} });
    run('renderSummaryCards()');
    assert.ok(html('summaryGrid').includes('no cleanup candidates'));
});

test('openDriftModal: shows the file diff first and the raw history counts separately', () => {
    const { run, el } = loadApp();

    el('driftModal').showModal = () => {};
    run("openDriftModal({ env: 'TEST', behind: '2', skipped: '4', diff: JSON.stringify({ files: 2, paths: ['x', 'y'], ignored: 0 }) })");

    const out = String(el('driftModal').innerHTML);

    assert.ok(out.indexOf('2 files differ') < out.indexOf('Git history'));
    assert.ok(out.includes('2 commit(s) on TEST'));
    assert.ok(out.includes('4 commit(s) here'));
});
