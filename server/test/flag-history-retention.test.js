// flag_value_history retention (lib/retention.js cleanupFlagHistory(), migration 034): changes older than the tenant's
// retention go, except each source/flag/environment's latest; current values stay; the dashboard reads at most
// HISTORY_READ_LIMIT changes, the newest. Against a real Postgres.
const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { cleanupFlagHistory, cleanupAll } = require('../lib/retention');
const { readDashboardFlags, HISTORY_READ_LIMIT } = require('../lib/flags');

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 899_000_001, login: 'alice' } }) });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const { source, token } = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice }, payload: { name: 'CI', kind: 'build' } })).json();
    const ingest = (observations) => app.inject({ method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token.token}` }, payload: { schemaVersion: 2, complete: false, observations } });
    const scoped = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    return { pool, tenantId, sourceId: source.id, ingest, scoped };
}

test('old flag changes go after the retention; each flag/environment keeps its latest; current values stay', async (t) => {
    const { pool, tenantId, sourceId, ingest, scoped } = await setup(t);
    assert.strictEqual((await ingest([{ key: 'a', env: 'prod', state: 'on' }, { key: 'b', env: 'prod', state: 'on' }])).statusCode, 200);
    // Back-date history: a's prod changed 400, 300 and 10 days ago; b's prod only 200 days ago; a's qa 150 and 120.
    await scoped('DELETE FROM flag_value_history WHERE tenant_id = $1', [tenantId]);
    const old = (key, env, state, days) => scoped(
        `INSERT INTO flag_value_history (tenant_id, source_id, key, environment, state, changed_at, changed_by)
         VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6), 'ci')`,
        [tenantId, sourceId, key, env, state, days]
    );
    await old('a', 'prod', 'off', 400);
    await old('a', 'prod', 'on', 300);
    await old('a', 'prod', 'off', 10);
    await old('b', 'prod', 'on', 200);
    await old('a', 'qa', 'on', 150);
    await old('a', 'qa', 'off', 120);
    const left = async () => (await scoped('SELECT key, environment, state, (now() - changed_at) > interval \'100 days\' AS old FROM flag_value_history ORDER BY key, environment, changed_at'))
        .map((r) => `${r.key}/${r.environment}/${r.state}${r.old ? '/old' : ''}`);

    assert.strictEqual(await cleanupFlagHistory(pool, tenantId), 3, 'default 90 days');
    assert.deepStrictEqual(await left(), ['a/prod/off', 'a/qa/off/old', 'b/prod/on/old'], 'the latest per flag/environment stays, however old');
    assert.strictEqual((await scoped('SELECT * FROM flag_values')).length, 2, 'current values are untouched');

    await pool.query('UPDATE tenants SET deployment_retention_days = 7 WHERE id = $1', [tenantId]);
    assert.strictEqual(await cleanupFlagHistory(pool, tenantId), 0, 'the rest are latest');
    assert.deepStrictEqual(await cleanupAll(pool), { deployments: 0, flagChanges: 0, pdiLayers: 0 });
});

test('the dashboard reads the newest HISTORY_READ_LIMIT changes, oldest first', async (t) => {
    const { pool, tenantId, sourceId, scoped } = await setup(t);
    await scoped(
        `INSERT INTO flag_value_history (tenant_id, source_id, key, environment, state, changed_at, changed_by)
         SELECT $1, $2, 'a', 'prod', CASE WHEN i % 2 = 0 THEN 'on' ELSE 'off' END, now() - make_interval(mins => $3 - i), 'ci'
         FROM generate_series(1, $3) AS i`,
        [tenantId, sourceId, HISTORY_READ_LIMIT + 50]
    );
    const { flagStateHistory } = await withScope(pool, { tenantId }, (client) => readDashboardFlags(client, { tenantId, componentOf: () => 'web' }));
    assert.strictEqual(flagStateHistory.length, HISTORY_READ_LIMIT);
    const times = flagStateHistory.map((r) => Date.parse(r.changedAt));
    assert.ok(times.every((v, i) => i === 0 || v >= times[i - 1]), 'oldest first');
    const newest = (await scoped('SELECT max(changed_at) AS at FROM flag_value_history'))[0].at;
    assert.strictEqual(times.at(-1), newest.getTime(), 'the newest are the ones kept');
});
