const { test } = require('node:test');
const assert = require('node:assert');
const { checkPayload, IngestPayloadError } = require('../lib/flags');

const NOW = new Date('2026-10-16T12:00:00Z');
const obs = (key, env, state, extra = {}) => ({ key, env, state, ...extra });

test('checkPayload: normalizes, derives covered environments, bounds the sender\'s changedAt, rejects contradictions', () => {
    const out = checkPayload({
        observations: [obs('a', 'prod', 'on'), obs('a', 'prod', 'on'), obs('b', 'qa', 'partial', { rollout: 25, changedAt: '2026-10-16T11:00:00Z' })],
        flags: [{ key: 'a', description: 'A' }],
    }, NOW);
    assert.strictEqual(out.complete, true, 'full state by default');
    assert.deepStrictEqual(out.environments, ['prod', 'qa']);
    assert.deepStrictEqual(out.observations.map((o) => [o.key, o.env, o.state, o.rollout, o.changedAt.toISOString()]), [
        ['a', 'prod', 'on', null, NOW.toISOString()],
        ['b', 'qa', 'partial', 25, '2026-10-16T11:00:00.000Z'],
    ]);
    assert.deepStrictEqual(checkPayload({ complete: false, environments: ['test', 'prod'], observations: [] }, NOW).environments, ['test', 'prod']);

    const bad = (payload, message) => assert.throws(() => checkPayload({ observations: [], ...payload }, NOW), (err) => err instanceof IngestPayloadError && message.test(err.message));
    bad({ observations: [obs('a', 'prod', 'on'), obs('a', 'prod', 'off')] }, /conflicting values for a\.prod/);
    bad({ observations: [obs('a', 'prod', 'partial', { rollout: 10 }), obs('a', 'prod', 'partial', { rollout: 20 })] }, /conflicting/);
    bad({ observations: [obs('a', 'prod', 'on', { rollout: 10 })] }, /only meaningful with state "partial"/);
    bad({ observations: [obs('a', 'prod', 'on', { changedAt: '2026-10-16T12:06:00Z' })] }, /in the future/);
    bad({ observations: [obs('a', 'prod', 'on', { changedAt: '2026-10-09T11:59:00Z' })] }, /more than 7 days old/);
    bad({ environments: ['qa'], observations: [obs('a', 'prod', 'on')] }, /prod is not in "environments"/);
    bad({ observations: [obs('__proto__', 'prod', 'on')] }, /not a valid flag key/);
    for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) bad({ observations: [obs(key, 'prod', 'on')] }, /not a valid flag key/);
    bad({ observations: [obs('a', 'prod', 'on')], flags: [{ key: 'toString' }] }, /not a valid flag key/);
    bad({ observations: [obs('a', 'prod', 'on')], flags: [{ key: 'b' }] }, /b has no observations/);
    bad({ observations: [obs('a', 'prod', 'on')], flags: [{ key: 'a' }, { key: 'a' }] }, /listed twice/);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { withScope } = require('../lib/scope');
const { ingestFlags } = require('../lib/flags');

const USERS = { alice: { id: 870_000_001, login: 'alice' }, bob: { id: 870_000_002, login: 'bob' }, mallory: { id: 870_000_003, login: 'mallory' } };

/** A tenant with acme/web (1) and acme/api (2) tracked, alice admin and bob a member. No GitHub App needed. */
async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub(USERS) });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/web'), ($1, 2, 9, 'acme/api')", [tenantId]);
    });
    const bob = await signIn(app, 'bob');
    const link = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice }, payload: { role: 'member' } })).json().url;
    assert.strictEqual((await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } })).statusCode, 201);

    /** Creates a source and returns its token. */
    const newSource = async (payload) => {
        const res = await app.inject({ method: 'POST', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice }, payload });
        assert.strictEqual(res.statusCode, 201, res.body);
        return res.json();
    };
    const ingest = (token, payload) => app.inject({ method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token}` }, payload: { schemaVersion: 2, ...payload } });
    const dashboard = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    return { pool, app, alice, bob, tenantId, newSource, ingest, dashboard, rows };
}

test('ingest: full state per environment -- values, history, removals and a flag coming back', async (t) => {
    const { newSource, ingest, dashboard, rows } = await setup(t);
    const { token } = (await newSource({ name: 'Frontend CI', kind: 'build', repoId: 1 })).token;

    let res = await ingest(token, {
        changedBy: 'ci-bot',
        observations: [obs('newCheckout', 'test', 'on'), obs('newCheckout', 'prod', 'off'), obs('darkMode', 'prod', 'on')],
        flags: [{ key: 'newCheckout', description: 'New checkout flow', jiraKeys: ['ABC-12'] }],
    });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.deepStrictEqual(res.json(), { source: 'Frontend CI', flags: 2, changed: 3, removed: 0, stale: 0, created: ['darkMode', 'newCheckout'] });

    // The same state again: nothing changes.
    res = await ingest(token, { observations: [obs('newCheckout', 'test', 'on'), obs('newCheckout', 'prod', 'off'), obs('darkMode', 'prod', 'on')] });
    assert.deepStrictEqual(res.json(), { source: 'Frontend CI', flags: 2, changed: 0, removed: 0, stale: 0, created: [] });

    // darkMode was deleted from the code: the next full prod state no longer lists it. test isn't covered, so untouched.
    res = await ingest(token, { observations: [obs('newCheckout', 'prod', 'off')] });
    assert.deepStrictEqual([res.json().changed, res.json().removed], [0, 1]);
    let data = await dashboard();
    assert.deepStrictEqual(Object.keys(data.flagsMeta).sort(), ['newCheckout'], 'a flag listed nowhere any more is not shown');
    assert.strictEqual(data.flagStates.newCheckout.test.build.enabled, true, 'environments outside the message are untouched');

    // An incremental message (complete: false) removes nothing; darkMode comes back.
    res = await ingest(token, { complete: false, observations: [obs('darkMode', 'prod', 'on')] });
    assert.deepStrictEqual([res.json().changed, res.json().removed], [1, 0]);
    data = await dashboard();
    assert.deepStrictEqual({ ...data.flagsMeta.newCheckout, createdAt: undefined }, {
        description: 'New checkout flow', source: 'build', jiraKeys: ['ABC-12'], components: ['web'], createdAt: undefined,
    });
    assert.deepStrictEqual(data.flagStates.newCheckout.prod.build, {
        enabled: false, state: 'off', rollout: null, changedAt: data.flagStates.newCheckout.prod.build.changedAt, changedBy: 'ci-bot', component: 'web', sourceName: 'Frontend CI',
    });
    assert.ok(data.flagStates.darkMode.prod.build.enabled);

    const history = await rows('SELECT key, environment, state, removed FROM flag_value_history ORDER BY id');
    assert.deepStrictEqual(history.map((h) => [h.key, h.environment, h.state, h.removed]), [
        ['newCheckout', 'test', 'on', false], ['newCheckout', 'prod', 'off', false], ['darkMode', 'prod', 'on', false],
        ['darkMode', 'prod', null, true],
        ['darkMode', 'prod', 'on', false],
    ]);
    assert.deepStrictEqual(data.flagStateHistory.map((h) => [h.key, h.env, h.enabled]), [
        ['newCheckout', 'test', true], ['newCheckout', 'prod', false], ['darkMode', 'prod', true], ['darkMode', 'prod', true],
    ], 'removals are not flips in the dashboard history');
});

test('ingest: partial rollouts, the sender\'s change time, and delayed messages that must not undo newer ones', async (t) => {
    const { pool, newSource, dashboard, rows } = await setup(t);
    const { token } = (await newSource({ name: 'LaunchDarkly', kind: 'runtime' })).token;
    const at = (iso) => new Date(iso);
    const send = (payload, now) => ingestFlags(pool, { token, payload: { schemaVersion: 2, complete: false, ...payload }, now });

    await send({ observations: [obs('beta', 'prod', 'partial', { rollout: 10, changedAt: '2026-10-16T09:00:00Z' })] }, at('2026-10-16T12:00:00Z'));
    const [stored] = await rows('SELECT state, rollout, changed_at FROM flag_values');
    assert.deepStrictEqual([stored.state, Number(stored.rollout), stored.changed_at.toISOString()], ['partial', 10, '2026-10-16T09:00:00.000Z'], 'the sender\'s time, not the arrival time');

    // A rollout change is a change.
    assert.strictEqual((await send({ observations: [obs('beta', 'prod', 'partial', { rollout: 50, changedAt: '2026-10-16T10:00:00Z' })] }, at('2026-10-16T12:00:00Z'))).changed, 1);
    // A message from 08:00 arriving late: ignored, the 10:00 value stays.
    const late = await send({ observations: [obs('beta', 'prod', 'off', { changedAt: '2026-10-16T08:00:00Z' })] }, at('2026-10-16T12:01:00Z'));
    assert.deepStrictEqual([late.changed, late.stale], [0, 1]);

    const data = await dashboard();
    assert.deepStrictEqual([data.flagStates.beta.prod['runtime-be'].enabled, data.flagStates.beta.prod['runtime-be'].state, data.flagStates.beta.prod['runtime-be'].rollout], [true, 'partial', 50]);
    assert.deepStrictEqual(data.flagsMeta.beta.components, [], 'a source without a repo has no component');
    assert.strictEqual(data.flagsMeta.beta.source, 'runtime-be');
});

test('ingest: several sources of one kind fold by priority, then by the latest change; build and runtime stay separate', async (t) => {
    const { newSource, ingest, dashboard, app, alice, tenantId } = await setup(t);
    const web = await newSource({ name: 'Web build', kind: 'build', repoId: 1 });
    const api = await newSource({ name: 'API build', kind: 'build', repoId: 2 });
    const ld = await newSource({ name: 'LaunchDarkly', kind: 'runtime', priority: 50 });
    const backend = await newSource({ name: 'Backend', kind: 'runtime' }); // default priority 100

    await ingest(web.token.token, { observations: [obs('shared', 'prod', 'on')] });
    await ingest(api.token.token, { observations: [obs('shared', 'prod', 'off')] });
    await ingest(ld.token.token, { observations: [obs('shared', 'prod', 'on')] });
    await ingest(backend.token.token, { observations: [obs('shared', 'prod', 'off')] });

    let data = await dashboard();
    assert.strictEqual(data.flagStates.shared.prod.build.sourceName, 'API build', 'same priority: the latest change wins');
    assert.strictEqual(data.flagStates.shared.prod['runtime-be'].sourceName, 'Backend', 'higher priority wins');
    assert.deepStrictEqual(data.flagsMeta.shared.components, ['api', 'web']);

    // Priority is configuration: raise LaunchDarkly above the backend.
    const put = await app.inject({
        method: 'PUT', url: `/tenants/${tenantId}/flag-sources/${ld.source.id}`, cookies: { sid: alice },
        payload: { name: 'LaunchDarkly', kind: 'runtime', priority: 500, repoId: null },
    });
    assert.strictEqual(put.statusCode, 200, put.body);
    data = await dashboard();
    assert.strictEqual(data.flagStates.shared.prod['runtime-be'].sourceName, 'LaunchDarkly');
    assert.strictEqual(data.flagStates.shared.prod['runtime-be'].enabled, true);
});

test('ingest: tokens are checked and payloads validated; nothing is written by a rejected request', async (t) => {
    const { app, newSource, ingest, rows } = await setup(t);
    const { token } = (await newSource({ name: 'CI', kind: 'build' })).token;
    const good = { observations: [obs('a', 'prod', 'on')] };

    for (const bad of ['', 'nope', `shpi_${'A'.repeat(43)}`, token.slice(0, -1)]) assert.strictEqual((await ingest(bad, good)).statusCode, 401, bad);
    assert.strictEqual((await app.inject({ method: 'POST', url: '/api/flags/ingest', payload: { schemaVersion: 2, ...good } })).statusCode, 401, 'no header');
    for (const bad of [
        { ...good, schemaVersion: 1 },
        { ...good, extra: 1 },
        { ...good, source: 'build' },
        { observations: [{ key: 'a', env: 'prod', enabled: true }] },
        { observations: [obs('a', 'staging', 'on')] },
        { observations: [obs('a', 'prod', 'maybe')] },
        { observations: [obs('a', 'prod', 'partial', { rollout: 101 })] },
        { observations: [obs('a', 'prod', 'on', { changedAt: 'yesterday' })] },
        { observations: [obs('1bad', 'prod', 'on')] },
        { observations: Array.from({ length: 5001 }, (_, i) => obs(`k${i}`, 'prod', 'on')) },
        { ...good, environments: [] },
        { ...good, flags: [{ key: 'a', jiraKeys: ['not-a-key'] }] },
    ]) {
        assert.strictEqual((await ingest(token, bad)).statusCode, 400, JSON.stringify(bad).slice(0, 80));
    }
    assert.deepStrictEqual(await rows('SELECT * FROM flags'), [], 'nothing written by rejected requests');
    assert.strictEqual((await ingest(token, good)).statusCode, 200);
    const [stored] = await rows('SELECT token_hash, last_used_at FROM ingest_tokens');
    assert.ok(stored.last_used_at);
    assert.ok(!stored.token_hash.includes(token.slice(5)), 'only a hash is stored');
});

test('source status: the last accepted message and the last refused one, with its reason, for Settings', async (t) => {
    const { app, alice, tenantId, newSource, ingest } = await setup(t);
    const { token } = (await newSource({ name: 'CI', kind: 'build' })).token;
    await newSource({ name: 'Idle', kind: 'runtime' });
    const status = async () => {
        const res = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice } });
        return Object.fromEntries(res.json().sources.map((s) => [s.name, s]));
    };

    let sources = await status();
    assert.deepStrictEqual([sources.CI.lastIngestAt, sources.CI.lastIngest, sources.CI.lastError], [null, null, null], 'nothing received yet');

    assert.strictEqual((await ingest(token, { observations: [obs('a', 'prod', 'on'), obs('b', 'prod', 'off')] })).statusCode, 200);
    sources = await status();
    assert.deepStrictEqual(sources.CI.lastIngest, { flags: 2, changed: 2, removed: 0, stale: 0 });
    assert.ok(sources.CI.lastIngestAt);
    assert.strictEqual(sources.CI.lastError, null);

    // Refused by the schema (before the handler) and by the server's own checks: both noted, nothing else changes.
    assert.strictEqual((await ingest(token, { observations: [obs('a', 'staging', 'on')] })).statusCode, 400);
    sources = await status();
    assert.match(sources.CI.lastError.message, /^body\/observations\/0\/env must be equal to one of the allowed values/);
    assert.deepStrictEqual(sources.CI.lastIngest, { flags: 2, changed: 2, removed: 0, stale: 0 }, 'the last accepted message stays');
    assert.strictEqual((await ingest(token, { observations: [obs('a', 'prod', 'on'), obs('a', 'prod', 'off')] })).statusCode, 400);
    sources = await status();
    assert.strictEqual(sources.CI.lastError.message, 'conflicting values for a.prod');
    assert.ok(new Date(sources.CI.lastError.at) >= new Date(sources.CI.lastIngestAt));

    // A later accepted message: the error stays on record, older than the success (Settings shows it as past).
    assert.strictEqual((await ingest(token, { observations: [obs('a', 'prod', 'on')] })).statusCode, 200);
    sources = await status();
    assert.deepStrictEqual(sources.CI.lastIngest, { flags: 1, changed: 0, removed: 1, stale: 0 });
    assert.ok(new Date(sources.CI.lastIngestAt) >= new Date(sources.CI.lastError.at));

    // An unknown token belongs to no source; the other source was never touched.
    assert.strictEqual((await ingest(`shpi_${'A'.repeat(43)}`, { observations: [obs('a', 'qa', 'on')], extra: 1 })).statusCode, 400);
    assert.deepStrictEqual([sources.Idle.lastIngestAt, sources.Idle.lastError], [null, null]);
    assert.strictEqual((await status()).CI.lastError.message, 'conflicting values for a.prod');
});

test('flag sources: admins create, list (never the tokens), rename, rotate tokens and delete; members and outsiders cannot', async (t) => {
    const { app, alice, bob, tenantId, newSource, ingest, rows } = await setup(t);
    const created = await newSource({ name: 'Frontend CI', kind: 'build', repoId: 1 });
    assert.deepStrictEqual([created.source.name, created.source.kind, created.source.priority, created.source.repoId], ['Frontend CI', 'build', 0, 1]);
    assert.match(created.token.token, /^shpi_/);
    const mallory = await signIn(app, 'mallory');
    const url = `/tenants/${tenantId}/flag-sources`;

    const list = await app.inject({ method: 'GET', url, cookies: { sid: alice } });
    assert.strictEqual(list.statusCode, 200);
    assert.deepStrictEqual(list.json().sources.map((s) => [s.name, s.tokens.length, s.tokens[0].lastUsedAt]), [['Frontend CI', 1, null]]);
    assert.ok(!list.body.includes(created.token.token.slice(5)), 'the token is shown once, at creation');

    const post = (sid, payload) => app.inject({ method: 'POST', url, cookies: { sid }, payload });
    assert.strictEqual((await post(bob, { name: 'x', kind: 'build' })).statusCode, 403);
    assert.strictEqual((await post(mallory, { name: 'x', kind: 'build' })).statusCode, 404);
    assert.strictEqual((await post(alice, { name: 'Frontend CI', kind: 'runtime' })).statusCode, 409, 'names are unique');
    assert.strictEqual((await post(alice, { name: 'x', kind: 'build', repoId: 99 })).statusCode, 404, 'repo not tracked');
    for (const bad of [{ name: '', kind: 'build' }, { name: 'x', kind: 'remote' }, { name: 'x', kind: 'build', priority: 1001 }, { name: 'x', kind: 'build', extra: 1 }, { name: 'x' }]) {
        assert.strictEqual((await post(alice, bad)).statusCode, 400, JSON.stringify(bad));
    }
    assert.strictEqual((await app.inject({ method: 'GET', url, cookies: { sid: bob } })).statusCode, 403);

    // Rotation: a second token works alongside the first; revoking the first leaves the second.
    const second = await app.inject({ method: 'POST', url: `${url}/${created.source.id}/tokens`, cookies: { sid: alice } });
    assert.strictEqual(second.statusCode, 201);
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/ingest-tokens/${created.token.id}`, cookies: { sid: bob } })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/ingest-tokens/${created.token.id}`, cookies: { sid: alice } })).statusCode, 204);
    assert.strictEqual((await ingest(created.token.token, { observations: [] })).statusCode, 401, 'revoked');
    assert.strictEqual((await ingest(second.json().token, { observations: [obs('a', 'prod', 'on')] })).statusCode, 200);

    // Untracking the repo keeps the source, without a component; deleting the source removes its values and tokens.
    await rows('DELETE FROM tracked_repos WHERE repo_id = 1');
    const dashboard = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    assert.deepStrictEqual((await dashboard()).flagsMeta.a.components, []);
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `${url}/${created.source.id}`, cookies: { sid: alice } })).statusCode, 204);
    assert.deepStrictEqual([await rows('SELECT * FROM flag_values'), await rows('SELECT * FROM ingest_tokens'), await rows('SELECT * FROM flag_value_history')], [[], [], []]);
    assert.deepStrictEqual((await dashboard()).flagsMeta, {});
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `${url}/${created.source.id}`, cookies: { sid: alice } })).statusCode, 404);
});

test('ingest: one tenant\'s ingests run one at a time', async (t) => {
    const { pool, tenantId, newSource, ingest } = await setup(t);
    const { token } = (await newSource({ name: 'CI', kind: 'build' })).token;
    const holder = await pool.connect();
    let pending;
    let settled = false;
    try {
        await holder.query('BEGIN');
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('flags:' || $1, 0))", [tenantId]);
        pending = ingest(token, { observations: [obs('a', 'prod', 'on')] }).then((res) => { settled = true; return res; });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.strictEqual(settled, false, 'waits while another ingest of this tenant is running');
    } finally {
        await holder.query('COMMIT');
        holder.release();
    }
    assert.strictEqual((await pending).statusCode, 200);
});

test('RLS: every table with a tenant_id forces row-level security, and flags are invisible across tenants', async (t) => {
    const { pool, app, alice, tenantId, newSource, ingest } = await setup(t);
    await ingest((await newSource({ name: 'CI', kind: 'build' })).token.token, { observations: [obs('a', 'prod', 'on')] });

    const { rows: tables } = await pool.query(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
         WHERE c.relkind = 'r'`
    );
    assert.ok(tables.length >= 11);
    for (const table of tables) assert.ok(table.relrowsecurity && table.relforcerowsecurity, `${table.relname} forces RLS`);

    for (const table of ['flag_sources', 'ingest_tokens', 'flags', 'flag_values', 'flag_value_history']) {
        assert.deepStrictEqual((await pool.query(`SELECT * FROM ${table}`)).rows, [], `${table} unscoped`);
    }
    const other = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Other' } })).json().tenant.id;
    assert.deepStrictEqual(await withScope(pool, { tenantId: other }, async (c) => (await c.query('SELECT * FROM flag_values')).rows), []);
    assert.strictEqual((await withScope(pool, { tenantId }, async (c) => (await c.query('SELECT * FROM flag_values')).rows)).length, 1);
});

test('the flags adapter (adapters/flags/) end to end: its message is accepted and a second run changes nothing', async (t) => {
    const { app, newSource, dashboard } = await setup(t);
    const { run } = require('../../adapters/flags/lib');
    const { token } = (await newSource({ name: 'AppConfig', kind: 'runtime' })).token;
    // The adapter's fetch, answered by this app instead of the network.
    const fetch = async (url, init) => {
        const res = await app.inject({ method: init.method, url: new URL(url).pathname, headers: init.headers, payload: init.body });
        return { ok: res.statusCode < 400, status: res.statusCode, text: async () => res.body };
    };
    const send = () => run({
        env: 'prod', url: 'https://appconfig.example/flags', valuePath: 'enabled', shipscopeUrl: 'https://ship.example', token,
    }, {
        fetch: (url, init) => (url === 'https://appconfig.example/flags'
            ? Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ newCheckout: { enabled: true }, search: { enabled: 25 } }) })
            : fetch(url, init)),
        log: () => {},
    });
    assert.deepStrictEqual((await send()).result, { source: 'AppConfig', flags: 2, changed: 2, removed: 0, stale: 0, created: ['newCheckout', 'search'] });
    assert.strictEqual((await send()).result.changed, 0);
    const states = (await dashboard()).flagStates;
    assert.deepStrictEqual([states.newCheckout.prod['runtime-be'].state, states.search.prod['runtime-be'].rollout], ['on', 25]);
});
