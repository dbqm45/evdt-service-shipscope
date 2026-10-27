const { withScope } = require('./scope');
const { PDI_DATA_KEEP_DAYS } = require('./pdi-connection-model');

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
 * Removes the pdi layer's data of a workspace disconnected from pdi more than PDI_DATA_KEEP_DAYS ago (decision D5,
 * design-docs/PDI-DATA-RETENTION-PLAN.pl.md): the work items and release plans read from its repos and the outgoing
 * events' state; its repos' changes folders are read anew once it connects again. Once per disconnect
 * (`data_removed_at`). Jira's release lines and the `Flag:` commit links are the core's and stay.
 *
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ removed: boolean }>}
 */
async function cleanupPdiLayer(pool, tenantId, { now = new Date() } = {}) {
    return withScope(pool, { tenantId }, async (client) => {
        const { rowCount } = await client.query(
            `UPDATE pdi_connections SET data_removed_at = $2
              WHERE tenant_id = $1 AND data_removed_at IS NULL
                AND disconnected_at < $2::timestamptz - make_interval(days => $3)`,
            [tenantId, now, PDI_DATA_KEEP_DAYS]
        );
        if (!rowCount) return { removed: false };
        await client.query('DELETE FROM work_items WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM release_plans WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM event_state WHERE tenant_id = $1', [tenantId]);
        await client.query('UPDATE tracked_repos SET work_items_ref = NULL, work_items_error = NULL, work_items_version = 0 WHERE tenant_id = $1', [tenantId]);
        return { removed: true };
    });
}

/**
 * Runs cleanupTenant, cleanupFlagHistory and cleanupPdiLayer for every tenant, each under its own scope.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ deployments: number, flagChanges: number, pdiLayers: number }>} records deleted in total, and
 *   the workspaces whose pdi layer was cleared
 */
async function cleanupAll(pool) {
    const { rows } = await pool.query('SELECT id FROM tenants');
    const deleted = { deployments: 0, flagChanges: 0, pdiLayers: 0 };
    for (const { id } of rows) {
        deleted.deployments += await cleanupTenant(pool, id);
        deleted.flagChanges += await cleanupFlagHistory(pool, id);
        if ((await cleanupPdiLayer(pool, id)).removed) deleted.pdiLayers += 1;
    }
    return deleted;
}

module.exports = { cleanupTenant, cleanupFlagHistory, cleanupPdiLayer, cleanupAll };
