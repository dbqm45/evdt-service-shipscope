// Unit + render tests for docs/app-product.js, run in a vm with a small functional stub DOM and a
// frozen clock (FakeDate) so nothing depends on wall-clock time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', 'docs');
const FILES = ['app-html', 'app-core', 'app-components', 'app-data', 'app-model', 'app-product', 'app-technical', 'app-release-notes', 'app-insights'];
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
        issueDeployments: {}, issueStatusIndex: {}, componentsOrder: [], summary: null, jiraIndex: null, ...o,
    })}`);

    return { ctx, el, ev, run, setState, html: id => String(els[id].innerHTML) };
}

const dep = (o = {}) => ({ id: 1, component: 'svc', environment: 'prod', status: 'success', version: 'v1.0.0', deployedAt: ago(0), ...o });
const flagEntry = (enabled, changedAt = ago(0)) => ({ enabled, changedAt, changedBy: 'bot' });
const issue = (key, o = {}) => ({ key, type: 'Story', title: `T ${key}`, pi: 'PI-27.3', sprint: 'Sparks 27.3.1', priority: 'Major', status: 'In Progress', statusCategory: 'indeterminate', ...o });
const idx = (sprints, currentPi = 'PI-27.3') => ({ currentPi, pis: [{ pi: 'PI-27.3', file: 'x.json', sprints }] });
const inCtx = (ctx, name, value) => vm.runInContext(`${name} = ${JSON.stringify(value)}`, ctx);

// Fixture: A-1 released on prod (flag on), A-2 deployed w/ flag off for 40 days (ghost), A-3 code only, A-4 untouched.
function mixedState(extra = {}) {
    return {
        jiraIndex: idx([{ name: 'Sparks 27.3.1', startDate: ago(0, 20), endDate: ago(0, 5) }, { name: 'Sparks 27.3.2', startDate: ago(0, 4), endDate: ago(0, -10) }, { name: 'Old 27.3.0', startDate: null, endDate: null }]),
        jiraIssues: [
            issue('A-1', { sprint: 'Sparks 27.3.2' }), issue('A-2', { type: 'Bug', priority: 'Blocker' }),
            issue('A-3', { type: 'Task', sprint: 'Sparks 27.3.2', priority: 'Minor' }), issue('A-4', { sprint: 'Sparks 27.3.2' }),
        ],
        flagsMeta: { f1: { jiraKeys: ['A-1'], components: ['svc'] }, f2: { jiraKeys: ['A-2'], components: ['svc'] } },
        flagStates: { f1: { prod: { build: flagEntry(true) } }, f2: { prod: { build: flagEntry(false, ago(0, 40)) } } },
        deployments: [dep({ relatedIssues: ['A-1', 'A-3'], deployedAt: ago(0, 1) }), dep({ id: 2, relatedIssues: ['A-2'], deployedAt: ago(0, 40) })],
        ...extra,
    };
}

test('renderProductSummary: empty state', () => {
    const { run, setState, html } = loadApp();

    setState({});
    run('renderProductSummary()');
    const out = html('pvSummary');

    assert.ok(out.includes('0/0'));
    assert.ok(out.includes('<b>0</b> items'));
    assert.ok(!out.includes('pv-pi-bar-seg'));
    assert.ok(!out.includes('current PI'));
});

test('renderProductSummary: counts, current tag, active tile and hostile PI', () => {
    const { run, setState, html } = loadApp();

    setState(mixedState());
    run('renderProductSummary()');
    let out = html('pvSummary');

    assert.ok(out.includes('current PI'));
    assert.ok(out.includes('pv-pi-bar-seg'));
    assert.ok(out.includes('3/4'));
    assert.equal(out.split('data-tile-key').length - 1, 4);
    assert.ok(out.includes('25% of items'));


    setState({ selectedPi: EVIL, jiraIssues: [issue('B-1')], jiraIndex: null });
    run('renderProductSummary()');
    out = html('pvSummary');
    assert.ok(!out.includes(EVIL));
    assert.ok(out.includes('1</b> item<'));
    assert.ok(!out.includes('current PI'));
});

test('renderProductSummary with no PI selected shows a dash', () => {
    const { run, setState, html } = loadApp();

    setState({ selectedPi: null });
    run('renderProductSummary()');
    assert.ok(html('pvSummary').includes('—'));
});

function filters(el, o = {}) {
    el('filterType').value = o.type || '';
    el('filterPriority').value = o.priority || '';
    el('filterHideTasks').checked = !!o.hideTasks;
    el('filterFrom').value = o.from || '';
    el('filterTo').value = o.to || '';
}

test('selectProductIssues: no filters returns everything and groups epic children', () => {
    const { run, ev, setState, el } = loadApp();

    setState(mixedState({ jiraIssues: [issue('E-1', { type: 'Epic', epicKey: null }), issue('A-1', { epicKey: 'E-1' }), issue('A-2'), issue('A-3', { type: 'Epic', epicKey: 'E-1' })] }));
    filters(el);
    const r = run('selectProductIssues()');

    assert.equal(r.allIssues.length, 4);
    assert.equal(r.showSprintBadge, true);
    assert.equal(r.rollupChildrenByEpicKey.get('E-1').length, 1);
    assert.equal(r.rollupChildrenByEpicKey.size, 1);
});

test('selectProductIssues: type, priority, hide-tasks and status tile filters', () => {
    const { run, ev, setState, el } = loadApp();

    setState(mixedState());
    filters(el, { type: 'Bug' });
    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key)'), ['A-2']);
    filters(el, { priority: 'Minor' });
    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key)'), ['A-3']);
    filters(el, { hideTasks: true });
    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key)'), ['A-1', 'A-2', 'A-4']);
    filters(el);
});

test('selectProductIssues: date range uses last environment change', () => {
    const { run, ev, setState, el } = loadApp();

    setState(mixedState());
    // A-1: flag flipped now, A-3: deployed 1 day ago, A-2 40 days ago, A-4 never
    filters(el, { from: '2026-10-01' });
    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key)'), ["A-1", "A-3"]);
    filters(el, { to: '2026-09-01' });
    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key).sort()'), ['A-2', 'A-4']);
    filters(el, { from: '2026-08-01', to: '2026-10-08' });
    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key).sort()'), ['A-2', 'A-3']);
    filters(el, { from: '2026-08-01', to: '2026-10-10' });
    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key).sort()'), ['A-1', 'A-2', 'A-3']);
});

test('selectProductIssues: sprint scope and badge visibility', () => {
    const { run, ev, setState, el } = loadApp();

    setState(mixedState({ selectedSprint: 'Sparks 27.3.2' }));
    filters(el);
    let r = run('selectProductIssues()');

    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key)'), ['A-1', 'A-3', 'A-4']);
    assert.equal(r.showSprintBadge, false);

    setState(mixedState({ selectedSprint: '__current_plus_unresolved__' }));
    r = run('selectProductIssues()');
    assert.equal(r.showSprintBadge, true);
    assert.deepEqual(ev('selectProductIssues().allIssues.map(i => i.key).sort()'), ['A-1', 'A-2', 'A-3', 'A-4']);
});

test('issueBreakdownHtml: table for linked issues, hint text when unlinked, dependency row', () => {
    const { run, setState, ctx } = loadApp();

    setState(mixedState());
    inCtx(ctx, 'i1', issue('A-1'));
    const linked = String(run('issueBreakdownHtml(i1)'));

    assert.ok(linked.includes('breakdown-table'));
    assert.ok(linked.includes('dot-yes'));
    assert.ok(linked.includes('dot-no'));
    assert.ok(linked.includes('referencing A-1'));
    assert.ok(!linked.includes('Blocking dependency'));

    inCtx(ctx, 'i3', issue('A-9'));
    assert.ok(String(run('issueBreakdownHtml(i3)')).includes('check flags-meta.json'));

    setState({ deployments: [dep({ relatedIssues: ['C-1'] })] });
    inCtx(ctx, 'ic', issue('C-1'));
    assert.ok(String(run('issueBreakdownHtml(ic)')).includes('code found in deployment history'));

    inCtx(ctx, 'idp', issue('D-1', { dependencyBlocked: true, dependencyNote: EVIL }));
    let out = String(run('issueBreakdownHtml(idp)'));

    assert.ok(out.includes('Blocking dependency'));
    assert.ok(!out.includes(EVIL));
    inCtx(ctx, 'idp', issue('D-1', { dependencyBlocked: true }));
    out = String(run('issueBreakdownHtml(idp)'));
    assert.ok(out.includes('unresolved'));
});

test('issueRowHtml: standard row, ghost flag, badges, hostile fields and expansion', () => {
    const { run, setState, ctx } = loadApp();

    setState(mixedState({ issueStatusIndex: { 'A-2': { pi: 'PI-27.4', statusCategory: 'new' } } }));
    inCtx(ctx, 'ghost', issue('A-2', { type: 'Bug', projectName: EVIL, sprint: EVIL, status: EVIL, subtasks: { done: 1, total: 3 }, title: EVIL, impediment: true }));
    const g = String(run('issueRowHtml(ghost, true, true)'));

    assert.ok(g.includes('wi-child-row'));
    assert.ok(g.includes('tag-ghost-flag'));
    assert.ok(g.includes('Prod 40d'));
    assert.ok(g.includes('Jira project'));
    assert.ok(g.includes('sprint-tag'));
    assert.ok(g.includes('Continued in PI-27.4'));
    assert.ok(!g.includes(EVIL));
    assert.ok(!g.includes('breakdown-table'));

    inCtx(ctx, 'plain', issue('A-4', { title: '—' }));
    const p = String(run('issueRowHtml(plain, false, false)'));

    assert.ok(p.includes('wi-ungrouped-row'));
    assert.ok(p.includes('title unavailable'));
    assert.ok(!p.includes('sprint-tag'));
    assert.ok(!p.includes('tag-ghost-flag'));

    run("expandedIssue = 'A-1'");
    inCtx(ctx, 'rel', issue('A-1'));
    assert.ok(String(run('issueRowHtml(rel, true, true)')).includes('breakdown-table'));
    run('expandedIssue = null');
});

test('issueRowHtml: dependency-blocked prod cell', () => {
    const { run, setState, ctx } = loadApp();

    setState(mixedState());
    inCtx(ctx, 'b', issue('A-2', { dependencyBlocked: true, dependencyNote: EVIL }));
    let out = String(run('issueRowHtml(b, true, true)'));

    if (out.includes('st-dependency')) {
        assert.ok(!out.includes(EVIL));
    }

    setState({ flagsMeta: { f: { jiraKeys: ['B-1'], components: ['svc'] } }, flagStates: { f: { prod: { build: flagEntry(true) } } }, deployments: [dep({ relatedIssues: ['B-1'] })] });
    inCtx(ctx, 'b', issue('B-1', { dependencyBlocked: true, dependencyNote: EVIL }));
    out = String(run('issueRowHtml(b, true, true)'));
    assert.ok(out.includes('Dependency'));
    assert.ok(!out.includes(EVIL));
    inCtx(ctx, 'b', issue('B-1', { dependencyBlocked: true }));
    assert.ok(String(run('issueRowHtml(b, true, true)')).includes('blocked by a dependency'));
});

test('epicHeaderHtml: fully released, open bug, ghost flags, empty and collapsed variants', () => {
    const { run, setState, ctx } = loadApp();

    setState(mixedState());
    const call = (group, children, sprint = true) => {
        inCtx(ctx, 'grp', group);
        inCtx(ctx, 'kids', children);

        return String(run(`epicHeaderHtml(grp, kids, ${sprint})`));
    };
    const rel = issue('A-1');
    const full = call({ epicKey: 'E-1', epicTitle: EVIL, epicIssue: issue('E-1', { type: 'Epic', sprint: EVIL, subtasks: { done: 2, total: 2 } }), children: [rel] }, [rel]);

    assert.ok(full.includes('Fully released'));
    assert.ok(full.includes('1/1'));
    assert.ok(full.includes('wi-epic-bar-released'));
    assert.ok(!full.includes('<b style'));
    assert.ok(full.includes('sprint-tag'));
    assert.ok(!full.includes(EVIL));
    assert.ok(full.includes('wi-epic-chevron open'));

    const ghost = issue('A-2', { type: 'Bug' });
    const mixed = call({ epicKey: 'E-2', epicTitle: null, epicIssue: null, children: [rel, ghost] }, [rel, ghost], false);

    assert.ok(mixed.includes('Open bug'));
    assert.ok(mixed.includes('1 ghost flag<'));
    assert.ok(!mixed.includes('Fully released'));
    assert.ok(!mixed.includes('sprint-tag'));
    assert.ok(mixed.includes('>E-2</a>'));

    const none = call({ epicKey: 'E-3', epicTitle: 'x', epicIssue: null, children: [issue('A-4')] }, [issue('A-4')]);

    assert.ok(none.includes('0/1'));
    assert.ok(none.includes('width:0.0%'));

    const empty = call({ epicKey: 'E-4', epicTitle: 'x', epicIssue: null, children: [] }, []);

    assert.ok(empty.includes('wi-epic-row-empty'));
    assert.ok(empty.includes('No linked work items'));
    assert.ok(empty.includes('<div class="wi-epic-progress"></div>'));

    run("collapsedEpics.add('E-1')");
    const collapsed = call({ epicKey: 'E-1', epicTitle: 't', epicIssue: null, children: [rel] }, [rel]);

    assert.ok(!collapsed.includes('wi-epic-chevron open'));

    const twoGhosts = call({ epicKey: 'E-5', epicTitle: 't', epicIssue: null, children: [ghost] }, [ghost, issue('A-2', { key: 'A-2' })]);

    assert.ok(twoGhosts.includes('2 ghost flags'));
});

test('renderIssues: empty state toggles the empty class', () => {
    const { run, setState, el, html } = loadApp();

    setState({});
    filters(el);
    run('renderIssues()');
    assert.ok(html('issueBody').includes('No results for the selected filters'));
    assert.ok(el('productPanelBody').classes.has('wi-body-empty'));
    assert.ok(html('issueCount').includes('0</span> items'));
});

test('renderIssues: epic groups, ungrouped section, collapse and pagination sentinel', () => {
    const { run, setState, el, html } = loadApp();

    setState(mixedState({ jiraIssues: [
        issue('E-1', { type: 'Epic', epicKey: null, sprint: null }), issue('A-1', { epicKey: 'E-1', title: EVIL }), issue('A-2', { type: 'Bug', epicKey: 'E-1' }), issue('A-3'),
    ] }));
    filters(el);
    run('renderIssues()');
    let out = html('issueBody');

    assert.ok(el('productPanelBody').classes.has('wi-body-empty') === false);
    assert.ok(out.includes('wi-epic-row'));
    assert.ok(out.includes('Ungrouped'));
    assert.ok(!out.includes(EVIL));
    assert.ok(!out.includes('issueLoadMore'));
    assert.ok(html('issueCount').includes('4</span> items'));

    run("collapsedEpics.add('E-1'); renderIssues()");
    out = html('issueBody');
    assert.ok(!out.includes('data-key="A-1"'));
    run('collapsedEpics.clear()');

    run('visibleIssueCount = 2; renderIssues()');
    assert.ok(html('issueBody').includes('issueLoadMore'));
    run('visibleIssueCount = 100');
});

test('renderIssues: single item uses singular count', () => {
    const { run, setState, el, html } = loadApp();

    setState({ jiraIssues: [issue('A-1')] });
    filters(el);
    run('renderIssues()');
    assert.ok(html('issueCount').includes('1</span> item<') || html('issueCount').endsWith('item'));
});

test('bindIssueRowHandlers: row click toggles expansion, epic click toggles collapse', () => {
    const { run, setState, el, html, ctx } = loadApp();

    setState(mixedState({ jiraIssues: [issue('E-1', { type: 'Epic', epicKey: null }), issue('A-1', { epicKey: 'E-1' })] }));
    filters(el);

    const rowEl = new El();
    const epicEl = new El();

    rowEl.dataset.key = 'A-1';
    epicEl.dataset.epicKey = 'E-1';
    el('issueBody').qsa = sel => (sel.startsWith('.wi-child-row') ? [rowEl] : sel.startsWith('.wi-epic-row') ? [epicEl] : []);
    run('renderIssues()');

    rowEl.onclick();
    assert.equal(run('expandedIssue'), 'A-1');
    assert.ok(html('issueBody').includes('breakdown-table'));
    rowEl.onclick();
    assert.equal(run('expandedIssue'), null);

    epicEl.onclick();
    assert.ok(run("collapsedEpics.has('E-1')"));
    assert.ok(!html('issueBody').includes('data-key="A-1"'));
    epicEl.onclick();
    assert.ok(!run("collapsedEpics.has('E-1')"));
    assert.ok(ctx);
});

test('resetIssuePagination restores the page size and re-renders', () => {
    const { run, setState, el, html } = loadApp();

    setState({});
    filters(el);
    run('visibleIssueCount = 1; resetIssuePagination()');
    assert.ok(run('visibleIssueCount') >= 1);
    assert.ok(html('issueBody').includes('No results'));
});

function withOptionQsa(container) {
    container.qsa = sel => {
        if (sel.includes('segmented-btn')) return container.children.filter(c => c.dataset.value !== '' && c.dataset.value !== undefined);
        if (sel.includes('option')) return container.children.filter(c => c.value !== '');

        return [];
    };

    return container;
}

test('refreshSprintSelect: no sprint data disables the select', () => {
    const { run, ev, setState, el } = loadApp();

    setState({ jiraIndex: null, selectedSprint: 'stale' });
    run('refreshSprintSelect()');
    const sel = el('filterSprint');

    assert.equal(sel.disabled, true);
    assert.equal(sel.title, 'No sprint data for this PI');
    assert.ok(sel.innerHTML.includes('All sprints'));
    assert.equal(run('state.selectedSprint'), '');
});

test('refreshSprintSelect: current sprint, hybrid option and remaining sprints in order', () => {
    const { run, ev, setState, el } = loadApp();

    setState(mixedState());
    run('refreshSprintSelect()');
    const sel = el('filterSprint');
    const texts = sel.children.map(c => c.textContent);

    assert.equal(sel.disabled, false);
    assert.deepEqual(texts, ['All sprints', 'Current sprint (Sparks 27.3.2)', 'Current sprint + unresolved', 'Sparks 27.3.1', 'Old 27.3.0']);
    assert.equal(run('state.selectedSprint'), 'Sparks 27.3.2');
    assert.equal(sel.value, 'Sparks 27.3.2');
});

test('refreshSprintSelect: past PI has no current sprint and no hybrid option', () => {
    const { run, ev, setState, el } = loadApp();

    setState(mixedState({ jiraIndex: idx([{ name: 'Sparks 27.3.1', startDate: ago(0, 20), endDate: ago(0, 5) }], 'PI-27.4') }));
    run('refreshSprintSelect()');
    assert.deepEqual(el('filterSprint').children.map(c => c.textContent), ['All sprints', 'Sparks 27.3.1']);
    assert.equal(run('state.selectedSprint'), '');
});

test('refreshProductViewFilterOptions rebuilds type buttons and priority options in rank order', () => {
    const { run, ev, setState, el } = loadApp();
    const typeGroup = withOptionQsa(el('filterTypeGroup'));
    const prio = withOptionQsa(el('filterPriority'));
    const all = new El('button');

    all.dataset.value = '';
    typeGroup.appendChild(all);
    const stale = new El('button');

    stale.dataset.value = 'Stale';
    typeGroup.appendChild(stale);

    setState({ jiraIssues: [issue('1', { type: 'Task', priority: 'Minor' }), issue('2', { type: 'Bug', priority: 'Blocker' }), issue('3', { type: 'Epic', priority: null }), issue('4', { type: 'Story', priority: 'Blocker' })] });
    run('refreshProductViewFilterOptions()');

    assert.deepEqual(typeGroup.children.map(c => c.dataset.value), ['', 'Epic', 'Bug', 'Story', 'Task']);
    assert.ok(typeGroup.children.slice(1).every(c => c.className === 'segmented-btn' && c.type === 'button'));
    assert.deepEqual(prio.children.map(c => c.value), ['Blocker', 'Minor']);
});

test('initProductView wires sprint, type, priority, hide-tasks, dates, clear and scroll handlers', () => {
    const { run, setState, el, html } = loadApp();
    const typeGroup = withOptionQsa(el('filterTypeGroup'));
    const allBtn = new El('button');
    const bugBtn = new El('button');

    allBtn.dataset.value = '';
    allBtn.classList.add('active');
    bugBtn.dataset.value = 'Bug';
    typeGroup.children.push(allBtn, bugBtn);
    typeGroup.qsa = sel => (sel === '.segmented-btn[data-value=""]' ? [allBtn] : sel === '.segmented-btn' ? [allBtn, bugBtn] : []);

    setState(mixedState());
    filters(el);
    run('initProductView()');

    // sprint change
    el('filterSprint').value = 'Sparks 27.3.2';
    el('filterSprint').fire('change');
    assert.equal(run('state.selectedSprint'), 'Sparks 27.3.2');
    assert.ok(html('pvSummary').includes('pv-pi-card'));

    // type click: ignore non-button, then pick Bug
    typeGroup.fire('click', { target: { closest: () => null } });
    assert.equal(el('filterType').value, '');
    typeGroup.fire('click', { target: { closest: () => bugBtn } });
    assert.equal(el('filterType').value, 'Bug');
    assert.ok(bugBtn.classes.has('active') && !allBtn.classes.has('active'));

    // other listeners re-render
    run('state.selectedSprint = ""');
    el('filterType').value = '';
    el('filterPriority').fire('input');
    el('filterHideTasks').fire('change');
    el('filterFrom').fire('input');
    el('filterTo').fire('input');
    assert.ok(html('issueCount').includes('4</span> items'));

    // clear
    el('filterType').value = 'Bug';
    el('filterPriority').value = 'Major';
    el('filterFrom').value = 'x';
    el('filterTo').value = 'y';
    el('filterHideTasks').checked = true;
    el('btnClearFilters').onclick();
    assert.equal(el('filterType').value, '');
    assert.equal(el('filterPriority').value, '');
    assert.equal(el('filterFrom').value, '');
    assert.equal(el('filterTo').value, '');
    assert.equal(el('filterHideTasks').checked, false);
    assert.ok(allBtn.classes.has('active') && !bugBtn.classes.has('active'));

    // infinite scroll
    const panel = el('productPanelBody');

    run('visibleIssueCount = 20');
    panel.scrollTop = 10;
    panel.clientHeight = 100;
    panel.scrollHeight = 1000;
    panel.fire('scroll');
    assert.equal(run('visibleIssueCount'), 20);
    panel.scrollTop = 900;
    panel.fire('scroll');
    assert.ok(run('visibleIssueCount') > 20);
    assert.equal(panel.scrollTop, 900);
});

test('refreshReleaseNotesFilterOptions builds application and type options from real-PI issues', () => {
    const { run, ev, setState, el } = loadApp();
    const appSel = withOptionQsa(el('filterNotesApp'));
    const typeGroup = withOptionQsa(el('filterNotesTypeGroup'));
    const stale = new El('option');

    stale.value = 'old';
    appSel.appendChild(stale);

    setState({
        componentsOrder: [{ name: 'fe', application: ['EBO'] }, { name: 'be', application: ['EVP'] }],
        flagsMeta: { f: { jiraKeys: ['A-1'], components: ['fe'] } },
        deployments: [dep({ component: 'be', relatedIssues: ['A-2'] })],
        jiraIssues: [issue('A-1', { type: 'Task' }), issue('A-2', { type: 'Bug' }), issue('A-3', { pi: '—' }), issue('A-4', { type: 'Story' })],
    });
    run('refreshReleaseNotesFilterOptions()');
    assert.deepEqual(appSel.children.map(c => c.value), ['EBO', 'EVP', 'Unassigned']);
    assert.deepEqual(typeGroup.children.map(c => c.dataset.value), ['Bug', 'Story', 'Task']);
});

test('initReleaseNotesFilters wires type clicks, app input and clear', () => {
    const { run, setState, el, html } = loadApp();
    const typeGroup = withOptionQsa(el('filterNotesTypeGroup'));
    const allBtn = new El('button');
    const bugBtn = new El('button');

    allBtn.dataset.value = '';
    bugBtn.dataset.value = 'Bug';
    typeGroup.children.push(allBtn, bugBtn);
    typeGroup.qsa = sel => (sel === '.segmented-btn[data-value=""]' ? [allBtn] : sel === '.segmented-btn' ? [allBtn, bugBtn] : []);

    setState(mixedState());
    run('initReleaseNotesFilters()');

    typeGroup.fire('click', { target: { closest: () => null } });
    assert.equal(el('filterNotesType').value, '');
    typeGroup.fire('click', { target: { closest: () => bugBtn } });
    assert.equal(el('filterNotesType').value, 'Bug');
    assert.ok(bugBtn.classes.has('active'));
    assert.ok(html('releaseNotesCount').includes('pv-count-num'));

    el('filterNotesApp').value = 'svc';
    el('filterNotesApp').fire('input');
    el('btnClearNotesFilters').onclick();
    assert.equal(el('filterNotesApp').value, '');
    assert.equal(el('filterNotesType').value, '');
    assert.ok(allBtn.classes.has('active') && !bugBtn.classes.has('active'));
});
