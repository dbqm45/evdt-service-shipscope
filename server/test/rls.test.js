const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { createTenantWithOwner } = require('../lib/tenants');
const { withScope } = require('../lib/scope');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

/**
 * The single most important test in this increment: proves Row-Level Security blocks cross-tenant
 * reads at the database level via a direct SQL query, independent of any application-code filtering.
 * This is the guardrail behind the PRD's "Company A can never see Company B's data" commitment.
 */
test('RLS: a session can only read the tenant it is scoped to, and nothing when unscoped', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const a = await createTenantWithOwner(pool, { name: 'Tenant A', githubUserId: 700_000_001, githubLogin: 'a-owner' });
    const b = await createTenantWithOwner(pool, { name: 'Tenant B', githubUserId: 700_000_002, githubLogin: 'b-owner' });

    const client = await pool.connect();
    try {
        await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', a.tenant.id]);
        const { rows: asA } = await client.query('SELECT tenant_id FROM memberships');
        assert.deepStrictEqual(asA.map((r) => r.tenant_id), [a.tenant.id]);

        await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', b.tenant.id]);
        const { rows: asB } = await client.query('SELECT tenant_id FROM memberships');
        assert.deepStrictEqual(asB.map((r) => r.tenant_id), [b.tenant.id]);
    } finally {
        // RESET before release is not test housekeeping -- it's the production rule this test exists
        // to prove. set_config(..., false) persists on the physical connection, and pg's Pool reuses
        // physical connections across logical requests. Any real request handler that sets
        // app.current_tenant_id on a pooled client MUST reset it before releasing, or the next,
        // unrelated request to reuse that connection silently inherits the previous tenant's scope.
        await client.query('RESET app.current_tenant_id');
        client.release();
    }

    // A query through the pool after the reset above -- whether it gets a fresh connection or reuses
    // the one just released, app.current_tenant_id is unset either way, so RLS fails closed: zero
    // rows, never "all rows".
    const { rows: unscoped } = await pool.query('SELECT tenant_id FROM memberships');
    assert.deepStrictEqual(unscoped, []);
});

test('RLS: a membership write outside a tenant scope, or for another tenant, is rejected', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const a = await createTenantWithOwner(pool, { name: 'Tenant A', githubUserId: 700_000_011, githubLogin: 'a-owner' });
    const b = await createTenantWithOwner(pool, { name: 'Tenant B', githubUserId: 700_000_012, githubLogin: 'b-owner' });

    // Unscoped: what a forgotten withScope() in a future handler would look like.
    await assert.rejects(
        () => pool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [a.tenant.id, b.user.id, 'admin']),
        /row-level security/
    );

    // Scoped to B, trying to write into A.
    await assert.rejects(
        () => withScope(pool, { tenantId: b.tenant.id }, (client) =>
            client.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [a.tenant.id, b.user.id, 'admin'])),
        /row-level security/
    );

    // Scoped to B, trying to delete A's rows: RLS hides them, so nothing is deleted.
    const deleted = await withScope(pool, { tenantId: b.tenant.id }, (client) =>
        client.query('DELETE FROM memberships WHERE tenant_id = $1', [a.tenant.id]));
    assert.strictEqual(deleted.rowCount, 0);
});

test('RLS: user scope sees exactly that user\'s memberships across tenants', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const a = await createTenantWithOwner(pool, { name: 'Tenant A', githubUserId: 700_000_021, githubLogin: 'shared' });
    const b = await createTenantWithOwner(pool, { name: 'Tenant B', githubUserId: 700_000_021, githubLogin: 'shared' });
    await createTenantWithOwner(pool, { name: 'Tenant C', githubUserId: 700_000_022, githubLogin: 'other' });

    const rows = await withScope(pool, { userId: a.user.id }, async (client) => (await client.query('SELECT tenant_id FROM memberships')).rows);
    assert.deepStrictEqual(rows.map((r) => r.tenant_id).sort(), [a.tenant.id, b.tenant.id].sort());
});

test('withScope: the scope ends with the transaction, so a reused pooled connection is unscoped', async (t) => {
    const { pool: base, teardown } = await createTestDb();
    t.after(teardown);
    const a = await createTenantWithOwner(base, { name: 'Tenant A', githubUserId: 700_000_031, githubLogin: 'a-owner' });

    // A one-connection pool guarantees the next query reuses the exact physical connection.
    const { Pool } = require('pg');
    const single = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: base.options.options, max: 1 });
    t.after(() => single.end());

    const scoped = await withScope(single, { tenantId: a.tenant.id }, async (client) => (await client.query('SELECT tenant_id FROM memberships')).rows);
    assert.strictEqual(scoped.length, 1);

    const { rows } = await single.query('SELECT tenant_id FROM memberships');
    assert.deepStrictEqual(rows, []);

    // Also after a failed transaction (rollback path).
    await assert.rejects(() => withScope(single, { tenantId: a.tenant.id }, async () => { throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual((await single.query('SELECT tenant_id FROM memberships')).rows, []);
});
