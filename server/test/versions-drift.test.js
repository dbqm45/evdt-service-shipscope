const { test } = require('node:test');
const assert = require('node:assert');
const { fakeGitHub, AUTH, signIn, testGitHubApp } = require('./helpers/auth');
const { extractPromotedVersion, parseVersionProperty, matchVersionLabel, fetchRefIndex, resolveVersionFile, resolveVersion } = require('../lib/version-resolution');
const { computeEnvDrift } = require('../lib/env-drift');

const sha = (n) => n.toString(16).padStart(40, 'a');
const TOKEN = 'inst-token-1';
const tree = (files, truncated = false) => ({ truncated, tree: Object.entries(files).map(([path, blob]) => ({ path, type: 'blob', sha: blob })) });

/** A fake GitHub for one repo, `acme/web`, recording the paths it was asked for. */
function fakeRepo(repo) {
    const fake = fakeGitHub({}, { repos: { 'acme/web': repo } });
    const calls = [];
    const fetch = (url, init) => {
        calls.push(url.replace('https://api.github.com/repos/acme/web/', ''));
        return fake(url, init);
    };
    return { fetch, calls };
}

test('extractPromotedVersion / parseVersionProperty', () => {
    assert.strictEqual(extractPromotedVersion('chore: promote v1.2.3 to prod'), 'v1.2.3');
    assert.strictEqual(extractPromotedVersion('release 10.0.1'), '10.0.1');
    assert.strictEqual(extractPromotedVersion('fix: no version here 1.2'), null);
    assert.strictEqual(extractPromotedVersion(undefined), null);
    assert.strictEqual(parseVersionProperty('# trigger\nversion=v0.0.702\nother=1\n'), 'v0.0.702');
    assert.strictEqual(parseVersionProperty('  version : abc123  '), 'abc123');
    assert.strictEqual(parseVersionProperty('versions=1'), null);
});

test('resolveVersion: release > tag > version file > commit message label; compares only ever use a real ref', async () => {
    const { fetch } = fakeRepo({
        tags: [{ name: 'v2.0.0', commit: { sha: sha(2) } }, { name: 'nightly', commit: { sha: sha(3) } }, { name: 'v1.0.0', commit: { sha: sha(1) } }],
        releases: [{ tag_name: 'v2.0.0' }, { tag_name: 'deleted-tag' }],
    });
    const refIndex = await fetchRefIndex({ token: TOKEN, fullName: 'acme/web', fetch });
    assert.strictEqual(refIndex.shaToRelease.get(sha(2)), 'v2.0.0');
    assert.strictEqual(refIndex.shaToRelease.size, 1, 'a release whose tag is gone maps to no commit');

    assert.deepStrictEqual(resolveVersion({ sha: sha(2), message: 'v9.9.9', refIndex, fileRef: null }), { version: 'v2.0.0', resolvedRef: 'v2.0.0' });
    assert.deepStrictEqual(resolveVersion({ sha: sha(3), message: 'v9.9.9', refIndex, fileRef: null }), { version: 'nightly', resolvedRef: 'nightly' });
    // The message label is shown but never used as a ref: it may name no tag at all.
    assert.deepStrictEqual(resolveVersion({ sha: sha(4), message: 'promote v9.9.9', refIndex, fileRef: null }), { version: 'v9.9.9', resolvedRef: sha(4) });
    assert.deepStrictEqual(resolveVersion({ sha: sha(4), message: 'fix', refIndex, fileRef: null }), { version: null, resolvedRef: sha(4) });
    // The version file says what really shipped (the deployed commit is only a trigger).
    assert.deepStrictEqual(resolveVersion({ sha: sha(2), message: '', refIndex, fileRef: { ref: 'v1.0.0', label: 'v1.0.0' } }), { version: 'v1.0.0', resolvedRef: 'v1.0.0' });
});

test('fetchRefIndex pages through tags and releases', async () => {
    const tags = Array.from({ length: 150 }, (_, i) => ({ name: `t${i}`, commit: { sha: sha(1000 + i) } }));
    const { fetch, calls } = fakeRepo({ tags, releases: [] });
    const refIndex = await fetchRefIndex({ token: TOKEN, fullName: 'acme/web', fetch });
    assert.strictEqual(refIndex.tagNames.size, 150);
    assert.deepStrictEqual(calls, ['tags?per_page=100&page=1', 'tags?per_page=100&page=2', 'releases?per_page=100&page=1']);
});

test('resolveVersionFile: a tag by that name, else the commit it names, else null (never throws)', async () => {
    const { fetch } = fakeRepo({
        tags: [{ name: 'v0.0.702', commit: { sha: sha(7) } }],
        files: {
            [sha(1)]: { 'deploy/trigger.properties': 'version=v0.0.702\n' },
            [sha(2)]: { 'deploy/trigger.properties': `version=${sha(8)}\n` },
            [sha(3)]: { 'deploy/trigger.properties': 'version=no-such-ref\n' },
            [sha(4)]: { 'deploy/trigger.properties': 'nothing useful\n' },
        },
    });
    const tagNames = new Set(['v0.0.702']);
    const resolve = (at) => resolveVersionFile({ token: TOKEN, fullName: 'acme/web', versionFile: 'deploy/trigger.properties', sha: at, tagNames, fetch });
    assert.deepStrictEqual(await resolve(sha(1)), { ref: 'v0.0.702', label: 'v0.0.702' });
    assert.deepStrictEqual(await resolve(sha(2)), { ref: sha(8), label: sha(8) });
    assert.strictEqual(await resolve(sha(3)), null, 'a ref GitHub does not know');
    assert.strictEqual(await resolve(sha(4)), null, 'no version= line');
    assert.strictEqual(await resolve(sha(5)), null, 'no file at that commit');
});

test('matchVersionLabel: exact tag, the v prefix toggled, the base tag of a suffixed version, latest release', () => {
    const tagNames = new Set(['v1.4.25', '2.0.0', '3.1.0-okta', '3.1.0', 'v5.0.0']);
    const m = (label, extra) => matchVersionLabel(label, { tagNames, ...extra });
    assert.deepStrictEqual(m('v1.4.25'), { ref: 'v1.4.25', label: 'v1.4.25' });
    assert.deepStrictEqual(m('1.4.25'), { ref: 'v1.4.25', label: '1.4.25' }, 'v added');
    assert.deepStrictEqual(m('v2.0.0'), { ref: '2.0.0', label: 'v2.0.0' }, 'v dropped');
    for (const suffix of ['-okta', '-abc', '-rc.1', '+build5', '_hotfix']) {
        assert.deepStrictEqual(m(`1.4.25${suffix}`), { ref: 'v1.4.25', label: `1.4.25${suffix}` }, suffix);
    }
    assert.deepStrictEqual(m('3.1.0-okta'), { ref: '3.1.0-okta', label: '3.1.0-okta' }, 'an exact tag wins over the base one');
    assert.strictEqual(m('1.4.25.1'), null, 'a fourth number is not a suffix');
    assert.strictEqual(m('9.9.9-okta'), null, 'no base tag either');
    assert.strictEqual(m('main'), null);

    const releases = [{ tag: 'v5.0.0', publishedAt: '2026-10-10T00:00:00Z' }, { tag: '2.0.0', publishedAt: '2026-09-01T00:00:00Z' }];
    assert.deepStrictEqual(m('latest', { releases, at: '2026-10-20T00:00:00Z' }), { ref: 'v5.0.0', label: 'v5.0.0' });
    assert.deepStrictEqual(m('LATEST', { releases, at: '2026-10-01T00:00:00Z' }), { ref: '2.0.0', label: '2.0.0' }, 'the newest one that existed then');
    assert.strictEqual(m('latest', { releases, at: '2026-08-01T00:00:00Z' }), null, 'no release yet');
    assert.strictEqual(m('latest', { releases }), null, 'no deployment time');
    assert.deepStrictEqual(matchVersionLabel('latest', { tagNames: new Set(['latest']), releases, at: '2026-10-20T00:00:00Z' }),
        { ref: 'latest', label: 'latest' }, 'a tag really named latest is used as is');
});

test('fetchRefIndex: releases for "latest" are the published, non-prerelease ones whose tag exists, newest first', async () => {
    const { fetch } = fakeRepo({
        tags: [{ name: 'v1', commit: { sha: sha(1) } }, { name: 'v2', commit: { sha: sha(2) } }, { name: 'v3', commit: { sha: sha(3) } }],
        releases: [
            { tag_name: 'v1', published_at: '2026-09-01T00:00:00Z' },
            { tag_name: 'v2', published_at: '2026-10-01T00:00:00Z' },
            { tag_name: 'v3', published_at: '2026-10-05T00:00:00Z', prerelease: true },
            { tag_name: 'v3', published_at: null, draft: true },
            { tag_name: 'gone', published_at: '2026-10-09T00:00:00Z' },
        ],
    });
    const { releases } = await fetchRefIndex({ token: TOKEN, fullName: 'acme/web', fetch });
    assert.deepStrictEqual(releases, [{ tag: 'v2', publishedAt: '2026-10-01T00:00:00Z' }, { tag: 'v1', publishedAt: '2026-09-01T00:00:00Z' }]);
});

test('resolveVersionFile: version=latest and a suffixed version resolve to a tag', async () => {
    const { fetch, calls } = fakeRepo({
        files: { [sha(1)]: { 'trigger.properties': 'version=latest\n' }, [sha(2)]: { 'trigger.properties': 'version=1.4.25-okta\n' } },
    });
    const releases = [{ tag: 'v1.1.46', publishedAt: '2026-10-10T00:00:00Z' }];
    const resolve = (at) => resolveVersionFile({ token: TOKEN, fullName: 'acme/web', versionFile: 'trigger.properties', sha: at, tagNames: new Set(['v1.1.46', 'v1.4.25']), releases, at: '2026-10-20T00:00:00Z', fetch });
    assert.deepStrictEqual(await resolve(sha(1)), { ref: 'v1.1.46', label: 'v1.1.46' });
    assert.deepStrictEqual(await resolve(sha(2)), { ref: 'v1.4.25', label: '1.4.25-okta' });
    assert.ok(!calls.some((c) => c.startsWith('commits/')), 'no commit lookup when a tag matched');
});

test('computeEnvDrift: the git tree decides; commit counts are context only', async () => {
    const t = (n) => `tree-${n}`;
    const repo = {
        compare: () => ({ ahead_by: 4, behind_by: 0 }),
        treeOf: { [sha(1)]: t(1), [sha(2)]: t(1), [sha(3)]: t(3), [sha(4)]: t(4), [sha(5)]: t(5), [sha(6)]: t(6) },
        trees: {
            [t(3)]: tree({ 'src/a.js': 'x1', '.github/ci.yml': 'c1', 'README.md': 'r1' }),
            [t(4)]: tree({ 'src/a.js': 'x1', '.github/ci.yml': 'c2', 'docs/README.md': 'r2' }),
            [t(5)]: tree({ 'src/a.js': 'x2', 'src/new.js': 'n1' }),
            [t(6)]: tree({}, true),
        },
    };
    const { fetch } = fakeRepo(repo);
    const drift = (latestByEnv, ignorePatterns = ['.github/', 'README.md']) => computeEnvDrift({ token: TOKEN, fullName: 'acme/web', latestByEnv, ignorePatterns, fetch });

    // Same tree (e.g. a squash on a deployment branch): 4 commits "behind", no drift.
    assert.deepStrictEqual(await drift({ test: { ref: sha(1) }, qa: { ref: sha(2) } }), { envs: {}, failed: [] });
    // Trees differ only in ignored plumbing: no drift.
    assert.deepStrictEqual(await drift({ test: { ref: sha(3) }, qa: { ref: sha(4) } }), { envs: {}, failed: [] });
    // A real code difference, with the ignored files counted separately.
    assert.deepStrictEqual(await drift({ qa: { ref: sha(3), version: 'v1' }, prod: { ref: sha(5), version: 'v1' } }), {
        envs: { prod: { behindEnv: 'qa', commitCount: 4, diff: { files: 2, paths: ['src/a.js', 'src/new.js'], ignored: 2 }, sameVersion: true } },
        failed: [],
    });
    // A truncated listing can't prove anything: unknown, never "no difference".
    assert.deepStrictEqual((await drift({ test: { ref: sha(3) }, qa: { ref: sha(6) } })).envs.qa.diff, { unknown: true });

    // Commits only on the later stage: deployed without passing through the earlier one.
    repo.compare = () => ({ ahead_by: 0, behind_by: 3 });
    assert.deepStrictEqual((await drift({ test: { ref: sha(3) }, qa: { ref: sha(5) } })).envs.qa,
        { untestedIn: 'test', untestedCommitCount: 3, diff: { files: 2, paths: ['src/a.js', 'src/new.js'], ignored: 2 } });
    // In sync by history: no tree calls at all.
    repo.compare = () => ({ ahead_by: 0, behind_by: 0 });
    assert.deepStrictEqual(await drift({ test: { ref: sha(3) }, qa: { ref: sha(5) } }), { envs: {}, failed: [] });
    // Same ref, or a missing stage: nothing to compare.
    assert.deepStrictEqual(await drift({ test: { ref: sha(3) }, qa: { ref: sha(3) }, prod: { ref: sha(5) } }), { envs: {}, failed: [] });

    // A compare error marks the environment failed (the caller keeps its previous value).
    repo.compare = () => { throw new Error('boom'); };
    const failing = fakeGitHub({}, { repos: { 'acme/web': { ...repo, compare: undefined } } });
    const errFetch = (url, init) => (url.includes('/compare/') ? Promise.resolve(new Response('{}', { status: 500 })) : failing(url, init));
    assert.deepStrictEqual(
        await computeEnvDrift({ token: TOKEN, fullName: 'acme/web', latestByEnv: { test: { ref: sha(3) }, qa: { ref: sha(5) } }, ignorePatterns: [], fetch: errFetch }),
        { envs: {}, failed: ['qa'] }
    );
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { syncAll } = require('../lib/deployment-sync');

const USERS = { alice: { id: 850_000_001, login: 'alice' }, bob: { id: 850_000_002, login: 'bob' } };
const ACME = 7001;
const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ok = (minutesAgo) => [{ state: 'success', created_at: at(minutesAgo) }];

async function setup(t, web) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { app: githubApp, publicKey } = testGitHubApp();
    const fake = fakeGitHub(USERS, {
        publicKey,
        installations: { [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: [] } },
        repos: { 'acme/web': web },
    });
    const calls = [];
    const fetch = (url, init) => {
        calls.push(url.replace('https://api.github.com/repos/acme/web/', ''));
        return fake(url, init);
    };
    const app = buildApp({ pool, auth: AUTH, githubApp, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, $2, 'acme', 'Organization')", [tenantId, ACME]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, $2, 'acme/web')", [tenantId, ACME]);
    });
    const sync = () => syncAll({ pool, app: githubApp, fetch, now: NOW });
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    const dashboard = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    return { pool, app, alice, tenantId, sync, rows, calls, dashboard };
}

test('sync: versions from release/tag/message, compares between resolved refs, drift stored and shown on the dashboard', async (t) => {
    const web = {
        deployments: [
            { id: 4, environment: 'qa', sha: sha(3), created_at: at(10) },
            { id: 3, environment: 'test', sha: sha(3), created_at: at(20) },
            { id: 2, environment: 'qa', sha: sha(2), created_at: at(30) },
            { id: 1, environment: 'test', sha: sha(1), created_at: at(40) },
        ],
        statuses: { 1: ok(39), 2: ok(29), 3: ok(19), 4: ok(9) },
        commits: { [sha(1)]: 'feat: ABC-1', [sha(2)]: 'chore: promote v7.7.7', [sha(3)]: 'feat: ABC-3' },
        tags: [{ name: 'v1.0.0', commit: { sha: sha(1) } }, { name: 'v1.1.0', commit: { sha: sha(3) } }],
        releases: [{ tag_name: 'v1.1.0' }],
        compare: (base, head) => {
            if (base === 'v1.0.0' && head === 'v1.1.0') return { status: 'ahead', commits: [{ commit: { message: 'feat: ABC-3' } }] };
            if (base === sha(2) && head === 'v1.1.0') return { status: 'ahead', commits: [{ commit: { message: 'fix: ABC-2' } }] };
            throw new Error(`unexpected compare ${base}...${head}`);
        },
    };
    const { sync, rows, calls, dashboard } = await setup(t, web);

    // Before the second qa deploy: test is on v1.0.0, qa on the v7.7.7-labelled commit (a label, not a ref).
    web.deployments = web.deployments.slice(2);
    web.compare = (base, head) => {
        assert.deepStrictEqual([base, head], [sha(2), 'v1.0.0'], 'drift compares qa...test by real refs');
        return { ahead_by: 1, behind_by: 0 };
    };
    web.trees = { [`tree-${sha(1)}`]: tree({ 'a.js': '1' }), [`tree-${sha(2)}`]: tree({ 'a.js': '2' }) };
    await sync();
    let deps = await rows('SELECT deployment_id, version, resolved_ref FROM deployments ORDER BY deployment_id');
    assert.deepStrictEqual(deps.map((d) => [Number(d.deployment_id), d.version, d.resolved_ref]), [[1, 'v1.0.0', 'v1.0.0'], [2, 'v7.7.7', sha(2)]]);
    let [repo] = await rows('SELECT drift FROM tracked_repos');
    assert.deepStrictEqual(repo.drift, {
        inputs: { test: 'v1.0.0', qa: sha(2) },
        failed: [],
        envs: { qa: { behindEnv: 'test', commitCount: 1, diff: { files: 1, paths: ['a.js'], ignored: 0 } } },
    });
    let data = await dashboard();
    const qa = data.deployments.find((d) => d.id === 'gh-2');
    assert.strictEqual(qa.version, 'v7.7.7');
    assert.strictEqual(qa.resolvedRef, sha(2));
    assert.deepStrictEqual(qa.driftBehind, repo.drift.envs.qa);

    // A pass with nothing new: drift inputs unchanged, so no compare or tree call at all.
    calls.length = 0;
    await sync();
    assert.deepStrictEqual(calls.filter((c) => /compare|git\/trees|commits\//.test(c)), []);

    // Both stages move to the v1.1.0 release: ranges compare tag to tag / sha to tag, and the drift disappears.
    web.deployments = [{ id: 4, environment: 'qa', sha: sha(3), created_at: at(10) }, { id: 3, environment: 'test', sha: sha(3), created_at: at(20) }];
    web.compare = (base, head) => {
        if (base === 'v1.0.0' && head === 'v1.1.0') return { status: 'ahead', commits: [{ commit: { message: 'feat: ABC-3' } }] };
        if (base === sha(2) && head === 'v1.1.0') return { status: 'ahead', commits: [{ commit: { message: 'fix: ABC-2' } }] };
        throw new Error(`unexpected compare ${base}...${head}`);
    };
    await sync();
    deps = await rows('SELECT deployment_id, version, resolved_ref, related_issues, commit_url FROM deployments WHERE deployment_id > 2 ORDER BY deployment_id');
    assert.deepStrictEqual(deps.map((d) => [Number(d.deployment_id), d.version, d.related_issues, d.commit_url]), [
        [3, 'v1.1.0', ['ABC-3'], `https://github.com/acme/web/compare/v1.0.0...${sha(3)}`],
        [4, 'v1.1.0', ['ABC-2'], `https://github.com/acme/web/compare/${sha(2)}...${sha(3)}`],
    ]);
    [repo] = await rows('SELECT drift FROM tracked_repos');
    assert.deepStrictEqual(repo.drift, { inputs: { test: 'v1.1.0', qa: 'v1.1.0' }, failed: [], envs: {} });
    data = await dashboard();
    assert.ok(data.deployments.every((d) => !('driftBehind' in d)));
});

test('sync: a version file names what really shipped; set later, it re-resolves drift for already-synced records', async (t) => {
    const trigger = (n) => sha(100 + n);
    const web = {
        deployments: [
            { id: 2, environment: 'prod', sha: trigger(2), created_at: at(10) },
            { id: 1, environment: 'qa', sha: trigger(1), created_at: at(20) },
        ],
        statuses: { 1: ok(19), 2: ok(9) },
        commits: { [sha(1)]: 'feat: ABC-1', [trigger(1)]: 'trigger', [trigger(2)]: 'trigger' },
        tags: [{ name: 'v0.0.1', commit: { sha: sha(1) } }, { name: 'v0.0.2', commit: { sha: sha(2) } }],
        files: { [trigger(1)]: { 'trigger.properties': 'version=v0.0.2\n' }, [trigger(2)]: { 'trigger.properties': 'version=v0.0.1\n' } },
        // Trigger commits on separate deployment branches: thousands of commits apart, same code.
        treeOf: { [trigger(1)]: 'tree-same', [trigger(2)]: 'tree-same' },
        trees: { [`tree-${sha(1)}`]: tree({ 'a.js': '1' }), [`tree-${sha(2)}`]: tree({ 'a.js': '2' }) },
        compare: () => ({ ahead_by: 786, behind_by: 2 }),
    };
    const { app, alice, tenantId, sync, rows } = await setup(t, web);

    // Without a version file: trigger commits compared, identical trees, so no drift despite the counts.
    await sync();
    let [repo] = await rows('SELECT drift FROM tracked_repos');
    assert.deepStrictEqual(repo.drift.envs, {});
    assert.deepStrictEqual(repo.drift.inputs, { qa: trigger(1), prod: trigger(2) });

    const put = (payload) => app.inject({ method: 'PUT', url: `/tenants/${tenantId}/github/repos/1/settings`, cookies: { sid: alice }, payload });
    const res = await put({ versionFile: 'trigger.properties', driftIgnorePaths: [] });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.deepStrictEqual(res.json(), { repoId: 1, versionFile: 'trigger.properties', driftIgnorePaths: [] });
    [repo] = await rows('SELECT drift FROM tracked_repos');
    assert.deepStrictEqual(repo.drift, {}, 'cleared, so the next pass recomputes');

    // The next pass resolves the file at the already-synced trigger commits: prod runs v0.0.1, qa v0.0.2.
    await sync();
    [repo] = await rows('SELECT drift FROM tracked_repos');
    assert.deepStrictEqual(repo.drift.envs, { prod: { behindEnv: 'qa', commitCount: 786, untestedIn: 'qa', untestedCommitCount: 2, diff: { files: 1, paths: ['a.js'], ignored: 0 } } });

    // A new deploy with the file configured: version and range come from the named tag.
    web.deployments.unshift({ id: 3, environment: 'prod', sha: trigger(3), created_at: at(5) });
    web.statuses[3] = ok(4);
    web.commits[trigger(3)] = 'trigger';
    web.files[trigger(3)] = { 'trigger.properties': 'version=v0.0.2\n' };
    web.compare = (base, head) => (head === 'v0.0.2' ? { status: 'ahead', commits: [{ commit: { message: 'fix: ABC-2' } }] } : { ahead_by: 0, behind_by: 0 });
    await sync();
    const [dep] = await rows('SELECT version, resolved_ref, related_issues, commit_url FROM deployments WHERE deployment_id = 3');
    assert.deepStrictEqual(dep, {
        version: 'v0.0.2', resolved_ref: 'v0.0.2', related_issues: ['ABC-2'],
        commit_url: `https://github.com/acme/web/compare/${trigger(2)}...v0.0.2`,
    });
    [repo] = await rows('SELECT drift FROM tracked_repos');
    assert.deepStrictEqual(repo.drift.envs, {}, 'qa and prod both run v0.0.2 now');
});

test('sync: version=latest is the release published before the deployment; a suffixed version uses its base tag', async (t) => {
    const trigger = (n) => sha(200 + n);
    const web = {
        deployments: [
            { id: 2, environment: 'test', sha: trigger(2), created_at: at(10) },
            { id: 1, environment: 'prod', sha: trigger(1), created_at: at(20) },
        ],
        statuses: { 1: ok(19), 2: ok(9) },
        commits: { [sha(1)]: 'feat: ABC-1', [sha(2)]: 'feat: ABC-2', [trigger(1)]: 'trigger', [trigger(2)]: 'trigger' },
        tags: [{ name: 'v1.0.0', commit: { sha: sha(1) } }, { name: 'v1.1.0', commit: { sha: sha(2) } }],
        // v1.1.0 was published after the prod deployment was created: "latest" then still meant v1.0.0.
        releases: [{ tag_name: 'v1.1.0', published_at: at(15) }, { tag_name: 'v1.0.0', published_at: at(30) }],
        files: { [trigger(1)]: { 'trigger.properties': 'version=latest\n' }, [trigger(2)]: { 'trigger.properties': 'version=1.1.0-okta\n' } },
        treeOf: { [sha(1)]: 'tree-1', [sha(2)]: 'tree-2' },
        trees: { 'tree-1': tree({ 'a.js': '1' }), 'tree-2': tree({ 'a.js': '2' }) },
        compare: () => ({ ahead_by: 1, behind_by: 0 }),
    };
    const { app, alice, tenantId, sync, rows } = await setup(t, web);
    const res = await app.inject({ method: 'PUT', url: `/tenants/${tenantId}/github/repos/1/settings`, cookies: { sid: alice }, payload: { versionFile: 'trigger.properties', driftIgnorePaths: [] } });
    assert.strictEqual(res.statusCode, 200, res.body);

    await sync();
    const deps = await rows('SELECT deployment_id, version, resolved_ref FROM deployments ORDER BY deployment_id');
    assert.deepStrictEqual(deps.map((d) => [Number(d.deployment_id), d.version, d.resolved_ref]), [[1, 'v1.0.0', 'v1.0.0'], [2, '1.1.0-okta', 'v1.1.0']]);
});

test('sync: a failed drift comparison keeps the previous value and is retried on the next pass', async (t) => {
    const web = {
        deployments: [{ id: 2, environment: 'qa', sha: sha(2), created_at: at(10) }, { id: 1, environment: 'test', sha: sha(1), created_at: at(20) }],
        statuses: { 1: ok(19), 2: ok(9) },
        commits: {},
        trees: { [`tree-${sha(1)}`]: tree({ 'a.js': '1' }), [`tree-${sha(2)}`]: tree({ 'a.js': '2' }), [`tree-${sha(3)}`]: tree({ 'a.js': '3' }) },
        compare: () => ({ ahead_by: 1, behind_by: 0 }),
    };
    const { sync, rows } = await setup(t, web);
    await sync();
    const [before] = await rows('SELECT drift FROM tracked_repos');
    assert.ok(before.drift.envs.qa);

    // test moves on, and the comparison errors: the old qa entry stays rather than reading as "in sync".
    web.deployments.unshift({ id: 3, environment: 'test', sha: sha(3), created_at: at(5) });
    web.statuses[3] = ok(4);
    web.compare = (base, head) => {
        if (head === sha(3) && base === sha(2)) throw new Error('flaky');
        return { status: 'ahead', commits: [] };
    };
    // A compare that throws makes the fake's fetch reject: a network error.
    await sync();
    let [repo] = await rows('SELECT drift, last_sync_error FROM tracked_repos');
    assert.strictEqual(repo.last_sync_error, null, 'drift trouble never fails the sync');
    assert.deepStrictEqual(repo.drift.failed, ['qa']);
    assert.deepStrictEqual(repo.drift.envs.qa, before.drift.envs.qa);

    web.compare = () => ({ ahead_by: 2, behind_by: 0 });
    await sync();
    [repo] = await rows('SELECT drift FROM tracked_repos');
    assert.deepStrictEqual(repo.drift.failed, []);
    assert.strictEqual(repo.drift.envs.qa.commitCount, 2);
});

test('repo settings: admins only, validated, listed with the connection', async (t) => {
    const { app, alice, tenantId } = await setup(t, { deployments: [], statuses: {}, compare: () => ({}) });
    const put = (sid, payload, repoId = 1) => app.inject({ method: 'PUT', url: `/tenants/${tenantId}/github/repos/${repoId}/settings`, cookies: { sid }, payload });

    const good = { versionFile: 'deploy/trigger.properties', driftIgnorePaths: ['.github/', 'README.md', 'docs/*.md'] };
    assert.strictEqual((await put(alice, good)).statusCode, 200);
    const listed = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github`, cookies: { sid: alice } })).json().repos[0];
    assert.deepStrictEqual([listed.versionFile, listed.driftIgnorePaths], [good.versionFile, good.driftIgnorePaths]);
    assert.deepStrictEqual((await put(alice, { versionFile: null, driftIgnorePaths: [] })).json(), { repoId: 1, versionFile: null, driftIgnorePaths: [] });

    for (const bad of [
        { versionFile: '/etc/passwd', driftIgnorePaths: [] },
        { versionFile: '../secrets', driftIgnorePaths: [] },
        { versionFile: 'a/../../b', driftIgnorePaths: [] },
        { versionFile: 'dir/', driftIgnorePaths: [] },
        { versionFile: 'a b', driftIgnorePaths: [] },
        { versionFile: 'x?ref=main', driftIgnorePaths: [] },
        { versionFile: '', driftIgnorePaths: [] },
        { versionFile: 'v', driftIgnorePaths: ['..'] },
        { versionFile: 'v', driftIgnorePaths: ['/abs/'] },
        { versionFile: 'v', driftIgnorePaths: ['a', 'a'] },
        { versionFile: 'v', driftIgnorePaths: Array.from({ length: 51 }, (_, i) => `p${i}`) },
        { versionFile: 'v', driftIgnorePaths: ['x'.repeat(201)] },
        { versionFile: 'v' },
        { versionFile: 'v', driftIgnorePaths: [], extra: 1 },
    ]) {
        assert.strictEqual((await put(alice, bad)).statusCode, 400, JSON.stringify(bad).slice(0, 80));
    }
    assert.strictEqual((await put(alice, good, 99)).statusCode, 404, 'not tracked');

    const bob = await signIn(app, 'bob');
    assert.strictEqual((await put(bob, good)).statusCode, 404, 'not a member');
    const invite = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice }, payload: { role: 'member' } })).json();
    const token = invite.url.split('/invitations/')[1];
    assert.strictEqual((await app.inject({ method: 'POST', url: `/invitations/${token}/accept`, cookies: { sid: bob } })).statusCode, 201);
    assert.strictEqual((await put(bob, good)).statusCode, 403, 'members can read, not configure');
});
