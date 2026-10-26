// The Release plan tab's model on the server (G1.5): the dashboard's own scripts (docs/app-*.js) run in a vm sandbox
// over one tenant's dashboard data, so the worker's events (lib/outgoing-events.js) follow exactly what the tab shows
// and release status has one implementation. The same technique as lib/mock-dashboard.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// What releasePlanModel() needs at run time, in docs/index.html order (app-technical.js holds issueIsReleasedToProd()).
const SCRIPTS = ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model', 'app-technical'];
const DOCS = path.join(__dirname, '..', '..', 'docs');

const stubElement = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
});

let compiled = null;
/** The scripts, read and compiled once per process. */
function scripts(dir) {
    if (!compiled || compiled.dir !== dir) {
        compiled = { dir, list: SCRIPTS.map((name) => new vm.Script(fs.readFileSync(path.join(dir, `${name}.js`), 'utf8'), { filename: `${name}.js` })) };
    }
    return compiled.list;
}

/**
 * releasePlanModel()'s groups for one tenant's dashboard data, each plan flag with the line its tasks are in
 * (`release`: the first line holding one of them).
 *
 * @param {object} data what readDashboardData() returns
 * @param {{ now?: Date, docsDir?: string }} [options]
 * @returns {Array<{ key: string, lines: Array<{ id: string, released: boolean, items: Array<{ key: string, onProd: boolean }> }>, flags: Array<{ key: string, hasPlan: boolean, stage: string|null, percent: number|null, status: string, release: string|null }> }>}
 */
function releaseGroups(data, { now = new Date(), docsDir = DOCS } = {}) {
    const NOW = now.getTime();
    class FrozenDate extends Date {
        constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
        static now() { return NOW; }
    }
    const context = vm.createContext({
        console, URLSearchParams, Date: FrozenDate, Math, Map, Set, JSON,
        location: { search: '', pathname: '/' },
        localStorage: { getItem: () => null, setItem() {} },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        document: { getElementById: stubElement, documentElement: stubElement(), body: stubElement(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: stubElement },
        fetch: () => Promise.reject(new Error('no network in the release-status sandbox')),
    });
    for (const script of scripts(docsDir)) script.runInContext(context);
    context.__data = JSON.stringify({ jiraIssues: [], selectedPi: null, ...data });
    const out = vm.runInContext(`(() => {
        state = JSON.parse(__data);
        const plans = new Map(((state.releasePlan && state.releasePlan.plans) || []).map(p => [p.change, p]));
        return JSON.stringify(releasePlanModel().groups.map(g => {
            const plan = plans.get(g.key);
            const lineOf = (tasks) => {
                const line = plan && (plan.releases || []).find(r => (r.tasks || []).some(t => (tasks || []).includes(t)));
                return line ? line.id : null;
            };
            return {
                key: g.key,
                lines: g.lines.map(l => ({ id: l.id, released: l.released, items: l.items.map(i => ({ key: i.key, onProd: i.onProd })) })),
                flags: g.flags.map(f => ({
                    key: f.key, hasPlan: f.hasPlan, stage: f.stage, percent: f.percent, status: f.status,
                    release: lineOf(plan && ((plan.flags || []).find(pf => pf.key === f.key) || {}).tasks),
                })),
            };
        }));
    })()`, context);
    return JSON.parse(out);
}

module.exports = { releaseGroups };
