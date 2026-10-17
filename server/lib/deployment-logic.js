/**
 * Pure deployment logic for FR-005 (ingesting GitHub deployments of tracked repos). Ported from the
 * file-based sync's deployment-records.js (now only in the original circlek-global repository); the rules and
 * their reasons are described in CLAUDE.md's "Deployments" section. Differences: nothing logs (skips are
 * returned), and there is no file trimming here (retention lives in lib/retention.js).
 */

/** Only test/qa/prod are tracked. Pre-production is checked first so "preprod" never counts as prod. */
function mapEnvironment(rawEnv) {
    const e = (rawEnv || '').toLowerCase().trim();
    if (/pre[-_]?prod/.test(e)) return null;
    if (e.includes('prod')) return 'prod';
    if (e.includes('qa')) return 'qa';
    if (e.includes('test') || e.includes('dev')) return 'test';
    return null;
}

/** Jira-style issue keys (PROJ-123) in a text, deduplicated. */
function extractIssueKeys(text) {
    return [...new Set((text || '').match(/[A-Z]{2,}-[0-9]+/g) || [])];
}

/** feat/fix/chore from a Conventional Commit header, else null. */
function extractCommitType(commitMessage) {
    const match = (commitMessage || '').match(/^(feat|fix|chore)(\([^)]*\))?!?:/);
    return match ? match[1] : null;
}

const STATE_MAP = { success: 'success', failure: 'failed', error: 'failed' };

/**
 * The status that decides a deployment's outcome: the newest one GitHub marks terminal. GitHub appends
 * `inactive` to an older deployment when a newer one on the same environment succeeds, so the newest
 * entry alone can hide the real outcome. Falls back to the newest entry (then the deployment is pending).
 */
function pickLatestStatus(statuses) {
    return statuses.find((s) => STATE_MAP[s.state]) || statuses[0];
}

/** First to last lifecycle status, excluding `inactive` (which only marks a later deploy). */
function computeDeployDurationMs(statuses) {
    const lifecycle = (statuses || []).filter((s) => s.state !== 'inactive');
    if (lifecycle.length < 2) return null;
    const times = lifecycle.map((s) => new Date(s.created_at).getTime());
    return Math.max(...times) - Math.min(...times);
}

/**
 * Turns fetched deployments + statuses into an ordered plan.
 * - unknown environment: permanent skip;
 * - no terminal status yet: `blockedIds` (the cursor must not pass it), unless older than stuckMaxAgeHours,
 *   then a permanent skip so one abandoned pipeline can't hold the cursor back forever;
 * - otherwise a plan entry, sorted by status time, with `previousSha` = the previous successful deploy's
 *   sha on the same environment within this batch (the caller seeds it from the database for the first).
 *
 * @returns {{ plan: object[], blockedIds: number[], skipped: Array<{ id: number, reason: 'environment'|'stuck' }> }}
 */
function buildDeploymentPlan(deployments, statusesById, { now = Date.now(), stuckMaxAgeHours, previousShaByEnv = {} }) {
    const withEnv = [];
    const blockedIds = [];
    const skipped = [];

    for (const dep of deployments) {
        const environment = mapEnvironment(dep.environment);
        if (!environment) {
            skipped.push({ id: dep.id, reason: 'environment' });
            continue;
        }
        const statuses = statusesById[dep.id] || [];
        const latest = pickLatestStatus(statuses);
        const status = latest && STATE_MAP[latest.state];
        if (!status) {
            if (now - new Date(dep.created_at).getTime() > stuckMaxAgeHours * 3600000) skipped.push({ id: dep.id, reason: 'stuck' });
            else blockedIds.push(dep.id);
            continue;
        }
        withEnv.push({
            dep,
            environment,
            status,
            statusCreatedAt: latest.created_at,
            workflowRunUrl: latest.log_url || null,
            durationMs: computeDeployDurationMs(statuses),
        });
    }

    withEnv.sort((a, b) => new Date(a.statusCreatedAt) - new Date(b.statusCreatedAt));
    const lastSuccessfulShaByEnv = { ...previousShaByEnv };
    const plan = withEnv.map((entry) => {
        const previousSha = lastSuccessfulShaByEnv[entry.environment] || null;
        if (entry.status === 'success') lastSuccessfulShaByEnv[entry.environment] = entry.dep.sha;
        return { ...entry, previousSha };
    });

    return { plan, blockedIds, skipped };
}

/**
 * Where the cursor may move: never past a blocked deployment (blocked ids are all newer than the cursor,
 * so this never moves it backwards), else the highest id actually processed this run.
 */
function computeNextCursor(processed, blockedIds, lastSyncedId) {
    return blockedIds.length
        ? Math.min(...blockedIds) - 1
        : processed.reduce((max, dep) => Math.max(max, dep.id), lastSyncedId);
}

/**
 * Issue keys (and the commit type that brought each) from a list of commit messages.
 *
 * @param {string[]} messages
 * @returns {{ keys: string[], typesByKey: Record<string, string> }}
 */
function issuesFromMessages(messages) {
    const keys = new Set();
    const typesByKey = {};
    for (const message of messages) {
        const type = extractCommitType(message);
        for (const key of extractIssueKeys(message)) {
            keys.add(key);
            if (type) typesByKey[key] = type;
        }
    }
    return { keys: [...keys], typesByKey };
}

module.exports = {
    mapEnvironment,
    extractIssueKeys,
    extractCommitType,
    pickLatestStatus,
    computeDeployDurationMs,
    buildDeploymentPlan,
    computeNextCursor,
    issuesFromMessages,
};
