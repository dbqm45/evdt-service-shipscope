'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTmp, rmTmp, runScript, runScriptAsync, write, readJ, exists } = require('./flag-scripts-helpers');

let tmp;

before(() => { tmp = makeTmp('state'); });
after(() => rmTmp(tmp));

describe('update-flag-state.js', () => {
    const paths = { FLAG_STATES_PATH: 'u/states.json', FLAG_STATE_HISTORY_PATH: 'u/history.json', FLAGS_META_PATH: 'u/meta.json' };
    const base = { ...paths, FLAG_KEY: 'f1', ENVIRONMENT: 'qa', ENABLED: 'true', CHANGED_BY: 'alice' };

    before(() => {
        write(tmp, 'u/states.json', {
            f1: { test: { build: { enabled: false, changedAt: 'x', changedBy: 'y', component: 'comp' } } },
            rb: { prod: { 'runtime-be': { enabled: true, changedAt: 'x', changedBy: 'y' } } },
        });
        write(tmp, 'u/meta.json', { rb: { source: 'runtime-be' }, f1: { source: 'build' } });
    });

    test('validation failures exit 1 with a message', () => {
        const cases = [
            [{ FLAG_KEY: '' }, /Missing FLAG_KEY/],
            [{ FLAG_KEY: '__proto__' }, /not a valid flag key/],
            [{ FLAG_KEY: 'constructor' }, /not a valid flag key/],
            [{ ENVIRONMENT: '' }, /Missing ENVIRONMENT/],
            [{ ENABLED: '' }, /Missing ENABLED/],
            [{ ENABLED: 'yes' }, /exactly "true" or "false"/],
            [{ ENVIRONMENT: 'staging' }, /Unknown environment/],
            [{ FLAG_KEY: 'nope' }, /Unknown flag "nope"/],
            [{ FLAG_STATES_PATH: '../s.json' }, /safe relative path/],
        ];

        for (const [over, re] of cases) {
            const r = runScript('update-flag-state.js', { ...base, ...over }, tmp);

            assert.equal(r.code, 1, JSON.stringify(over));
            assert.match(r.err, re);
        }
        assert.equal(exists(tmp, 'u/history.json'), false);
    });

    test('ENABLED unset entirely is rejected', () => {
        const env = { ...base };

        delete env.ENABLED;
        assert.match(runScript('update-flag-state.js', env, tmp).err, /Missing ENABLED/);
    });

    test('flips a build flag into a new env, preserving no component when none existed', () => {
        const r = runScript('update-flag-state.js', base, tmp);

        assert.equal(r.code, 0);
        assert.match(r.out, /Updated f1\.qa\.build -> enabled=true \(by alice\)/);
        const s = readJ(tmp, 'u/states.json');

        assert.equal(s.f1.qa.build.enabled, true);
        assert.equal(s.f1.qa.build.component, undefined);
        assert.equal(s.f1.test.build.enabled, false);
        const h = readJ(tmp, 'u/history.json');

        assert.equal(h.length, 1);
        assert.deepEqual({ ...h[0], changedAt: 0 }, { key: 'f1', env: 'qa', source: 'build', enabled: true, changedAt: 0, changedBy: 'alice' });
    });

    test('same value again is a no-op (no write, no history)', () => {
        const before = fs.readFileSync(path.join(tmp, 'u/states.json'), 'utf8');
        const r = runScript('update-flag-state.js', base, tmp);

        assert.match(r.out, /No change/);
        assert.equal(fs.readFileSync(path.join(tmp, 'u/states.json'), 'utf8'), before);
        assert.equal(readJ(tmp, 'u/history.json').length, 1);
    });

    test('keeps the existing component tag; default changedBy; runtime-be source from meta', () => {
        const r1 = runScript('update-flag-state.js', { ...base, ENVIRONMENT: 'test', CHANGED_BY: '' }, tmp);

        assert.equal(r1.code, 0);
        const t = readJ(tmp, 'u/states.json').f1.test.build;

        assert.equal(t.component, 'comp');
        assert.equal(t.changedBy, 'backend-service');
        assert.equal(t.enabled, true);

        const r2 = runScript('update-flag-state.js', { ...base, FLAG_KEY: 'rb', ENVIRONMENT: 'prod', ENABLED: 'false' }, tmp);

        assert.match(r2.out, /rb\.prod\.runtime-be -> enabled=false/);
        assert.equal(readJ(tmp, 'u/states.json').rb.prod['runtime-be'].enabled, false);
        assert.equal(readJ(tmp, 'u/history.json').length, 3);
    });

    test('missing meta file is tolerated (defaults to build); missing states file crashes', () => {
        write(tmp, 'u2/states.json', { z: {} });
        const r = runScript('update-flag-state.js', {
            FLAG_STATES_PATH: 'u2/states.json', FLAG_STATE_HISTORY_PATH: 'u2/h.json', FLAGS_META_PATH: 'u2/none.json',
            FLAG_KEY: 'z', ENVIRONMENT: 'prod', ENABLED: 'false',
        }, tmp);

        assert.equal(r.code, 0);
        assert.equal(readJ(tmp, 'u2/states.json').z.prod.build.enabled, false);

        const bad = runScript('update-flag-state.js', { ...base, FLAG_STATES_PATH: 'u2/missing.json' }, tmp);

        assert.notEqual(bad.code, 0);
    });

    test('default paths are used when env is unset', () => {
        write(tmp, 'd/docs/data/flag-states.json', { k: {} });
        const r = runScript('update-flag-state.js', { FLAG_KEY: 'k', ENVIRONMENT: 'test', ENABLED: 'true' }, path.join(tmp, 'd'));

        assert.equal(r.code, 0);
        assert.equal(readJ(tmp, 'd/docs/data/flag-states.json').k.test.build.enabled, true);
        assert.equal(readJ(tmp, 'd/docs/data/flag-state-history.json').length, 1);
    });
});

describe('resolve-all-flag-states.js', () => {
    const env = {
        FLAGS_SEARCH_ROOT: 'r/domains', FLAG_STATES_PATH: 'r/states.json',
        FLAG_STATE_HISTORY_PATH: 'r/history.json', FLAGS_META_PATH: 'r/meta.json', COMPONENT: 'comp-a',
    };

    test('requires COMPONENT; no flag-parts dirs is a no-op', () => {
        const e = { ...env };

        delete e.COMPONENT;
        assert.match(runScript('resolve-all-flag-states.js', e, tmp).err, /Missing COMPONENT/);

        const r = runScript('resolve-all-flag-states.js', env, tmp);

        assert.equal(r.code, 0);
        assert.match(r.out, /No flag-parts directories found/);
        assert.equal(exists(tmp, 'r/states.json'), false);
    });

    test('resolves default + env overrides, scaffolds meta, logs history, then is idempotent', () => {
        write(tmp, 'r/domains/one/flag-parts/default.ts', 'export const d = {\n  alpha: true,\n  beta: false,\n};');
        write(tmp, 'r/domains/one/flag-parts/prod.ts', 'export const p = { beta: true };');
        write(tmp, 'r/domains/one/flag-parts/qa.ts', 'export const nothing = 5;');
        write(tmp, 'r/domains/node_modules/flag-parts/default.ts', 'export const d = { skipped: true };');
        write(tmp, 'r/domains/dist/flag-parts/default.ts', 'export const d = { skipped2: true };');
        write(tmp, 'r/domains/file-not-dir', 'x');

        const r1 = runScript('resolve-all-flag-states.js', env, tmp);

        assert.equal(r1.code, 0, r1.err);
        assert.match(r1.out, /Found 1 flag-parts directory\./);
        assert.match(r1.out, /Resolved 2 build-time flag\(s\); 6 state\(s\) changed, scaffolded 2/);
        const s = readJ(tmp, 'r/states.json');

        assert.equal(s.alpha.prod.build.enabled, true);
        assert.equal(s.beta.test.build.enabled, false);
        assert.equal(s.beta.prod.build.enabled, true);
        assert.equal(s.beta.qa.build.component, 'comp-a');
        assert.equal(s.skipped, undefined);
        const m = readJ(tmp, 'r/meta.json');

        assert.equal(m.alpha.source, 'build');
        assert.deepEqual(m.alpha.components, ['comp-a']);
        assert.equal(readJ(tmp, 'r/history.json').length, 6);

        const snap = ['r/states.json', 'r/meta.json', 'r/history.json'].map(f => fs.readFileSync(path.join(tmp, f), 'utf8'));
        const r2 = runScript('resolve-all-flag-states.js', env, tmp);

        assert.match(r2.out, /0 state\(s\) changed\./);
        assert.deepEqual(['r/states.json', 'r/meta.json', 'r/history.json'].map(f => fs.readFileSync(path.join(tmp, f), 'utf8')), snap);
    });

    test('a changed override logs exactly one flip', () => {
        write(tmp, 'r/domains/one/flag-parts/prod.ts', 'export const p = { beta: false };');
        const r = runScript('resolve-all-flag-states.js', { ...env, CHANGED_BY: 'carol' }, tmp);

        assert.match(r.out, /1 state\(s\) changed/);
        const h = readJ(tmp, 'r/history.json');

        assert.equal(h.length, 7);
        assert.equal(h[6].changedBy, 'carol');
        assert.equal(h[6].enabled, false);
    });

    test('second component: union in meta; collision with another owner is skipped loudly', () => {
        write(tmp, 'r/domains/two/flag-parts/default.ts', 'export const d = { alpha: true, gamma: true };');
        const r = runScript('resolve-all-flag-states.js', { ...env, COMPONENT: 'comp-b' }, tmp);

        assert.equal(r.code, 0);
        assert.match(r.err, /::error::Flag key "alpha" is already owned by component "comp-a"/);
        assert.match(r.err, /::error::2 flag key collision\(s\)/);
        assert.match(r.err, /::error::Flag key "beta" is already owned/);
        assert.match(r.out, /Found 2 flag-parts directories\./);
        const m = readJ(tmp, 'r/meta.json');

        assert.deepEqual(m.alpha.components, ['comp-a']);
        assert.deepEqual(m.gamma.components, ['comp-b']);
    });

    test('untagged legacy state is claimed without a flip; meta components gets unioned', () => {
        write(tmp, 'l/domains/x/flag-parts/default.ts', 'export const d = { legacy: true, fresh: true };');
        write(tmp, 'l/states.json', { legacy: { test: { build: { enabled: true, changedAt: 't', changedBy: 'old' } } } });
        write(tmp, 'l/meta.json', { legacy: { source: 'build', jiraKeys: [], components: ['other'] }, fresh: { source: 'build', jiraKeys: [], components: ['comp-a'] } });
        const e = { ...env, FLAGS_SEARCH_ROOT: 'l/domains', FLAG_STATES_PATH: 'l/states.json', FLAG_STATE_HISTORY_PATH: 'l/h.json', FLAGS_META_PATH: 'l/meta.json' };
        const r = runScript('resolve-all-flag-states.js', e, tmp);

        assert.equal(r.code, 0);
        const s = readJ(tmp, 'l/states.json');

        assert.equal(s.legacy.test.build.component, 'comp-a');
        assert.equal(s.legacy.test.build.changedAt, 't');
        assert.equal(s.legacy.qa.build.enabled, true);
        assert.deepEqual(readJ(tmp, 'l/meta.json').legacy.components, ['other', 'comp-a']);
        assert.deepEqual(readJ(tmp, 'l/meta.json').fresh.components, ['comp-a']);
        assert.equal(readJ(tmp, 'l/h.json').length, 5);
    });

    test('meta entry lacking components is treated as empty and extended', () => {
        write(tmp, 'n/domains/x/flag-parts/default.ts', 'export const d = { nocomp: false };');
        write(tmp, 'n/meta.json', { nocomp: { source: 'build' } });
        const e = { ...env, FLAGS_SEARCH_ROOT: 'n/domains', FLAG_STATES_PATH: 'n/s.json', FLAG_STATE_HISTORY_PATH: 'n/h.json', FLAGS_META_PATH: 'n/meta.json' };

        assert.equal(runScript('resolve-all-flag-states.js', e, tmp).code, 0);
        assert.deepEqual(readJ(tmp, 'n/meta.json').nocomp.components, ['comp-a']);
    });

    test('default paths and default CHANGED_BY', () => {
        write(tmp, 'dd/domains/x/flag-parts/default.ts', 'export const d = { q: true };');
        write(tmp, 'dd/status-repo/docs/data/.keep', '');
        const r = runScript('resolve-all-flag-states.js', { COMPONENT: 'c' }, path.join(tmp, 'dd'));

        assert.equal(r.code, 0, r.err);
        assert.equal(readJ(tmp, 'dd/status-repo/docs/data/flag-state-history.json')[0].changedBy, 'resolve-all-flag-states-bot');
    });
});

describe('backfill-flag-state-history.js', () => {
    let repo;
    const env = { FLAG_STATES_PATH: 'data/flag-states.json', FLAG_STATE_HISTORY_PATH: 'data/history.json' };

    function git(args, date) {
        const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], {
            cwd: repo, encoding: 'utf8',
            env: { ...process.env, GIT_AUTHOR_DATE: date || '', GIT_COMMITTER_DATE: date || '' },
        });

        assert.equal(r.status, 0, r.stderr);
    }

    function commitStates(content, date) {
        write(repo, 'data/flag-states.json', content);
        git(['add', '-A'], date);
        git(['commit', '-q', '-m', 'c'], date);
    }

    before(() => {
        repo = path.join(tmp, 'gitrepo');
        fs.mkdirSync(repo, { recursive: true });
        git(['init', '-q']);
    });

    test('a repo with commits but none touching the file: nothing to backfill', () => {
        write(repo, 'other.txt', 'x');
        git(['add', '-A'], '2026-01-01T10:00:00+00:00');
        git(['commit', '-q', '-m', 'init'], '2026-01-01T10:00:00+00:00');
        const r = runScript('backfill-flag-state-history.js', env, repo);

        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /No commits found touching data\/flag-states.json/);
        assert.equal(exists(repo, 'data/history.json'), false);
    });

    test('mines history, skips unreadable commits, dedupes by day, is idempotent', () => {
        const on = (b, extra) => ({ f: { test: { build: { enabled: b } }, ...extra } });

        commitStates(on(false), '2026-02-01T10:00:00+00:00');
        commitStates(on(true, { qa: { 'runtime-be': { enabled: true }, build: { enabled: 'nope' }, junk: null } }), '2026-02-10T10:00:00+00:00');
        commitStates('{ not json', '2026-02-11T10:00:00+00:00');
        commitStates(on(true, { qa: { 'runtime-be': { enabled: true } } }), '2026-02-12T10:00:00+00:00');
        write(repo, 'data/history.json', [
            { key: 'f', env: 'test', source: 'build', enabled: false, changedAt: '2026-02-01T23:59:59Z', changedBy: 'live' },
        ]);

        const r1 = runScript('backfill-flag-state-history.js', env, repo);

        assert.equal(r1.code, 0, r1.err);
        assert.match(r1.err, /Skipping [0-9a-f]{7} .* missing or unreadable/);
        assert.match(r1.out, /Backfilled 2 historical flag change\(s\) from 4 commit\(s\)/);
        const h = readJ(repo, 'data/history.json');

        assert.equal(h.length, 3);
        assert.deepEqual(h.map(e => `${e.key}.${e.env}.${e.source}=${e.enabled}`), [
            'f.test.build=false', 'f.test.build=true', 'f.qa.runtime-be=true',
        ]);
        assert.equal(h[1].changedBy, 'unknown (backfilled from git history)');

        const snap = fs.readFileSync(path.join(repo, 'data/history.json'), 'utf8');
        const r2 = runScript('backfill-flag-state-history.js', env, repo);

        assert.match(r2.out, /nothing new to backfill/);
        assert.equal(fs.readFileSync(path.join(repo, 'data/history.json'), 'utf8'), snap);
    });

    test('unsafe path is rejected; default path env works', () => {
        assert.equal(runScript('backfill-flag-state-history.js', { FLAG_STATES_PATH: '../x' }, repo).code, 1);
        const r = runScript('backfill-flag-state-history.js', {}, repo);

        assert.equal(r.code, 0);
        assert.match(r.out, /No commits found touching docs\/data\/flag-states.json/);
    });
});

describe('sync-runtime-be-flags.js', () => {
    let server;
    let base;
    const sockets = new Set();
    const bodies = {
        '/test': { a: true, b: false, n: 1, s: 'x' },
        '/prod': { a: false, only: true },
        '/one': { solo: true },
    };

    before(async () => {
        server = http.createServer((req, res) => {
            if (req.url === '/hang') { return; }
            if (req.url === '/err') {
                res.statusCode = 500;
                res.end('boom');
                return;
            }
            const body = bodies[req.url];

            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(body || {}));
        });
        server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        for (const s of sockets) s.destroy();
        await new Promise(r => server.close(r));
    });

    const paths = (n) => ({
        FLAG_STATES_PATH: `b${n}/states.json`, FLAG_STATE_HISTORY_PATH: `b${n}/history.json`, FLAGS_META_PATH: `b${n}/meta.json`,
    });

    test('requires COMPONENT', async () => {
        const r = await runScriptAsync('sync-runtime-be-flags.js', paths(0), tmp);

        assert.equal(r.code, 1);
        assert.match(r.err, /Missing COMPONENT/);
    });

    test('syncs two envs, skips unconfigured qa, scaffolds meta, then is idempotent and records flips', async () => {
        write(tmp, 'b1/.keep', '');
        const env = { ...paths(1), COMPONENT: 'be-a', URL_TEST: `${base}/test`, URL_PROD: `${base}/prod` };
        const r1 = await runScriptAsync('sync-runtime-be-flags.js', env, tmp);

        assert.equal(r1.code, 0, r1.err);
        assert.match(r1.err, /no URL configured for "qa"/);
        assert.match(r1.out, /test: fetched 4 properties, 2 of them are boolean flags/);
        assert.match(r1.out, /Created\/corrected 3 flags-meta.json entries/);
        assert.match(r1.out, /Done\. 4 state\(s\) changed/);
        const s = readJ(tmp, 'b1/states.json');

        assert.equal(s.a.test['runtime-be'].enabled, true);
        assert.equal(s.a.prod['runtime-be'].enabled, false);
        assert.equal(s.a.prod['runtime-be'].component, 'be-a');
        assert.equal(s.a.qa, undefined);
        assert.equal(readJ(tmp, 'b1/meta.json').only.source, 'runtime-be');
        assert.equal(readJ(tmp, 'b1/history.json').length, 4);

        const snap = ['states', 'meta', 'history'].map(n => fs.readFileSync(path.join(tmp, `b1/${n}.json`), 'utf8'));
        const r2 = await runScriptAsync('sync-runtime-be-flags.js', env, tmp);

        assert.match(r2.out, /Done\. 0 state\(s\) changed/);
        assert.deepEqual(['states', 'meta', 'history'].map(n => fs.readFileSync(path.join(tmp, `b1/${n}.json`), 'utf8')), snap);

        bodies['/test'] = { a: false, b: false };
        const r3 = await runScriptAsync('sync-runtime-be-flags.js', { ...env, CHANGED_BY: 'zed' }, tmp);

        assert.match(r3.out, /Done\. 1 state\(s\) changed/);
        const h = readJ(tmp, 'b1/history.json');

        assert.equal(h.length, 5);
        assert.equal(h[4].changedBy, 'zed');
        bodies['/test'] = { a: true, b: false, n: 1, s: 'x' };
    });

    test('singular "property" wording and default CHANGED_BY', async () => {
        write(tmp, 'b2/.keep', '');
        const r = await runScriptAsync('sync-runtime-be-flags.js', { ...paths(2), COMPONENT: 'be', URL_QA: `${base}/one` }, tmp);

        assert.match(r.out, /qa: fetched 1 property, 1 of them/);
        assert.match(r.out, /entry for BE-controlled flags: solo/);
        assert.equal(readJ(tmp, 'b2/history.json')[0].changedBy, 'sync-runtime-be-flags-bot');
    });

    test('collision with a different owner is skipped loudly; ownership backfilled; meta corrected/unioned', async () => {
        write(tmp, 'b3/states.json', {
            a: { test: { 'runtime-be': { enabled: true, changedAt: 't', changedBy: 'o', component: 'someone-else' } } },
            b: { test: { 'runtime-be': { enabled: false, changedAt: 't', changedBy: 'o' } } },
        });
        write(tmp, 'b3/meta.json', {
            b: { source: 'build', components: ['x'] },
            n: { source: 'runtime-be' },
        });
        bodies['/test'] = { a: true, b: false, n: true };
        const r = await runScriptAsync('sync-runtime-be-flags.js', { ...paths(3), COMPONENT: 'be-z', URL_TEST: `${base}/test` }, tmp);

        bodies['/test'] = { a: true, b: false, n: 1, s: 'x' };
        assert.equal(r.code, 0, r.err);
        assert.match(r.err, /::error::Flag key "a" is already owned by component "someone-else"/);
        assert.match(r.err, /::error::1 flag key collision/);
        const s = readJ(tmp, 'b3/states.json');

        assert.equal(s.a.test['runtime-be'].component, 'someone-else');
        assert.equal(s.b.test['runtime-be'].component, 'be-z');
        assert.equal(s.b.test['runtime-be'].changedAt, 't');
        const m = readJ(tmp, 'b3/meta.json');

        assert.equal(m.a, undefined);
        assert.equal(m.b.source, 'runtime-be');
        assert.deepEqual(m.b.components, ['x', 'be-z']);
        assert.deepEqual(m.n.components, ['be-z']);
        assert.equal(readJ(tmp, 'b3/history.json').length, 1);
    });

    test('non-2xx and timeout fail the run', async () => {
        write(tmp, 'b4/.keep', '');
        const bad = await runScriptAsync('sync-runtime-be-flags.js', { ...paths(4), COMPONENT: 'c', URL_PROD: `${base}/err` }, tmp);

        assert.equal(bad.code, 1);
        assert.match(bad.err, /Request to prod endpoint failed: 500 boom/);

        const slow = await runScriptAsync('sync-runtime-be-flags.js', {
            ...paths(4), COMPONENT: 'c', URL_TEST: `${base}/hang`, FETCH_TIMEOUT_MS: '300',
        }, tmp);

        assert.equal(slow.code, 1);
        assert.equal(exists(tmp, 'b4/states.json'), false);
    });

    test('default data paths', async () => {
        write(tmp, 'd2/docs/data/.keep', '');
        const r = await runScriptAsync('sync-runtime-be-flags.js', { COMPONENT: 'c', URL_TEST: `${base}/one` }, path.join(tmp, 'd2'));

        assert.equal(r.code, 0, r.err);
        assert.ok(exists(tmp, 'd2/docs/data/flag-states.json'));
    });
});
