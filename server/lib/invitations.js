const crypto = require('crypto');
const { setScope, withScope } = require('./scope');
const { assertAdmin, roleOf, AlreadyMemberError } = require('./tenants');

const INVITATION_TTL_DAYS = 7;
const VALID_ROLES = new Set(['admin', 'member']);
/** 24 random bytes as base64url: 32 characters, used in the invitation URL path. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

class InvitationNotFoundError extends Error {}
/** The invitation exists but can't be used any more; `status` says why. */
class InvitationUnusableError extends Error {
    constructor(status) {
        super(`Invitation is ${status}`);
        this.status = status;
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** @returns {'pending'|'accepted'|'revoked'|'expired'} */
function statusOf(row, now = new Date()) {
    if (row.accepted_at) return 'accepted';
    if (row.revoked_at) return 'revoked';
    if (row.expires_at <= now) return 'expired';
    return 'pending';
}

/**
 * Creates an invitation to tenantId with the given role. Admins only. Returns the raw token once; only
 * its SHA-256 is stored.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, role: 'admin'|'member' }} input
 * @returns {Promise<{ id: string, token: string, role: 'admin'|'member', expiresAt: Date }>}
 * @throws {import('./tenants').TenantNotFoundError|import('./tenants').ForbiddenError}
 */
async function createInvitation(pool, { tenantId, actorUserId, role }) {
    if (!VALID_ROLES.has(role)) throw new Error(`role must be one of: ${[...VALID_ROLES].join(', ')}`);
    const token = crypto.randomBytes(24).toString('base64url');
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            `INSERT INTO invitations (token_hash, tenant_id, role, created_by, expires_at)
             VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
             RETURNING id, role, expires_at`,
            [hashToken(token), tenantId, role, actorUserId, INVITATION_TTL_DAYS]
        );
        return { id: rows[0].id, token, role: rows[0].role, expiresAt: rows[0].expires_at };
    });
}

/**
 * Lists a tenant's pending (not accepted, revoked or expired) invitations. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<{ id: string, role: 'admin'|'member', createdBy: string, createdAt: Date, expiresAt: Date }>>}
 */
async function listPendingInvitations(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            `SELECT i.id, i.role, u.github_login, i.created_at, i.expires_at
             FROM invitations i JOIN users u ON u.id = i.created_by
             WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
             ORDER BY i.created_at`,
            [tenantId]
        );
        return rows.map((row) => ({
            id: row.id, role: row.role, createdBy: row.github_login, createdAt: row.created_at, expiresAt: row.expires_at,
        }));
    });
}

/**
 * Revokes a pending invitation so its link stops working. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, invitationId: string }} input
 * @returns {Promise<boolean>} false if there's no pending invitation with that id in this tenant
 */
async function revokeInvitation(pool, { tenantId, actorUserId, invitationId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rowCount } = await client.query(
            `UPDATE invitations SET revoked_at = now()
             WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
            [invitationId, tenantId]
        );
        return rowCount === 1;
    });
}

/** Reads one invitation through the token-scoped RLS policy. Call inside a transaction. */
async function findByToken(client, token) {
    const tokenHash = hashToken(token);
    await setScope(client, { inviteTokenHash: tokenHash });
    const { rows } = await client.query(
        `SELECT i.id, i.tenant_id, i.role, i.expires_at, i.accepted_at, i.revoked_at, t.name AS tenant_name
         FROM invitations i JOIN tenants t ON t.id = i.tenant_id
         WHERE i.token_hash = $1`,
        [tokenHash]
    );
    return rows[0] || null;
}

/**
 * What an invitation link offers, for the invitee to see before accepting.
 *
 * @param {import('pg').Pool} pool
 * @param {{ token: string, userId: string }} input
 * @returns {Promise<{ tenant: { id: string, name: string }, role: 'admin'|'member', status: 'pending'|'accepted'|'revoked'|'expired', alreadyMember: boolean }>}
 * @throws {InvitationNotFoundError}
 */
async function previewInvitation(pool, { token, userId }) {
    if (!TOKEN_PATTERN.test(token)) throw new InvitationNotFoundError('Invitation not found');
    return withScope(pool, {}, async (client) => {
        const row = await findByToken(client, token);
        if (!row) throw new InvitationNotFoundError('Invitation not found');
        await setScope(client, { tenantId: row.tenant_id });
        const alreadyMember = Boolean(await roleOf(client, { tenantId: row.tenant_id, userId }));
        return { tenant: { id: row.tenant_id, name: row.tenant_name }, role: row.role, status: statusOf(row), alreadyMember };
    });
}

/**
 * Accepts an invitation: the user becomes a member with the invitation's role. Single use -- the
 * invitation is claimed by one conditional UPDATE, so two concurrent accepts can't both succeed.
 *
 * @param {import('pg').Pool} pool
 * @param {{ token: string, userId: string }} input
 * @returns {Promise<{ tenant: { id: string, name: string }, role: 'admin'|'member' }>}
 * @throws {InvitationNotFoundError} unknown token
 * @throws {InvitationUnusableError} already accepted, revoked or expired
 * @throws {import('./tenants').AlreadyMemberError} the user is already a member (the invitation stays unused)
 */
async function acceptInvitation(pool, { token, userId }) {
    if (!TOKEN_PATTERN.test(token)) throw new InvitationNotFoundError('Invitation not found');
    return withScope(pool, {}, async (client) => {
        const row = await findByToken(client, token);
        if (!row) throw new InvitationNotFoundError('Invitation not found');
        const status = statusOf(row);
        if (status !== 'pending') throw new InvitationUnusableError(status);

        await setScope(client, { tenantId: row.tenant_id });
        if (await roleOf(client, { tenantId: row.tenant_id, userId })) {
            throw new AlreadyMemberError('You are already a member of this tenant');
        }

        const { rowCount } = await client.query(
            `UPDATE invitations SET accepted_at = now(), accepted_by = $2
             WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
            [row.id, userId]
        );
        // Lost a race with another accept, a revoke or the expiry since the read above.
        if (rowCount !== 1) throw new InvitationUnusableError('no longer pending');

        await client.query(
            'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
            [row.tenant_id, userId, row.role]
        );
        return { tenant: { id: row.tenant_id, name: row.tenant_name }, role: row.role };
    });
}

module.exports = {
    createInvitation,
    listPendingInvitations,
    revokeInvitation,
    previewInvitation,
    acceptInvitation,
    InvitationNotFoundError,
    InvitationUnusableError,
    TOKEN_PATTERN,
};
