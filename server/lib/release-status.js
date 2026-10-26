// The dashboard's model on the server: its own scripts (docs/app-*.js) run in a vm sandbox over one tenant's dashboard
// data, so the worker's events (G1.5, lib/outgoing-events.js) and the service API (F5, lib/service-api.js) follow
// exactly what the dashboard shows and release status has one implementation. The same technique as
// lib/mock-dashboard.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// What the models need at run time, in docs/index.html order (app-technical.js holds issueIsReleasedToProd(),
// app-technical-flags.js flagStaleWarning()/flagBlastRadius(), app-insights.js earliestProdDeployedAt()).
const SCRIPTS = ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model', 'app-technical', 'app-technical-flags', 'app-insights'];
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
 * A sandbox with the dashboard's scripts loaded, `state` set to one tenant's dashboard data and the clock frozen.
 *
 * @param {object} data what readDashboardData() returns, plus `jiraIssues` when a model needs issues
 * @param {{ now?: Date, docsDir?: string }} options
 * @returns {import('vm').Context}
 */
function sandbox(data, { now = new Date(), docsDir = DOCS } = {}) {
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
    vm.runInContext('state = JSON.parse(__data);', context);
    return context;
}

/** Runs `expression` (returning JSON text) in a fresh sandbox; `input` is available to it as `__input`. */
function evaluate(data, options, expression, input) {
    const context = sandbox(data, options);
    context.__input = JSON.stringify(input ?? null);
    return JSON.parse(vm.runInContext(`(() => { const input = JSON.parse(__input); ${expression} })()`, context));
}

/**
 * releasePlanModel()'s groups for one tenant's dashboard data, each plan flag with the line its tasks are in
 * (`release`: the first line holding one of them).
 *
 * @param {object} data what readDashboardData() returns
 * @param {{ now?: Date, docsDir?: string }} [options]
 * @returns {Array<{ key: string, lines: Array<{ id: string, released: boolean, items: Array<{ key: string, onProd: boolean }> }>, flags: Array<{ key: string, hasPlan: boolean, stage: string|null, percent: number|null, status: string, release: string|null }> }>}
 */
function releaseGroups(data, options = {}) {
    return evaluate(data, options, `
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
        }));`);
}

/**
 * One item's status per environment, as the dashboard's pill shows it (issueStatusForEnv()), and its first PROD
 * deployment (earliestProdDeployedAt()).
 *
 * @param {object} data what readDashboardData() returns
 * @param {object} issue the item in the jira-issues shape (a Jira issue or workItemIssues()' entry)
 * @param {{ now?: Date, docsDir?: string }} [options]
 * @returns {{ envs: Record<'test'|'qa'|'prod', { status: string, uncertain: object[], mismatch: object[] }>, firstProdAt: string|null, releasedOnProd: boolean }}
 */
function itemStatus(data, issue, options = {}) {
    return evaluate({ ...data, jiraIssues: [issue] }, options, `
        const issue = state.jiraIssues[0];
        const envs = {};
        for (const env of ['test', 'qa', 'prod']) {
            const s = issueStatusForEnv(issue, env);
            envs[env] = { status: s.level, uncertain: s.uncertain || [], mismatch: s.mismatch || [] };
        }
        const first = earliestProdDeployedAt(issue);
        return JSON.stringify({ envs, firstProdAt: first === null ? null : new Date(first).toISOString(), releasedOnProd: issueIsReleasedToProd(issue) });`);
}

/**
 * For each resolved issue: the first PROD deployment and the days from resolution to it (negative clamped to 0,
 * as leadTimeToProdBySprint() does), or null when it never reached PROD.
 *
 * @param {object} data what readDashboardData() returns
 * @param {object[]} issues Jira issues (jira-issues shape)
 * @param {{ now?: Date, docsDir?: string }} [options]
 * @returns {Array<{ key: string, firstProdAt: string, days: number }>}
 */
function leadTimes(data, issues, options = {}) {
    return evaluate({ ...data, jiraIssues: issues }, options, `
        return JSON.stringify(state.jiraIssues.filter(i => i.resolvedAt).flatMap(issue => {
            const first = earliestProdDeployedAt(issue);
            if (!first) return [];
            const days = Math.max(0, Math.floor((first - new Date(issue.resolvedAt).getTime()) / 86400000));
            return [{ key: issue.key, firstProdAt: new Date(first).toISOString(), days }];
        }));`);
}

/**
 * Several items' status at once (one sandbox): per environment, the first PROD deployment and whether it is with users.
 *
 * @param {object} data what readDashboardData() returns
 * @param {object[]} issues items in the jira-issues shape
 * @param {{ now?: Date, docsDir?: string }} [options]
 * @returns {Record<string, { envs: Record<'test'|'qa'|'prod', { status: string, uncertain: object[], mismatch: object[] }>, firstProdAt: string|null, releasedOnProd: boolean }>}
 */
function itemStatuses(data, issues, options = {}) {
    return evaluate({ ...data, jiraIssues: issues }, options, `
        const out = {};
        for (const issue of state.jiraIssues) {
            const envs = {};
            for (const env of ['test', 'qa', 'prod']) {
                const s = issueStatusForEnv(issue, env);
                envs[env] = { status: s.level, uncertain: s.uncertain || [], mismatch: s.mismatch || [] };
            }
            const first = earliestProdDeployedAt(issue);
            out[issue.key] = { envs, firstProdAt: first === null ? null : new Date(first).toISOString(), releasedOnProd: issueIsReleasedToProd(issue) };
        }
        return JSON.stringify(out);`);
}

/**
 * The Release plan tab's model (releasePlanModel()), its items cut to key, title, PROD level and whether with users.
 *
 * @param {object} data what readDashboardData() returns
 * @param {{ now?: Date, docsDir?: string }} [options]
 * @returns {{ mode: string, groups: Array<{ key: string, title: string, mvp: string, outcome: string|null, mvpReleased: boolean, problems: string[], lines: Array<{ id: string, name: string|null, released: boolean, onProdCount: number, items: Array<{ key: string, title: string, prod: string, onProd: boolean }> }>, flags: object[] }> }}
 */
function releasePlan(data, options = {}) {
    return evaluate(data, options, `
        const model = releasePlanModel();
        return JSON.stringify({
            mode: model.mode,
            groups: model.groups.map(g => ({
                key: g.key, title: g.title, mvp: g.mvp, outcome: g.outcome, mvpReleased: g.mvpReleased, problems: g.problems || [],
                lines: g.lines.map(l => ({ id: l.id, name: l.name, released: l.released, onProdCount: l.onProdCount,
                    items: l.items.map(i => ({ key: i.key, title: i.title, prod: i.prodLevel, onProd: i.onProd })) })),
                flags: g.flags,
            })),
        });`);
}

/**
 * Every flag as the Technical view's flags panel knows it: what it is, its items, PROD exposure (flagProdExposure()),
 * its state per environment and service (flagStatesByComponent), the freshness of the services it covers, and the
 * panel's warnings (flagBlastRadius(), flagStaleWarning()). Key order.
 *
 * @param {object} data what readDashboardData() returns
 * @param {{ now?: Date, docsDir?: string }} [options]
 * @returns {Array<{ key: string, description: string, kind: 'build'|'runtime', itemKeys: string[], services: string[], prod: object|null, envs: object, freshness: object, blastRadius: string[]|null, stale: object|null }>}
 */
function flagsView(data, options = {}) {
    return evaluate(data, options, `
        return JSON.stringify(Object.keys(state.flagsMeta).sort().map(key => {
            const meta = state.flagsMeta[key];
            const byEnv = (state.flagStatesByComponent && state.flagStatesByComponent[key]) || {};
            const envs = {};
            const services = new Set(meta.components || []);
            for (const [env, byComponent] of Object.entries(byEnv)) {
                envs[env] = {};
                for (const [component, v] of Object.entries(byComponent)) {
                    services.add(component);
                    envs[env][component] = { state: v.state, rollout: typeof v.rollout === 'number' ? v.rollout : null, changedAt: v.changedAt || null, sourceName: v.sourceName || null };
                }
            }
            const freshness = {};
            for (const component of services) {
                if (state.flagFreshness && state.flagFreshness[component]) freshness[component] = state.flagFreshness[component];
            }
            return {
                key, description: meta.description || '', kind: meta.source === 'build' ? 'build' : 'runtime',
                itemKeys: meta.jiraKeys || [], services: [...services].sort(), prod: flagProdExposure(key), envs, freshness,
                blastRadius: flagBlastRadius(meta), stale: flagStaleWarning(meta, key),
            };
        }));`);
}

/**
 * Per tracked repo (componentsOrder) and environment: the latest successful deployment (currentVersion()) with its
 * version, time, commit, whether it was a rollback, and its drift against the previous stage, or null when never
 * deployed there.
 *
 * @param {object} data what readDashboardData() returns
 * @param {{ now?: Date, docsDir?: string }} [options]
 * @returns {Array<{ name: string, serviceType: string|null, flagCoverage: string, envs: Record<'test'|'qa'|'prod', null|{ version: string|null, deployedAt: string, commitUrl: string|null, deployedBy: string|null, rollback: boolean, drift: null|{ comparedWith: string|null, files: number|null, paths: string[], unknown: boolean, commitsBehind: number|null } }> }>}
 */
function environmentsView(data, options = {}) {
    return evaluate(data, options, `
        const driftOf = (d) => {
            if (!d || !(d.diff || d.commitCount || d.untestedCommitCount)) return null;
            const diff = d.diff || {};
            return {
                comparedWith: d.behindEnv || d.untestedIn || null,
                files: typeof diff.files === 'number' ? diff.files : null,
                paths: diff.paths || [],
                unknown: !!diff.unknown,
                commitsBehind: typeof d.commitCount === 'number' ? d.commitCount : null,
            };
        };
        return JSON.stringify((state.componentsOrder || []).map(c => {
            const envs = {};
            for (const env of ['test', 'qa', 'prod']) {
                const d = currentVersion(c.name, env);
                envs[env] = d ? { version: d.version || null, deployedAt: new Date(d.deployedAt).toISOString(), commitUrl: d.commitUrl || null, deployedBy: d.deployedBy || null, rollback: !!d.rollback, drift: driftOf(d.driftBehind) } : null;
            }
            return { name: c.name, serviceType: c.serviceType || null, flagCoverage: c.flagCoverage || 'unknown', envs };
        }));`);
}

module.exports = { releaseGroups, itemStatus, itemStatuses, leadTimes, releasePlan, flagsView, environmentsView };
