const { withScope } = require('./scope');

/**
 * Deletes a tenant's deployment records older than its retention (tenants.deployment_retention_days),
 * except, per repo and environment, the latest record and the latest successful one -- whatever their age,
 * since "what runs now" and rollback detection depend on them. issue_deployments is never trimmed.
 *
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @returns {Promise<number>} records deleted
 */
async function cleanupTenant(pool, tenantId) {
    return withScope(pool, { tenantId }, async (client) => {
        const { rowCount } = await client.query(
            `WITH keep AS (
                 (SELECT DISTINCT ON (repo_id, environment) deployment_id FROM deployments
                  WHERE tenant_id = $1 ORDER BY repo_id, environment, deployed_at DESC, deployment_id DESC)
                 UNION
                 (SELECT DISTINCT ON (repo_id, environment) deployment_id FROM deployments
                  WHERE tenant_id = $1 AND status = 'success' ORDER BY repo_id, environment, deployed_at DESC, deployment_id DESC)
             )
             DELETE FROM deployments
             WHERE tenant_id = $1
               AND deployed_at < now() - make_interval(days => (SELECT deployment_retention_days FROM tenants WHERE id = $1))
               AND deployment_id NOT IN (SELECT deployment_id FROM keep)`,
            [tenantId]
        );
        return rowCount;
    });
}

/**
 * Deletes a tenant's flag changes (flag_value_history) older than the same retention, except, per source, flag and
 * environment, the latest one -- whatever its age, so the Deployment history still shows when each flag last changed.
 * Current values (flag_values) are never touched.
 *
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @returns {Promise<number>} changes deleted
 */
async function cleanupFlagHistory(pool, tenantId) {
    return withScope(pool, { tenantId }, async (client) => {
        const { rowCount } = await client.query(
            `WITH keep AS (
                 SELECT DISTINCT ON (source_id, key, environment) id FROM flag_value_history
                 WHERE tenant_id = $1 ORDER BY source_id, key, environment, changed_at DESC, id DESC
             )
             DELETE FROM flag_value_history
             WHERE tenant_id = $1
               AND changed_at < now() - make_interval(days => (SELECT deployment_retention_days FROM tenants WHERE id = $1))
               AND id NOT IN (SELECT id FROM keep)`,
            [tenantId]
        );
        return rowCount;
    });
}

/**
 * Runs cleanupTenant and cleanupFlagHistory for every tenant, each under its own scope.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ deployments: number, flagChanges: number }>} records deleted in total
 */
async function cleanupAll(pool) {
    const { rows } = await pool.query('SELECT id FROM tenants');
    const deleted = { deployments: 0, flagChanges: 0 };
    for (const { id } of rows) {
        deleted.deployments += await cleanupTenant(pool, id);
        deleted.flagChanges += await cleanupFlagHistory(pool, id);
    }
    return deleted;
}

module.exports = { cleanupTenant, cleanupFlagHistory, cleanupAll };
