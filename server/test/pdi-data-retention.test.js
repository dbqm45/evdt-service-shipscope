// The pdi layer's data after a disconnect (design-docs/PDI-DATA-RETENTION-PLAN.pl.md, D5): kept 30 days, so connecting
// again starts where it left off; then the daily retention removes it and the repos' changes folders are read anew.
// The core's data (deployments, Jira's release lines) stays.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { judgePdiConnection, PDI_DATA_KEEP_DAYS } = require('../lib/pdi-connection-model');

const DAY = 86_400_000;
const NOW = new Date('2026-10-27T12:00:00Z');

test('model: a disconnected connection says until when its data is kept, or when it was removed', () => {
    assert.strictEqual(PDI_DATA_KEEP_DAYS, 30);
    const row = (over) => ({ receiver_url: 'https://pdi.example.com', created_at: new Date(NOW - 60 * DAY), last_ping_ok_at: null, last_ping_error: null, last_ping_error_at: null, disconnected_at: null, data_removed_at: null, ...over });
    const judge = (connection) => judgePdiConnection({ connection, tokenLastUsedAt: null, subscription: null, now: NOW });
    const kept = judge(row({ disconnected_at: new Date(NOW - 2 * DAY) }));
    assert.deepStrictEqual([kept.dataKeptUntil, kept.dataRemovedAt], [new Date(NOW - 2 * DAY + 30 * DAY).toISOString(), null]);
    const removed = judge(row({ disconnected_at: new Date(NOW - 40 * DAY), data_removed_at: new Date(NOW - 9 * DAY) }));
    assert.deepStrictEqual([removed.dataKeptUntil, removed.dataRemovedAt], [null, new Date(NOW - 9 * DAY).toISOString()]);
    assert.deepStrictEqual([judge(row({})).dataKeptUntil, judge(null).dataKeptUntil], [null, null], 'only once disconnected');
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { withScope } = require('../lib/scope');
const { connectPdiForTest } = require('./helpers/pdi');
const { cleanupPdiLayer, cleanupAll } = require('../lib/retention');
const { connectPdi } = require('../lib/pdi-connection');

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { rows: [user] } = await pool.query("INSERT INTO users (github_user_id, github_login) VALUES (850620001, 'alice') RETURNING id");
    const { rows: [tenant] } = await pool.query("INSERT INTO tenants (name) VALUES ('Acme') RETURNING id");
    const tenantId = tenant.id;
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    await rows("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [tenantId, user.id]);
    await rows("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
    await rows("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name, work_items_ref, work_items_error, work_items_version) VALUES ($1, 1, 9, 'acme/pay', 'abc', 'x: bad', 4)", [tenantId]);
    await rows("INSERT INTO work_items (tenant_id, repo_id, item_key, kind, title, path, ref) VALUES ($1, 1, 'CHG-12', 'change', 'Retry', 'docs/project/changes/CHG-12', 'abc')", [tenantId]);
    await rows("INSERT INTO release_plans (tenant_id, repo_id, change_key, plan, ref) VALUES ($1, 1, 'CHG-12', '{}', 'abc')", [tenantId]);
    await rows("INSERT INTO event_state (tenant_id, kind, subject, value) VALUES ($1, 'seen', 'CHG-12', '')", [tenantId]);
    await rows("INSERT INTO release_lines (tenant_id, item_key, release, origin) VALUES ($1, 'PAY-1', 'R1', 'jira')", [tenantId]);
    await connectPdiForTest(pool, tenantId);
    const disconnect = (daysAgo) => rows('UPDATE pdi_connections SET disconnected_at = $2 WHERE tenant_id = $1', [tenantId, new Date(NOW - daysAgo * DAY)]);
    const counts = async () => (await rows(`SELECT
        (SELECT count(*)::int FROM work_items) AS items, (SELECT count(*)::int FROM release_plans) AS plans,
        (SELECT count(*)::int FROM event_state) AS state, (SELECT count(*)::int FROM release_lines) AS lines`))[0];
    return { pool, tenantId, userId: user.id, rows, disconnect, counts };
}

test('within 30 days of a disconnect nothing goes; after them the pdi layer\'s data does, the core\'s stays', async (t) => {
    const { pool, tenantId, rows, disconnect, counts } = await setup(t);
    const all = { items: 1, plans: 1, state: 1, lines: 1 };

    assert.deepStrictEqual(await cleanupPdiLayer(pool, tenantId, { now: NOW }), { removed: false }, 'connected');
    await disconnect(29);
    assert.deepStrictEqual(await cleanupPdiLayer(pool, tenantId, { now: NOW }), { removed: false }, 'day 29');
    assert.deepStrictEqual(await counts(), all);

    await disconnect(31);
    assert.deepStrictEqual(await cleanupPdiLayer(pool, tenantId, { now: NOW }), { removed: true });
    assert.deepStrictEqual(await counts(), { items: 0, plans: 0, state: 0, lines: 1 }, 'Jira\'s release lines are the core\'s');
    const [repo] = await rows('SELECT work_items_ref, work_items_error, work_items_version FROM tracked_repos');
    assert.deepStrictEqual(repo, { work_items_ref: null, work_items_error: null, work_items_version: 0 }, 'read anew after connecting again');
    const [connection] = await rows('SELECT data_removed_at FROM pdi_connections');
    assert.strictEqual(connection.data_removed_at.toISOString(), NOW.toISOString());
    assert.deepStrictEqual(await cleanupPdiLayer(pool, tenantId, { now: new Date(+NOW + DAY) }), { removed: false }, 'once');
});

test('connecting again before the 30 days keeps the data and clears the removal', async (t) => {
    const { pool, tenantId, userId, rows, disconnect, counts } = await setup(t);
    await disconnect(20);
    await connectPdi(pool, { tenantId, actorUserId: userId, receiverUrl: 'https://pdi.example.com', publicBaseUrl: 'https://shipscope.example.com', encryptionKey: crypto.randomBytes(32), now: NOW });
    assert.deepStrictEqual(await cleanupPdiLayer(pool, tenantId, { now: new Date(+NOW + 40 * DAY) }), { removed: false }, 'connected again');
    assert.deepStrictEqual(await counts(), { items: 1, plans: 1, state: 1, lines: 1 });

    // Removed once, then connected again: the next disconnect counts its own 30 days.
    await rows('UPDATE pdi_connections SET disconnected_at = $2, data_removed_at = $2 WHERE tenant_id = $1', [tenantId, new Date(NOW - 50 * DAY)]);
    await connectPdi(pool, { tenantId, actorUserId: userId, receiverUrl: 'https://pdi.example.com', publicBaseUrl: 'https://shipscope.example.com', encryptionKey: crypto.randomBytes(32), now: NOW });
    const [connection] = await rows('SELECT disconnected_at, data_removed_at FROM pdi_connections');
    assert.deepStrictEqual(connection, { disconnected_at: null, data_removed_at: null });
});

test('the daily retention runs it for every workspace and counts what it cleared', async (t) => {
    const { pool, disconnect, counts } = await setup(t);
    await disconnect(31);
    const deleted = await cleanupAll(pool);
    assert.strictEqual(deleted.pdiLayers, 1);
    assert.strictEqual((await counts()).items, 0);
});
