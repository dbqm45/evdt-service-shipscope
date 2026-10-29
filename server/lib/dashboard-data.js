const { withScope } = require('./scope');
const { pdiLayer } = require('./pdi-layer');
const { readWorkItems, readReleasePlans } = require('./work-items');
const { CHANGES_KEY, CHANGES_LABEL, workItemIssues } = require('./work-items-model');
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

/** One deployments row in the dashboard's deployment-record shape (CLAUDE.md, "Dashboard data"). */
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
        // Only on a rollback that took issues off (docs/app-model.js keyDeployment()).
        ...(row.rolled_back_issues?.length && { rolledBackIssues: row.rolled_back_issues }),
        // A QA/PROD deploy of a version the stage before never had (lib/deployment-logic.js skippedStage()).
        ...(row.skipped_env && { skippedEnv: row.skipped_env }),
        issueCommitTypes: row.issue_commit_types,
        resolvedRef: row.resolved_ref,
    };
}

/**
 * The release plan (G1.3): every work item with a release line, in the shape the Release plan tab reads, its fields
 * from the newest synced copy of the issue (whatever increment it is in); a line whose issue is no longer synced (a
 * board deselected, another site) is left out. `plans` holds the plans read from the repos' changes/CHG-n/release.yaml
 * (pdi contract 0.4.0, lib/work-items.js); their tasks are lines too, titled from the work items (`mode: 'repo'`).
 *
 * @param {import('pg').PoolClient} client inside withScope()
 * @param {string} tenantId
 * @param {Array<{ key: string, title: string }>} [workItems] readWorkItems()
 * @returns {Promise<{ mode: 'jira'|'repo', lines: Array<{ key: string, release: string, title: string, type: string|null, epicKey: string|null, epicTitle: string|null, subtaskKeys: string[], blockedByKeys: string[], dependencyBlocked: boolean, featureFlags: string[] }>, plans: object[] }>}
 */
async function readReleasePlan(client, tenantId, workItems = []) {
    const { rows } = await client.query(
        `SELECT DISTINCT ON (l.item_key) l.item_key, l.release, i.data
         FROM release_lines l
         JOIN jira_issues i ON i.tenant_id = l.tenant_id AND i.key = l.item_key
         WHERE l.tenant_id = $1
         ORDER BY l.item_key, i.synced_at DESC`,
        [tenantId]
    );
    const lines = rows.map((r) => {
        const d = r.data || {};
        return {
            key: r.item_key,
            release: r.release,
            title: d.title || r.item_key,
            type: d.type || null,
            epicKey: d.epicKey || null,
            epicTitle: d.epicTitle || null,
            subtaskKeys: Array.isArray(d.subtaskKeys) ? d.subtaskKeys : [],
            blockedByKeys: Array.isArray(d.blockedByKeys) ? d.blockedByKeys : [],
            dependencyBlocked: d.dependencyBlocked === true,
            featureFlags: Array.isArray(d.featureFlags) ? d.featureFlags : [],
        };
    });
    // Line order (R1, R2, … R10), then key.
    const n = (release) => Number(release.slice(1));
    lines.sort((a, b) => n(a.release) - n(b.release) || a.key.localeCompare(b.key, 'en', { numeric: true }));
    // Plans kept in a repo (release.yaml): their tasks are lines too, titled from plan.md (work_items).
    const plans = await readReleasePlans(client, tenantId);
    const itemOf = new Map(workItems.map((w) => [w.key, w]));
    const planned = new Set();
    const planLines = [];
    for (const plan of plans) {
        const changeTitle = itemOf.get(plan.change)?.title || plan.change;
        for (const release of plan.releases) {
            for (const key of release.tasks) {
                if (planned.has(key)) continue;
                planned.add(key);
                planLines.push({
                    key, release: release.id, title: itemOf.get(key)?.title || key, type: 'Story', epicKey: plan.change, epicTitle: changeTitle,
                    subtaskKeys: [], blockedByKeys: [], dependencyBlocked: false, featureFlags: [],
                });
            }
        }
    }
    // A task a repo plan places wins over a Jira line of the same key.
    return { mode: plans.length ? 'repo' : 'jira', lines: [...lines.filter((l) => !planned.has(l.key)), ...planLines], plans };
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
 *   lastSyncedAt: string|null, jiraBrowseUrl: string|null, releasePlan: { mode: string, lines: object[], plans: object[] }, workItemUrls: Object<string, string> }>}
 * @throws {TenantNotFoundError} the user isn't a member
 */
async function buildDashboardData(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        // People see the pdi layer only once the workspace is connected with pdi (design-docs/PDI-GATE-PLAN.pl.md).
        const { visible } = await pdiLayer(client, { tenantId });
        const data = await readDashboardData(client, { tenantId, pdi: visible });
        // Insights is the workspace's choice (design-docs/CORE-SIMPLIFY-PLAN.pl.md, D2).
        const { rows } = await client.query('SELECT insights_enabled FROM tenants WHERE id = $1', [tenantId]);
        return { ...data, capabilities: { ...data.capabilities, insights: rows[0].insights_enabled } };
    });
}

/**
 * The dashboard data of one tenant, without a member check: for the worker (lib/release-status.js), which acts for the
 * tenant itself. Same shape as buildDashboardData().
 *
 * @param {import('pg').PoolClient} client inside withScope()
 * @param {{ tenantId: string, pdi?: boolean }} input `pdi: false` leaves out the pdi layer (changes from the repos, the
 *   release plan) and says so in `capabilities.pdi`; the worker and the service API read it all
 * @returns {Promise<object>}
 */
async function readDashboardData(client, { tenantId, pdi = true }) {
    const { rows: repos } = await client.query(
        'SELECT repo_id, full_name, last_synced_at, drift, flag_stance, service_role FROM tracked_repos WHERE tenant_id = $1 ORDER BY created_at, full_name',
        [tenantId]
    );
    const names = componentNames(repos);
    const { rows: deployments } = await client.query(
        'SELECT * FROM deployments WHERE tenant_id = $1 ORDER BY deployed_at DESC, deployment_id DESC',
        [tenantId]
    );
    const { rows: facts } = await client.query(
        'SELECT issue_key, environment, repo_id, first_deployed_at, commit_url, rolled_back_at FROM issue_deployments WHERE tenant_id = $1',
        [tenantId]
    );

    const issueDeployments = {};
    for (const f of facts) {
        const byEnv = (issueDeployments[f.issue_key] ||= {});
        const byComponent = (byEnv[f.environment] ||= {});
        byComponent[names.get(Number(f.repo_id))] = {
            deployedAt: f.first_deployed_at.toISOString(), commitUrl: f.commit_url,
            // Taken off by a rollback and not deployed again since (docs/app-model.js keyDeployment()).
            ...(f.rolled_back_at && { rolledBackAt: f.rolled_back_at.toISOString() }),
        };
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
    // Work items from the repos (F1): their own increment, their keys in the status index, links to their files.
    const workItems = pdi ? await readWorkItems(client, tenantId) : [];
    const releasePlan = pdi ? await readReleasePlan(client, tenantId, workItems) : { mode: 'jira', lines: [], plans: [] };
    const workItemUrls = {};
    if (workItems.length) {
        jiraIndex.pis.push({ pi: CHANGES_KEY, kind: 'change', label: CHANGES_LABEL, file: 'changes.json', sprints: [] });
        if (!jiraIndex.currentPi) jiraIndex.currentPi = CHANGES_KEY;
        for (const issue of workItemIssues(workItems)) {
            if (!issueStatusIndex[issue.key]) issueStatusIndex[issue.key] = { pi: CHANGES_KEY, statusCategory: issue.statusCategory };
        }
        for (const w of workItems) workItemUrls[w.key] = w.url;
    }
    const { flagsMeta, flagStates, flagStatesByComponent, flagFreshness, flagStateHistory, coveredComponents } = await readDashboardFlags(client, {
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
        flagStatesByComponent,
        flagFreshness,
        flagStateHistory,
        jiraIndex,
        issueStatusIndex,
        issueDeployments,
        componentsOrder: repos.map((r) => ({
            name: names.get(Number(r.repo_id)),
            description: r.full_name,
            // The admin's role for the repo (migration 025): FE/BE, as the file-based components.json had it.
            serviceType: r.service_role === 'frontend' ? 'FE' : r.service_role === 'backend' ? 'BE' : null,
            featureFlagsIncluded: null,
            application: null,
            // ADR-003: tracked (a source covers it), none (declared: no flags) or unknown (nobody said).
            flagCoverage: coveredComponents.has(names.get(Number(r.repo_id))) ? 'tracked' : r.flag_stance === 'none' ? 'none' : 'unknown',
        })),
        lastSyncedAt: synced.length ? synced[0].toISOString() : null,
        jiraBrowseUrl,
        releasePlan,
        workItemUrls,
        capabilities: { pdi },
    };
}

module.exports = { buildDashboardData, readDashboardData };
