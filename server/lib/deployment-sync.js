const { withScope } = require('./scope');
const { withTenantClaim, eachLimited } = require('./tenant-claim');
const { createInstallationToken, githubGet, GitHubApiError, GitHubRateLimitError } = require('./github-app');
const { buildDeploymentPlan, computeNextCursor, issuesFromMessages, flagLinksFromMessages, firstCommitDates, mergeSeenEnvironments, skippedStage } = require('./deployment-logic');
const { fetchRefIndex, resolveVersionFile, resolvePayloadVersion, resolveVersion, planVersionBackfill } = require('./version-resolution');
const { ENV_ORDER, computeEnvDrift } = require('./env-drift');
const { MAX_RUN_LOOKUPS, createCaches, resolveManual, resolveDisplayName } = require('./deployment-people');
const { refreshCodeFlags } = require('./code-flags');
const { refreshWorkItems } = require('./work-items');
const { pdiLayer } = require('./pdi-layer');

/**
 * FR-005: pulls new GitHub deployments of every tracked repo into the tenant's `deployments` table.
 * Same rules as the file-based sync's sync-github-deployments.js (cursor, blocked/stuck deployments,
 * version from release/tag/version file/commit message, issue keys from the commit range between resolved
 * refs, rollback detection, per-run cap, environment drift); see lib/deployment-logic.js,
 * lib/version-resolution.js, lib/env-drift.js and lib/deployment-people.js (the `manual` flag, display names).
 *
 * GitHub calls all happen before the database transaction, so a slow GitHub never holds a lock, and a
 * repo's records, issue facts and cursor are written together or not at all.
 */

const DEFAULTS = { maxPerRun: 200, stuckMaxAgeHours: 48, maxPages: 20 };
/** A tenant's share of one pass (worker.js SYNC_TENANT_BUDGET_SECONDS); a large backlog continues next pass. */
const DEFAULT_TENANT_BUDGET_MS = 120_000;
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
        `SELECT DISTINCT ON (environment) environment, sha, resolved_ref, version, related_issues, issue_commit_types, commit_url, deployed_at
         FROM deployments WHERE tenant_id = $1 AND repo_id = $2 AND status = 'success'
         ORDER BY environment, deployed_at DESC, deployment_id DESC`,
        [tenantId, repoId]
    );
    return Object.fromEntries(rows.map((r) => [r.environment, {
        // Records synced before version resolution existed have no resolved_ref; their sha is the ref.
        sha: r.sha, ref: r.resolved_ref || r.sha, version: r.version,
        relatedIssues: r.related_issues, issueCommitTypes: r.issue_commit_types, commitUrl: r.commit_url,
        // The status time, not GitHub's created_at (not stored): what `version=latest` is judged against for old records.
        deployedAt: r.deployed_at instanceof Date ? r.deployed_at.toISOString() : r.deployed_at,
    }]));
}

/**
 * The successful deploys the repo has had on test and QA, for skippedStage(): their refs and version labels, and
 * the newest ref per stage. Updated in memory as a pass records new ones.
 */
async function stageHistory(client, { tenantId, repoId }) {
    const { rows } = await client.query(
        `SELECT environment, COALESCE(resolved_ref, sha) AS ref, version FROM deployments
         WHERE tenant_id = $1 AND repo_id = $2 AND status = 'success' AND environment IN ('test', 'qa')
         ORDER BY deployed_at, deployment_id`,
        [tenantId, repoId]
    );
    const stages = { test: { refs: new Set(), versions: new Set(), latestRef: null }, qa: { refs: new Set(), versions: new Set(), latestRef: null } };
    for (const r of rows) noteStage(stages, r.environment, r.ref, r.version);
    return stages;
}

function noteStage(stages, environment, ref, version) {
    const stage = stages[environment];
    if (!stage) return;
    stage.refs.add(ref);
    if (version) stage.versions.add(version);
    stage.latestRef = ref;
}

/** The git tree of a ref, or null when GitHub can't say (a rate limit is rethrown). */
async function treeOf({ token, fullName, ref, fetch }) {
    try {
        const commit = await githubGet({ token, path: `/repos/${fullName}/commits/${encodeURIComponent(ref)}`, fetch });
        return typeof commit?.commit?.tree?.sha === 'string' ? commit.commit.tree.sha : null;
    } catch (err) {
        if (err instanceof GitHubRateLimitError) throw err;
        return null;
    }
}

/**
 * The stage a successful QA or PROD deploy skipped (skippedStage()), settling "another commit, maybe the same code"
 * by comparing git trees with the stage's newest deploy. Null when it skipped nothing or GitHub can't say -- never a
 * false alarm, never a failed sync.
 */
async function judgeSkippedStage({ token, fullName, deploy, stages, fetch }) {
    const verdict = skippedStage(deploy, stages);
    if (!verdict) return null;
    const [mine, theirs] = await Promise.all([
        treeOf({ token, fullName, ref: deploy.ref, fetch }),
        treeOf({ token, fullName, ref: verdict.checkTree.ref, fetch }),
    ]);
    if (!mine || !theirs || mine === theirs) return null;
    return verdict.checkTree.stage;
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
        // Its Flag: trailers were stored with the previous record.
        return { keys: previous.relatedIssues, typesByKey: previous.issueCommitTypes, commitUrl: previous.commitUrl, rollbackTo: null, rolledBack: [], flagLinks: [], firstCommits: {} };
    }
    if (!previous) {
        // With a version file the deployed commit is only a trigger; the issues are on the commit it names.
        const commit = current.fromFile
            ? (await githubGet({ token, path: `/repos/${fullName}/commits/${encodeURIComponent(current.ref)}`, fetch }))?.commit
            : current.commit;
        const message = commit?.message;
        const { keys, typesByKey } = issuesFromMessages([message || '']);
        return {
            keys, typesByKey, commitUrl: `https://github.com/${fullName}/commit/${current.sha}`, rollbackTo: null, rolledBack: [],
            flagLinks: flagLinksFromMessages([message || '']), firstCommits: firstCommitDates([{ commit }]),
        };
    }
    const comparison = await githubGet({
        token,
        path: `/repos/${fullName}/compare/${encodeURIComponent(previous.ref)}...${encodeURIComponent(current.ref)}`,
        fetch,
    });
    // GitHub caps `commits` at 250; issues from the rest are missing (same known gap as the file-based sync).
    const messages = (comparison?.commits || []).map((c) => c?.commit?.message || '');
    const { keys, typesByKey } = issuesFromMessages(messages);
    const rollbackTo = comparison?.status === 'behind' ? current.ref : null;
    return {
        keys,
        typesByKey,
        flagLinks: flagLinksFromMessages(messages),
        firstCommits: firstCommitDates(comparison?.commits),
        commitUrl: `https://github.com/${fullName}/compare/${previous.ref}...${current.fromFile ? current.ref : current.sha}`,
        // "behind": this ref is an ancestor of what was deployed before, so the environment moved backwards.
        rollbackTo,
        rolledBack: rollbackTo ? await rolledBackKeys({ token, fullName, from: current.ref, to: previous.ref, fetch }) : [],
    };
}

/**
 * The issue keys a rollback took off its environment: those of the commits the previous deploy had and the new,
 * older one has not (`compare/<new>...<previous>`). Empty when GitHub can't say -- never fails the sync; a rate
 * limit is rethrown.
 */
async function rolledBackKeys({ token, fullName, from, to, fetch }) {
    try {
        const comparison = await githubGet({ token, path: `/repos/${fullName}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`, fetch });
        const commits = Array.isArray(comparison?.commits) ? comparison.commits : [];
        return issuesFromMessages(commits.map((c) => (typeof c?.commit?.message === 'string' ? c.commit.message : ''))).keys;
    } catch (err) {
        if (err instanceof GitHubRateLimitError) throw err;
        return [];
    }
}

// How far back a deploy synced as a bare sha still gets the tag its commit was given later.
const BACKFILL_HOURS = 48;

/**
 * Fills in the version of the repo's recent deploys that were synced before their commit had a release or tag (a
 * pipeline that tags after it deploys): no version at all, the ref still the sha, at most BACKFILL_HOURS old.
 * Never for a repo with a version file, whose deployed commit is only a trigger. Lists the tags only when such a
 * record exists, reusing the pass's listing when there is one.
 *
 * @returns {Promise<number>} records updated
 */
async function backfillVersions({ pool, token, tenantId, repo, refIndex, now, fetch: fetchFn }) {
    if (repo.versionFile) return 0;
    const { rows } = await withScope(pool, { tenantId }, (client) => client.query(
        `SELECT deployment_id, sha FROM deployments
         WHERE tenant_id = $1 AND repo_id = $2 AND version IS NULL AND resolved_ref = sha AND deployed_at > $3`,
        [tenantId, repo.repoId, new Date(now - BACKFILL_HOURS * 3600000)]
    ));
    if (!rows.length) return 0;
    const index = refIndex || await fetchRefIndex({ token, fullName: repo.fullName, fetch: fetchFn });
    const updates = planVersionBackfill(rows.map((r) => ({ deploymentId: Number(r.deployment_id), sha: r.sha })), index);
    if (!updates.length) return 0;
    await withScope(pool, { tenantId }, async (client) => {
        for (const u of updates) {
            await client.query(
                'UPDATE deployments SET version = $3, resolved_ref = $4 WHERE tenant_id = $1 AND deployment_id = $2 AND version IS NULL',
                [tenantId, u.deploymentId, u.version, u.resolvedRef]
            );
        }
    });
    return updates.length;
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
    // Tags and releases only when a record needs the version file resolved (`latest`, a suffixed version).
    let refIndex = null;
    for (const [env, rec] of Object.entries(latest)) {
        let { ref, version } = rec;
        // A record whose ref is still its own sha (synced before version resolution, or before the version file
        // was configured) points at the trigger commit; drift must compare the code the version file names
        // (resolved on the fly, as the file-based sync does for old records).
        if (repo.versionFile && ref === rec.sha) {
            refIndex = refIndex || await fetchRefIndex({ token, fullName: repo.fullName, fetch: fetchFn }).catch((err) => {
                if (err instanceof GitHubRateLimitError) throw err;
                return { tagNames: new Set(), releases: [] };
            });
            const fileRef = await resolveVersionFile({
                token, fullName: repo.fullName, versionFile: repo.versionFile, sha: rec.sha, tagNames: refIndex.tagNames, releases: refIndex.releases, at: rec.deployedAt, fetch: fetchFn,
            });
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
 * `deadline` (ms since the epoch, by `clock`) is the tenant's time budget: past it the repo stops between deployments
 * (`partial`), keeps what it did, and leaves the cursor before the rest. Drift then waits for a pass that finishes.
 *
 * @param {{ pool: import('pg').Pool, token: string, tenantId: string, repo: { repoId: number, fullName: string, cursor: number, versionFile?: string|null, driftIgnorePaths?: string[], drift?: object, envMap?: object, seenEnvironments?: string[] }, fetch?: typeof fetch, now?: number, options?: Partial<typeof DEFAULTS>, caches?: ReturnType<typeof createCaches>, deadline?: number, clock?: () => number }} input
 * @returns {Promise<{ inserted: number, blocked: number, skipped: number, cursor: number, partial: boolean, driftRecomputed: boolean, codeFlags: { read: number, failed: number }, untracked?: true }>}
 * @throws {GitHubApiError} a GitHubRateLimitError when the installation's rate limit is spent
 */
async function syncRepo({ pool, token, tenantId, repo, fetch: fetchFn = fetch, now = Date.now(), options = {}, caches = createCaches(), deadline = Infinity, clock = Date.now, log = () => {} }) {
    const { maxPerRun, stuckMaxAgeHours, maxPages } = { ...DEFAULTS, ...options };
    const { repoId, fullName, cursor } = repo;
    // Past the tenant's time budget (syncAll), stop between deployments -- after at least one, so every pass makes
    // progress -- and leave the rest, and the cursor before them, for the next pass.
    const outOfTime = (done) => done > 0 && clock() >= deadline;

    const fetched = await fetchNewDeployments({ token, fullName, cursor, fetch: fetchFn, maxPages });
    // Oldest first and capped, so a large backlog makes steady progress across runs.
    let batch = fetched.sort((a, b) => a.id - b.id).slice(0, maxPerRun);
    const statusesById = {};
    for (const [i, dep] of batch.entries()) {
        if (outOfTime(i)) {
            batch = batch.slice(0, i);
            break;
        }
        const statuses = await githubGet({ token, path: `/repos/${fullName}/deployments/${dep.id}/statuses?per_page=10`, fetch: fetchFn });
        if (!Array.isArray(statuses)) throw new GitHubApiError('statuses response is not a list', 502);
        statusesById[dep.id] = statuses;
    }

    const previousByEnv = await withScope(pool, { tenantId }, (client) => lastSuccessByEnv(client, { tenantId, repoId }));
    const stages = await withScope(pool, { tenantId }, (client) => stageHistory(client, { tenantId, repoId }));
    const { plan, blockedIds, skipped } = buildDeploymentPlan(batch, statusesById, { now, stuckMaxAgeHours, fullName, envMap: repo.envMap || {} });
    const seenEnvironments = mergeSeenEnvironments(repo.seenEnvironments || [], batch.map((d) => d.environment));

    // Tags and releases: two list calls per repo, and only when there's something new to resolve.
    const refIndex = plan.length ? await fetchRefIndex({ token, fullName, fetch: fetchFn }) : null;

    const records = [];
    const budget = { runs: MAX_RUN_LOOKUPS };
    const unfinished = [...blockedIds];
    for (const [i, entry] of plan.entries()) {
        if (outOfTime(i)) {
            // The plan runs in status order, not id order: everything not done holds the cursor back.
            unfinished.push(...plan.slice(i).map((e) => e.dep.id));
            break;
        }
        const sha = entry.dep.sha;
        const commit = await githubGet({ token, path: `/repos/${fullName}/commits/${sha}`, fetch: fetchFn });
        const message = commit?.commit?.message || '';
        // What the pipeline said it shipped comes first; the version file is read only when that names no ref.
        const payloadRef = await resolvePayloadVersion({
            token, fullName, payload: entry.dep.payload, tagNames: refIndex.tagNames, releases: refIndex.releases, at: entry.dep.created_at, fetch: fetchFn,
        });
        const fileRef = repo.versionFile && !payloadRef?.ref
            ? await resolveVersionFile({
                token, fullName, versionFile: repo.versionFile, sha, tagNames: refIndex.tagNames, releases: refIndex.releases, at: entry.dep.created_at, fetch: fetchFn,
            })
            : null;
        const { version, resolvedRef } = resolveVersion({ sha, message, refIndex, fileRef, payloadRef });
        const previous = previousByEnv[entry.environment] || null;
        const range = await describeRange({
            token, fullName, previous, current: { sha, ref: resolvedRef, message, commit: commit?.commit, fromFile: Boolean(fileRef || payloadRef?.ref) }, fetch: fetchFn,
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
        record.skippedEnv = record.status === 'success'
            ? await judgeSkippedStage({ token, fullName, deploy: { environment: entry.environment, ref: resolvedRef, version }, stages, fetch: fetchFn })
            : null;
        records.push(record);
        if (record.status === 'success') {
            noteStage(stages, entry.environment, resolvedRef, version);
            previousByEnv[entry.environment] = {
                sha, ref: resolvedRef, version,
                relatedIssues: record.keys, issueCommitTypes: record.typesByKey, commitUrl: record.commitUrl,
            };
        }
    }

    const nextCursor = computeNextCursor(batch, unfinished, cursor);
    const partial = batch.length < Math.min(fetched.length, maxPerRun) || unfinished.length > blockedIds.length;

    const written = await withScope(pool, { tenantId }, async (client) => {
        // Untracked while GitHub was being read: its records would have nowhere to go (and shouldn't).
        const { rows: still } = await client.query(
            'SELECT 1 FROM tracked_repos WHERE tenant_id = $1 AND repo_id = $2 FOR UPDATE',
            [tenantId, repoId]
        );
        if (!still.length) return { inserted: 0, blocked: blockedIds.length, skipped: skipped.length, cursor, partial: false, untracked: true };

        let inserted = 0;
        for (const r of records) {
            const { rowCount } = await client.query(
                `INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, ref, deployed_at,
                     deployed_by_login, workflow_run_url, duration_ms, commit_url, rollback_to_sha, related_issues, issue_commit_types,
                     version, resolved_ref, manual, deployed_by_name, rolled_back_issues, skipped_env)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                 ON CONFLICT (tenant_id, deployment_id) DO NOTHING`,
                [tenantId, repoId, r.deploymentId, r.environment, r.status, r.sha, r.ref, r.deployedAt, r.deployedByLogin,
                    r.workflowRunUrl, r.durationMs, r.commitUrl, r.rollbackTo, r.keys, JSON.stringify(r.typesByKey),
                    r.version, r.resolvedRef, r.manual, r.deployedByName, r.rolledBack || [], r.skippedEnv || null]
            );
            inserted += rowCount;
            // `Flag:` trailers of the deployment's commits (lib/deployment-logic.js): a strong flag -> work item link.
            for (const { flag, keys } of r.flagLinks || []) {
                await client.query(
                    `INSERT INTO flag_commit_links (tenant_id, flag_key, item_key, repo_id)
                     SELECT $1, $2, k, $4 FROM unnest($3::text[]) AS k
                     ON CONFLICT (tenant_id, flag_key, item_key) DO NOTHING`,
                    [tenantId, flag, keys, repoId]
                );
            }
            if (r.status !== 'success') continue;
            for (const key of r.keys) {
                await client.query(
                    // The first commit date is filled in when a later deployment knows it, and never moves later (G3).
                    `INSERT INTO issue_deployments (tenant_id, issue_key, environment, repo_id, first_deployed_at, commit_url, first_commit_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (tenant_id, issue_key, environment, repo_id) DO UPDATE
                         SET first_commit_at = LEAST(COALESCE(issue_deployments.first_commit_at, EXCLUDED.first_commit_at), COALESCE(EXCLUDED.first_commit_at, issue_deployments.first_commit_at)),
                             -- Deployed again after a rollback took it off: on the environment again.
                             rolled_back_at = NULL`,
                    [tenantId, key, r.environment, repoId, r.deployedAt, r.commitUrl, (r.firstCommits || {})[key] || null]
                );
            }
            if ((r.rolledBack || []).length) {
                // A rollback took these off the environment (design-docs/ROLLBACK-STATUS-PLAN.pl.md).
                await client.query(
                    `UPDATE issue_deployments SET rolled_back_at = $5
                     WHERE tenant_id = $1 AND environment = $2 AND repo_id = $3 AND issue_key = ANY($4::text[])`,
                    [tenantId, r.environment, repoId, r.rolledBack, r.deployedAt]
                );
            }
        }
        await client.query(
            `UPDATE tracked_repos SET deployments_cursor = $3, last_synced_at = now(), last_attempt_at = now(), last_sync_error = NULL,
                 seen_environments = $4
             WHERE tenant_id = $1 AND repo_id = $2`,
            [tenantId, repoId, nextCursor, seenEnvironments]
        );
        return { inserted, blocked: blockedIds.length, skipped: skipped.length, cursor: nextCursor, partial };
    });
    // A cut-short repo's latest deploys may still change this pass's picture; drift waits for a complete pass.
    if (written.untracked || written.partial) return { ...written, driftRecomputed: false, codeFlags: { read: 0, failed: 0 } };

    // Before drift, so a deploy tagged after it was synced is compared by its tag.
    await backfillVersions({ pool, token, tenantId, repo, refIndex, now, fetch: fetchFn });
    const driftRecomputed = await refreshDrift({ pool, token, tenantId, repo, fetch: fetchFn });
    // Flags kept in the repo's code, read at what each environment now runs (ADR-003). Never fails the sync.
    const codeFlags = await refreshCodeFlags({ pool, token, tenantId, repo, fetch: fetchFn, now: new Date(now), log });
    // Work items kept in the repo (F1: docs/project/changes/<CHG>/), read when that folder changed. Never fails the sync.
    // Only for workspaces connected with pdi (the pdi layer, design-docs/PDI-GATE-PLAN.pl.md): no requests otherwise.
    const pdiActive = await withScope(pool, { tenantId }, async (client) => (await pdiLayer(client, { tenantId })).active);
    const workItems = pdiActive ? await refreshWorkItems({ pool, token, tenantId, repo, fetch: fetchFn, log }) : { skipped: 'no connection with pdi' };
    return { ...written, driftRecomputed, codeFlags, workItems };
}

/**
 * One sync pass over every tenant's tracked repos, fair across tenants (prd.md Open Question 2):
 * - tenants go longest-waiting first (by their repos' oldest last attempt; never-tried first), and so do repos within one;
 * - each tenant gets `options.tenantBudgetMs` per pass: past it, no new repo starts and the current one stops between
 *   deployments, so a large backlog takes several passes instead of holding up everyone else;
 * - a rate limit pauses only that App installation (its own budget on GitHub's side) until GitHub says, recorded in
 *   `github_installations.rate_limited_until`; its other repos wait, every other tenant goes on.
 * Each tenant is read under its own RLS scope (the worker has no cross-tenant view). One failing repo records its
 * error on its row and the pass moves on.
 *
 * `repoIds` limits the pass to those repos (in every tenant that tracks them): a webhook's targeted sync.
 *
 * Several worker instances share the work (lib/tenant-claim.js): each tenant runs under its own claim, a tenant
 * another instance holds is skipped (`busy`), and a periodic pass leaves out repos attempted after it began.
 * `options.concurrency` tenants run side by side in this instance (WORKER_CONCURRENCY).
 *
 * @param {{ pool: import('pg').Pool, app: { appId: string, privateKey: import('crypto').KeyObject }, fetch?: typeof fetch, now?: number, clock?: () => number, log?: (msg: string, fields?: { level?: string } & object) => void, options?: { tenantBudgetMs?: number, concurrency?: number }, repoIds?: number[] }} input
 * @returns {Promise<{ repos: number, inserted: number, failed: number, deferred: number, busy?: number }>} deferred: repos left for a later pass (rate limit or time budget); busy (when any): tenants another instance was syncing
 */
async function syncAll({ pool, app, fetch: fetchFn = fetch, now = Date.now(), clock = Date.now, log = () => {}, options = {}, repoIds = null }) {
    const tenantBudgetMs = options.tenantBudgetMs ?? DEFAULT_TENANT_BUDGET_MS;
    const concurrency = options.concurrency ?? 1;
    const tokens = new Map(); // installationId -> Promise<token>, for this pass only
    const tokenFor = (installationId) => {
        if (!tokens.has(installationId)) tokens.set(installationId, createInstallationToken({ app, installationId, fetch: fetchFn }));
        return tokens.get(installationId);
    };
    // A periodic pass skips repos another instance attempted after it began (lib/tenant-claim.js); a webhook's pass
    // (repoIds) syncs what it was asked for regardless.
    const { rows: [{ started }] } = await pool.query('SELECT clock_timestamp() AS started');
    const tenantRepos = (tenantId) => withScope(pool, { tenantId }, async (client) => (await client.query(
        `SELECT r.repo_id, r.full_name, r.installation_id, r.deployments_cursor, r.version_file, r.drift_ignore_paths, r.drift, r.env_map, r.seen_environments,
                r.last_attempt_at, i.rate_limited_until
         FROM tracked_repos r
         LEFT JOIN github_installations i ON i.tenant_id = r.tenant_id AND i.installation_id = r.installation_id
         WHERE r.tenant_id = $1 AND ($2::bigint[] IS NULL OR r.repo_id = ANY($2))
           AND ($3::timestamptz IS NULL OR r.last_attempt_at IS NULL OR r.last_attempt_at < $3)
         ORDER BY r.last_attempt_at NULLS FIRST, r.full_name`,
        [tenantId, repoIds, repoIds ? null : started]
    )).rows);

    const { rows: tenantRows } = await pool.query('SELECT id FROM tenants ORDER BY created_at');
    const work = [];
    for (const { id: tenantId } of tenantRows) {
        const repos = await tenantRepos(tenantId);
        if (repos.length) work.push({ tenantId, waitingSince: repos[0].last_attempt_at });
    }
    // Stable sort: equally-waiting tenants keep their creation order.
    work.sort((a, b) => waitKey(a.waitingSince) - waitKey(b.waitingSince));

    const totals = { repos: 0, inserted: 0, failed: 0, deferred: 0 };
    let busy = 0;
    const limitedUntil = new Map(); // installationId -> Date, learned this pass
    await eachLimited(work, concurrency, async ({ tenantId }) => {
        const claim = await withTenantClaim(pool, { job: 'deployments', tenantId }, async () => {
            // Read again under the claim: another instance may have just synced some of them.
            const repos = await tenantRepos(tenantId);
            await syncTenantRepos(tenantId, repos);
        });
        if (!claim.claimed) busy += 1;
    });
    return busy ? { ...totals, busy } : totals;

    async function syncTenantRepos(tenantId, repos) {
        const caches = createCaches(); // per tenant: one tenant's lookups never answer another's
        const deadline = clock() + tenantBudgetMs;
        for (const [i, row] of repos.entries()) {
            const installationId = Number(row.installation_id);
            const repo = {
                repoId: Number(row.repo_id),
                fullName: row.full_name,
                cursor: Number(row.deployments_cursor),
                versionFile: row.version_file,
                driftIgnorePaths: row.drift_ignore_paths,
                drift: row.drift,
                envMap: row.env_map,
                seenEnvironments: row.seen_environments,
            };
            const limited = limitedUntil.get(installationId) || row.rate_limited_until;
            if (limited && limited.getTime() > clock()) {
                totals.deferred += 1;
                continue;
            }
            if (i > 0 && clock() >= deadline) {
                totals.deferred += 1;
                continue;
            }
            totals.repos += 1;
            try {
                const token = await tokenFor(installationId);
                const result = await syncRepo({ pool, token, tenantId, repo, fetch: fetchFn, now, options, caches, deadline, clock, log });
                totals.inserted += result.inserted;
                if (result.partial) totals.deferred += 1;
                if (result.inserted || result.blocked || result.partial) {
                    log(`${repo.fullName}: +${result.inserted} deployments, ${result.blocked} pending${result.partial ? ', more next pass (time budget)' : ''}`,
                        { tenantId, repo: repo.fullName, inserted: result.inserted, pending: result.blocked, partial: !!result.partial });
                }
            } catch (err) {
                if (err instanceof GitHubRateLimitError) {
                    totals.deferred += 1;
                    limitedUntil.set(installationId, err.retryAt);
                    log(`${repo.fullName}: GitHub rate limit, installation ${installationId} paused until ${err.retryAt.toISOString()}`,
                        { level: 'warn', tenantId, repo: repo.fullName, installationId, retryAt: err.retryAt });
                    await withScope(pool, { tenantId }, async (client) => {
                        await client.query(
                            'UPDATE github_installations SET rate_limited_until = $3 WHERE tenant_id = $1 AND installation_id = $2',
                            [tenantId, installationId, err.retryAt]
                        );
                        await client.query('UPDATE tracked_repos SET last_attempt_at = now() WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repo.repoId]);
                    });
                    continue;
                }
                totals.failed += 1;
                const message = String(err.message || err).slice(0, ERROR_MAX_LENGTH);
                log(`${repo.fullName}: sync failed: ${message}`, { level: 'warn', tenantId, repo: repo.fullName, installationId, err });
                await withScope(pool, { tenantId }, (client) => client.query(
                    'UPDATE tracked_repos SET last_sync_error = $3, last_attempt_at = now() WHERE tenant_id = $1 AND repo_id = $2',
                    [tenantId, repo.repoId, message]
                ));
            }
        }
    }
}

/** Never tried sorts first, then the oldest attempt. */
const waitKey = (at) => (at ? at.getTime() : -1);

module.exports = { syncAll };
