// Tests docs/app-core.js and docs/app-data.js (vm + stub DOM, fake clock, mocked fetch).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime();

function stubElement() {
    const classes = new Set();
    const el = {
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, force) => ((force === undefined ? !classes.has(c) : force) ? classes.add(c) : classes.delete(c)) },
        style: {}, dataset: {}, attrs: {}, children: [], textContent: '', innerHTML: '', title: '',
        addEventListener() {}, appendChild(c) { el.children.push(c); },
        getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; }, setAttribute(k, v) { el.attrs[k] = v; },
    };

    return el;
}

function loadApp({ fetchImpl, storageThrows, loc } = {}) {
    const boxes = {};
    const stored = {};
    class FakeDate extends Date {
        constructor(...a) { if (a.length) { super(...a); } else { super(NOW); } }
        static now() { return NOW; }
    }
    const ctx = {
        console, URLSearchParams, Math, Map, Set, Promise, Date: FakeDate, location: loc || { search: '' },
        localStorage: { getItem: () => null, setItem(k, v) { if (storageThrows) throw new Error('quota'); stored[k] = v; } },
        fetch: fetchImpl || (() => Promise.reject(new Error('no network'))),
        document: { documentElement: stubElement(), getElementById: id => boxes[id] || (boxes[id] = stubElement()) },
    };

    vm.createContext(ctx);
    ['app-html', 'app-icons', 'app-core', 'app-components', 'app-data', 'app-model'].forEach(f =>
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs', `${f}.js`), 'utf8'), ctx, { filename: require('node:url').pathToFileURL(path.join(__dirname, '..', 'docs', `${f}.js`)).href }));
    vm.runInContext('const FALLBACK = buildFallbackData();', ctx);

    return { ctx, boxes, stored, run: code => vm.runInContext(code, ctx) };
}

test('initTheme toggles theme, titles, aria-label and persists (also when storage throws)', () => {
    const { boxes, stored, ctx } = loadApp();
    const root = ctx.document.documentElement;
    const btn = boxes.themeToggle;

    assert.equal(btn.title, 'Switch to light theme');
    btn.onclick();
    assert.equal(root.attrs['data-theme'], 'light');
    assert.equal(btn.title, 'Switch to dark theme');
    assert.equal(btn.attrs['aria-label'], 'Switch to dark theme');
    assert.equal(stored['shipscope-theme'], 'light');
    btn.onclick();
    assert.equal(root.attrs['data-theme'], 'dark');
    assert.equal(stored['shipscope-theme'], 'dark');

    const t = loadApp({ storageThrows: true });

    t.ctx.document.documentElement.setAttribute('data-theme', 'light');
    t.boxes.themeToggle.onclick();
    assert.equal(t.ctx.document.documentElement.attrs['data-theme'], 'dark');
});

test('initTheme reflects a pre-applied light theme in the button title', () => {
    const boxes = {};
    const root = stubElement();

    root.setAttribute('data-theme', 'light');

    const ctx = { console, URLSearchParams, location: { search: '' }, localStorage: { setItem() {} },
        document: { documentElement: root, getElementById: id => boxes[id] || (boxes[id] = stubElement()) } };

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs', 'app-core.js'), 'utf8'), ctx);
    assert.equal(boxes.themeToggle.title, 'Switch to dark theme');
});

test('barsIcon lights the first N bars; ENV_BAR_COUNT and ICONS shape (every icon already raw())', () => {
    const { run } = loadApp();
    const svg = run('String(barsIcon(2))');

    assert.equal((svg.match(/#ECEEF1/g) || []).length, 2);
    assert.equal((svg.match(/#33373D/g) || []).length, 1);
    assert.equal((run('String(barsIcon(0))').match(/#ECEEF1/g) || []).length, 0);
    assert.equal((run('String(barsIcon(3))').match(/#33373D/g) || []).length, 0);
    assert.deepEqual(JSON.parse(run('JSON.stringify(ENV_BAR_COUNT)')), { test: 1, qa: 2, prod: 3 });
    assert.deepEqual(JSON.parse(run('JSON.stringify(ENVIRONMENTS)')), ['test', 'qa', 'prod']);
    assert.ok(run('Object.values(ICONS).every(v => v instanceof SafeHtml && v.value.startsWith("<svg"))'));
    assert.ok(run('barsIcon(1) instanceof SafeHtml && envBadgeIcon(1) instanceof SafeHtml'));
    assert.ok(run('String(html`<i>${ICONS.flag}</i>`).startsWith("<i><svg")'), 'goes into html unescaped, no raw() needed');
    assert.ok(run('["external","manual","chevron","chevronDown","warn","flag","hourglass","bug","check"].every(k => k in ICONS)'));
});

test('feature switches', () => {
    assert.equal(loadApp().run('INSIGHTS_ENABLED'), false);
    assert.equal(loadApp().run('DEFAULT_VIEW'), 'tech');
});

test('effectiveFlagState prefers runtime-be, then build, else null', () => {
    const { run } = loadApp();

    assert.equal(run('effectiveFlagState(null)'), null);
    assert.equal(run('effectiveFlagState(undefined)'), null);
    assert.equal(run('effectiveFlagState({})'), null);
    assert.equal(run('JSON.stringify(effectiveFlagState({build:{enabled:true}}))'), '{"enabled":true,"source":"build"}');
    assert.equal(run('JSON.stringify(effectiveFlagState({build:{enabled:true},"runtime-be":{enabled:false}}))'), '{"enabled":false,"source":"runtime-be"}');
});

test('date/time formatters with a fixed clock', () => {
    const { run } = loadApp();
    const iso = new Date(2026, 9, 9, 8, 5, 0).toISOString();

    assert.match(run(`fmtDateShort("${iso}")`), /09\.10\.2026/);
    assert.match(run(`fmtTime("${iso}")`), /08:05/);
    assert.equal(run(`dayKey("${iso}")`), '2026-9-9');

    assert.match(run(`dayHeadLabel("${iso}")`), /^Today · Friday, 09\.10\.2026$/);
    assert.match(run(`dayHeadLabel("${new Date(2026, 9, 8, 9).toISOString()}")`), /^Yesterday · Thursday, 08\.10\.2026$/);
    assert.match(run(`dayHeadLabel("${new Date(2026, 8, 1, 9).toISOString()}")`), /^Tuesday, 01\.09\.2026$/);
});

test('relTime buckets', () => {
    const { run } = loadApp();
    const ago = s => new Date(NOW - s * 1000).toISOString();

    assert.equal(run(`relTime("${ago(5)}")`), 'just now');
    assert.equal(run(`relTime("${ago(120)}")`), '2 min ago');
    assert.equal(run(`relTime("${ago(7300)}")`), '2 hr ago');
    assert.equal(run(`relTime("${ago(86400)}")`), '1 day ago');
    assert.equal(run(`relTime("${ago(86400 * 5)}")`), '5 days ago');
});

test('fmtDuration', () => {
    const { run } = loadApp();

    assert.equal(run('fmtDuration(0)'), null);
    assert.equal(run('fmtDuration(undefined)'), null);
    assert.equal(run('fmtDuration(45000)'), '45s');
    assert.equal(run('fmtDuration(65000)'), '1m 5s');
});

test('buildFallbackData returns a coherent dataset', () => {
    const { run } = loadApp();
    const out = JSON.parse(run(`JSON.stringify((() => { const f = buildFallbackData();
        return { keys: Object.keys(f), pis: f.jiraIndex.pis.map(p => p.pi), current: f.jiraIndex.currentPi,
          byPi: [...f.jiraIssuesByPi.keys()], nDeps: f.deployments.length, nIssues: [...f.jiraIssuesByPi.values()].flat().length,
          sprintDates: f.jiraIndex.pis[0].sprints, idx: f.issueStatusIndex['EBO-16955'], jiraBrowseUrl: f.jiraBrowseUrl, nullSprintPi: f.jiraIndex.pis.find(p => p.pi === 'PI-27.1').sprints }; })())`));

    assert.deepEqual(out.keys.sort(), ['componentsOrder', 'deployments', 'flagFreshness', 'flagStateHistory', 'flagStates', 'flagsMeta', 'issueDeployments', 'issueStatusIndex', 'jiraBrowseUrl', 'jiraIndex', 'jiraIssuesByPi']);
    assert.equal(out.current, 'PI-27.3');
    assert.deepEqual(out.pis, ['PI-27.3', 'PI-27.2', 'PI-27.1', 'PI-26.5']);
    assert.deepEqual(out.byPi.sort(), ['PI-26.5', 'PI-27.1', 'PI-27.2', 'PI-27.3']);
    assert.ok(out.nDeps > 20 && out.nIssues > 40);
    assert.equal(out.idx.pi, 'PI-27.3');
    assert.equal(out.idx.statusCategory, 'done');
    assert.equal(out.jiraBrowseUrl, null, 'sample issue keys are not linked to any real Jira');
    assert.ok(out.sprintDates.some(s => s.startDate && s.endDate), 'dated sprints exist');
    assert.ok(out.nullSprintPi.every(s => s.startDate === null), 'undated sprints exist');
    assert.deepEqual(out.nullSprintPi.map(s => s.name).sort(), ['Sparks PI-27.1.4', 'Sparks PI-27.1.5']);
});

test('loadData off the server: the built-in sample data, no requests, a "Sample" badge', async () => {
    const urls = [];
    const { run, boxes } = loadApp({ fetchImpl: (url) => { urls.push(url); return Promise.reject(new Error('unexpected')); } });
    const out = await run('loadData()');

    assert.equal(out.isFallback, true);
    assert.ok(out.deployments.length > 0);
    assert.deepEqual(urls, [], 'no data/*.json requests');
    assert.equal(boxes.statusBadgeLabel.textContent, 'Sample');
    assert.ok(boxes.statusBadge.classList.contains('fallback'));
    assert.match(boxes.statusBadge.title, /Sample data/);
    assert.equal(boxes.settingsLink, undefined, 'no settings page off the server: the link is never shown');
});

test('loadJiraIssuesForPi: empty pi, sample data, unknown increment', async () => {
    const { run } = loadApp();

    assert.equal((await run('loadJiraIssuesForPi(null)')).length, 0);
    assert.equal((await run('loadJiraIssuesForPi("")')).length, 0);

    run('state = { isFallback: true }');
    assert.ok((await run('loadJiraIssuesForPi("PI-27.3")')).length > 0);
    assert.equal((await run('loadJiraIssuesForPi("PI-nope")')).length, 0);
});

// SaaS mode: the page served by the ShipScope server at /t/<tenantId>/ loads its data from the API.
const TENANT = '0b0e4c3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d';
const apiLocation = (extra = {}) => ({ search: '', pathname: `/t/${TENANT}/`, assigned: [], assign(url) { this.assigned.push(url); }, ...extra });
const jsonResponse = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

test('jiraIssueUrl: the tenant\'s own Jira site in API mode, none until Jira is connected, none for the sample data', async () => {
    const sample = loadApp();
    assert.equal(sample.run('jiraIssueUrl("ABC-1")'), null, 'before any data');
    await sample.run('loadData().then((d) => { state = d; })');
    assert.equal(sample.run('jiraIssueUrl("ABC-1")'), null, 'sample data: unlinked');

    const tenant = loadApp({ fetchImpl: () => jsonResponse({ jiraBrowseUrl: 'https://acme.atlassian.net/browse' }), loc: apiLocation() });
    tenant.run('state = null');
    await tenant.run('loadData().then((d) => { state = d; })');
    assert.equal(tenant.run('jiraIssueUrl("ABC-1")'), 'https://acme.atlassian.net/browse/ABC-1');

    for (const fetchImpl of [() => jsonResponse({}), () => jsonResponse({}, 500)]) {
        const bare = loadApp({ fetchImpl, loc: apiLocation() });
        await bare.run('loadData().then((d) => { state = d; })');
        assert.equal(bare.run('jiraIssueUrl("ABC-1")'), null, 'no Jira connected (or no data): unlinked, never another org\'s site');
    }
});

test('API mode: one request to the tenant API, live badge with the last sync time, missing keys defaulted', async () => {
    const urls = [];
    const fetchImpl = (url) => {
        urls.push(url);
        return jsonResponse({
            deployments: [{ id: 'gh-1', component: 'web', environment: 'prod', status: 'success' }],
            componentsOrder: [{ name: 'web' }],
            lastSyncedAt: '2026-10-09T05:30:00Z',
        });
    };
    const { boxes, run } = loadApp({ fetchImpl, loc: apiLocation() });
    const out = JSON.parse(JSON.stringify(await run('loadData()')));

    assert.deepEqual(urls, [`/api/tenants/${TENANT}/dashboard-data`], 'no data/*.json requests');
    assert.equal(out.isFallback, false);
    assert.equal(out.deployments.length, 1);
    assert.deepEqual(out.flagsMeta, {});
    assert.deepEqual(out.jiraIndex, { currentPi: null, pis: [] });
    assert.equal(boxes.statusBadgeLabel.textContent, 'Live');
    assert.match(boxes.statusBadgeTime.textContent, /^synced \d\d:\d\d · source: ShipScope API$/);
    assert.equal(boxes.settingsLink.hidden, false, 'the server\'s settings page is linked');
    assert.equal(boxes.setupBanner.hidden, true, 'data: no "finish setting up" banner');
});

test('API mode with npm run dev:mock: a "Mock" badge, not "Live"', async () => {
    const { boxes, run } = loadApp({ fetchImpl: () => jsonResponse({ mock: true, deployments: [{ id: 'd1' }], lastSyncedAt: '2026-10-09T05:30:00Z' }), loc: apiLocation() });
    await run('loadData()');
    assert.equal(boxes.statusBadgeLabel.textContent, 'Mock');
    assert.equal(boxes.statusBadgeTime.textContent, 'source: sample data');
    assert.ok(boxes.statusBadge.classList.contains('fallback'));
    assert.match(boxes.statusBadge.title, /dev:mock/);
});

test('API mode: a workspace with no data yet points at its setup checklist; any data hides the banner', async () => {
    for (const [body, hidden] of [
        [{}, false],
        [{ deployments: [], flagsMeta: {}, jiraIndex: { currentPi: null, pis: [] } }, false],
        [{ flagsMeta: { newCheckout: {} } }, true],
        [{ jiraIndex: { currentPi: 'PI-1', pis: [{ pi: 'PI-1' }] } }, true],
    ]) {
        const { boxes, run } = loadApp({ fetchImpl: () => jsonResponse(body), loc: apiLocation() });
        await run('loadData()');
        assert.equal(boxes.setupBanner.hidden, hidden, JSON.stringify(body));
    }
    const off = loadApp({ fetchImpl: () => jsonResponse({}, 500), loc: apiLocation() });
    await off.run('loadData()');
    assert.equal(off.boxes.setupBanner, undefined, 'an error is not "no data yet"');
});

test('API mode: one PI\'s issues come from the tenant API, never from data/jira-issues/*.json', async () => {
    const urls = [];
    const fetchImpl = (url, init) => {
        urls.push([url, init && init.credentials]);
        return url.includes('PI-27.3') ? jsonResponse([{ key: 'ABC-1' }]) : url.includes('broken') ? jsonResponse({}, 500) : Promise.reject(new Error('offline'));
    };
    const { run } = loadApp({ fetchImpl, loc: apiLocation() });
    run('state = { isFallback: false, jiraIndex: { pis: [{ pi: "PI-27.3", file: "PI-27.3.json" }, { pi: "broken", file: "x.json" }, { pi: "Sprint 4", file: "y.json" }] } }');
    assert.deepEqual(JSON.parse(JSON.stringify(await run('loadJiraIssuesForPi("PI-27.3")'))), [{ key: 'ABC-1' }]);
    assert.equal((await run('loadJiraIssuesForPi("broken")')).length, 0);
    assert.equal((await run('loadJiraIssuesForPi("Sprint 4")')).length, 0);
    assert.equal((await run('loadJiraIssuesForPi("missing")')).length, 0, 'not in the index: no request');
    assert.deepEqual(urls, [
        [`/api/tenants/${TENANT}/jira-issues?pi=PI-27.3`, 'same-origin'],
        [`/api/tenants/${TENANT}/jira-issues?pi=broken`, 'same-origin'],
        [`/api/tenants/${TENANT}/jira-issues?pi=Sprint%204`, 'same-origin'],
    ]);
});

test('API mode: never falls back to the sample data -- an error shows an empty dashboard with an error badge', async () => {
    for (const fetchImpl of [() => jsonResponse({}, 500), () => Promise.reject(new Error('offline'))]) {
        const { boxes, run } = loadApp({ fetchImpl, loc: apiLocation() });
        const out = await run('loadData()');
        assert.equal(out.isFallback, false);
        assert.equal(out.deployments.length, 0, 'no sample deployments');
        assert.equal(boxes.statusBadgeLabel.textContent, 'Error');
        assert.ok(boxes.statusBadge.classList.contains('fallback'));
        assert.match(boxes.statusBadge.title, /Could not load/);
    }
});

test('API mode: signed out (401) goes through sign-in and back to this dashboard', async () => {
    const loc = apiLocation();
    const { run } = loadApp({ fetchImpl: () => jsonResponse({ error: 'Not signed in' }, 401), loc });
    const pending = run('loadData()');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(loc.assigned, [`/auth/github/login?returnTo=${encodeURIComponent(`/t/${TENANT}/`)}`]);
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, 'nothing renders while the page navigates away');
});

test('outside /t/<uuid>/ the sample data is shown, even for a /t/ path without a uuid', async () => {
    const urls = [];
    const fetchImpl = (url) => { urls.push(url); return Promise.reject(new Error('no network')); };
    const { run } = loadApp({ fetchImpl, loc: { search: '', pathname: '/t/not-a-tenant/' } });
    const out = await run('loadData()');
    assert.equal(out.isFallback, true);
    assert.deepEqual(urls, []);
});
