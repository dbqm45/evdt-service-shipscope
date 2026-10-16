const { withScope } = require('./scope');
const { createInstallationToken, githubGet, GitHubApiError } = require('./github-app');
const { buildDeploymentPlan, computeNextCursor, issuesFromMessages } = require('./deployment-logic');
const { fetchRefIndex, resolveVersionFile, resolveVersion } = require('./version-resolution');
const { ENV_ORDER, computeEnvDrift } = require('./env-drift');
const { MAX_RUN_LOOKUPS, createCaches, resolveManual, resolveDisplayName } = require('./deployment-people');

/**
 * FR-005: pulls new GitHub deployments of every tracked repo into the tenant's `deployments` table.
 * Same rules as the file-based scripts/sync-github-deployments.js (cursor, blocked/stuck deployments,
 * version from release/tag/version file/commit message, issue keys from the commit range between resolved
 * refs, rollback detection, per-run cap, environment drift); see lib/deployment-logic.js,
 * lib/version-resolution.js, lib/env-drift.js and lib/deployment-people.js (the `manual` flag, display names).
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
        `SELECT DISTINCT ON (environment) environment, sha, resolved_ref, version, related_issues, issue_commit_types, commit_url
         FROM deployments WHERE tenant_id = $1 AND repo_id = $2 AND status = 'success'
         ORDER BY environment, deployed_at DESC, deployment_id DESC`,
        [tenantId, repoId]
    );
    return Object.fromEntries(rows.map((r) => [r.environment, {
        // Records synced before version resolution existed have no resolved_ref; their sha is the ref.
        sha: r.sha, ref: r.resolved_ref || r.sha, version: r.version,
        relatedIssues: r.related_issues, issueCommitTypes: r.issue_commit_types, commitUrl: r.commit_url,
    }]));
}

/**
 * What a deployment shipped compared with the previous successful one on its environment: the issue keys
 * in the range between their resolved refs, a link to that range, and whether it went backwards (a rollback).
 * `current.ref` is the resolved ref (release/tag, the version file's ref, or the sha) -- never the
 * commit-message label, which may not be a real ref.
 */
async function describeRange({ token, fullName, previous, current, fetch }) {
    if (previous && previous.ref === current.ref) {
        // A redeploy of the same ref: comparing it with itself would yield an empty range, so it inherits
        // what the previous record shipped (the same lesson as lastResolvedRangeByEnv in the file-based sync).
        return { keys: previous.relatedIssues, typesByKey: previous.issueCommitTypes, commitUrl: previous.commitUrl, rollbackTo: null };
    }
    if (!previous) {
        // With a version file the deployed commit is only a trigger; the issues are on the commit it names.
        const message = current.fromFile
            ? (await githubGet({ token, path: `/repos/${fullName}/commits/${encodeURIComponent(current.ref)}`, fetch }))?.commit?.message
            : current.message;
        const { keys, typesByKey } = issuesFromMessages([message || '']);
        return { keys, typesByKey, commitUrl: `https://github.com/${fullName}/commit/${current.sha}`, rollbackTo: null };
    }
    const comparison = await githubGet({
        token,
        path: `/repos/${fullName}/compare/${encodeURIComponent(previous.ref)}...${encodeURIComponent(current.ref)}`,
        fetch,
    });
    // GitHub caps `commits` at 250; issues from the rest are missing (same known gap as the file-based sync).
    const { keys, typesByKey } = issuesFromMessages((comparison?.commits || []).map((c) => c?.commit?.message || ''));
    return {
        keys,
        typesByKey,
        commitUrl: `https://github.com/${fullName}/compare/${previous.ref}...${current.fromFile ? current.ref : current.sha}`,
        // "behind": this ref is an ancestor of what was deployed before, so the environment moved backwards.
        rollbackTo: comparison?.status === 'behind' ? current.ref : null,
    };
}

/**
 * Recomputes the repo's environment drift (lib/env-drift.js) when a latest successful deploy changed since
 * the stored result, or the last attempt failed; otherwise no GitHub call at all. Comparisons that error keep
 * their previous value instead of clearing a still-real drift.
 *
 * @returns {Promise<boolean>} whether it recomputed
 */
async function refreshDrift({ pool, token, tenantId, repo, fetch: fetchFn }) {
    const latest = await withScope(pool, { tenantId }, (client) => lastSuccessByEnv(client, { tenantId, repoId: repo.repoId }));
    const inputs = Object.fromEntries(ENV_ORDER.filter((env) => latest[env]).map((env) => [env, latest[env].ref]));
    const stored = repo.drift || {};
    // Per environment, not JSON.stringify: jsonb doesn't keep key order, so the stored object comes back reordered.
    const unchanged = stored.inputs && ENV_ORDER.every((env) => (stored.inputs[env] ?? null) === (inputs[env] ?? null));
    if (unchanged && !(stored.failed || []).length) return false;

    const latestByEnv = {};
    for (const [env, rec] of Object.entries(latest)) {
        let { ref, version } = rec;
        // A record whose ref is still its own sha (synced before version resolution, or before the version file
        // was configured) points at the trigger commit; drift must compare the code the version file names
        // (resolved on the fly, as the file-based sync does for old records).
        if (repo.versionFile && ref === rec.sha) {
            const fileRef = await resolveVersionFile({ token, fullName: repo.fullName, versionFile: repo.versionFile, sha: rec.sha, tagNames: new Set(), fetch: fetchFn });
            if (fileRef) ({ ref, label: version } = fileRef);
        }
        latestByEnv[env] = { ref, version };
    }
    const { envs, failed } = await computeEnvDrift({ token, fullName: repo.fullName, latestByEnv, ignorePatterns: repo.driftIgnorePaths || [], fetch: fetchFn });
    for (const env of failed) if (stored.envs?.[env]) envs[env] = stored.envs[env];

    await withScope(pool, { tenantId }, (client) => client.query(
        'UPDATE tracked_repos SET drift = $3 WHERE tenant_id = $1 AND repo_id = $2',
        [tenantId, repo.repoId, JSON.stringify({ inputs, failed, envs })]
    ));
    return true;
}

/**
 * Syncs one tracked repo.
 *
 * @param {{ pool: import('pg').Pool, token: string, tenantId: string, repo: { repoId: number, fullName: string, cursor: number, versionFile?: string|null, driftIgnorePaths?: string[], drift?: object }, fetch?: typeof fetch, now?: number, options?: Partial<typeof DEFAULTS>, caches?: ReturnType<typeof createCaches> }} input
 * @returns {Promise<{ inserted: number, blocked: number, skipped: number, cursor: number, driftRecomputed: boolean, untracked?: true }>}
 * @throws {GitHubApiError}
 */
async function syncRepo({ pool, token, tenantId, repo, fetch: fetchFn = fetch, now = Date.now(), options = {}, caches = createCaches() }) {
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

    // Tags and releases: two list calls per repo, and only when there's something new to resolve.
    const refIndex = plan.length ? await fetchRefIndex({ token, fullName, fetch: fetchFn }) : null;

    const records = [];
    const budget = { runs: MAX_RUN_LOOKUPS };
    for (const entry of plan) {
        const sha = entry.dep.sha;
        const commit = await githubGet({ token, path: `/repos/${fullName}/commits/${sha}`, fetch: fetchFn });
        const message = commit?.commit?.message || '';
        const fileRef = repo.versionFile
            ? await resolveVersionFile({ token, fullName, versionFile: repo.versionFile, sha, tagNames: refIndex.tagNames, fetch: fetchFn })
            : null;
        const { version, resolvedRef } = resolveVersion({ sha, message, refIndex, fileRef });
        const previous = previousByEnv[entry.environment] || null;
        const range = await describeRange({
            token, fullName, previous, current: { sha, ref: resolvedRef, message, fromFile: Boolean(fileRef) }, fetch: fetchFn,
        });
        const record = {
            deploymentId: entry.dep.id,
            environment: entry.environment,
            status: entry.status,
            sha: entry.dep.sha,
            ref: typeof entry.dep.ref === 'string' ? entry.dep.ref : null,
            deployedAt: entry.statusCreatedAt,
            deployedByLogin: typeof entry.dep.creator?.login === 'string' ? entry.dep.creator.login : null,
            workflowRunUrl: entry.workflowRunUrl,
            manual: await resolveManual({ token, fullName, workflowRunUrl: entry.workflowRunUrl, caches, budget, fetch: fetchFn }),
            durationMs: entry.durationMs,
            version,
            resolvedRef,
            ...range,
        };
        record.deployedByName = await resolveDisplayName({ token, login: record.deployedByLogin, caches, fetch: fetchFn });
        records.push(record);
        if (record.status === 'success') {
            previousByEnv[entry.environment] = {
                sha, ref: resolvedRef, version,
                relatedIssues: record.keys, issueCommitTypes: record.typesByKey, commitUrl: record.commitUrl,
            };
        }
    }

    const nextCursor = computeNextCursor(batch, blockedIds, cursor);

    const written = await withScope(pool, { tenantId }, async (client) => {
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
                     deployed_by_login, workflow_run_url, duration_ms, commit_url, rollback_to_sha, related_issues, issue_commit_types,
                     version, resolved_ref, manual, deployed_by_name)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
                 ON CONFLICT (tenant_id, deployment_id) DO NOTHING`,
                [tenantId, repoId, r.deploymentId, r.environment, r.status, r.sha, r.ref, r.deployedAt, r.deployedByLogin,
                    r.workflowRunUrl, r.durationMs, r.commitUrl, r.rollbackTo, r.keys, JSON.stringify(r.typesByKey),
                    r.version, r.resolvedRef, r.manual, r.deployedByName]
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
    if (written.untracked) return { ...written, driftRecomputed: false };

    const driftRecomputed = await refreshDrift({ pool, token, tenantId, repo, fetch: fetchFn });
    return { ...written, driftRecomputed };
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
        const caches = createCaches(); // per tenant: one tenant's lookups never answer another's
        const repos = await withScope(pool, { tenantId }, async (client) => (await client.query(
            `SELECT repo_id, full_name, installation_id, deployments_cursor, version_file, drift_ignore_paths, drift
             FROM tracked_repos WHERE tenant_id = $1 ORDER BY full_name`,
            [tenantId]
        )).rows);
        for (const row of repos) {
            totals.repos += 1;
            const repo = {
                repoId: Number(row.repo_id),
                fullName: row.full_name,
                cursor: Number(row.deployments_cursor),
                versionFile: row.version_file,
                driftIgnorePaths: row.drift_ignore_paths,
                drift: row.drift,
            };
            try {
                const token = await tokenFor(Number(row.installation_id));
                const result = await syncRepo({ pool, token, tenantId, repo, fetch: fetchFn, now, options, caches });
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
