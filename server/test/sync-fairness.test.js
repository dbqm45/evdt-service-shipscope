const { test } = require('node:test');
const assert = require('node:assert');
const { retryAtFrom } = require('../lib/rate-limit');
const { githubGet, GitHubApiError, GitHubRateLimitError } = require('../lib/github-app');
const { fetchFieldIds, refreshAccessToken, AtlassianError } = require('../lib/atlassian');

const T = Date.parse('2026-10-16T12:00:00Z');
const headers = (h) => new Headers(h);
const reply = (status, h = {}) => async () => new Response('{"message":"x"}', { status, headers: h });

test('retryAtFrom: Retry-After seconds or date, then x-ratelimit-reset, then the fallback; clamped to [1 s, 1 h]', () => {
    const at = (h, opts = {}) => retryAtFrom(headers(h), { now: T, ...opts }).toISOString();
    assert.strictEqual(at({ 'retry-after': '90' }), '2026-10-16T12:01:30.000Z');
    assert.strictEqual(at({ 'retry-after': 'Fri, 16 Oct 2026 12:10:00 GMT' }), '2026-10-16T12:10:00.000Z');
    assert.strictEqual(at({ 'retry-after': '30', 'x-ratelimit-reset': String(T / 1000 + 600) }), '2026-10-16T12:00:30.000Z', 'Retry-After wins');
    assert.strictEqual(at({ 'x-ratelimit-reset': String(T / 1000 + 600) }), '2026-10-16T12:10:00.000Z');
    assert.strictEqual(at({}), '2026-10-16T12:05:00.000Z', 'default fallback: 5 minutes');
    assert.strictEqual(at({}, { fallbackMs: 60_000 }), '2026-10-16T12:01:00.000Z');
    assert.strictEqual(at({ 'retry-after': 'soon' }), '2026-10-16T12:05:00.000Z', 'garbage is ignored');
    assert.strictEqual(at({ 'retry-after': '0' }), '2026-10-16T12:00:01.000Z', 'never "right now"');
    assert.strictEqual(at({ 'x-ratelimit-reset': String(T / 1000 - 600) }), '2026-10-16T12:00:01.000Z', 'a reset in the past');
    assert.strictEqual(at({ 'retry-after': '999999' }), '2026-10-16T13:00:00.000Z', 'at most an hour');
});

test('GitHub: a rate limit (429, or 403 with no requests left or a Retry-After) is told apart from a real 403', async () => {
    const get = (fetch) => githubGet({ token: 't', path: '/repos/acme/web/deployments', fetch });
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    for (const [fetch, label] of [
        [reply(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), 'primary'],
        [reply(403, { 'x-ratelimit-remaining': '12', 'retry-after': '60' }), 'secondary'],
        [reply(429, {}), '429'],
    ]) {
        const err = await get(fetch).then(() => assert.fail('must throw'), (e) => e);
        assert.ok(err instanceof GitHubRateLimitError, label);
        assert.ok(err instanceof GitHubApiError, `${label}: still a GitHubApiError for callers that don't care`);
        assert.ok(err.retryAt.getTime() > Date.now(), label);
        assert.match(err.message, /rate limit/);
    }
    const primary = await get(reply(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset })).catch((e) => e);
    assert.strictEqual(primary.retryAt.getTime(), Number(reset) * 1000);
    const plain = await get(reply(403, { 'x-ratelimit-remaining': '4000' })).catch((e) => e);
    assert.ok(!(plain instanceof GitHubRateLimitError), 'a permission 403 is a real error');
    assert.strictEqual(plain.status, 403);
});

test('Atlassian: a 429 carries when to retry and never asks to reconnect; a stalled request times out', async () => {
    const field = (fetch) => fetchFieldIds({ accessToken: 'a', cloudId: 'cloud-a', fetch });
    const limited = await field(reply(429, { 'retry-after': '120' })).catch((e) => e);
    assert.ok(limited instanceof AtlassianError);
    assert.deepStrictEqual([limited.status, limited.reconnect], [429, false]);
    assert.ok(Math.abs(limited.retryAt.getTime() - (Date.now() + 120_000)) < 5000);
    assert.strictEqual((await field(reply(500)).catch((e) => e)).retryAt, null, 'other errors have no retry time');

    const token = await refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch: reply(429) }).catch((e) => e);
    assert.deepStrictEqual([token.status, token.reconnect], [429, false], 'a busy token endpoint is not a revoked grant');
    assert.ok(token.retryAt);

    let signal = null;
    const stalled = await field(async (url, init) => {
        signal = init.signal;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }).catch((e) => e);
    assert.ok(signal instanceof AbortSignal, 'every request has a deadline');
    assert.match(stalled.message, /timed out/);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, testGitHubApp } = require('./helpers/auth');
const { withScope } = require('../lib/scope');
const { syncAll } = require('../lib/deployment-sync');

const USERS = { alice: { id: 850_000_001, login: 'alice' }, bob: { id: 850_000_002, login: 'bob' } };
const ACME = 6101;
const BETA = 6102;
const sha = (n) => n.toString(16).padStart(40, 'a');
const success = { state: 'success', created_at: new Date(Date.now() - 60_000).toISOString() };
const deploys = (...ids) => ({
    deployments: ids.map((id) => ({ id, environment: 'prod', sha: sha(id), created_at: new Date(Date.now() - (1000 - id) * 1000).toISOString() })).reverse(),
    statuses: Object.fromEntries(ids.map((id) => [id, [{ ...success, created_at: new Date(Date.now() - (1000 - id) * 1000).toISOString() }]])),
    commits: {},
    compare: () => ({ status: 'ahead', commits: [] }),
});

/** Acme (acme/web, acme/api on installation ACME) and Beta (beta/app on BETA), straight in the database. */
async function setup(t, repos) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { app: githubApp, publicKey } = testGitHubApp();
    const fake = fakeGitHub(USERS, {
        publicKey,
        installations: { [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: [] }, [BETA]: { account: { login: 'beta', type: 'Organization' }, repos: [] } },
        repos,
    });
    const calls = [];
    let override = null; // (url) => Response | null, to simulate GitHub's rate limit
    const fetch = async (url, init) => {
        calls.push(url);
        return (override && override(url)) || fake(url, init);
    };
    const app = buildApp({ pool, auth: AUTH, githubApp, fetch });
    t.after(() => app.close());
    const tenants = {};
    for (const [name, user, installation, repoRows] of [
        ['Acme', 'alice', ACME, [[1, 'acme/web'], [2, 'acme/api']]],
        ['Beta', 'bob', BETA, [[3, 'beta/app']]],
    ]) {
        const sid = await signIn(app, user);
        const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid }, payload: { name } })).json().tenant.id;
        await withScope(pool, { tenantId }, async (c) => {
            await c.query('INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, $2, $3, \'Organization\')', [tenantId, installation, name.toLowerCase()]);
            for (const [repoId, fullName] of repoRows) {
                await c.query('INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, $2, $3, $4)', [tenantId, repoId, installation, fullName]);
            }
        });
        tenants[name] = { tenantId, sid };
    }
    const rows = (name, sql, params = []) => withScope(pool, { tenantId: tenants[name].tenantId }, async (c) => (await c.query(sql, params)).rows);
    const sync = (extra = {}) => syncAll({ pool, app: githubApp, fetch, ...extra });
    const firstCall = (prefix) => calls.findIndex((u) => u.includes(`/repos/${prefix}`));
    return { pool, app, tenants, rows, sync, calls, firstCall, setOverride: (fn) => { override = fn; } };
}

test('fairness: the tenant that waited longest goes first, and within a tenant the repo that waited longest', async (t) => {
    const ctx = await setup(t, { 'acme/web': deploys(11), 'acme/api': deploys(21), 'beta/app': deploys(31) });
    assert.deepStrictEqual(await ctx.sync(), { repos: 3, inserted: 3, failed: 0, deferred: 0 });
    assert.ok(ctx.firstCall('acme/') < ctx.firstCall('beta/'), 'never tried: in the order the tenants were created');

    // Beta waited an hour longer than Acme; within Acme, api longer than web.
    await ctx.rows('Acme', "UPDATE tracked_repos SET last_attempt_at = now() - CASE full_name WHEN 'acme/api' THEN interval '20 minutes' ELSE interval '10 minutes' END");
    await ctx.rows('Beta', "UPDATE tracked_repos SET last_attempt_at = now() - interval '1 hour'");
    ctx.calls.length = 0;
    await ctx.sync();
    assert.ok(ctx.firstCall('beta/') < ctx.firstCall('acme/'), 'Beta first');
    assert.ok(ctx.firstCall('acme/api') < ctx.firstCall('acme/web'), 'then Acme, its longest-waiting repo first');
    const attempts = await ctx.rows('Acme', 'SELECT full_name, last_attempt_at FROM tracked_repos ORDER BY full_name');
    assert.ok(attempts.every((r) => Date.now() - r.last_attempt_at.getTime() < 60_000), 'every attempt is recorded');
});

test('fairness: past its time budget a tenant stops between deployments and repos, keeps what it did, and continues next pass', async (t) => {
    const ctx = await setup(t, { 'acme/web': deploys(11, 12, 13), 'acme/api': deploys(21), 'beta/app': deploys(31) });
    // A budget of 0 with a frozen clock: each tenant does exactly one unit of work (one deployment of one repo) per pass.
    const pass = () => ctx.sync({ clock: () => 1_000, options: { tenantBudgetMs: 0 } });
    const synced = async () => (await ctx.rows('Acme', 'SELECT deployment_id FROM deployments ORDER BY deployment_id')).map((r) => Number(r.deployment_id));
    const cursors = async () => Object.fromEntries((await ctx.rows('Acme', 'SELECT full_name, deployments_cursor, drift FROM tracked_repos')).map((r) => [r.full_name, [Number(r.deployments_cursor), r.drift]]));

    // Never tried, so by name: acme/api (one deployment, done), then acme/web is left out; Beta still has its turn.
    assert.deepStrictEqual(await pass(), { repos: 2, inserted: 2, failed: 0, deferred: 1 });
    assert.deepStrictEqual(await synced(), [21]);
    assert.strictEqual((await ctx.rows('Beta', 'SELECT count(*)::int AS n FROM deployments'))[0].n, 1);

    // acme/web waited longest now: it goes first and is cut short after one deployment.
    assert.deepStrictEqual(await pass(), { repos: 2, inserted: 1, failed: 0, deferred: 2 });
    assert.deepStrictEqual(await synced(), [11, 21]);
    assert.deepStrictEqual((await cursors())['acme/web'], [11, {}], 'the cursor stops before what was left; drift waits for a complete pass');

    // With a budget this small one of Acme's repos always waits, but the backlog still drains, a deployment a pass.
    for (let passes = 2; (await synced()).length < 4; passes++) {
        assert.ok(passes < 10, 'the backlog drains');
        await pass();
    }
    assert.deepStrictEqual(await synced(), [11, 12, 13, 21], 'nothing skipped, nothing twice');
    const [cursor, drift] = (await cursors())['acme/web'];
    assert.strictEqual(cursor, 13);
    assert.deepStrictEqual(drift.inputs, { prod: sha(13) }, 'the complete pass computes drift');

    // Without the budget, nothing is cut short.
    assert.deepStrictEqual(await ctx.sync(), { repos: 3, inserted: 0, failed: 0, deferred: 0 });
});

test('fairness: a rate limit pauses only that installation, until GitHub says; everyone else syncs on', async (t) => {
    const ctx = await setup(t, { 'acme/web': deploys(11), 'acme/api': deploys(21), 'beta/app': deploys(31) });
    const reset = Math.floor(Date.now() / 1000) + 600;
    ctx.setOverride((url) => (url.includes('/repos/acme/web/') ? new Response('{"message":"API rate limit exceeded"}', {
        status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    }) : null));
    // Acme's api repo would go first (by name); make web go first so the limit hits before api is tried.
    await ctx.rows('Acme', "UPDATE tracked_repos SET last_attempt_at = CASE full_name WHEN 'acme/web' THEN now() - interval '1 hour' ELSE now() END");
    const log = [];

    assert.deepStrictEqual(await ctx.sync({ log: (m) => log.push(m) }), { repos: 2, inserted: 1, failed: 0, deferred: 2 });
    assert.ok(!ctx.calls.some((u) => u.includes('/repos/acme/api/')), 'the same installation\'s other repo is not even tried');
    assert.match(log.join('\n'), /acme\/web: GitHub rate limit, installation 6101 paused until/);
    const [inst] = await ctx.rows('Acme', 'SELECT rate_limited_until FROM github_installations');
    assert.strictEqual(inst.rate_limited_until.getTime(), reset * 1000);
    const web = (await ctx.rows('Acme', "SELECT last_sync_error, last_attempt_at FROM tracked_repos WHERE full_name = 'acme/web'"))[0];
    assert.deepStrictEqual([web.last_sync_error, Boolean(web.last_attempt_at)], [null, true], 'a pause is not a failure for the admin to fix');
    assert.strictEqual((await ctx.rows('Beta', 'SELECT count(*)::int AS n FROM deployments'))[0].n, 1, 'Beta synced');

    // Settings show the pause on both of the installation's repos.
    const list = (await ctx.app.inject({ method: 'GET', url: `/tenants/${ctx.tenants.Acme.tenantId}/github`, cookies: { sid: ctx.tenants.Acme.sid } })).json();
    assert.deepStrictEqual(list.repos.map((r) => [r.fullName, r.rateLimitedUntil]), [['acme/api', new Date(reset * 1000).toISOString()], ['acme/web', new Date(reset * 1000).toISOString()]]);

    // Next pass, still within the wait: Acme isn't asked anything at all.
    ctx.calls.length = 0;
    assert.deepStrictEqual(await ctx.sync(), { repos: 1, inserted: 0, failed: 0, deferred: 2 });
    assert.ok(!ctx.calls.some((u) => u.includes('/repos/acme/') || u.includes(`/installations/${ACME}/`)));

    // After the wait (GitHub's budget is back): Acme syncs again; the past pause no longer shows.
    ctx.setOverride(null);
    assert.deepStrictEqual(await ctx.sync({ clock: () => reset * 1000 + 1000 }), { repos: 3, inserted: 2, failed: 0, deferred: 0 });
    await ctx.rows('Acme', "UPDATE github_installations SET rate_limited_until = now() - interval '1 second'");
    const after = (await ctx.app.inject({ method: 'GET', url: `/tenants/${ctx.tenants.Acme.tenantId}/github`, cookies: { sid: ctx.tenants.Acme.sid } })).json();
    assert.deepStrictEqual(after.repos.map((r) => r.rateLimitedUntil), [null, null]);
});

test('fairness: cut short while resolving (which runs in status order, not id order), the cursor never skips what was left', async (t) => {
    const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const web = {
        // 43 finished first (e.g. a quick hotfix), then 41 and 42.
        deployments: [43, 42, 41].map((id) => ({ id, environment: 'prod', sha: sha(id), created_at: at(60) })),
        statuses: { 41: [{ state: 'success', created_at: at(20) }], 42: [{ state: 'success', created_at: at(10) }], 43: [{ state: 'success', created_at: at(30) }] },
        commits: {},
        compare: () => ({ status: 'ahead', commits: [] }),
    };
    const ctx = await setup(t, { 'acme/web': web, 'acme/api': deploys(), 'beta/app': deploys() });
    // The budget runs out as soon as resolving starts (the first commit lookup): one deployment gets resolved.
    let late = false;
    ctx.setOverride((url) => {
        if (url.includes('/repos/acme/web/commits/')) late = true;
        return null;
    });
    await ctx.rows('Acme', "UPDATE tracked_repos SET last_attempt_at = CASE full_name WHEN 'acme/web' THEN now() - interval '1 hour' ELSE now() END");
    await ctx.sync({ clock: () => (late ? 10_000_000 : 0), options: { tenantBudgetMs: 60_000 } });

    const [web1] = await ctx.rows('Acme', "SELECT deployments_cursor FROM tracked_repos WHERE full_name = 'acme/web'");
    assert.deepStrictEqual((await ctx.rows('Acme', 'SELECT deployment_id FROM deployments')).map((r) => Number(r.deployment_id)), [43]);
    assert.strictEqual(Number(web1.deployments_cursor), 40, 'not 43: 41 and 42 are still to do');

    late = false;
    ctx.setOverride(null);
    await ctx.sync();
    assert.deepStrictEqual((await ctx.rows('Acme', 'SELECT deployment_id FROM deployments ORDER BY deployment_id')).map((r) => Number(r.deployment_id)), [41, 42, 43]);
    assert.strictEqual(Number((await ctx.rows('Acme', "SELECT deployments_cursor FROM tracked_repos WHERE full_name = 'acme/web'"))[0].deployments_cursor), 43);
});
