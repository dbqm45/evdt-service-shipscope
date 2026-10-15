// Shared support module (not a test file — the npm glob only picks up *.test.js) for the "sync" test files
// that run scripts/sync-*.js / backfill-*.js as child processes. A generated --require preload replaces
// global fetch with a JSON-fixture router (no real network), freezes the clock (FAKE_NOW) and collapses
// any rate-limit backoff sleep (setTimeout >= 1s) to zero, so runs are deterministic and fast.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const PRELOAD_SOURCE = `
const fs = require('fs');
const fixture = JSON.parse(fs.readFileSync(process.env.FETCH_FIXTURE, 'utf8'));
const logFile = process.env.FETCH_LOG;
const counts = new Map();
const fixed = Date.parse(process.env.FAKE_NOW || '2026-10-09T12:00:00Z');
const RealDate = Date;
class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
}
global.Date = FakeDate;
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...a);

function matchInfo(route, url) {
    const candidates = [url];
    try { candidates.push(decodeURIComponent(url)); } catch (e) { /* ignore */ }
    if (route.re) {
        const re = new RegExp(route.re);
        for (const c of candidates) { const m = re.exec(c); if (m) return m; }
        return null;
    }
    if (route.exact) return candidates.includes(route.exact) ? [] : null;
    return candidates.some(c => c.includes(route.url)) ? [] : null;
}

global.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    fs.appendFileSync(logFile, JSON.stringify({ url, method, headers }) + '\\n');
    for (let i = 0; i < fixture.routes.length; i++) {
        const route = fixture.routes[i];
        if (route.method && route.method !== method) continue;
        const m = matchInfo(route, url);
        if (!m) continue;
        const n = counts.get(i) || 0;
        counts.set(i, n + 1);
        const resp = route.seq ? route.seq[Math.min(n, route.seq.length - 1)] : route;
        if (resp.throw) throw new Error(resp.throw);
        const hdrs = new Headers(resp.headers || {});
        if (resp.etag) {
            if (headers['If-None-Match'] === resp.etag) return new Response(null, { status: 304 });
            hdrs.set('etag', resp.etag);
        }
        const status = resp.status || 200;
        let body = resp.text !== undefined ? resp.text : (resp.body === undefined ? 'null' : JSON.stringify(resp.body));
        body = body.replace(/\\{\\$(\\d)\\}/g, (_, i) => m[Number(i)]);
        return new Response(status === 204 || status === 304 ? null : body, { status, headers: hdrs });
    }
    return new Response('no fixture for ' + url, { status: 404 });
};
`;

const SCRUBBED_ENV = [
    'GITHUB_TOKEN', 'APP_REPO', 'COMPONENT', 'DATA_PATH', 'CURSOR_PATH', 'ISSUE_DEPLOYMENTS_PATH', 'SUMMARY_PATH',
    'RETENTION_DAYS', 'STUCK_DEPLOYMENT_MAX_AGE_HOURS', 'MAX_NEW_DEPLOYMENTS_PER_RUN', 'MAX_RECORDS_PER_RUN',
    'SIZE_WARNING_THRESHOLD_MB', 'GITHUB_API_ETAG_CACHE_DIR', 'RUNNER_TEMP', 'JIRA_BASE_URL', 'JIRA_EMAIL',
    'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'DEPLOYMENTS_PATH', 'SPACES_PATH', 'JIRA_BOARD_LOOKUP_STRICT',
    'JIRA_ISSUES_DIR', 'BACKFILL_PIS',
];

function createHarness(prefix) {
    const root = path.join(__dirname, `.tmp-${prefix}-${process.pid}`);
    let counter = 0;

    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });

    const preload = path.join(root, 'preload.js');

    fs.writeFileSync(preload, PRELOAD_SOURCE);

    return {
        root,
        cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
        /** A fresh working directory (the child's cwd) plus its own RUNNER_TEMP. */
        workspace() {
            const dir = path.join(root, `w${++counter}`);

            fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'docs', 'data'), { recursive: true });

            return { dir, runnerTemp: path.join(dir, 'tmp') };
        },
        /** Runs a repo script as a child process under the fetch-fixture preload. Returns
         *  `{ status, stdout, stderr, out, calls }` where `calls` is every fetch the child made. */
        run(scriptRelPath, ws, { env = {}, routes = [], fakeNow = '2026-10-09T12:00:00Z' } = {}) {
            const fixtureFile = path.join(ws.dir, `fixture-${++counter}.json`);
            const logFile = path.join(ws.dir, `fetch-log-${counter}.ndjson`);

            fs.writeFileSync(fixtureFile, JSON.stringify({ routes }));
            fs.writeFileSync(logFile, '');

            const childEnv = { ...process.env };

            SCRUBBED_ENV.forEach(k => delete childEnv[k]);

            const res = spawnSync(
                process.execPath,
                ['--require', preload, path.join(REPO_ROOT, scriptRelPath)],
                {
                    cwd: ws.dir,
                    encoding: 'utf8',
                    env: {
                        ...childEnv,
                        RUNNER_TEMP: ws.runnerTemp,
                        FETCH_FIXTURE: fixtureFile,
                        FETCH_LOG: logFile,
                        FAKE_NOW: fakeNow,
                        ...env,
                    },
                }
            );
            const calls = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

            return { status: res.status, stdout: res.stdout, stderr: res.stderr, out: res.stdout + res.stderr, calls };
        },
        writeJson(ws, rel, value) {
            const full = path.join(ws.dir, rel);

            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        },
        readJson(ws, rel) { return JSON.parse(fs.readFileSync(path.join(ws.dir, rel), 'utf8')); },
        exists(ws, rel) { return fs.existsSync(path.join(ws.dir, rel)); },
    };
}

module.exports = { createHarness, REPO_ROOT };
