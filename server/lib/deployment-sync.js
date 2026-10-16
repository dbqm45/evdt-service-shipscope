const { withScope } = require('./scope');
const { createInstallationToken, githubGet, GitHubApiError } = require('./github-app');
const { buildDeploymentPlan, computeNextCursor, issuesFromMessages } = require('./deployment-logic');

/**
 * FR-005: pulls new GitHub deployments of every tracked repo into the tenant's `deployments` table.
 * Same rules as the file-based scripts/sync-github-deployments.js (cursor, blocked/stuck deployments,
 * issue keys from the commit range, rollback detection, per-run cap); see lib/deployment-logic.js.
 * Not ported yet: version from releases/tags/versionFile, environment drift, the `manual` flag and
 * display names -- every record still has its sha, so those can be added later without a re-sync.
 *
 * GitHub calls all happen before the database transaction, so a slow GitHub never holds a lock, and a
 * repo's records, issue facts and cursor are written together or not at all.
 */

const DEFAULTS = { maxPerRun: 200, stuckMaxAgeHours: 48, maxPages: 20 };
const ERROR_MAX_LENGTH = 500;

/** New deployments (id > cursor), newest-first from GitHub, stopping at the first already-synced id. */
async function fetchNewDeployments({ token, fullName, cursor, fetch, maxPages }) {
    const found = [];
    for (let page = 1; page <= maxPages; page++) {
        const batch = await githubGet({ token, path: `/repos/${fullName}/deployments?per_page=100&page=${page}`, fetch });
        if (!Array.isArray(batch)) throw new GitHubApiError('deployments response is not a list', 502);
        for (const dep of batch) {
            if (!Number.isSafeInteger(dep?.id) || typeof dep.sha !== 'string' || typeof dep.created_at !== 'string') {
                throw new GitHubApiError('deployment entry is missing id/sha/created_at', 502);
            }
            if (dep.id <= cursor) return found;
            found.push(dep);
        }
        if (batch.length < 100) return found;
    }
    return found;
}

/** The newest successful deployment per environment already in the database, to compare the first new one against. */
async function lastSuccessByEnv(client, { tenantId, repoId }) {
    const { rows } = await client.query(
        `SELECT DISTINCT ON (environment) environment, sha, related_issues, issue_commit_types, commit_url
         FROM deployments WHERE tenant_id = $1 AND repo_id = $2 AND status = 'success'
         ORDER BY environment, deployed_at DESC, deployment_id DESC`,
        [tenantId, repoId]
    );
    return Object.fromEntries(rows.map((r) => [r.environment, {
        sha: r.sha, relatedIssues: r.related_issues, issueCommitTypes: r.issue_commit_types, commitUrl: r.commit_url,
    }]));
}

/**
 * What a deployment shipped compared with the previous successful one on its environment: the issue keys
 * in the commit range, a link to that range, and whether it went backwards (a rollback).
 */
async function describeRange({ token, fullName, previous, sha, fetch }) {
    if (previous && previous.sha === sha) {
        // A redeploy of the same commit: comparing it with itself would yield an empty range, so it inherits
        // what the previous record shipped (the same lesson as lastResolvedRangeByEnv in the file-based sync).
        return { keys: previous.relatedIssues, typesByKey: previous.issueCommitTypes, commitUrl: previous.commitUrl, rollbackToSha: null };
    }
    if (!previous) {
        const commit = await githubGet({ token, path: `/repos/${fullName}/commits/${sha}`, fetch });
        const { keys, typesByKey } = issuesFromMessages([commit?.commit?.message || '']);
        return { keys, typesByKey, commitUrl: `https://github.com/${fullName}/commit/${sha}`, rollbackToSha: null };
    }
    const comparison = await githubGet({ token, path: `/repos/${fullName}/compare/${previous.sha}...${sha}`, fetch });
    // GitHub caps `commits` at 250; issues from the rest are missing (same known gap as the file-based sync).
    const { keys, typesByKey } = issuesFromMessages((comparison?.commits || []).map((c) => c?.commit?.message || ''));
    return {
        keys,
        typesByKey,
        commitUrl: `https://github.com/${fullName}/compare/${previous.sha}...${sha}`,
        // "behind": this commit is an ancestor of what was deployed before, so the environment moved backwards.
        rollbackToSha: comparison?.status === 'behind' ? sha : null,
    };
}

/**
 * Syncs one tracked repo.
 *
 * @param {{ pool: import('pg').Pool, token: string, tenantId: string, repo: { repoId: number, fullName: string, cursor: number }, fetch?: typeof fetch, now?: number, options?: Partial<typeof DEFAULTS> }} input
 * @returns {Promise<{ inserted: number, blocked: number, skipped: number, cursor: number, untracked?: true }>}
 * @throws {GitHubApiError}
 */
async function syncRepo({ pool, token, tenantId, repo, fetch: fetchFn = fetch, now = Date.now(), options = {} }) {
    const { maxPerRun, stuckMaxAgeHours, maxPages } = { ...DEFAULTS, ...options };
    const { repoId, fullName, cursor } = repo;

    const fetched = await fetchNewDeployments({ token, fullName, cursor, fetch: fetchFn, maxPages });
    // Oldest first and capped, so a large backlog makes steady progress across runs.
    const batch = fetched.sort((a, b) => a.id - b.id).slice(0, maxPerRun);
    const statusesById = {};
    for (const dep of batch) {
        const statuses = await githubGet({ token, path: `/repos/${fullName}/deployments/${dep.id}/statuses?per_page=10`, fetch: fetchFn });
        if (!Array.isArray(statuses)) throw new GitHubApiError('statuses response is not a list', 502);
        statusesById[dep.id] = statuses;
    }

    const previousByEnv = await withScope(pool, { tenantId }, (client) => lastSuccessByEnv(client, { tenantId, repoId }));
    const { plan, blockedIds, skipped } = buildDeploymentPlan(batch, statusesById, { now, stuckMaxAgeHours });

    const records = [];
    for (const entry of plan) {
        const previous = previousByEnv[entry.environment] || null;
        const range = await describeRange({ token, fullName, previous, sha: entry.dep.sha, fetch: fetchFn });
        const record = {
            deploymentId: entry.dep.id,
            environment: entry.environment,
            status: entry.status,
            sha: entry.dep.sha,
            ref: typeof entry.dep.ref === 'string' ? entry.dep.ref : null,
            deployedAt: entry.statusCreatedAt,
            deployedByLogin: typeof entry.dep.creator?.login === 'string' ? entry.dep.creator.login : null,
            workflowRunUrl: entry.workflowRunUrl,
            durationMs: entry.durationMs,
            ...range,
        };
        records.push(record);
        if (record.status === 'success') {
            previousByEnv[entry.environment] = { sha: record.sha, relatedIssues: record.keys, issueCommitTypes: record.typesByKey, commitUrl: record.commitUrl };
        }
    }

    const nextCursor = computeNextCursor(batch, blockedIds, cursor);

    return withScope(pool, { tenantId }, async (client) => {
        // Untracked while GitHub was being read: its records would have nowhere to go (and shouldn't).
        const { rows: still } = await client.query(
            'SELECT 1 FROM tracked_repos WHERE tenant_id = $1 AND repo_id = $2 FOR UPDATE',
            [tenantId, repoId]
        );
        if (!still.length) return { inserted: 0, blocked: blockedIds.length, skipped: skipped.length, cursor, untracked: true };

        let inserted = 0;
        for (const r of records) {
            const { rowCount } = await client.query(
                `INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, ref, deployed_at,
                     deployed_by_login, workflow_run_url, duration_ms, commit_url, rollback_to_sha, related_issues, issue_commit_types)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                 ON CONFLICT (tenant_id, deployment_id) DO NOTHING`,
                [tenantId, repoId, r.deploymentId, r.environment, r.status, r.sha, r.ref, r.deployedAt, r.deployedByLogin,
                    r.workflowRunUrl, r.durationMs, r.commitUrl, r.rollbackToSha, r.keys, JSON.stringify(r.typesByKey)]
            );
            inserted += rowCount;
            if (r.status !== 'success') continue;
            for (const key of r.keys) {
                await client.query(
                    `INSERT INTO issue_deployments (tenant_id, issue_key, environment, repo_id, first_deployed_at, commit_url)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (tenant_id, issue_key, environment, repo_id) DO NOTHING`,
                    [tenantId, key, r.environment, repoId, r.deployedAt, r.commitUrl]
                );
            }
        }
        await client.query(
            `UPDATE tracked_repos SET deployments_cursor = $3, last_synced_at = now(), last_sync_error = NULL
             WHERE tenant_id = $1 AND repo_id = $2`,
            [tenantId, repoId, nextCursor]
        );
        return { inserted, blocked: blockedIds.length, skipped: skipped.length, cursor: nextCursor };
    });
}

/**
 * One sync pass over every tenant's tracked repos. Each tenant is read under its own RLS scope (the worker
 * has no cross-tenant view). One failing repo records its error on its row and the pass moves on.
 *
 * @param {{ pool: import('pg').Pool, app: { appId: string, privateKey: import('crypto').KeyObject }, fetch?: typeof fetch, now?: number, log?: (msg: string) => void, options?: object }} input
 * @returns {Promise<{ repos: number, inserted: number, failed: number }>}
 */
async function syncAll({ pool, app, fetch: fetchFn = fetch, now = Date.now(), log = () => {}, options = {} }) {
    const tokens = new Map(); // installationId -> Promise<token>, for this pass only
    const tokenFor = (installationId) => {
        if (!tokens.has(installationId)) tokens.set(installationId, createInstallationToken({ app, installationId, fetch: fetchFn }));
        return tokens.get(installationId);
    };

    const totals = { repos: 0, inserted: 0, failed: 0 };
    const { rows: tenants } = await pool.query('SELECT id FROM tenants ORDER BY created_at');
    for (const { id: tenantId } of tenants) {
        const repos = await withScope(pool, { tenantId }, async (client) => (await client.query(
            'SELECT repo_id, full_name, installation_id, deployments_cursor FROM tracked_repos WHERE tenant_id = $1 ORDER BY full_name',
            [tenantId]
        )).rows);
        for (const row of repos) {
            totals.repos += 1;
            const repo = { repoId: Number(row.repo_id), fullName: row.full_name, cursor: Number(row.deployments_cursor) };
            try {
                const token = await tokenFor(Number(row.installation_id));
                const result = await syncRepo({ pool, token, tenantId, repo, fetch: fetchFn, now, options });
                totals.inserted += result.inserted;
                if (result.inserted || result.blocked) log(`${repo.fullName}: +${result.inserted} deployments, ${result.blocked} pending`);
            } catch (err) {
                totals.failed += 1;
                const message = String(err.message || err).slice(0, ERROR_MAX_LENGTH);
                log(`${repo.fullName}: sync failed: ${message}`);
                await withScope(pool, { tenantId }, (client) => client.query(
                    'UPDATE tracked_repos SET last_sync_error = $3 WHERE tenant_id = $1 AND repo_id = $2',
                    [tenantId, repo.repoId, message]
                ));
            }
        }
    }
    return totals;
}

module.exports = { syncRepo, syncAll };
