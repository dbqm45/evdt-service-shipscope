const { withScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');

/** No installation with that id is linked to this tenant (or the repo isn't tracked). */
class InstallationNotFoundError extends Error {}
/** The installation is already linked to another tenant. */
class InstallationTakenError extends Error {}

function toInstallation(row) {
    return { installationId: Number(row.installation_id), accountLogin: row.account_login, accountType: row.account_type };
}

/**
 * Links a GitHub App installation to a tenant. Admins only. Re-linking an installation the tenant already
 * has is a no-op that refreshes the account login (the "Configure" flow on GitHub comes back here too).
 * The caller must already have verified that this user can access the installation on GitHub.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, installation: { installationId: number, accountLogin: string, accountType: string } }} input
 * @returns {Promise<{ installationId: number, accountLogin: string, accountType: string }>}
 * @throws {TenantNotFoundError|import('./tenants').ForbiddenError|InstallationTakenError}
 */
async function linkInstallation(pool, { tenantId, actorUserId, installation }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: existing } = await client.query(
            `UPDATE github_installations SET account_login = $3, account_type = $4
             WHERE tenant_id = $1 AND installation_id = $2
             RETURNING installation_id, account_login, account_type`,
            [tenantId, installation.installationId, installation.accountLogin, installation.accountType]
        );
        if (existing.length) return toInstallation(existing[0]);
        try {
            const { rows } = await client.query(
                `INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type, created_by)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING installation_id, account_login, account_type`,
                [tenantId, installation.installationId, installation.accountLogin, installation.accountType, actorUserId]
            );
            return toInstallation(rows[0]);
        } catch (err) {
            // The unique constraint holds across tenants even though RLS hides the other tenant's row.
            if (err.code === '23505') throw new InstallationTakenError('This GitHub installation is already connected to another tenant', { cause: err });
            throw err;
        }
    });
}

/**
 * A tenant's linked installations and tracked repos. Any member may read them.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<{ installations: Array<{ installationId: number, accountLogin: string, accountType: string }>, repos: Array<{ repoId: number, fullName: string, installationId: number, lastSyncedAt: Date|null, lastSyncError: string|null, rateLimitedUntil: Date|null, deployments: number, versionFile: string|null, driftIgnorePaths: string[] }> }>}
 */
async function listConnections(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows: installations } = await client.query(
            'SELECT installation_id, account_login, account_type FROM github_installations WHERE tenant_id = $1 ORDER BY created_at',
            [tenantId]
        );
        const { rows: repos } = await client.query(
            `SELECT r.repo_id, r.full_name, r.installation_id, r.last_synced_at, r.last_sync_error, r.version_file, r.drift_ignore_paths,
                    CASE WHEN i.rate_limited_until > now() THEN i.rate_limited_until END AS rate_limited_until,
                    (SELECT count(*) FROM deployments d WHERE d.tenant_id = r.tenant_id AND d.repo_id = r.repo_id)::int AS deployments
             FROM tracked_repos r
             LEFT JOIN github_installations i ON i.tenant_id = r.tenant_id AND i.installation_id = r.installation_id
             WHERE r.tenant_id = $1 ORDER BY r.full_name`,
            [tenantId]
        );
        return {
            installations: installations.map(toInstallation),
            repos: repos.map((r) => ({
                repoId: Number(r.repo_id),
                fullName: r.full_name,
                installationId: Number(r.installation_id),
                lastSyncedAt: r.last_synced_at,
                lastSyncError: r.last_sync_error,
                rateLimitedUntil: r.rate_limited_until,
                deployments: r.deployments,
                versionFile: r.version_file,
                driftIgnorePaths: r.drift_ignore_paths,
            })),
        };
    });
}

/**
 * Admin check plus "is this installation linked to this tenant", before any call to GitHub on its behalf.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, installationId: number }} input
 * @returns {Promise<Set<number>>} ids of the repos this tenant tracks from that installation
 * @throws {InstallationNotFoundError}
 */
async function trackedRepoIdsForAdmin(pool, { tenantId, actorUserId, installationId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            'SELECT 1 FROM github_installations WHERE tenant_id = $1 AND installation_id = $2',
            [tenantId, installationId]
        );
        if (!rows.length) throw new InstallationNotFoundError('No such installation in this tenant');
        const { rows: tracked } = await client.query(
            'SELECT repo_id FROM tracked_repos WHERE tenant_id = $1 AND installation_id = $2',
            [tenantId, installationId]
        );
        return new Set(tracked.map((r) => Number(r.repo_id)));
    });
}

/**
 * Starts tracking a repo. Admins only; the caller must have checked the repo belongs to the installation
 * (listed by GitHub for it). Idempotent.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, installationId: number, repo: { id: number, fullName: string } }} input
 * @returns {Promise<{ repoId: number, fullName: string, installationId: number }>}
 */
async function trackRepo(pool, { tenantId, actorUserId, installationId, repo }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        await client.query(
            `INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, repo_id) DO UPDATE SET full_name = EXCLUDED.full_name, installation_id = EXCLUDED.installation_id`,
            [tenantId, repo.id, installationId, repo.fullName]
        );
        return { repoId: repo.id, fullName: repo.fullName, installationId };
    });
}

/**
 * Stops tracking a repo. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, repoId: number }} input
 * @returns {Promise<boolean>} false if it wasn't tracked
 */
async function untrackRepo(pool, { tenantId, actorUserId, repoId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rowCount } = await client.query('DELETE FROM tracked_repos WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repoId]);
        return rowCount === 1;
    });
}

/**
 * A tracked repo's version/drift settings (what docs/components.json's `versionFile`/`driftIgnorePaths` are for the
 * file-based sync). Clears the stored drift, so the next sync recomputes it under the new settings. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, repoId: number, versionFile: string|null, driftIgnorePaths: string[] }} input
 * @returns {Promise<{ repoId: number, versionFile: string|null, driftIgnorePaths: string[] }|null>} null if it isn't tracked
 */
async function updateRepoSettings(pool, { tenantId, actorUserId, repoId, versionFile, driftIgnorePaths }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            `UPDATE tracked_repos SET version_file = $3, drift_ignore_paths = $4, drift = '{}'
             WHERE tenant_id = $1 AND repo_id = $2 RETURNING version_file, drift_ignore_paths`,
            [tenantId, repoId, versionFile, driftIgnorePaths]
        );
        if (!rows.length) return null;
        return { repoId, versionFile: rows[0].version_file, driftIgnorePaths: rows[0].drift_ignore_paths };
    });
}

/**
 * Unlinks an installation from the tenant (and stops tracking its repos). It stays installed on GitHub;
 * uninstalling is the organization's own action there. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, installationId: number }} input
 * @returns {Promise<boolean>} false if it wasn't linked to this tenant
 */
async function unlinkInstallation(pool, { tenantId, actorUserId, installationId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rowCount } = await client.query(
            'DELETE FROM github_installations WHERE tenant_id = $1 AND installation_id = $2',
            [tenantId, installationId]
        );
        return rowCount === 1;
    });
}

module.exports = {
    linkInstallation,
    listConnections,
    trackedRepoIdsForAdmin,
    trackRepo,
    untrackRepo,
    updateRepoSettings,
    unlinkInstallation,
    InstallationNotFoundError,
    InstallationTakenError,
};
