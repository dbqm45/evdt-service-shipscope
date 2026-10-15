/**
 * Pure (no fs, no network, no env) deployment-record logic shared by sync-github-deployments.js — split out
 * so it can be unit-tested without that script's require-time env checks. Anything that used to read
 * RETENTION_DAYS / STUCK_DEPLOYMENT_MAX_AGE_HOURS / Date.now() now takes it as an explicit parameter.
 */

/**
 * ShipScope only ever tracks these 3 named environments (`ENVIRONMENTS` in docs/app.js, and the whole
 * test→qa→prod promotion-chain assumption drift detection relies on) — a real deployment to anything else
 * (staging, uat, a preview env) has nowhere to go today and is dropped, loudly, below.
 *
 * Checked *before* the substring matching: a pre-production environment ("preprod"/"pre-prod") must never
 * be miscategorized as `prod` just because its name contains that substring — `.includes('prod')` below
 * would otherwise match it too, silently corrupting prod's current version/drift/rollback with a
 * different environment's deployments.
 */
function mapEnvironment(rawEnv) {
    const e = (rawEnv || '').toLowerCase().trim();

    if (/pre[-_]?prod/.test(e)) {
        return null;
    }

    if (e.includes('prod')) {
        return 'prod';
    }
    if (e.includes('qa')) {
        return 'qa';
    }
    if (e.includes('test') || e.includes('dev')) {
        return 'test';
    }

    return null;
}

function extractIssueKeys(text) {
    return [...new Set(((text || '').match(/[A-Z]{2,}-[0-9]+/g)) || [])];
}

function extractCommitType(commitMessage) {
    const match = (commitMessage || '').match(/^(feat|fix|chore)(\([^)]*\))?!?:/);

    return match ? match[1] : null;
}

function extractPromotedVersion(commitMessage) {
    const match = (commitMessage || '').match(/\bv?\d+\.\d+\.\d+\b/);

    return match ? match[0] : null;
}

const STATE_MAP = { success: 'success', failure: 'failed', error: 'failed' };
const ENV_ORDER = ['test', 'qa', 'prod'];

function extractRunId(logUrl) {
    const match = (logUrl || '').match(/\/actions\/runs\/(\d+)/);

    return match ? match[1] : null;
}

function latestSuccessfulByEnv(componentRecords) {
    const latest = {};

    for (const rec of componentRecords) {
        if (rec.status !== 'success') continue;

        if (!latest[rec.environment] || new Date(rec.deployedAt) > new Date(latest[rec.environment].deployedAt)) {
            latest[rec.environment] = rec;
        }
    }

    return latest;
}

/**
 * ShipScope shows the current, real state of what's deployed — not a historical archive (Jira and
 * GitHub's own deployment/Actions history already own that). So anything older than `retentionDays` (RETENTION_DAYS) is
 * physically removed from `deployments.json`, **except**: the single latest record overall per
 * component/environment (whatever `currentVersion()` in docs/app.js always needs to show, success or
 * not) and the single latest *successful* one (whatever drift/rollback detection needs as "the last real
 * deploy," which can differ from the latest-overall record when the most recent attempt failed). Both are
 * kept no matter how old, so this never breaks either of those — everything else outside the window is
 * simply gone, not archived anywhere.
 */
function trimOldRecords(records, { retentionDays, now = Date.now() }) {
    const cutoffMs = now - retentionDays * 86400000;
    const keepIds = new Set();

    const latestOverall = new Map();
    const latestSuccess = new Map();

    records.forEach(rec => {
        const key = `${rec.component}::${rec.environment}`;
        const time = new Date(rec.deployedAt).getTime();

        const curOverall = latestOverall.get(key);

        if (!curOverall || time > new Date(curOverall.deployedAt).getTime()) {
            latestOverall.set(key, rec);
        }

        if (rec.status === 'success') {
            const curSuccess = latestSuccess.get(key);

            if (!curSuccess || time > new Date(curSuccess.deployedAt).getTime()) {
                latestSuccess.set(key, rec);
            }
        }
    });

    [...latestOverall.values(), ...latestSuccess.values()].forEach(rec => keepIds.add(rec.id));

    const kept = records.filter(rec => keepIds.has(rec.id) || new Date(rec.deployedAt).getTime() >= cutoffMs);

    return { records: kept, latestOverall, latestSuccess };
}

/** Builds SUMMARY_PATH's content straight from the two maps trimOldRecords() already computed — see that
 *  constant's own comment for why this exists. Every env entry gets both keys (even if, in some
 *  theoretically-impossible case, only one map had it) so docs/app.js never has to branch on a missing key. */
function buildSummary(latestOverall, latestSuccess) {
    const components = {};
    const bucketFor = rec => components[rec.component] || (components[rec.component] = {});

    latestOverall.forEach(rec => {
        const bucket = bucketFor(rec);

        bucket[rec.environment] = { ...(bucket[rec.environment] || {}), latestOverall: rec };
    });
    latestSuccess.forEach(rec => {
        const bucket = bucketFor(rec);

        bucket[rec.environment] = { ...(bucket[rec.environment] || {}), current: rec };
    });

    Object.values(components).forEach(envs => Object.values(envs).forEach(entry => {
        if (!('current' in entry)) entry.current = null;
        if (!('latestOverall' in entry)) entry.latestOverall = null;
    }));

    return { components };
}

/**
 * Mutates `history` (the never-trimmed issue-deployments companion — see ISSUE_DEPLOYMENTS_PATH's comment in
 * sync-github-deployments.js for why it exists) and returns whether anything was added. Only the *first* time an issue key is seen as successfully deployed to a given env/component
 * is kept: that's all `docs/app.js`'s "has this ever shipped" joins need, and it means this file never
 * needs updating once an (issue, env, component) triple is recorded, regardless of how many further
 * deployments that issue's commit range gets swept up into. Deliberately called with this component's
 * *full current* record set (not just this run's freshly-resolved ones) — a one-time, zero-API-cost
 * backfill effect: every record already sitting in `deployments.json` when this file was introduced (and
 * not yet trimmed) gets captured on this component's very next sync, instead of needing a separate one-off
 * backfill script. Cheap (pure local JSON work) and idempotent (only ever adds missing entries), so safe
 * to pass the full set on every single run, forever.
 */
function mergeIssueDeploymentHistory(history, allRecords) {
    let changed = false;

    for (const rec of allRecords) {
        if (rec.status !== 'success') continue;

        for (const issueKey of rec.relatedIssues || []) {
            if (!history[issueKey]) history[issueKey] = {};
            if (!history[issueKey][rec.environment]) history[issueKey][rec.environment] = {};

            if (!history[issueKey][rec.environment][rec.component]) {
                history[issueKey][rec.environment][rec.component] = {
                    deployedAt: rec.deployedAt,
                    commitUrl: rec.commitUrl || null,
                };
                changed = true;
            }
        }
    }

    return changed;
}

/**
 * `inactive` is excluded on purpose: GitHub appends it to a deployment's *own* status history whenever a
 * later deployment on the same environment succeeds (`auto_inactive`, on by default for every environment
 * except one literally named `production`) — not part of that deployment's own lifecycle, so including it
 * would inflate `durationMs` to "however long until some unrelated future deploy happened" instead of how
 * long this one actually took, especially badly if the two deploys end up fetched in the same sync run
 * (see `buildDeploymentPlan`'s own `inactive` handling for the related, more serious bug this caused).
 */
function computeDeployDurationMs(statuses) {
    const lifecycle = (statuses || []).filter(s => s.state !== 'inactive');

    if (lifecycle.length < 2) return null;

    const times = lifecycle.map(s => new Date(s.created_at).getTime());

    return Math.max(...times) - Math.min(...times);
}

/**
 * `blockedIds` collects every deployment that has a *recognized* environment but no terminal status yet
 * (`!latest`, or a status GitHub reports that `STATE_MAP` doesn't recognize as terminal — e.g. still
 * `queued`/`in_progress`) — as opposed to one dropped for an unrecognized environment, which will never
 * resolve differently no matter how many times it's re-fetched. `main()` uses `blockedIds` to decide how
 * far the sync cursor is allowed to advance (see its own comment) — advancing past a blocked deployment's
 * ID would permanently exclude it from every future `newDeployments` filter even after it later gets a
 * real terminal status, since the cursor comparison is purely by ID, not by whether this deployment was
 * actually turned into a record.
 *
 * A deployment blocked for longer than `STUCK_DEPLOYMENT_MAX_AGE_HOURS` (by its own `created_at`) is
 * treated as a *permanent* skip instead — same as an unrecognized environment — rather than being added
 * to `blockedIds`: it's never going to post a terminal status at this point, so there's nothing left to
 * wait for, and continuing to hold the cursor back for it would just force every newer deployment to be
 * re-fetched and re-processed forever (see `STUCK_DEPLOYMENT_MAX_AGE_HOURS`'s own comment). Logged loudly
 * since, unlike a dropped unrecognized environment, this is a one-way decision to stop looking for a
 * status that may, in rare cases, still eventually show up.
 */
function buildDeploymentPlan(deployments, latestStatusById, statusesById, { now = Date.now(), stuckMaxAgeHours }) {
    const withEnv = [];
    const blockedIds = [];

    for (const dep of deployments) {
        const environment = mapEnvironment(dep.environment);

        if (!environment) {
            console.warn(`Warning: deployment ${dep.id} targets environment "${dep.environment}", which ShipScope doesn't track (only test/qa/prod) — skipped.`);
            continue;
        }

        const latest = latestStatusById[dep.id];
        const status = latest && STATE_MAP[latest.state];

        if (!status) {
            const ageMs = now - new Date(dep.created_at).getTime();

            if (ageMs > stuckMaxAgeHours * 3600000) {
                console.warn(
                    `::warning::Deployment ${dep.id} (created ${dep.created_at}) still has no terminal status after ` +
                    `${stuckMaxAgeHours}h — permanently skipping it so it doesn't block the sync cursor forever.`
                );
            } else {
                blockedIds.push(dep.id);
            }

            continue;
        }

        withEnv.push({
            dep,
            environment,
            status,
            statusCreatedAt: latest.created_at,
            workflowRunUrl: latest.log_url || null,
            durationMs: computeDeployDurationMs(statusesById[dep.id]),
        });
    }

    withEnv.sort((a, b) => new Date(a.statusCreatedAt) - new Date(b.statusCreatedAt));

    const lastSuccessfulShaByEnv = {};
    const plan = withEnv.map(entry => {
        const previousSha = lastSuccessfulShaByEnv[entry.environment] || null;

        if (entry.status === 'success') {
            lastSuccessfulShaByEnv[entry.environment] = entry.dep.sha;
        }

        return { ...entry, previousSha };
    });

    return { plan, blockedIds };
}

function buildRecord(entry, component, relatedIssues, appRepo, promotedVersion, issueCommitTypes, resolvedRef) {
    const { dep, environment, status, statusCreatedAt, workflowRunUrl, durationMs, manual, compareUrl, rollback, deployedByLogin, deployedByName } = entry;

    return {
        id: `gh-${dep.id}`,
        component,
        environment,
        version: promotedVersion || (dep.sha || dep.ref || '').toString().slice(0, 12),
        commitUrl: compareUrl || (dep.sha && appRepo ? `https://github.com/${appRepo}/commit/${dep.sha}` : null),
        workflowRunUrl: workflowRunUrl || null,
        durationMs: durationMs || null,
        manual: manual === true,
        rollback: rollback || null,
        deployedAt: statusCreatedAt,
        deployedBy: deployedByName || deployedByLogin || 'unknown',
        deployedByLogin: deployedByLogin || null,
        status,
        relatedIssues,
        issueCommitTypes: issueCommitTypes || {},
        resolvedRef: resolvedRef || null,
    };
}

function seedLastResolvedRefByEnv(existingForComponent) {
    const lastResolvedRefByEnv = {};
    const lastDeployedAtByEnv = {};

    for (const rec of existingForComponent) {
        if (rec.status !== 'success') continue;

        const isNewer = !lastDeployedAtByEnv[rec.environment] || new Date(rec.deployedAt) > new Date(lastDeployedAtByEnv[rec.environment]);

        if (isNewer) {
            lastDeployedAtByEnv[rec.environment] = rec.deployedAt;
            lastResolvedRefByEnv[rec.environment] = rec.resolvedRef || rec.version;
        }
    }

    return lastResolvedRefByEnv;
}

/**
 * Companion to seedLastResolvedRefByEnv: seeds the *result* already computed for that same latest-per-env
 * record (its compare URL, relatedIssues, issueCommitTypes, rollback) — see the matching cache built up in
 * main() below for why. `commitUrl` only came from a real `/compare/...` range (as opposed to the
 * single-commit fallback) when it actually contains `/compare/`, which is the only signal available once
 * a record is already written to disk (the intermediate `compareUrl` variable itself isn't persisted).
 */
function seedLastResolvedRangeByEnv(existingForComponent) {
    const lastResolvedRangeByEnv = {};
    const lastDeployedAtByEnv = {};

    for (const rec of existingForComponent) {
        if (rec.status !== 'success') continue;

        const isNewer = !lastDeployedAtByEnv[rec.environment] || new Date(rec.deployedAt) > new Date(lastDeployedAtByEnv[rec.environment]);

        if (isNewer) {
            lastDeployedAtByEnv[rec.environment] = rec.deployedAt;
            lastResolvedRangeByEnv[rec.environment] = {
                ref: rec.resolvedRef || rec.version,
                compareUrl: rec.commitUrl && rec.commitUrl.includes('/compare/') ? rec.commitUrl : null,
                relatedIssues: rec.relatedIssues || [],
                issueCommitTypes: rec.issueCommitTypes || {},
                rollback: rec.rollback || null,
            };
        }
    }

    return lastResolvedRangeByEnv;
}

/**
 * The newest status entry isn't necessarily the one that matters: GitHub appends `inactive` to a
 * deployment's own history whenever a later deployment on the same environment succeeds (see
 * computeDeployDurationMs). Returns the most recent entry with a recognized terminal state, else the newest
 * entry (so a still-pending deployment is seen as blocked by buildDeploymentPlan), else undefined.
 */
function pickLatestStatus(statuses) {
    return statuses.find(s => STATE_MAP[s.state]) || statuses[0];
}

/**
 * Where the sync cursor may advance to: never past a still-blocked deployment (see buildDeploymentPlan),
 * else the highest ID in the capped, actually-processed batch — not the full fetched list.
 */
function computeNextCursor(newDeployments, blockedIds, lastSyncedId) {
    return blockedIds.length
        ? Math.min(...blockedIds) - 1
        : newDeployments.reduce((max, dep) => Math.max(max, dep.id), lastSyncedId);
}

/**
 * Applies computeEnvDrift's result onto each env's latest successful record. A failed compare (transient
 * error) leaves any existing driftBehind untouched rather than wiping a still-real value.
 */
function applyDrift(latestByEnv, drift, failed) {
    for (const env of Object.keys(latestByEnv)) {
        if (drift[env]) {
            latestByEnv[env].driftBehind = drift[env];
        } else if (!failed.has(env)) {
            delete latestByEnv[env].driftBehind;
        }
    }
}

module.exports = {
    STATE_MAP,
    ENV_ORDER,
    mapEnvironment,
    extractIssueKeys,
    extractCommitType,
    extractPromotedVersion,
    extractRunId,
    latestSuccessfulByEnv,
    trimOldRecords,
    buildSummary,
    mergeIssueDeploymentHistory,
    computeDeployDurationMs,
    buildDeploymentPlan,
    buildRecord,
    seedLastResolvedRefByEnv,
    seedLastResolvedRangeByEnv,
    pickLatestStatus,
    computeNextCursor,
    applyDrift,
};
