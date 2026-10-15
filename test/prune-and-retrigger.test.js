'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmp, rmTmp, runScript, write, readJ, exists } = require('./flag-scripts-helpers');

let tmp;

before(() => { tmp = makeTmp('prune'); });
after(() => rmTmp(tmp));

describe('prune-jira-pis.js (in-process helpers)', () => {
    const { parsePrunePis } = require('../scripts/prune-jira-pis');

    test('parsePrunePis normalizes, uppercases and dedupes', () => {
        const old = process.env.PRUNE_PIS;

        try {
            process.env.PRUNE_PIS = '26.4, pi-26.5  PI-26.4,27.1.2';
            assert.deepEqual(parsePrunePis(), ['PI-26.4', 'PI-26.5', 'PI-27.1.2']);
            process.env.PRUNE_PIS = '';
            assert.deepEqual(parsePrunePis(), []);
            delete process.env.PRUNE_PIS;
            assert.deepEqual(parsePrunePis(), []);
        } finally {
            if (old === undefined) delete process.env.PRUNE_PIS; else process.env.PRUNE_PIS = old;
        }
    });
});

describe('prune-jira-pis.js (child process)', () => {
    const dir = 'ji';
    const env = { JIRA_ISSUES_DIR: dir };

    function seed() {
        write(tmp, `${dir}/index.json`, {
            currentPi: 'PI-27.3',
            pis: [
                { pi: 'PI-27.3', file: 'PI-27.3.json' },
                { pi: 'PI-26.5', file: 'PI-26.5.json' },
                { pi: 'PI-26.4', file: 'PI-26.4.json' },
                { pi: 'PI-26.3', file: '../escape.json' },
            ],
        });
        for (const f of ['PI-27.3', 'PI-26.5', 'PI-26.4']) write(tmp, `${dir}/${f}.json`, []);
        write(tmp, 'escape.json', ['must survive']);
    }

    test('fails without PRUNE_PIS or index.json; rejects unsafe dir', () => {
        assert.match(runScript('prune-jira-pis.js', env, tmp).err, /No PI\(s\) given/);
        const noIndex = runScript('prune-jira-pis.js', { ...env, JIRA_ISSUES_DIR: 'nothing-here', PRUNE_PIS: '26.4' }, tmp);

        assert.equal(noIndex.code, 1);
        assert.match(noIndex.err, /does not exist — nothing to prune/);
        assert.equal(runScript('prune-jira-pis.js', { JIRA_ISSUES_DIR: '../x', PRUNE_PIS: '26.4' }, tmp).code, 1);
    });

    test('prunes shards + index entries, records exclusions, refuses current PI, never escapes the dir', () => {
        seed();
        const r = runScript('prune-jira-pis.js', { ...env, PRUNE_PIS: 'PI-27.3, 26.4 26.3 PI-25.1' }, tmp);

        assert.equal(r.code, 0, r.err);
        assert.match(r.err, /Skipping PI-27\.3 — it's the current PI/);
        assert.match(r.out, /PI-25\.1 isn't currently in .* adding it to the pruned-PI list anyway/);
        assert.match(r.out, /Pruned 2 PI shard\(s\) now, excluded 3 PI\(s\) permanently: PI-26\.4, PI-26\.3, PI-25\.1\./);
        assert.equal(exists(tmp, `${dir}/PI-26.4.json`), false);
        assert.equal(exists(tmp, `${dir}/PI-26.5.json`), true);
        assert.equal(exists(tmp, 'escape.json'), true, 'file outside the dir must not be deleted');
        const idx = readJ(tmp, `${dir}/index.json`);

        assert.equal(idx.currentPi, 'PI-27.3');
        assert.deepEqual(idx.pis.map(p => p.pi), ['PI-27.3', 'PI-26.5']);
        assert.deepEqual(readJ(tmp, `${dir}/pruned-pis.json`), ['PI-26.4', 'PI-26.3', 'PI-25.1']);
    });

    test('is idempotent: pruning again adds nothing new', () => {
        const before = fs.readFileSync(path.join(tmp, `${dir}/pruned-pis.json`), 'utf8');
        const r = runScript('prune-jira-pis.js', { ...env, PRUNE_PIS: '26.4' }, tmp);

        assert.equal(r.code, 0);
        assert.match(r.out, /Pruned 0 PI shard\(s\) now, excluded 1/);
        assert.equal(fs.readFileSync(path.join(tmp, `${dir}/pruned-pis.json`), 'utf8'), before);
    });

    test('only the current PI requested: Nothing to prune, no changes', () => {
        const before = fs.readFileSync(path.join(tmp, `${dir}/index.json`), 'utf8');
        const r = runScript('prune-jira-pis.js', { ...env, PRUNE_PIS: 'PI-27.3' }, tmp);

        assert.equal(r.code, 0);
        assert.match(r.out, /Nothing to prune/);
        assert.equal(fs.readFileSync(path.join(tmp, `${dir}/index.json`), 'utf8'), before);
    });

    test('index without a pis array and a shard file already missing', () => {
        write(tmp, 'ji2/index.json', { currentPi: null });
        const r1 = runScript('prune-jira-pis.js', { JIRA_ISSUES_DIR: 'ji2', PRUNE_PIS: '1.1' }, tmp);

        assert.equal(r1.code, 0, r1.err);
        assert.deepEqual(readJ(tmp, 'ji2/index.json'), { currentPi: null, pis: [] });

        write(tmp, 'ji3/index.json', { currentPi: 'PI-2.1', pis: [{ pi: 'PI-1.1', file: 'PI-1.1.json' }] });
        const r2 = runScript('prune-jira-pis.js', { JIRA_ISSUES_DIR: 'ji3', PRUNE_PIS: '1.1' }, tmp);

        assert.equal(r2.code, 0, r2.err);
        assert.match(r2.out, /Pruned 1 PI shard\(s\) now/);
        assert.deepEqual(readJ(tmp, 'ji3/index.json').pis, []);
    });

    test('default JIRA_ISSUES_DIR', () => {
        write(tmp, 'dflt/docs/data/jira-issues/index.json', { currentPi: 'PI-9.9', pis: [] });
        const r = runScript('prune-jira-pis.js', { PRUNE_PIS: '1.2' }, path.join(tmp, 'dflt'));

        assert.equal(r.code, 0, r.err);
        assert.deepEqual(readJ(tmp, 'dflt/docs/data/jira-issues/pruned-pis.json'), ['PI-1.2']);
    });
});

describe('retrigger-app-checks.js', () => {
    let preload;
    let logFile;
    let cfgFile;

    before(() => {
        write(tmp, 'rt/preload.js', `
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.MOCK_CFG, 'utf8'));
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => { fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ sleep: ms }) + '\\n'); return realSetTimeout(fn, 0, ...a); };
const counters = {};
global.fetch = async (url, opts = {}) => {
    fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ url, method: opts.method || 'GET', auth: opts.headers && opts.headers.Authorization }) + '\\n');
    const idx = cfg.routes.findIndex(r => url.includes(r.match));
    if (idx < 0) throw new Error('unmocked ' + url);
    const route = cfg.routes[idx];
    const n = counters[idx] = (counters[idx] || 0) + 1;
    const resp = route.responses[Math.min(n, route.responses.length) - 1];
    const headers = new Map(Object.entries(resp.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
        status: resp.status, ok: resp.status >= 200 && resp.status < 300,
        headers: { get: k => headers.has(k.toLowerCase()) ? headers.get(k.toLowerCase()) : null },
        json: async () => resp.body, text: async () => JSON.stringify(resp.body || ''),
    };
};
`);
        preload = path.join(tmp, 'rt/preload.js');
        logFile = path.join(tmp, 'rt/log.jsonl');
        cfgFile = path.join(tmp, 'rt/cfg.json');
    });

    function run(routes, extraEnv = {}) {
        fs.writeFileSync(cfgFile, JSON.stringify({ routes }));
        fs.writeFileSync(logFile, '');
        const r = runScript('retrigger-app-checks.js', {
            APP_REPO: 'org/app', APP_REPO_RERUN_TOKEN: 'tok', NODE_OPTIONS: `--require ${preload.replace(/\\/g, '/')}`,
            MOCK_CFG: cfgFile, MOCK_LOG: logFile, ...extraEnv,
        }, tmp);
        const log = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

        return { ...r, log };
    }

    const failedPr = { id: 11, status: 'completed', conclusion: 'failure', event: 'pull_request', head_sha: 'abcdef123456', pull_requests: [{ number: 5 }, { number: 6 }] };
    const runsRoute = (body, status = 200, headers) => ({ match: '/runs?status=failure', responses: [{ status, body, headers }] });

    test('selectRunsToRerun filters to completed failures of open PRs only', () => {
        const { selectRunsToRerun } = require('../scripts/retrigger-app-checks');

        assert.deepEqual(selectRunsToRerun([
            failedPr,
            { ...failedPr, id: 2, status: 'in_progress' },
            { ...failedPr, id: 3, conclusion: 'success' },
            { ...failedPr, id: 4, event: 'push' },
            { ...failedPr, id: 5, pull_requests: [] },
            { ...failedPr, id: 6, pull_requests: undefined },
        ]).map(r => r.id), [11]);
    });

    test('missing APP_REPO / token fail fast', () => {
        const a = runScript('retrigger-app-checks.js', { APP_REPO_RERUN_TOKEN: 't' }, tmp);

        assert.equal(a.code, 1);
        assert.match(a.err, /Missing APP_REPO/);
        const b = runScript('retrigger-app-checks.js', { APP_REPO: 'o/r' }, tmp);

        assert.equal(b.code, 1);
        assert.match(b.err, /Missing APP_REPO_RERUN_TOKEN/);
    });

    test('nothing to re-run when there are no eligible runs (or no workflow_runs key)', () => {
        const r1 = run([runsRoute({ workflow_runs: [{ ...failedPr, event: 'push' }] })]);

        assert.equal(r1.code, 0, r1.err);
        assert.match(r1.out, /nothing to re-run/);
        assert.equal(r1.log.length, 1);

        const r2 = run([runsRoute({})]);

        assert.match(r2.out, /nothing to re-run/);
    });

    test('re-runs each eligible run with POST, using the default workflow file', () => {
        const r = run([
            runsRoute({ workflow_runs: [failedPr, { ...failedPr, id: 12 }, { ...failedPr, id: 13, event: 'push' }] }),
            { match: '/rerun-failed-jobs', responses: [{ status: 201, body: {} }] },
        ]);

        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /Re-running run 11 \(#5, #6, commit abcdef1\)/);
        assert.match(r.out, /Re-triggered 2 run\(s\)\./);
        assert.match(r.log[0].url, /repos\/org\/app\/actions\/workflows\/check-flags-trigger\.yml\/runs/);
        assert.equal(r.log[0].auth, 'Bearer tok');
        const posts = r.log.filter(l => l.method === 'POST');

        assert.deepEqual(posts.map(p => p.url.match(/runs\/(\d+)\//)[1]), ['11', '12']);
    });

    test('custom WORKFLOW_FILE is used', () => {
        const r = run([runsRoute({ workflow_runs: [] })], { WORKFLOW_FILE: 'custom.yml' });

        assert.match(r.log[0].url, /workflows\/custom\.yml\/runs/);
    });

    test('rate limit is waited out (mocked sleep) and retried', () => {
        const r = run([{
            match: '/runs?status=failure',
            responses: [
                { status: 429, body: 'slow down', headers: { 'retry-after': '7' } },
                { status: 200, body: { workflow_runs: [] } },
            ],
        }]);

        assert.equal(r.code, 0, r.err);
        assert.match(r.err, /Rate limited .* waiting 7s before retry 2\/4/);
        assert.deepEqual(r.log.filter(l => 'sleep' in l), [{ sleep: 7000 }]);
        assert.match(r.out, /nothing to re-run/);
    });

    test('a hard API error exits 1', () => {
        const r = run([runsRoute('nope', 404)]);

        assert.equal(r.code, 1);
        assert.match(r.err, /GitHub API error on .*: 404/);
    });

    test('failure on the re-run POST also exits 1', () => {
        const r = run([
            runsRoute({ workflow_runs: [failedPr] }),
            { match: '/rerun-failed-jobs', responses: [{ status: 403, body: 'forbidden' }] },
        ]);

        assert.equal(r.code, 1);
        assert.match(r.err, /403/);
    });
});
