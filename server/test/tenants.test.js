const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { createTenantWithOwner } = require('../lib/tenants');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

let seq = 0;
function uniqueGithubUserId() {
    return 900_000_000 + seq++;
}

test('createTenantWithOwner: creates exactly one admin membership', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const githubUserId = uniqueGithubUserId();
    const result = await createTenantWithOwner(pool, { name: 'Acme Inc', githubUserId, githubLogin: 'acme-owner' });

    assert.strictEqual(result.membership.role, 'admin');

    // memberships has RLS enabled -- reading it back (even to verify our own write) requires scoping
    // the session to this tenant first, same as any real caller would need to. See rls.test.js for why
    // this reset-before-release pattern matters on a pooled connection.
    const client = await pool.connect();
    try {
        await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', result.tenant.id]);
        const { rows } = await client.query('SELECT role FROM memberships WHERE tenant_id = $1', [result.tenant.id]);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].role, 'admin');
    } finally {
        await client.query('RESET app.current_tenant_id');
        client.release();
    }
});

