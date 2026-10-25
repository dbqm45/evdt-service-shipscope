// The Release plan tab (G1.3): lines R1…Rn with their items' PROD status, the flags' rollout against their planned
// stages, days in a stage against min_days, flags past remove_by, and "R1 released". docs/app-model.js computes it
// (releasePlanModel(), flagPlanStatus()), docs/app-release-plan.js renders it. Run in a vm with a stub DOM and a
// frozen clock, like the other view tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', 'docs');
const FILES = ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model', 'app-product', 'app-technical', 'app-technical-matrix', 'app-technical-timeline', 'app-technical-flags', 'app-release-notes', 'app-release-plan'];
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const DAY = 86400000;
const EVIL = '<img src=x onerror=alert(1)>';
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

// The functional stub DOM of the other view tests (test/frontviews-release-insights.test.js).
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
    const el = (id) => els[id] || (els[id] = new El());
    const ctx = {
        console, URLSearchParams, Date: FakeDate, Math, Map, Set, CSS: { escape: (s) => String(s) }, location: { search: '' },
        localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }),
        document: { documentElement: new El(), body: new El(), getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: (tag) => new El(tag) },
    };
    vm.createContext(ctx);
    FILES.forEach((f) => {
        const file = path.join(DOCS, `${f}.js`);
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    });
    const ev = (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, ctx));
    const setState = (o) => vm.runInContext(`state = ${JSON.stringify({
        selectedPi: 'PI-1', jiraIssues: [], deployments: [], flagsMeta: {}, flagStates: {}, flagStateHistory: [], issueDeployments: {},
        issueStatusIndex: {}, componentsOrder: [{ name: 'pay', flagCoverage: 'tracked' }], jiraBrowseUrl: null, jiraIndex: { currentPi: null, pis: [] }, ...o,
    })}`, ctx);
    const render = () => {
        vm.runInContext('renderReleasePlan()', ctx);
        return String(el('releasePlanBody').innerHTML);
    };
    return { ev, setState, render };
}

const line = (key, release, o = {}) => ({ key, release, title: `T ${key}`, type: 'Story', epicKey: 'ABC-10', epicTitle: 'Payments', subtaskKeys: [], blockedByKeys: [], dependencyBlocked: false, ...o });
const dep = (keys, o = {}) => ({ id: 1, component: 'pay', environment: 'prod', status: 'success', version: 'v1', deployedAt: daysAgo(1), relatedIssues: keys, ...o });
const prodFlag = (key, state, rollout, changedAt) => ({ [key]: { prod: { pay: { state, rollout, enabled: state === 'on', changedAt, changedBy: 'ld', sourceName: 'LD', kind: 'runtime', overridden: [] } } } });

test('Jira mode: an R1 item on PROD and one not; "R1 released" once every R1 item is with users', () => {
    const app = loadApp();
    const base = { releasePlan: { mode: 'jira', lines: [line('ABC-1', 'R1', { title: EVIL }), line('ABC-2', 'R1'), line('ABC-3', 'R2')], plans: [] } };
    app.setState({ ...base, deployments: [dep(['ABC-1'])] });

    const model = app.ev('releasePlanModel()');
    assert.equal(model.mode, 'jira');
    assert.equal(model.groups.length, 1);
    assert.deepEqual([model.groups[0].key, model.groups[0].title], ['ABC-10', 'Payments']);
    const [r1, r2] = model.groups[0].lines;
    assert.deepEqual([r1.id, r2.id], ['R1', 'R2']);
    assert.deepEqual(r1.items.map((i) => [i.key, i.prodLevel, i.onProd]), [['ABC-1', 'deployed_code_only', true], ['ABC-2', 'none', false]]);
    assert.equal(r1.released, false);
    assert.equal(model.groups[0].mvpReleased, false);

    let out = app.render();
    assert.ok(out.includes('Code deployed'), 'the PROD pill of the item on PROD');
    assert.ok(out.includes('Not deployed'), 'and of the one not');
    assert.ok(!out.includes(EVIL) && out.includes('&lt;img'), 'titles escaped');
    assert.ok(!out.includes('R1 released'));
    assert.ok(out.includes('1/2 on PROD'));

    app.setState({ ...base, deployments: [dep(['ABC-1', 'ABC-2'])] });
    assert.equal(app.ev('releasePlanModel()').groups[0].mvpReleased, true);
    out = app.render();
    assert.ok(out.includes('R1 released'));
});

test('Jira mode has no stages: a linked flag shows its PROD rollout and "No plan"', () => {
    const app = loadApp();
    app.setState({
        releasePlan: { mode: 'jira', lines: [line('ABC-1', 'R1')], plans: [] },
        deployments: [dep(['ABC-1'])],
        flagsMeta: { 'payment-retry': { jiraKeys: ['ABC-1'], components: ['pay'] } },
        flagStatesByComponent: prodFlag('payment-retry', 'partial', 25, daysAgo(2)),
    });
    const [flag] = app.ev('releasePlanModel()').groups[0].flags;
    assert.deepEqual([flag.key, flag.percent, flag.hasPlan, flag.status], ['payment-retry', 25, false, 'no_plan']);
    const out = app.render();
    assert.ok(out.includes('payment-retry') && out.includes('25%') && out.includes('No plan'));
});

const PLAN = {
    change: 'CHG-12',
    mvp: { release: 'R1', outcome: 'Retry a failed payment' },
    releases: [{ id: 'R1', name: 'MVP', tasks: ['TSK-57', 'TSK-58'] }, { id: 'R2', tasks: ['TSK-59'] }],
    flags: [{
        key: 'payment-retry', tasks: ['TSK-57', 'TSK-58'], owner: 'PO Payments', remove_by: '2026-12-31',
        rollout: [{ stage: 'internal', min_days: 3 }, { stage: '10%', min_days: 7 }, { stage: '100%' }],
    }],
};
const repoState = (flagStatesByComponent, plan = PLAN) => ({
    releasePlan: { mode: 'repo', lines: [], plans: [plan] }, flagStatesByComponent,
    flagsMeta: { 'payment-retry': { jiraKeys: [], components: ['pay'] } },
});

test('flagPlanStatus: before its first stage, in a stage under min_days, past min_days, at the last stage', () => {
    const app = loadApp();
    const status = () => app.ev('releasePlanModel()').groups[0].flags[0];

    app.setState(repoState(prodFlag('payment-retry', 'off', null, daysAgo(1))));
    assert.deepEqual([status().status, status().stageIndex, status().nextStage], ['not_started', -1, 'internal']);

    app.setState(repoState(prodFlag('payment-retry', 'partial', 10, daysAgo(2))));
    let s = status();
    assert.deepEqual([s.status, s.stage, s.percent, s.daysInStage, s.minDays, s.nextStage], ['waiting', '10%', 10, 2, 7, '100%']);
    assert.ok(app.render().includes('2 of 7 days'));

    app.setState(repoState(prodFlag('payment-retry', 'partial', 10, daysAgo(8))));
    s = status();
    assert.deepEqual([s.status, s.daysInStage], ['ready', 8]);
    assert.ok(app.render().includes('Ready for 100%'));

    app.setState(repoState(prodFlag('payment-retry', 'partial', 3, daysAgo(4))));
    assert.deepEqual([status().stage, status().status], ['internal', 'ready'], 'a rollout below the first % stage is the named stage before it');

    app.setState(repoState(prodFlag('payment-retry', 'on', null, daysAgo(1))));
    assert.deepEqual([status().stage, status().percent, status().status], ['100%', 100, 'final']);
});

test('a flag past remove_by is highlighted with its days overdue; one before it is not', () => {
    const app = loadApp();
    app.setState(repoState(prodFlag('payment-retry', 'on', null, daysAgo(30)), { ...PLAN, flags: [{ ...PLAN.flags[0], remove_by: '2026-10-01' }] }));
    const s = app.ev('releasePlanModel()').groups[0].flags[0];
    assert.deepEqual([s.overdue, s.daysPastRemoveBy, s.removeBy], [true, 8, '2026-10-01']);
    const out = app.render();
    assert.ok(out.includes('flag-overdue'));
    assert.ok(out.includes('8 days past remove-by'));

    app.setState(repoState(prodFlag('payment-retry', 'on', null, daysAgo(30))));
    const before = app.ev('releasePlanModel()').groups[0].flags[0];
    assert.deepEqual([before.overdue, before.daysPastRemoveBy], [false, 0]);
    assert.ok(!app.render().includes('flag-overdue'));
});

test('repo mode: a plan groups by its change, lines from releases, the MVP line marked', () => {
    const app = loadApp();
    app.setState(repoState({}));
    const [group] = app.ev('releasePlanModel()').groups;
    assert.deepEqual([group.key, group.mvp, group.outcome], ['CHG-12', 'R1', 'Retry a failed payment']);
    assert.deepEqual(group.lines.map((l) => [l.id, l.name, l.items.map((i) => i.key)]), [['R1', 'MVP', ['TSK-57', 'TSK-58']], ['R2', null, ['TSK-59']]]);
});

test('no lines at all: an empty state that says how to mark one', () => {
    const app = loadApp();
    app.setState({ releasePlan: { mode: 'jira', lines: [], plans: [] } });
    assert.deepEqual(app.ev('releasePlanModel()').groups, []);
    assert.ok(app.render().includes('release:R1'));
});

test('a broken plan is shown, not fixed: MVP line missing, a task in two lines, a flag task outside the lines', () => {
    const app = loadApp();
    const broken = {
        ...PLAN,
        mvp: { release: 'R3' },
        releases: [{ id: 'R1', tasks: ['TSK-57', 'TSK-58'] }, { id: 'R2', tasks: ['TSK-58'] }],
        flags: [{ key: 'payment-retry', tasks: ['TSK-57', 'TSK-99'], rollout: [{ stage: '100%' }] }],
    };
    app.setState(repoState({}, broken));
    assert.deepEqual(app.ev('releasePlanProblems(state.releasePlan.plans[0])'), [
        'The MVP line R3 is not among the lines',
        'TSK-58 is in more than one line (R1, R2)',
        'Flag payment-retry names TSK-99, which is in no line',
    ]);
    assert.deepEqual(app.ev('releasePlanModel().groups[0].problems').length, 3);
    const out = app.render();
    assert.ok(out.includes('rp-problems') && out.includes('TSK-58 is in more than one line (R1, R2)'));

    app.setState(repoState({}));
    assert.deepEqual(app.ev('releasePlanProblems(state.releasePlan.plans[0])'), []);
    assert.ok(!app.render().includes('rp-problems'));
});
