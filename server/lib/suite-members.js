// People from the suite's identity service (design-docs/SUITE-LOGIN-PLAN.pl.md): their user row and their memberships
// in the workspaces linked to a suite organization, set from the token at every sign-in. A workspace is linked by its
// admin (`tenants.suite_organization`); memberships in workspaces that are not linked (an invitation) are left alone.
const { withScope } = require('./scope');
const { recordAuditEvent } = require('./audit-log');

/**
 * The role a person gets in a linked workspace from the roles of this application in their token: `admin` → admin,
 * `editor` or `viewer` → member (ShipScope has no read-only role), anything else → none.
 *
 * @param {string[]} roles
 * @returns {'admin'|'member'|null}
 */
function suiteRole(roles) {
    if (roles.includes('admin')) return 'admin';
    if (roles.includes('editor') || roles.includes('viewer')) return 'member';
    return null;
}

/**
 * Inserts a person by the suite's `sub`, or refreshes their name. users has no RLS -- it's not tenant data.
 *
 * @param {import('pg').Pool} pool
 * @param {{ sub: string, name: string }} input
 * @returns {Promise<{ id: string, displayName: string }>}
 */
async function upsertSuiteUser(pool, { sub, name }) {
    const { rows } = await pool.query(
        `INSERT INTO users (suite_sub, display_name) VALUES ($1, $2)
         ON CONFLICT (suite_sub) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
         RETURNING id, display_name`,
        [sub, name]
    );
    return { id: rows[0].id, displayName: rows[0].display_name };
}

/**
 * Sets the person's memberships in every linked workspace their token concerns: the workspaces of the organizations it
 * names (joined, or the role changed to the token's) and the linked workspaces they are already in (left when the
 * token no longer names the organization or gives no role). The last admin of a workspace is never removed or
 * lowered: they stay, and the caller is told.
 *
 * @param {import('pg').Pool} pool
 * @param {{ userId: string, displayName: string, organizations: string[], role: 'admin'|'member'|null }} input
 * @returns {Promise<Array<{ tenantId: string, change: 'joined'|'role_changed'|'removed'|'kept_last_admin' }>>}
 */
async function syncSuiteMemberships(pool, { userId, displayName, organizations, role }) {
    const { rows: named } = await pool.query(
        'SELECT id, suite_organization FROM tenants WHERE suite_organization = ANY($1::text[])',
        [organizations]
    );
    const current = await withScope(pool, { userId }, async (client) => (await client.query(
        `SELECT t.id, t.suite_organization FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND t.suite_organization IS NOT NULL`,
        [userId]
    )).rows);
    const tenants = new Map([...named, ...current].map((t) => [t.id, t.suite_organization]));
    const changes = [];
    for (const [tenantId, organization] of tenants) {
        const want = organizations.includes(organization) ? role : null;
        const change = await withScope(pool, { tenantId }, async (client) => {
            // Lock the tenant's admin rows, as removeMember() does, so the last-admin check holds under concurrency.
            const { rows: admins } = await client.query(
                "SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'admin' FOR UPDATE",
                [tenantId]
            );
            const { rows: [mine] } = await client.query('SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
            const have = mine ? mine.role : null;
            if (have === want) return null;
            const lastAdmin = have === 'admin' && admins.length === 1;
            if (lastAdmin) return 'kept_last_admin';
            if (!have) {
                await client.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [tenantId, userId, want]);
                await recordAuditEvent(client, { tenantId, actorUserId: userId, kind: 'member_joined', subject: `${want} (suite)` });
                return 'joined';
            }
            if (!want) {
                await client.query('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
                await recordAuditEvent(client, { tenantId, actorUserId: userId, kind: 'member_removed', subject: `${displayName} (suite)` });
                return 'removed';
            }
            await client.query('UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId, want]);
            await recordAuditEvent(client, { tenantId, actorUserId: userId, kind: 'member_role_changed', subject: `${displayName} (suite, ${want})` });
            return 'role_changed';
        });
        if (change) changes.push({ tenantId, change });
    }
    return changes;
}

/** A GitHub account in a workspace that signs in only through the suite (design-docs/SUITE-LOGIN-PLAN.pl.md, step 3): 403. */
class SuiteOnlyAccessError extends Error {
    constructor() {
        super('This workspace signs in through the suite; sign in with the suite to open it');
    }
}

/**
 * Whether a workspace refuses this user: on in the workspace and the user signed in through GitHub. `tenants` is not
 * an RLS table, so the flag reads without a scope.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {{ tenantId: string, user: { fromSuite: boolean } }} input
 * @returns {Promise<boolean>}
 */
async function refusedBySuiteOnly(db, { tenantId, user }) {
    if (user.fromSuite) return false;
    const { rows } = await db.query('SELECT suite_only FROM tenants WHERE id = $1', [tenantId]);
    return Boolean(rows[0] && rows[0].suite_only);
}

module.exports = { SuiteOnlyAccessError, refusedBySuiteOnly, suiteRole, upsertSuiteUser, syncSuiteMemberships };
