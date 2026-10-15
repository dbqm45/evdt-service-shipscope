const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { createTenantWithOwner, addMember, TenantNotFoundError, AlreadyMemberError } = require('../lib/tenants');

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

test('addMember: admin and member roles both succeed and persist', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const { tenant } = await createTenantWithOwner(pool, { name: 'Acme Inc', githubUserId: uniqueGithubUserId(), githubLogin: 'acme-owner' });

    const member = await addMember(pool, { tenantId: tenant.id, githubUserId: uniqueGithubUserId(), githubLogin: 'acme-member', role: 'member' });
    assert.strictEqual(member.role, 'member');

    const admin2 = await addMember(pool, { tenantId: tenant.id, githubUserId: uniqueGithubUserId(), githubLogin: 'acme-admin-2', role: 'admin' });
    assert.strictEqual(admin2.role, 'admin');
});

test('addMember: throws TenantNotFoundError for a nonexistent tenant', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    await assert.rejects(
        () => addMember(pool, { tenantId: '00000000-0000-0000-0000-000000000000', githubUserId: uniqueGithubUserId(), githubLogin: 'nobody', role: 'member' }),
        TenantNotFoundError
    );
});

test('addMember: throws AlreadyMemberError on a duplicate membership', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const { tenant } = await createTenantWithOwner(pool, { name: 'Acme Inc', githubUserId: uniqueGithubUserId(), githubLogin: 'acme-owner' });
    const githubUserId = uniqueGithubUserId();
    await addMember(pool, { tenantId: tenant.id, githubUserId, githubLogin: 'dup', role: 'member' });

    await assert.rejects(
        () => addMember(pool, { tenantId: tenant.id, githubUserId, githubLogin: 'dup', role: 'member' }),
        AlreadyMemberError
    );
});

test('addMember: rejects an invalid role before running any query', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    await assert.rejects(
        () => addMember(pool, { tenantId: '00000000-0000-0000-0000-000000000000', githubUserId: uniqueGithubUserId(), githubLogin: 'x', role: 'superadmin' }),
        /role must be one of/
    );
});
