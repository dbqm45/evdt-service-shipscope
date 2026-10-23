// Tests docs/app-main.js (init, tab switching, global PI select, sprint defaults, fallback) by loading the
// whole app into a vm with a recording stub DOM, a fake clock and a mocked fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const vm = require('node:vm');

const NOW = new Date('2026-10-09T12:00:00Z').getTime();
const FILES = ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model', 'app-product', 'app-technical', 'app-technical-matrix', 'app-technical-timeline', 'app-technical-flags', 'app-release-notes', 'app-insights', 'app-main'];
const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(r => setImmediate(r)); } };
const plain = v => JSON.parse(JSON.stringify(v));

function stubElement(extra = {}) {
    const classes = new Set();
    const el = {
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; on ? classes.add(c) : classes.delete(c); return on; } },
        style: {}, dataset: {}, attrs: {}, children: [], listeners: {}, textContent: '', value: '', title: '',
        scrollTop: 0, clientHeight: 0, scrollHeight: 0, removed: false,
        addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
        appendChild(c) { el.children.push(c); },
        getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; }, setAttribute(k, v) { el.attrs[k] = v; },
        getBoundingClientRect: () => ({ height: 70 }), querySelector: () => stubElement(), querySelectorAll: () => [],
        remove() { el.removed = true; }, click() { if (el.onclick) el.onclick({ target: el }); },
        ...extra,
    };
    let inner = '';

    Object.defineProperty(el, 'innerHTML', { get: () => inner, set: v => { inner = v; el.children.length = 0; }, enumerable: true });

    return el;
}

function loadApp({ fetchImpl, search = '', pathname = '/', patch = s => s, tabs = ['tech', 'product', 'notes', 'insights'] } = {}) {
    const boxes = {};
    const created = [];
    const tabEls = tabs.map(v => stubElement({ dataset: { view: v } }));
    const viewEls = tabs.map(v => stubElement({ dataset: { view: v } }));
    const byView = Object.fromEntries(tabs.map((v, i) => [v, tabEls[i]]));
    tabs.forEach((v, i) => { boxes['view-' + v] = viewEls[i]; });
    let stored = {};
    class FakeDate extends Date {
        constructor(...a) { if (a.length) { super(...a); } else { super(NOW); } }
        static now() { return NOW; }
    }
    const ctx = {
        console, URLSearchParams, Math, Map, Set, Promise, Date: FakeDate, location: { search, pathname },
        CSS: { escape: s => s },
        localStorage: { getItem: () => null, setItem(k, v) { stored[k] = v; } },
        fetch: fetchImpl || (() => Promise.reject(new Error('offline'))),
        document: {
            documentElement: stubElement(), body: stubElement(), listeners: [], addEventListener(type, fn, capture) { ctx.document.listeners.push({ type, fn, capture: !!capture }); },
            getElementById: id => boxes[id] || (boxes[id] = stubElement()),
            createElement: () => { const el = stubElement(); created.push(el); return el; },
            querySelectorAll: sel => (sel === '.tab' ? tabEls.filter(t => !t.removed) : sel === '.view' ? viewEls : []),
            querySelector: sel => { const m = /^\.tab\[data-view="(\w+)"\]$/.exec(sel); return m ? byView[m[1]] : stubElement(); },
        },
    };

    vm.createContext(ctx);
    FILES.forEach(f => {
        const file = path.join(__dirname, '..', 'docs', `${f}.js`);

        vm.runInContext(patch(fs.readFileSync(file, 'utf8')), ctx, { filename: url.pathToFileURL(file).href });
    });

    const run = code => vm.runInContext(code, ctx);

    return { ctx, boxes, created, tabEls, viewEls, byView, run, stored: () => stored };
}

const jsonRes = (body, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });

// A workspace's dashboard served by the ShipScope server: data from its API.
const TENANT = '0b0e4c3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d';
const API_PATH = `/t/${TENANT}/`;
const DATA_URL = `/api/tenants/${TENANT}/dashboard-data`;
const issuesUrl = pi => `/api/tenants/${TENANT}/jira-issues?pi=${encodeURIComponent(pi)}`;

function liveRoutes({ jiraIndex } = {}) {
    const sprints = [{ name: 'Sparks 2.0.1', startDate: '2026-09-01T00:00:00Z', endDate: '2026-09-20T00:00:00Z' },
        { name: 'Sparks 2.0.2', startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-20T00:00:00Z' }];
    const issue = (key, pi, sprint) => ({ key, type: 'Story', title: key, pi, sprint, priority: 'Major' });

    return {
        [DATA_URL]: {
            deployments: [{ id: 1, component: 'zeta', environment: 'prod', status: 'success', version: 'v1', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [] },
                { id: 2, component: 'alpha', environment: 'qa', status: 'success', version: 'v2', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [] },
                { id: 3, component: 'alpha', environment: 'test', status: 'success', version: 'v3', deployedAt: '2026-10-08T00:00:00Z', relatedIssues: [] }],
            flagsMeta: {}, flagStates: {},
            jiraIndex: jiraIndex || { currentPi: 'PI-2.0', pis: [{ pi: 'PI-2.0', file: 'pi2.json', sprints }, { pi: 'PI-1.0', file: 'pi1.json', sprints: [] }] },
        },
        [issuesUrl('PI-2.0')]: [issue('A-1', 'PI-2.0', 'Sparks 2.0.2')],
        [issuesUrl('PI-1.0')]: [issue('B-1', 'PI-1.0', 'Sparks 1.0.1')],
    };
}

const fetchFrom = routes => url => (url in routes ? jsonRes(routes[url]) : jsonRes(null, false));

test('fallback boot: init renders everything from the built-in dataset and picks the current sprint', async () => {
    const app = loadApp();

    await settle();

    const { run, boxes } = app;

    assert.equal(run('state.isFallback'), true);
    assert.equal(run('state.selectedPi'), 'PI-27.3');
    assert.ok(run('state.jiraIssues.length') > 0);
    assert.equal(run('state.selectedSprint'), 'Sparks 27.3.2', 'active sprint is the default');
    assert.equal(boxes.filterSprint.value, 'Sparks 27.3.2');

    // global PI select: options newest first, current marked, value preselected
    const labels = boxes.globalPiSelect.children.map(o => o.textContent);

    assert.deepEqual(labels, ['PI-27.3 (current)', 'PI-27.2', 'PI-27.1', 'PI-26.5']);
    assert.equal(boxes.globalPiSelect.value, 'PI-27.3');

    // env / component filters
    assert.deepEqual(boxes.filterEnv.children.map(o => [o.value, o.textContent]), [['test', 'TEST'], ['qa', 'QA'], ['prod', 'PROD']]);
    const comps = boxes.filterComponent.children.map(o => o.value);

    assert.deepEqual(comps, [...comps].sort());
    assert.equal(new Set(comps).size, comps.length);
    assert.ok(comps.includes('evapl-service-frontend'));

    // views rendered
    for (const id of ['summaryGrid', 'timeline', 'flags', 'pvSummary', 'issueBody', 'releaseNotesBody']) {
        assert.ok(String(boxes[id].innerHTML).length > 0, `${id} rendered`);
    }
    assert.equal(boxes.statusBadgeLabel.textContent, 'Sample');
});

test('tabs: default view is tech; Insights tab removed without ?insights=1, shown with it', async () => {
    const off = loadApp();

    await settle();
    assert.equal(off.boxes['globalPiSelectWrap'].style.display, 'none');
    assert.equal(off.boxes['sprintSelectWrap'].style.display, 'none');
    assert.ok(off.byView.tech.classList.contains('active'));
    assert.ok(off.viewEls[0].classList.contains('active'));
    assert.equal(off.byView.insights.removed, true);
    assert.equal(off.byView.notes.removed, false);
    assert.equal(off.boxes.chartSprint, undefined, 'insights not rendered');

    const on = loadApp({ search: '?insights=1' });

    await settle();
    assert.equal(on.byView.insights.removed, false);
    assert.equal(on.byView.insights.style.display, '');
    assert.ok(String(on.boxes.chartSprint.innerHTML).length > 0, 'insights rendered');
});

test('tab clicks switch views and toggle the PI / sprint selectors', async () => {
    const app = loadApp({ search: '?insights=1' });

    await settle();

    const { byView, viewEls, boxes } = app;
    const activeViews = () => viewEls.filter(v => v.classList.contains('active')).map(v => v.dataset.view);

    byView.product.onclick();
    assert.deepEqual(activeViews(), ['product']);
    assert.equal(boxes.globalPiSelectWrap.style.display, '');
    assert.equal(boxes.sprintSelectWrap.style.display, '');
    assert.ok(byView.product.classList.contains('active'));
    assert.ok(!byView.tech.classList.contains('active'));

    byView.notes.onclick();
    assert.deepEqual(activeViews(), ['notes']);
    assert.equal(boxes.globalPiSelectWrap.style.display, '');
    assert.equal(boxes.sprintSelectWrap.style.display, 'none');

    byView.insights.onclick();
    assert.deepEqual(activeViews(), ['insights']);
    assert.equal(boxes.sprintSelectWrap.style.display, 'none');

    byView.tech.onclick();
    assert.deepEqual(activeViews(), ['tech']);
    assert.equal(boxes.globalPiSelectWrap.style.display, 'none');
});

test('live boot: current PI chosen from the index, its shard loaded, options labelled', async () => {
    const calls = [];
    const routes = liveRoutes();
    const app = loadApp({ fetchImpl: u => { calls.push(u); return fetchFrom(routes)(u); }, pathname: API_PATH });

    await settle();

    const { run, boxes } = app;

    assert.equal(run('state.isFallback'), false);
    assert.equal(run('state.selectedPi'), 'PI-2.0');
    assert.deepEqual(plain(run('state.jiraIssues.map(i => i.key)')), ['A-1']);
    assert.equal(run('state.selectedSprint'), 'Sparks 2.0.2');
    assert.deepEqual(boxes.globalPiSelect.children.map(o => o.textContent), ['PI-2.0 (current)', 'PI-1.0']);
    assert.deepEqual(boxes.filterComponent.children.map(o => o.value), ['alpha', 'zeta']);
    assert.ok(calls.includes(issuesUrl('PI-2.0')));
    assert.ok(!calls.includes(issuesUrl('PI-1.0')), 'only one increment is loaded up front');
    assert.equal(boxes.statusBadgeLabel.textContent, 'Live');
});

test('live boot without currentPi falls back to the first PI; without any PI selects null', async () => {
    const routes = liveRoutes({ jiraIndex: { currentPi: null, pis: [{ pi: 'PI-1.0', file: 'pi1.json', sprints: [] }] } });
    const a = loadApp({ fetchImpl: fetchFrom(routes), pathname: API_PATH });

    await settle();
    assert.equal(a.run('state.selectedPi'), 'PI-1.0');
    assert.deepEqual(plain(a.run('state.jiraIssues.map(i => i.key)')), ['B-1']);
    assert.equal(a.run('state.selectedSprint'), '', 'no sprint data -> All sprints');
    assert.equal(a.boxes.filterSprint.disabled, true);
    assert.deepEqual(a.boxes.globalPiSelect.children.map(o => o.textContent), ['PI-1.0']);

    const b = loadApp({ fetchImpl: fetchFrom(liveRoutes({ jiraIndex: { currentPi: null, pis: [] } })), pathname: API_PATH });

    await settle();
    assert.equal(b.run('state.selectedPi'), null);
    assert.equal(b.run('state.jiraIssues.length'), 0);
    assert.equal(b.boxes.globalPiSelect.value, '');
});

test('refreshSprintSelect: current option first, hybrid option, remaining sprints newest first; past PI has no current/hybrid', async () => {
    const app = loadApp({ fetchImpl: fetchFrom(liveRoutes()), pathname: API_PATH });

    await settle();

    const { boxes, run } = app;

    assert.deepEqual(boxes.filterSprint.children.map(o => o.textContent),
        ['All sprints', 'Current sprint (Sparks 2.0.2)', 'Current sprint + unresolved', 'Sparks 2.0.1']);

    run('state.selectedPi = "PI-1.0"; state.jiraIndex.pis[1].sprints = [{name:"S9"},{name:"S10"}]; refreshSprintSelect()');
    assert.deepEqual(boxes.filterSprint.children.map(o => o.textContent), ['All sprints', 'S10', 'S9']);
    assert.equal(run('state.selectedSprint'), '');
});

test('PI select change loads the shard, resets filters and refreshes sprint scope', async () => {
    const app = loadApp({ fetchImpl: fetchFrom(liveRoutes()), search: '?insights=1', pathname: API_PATH });

    await settle();

    const { boxes, run } = app;
    let clears = 0;
    let noteClears = 0;

    boxes.btnClearFilters.onclick = () => { clears++; };
    boxes.btnClearNotesFilters.onclick = () => { noteClears++; };
    boxes.chartSprint.innerHTML = '';

    boxes.globalPiSelect.value = 'PI-1.0';
    await boxes.globalPiSelect.listeners.change[0]();

    assert.equal(run('state.selectedPi'), 'PI-1.0');
    assert.deepEqual(plain(run('state.jiraIssues.map(i => i.key)')), ['B-1']);
    assert.equal(run('state.selectedSprint'), '', 'PI without sprint data -> All sprints');
    assert.equal(clears, 1);
    assert.equal(noteClears, 1);
    assert.ok(String(boxes.chartSprint.innerHTML).length > 0, 'insights re-rendered');
});

test('PI select: latest request wins when responses arrive out of order', async () => {
    const pending = {};
    const routes = liveRoutes();
    const fetchImpl = u => {
        if (u === issuesUrl('PI-1.0')) {
            return new Promise(resolve => { pending.pi1 = () => resolve({ ok: true, json: () => Promise.resolve(routes[u]) }); });
        }
        if (u === issuesUrl('PI-2.0') && pending.hold) {
            return new Promise(resolve => { pending.pi2 = () => resolve({ ok: true, json: () => Promise.resolve([{ key: 'LATE', pi: 'PI-2.0' }]) }); });
        }

        return fetchFrom(routes)(u);
    };
    const app = loadApp({ fetchImpl, pathname: API_PATH });

    await settle();

    const { boxes, run } = app;
    let clears = 0;

    boxes.btnClearFilters.onclick = () => { clears++; };
    pending.hold = true;

    // user picks PI-1.0 and then, before it answers, goes back to PI-2.0
    boxes.globalPiSelect.value = 'PI-1.0';

    const first = boxes.globalPiSelect.listeners.change[0]();

    boxes.globalPiSelect.value = 'PI-2.0';

    const second = boxes.globalPiSelect.listeners.change[0]();

    await settle();
    pending.pi2();
    await second;
    assert.equal(run('state.selectedPi'), 'PI-2.0');
    assert.deepEqual(plain(run('state.jiraIssues.map(i => i.key)')), ['LATE']);
    assert.equal(clears, 1);

    // the slow, stale response now lands and must be discarded
    pending.pi1();
    await first;
    assert.equal(run('state.selectedPi'), 'PI-2.0');
    assert.deepEqual(plain(run('state.jiraIssues.map(i => i.key)')), ['LATE']);
    assert.equal(clears, 1, 'stale response did not touch filters');
    assert.equal(boxes.globalPiSelect.value, 'PI-2.0');
});

test('timeline infinite scroll and deploy filter reset wiring', async () => {
    const app = loadApp({ fetchImpl: fetchFrom(liveRoutes()), pathname: API_PATH });

    await settle();

    const { boxes, run } = app;
    const before = run('visibleDeployCount');
    const timeline = boxes.timeline;

    // far from the bottom -> nothing
    timeline.scrollTop = 0; timeline.clientHeight = 100; timeline.scrollHeight = 5000;
    timeline.listeners.scroll[0].call(timeline);
    assert.equal(run('visibleDeployCount'), before);

    // near the bottom -> next page, scroll position preserved
    timeline.scrollTop = 4900;
    timeline.listeners.scroll[0].call(timeline);
    assert.equal(run('visibleDeployCount'), before + run('DEPLOY_PAGE_SIZE'));
    assert.equal(timeline.scrollTop, 4900);

    // clear button resets every deploy filter
    boxes.filterComponent.value = 'alpha';
    boxes.filterEnv.value = 'qa';
    boxes.filterDeployRange.value = 'all';
    boxes.btnClearDeployFilters.onclick();
    assert.equal(boxes.filterComponent.value, '');
    assert.equal(boxes.filterEnv.value, '');
    assert.equal(boxes.filterDeployRange.value, '90');

    // change handlers are wired
    assert.equal(typeof boxes.filterEnv.onchange, 'function');
    assert.equal(typeof boxes.filterComponent.onchange, 'function');
    assert.equal(typeof boxes.filterDeployRange.onchange, 'function');
    boxes.filterEnv.onchange();
    boxes.filterFlagSource.onchange();
    assert.equal(run('visibleDeployCount'), run('DEPLOY_PAGE_SIZE'), 'filter change resets pagination');
});

test('sprint select change updates the scope and re-renders', async () => {
    const app = loadApp({ fetchImpl: fetchFrom(liveRoutes()), pathname: API_PATH });

    await settle();
    app.boxes.filterSprint.value = 'Sparks 2.0.1';
    app.boxes.filterSprint.listeners.change[0]();
    assert.equal(app.run('state.selectedSprint'), 'Sparks 2.0.1');
    app.boxes.filterSprint.value = '';
    app.boxes.filterSprint.listeners.change[0]();
    assert.equal(app.run('state.selectedSprint'), '');
});

test('delegated handlers: data-stop-click stops the click in the capture phase, data-close-dialog closes its dialog', async () => {
    const { ctx } = loadApp();
    await settle();
    const clicks = ctx.document.listeners.filter(l => l.type === 'click');
    const capture = clicks.filter(l => l.capture && String(l.fn).includes('data-stop-click'));
    const bubble = clicks.filter(l => !l.capture && String(l.fn).includes('data-close-dialog'));
    assert.deepEqual([capture.length, bubble.length], [1, 1]);

    let stopped = 0;
    const event = target => ({ target, stopPropagation() { stopped++; } });
    const link = { closest: sel => (sel === '[data-stop-click]' ? link : null) };
    const other = { closest: () => null };
    capture[0].fn(event(link));
    capture[0].fn(event(other));
    capture[0].fn(event({}));
    assert.equal(stopped, 1, 'only a click inside [data-stop-click] is stopped');

    let closed = 0;
    const dialog = { close() { closed++; } };
    const button = { closest: sel => (sel === '[data-close-dialog]' ? button : sel === 'dialog' ? dialog : null) };
    bubble.forEach(l => l.fn(event(button)));
    bubble.forEach(l => l.fn(event(other)));
    assert.equal(closed, 1);
});
