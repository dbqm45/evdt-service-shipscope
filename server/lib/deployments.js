const { withScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');

const MAX_LIMIT = 500;

function toDeployment(row, fullNameByRepo) {
    return {
        deploymentId: Number(row.deployment_id),
        repoId: Number(row.repo_id),
        repo: fullNameByRepo.get(Number(row.repo_id)) || null,
        environment: row.environment,
        status: row.status,
        sha: row.sha,
        ref: row.ref,
        deployedAt: row.deployed_at,
        deployedByLogin: row.deployed_by_login,
        workflowRunUrl: row.workflow_run_url,
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        commitUrl: row.commit_url,
        rollbackToSha: row.rollback_to_sha,
        relatedIssues: row.related_issues,
        issueCommitTypes: row.issue_commit_types,
    };
}

/**
 * A tenant's deployments, newest first. Any member may read them.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, repoId?: number, environment?: 'test'|'qa'|'prod', limit?: number }} input
 * @returns {Promise<object[]>}
 */
async function listDeployments(pool, { tenantId, actorUserId, repoId, environment, limit = 100 }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows: repos } = await client.query('SELECT repo_id, full_name FROM tracked_repos WHERE tenant_id = $1', [tenantId]);
        const fullNameByRepo = new Map(repos.map((r) => [Number(r.repo_id), r.full_name]));
        const { rows } = await client.query(
            `SELECT * FROM deployments
             WHERE tenant_id = $1 AND ($2::bigint IS NULL OR repo_id = $2) AND ($3::text IS NULL OR environment = $3)
             ORDER BY deployed_at DESC, deployment_id DESC
             LIMIT $4`,
            [tenantId, repoId ?? null, environment ?? null, Math.min(limit, MAX_LIMIT)]
        );
        return rows.map((row) => toDeployment(row, fullNameByRepo));
    });
}

/**
 * The tenant's settings. Any member may read them.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<{ name: string, deploymentRetentionDays: number }>}
 */
async function getSettings(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows } = await client.query('SELECT name, deployment_retention_days FROM tenants WHERE id = $1', [tenantId]);
        return { name: rows[0].name, deploymentRetentionDays: rows[0].deployment_retention_days };
    });
}

/**
 * Changes how many days of deployment history the tenant keeps (7-730, enforced by the database too).
 * Admins only. Takes effect at the next daily cleanup.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, deploymentRetentionDays: number }} input
 * @returns {Promise<{ name: string, deploymentRetentionDays: number }>}
 */
async function updateSettings(pool, { tenantId, actorUserId, deploymentRetentionDays }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            'UPDATE tenants SET deployment_retention_days = $2 WHERE id = $1 RETURNING name, deployment_retention_days',
            [tenantId, deploymentRetentionDays]
        );
        return { name: rows[0].name, deploymentRetentionDays: rows[0].deployment_retention_days };
    });
}

module.exports = { listDeployments, getSettings, updateSettings, MAX_LIMIT };
