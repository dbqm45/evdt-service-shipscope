// Exhaustive tests of the pure derivation logic in docs/app-model.js (vm-loaded, fake clock).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const vm = require('node:vm');

const NOW = new Date('2026-10-09T12:00:00Z').getTime();
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const daysAgo = d => iso(NOW - d * DAY);

function loadApp() {
    class FakeDate extends Date {
        constructor(...a) { if (a.length) { super(...a); } else { super(NOW); } }
        static now() { return NOW; }
    }
    const el = () => ({ classList: { add() {}, remove() {} }, style: {}, setAttribute() {}, getAttribute: () => null });
    const ctx = { console, URLSearchParams, Math, Map, Set, Date: FakeDate, location: { search: '' },
        localStorage: { setItem() {} }, document: { documentElement: el(), getElementById: () => el() } };

    vm.createContext(ctx);
    ['app-html', 'app-icons', 'app-core', 'app-components', 'app-model'].forEach(f => {
        const file = path.join(__dirname, '..', 'docs', `${f}.js`);

        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: url.pathToFileURL(file).href });
    });

    const run = code => vm.runInContext(code, ctx);
    const j = code => JSON.parse(JSON.stringify(run(code)));
    const setState = s => run(`state = ${JSON.stringify({ deployments: [], flagsMeta: {}, flagStates: {}, issueDeployments: {}, issueStatusIndex: {}, jiraIssues: [], jiraIndex: null, selectedPi: null, selectedSprint: '', ...s })}`);

    return { run, j, setState };
}

const dep = (component, env, extra = {}) => ({ component, environment: env, status: 'success', deployedAt: daysAgo(1), relatedIssues: [], ...extra });
const flagState = (enabled, changedAt) => ({ prod: { build: { enabled, changedAt } }, qa: { build: { enabled, changedAt } } });

test('componentDeployments / currentVersion: latest successful deploy per component/env', () => {
    const { run, j, setState } = loadApp();

    setState({ deployments: [
        dep('c', 'prod', { id: 'old', deployedAt: daysAgo(5) }), dep('c', 'prod', { id: 'new', deployedAt: daysAgo(1) }),
        dep('c', 'prod', { id: 'failed', status: 'failure', deployedAt: daysAgo(0) }), dep('d', 'prod', { id: 'other' }),
    ] });
    assert.equal(run('componentDeployments("c","prod").length'), 2);
    assert.equal(run('currentVersion("c","prod").id'), 'new');
    assert.equal(run('currentVersion("c","qa")'), null);

    assert.deepEqual(j('currentVersion("c","qa")'), null);
});

test('effectiveFlagState is available to the model (runtime-be wins)', () => {
    const { j } = loadApp();

    assert.deepEqual(j('effectiveFlagState({build:{enabled:true},"runtime-be":{enabled:false}})'), { enabled: false, source: 'runtime-be' });
});

test('flagsForIssue / issueLinks', () => {
    const { j, setState } = loadApp();

    setState({ flagsMeta: { f1: { jiraKeys: ['K-1'], components: ['a', 'b'] }, f2: { jiraKeys: ['K-2'] }, f3: {}, f4: { jiraKeys: ['K-1'] } } });
    assert.deepEqual(j('flagsForIssue("K-1").map(f => f.key)'), ['f1', 'f4']);
    assert.deepEqual(j('flagsForIssue("none")'), []);
    assert.deepEqual(j('issueLinks({key:"K-1"})'), [{ component: 'a', flagKey: 'f1' }, { component: 'b', flagKey: 'f1' }]);
    assert.deepEqual(j('issueLinks({key:"K-2"})'), []);
});

test('issueDeployedOnComponent / anyDeploymentForIssue use live records then the never-trimmed index', () => {
    const { j, run, setState } = loadApp();

    setState({
        deployments: [dep('c', 'prod', { id: 'live', relatedIssues: ['K-1'] }), dep('c', 'prod', { id: 'noissues', relatedIssues: undefined }), dep('c', 'qa', { status: 'failure', relatedIssues: ['K-3'] })],
        issueDeployments: { 'K-2': { prod: { c: { deployedAt: '2026-01-01T00:00:00Z', commitUrl: 'u' } } } },
    });
    assert.equal(run('issueDeployedOnComponent("c",{key:"K-1"},"prod").id'), 'live');
    assert.deepEqual(j('issueDeployedOnComponent("c",{key:"K-2"},"prod")'), {
        deployedAt: '2026-01-01T00:00:00Z', commitUrl: 'u', relatedIssues: ['K-2'], component: 'c', environment: 'prod', status: 'success' });
    assert.equal(run('issueDeployedOnComponent("c",{key:"K-9"},"prod")'), null);
    assert.equal(run('issueDeployedOnComponent("zzz",{key:"K-2"},"prod")'), null);

    assert.equal(run('anyDeploymentForIssue({key:"K-1"},"prod")'), true);
    assert.equal(run('anyDeploymentForIssue({key:"K-1"},"qa")'), false);
    assert.equal(run('anyDeploymentForIssue({key:"K-3"},"qa")'), false, 'failed deploys do not count');
    assert.equal(run('anyDeploymentForIssue({key:"K-2"},"prod")'), true, 'historical index fallback');
    assert.equal(run('anyDeploymentForIssue({key:"K-2"},"test")'), false);
});

test('a deployment naming only a sub-task counts for its parent (subtaskKeys)', () => {
    const { j, run, setState } = loadApp();

    setState({
        deployments: [dep('c', 'prod', { id: 'sub', relatedIssues: ['S-2'] })],
        issueDeployments: { 'S-3': { qa: { c: { deployedAt: '2026-01-01T00:00:00Z' } } } },
    });
    const story = '{key:"S-1",subtaskKeys:["S-2","S-3"]}';
    assert.equal(run(`issueDeployedOnComponent("c",${story},"prod").id`), 'sub');
    assert.deepEqual(j(`issueDeployedOnComponent("c",${story},"qa").relatedIssues`), ['S-3'], 'historical index by a sub-task key');
    assert.equal(run(`anyDeploymentForIssue(${story},"prod")`), true);
    assert.equal(run(`anyDeploymentForIssue(${story},"qa")`), true);
    assert.equal(run('anyDeploymentForIssue({key:"S-1"},"prod")'), false, 'without subtaskKeys (synced before the field) only the own key');
    assert.deepEqual(j(`issueStatusForEnv(${story},"prod")`), { level: 'deployed_code_only', blocked: false, results: [], uncertain: [] });
});

test('an issue with no deployment of its own counts as deployed where all its blockers are (blockedByKeys)', () => {
    const { j, run, setState } = loadApp();

    setState({
        // B-1 (a Story) shipped through its sub-task B-3 on test and qa; B-2 only on test.
        deployments: [dep('c', 'test', { relatedIssues: ['B-3', 'B-2'] }), dep('c', 'qa', { relatedIssues: ['B-3'] })],
        jiraIssues: [{ key: 'B-1', subtaskKeys: ['B-3'] }],
    });
    assert.deepEqual(j('issueStatusForEnv({key:"BUG-1",blockedByKeys:["B-1"]},"qa")'), { level: 'deployed_code_only', blocked: false, results: [], uncertain: [] },
        'the blocker is matched on its sub-task\'s key');
    assert.equal(run('issueStatusForEnv({key:"BUG-1",blockedByKeys:["B-1"]},"prod").level'), 'none');
    assert.equal(run('issueStatusForEnv({key:"BUG-2",blockedByKeys:["B-1","B-2"]},"test").level'), 'deployed_code_only');
    assert.equal(run('issueStatusForEnv({key:"BUG-2",blockedByKeys:["B-1","B-2"]},"qa").level'), 'none', 'every blocker, not any');
    assert.equal(run('issueStatusForEnv({key:"BUG-3",blockedByKeys:["B-2"]},"test").level'), 'deployed_code_only', 'a blocker not loaded: its own key');
    assert.equal(run('issueStatusForEnv({key:"BUG-4",blockedByKeys:[]},"test").level'), 'none');
    assert.equal(run('issueStatusForEnv({key:"BUG-5"},"test").level'), 'none', 'synced before the field');
});

test('issueStatusForEnv without linked flags: raw deployment presence', () => {
    const { j, setState } = loadApp();

    setState({ deployments: [dep('c', 'prod', { relatedIssues: ['K-1'] })] });
    assert.deepEqual(j('issueStatusForEnv({key:"K-1"},"prod")'), { level: 'deployed_code_only', blocked: false, results: [], uncertain: [] });
    assert.deepEqual(j('issueStatusForEnv({key:"K-1"},"qa")'), { level: 'none', blocked: false, results: [], uncertain: [] });
});

test('issueStatusForEnv with flags: none / released / deployed / partial / blocked', () => {
    const { j, run, setState } = loadApp();
    const base = {
        flagsMeta: { f1: { jiraKeys: ['K-1'], components: ['a'] }, f2: { jiraKeys: ['K-2'], components: ['a', 'b'] } },
    };

    // none: flag linked but nothing deployed
    setState({ ...base, flagStates: { f1: flagState(true, daysAgo(2)) } });
    assert.equal(run('issueStatusForEnv({key:"K-1"},"prod").level'), 'none');

    // released: deployed and flag on
    setState({ ...base, deployments: [dep('a', 'prod', { relatedIssues: ['K-1'] })], flagStates: { f1: flagState(true, daysAgo(2)) } });
    assert.equal(run('issueStatusForEnv({key:"K-1"},"prod").level'), 'released');
    assert.equal(run('issueStatusForEnv({key:"K-1"},"prod").results[0].flagOn'), true);

    // deployed: flag off; flag state absent counts as off
    setState({ ...base, deployments: [dep('a', 'prod', { relatedIssues: ['K-1'] })], flagStates: { f1: flagState(false, daysAgo(2)) } });
    assert.equal(run('issueStatusForEnv({key:"K-1"},"prod").level'), 'deployed');
    setState({ ...base, deployments: [dep('a', 'prod', { relatedIssues: ['K-1'] })], flagStates: { f1: { qa: { build: { enabled: true } } } } });
    assert.deepEqual(j('issueStatusForEnv({key:"K-1"},"prod").results[0]'), {
        deployed: true, released: false, deployment: j('state.deployments[0]'), flagOn: false, flagPartial: false, flagChangedAt: null, component: 'a', flagKey: 'f1' });
    setState({ ...base, deployments: [dep('a', 'prod', { relatedIssues: ['K-1'] })] });
    assert.equal(run('issueStatusForEnv({key:"K-1"},"prod").level'), 'deployed');

    // partial: only one of two components deployed (flag on)
    setState({ ...base, deployments: [dep('a', 'prod', { relatedIssues: ['K-2'] })], flagStates: { f2: flagState(true, daysAgo(2)) } });
    assert.equal(run('issueStatusForEnv({key:"K-2"},"prod").level'), 'partial');

    // partial: both deployed but flag state mixed via runtime-be override
    setState({ ...base, deployments: [dep('a', 'prod', { relatedIssues: ['K-2'] }), dep('b', 'prod', { relatedIssues: ['K-2'] })],
        flagStates: { f2: { prod: { build: { enabled: true }, 'runtime-be': { enabled: false } } } } });
    assert.equal(run('issueStatusForEnv({key:"K-2"},"prod").level'), 'deployed');

    // blocked downgrade only on prod and only from released
    setState({ ...base, deployments: [dep('a', 'prod', { relatedIssues: ['K-1'] }), dep('a', 'qa', { relatedIssues: ['K-1'] })], flagStates: { f1: flagState(true, daysAgo(2)) } });
    assert.deepEqual(j('(({level, blocked}) => ({level, blocked}))(issueStatusForEnv({key:"K-1", dependencyBlocked:true},"prod"))'), { level: 'deployed', blocked: true });
    assert.deepEqual(j('(({level, blocked}) => ({level, blocked}))(issueStatusForEnv({key:"K-1", dependencyBlocked:true},"qa"))'), { level: 'released', blocked: false });
    setState({ ...base, deployments: [dep('a', 'prod', { relatedIssues: ['K-1'] })], flagStates: { f1: flagState(false, daysAgo(2)) } });
    assert.equal(run('issueStatusForEnv({key:"K-1", dependencyBlocked:true},"prod").blocked'), false);
});

test('issueStatusForEnv per service (ADR-003): own state per service, neutral services, partial rollouts, "?" for untracked', () => {
    const { j, run, setState } = loadApp();
    const at = daysAgo(2);
    const v = (stateName, rollout = null) => ({ state: stateName, rollout, enabled: stateName === 'on', changedAt: at });
    const comps = (coverage) => Object.entries(coverage).map(([name, flagCoverage]) => ({ name, flagCoverage }));
    const deps = (...cs) => cs.map(c => dep(c, 'prod', { relatedIssues: ['K-1'] }));
    const flagsMeta = { fe: { jiraKeys: ['K-1'], components: ['web'] }, be: { jiraKeys: ['K-1'], components: ['api'] } };
    const level = () => run('issueStatusForEnv({key:"K-1"},"prod").level');

    // FE on in code, BE off at runtime: each service keeps its own value (the old model let BE win for both).
    setState({ flagsMeta, deployments: deps('web', 'api'), componentsOrder: comps({ web: 'tracked', api: 'tracked' }),
        flagStatesByComponent: { fe: { prod: { web: v('on') } }, be: { prod: { api: v('off') } } } });
    assert.equal(level(), 'partial');
    setState({ flagsMeta, deployments: deps('web', 'api'), componentsOrder: comps({ web: 'tracked', api: 'tracked' }),
        flagStatesByComponent: { fe: { prod: { web: v('on') } }, be: { prod: { api: v('on') } } } });
    assert.equal(level(), 'released');
    setState({ flagsMeta, deployments: deps('web', 'api'), componentsOrder: comps({ web: 'tracked', api: 'tracked' }),
        flagStatesByComponent: { fe: { prod: { web: v('off') } }, be: { prod: { api: v('off') } } } });
    assert.equal(level(), 'deployed');

    // A rollout below 100% is partial, never released.
    setState({ flagsMeta: { fe: flagsMeta.fe }, deployments: deps('web'), componentsOrder: comps({ web: 'tracked' }),
        flagStatesByComponent: { fe: { prod: { web: v('partial', 25) } } } });
    assert.equal(level(), 'partial');
    assert.equal(run('issueStatusForEnv({key:"K-1"},"prod").results[0].flagPartial'), true);

    // A service the code reached without a linked flag is neutral: it neither releases nor holds back.
    setState({ flagsMeta: { fe: flagsMeta.fe }, deployments: deps('web', 'worker'), componentsOrder: comps({ web: 'tracked', worker: 'none' }),
        flagStatesByComponent: { fe: { prod: { web: v('on') } } } });
    assert.deepEqual(j('(({level, uncertain}) => ({level, uncertain}))(issueStatusForEnv({key:"K-1"},"prod"))'), { level: 'released', uncertain: [] });

    // ... but when nobody said whether it has flags, the level stays and the service is listed as uncertain.
    setState({ flagsMeta: { fe: flagsMeta.fe }, deployments: deps('web', 'worker'), componentsOrder: comps({ web: 'tracked', worker: 'unknown' }),
        flagStatesByComponent: { fe: { prod: { web: v('on') } } } });
    assert.deepEqual(j('(({level, uncertain}) => ({level, uncertain}))(issueStatusForEnv({key:"K-1"},"prod"))'), { level: 'released', uncertain: [{ component: 'worker', reason: 'untracked', observedAt: null }] });
    setState({ deployments: deps('worker'), componentsOrder: comps({ worker: 'unknown' }), flagStatesByComponent: {} });
    assert.deepEqual(j('(({level, uncertain}) => ({level, uncertain}))(issueStatusForEnv({key:"K-1"},"prod"))'), { level: 'deployed_code_only', uncertain: [{ component: 'worker', reason: 'untracked', observedAt: null }] });
    assert.deepEqual(j('issueStatusForEnv({key:"K-1"},"qa").uncertain'), [], 'nothing deployed: nothing to doubt');

    // A flag reported only through flagStatesByComponent still links its service; a service without the
    // issue's code leaves the issue partial.
    setState({ flagsMeta: { fe: { jiraKeys: ['K-1'], components: [] } }, deployments: deps('api'), componentsOrder: comps({ web: 'tracked', api: 'tracked' }),
        flagStatesByComponent: { fe: { prod: { web: v('on') } } } });
    assert.equal(level(), 'partial');
    assert.deepEqual(j('issueLinks({key:"K-1"})'), [{ component: 'web', flagKey: 'fe' }]);

    // A gate whose values are not confirmed (stale, refused, never confirmed) keeps the level and adds a doubt; a
    // fresh one, or a service without the issue's code, does not.
    const fresh = (component, s, observedAt = at) => ({ [component]: { prod: { state: s, observedAt, sources: [] } } });
    setState({ flagsMeta, deployments: deps('web', 'api'), componentsOrder: comps({ web: 'tracked', api: 'tracked' }),
        flagStatesByComponent: { fe: { prod: { web: v('on') } }, be: { prod: { api: v('on') } } },
        flagFreshness: { ...fresh('web', 'fresh'), ...fresh('api', 'stale', '2026-10-01T08:00:00.000Z') } });
    assert.deepEqual(j('(({level, uncertain}) => ({level, uncertain}))(issueStatusForEnv({key:"K-1"},"prod"))'),
        { level: 'released', uncertain: [{ component: 'api', reason: 'stale', observedAt: '2026-10-01T08:00:00.000Z' }] });
    assert.match(run('doubtText(issueStatusForEnv({key:"K-1"},"prod").uncertain[0])'), /^api: flag values not confirmed since 01\.10\.2026 \d\d:\d\d$/);
    run('state.flagFreshness.api.prod.state = "error"');
    assert.equal(run('doubtText(issueStatusForEnv({key:"K-1"},"prod").uncertain[0])'), 'api: the last flag message from its source was refused');
    run('state.flagFreshness.api.prod = { state: "unknown", observedAt: null, sources: [] }');
    assert.equal(run('doubtText(issueStatusForEnv({key:"K-1"},"prod").uncertain[0])'), 'api: its flag source has not confirmed a full state yet');
    setState({ flagsMeta, deployments: deps('web'), componentsOrder: comps({ web: 'tracked', api: 'tracked' }),
        flagStatesByComponent: { fe: { prod: { web: v('on') } }, be: { prod: { api: v('on') } } }, flagFreshness: fresh('api', 'stale') });
    assert.deepEqual(j('issueStatusForEnv({key:"K-1"},"prod").uncertain'), [], 'api has no code of this issue: its freshness is not the doubt');
    assert.equal(run('doubtText({ component: "w", reason: "untracked" })'), 'w: no flag source covers it and it is not marked as having no flags');

    // Legacy data (no flagStatesByComponent): a partial value is no longer "on".
    setState({ flagsMeta: { fe: flagsMeta.fe }, deployments: deps('web'), flagStates: { fe: { prod: { build: { enabled: true, state: 'partial', rollout: 5 } } } } });
    assert.equal(level(), 'partial');
});

test('prodStatusBucket maps levels to buckets', () => {
    const { run, setState } = loadApp();
    const flagsMeta = { f1: { jiraKeys: ['R'], components: ['a'] }, f2: { jiraKeys: ['H'], components: ['a'] }, f3: { jiraKeys: ['P'], components: ['a', 'b'] } };

    setState({
        flagsMeta, flagStates: { f1: flagState(true), f2: flagState(false), f3: flagState(true) },
        deployments: [dep('a', 'prod', { relatedIssues: ['R', 'H', 'P', 'C'] })],
    });
    assert.equal(run('prodStatusBucket({key:"R"})'), 'released');
    assert.equal(run('prodStatusBucket({key:"H"})'), 'code');
    assert.equal(run('prodStatusBucket({key:"C"})'), 'code');
    assert.equal(run('prodStatusBucket({key:"P"})'), 'partial');
    assert.equal(run('prodStatusBucket({key:"nothing"})'), 'none');
});

test('status label / class / tooltip tables', () => {
    const { run } = loadApp();
    const levels = ['none', 'deployed', 'released', 'partial', 'deployed_code_only'];

    assert.deepEqual(levels.map(l => run(`statusLabel("${l}")`)), ['Not deployed', 'Deployed (hidden)', 'Released', 'Partial', 'Code deployed']);
    assert.deepEqual(levels.map(l => run(`statusClass("${l}")`)), ['st-none', 'st-deployed', 'st-released', 'st-partial', 'st-deployed']);
    levels.forEach(l => assert.ok(run(`statusLabelTooltip("${l}")`).length > 10));
    assert.equal(run('statusLabelTooltip("bogus")'), '');
    assert.equal(run('statusLabel("bogus")'), undefined);
    assert.equal(run('statusClass("bogus")'), undefined);

    assert.match(run('driftNoteTooltip("files","qa")'), /content differs between this environment's deployed commit and qa's/);
    assert.match(run('driftNoteTooltip("unknown","qa")'), /could not be compared reliably/);
    assert.match(run('driftNoteTooltip("history","qa")'), /counts commits, not code/);
    assert.match(run('driftNoteTooltip("historySameVersion","qa")'), /same version name/);
    assert.match(run('driftNoteTooltip("scope","qa")'), /does not confirm/);
    assert.equal(run('driftNoteTooltip("other","qa")'), '');
});

test('jiraStatusTagClass / jiraStatusTagHtml / subtasksTagHtml', () => {
    const { run } = loadApp();

    assert.equal(run('jiraStatusTagClass(null)'), '');
    assert.equal(run('jiraStatusTagClass("")'), '');
    for (const s of ['Done', 'ready for prod', 'READY FOR PROD']) assert.equal(run(`jiraStatusTagClass("${s}")`), 'tag-status-done');
    for (const s of ['In Development', 'In Progress', 'in test']) assert.equal(run(`jiraStatusTagClass("${s}")`), 'tag-status-inprogress');
    assert.equal(run('jiraStatusTagClass("Blocked")'), 'tag-status-blocked');
    assert.equal(run('jiraStatusTagClass("Weird")'), '');

    assert.equal(run('String(jiraStatusTagHtml(null, true))'), '');
    assert.equal(run('String(jiraStatusTagHtml("Done", false))'), '<span class="tag tag-status-done" title="Jira status">Done</span>');
    const flagged = run('String(jiraStatusTagHtml("<b>", true))');

    assert.match(flagged, /tag-flagged/);
    assert.match(flagged, /<svg/);
    assert.match(flagged, /&lt;b&gt;/);

    assert.equal(run('String(subtasksTagHtml(null))'), '');
    assert.match(run('String(subtasksTagHtml({done:2,total:2}))'), /tag-status-done.*2\/2 sub-tasks/);
    assert.match(run('String(subtasksTagHtml({done:1,total:2}))'), /tag-status-inprogress.*1\/2 sub-tasks/);
});

test('issueEnvDate / issueLastChange', () => {
    const { j, run, setState } = loadApp();
    const flagsMeta = { f1: { jiraKeys: ['K-1'], components: ['a', 'b'] } };

    // flag-based: latest of every deployedAt and flag changedAt
    setState({
        flagsMeta, flagStates: { f1: { prod: { build: { enabled: true, changedAt: daysAgo(1) } }, qa: { build: { enabled: true } } } },
        deployments: [dep('a', 'prod', { relatedIssues: ['K-1'], deployedAt: daysAgo(3) }), dep('b', 'prod', { relatedIssues: ['K-1'], deployedAt: daysAgo(2) }),
            dep('a', 'qa', { relatedIssues: ['K-1'], deployedAt: daysAgo(6) })],
    });
    // the flag flip (1 day ago, under envEntry.build) is newer than every deployment, so it wins
    assert.equal(run('issueEnvDate({key:"K-1"},"prod").toISOString()'), daysAgo(1));
    assert.equal(run('issueEnvDate({key:"K-1"},"qa").toISOString()'), daysAgo(6));
    assert.equal(run('issueEnvDate({key:"K-1"},"test")'), null);
    assert.equal(run('issueLastChange({key:"K-1"}).toISOString()'), daysAgo(1));

    // flagless: raw deployments (later one wins; earlier considered without replacing)
    setState({ deployments: [dep('a', 'prod', { relatedIssues: ['K-2'], deployedAt: daysAgo(2) }), dep('a', 'prod', { relatedIssues: ['K-2'], deployedAt: daysAgo(4) }),
        dep('a', 'prod', { relatedIssues: ['K-2'], status: 'failure', deployedAt: daysAgo(0) })] });
    assert.equal(run('issueEnvDate({key:"K-2"},"prod").toISOString()'), daysAgo(2));
    assert.equal(run('issueLastChange({key:"K-nothing"})'), null);
    assert.deepEqual(j('issueLastChange({key:"K-2"}) && true'), true);

    // deployedAt missing is ignored
    setState({ deployments: [dep('a', 'prod', { relatedIssues: ['K-3'], deployedAt: null })] });
    assert.equal(run('issueEnvDate({key:"K-3"},"prod")'), null);
});


test('isRealPi', () => {
    const { run } = loadApp();

    for (const v of ['PI-24.4', 'pi-1.2', 'PI24.4', 'x PI-1.1', 'Sprint 5', 'PAY Sprint 1']) assert.equal(run(`isRealPi(${JSON.stringify(v)})`), true, v);
    for (const v of [null, undefined, '', '—']) assert.equal(run(`isRealPi(${JSON.stringify(v ?? null)})`), false);
});

test('compareVersionDesc ordering and tiebreaks', () => {
    const { run, j } = loadApp();
    const cmp = (a, b) => run(`compareVersionDesc(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    const sorted = list => j(`${JSON.stringify(list)}.sort(compareVersionDesc)`);

    assert.deepEqual(sorted(['PI-26.5', 'PI-27.2', 'PI-27.10', 'PI-27.3']), ['PI-27.10', 'PI-27.3', 'PI-27.2', 'PI-26.5']);
    assert.deepEqual(sorted(['Sparks 27.2.1', 'Sparks 27.2.3', 'Sparks 27.2.2']), ['Sparks 27.2.3', 'Sparks 27.2.2', 'Sparks 27.2.1']);
    assert.ok(cmp('PI-27.3', 'PI-27.2') < 0);
    assert.equal(cmp('PI-27.3', 'PI-27.3'), 0);
    // no digits sorts last, in either argument position
    assert.equal(cmp('Unassigned', 'PI-1.1'), 1);
    assert.equal(cmp('PI-1.1', 'Unassigned'), -1);
    // both without digits -> string descending
    assert.ok(cmp('Alpha', 'Beta') > 0);
    assert.ok(cmp('Beta', 'Alpha') < 0);
    // shared numeric prefix, different tail -> string tiebreak (deterministic)
    assert.notEqual(cmp('Sprint 27.2', '27.2.3 Sprint'), 0);
});

test('typeSortRank and groupIssuesByEpic', () => {
    const { j, run } = loadApp();

    assert.deepEqual(['Epic', 'Bug', 'Story', 'Task', 'Other'].map(t => run(`typeSortRank("${t}")`)), [0, 1, 2, 3, 4]);

    const out = j(`groupIssuesByEpic([
        { key: 'T1', type: 'Task', epicKey: 'E-1', epicTitle: 'From child' },
        { key: 'E-1', type: 'Epic', title: 'Epic one' },
        { key: 'S1', type: 'Story', epicKey: 'E-1' },
        { key: 'B1', type: 'Bug', epicKey: 'E-1' },
        { key: 'S2', type: 'Story', epicKey: 'E-2', epicTitle: 'Headerless' },
        { key: 'E-3', type: 'Epic' },
        { key: 'S3', type: 'Story', epicKey: 'E-3' },
        { key: 'T2', type: 'Task' }, { key: 'B2', type: 'Bug' }, { key: 'S4', type: 'Story' },
    ])`);

    assert.deepEqual(out.groups.map(g => g.epicKey), ['E-1', 'E-2', 'E-3']);
    assert.equal(out.groups[0].epicTitle, 'From child', 'first non-empty title wins');
    assert.equal(j("groupIssuesByEpic([{key:'c',type:'Task',epicKey:'E-4'},{key:'E-4',type:'Epic',title:'Late title'}]).groups[0].epicTitle"), 'Late title');
    assert.deepEqual(out.groups[0].children.map(c => c.key), ['B1', 'S1', 'T1']);
    assert.equal(out.groups[0].epicIssue.key, 'E-1');
    assert.equal(out.groups[1].epicIssue, null);
    assert.equal(out.groups[1].epicTitle, 'Headerless');
    assert.equal(out.groups[2].epicTitle, null);
    assert.deepEqual(out.ungrouped.map(i => i.key), ['B2', 'S4', 'T2']);
    assert.deepEqual(j('groupIssuesByEpic([])'), { groups: [], ungrouped: [] });
});

test('epicRollup / epicHasOpenBug', () => {
    const { j, run, setState } = loadApp();

    setState({
        flagsMeta: { f1: { jiraKeys: ['R'], components: ['a'] } }, flagStates: { f1: flagState(true) },
        deployments: [dep('a', 'prod', { relatedIssues: ['R', 'C'] })],
    });
    assert.equal(run('epicRollup([])'), null);
    assert.deepEqual(j('epicRollup([{key:"R"},{key:"C"},{key:"N"}])'), { released: 1, code: 1, total: 3 });

    assert.equal(run('epicHasOpenBug([])'), false);
    assert.equal(run('epicHasOpenBug([{type:"Story",statusCategory:"new"}])'), false);
    assert.equal(run('epicHasOpenBug([{type:"Bug",statusCategory:"done"}])'), false);
    assert.equal(run('epicHasOpenBug([{type:"Story"},{type:"Bug",statusCategory:"indeterminate"}])'), true);
    assert.equal(run('epicHasOpenBug([{type:"Bug"}])'), true);
});

test('ghostFlagAge', () => {
    const { j, run, setState } = loadApp();
    const flagsMeta = { f1: { jiraKeys: ['K'], components: ['a'] }, f2: { jiraKeys: ['M'], components: ['a', 'b'] } };

    assert.equal(run('GHOST_FLAG_DAYS'), 30);

    // deployed, flag off for 35 days (changed after deploy) -> 35
    setState({ flagsMeta, flagStates: { f1: flagState(false, daysAgo(35)) }, deployments: [dep('a', 'prod', { relatedIssues: ['K'], deployedAt: daysAgo(50) })] });
    assert.deepEqual(j('ghostFlagAge({key:"K"},"prod")'), { days: 35 });

    // deployed 40 days ago, flag changed even earlier -> deployedAt dominates
    setState({ flagsMeta, flagStates: { f1: flagState(false, daysAgo(90)) }, deployments: [dep('a', 'prod', { relatedIssues: ['K'], deployedAt: daysAgo(40) })] });
    assert.deepEqual(j('ghostFlagAge({key:"K"},"prod")'), { days: 40 });

    // no flag state at all -> deployedAt used
    setState({ flagsMeta, deployments: [dep('a', 'prod', { relatedIssues: ['K'], deployedAt: daysAgo(31) })] });
    assert.deepEqual(j('ghostFlagAge({key:"K"},"prod")'), { days: 31 });

    // below threshold
    setState({ flagsMeta, flagStates: { f1: flagState(false, daysAgo(2)) }, deployments: [dep('a', 'prod', { relatedIssues: ['K'], deployedAt: daysAgo(50) })] });
    assert.equal(run('ghostFlagAge({key:"K"},"prod")'), null);

    // released / none / code-only levels are not ghosts
    setState({ flagsMeta, flagStates: { f1: flagState(true, daysAgo(60)) }, deployments: [dep('a', 'prod', { relatedIssues: ['K'], deployedAt: daysAgo(60) })] });
    assert.equal(run('ghostFlagAge({key:"K"},"prod")'), null);
    setState({ flagsMeta });
    assert.equal(run('ghostFlagAge({key:"K"},"prod")'), null);
    setState({ deployments: [dep('a', 'prod', { relatedIssues: ['X'], deployedAt: daysAgo(60) })] });
    assert.equal(run('ghostFlagAge({key:"X"},"prod")'), null);

    // historical record without deployedAt -> no stuck links
    setState({ flagsMeta, flagStates: { f1: flagState(false, daysAgo(60)) }, issueDeployments: { K: { prod: { a: { commitUrl: 'u' } } } } });
    assert.equal(run('ghostFlagAge({key:"K"},"prod")'), null);

    // partial: the youngest stuck link decides (min over links); the released link is ignored
    setState({ flagsMeta, flagStates: { f2: flagState(true, daysAgo(1)) }, deployments: [dep('a', 'prod', { relatedIssues: ['M'], deployedAt: daysAgo(45) })] });
    assert.equal(run('ghostFlagAge({key:"M"},"prod")'), null, 'partial but no deployed-and-off link');
    setState({ flagsMeta, flagStates: { f2: flagState(false, daysAgo(40)) }, deployments: [dep('a', 'prod', { relatedIssues: ['M'], deployedAt: daysAgo(45) })] });
    assert.deepEqual(j('ghostFlagAge({key:"M"},"prod")'), { days: 40 });
    setState({ flagsMeta, flagStates: { f2: flagState(false, daysAgo(33)) },
        deployments: [dep('a', 'prod', { relatedIssues: ['M'], deployedAt: daysAgo(80) }), dep('b', 'prod', { relatedIssues: ['M'], deployedAt: daysAgo(70) })] });
    assert.deepEqual(j('ghostFlagAge({key:"M"},"prod")'), { days: 33 });
});

test('currentPi / sprintsForSelectedPi / currentSprintNames / selectedSprintNames', () => {
    const { j, run, setState } = loadApp();
    const sprints = [
        { name: 'S1', startDate: daysAgo(30), endDate: daysAgo(16) },
        { name: 'S2', startDate: daysAgo(15), endDate: daysAgo(1) },
        { name: 'Undated', startDate: null, endDate: null },
    ];

    setState({});
    assert.equal(run('currentPi()'), null);
    setState({ jiraIndex: {} });
    assert.equal(run('currentPi()'), null);
    assert.deepEqual(j('sprintsForSelectedPi()'), []);
    setState({ jiraIndex: { currentPi: 'P1', pis: [{ pi: 'P1', sprints }, { pi: 'P2' }], }, selectedPi: 'P1' });
    assert.equal(run('currentPi()'), 'P1');
    assert.equal(run('sprintsForSelectedPi().length'), 3);
    setState({ jiraIndex: { currentPi: 'P1', pis: [{ pi: 'P1', sprints }, { pi: 'P2' }] }, selectedPi: 'P2' });
    assert.deepEqual(j('sprintsForSelectedPi()'), []);
    setState({ jiraIndex: { currentPi: 'P1' }, selectedPi: 'P1' });
    assert.deepEqual(j('sprintsForSelectedPi()'), []);

    // gap between sprints -> most recently started
    setState({ jiraIndex: { currentPi: 'P1', pis: [{ pi: 'P1', sprints }] }, selectedPi: 'P1' });
    assert.deepEqual(j('currentSprintNames()'), ['S2']);

    // today inside both of two overlapping sprints -> both
    const overlap = [{ name: 'A', startDate: daysAgo(5), endDate: iso(NOW + DAY) }, { name: 'B', startDate: daysAgo(2), endDate: iso(NOW + 5 * DAY) }, ...sprints];

    setState({ jiraIndex: { currentPi: 'P1', pis: [{ pi: 'P1', sprints: overlap }] }, selectedPi: 'P1' });
    assert.deepEqual(j('currentSprintNames()'), ['A', 'B']);

    // not the org's current PI, no selected PI, or no dated sprints -> none
    setState({ jiraIndex: { currentPi: 'P9', pis: [{ pi: 'P1', sprints }] }, selectedPi: 'P1' });
    assert.deepEqual(j('currentSprintNames()'), []);
    setState({ jiraIndex: { currentPi: null, pis: [] }, selectedPi: null });
    assert.deepEqual(j('currentSprintNames()'), []);
    setState({ jiraIndex: { currentPi: 'P1', pis: [{ pi: 'P1', sprints: [sprints[2]] }] }, selectedPi: 'P1' });
    assert.deepEqual(j('currentSprintNames()'), []);

    setState({ selectedSprint: '' });
    assert.equal(run('selectedSprintNames()'), null);
    setState({ selectedSprint: 'S1' });
    assert.deepEqual(j('selectedSprintNames()'), ['S1']);
    assert.equal(run('SPRINT_ALL'), '');
    assert.equal(run('SPRINT_CURRENT_PLUS_UNRESOLVED'), '__current_plus_unresolved__');
});

test('issuesInSprintScope: all, literal sprint, and hybrid current + unresolved', () => {
    const { j, run, setState } = loadApp();
    const sprints = [{ name: 'S1', startDate: daysAgo(30), endDate: daysAgo(16) }, { name: 'S2', startDate: daysAgo(3), endDate: iso(NOW + 5 * DAY) }];
    const issues = [
        { key: 'cur-done', sprint: 'S2', pi: 'PI-1.1' },
        { key: 'old-released', sprint: 'S1', pi: 'PI-1.1' },
        { key: 'old-open', sprint: 'S1', pi: 'PI-1.1' },
        { key: 'old-open-nopi', sprint: 'S1', pi: '—' },
        { key: 'epic-nosprint', pi: 'PI-1.1' },
    ];
    const common = {
        jiraIndex: { currentPi: 'PI-1.1', pis: [{ pi: 'PI-1.1', sprints }] }, selectedPi: 'PI-1.1',
        flagsMeta: { f1: { jiraKeys: ['old-released'], components: ['a'] } }, flagStates: { f1: flagState(true) },
        deployments: [dep('a', 'prod', { relatedIssues: ['old-released'] })],
    };
    const keys = () => j(`issuesInSprintScope(${JSON.stringify(issues)}).map(i => i.key)`);

    setState({ ...common, selectedSprint: '' });
    assert.equal(keys().length, 5);
    setState({ ...common, selectedSprint: 'S1' });
    assert.deepEqual(keys(), ['old-released', 'old-open', 'old-open-nopi']);
    setState({ ...common, selectedSprint: 'Nope' });
    assert.deepEqual(keys(), []);
    setState({ ...common, selectedSprint: '__current_plus_unresolved__' });
    assert.deepEqual(keys(), ['cur-done', 'old-open', 'epic-nosprint']);

    // no current sprint resolvable: only unresolved issues remain
    setState({ ...common, selectedPi: 'PI-0.9', selectedSprint: '__current_plus_unresolved__' });
    assert.deepEqual(keys(), ['cur-done', 'old-open', 'epic-nosprint']);
    assert.equal(run('typeof piWorkItemCounts'), 'function');
});

test('piContinuationBadge', () => {
    const { run, setState } = loadApp();

    setState({ selectedPi: 'PI-1.1', issueStatusIndex: { A: { pi: 'PI-1.1' }, B: { pi: 'PI-1.2' }, C: { pi: null }, D: { pi: '<x>' } } });
    assert.equal(run('piContinuationBadge("zzz")'), '');
    assert.equal(run('piContinuationBadge("A")'), '');
    assert.equal(run('piContinuationBadge("C")'), '');
    assert.match(run('String(piContinuationBadge("B"))'), /Continued in PI-1\.2/);
    assert.match(run('String(piContinuationBadge("D"))'), /Continued in &lt;x&gt;/);

    // "Now" joins every team's current increment: an issue in any of them is not "continued" elsewhere.
    setState({
        selectedPi: '@now', issueStatusIndex: { A: { pi: 'PI-1.1' }, S: { pi: 'PAY Sprint 1' }, B: { pi: 'PI-1.2' } },
        jiraIndex: { currentPi: '@now', pis: [{ pi: '@now', label: 'Now: PI-1.1, PAY Sprint 1', includes: ['PI-1.1', 'PAY Sprint 1'] }, { pi: 'PI-1.1' }] },
    });
    assert.equal(run('piContinuationBadge("A")'), '');
    assert.equal(run('piContinuationBadge("S")'), '');
    assert.match(run('String(piContinuationBadge("B"))'), /Continued in PI-1\.2/);
    assert.equal(run('incrementLabel("@now")'), 'Now: PI-1.1, PAY Sprint 1');
    assert.equal(run('incrementLabel("PI-1.1")'), 'PI-1.1');
    assert.deepEqual(JSON.parse(run('JSON.stringify(selectedIncrements())')), ['PI-1.1', 'PAY Sprint 1']);
});

test('piWorkItemCounts excludes epics and honours the sprint scope', () => {
    const { j, setState } = loadApp();

    setState({
        flagsMeta: { f1: { jiraKeys: ['R'], components: ['a'] }, f2: { jiraKeys: ['H'], components: ['a'] } }, flagStates: { f1: flagState(true), f2: flagState(false) },
        deployments: [dep('a', 'prod', { relatedIssues: ['R', 'H'] })], selectedSprint: 'S1',
        jiraIssues: [{ key: 'R', type: 'Story', sprint: 'S1' }, { key: 'H', type: 'Bug', sprint: 'S1' }, { key: 'N', type: 'Task', sprint: 'S1' },
            { key: 'E', type: 'Epic', sprint: 'S1' }, { key: 'other', type: 'Task', sprint: 'S2' }],
    });
    assert.deepEqual(j('piWorkItemCounts()'), { counts: { released: 1, code: 1, partial: 0, none: 1 }, total: 3 });
    setState({ jiraIssues: [], selectedSprint: '' });
    assert.deepEqual(j('piWorkItemCounts()'), { counts: { released: 0, code: 0, partial: 0, none: 0 }, total: 0 });
});
