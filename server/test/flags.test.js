const { test } = require('node:test');
const assert = require('node:assert');
const { checkPayload, IngestPayloadError } = require('../lib/flags');

const REPO = { fullName: 'acme/web' };
const obs = (key, env, enabled) => ({ key, env, enabled });

test('checkPayload: groups values by key, takes the component from the token, rejects conflicts and prototype keys', () => {
    const { valuesByKey, metaByKey } = checkPayload({
        source: 'build',
        component: 'web',
        observations: [obs('a', 'prod', true), obs('a', 'qa', false), obs('a', 'prod', true), obs('b', 'test', true)],
        flags: [{ key: 'a', description: 'A', jiraKeys: ['ABC-1'] }],
    }, REPO);
    assert.deepStrictEqual(valuesByKey, { a: { prod: true, qa: false }, b: { test: true } });
    assert.deepStrictEqual([...metaByKey.keys()], ['a']);
    assert.doesNotThrow(() => checkPayload({ source: 'build', component: 'acme/web', observations: [] }, REPO));

    const bad = (payload, message) => assert.throws(() => checkPayload({ source: 'build', observations: [], ...payload }, REPO), (err) => err instanceof IngestPayloadError && message.test(err.message));
    bad({ component: 'api' }, /does not match this token's repository "acme\/web"/);
    bad({ observations: [obs('a', 'prod', true), obs('a', 'prod', false)] }, /conflicting values for a\.prod/);
    bad({ observations: [obs('__proto__', 'prod', true)] }, /not a valid flag key/);
    bad({ observations: [obs('a', 'prod', true)], flags: [{ key: 'b' }] }, /b has no observations/);
    bad({ observations: [obs('a', 'prod', true)], flags: [{ key: 'a' }, { key: 'a' }] }, /listed twice/);
    bad({ observations: [obs('constructor', 'prod', true)], flags: [{ key: 'constructor' }] }, /not a valid flag key/);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { withScope } = require('../lib/scope');

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

    const newToken = async (repoId, label = 'CI') => {
        const res = await app.inject({ method: 'POST', url: `/tenants/${tenantId}/repos/${repoId}/ingest-tokens`, cookies: { sid: alice }, payload: { label } });
        assert.strictEqual(res.statusCode, 201, res.body);
        return res.json().token;
    };
    const ingest = (token, payload) => app.inject({ method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token}` }, payload });
    const dashboard = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json();
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    return { pool, app, alice, bob, tenantId, newToken, ingest, dashboard, rows };
}

test('ingest: values, metadata and history land in the dashboard shapes; resends change nothing', async (t) => {
    const { newToken, ingest, dashboard, rows } = await setup(t);
    const web = await newToken(1);

    let res = await ingest(web, {
        schemaVersion: 1,
        source: 'build',
        changedBy: 'ci-bot',
        observations: [obs('newCheckout', 'test', true), obs('newCheckout', 'prod', false), obs('darkMode', 'qa', true)],
        flags: [{ key: 'newCheckout', description: 'New checkout flow', jiraKeys: ['ABC-12'] }],
    });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.deepStrictEqual(res.json(), { component: 'acme/web', flags: 2, changed: 3, created: ['darkMode', 'newCheckout'], collisions: [] });

    // The same payload again: nothing changes, no history.
    res = await ingest(web, { schemaVersion: 1, source: 'build', observations: [obs('newCheckout', 'test', true), obs('newCheckout', 'prod', false)] });
    assert.deepStrictEqual(res.json(), { component: 'acme/web', flags: 1, changed: 0, created: [], collisions: [] });
    assert.strictEqual((await rows('SELECT * FROM flag_state_history')).length, 3);

    // A flip, from a runtime source; metadata left out stays as it was.
    res = await ingest(web, { schemaVersion: 1, source: 'runtime-be', observations: [obs('newCheckout', 'prod', true)] });
    assert.strictEqual(res.json().changed, 1);

    const data = await dashboard();
    assert.deepStrictEqual(Object.keys(data.flagsMeta).sort(), ['darkMode', 'newCheckout']);
    assert.deepStrictEqual({ ...data.flagsMeta.newCheckout, createdAt: undefined }, {
        description: 'New checkout flow', source: 'runtime-be', jiraKeys: ['ABC-12'], components: ['web'], createdAt: undefined,
    });
    assert.deepStrictEqual(data.flagsMeta.darkMode.description, '');
    const prod = data.flagStates.newCheckout.prod;
    assert.deepStrictEqual([prod.build.enabled, prod.build.changedBy, prod.build.component], [false, 'ci-bot', 'web']);
    assert.deepStrictEqual([prod['runtime-be'].enabled, prod['runtime-be'].changedBy], [true, 'ingest: acme/web']);
    assert.deepStrictEqual(data.flagStateHistory.map((h) => [h.key, h.env, h.source, h.enabled]), [
        ['newCheckout', 'test', 'build', true],
        ['newCheckout', 'prod', 'build', false],
        ['darkMode', 'qa', 'build', true],
        ['newCheckout', 'prod', 'runtime-be', true],
    ], 'oldest first');
});

test('ingest: another repo sending the same key and source is a collision; the rest of its payload still applies', async (t) => {
    const { newToken, ingest, dashboard } = await setup(t);
    const web = await newToken(1);
    const api = await newToken(2);
    await ingest(web, { schemaVersion: 1, source: 'build', observations: [obs('shared', 'prod', true)] });

    const res = await ingest(api, {
        schemaVersion: 1,
        source: 'build',
        observations: [obs('shared', 'prod', false), obs('apiOnly', 'prod', true)],
        flags: [{ key: 'shared', description: 'hijack' }],
    });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.deepStrictEqual(res.json().collisions, [{ key: 'shared', ownedBy: 'acme/web' }]);
    assert.strictEqual(res.json().changed, 1);
    // A different source for the same key is deliberate sharing (a FE build flag and a BE runtime flag), not a collision.
    assert.deepStrictEqual((await ingest(api, { schemaVersion: 1, source: 'runtime-be', observations: [obs('shared', 'prod', false)] })).json().collisions, []);

    const data = await dashboard();
    assert.strictEqual(data.flagStates.shared.prod.build.enabled, true, 'not overwritten');
    assert.strictEqual(data.flagsMeta.shared.description, '', 'metadata of a collided key is not applied');
    assert.deepStrictEqual(data.flagsMeta.shared.components, ['api', 'web']);
});

test('ingest: one tenant\'s ingests run one at a time, so two senders of a new key cannot both own it', async (t) => {
    const { pool, tenantId, newToken, ingest } = await setup(t);
    const web = await newToken(1);
    const holder = await pool.connect();
    let pending;
    let settled = false;
    try {
        await holder.query('BEGIN');
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('flags:' || $1, 0))", [tenantId]);
        pending = ingest(web, { schemaVersion: 1, source: 'build', observations: [obs('a', 'prod', true)] }).then((res) => { settled = true; return res; });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.strictEqual(settled, false, 'waits while another ingest of this tenant is running');
    } finally {
        await holder.query('COMMIT');
        holder.release();
    }
    assert.strictEqual((await pending).statusCode, 200);
});

test('ingest: tokens are checked, payloads validated, and untracking a repo removes its flags and tokens', async (t) => {
    const { app, newToken, ingest, dashboard, rows } = await setup(t);
    const web = await newToken(1);
    const good = { schemaVersion: 1, source: 'build', observations: [obs('a', 'prod', true)] };

    for (const token of ['', 'nope', `shpi_${'A'.repeat(43)}`, web.slice(0, -1)]) {
        assert.strictEqual((await ingest(token, good)).statusCode, 401, token);
    }
    assert.strictEqual((await app.inject({ method: 'POST', url: '/api/flags/ingest', payload: good })).statusCode, 401, 'no header');
    for (const bad of [
        { ...good, schemaVersion: 2 },
        { ...good, source: 'launchdarkly' },
        { ...good, extra: 1 },
        { ...good, observations: [{ key: 'a', env: 'staging', enabled: true }] },
        { ...good, observations: [{ key: 'a', env: 'prod', enabled: 'true' }] },
        { ...good, observations: [{ key: '1bad', env: 'prod', enabled: true }] },
        { ...good, observations: Array.from({ length: 5001 }, (_, i) => obs(`k${i}`, 'prod', true)) },
        { ...good, flags: [{ key: 'a', jiraKeys: ['not-a-key'] }] },
        { ...good, component: 'acme/api' },
    ]) {
        assert.strictEqual((await ingest(web, bad)).statusCode, 400, JSON.stringify(bad).slice(0, 80));
    }
    assert.strictEqual((await rows('SELECT * FROM flags')).length, 0, 'nothing written by rejected requests');

    assert.strictEqual((await ingest(web, good)).statusCode, 200);
    const [token] = await rows('SELECT token_hash, last_used_at FROM ingest_tokens');
    assert.ok(token.last_used_at);
    assert.notStrictEqual(token.token_hash, web, 'only a hash is stored');

    // Untracking (the GitHub routes' DELETE does exactly this delete).
    await rows('DELETE FROM tracked_repos WHERE repo_id = 1');
    assert.deepStrictEqual(await rows('SELECT * FROM ingest_tokens'), []);
    assert.deepStrictEqual(await rows('SELECT * FROM flag_states'), []);
    assert.deepStrictEqual(await rows('SELECT * FROM flag_state_history'), []);
    assert.deepStrictEqual((await dashboard()).flagsMeta, {}, 'a flag with nothing left is not shown');
    assert.strictEqual((await ingest(web, good)).statusCode, 401, 'its token went with it');
});

test('ingest tokens: admins create, list (never the token) and revoke; members and outsiders cannot', async (t) => {
    const { app, alice, bob, tenantId, newToken, ingest } = await setup(t);
    const token = await newToken(1, 'GitHub Actions');
    const mallory = await signIn(app, 'mallory');

    const list = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/ingest-tokens`, cookies: { sid: alice } });
    assert.strictEqual(list.statusCode, 200);
    const [entry] = list.json().tokens;
    assert.deepStrictEqual([entry.repoId, entry.fullName, entry.label, entry.lastUsedAt], [1, 'acme/web', 'GitHub Actions', null]);
    assert.ok(!JSON.stringify(list.json()).includes(token.slice(5)), 'the token is shown once, at creation');

    const create = (sid, repoId, payload = { label: 'x' }) => app.inject({ method: 'POST', url: `/tenants/${tenantId}/repos/${repoId}/ingest-tokens`, cookies: { sid }, payload });
    assert.strictEqual((await create(bob, 1)).statusCode, 403);
    assert.strictEqual((await create(mallory, 1)).statusCode, 404);
    assert.strictEqual((await create(alice, 99)).statusCode, 404, 'not tracked');
    assert.strictEqual((await create(alice, 1, { label: '' })).statusCode, 400);
    assert.strictEqual((await create(alice, 1, { label: 'x', repoId: 2 })).statusCode, 400);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/ingest-tokens`, cookies: { sid: bob } })).statusCode, 403);

    const del = (sid, id) => app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/ingest-tokens/${id}`, cookies: { sid } });
    assert.strictEqual((await del(bob, entry.id)).statusCode, 403);
    assert.strictEqual((await del(alice, entry.id)).statusCode, 204);
    assert.strictEqual((await del(alice, entry.id)).statusCode, 404);
    assert.strictEqual((await ingest(token, { schemaVersion: 1, source: 'build', observations: [] })).statusCode, 401, 'revoked');
});

test('RLS: every table with a tenant_id forces row-level security, and flags are invisible across tenants', async (t) => {
    const { pool, app, alice, tenantId, newToken, ingest } = await setup(t);
    await ingest(await newToken(1), { schemaVersion: 1, source: 'build', observations: [obs('a', 'prod', true)] });

    const { rows: tables } = await pool.query(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
         WHERE c.relkind = 'r'`
    );
    assert.ok(tables.length >= 10);
    for (const table of tables) assert.ok(table.relrowsecurity && table.relforcerowsecurity, `${table.relname} forces RLS`);

    for (const table of ['flags', 'flag_states', 'flag_state_history', 'ingest_tokens']) {
        assert.deepStrictEqual((await pool.query(`SELECT * FROM ${table}`)).rows, [], `${table} unscoped`);
    }
    const other = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Other' } })).json().tenant.id;
    assert.deepStrictEqual(await withScope(pool, { tenantId: other }, async (c) => (await c.query('SELECT * FROM flag_states')).rows), []);
    assert.strictEqual((await withScope(pool, { tenantId }, async (c) => (await c.query('SELECT * FROM flag_states')).rows)).length, 1);
});
