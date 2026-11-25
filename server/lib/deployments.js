const { withScope } = require('./scope');
const { recordAuditEvent } = require('./audit-log');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');

const MAX_LIMIT = 500;

/** Another workspace is already linked to that suite organization (409). */
class SuiteOrganizationTakenError extends Error {}

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
        rolledBackIssues: row.rolled_back_issues || [],
        skippedEnv: row.skipped_env || null,
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
 * @returns {Promise<{ name: string, deploymentRetentionDays: number, insightsEnabled: boolean }>}
 */
async function getSettings(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows } = await client.query('SELECT name, deployment_retention_days, insights_enabled, suite_organization FROM tenants WHERE id = $1', [tenantId]);
        return settingsOf(rows[0]);
    });
}

const settingsOf = (row) => ({ name: row.name, deploymentRetentionDays: row.deployment_retention_days, insightsEnabled: row.insights_enabled, suiteOrganization: row.suite_organization });

/**
 * Changes the settings given, leaving the others: how many days of deployment history the tenant keeps (7-730,
 * enforced by the database too; applied at the next daily cleanup) and whether the dashboard shows Insights.
 * Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, deploymentRetentionDays?: number, insightsEnabled?: boolean, suiteOrganization?: string|null }} input
 * @returns {Promise<{ name: string, deploymentRetentionDays: number, insightsEnabled: boolean, suiteOrganization: string|null }>}
 */
async function updateSettings(pool, { tenantId, actorUserId, deploymentRetentionDays, insightsEnabled, suiteOrganization }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            `UPDATE tenants SET deployment_retention_days = COALESCE($2, deployment_retention_days), insights_enabled = COALESCE($3, insights_enabled)
              WHERE id = $1 RETURNING name, deployment_retention_days, insights_enabled, suite_organization`,
            [tenantId, deploymentRetentionDays ?? null, insightsEnabled ?? null]
        );
        // The suite organization whose people join with their token's role (design-docs/SUITE-LOGIN-PLAN.pl.md); null unlinks.
        if (suiteOrganization !== undefined && suiteOrganization !== rows[0].suite_organization) {
            await client.query('SAVEPOINT suite_organization');
            try {
                await client.query('UPDATE tenants SET suite_organization = $2 WHERE id = $1', [tenantId, suiteOrganization]);
            } catch (err) {
                if (err.code !== '23505') throw err;
                await client.query('ROLLBACK TO SAVEPOINT suite_organization');
                throw new SuiteOrganizationTakenError('Another workspace is already linked to that suite organization');
            }
            rows[0].suite_organization = suiteOrganization;
            await recordAuditEvent(client, { tenantId, actorUserId, kind: 'suite_organization_changed', subject: suiteOrganization ?? 'none' });
        }
        if (deploymentRetentionDays !== undefined) {
            await recordAuditEvent(client, { tenantId, actorUserId, kind: 'retention_changed', subject: `${rows[0].deployment_retention_days} days` });
        }
        if (insightsEnabled !== undefined) {
            await recordAuditEvent(client, { tenantId, actorUserId, kind: 'insights_changed', subject: rows[0].insights_enabled ? 'on' : 'off' });
        }
        return settingsOf(rows[0]);
    });
}

module.exports = { listDeployments, getSettings, updateSettings, SuiteOrganizationTakenError, MAX_LIMIT };
