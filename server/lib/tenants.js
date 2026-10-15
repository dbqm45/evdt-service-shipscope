const VALID_ROLES = new Set(['admin', 'member']);

class TenantNotFoundError extends Error {}
class AlreadyMemberError extends Error {}

function toUser(row) {
    return { id: row.id, githubUserId: Number(row.github_user_id), githubLogin: row.github_login };
}

function toTenant(row) {
    return { id: row.id, name: row.name, createdAt: row.created_at };
}

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

module.exports = { createTenantWithOwner, addMember, TenantNotFoundError, AlreadyMemberError };
