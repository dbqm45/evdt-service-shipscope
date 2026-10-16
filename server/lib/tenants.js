const { setScope, withScope } = require('./scope');

const VALID_ROLES = new Set(['admin', 'member']);

class TenantNotFoundError extends Error {}
class AlreadyMemberError extends Error {}
/** The caller is a member of the tenant but lacks the admin role the action needs. */
class ForbiddenError extends Error {}
/** The action would leave a tenant without any admin. */
class LastAdminError extends Error {}

function toUser(row) {
    return { id: row.id, githubUserId: Number(row.github_user_id), githubLogin: row.github_login };
}

function toTenant(row) {
    return { id: row.id, name: row.name, createdAt: row.created_at };
}

/**
 * Inserts a user by GitHub identity, or refreshes githubLogin if that githubUserId already exists
 * (logins can be renamed on GitHub; the numeric id can't). users has no RLS -- it's not tenant data.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} client
 * @param {{ githubUserId: number, githubLogin: string }} input
 * @returns {Promise<{ id: string, githubUserId: number, githubLogin: string }>}
 */
async function upsertUser(client, { githubUserId, githubLogin }) {
    const { rows } = await client.query(
        `INSERT INTO users (github_user_id, github_login)
         VALUES ($1, $2)
         ON CONFLICT (github_user_id) DO UPDATE SET github_login = EXCLUDED.github_login, updated_at = now()
         RETURNING id, github_user_id, github_login`,
        [githubUserId, githubLogin]
    );
    return toUser(rows[0]);
}

/**
 * Creates a new tenant plus its first user+admin membership in one transaction. If a user with this
 * githubUserId already exists (already a member of another tenant -- FR-002's accepted "two tenants,
 * same company" risk means this is expected, not an error), their githubLogin is refreshed and they
 * become admin of the new tenant too.
 *
 * @param {import('pg').Pool} pool
 * @param {{ name: string, githubUserId: number, githubLogin: string }} input
 * @returns {Promise<{ tenant: {id: string, name: string, createdAt: Date}, user: {id: string, githubUserId: number, githubLogin: string}, membership: {tenantId: string, userId: string, role: 'admin'} }>}
 * @throws {Error} if name/githubUserId/githubLogin are missing or wrong-typed (validated before any query)
 */
async function createTenantWithOwner(pool, { name, githubUserId, githubLogin }) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');
    if (typeof githubUserId !== 'number' || !Number.isInteger(githubUserId)) throw new Error('githubUserId must be an integer');
    if (typeof githubLogin !== 'string' || !githubLogin.trim()) throw new Error('githubLogin is required');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: tenantRows } = await client.query(
            'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
            [name]
        );
        const tenant = toTenant(tenantRows[0]);
        // The memberships write policy only accepts rows for the tenant this transaction is scoped to.
        await setScope(client, { tenantId: tenant.id });

        const user = await upsertUser(client, { githubUserId, githubLogin });

        await client.query(
            'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
            [tenant.id, user.id, 'admin']
        );

        await client.query('COMMIT');
        return { tenant, user, membership: { tenantId: tenant.id, userId: user.id, role: 'admin' } };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Adds a GitHub-identified user as a member of an existing tenant, upserting the user row by
 * githubUserId if they're new to this system.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, githubUserId: number, githubLogin: string, role: 'admin'|'member' }} input
 * @returns {Promise<{ tenantId: string, userId: string, role: 'admin'|'member' }>}
 * @throws {TenantNotFoundError} tenantId does not reference an existing tenant (FK violation, code 23503)
 * @throws {AlreadyMemberError} this user is already a member of this tenant (PK violation, code 23505)
 * @throws {Error} role is not 'admin'/'member', or other inputs missing/wrong-typed
 */
async function addMember(pool, { tenantId, githubUserId, githubLogin, role }) {
    if (typeof tenantId !== 'string' || !tenantId.trim()) throw new Error('tenantId is required');
    if (typeof githubUserId !== 'number' || !Number.isInteger(githubUserId)) throw new Error('githubUserId must be an integer');
    if (typeof githubLogin !== 'string' || !githubLogin.trim()) throw new Error('githubLogin is required');
    if (!VALID_ROLES.has(role)) throw new Error(`role must be one of: ${[...VALID_ROLES].join(', ')}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setScope(client, { tenantId });

        const user = await upsertUser(client, { githubUserId, githubLogin });

        await client.query(
            'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
            [tenantId, user.id, role]
        );

        await client.query('COMMIT');
        return { tenantId, userId: user.id, role };
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23503') throw new TenantNotFoundError(`No tenant with id ${tenantId}`, { cause: err });
        if (err.code === '23505') throw new AlreadyMemberError(`User is already a member of tenant ${tenantId}`, { cause: err });
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Lists every tenant this user belongs to, with their role in each. Reads through the
 * memberships_self_read RLS policy (user scope), so no tenant has to be chosen first.
 *
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<Array<{ id: string, name: string, role: 'admin'|'member' }>>}
 */
async function listTenantsForUser(pool, userId) {
    return withScope(pool, { userId }, async (client) => {
        const { rows } = await client.query(
            `SELECT t.id, t.name, m.role
             FROM memberships m JOIN tenants t ON t.id = m.tenant_id
             WHERE m.user_id = $1
             ORDER BY t.created_at`,
            [userId]
        );
        return rows.map((row) => ({ id: row.id, name: row.name, role: row.role }));
    });
}

/**
 * Lists a tenant's members, but only if userId is itself a member of that tenant -- returns null
 * otherwise, so a caller can't tell "tenant doesn't exist" apart from "not yours" (both 404).
 * Filters by tenant in SQL and also runs under tenant scope, so RLS still hides every other
 * tenant's rows if that WHERE clause were ever dropped.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, userId: string }} input
 * @returns {Promise<Array<{ userId: string, githubLogin: string, role: 'admin'|'member' }>|null>}
 */
async function listMembersIfMember(pool, { tenantId, userId }) {
    return withScope(pool, { tenantId }, async (client) => {
        const { rows } = await client.query(
            `SELECT u.id AS user_id, u.github_login, m.role
             FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.tenant_id = $1
             ORDER BY m.created_at`,
            [tenantId]
        );
        if (!rows.some((row) => row.user_id === userId)) return null;
        return rows.map((row) => ({ userId: row.user_id, githubLogin: row.github_login, role: row.role }));
    });
}

/**
 * The user's role in a tenant, or null if they're not a member. Must run inside a transaction scoped to
 * that tenant (withScope/setScope), since memberships is RLS-protected.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, userId: string }} input
 * @returns {Promise<'admin'|'member'|null>}
 */
async function roleOf(client, { tenantId, userId }) {
    const { rows } = await client.query(
        'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId]
    );
    return rows.length ? rows[0].role : null;
}

/**
 * Throws unless userId is an admin of tenantId: TenantNotFoundError for a non-member (indistinguishable
 * from a missing tenant), ForbiddenError for a plain member. Call inside the tenant's scope.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, userId: string }} input
 * @returns {Promise<void>}
 */
async function assertAdmin(client, { tenantId, userId }) {
    const role = await roleOf(client, { tenantId, userId });
    if (!role) throw new TenantNotFoundError('Tenant not found');
    if (role !== 'admin') throw new ForbiddenError('Only an admin can do this');
}

/**
 * Removes a member. An admin may remove anyone; any member may remove themselves (leave). The tenant's
 * last admin can't be removed -- that would leave nobody able to manage it.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, targetUserId: string }} input
 * @returns {Promise<void>}
 * @throws {TenantNotFoundError} actor isn't a member, or target isn't a member of this tenant
 * @throws {ForbiddenError} actor is a plain member removing someone else
 * @throws {LastAdminError} target is the only admin
 */
async function removeMember(pool, { tenantId, actorUserId, targetUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        const actorRole = await roleOf(client, { tenantId, userId: actorUserId });
        if (!actorRole) throw new TenantNotFoundError('Tenant not found');
        if (actorUserId !== targetUserId && actorRole !== 'admin') throw new ForbiddenError('Only an admin can remove other members');

        // Lock the tenant's admin rows so two admins removing each other at once can't both pass the check.
        const { rows: admins } = await client.query(
            "SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'admin' FOR UPDATE",
            [tenantId]
        );
        const targetRole = await roleOf(client, { tenantId, userId: targetUserId });
        if (!targetRole) throw new TenantNotFoundError('Member not found');
        if (targetRole === 'admin' && admins.length === 1) throw new LastAdminError('A tenant needs at least one admin');

        await client.query('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, targetUserId]);
    });
}

module.exports = {
    createTenantWithOwner,
    roleOf,
    assertAdmin,
    removeMember,
    addMember,
    upsertUser,
    listTenantsForUser,
    listMembersIfMember,
    TenantNotFoundError,
    AlreadyMemberError,
    ForbiddenError,
    LastAdminError,
};
