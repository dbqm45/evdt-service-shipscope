const { withScope } = require('./scope');
const { roleOf, TenantNotFoundError } = require('./tenants');
const { readDashboardFlags } = require('./flags');
const { readDashboardJira } = require('./jira-sync');

/**
 * Everything the dashboard (docs/app-*.js) loads, for one tenant, in the exact shapes of the file-based
 * data/*.json it reads on GitHub Pages -- so the views and their tests stay unchanged and only
 * app-data.js's loader differs. Jira issues come per PI from GET /api/tenants/:id/jira-issues (loadJiraIssuesForPi);
 * the views already handle that (they render "no data" states, the same as before a first sync).
 */

/** "org/repo" -> "repo", unless two tracked repos share a short name; then both keep the full name. */
function componentNames(repos) {
    const counts = new Map();
    for (const r of repos) {
        const short = r.full_name.split('/').pop();
        counts.set(short, (counts.get(short) || 0) + 1);
    }
    return new Map(repos.map((r) => {
        const short = r.full_name.split('/').pop();
        return [Number(r.repo_id), counts.get(short) > 1 ? r.full_name : short];
    }));
}

/** One deployments row as a data/deployments.json record (scripts/lib/deployment-records.js buildRecord()). */
function toLegacyRecord(row, component) {
    return {
        id: `gh-${row.deployment_id}`,
        component,
        environment: row.environment,
        // The short sha is what the file-based sync shows when no release/tag/version file/message resolved.
        version: row.version || row.sha.slice(0, 12),
        commitUrl: row.commit_url,
        workflowRunUrl: row.workflow_run_url,
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        manual: row.manual === true,
        rollback: row.rollback_to_sha ? { toRef: shortRef(row.rollback_to_sha) } : null,
        deployedAt: row.deployed_at.toISOString(),
        deployedBy: row.deployed_by_name || row.deployed_by_login || 'unknown',
        deployedByLogin: row.deployed_by_login,
        status: row.status,
        relatedIssues: row.related_issues,
        issueCommitTypes: row.issue_commit_types,
        resolvedRef: row.resolved_ref,
    };
}

/** A commit sha shortened for display; a tag/release name as is. */
function shortRef(ref) {
    return /^[0-9a-f]+$/.test(ref) ? ref.slice(0, 12) : ref;
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<{ deployments: object[], flagsMeta: object, flagStates: object, jiraIndex: { currentPi: string|null, pis: object[] },
 *   flagStateHistory: [], componentsOrder: object[], issueStatusIndex: object, issueDeployments: object,
 *   summary: { components: object }, lastSyncedAt: string|null, jiraBrowseUrl: string|null }>}
 * @throws {TenantNotFoundError} the user isn't a member
 */
async function buildDashboardData(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');

        const { rows: repos } = await client.query(
            'SELECT repo_id, full_name, last_synced_at, drift FROM tracked_repos WHERE tenant_id = $1 ORDER BY created_at, full_name',
            [tenantId]
        );
        const names = componentNames(repos);
        const { rows: deployments } = await client.query(
            'SELECT * FROM deployments WHERE tenant_id = $1 ORDER BY deployed_at DESC, deployment_id DESC',
            [tenantId]
        );
        const { rows: facts } = await client.query(
            'SELECT issue_key, environment, repo_id, first_deployed_at, commit_url FROM issue_deployments WHERE tenant_id = $1',
            [tenantId]
        );

        const issueDeployments = {};
        for (const f of facts) {
            const byEnv = (issueDeployments[f.issue_key] ||= {});
            const byComponent = (byEnv[f.environment] ||= {});
            byComponent[names.get(Number(f.repo_id))] = { deployedAt: f.first_deployed_at.toISOString(), commitUrl: f.commit_url };
        }

        // Drift belongs on each environment's latest successful record, where currentVersion() finds it
        // (rows are newest first, so the first success per repo/environment is that record).
        const driftByRepo = new Map(repos.map((r) => [Number(r.repo_id), r.drift?.envs || {}]));
        const seen = new Set();
        const records = deployments.map((row) => {
            const record = toLegacyRecord(row, names.get(Number(row.repo_id)));
            const key = `${row.repo_id}/${row.environment}`;
            if (row.status === 'success' && !seen.has(key)) {
                seen.add(key);
                const drift = driftByRepo.get(Number(row.repo_id))[row.environment];
                if (drift) record.driftBehind = drift;
            }
            return record;
        });

        const { jiraIndex, issueStatusIndex } = await readDashboardJira(client, { tenantId });
        const { flagsMeta, flagStates, flagStateHistory } = await readDashboardFlags(client, {
            tenantId, componentOf: (repoId) => names.get(repoId),
        });

        // Where an issue key links to: the tenant's own Jira site, or nowhere until Jira is connected (the dashboard
        // then shows keys unlinked rather than pointing them at somebody else's Jira).
        const { rows: [jira] } = await client.query('SELECT site_url FROM jira_connections WHERE tenant_id = $1 AND cloud_id IS NOT NULL', [tenantId]);
        const jiraBrowseUrl = jira && /^https:\/\/[^/\s]+/.test(jira.site_url || '') ? `${jira.site_url.replace(/\/+$/, '')}/browse` : null;

        const synced = repos.map((r) => r.last_synced_at).filter(Boolean).sort((a, b) => b - a);
        return {
            deployments: records,
            flagsMeta,
            flagStates,
            flagStateHistory,
            jiraIndex,
            issueStatusIndex,
            issueDeployments,
            summary: { components: {} },
            componentsOrder: repos.map((r) => ({
                name: names.get(Number(r.repo_id)),
                description: r.full_name,
                serviceType: null,
                featureFlagsIncluded: null,
                application: null,
            })),
            lastSyncedAt: synced.length ? synced[0].toISOString() : null,
            jiraBrowseUrl,
        };
    });
}

module.exports = { buildDashboardData, componentNames };
