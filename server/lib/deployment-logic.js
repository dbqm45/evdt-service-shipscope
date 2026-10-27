/**
 * Pure deployment logic for FR-005 (ingesting GitHub deployments of tracked repos). Ported from the
 * file-based sync's deployment-records.js (now only in the original circlek-global repository); the rules and
 * their reasons are described in CLAUDE.md's "Deployments" section. Differences: nothing logs (skips are
 * returned), and there is no file trimming here (retention lives in lib/retention.js).
 */
const { isReservedKey } = require('./flags-logic');

/** Only test/qa/prod are tracked. Pre-production is checked first so "preprod" never counts as prod. */
function mapEnvironment(rawEnv) {
    const e = (rawEnv || '').toLowerCase().trim();
    if (/pre[-_]?prod/.test(e)) return null;
    if (e.includes('prod')) return 'prod';
    if (e.includes('qa')) return 'qa';
    if (e.includes('test') || e.includes('dev')) return 'test';
    return null;
}

const MAPPED_ENVS = ['test', 'qa', 'prod'];
// GitHub environment names the sync remembers per repo for Settings (seen_environments); more are not shown.
const MAX_SEEN_ENVIRONMENTS = 50;

/**
 * The ShipScope environment of a GitHub environment name: the repo's own map first (`envMap`, names compared without
 * case; `skip` = not tracked), else the default rule (mapEnvironment()).
 *
 * @param {string} rawEnv
 * @param {Record<string, 'test'|'qa'|'prod'|'skip'>} [envMap]
 * @returns {'test'|'qa'|'prod'|null}
 */
function environmentFor(rawEnv, envMap = {}) {
    const name = (rawEnv || '').trim().toLowerCase();
    const mapped = Object.entries(envMap).find(([key]) => key.trim().toLowerCase() === name);
    if (mapped) return MAPPED_ENVS.includes(mapped[1]) ? mapped[1] : null;
    return mapEnvironment(rawEnv);
}

/**
 * The GitHub environment names to remember for a repo: the ones stored plus the new ones, in first-seen order, at
 * most MAX_SEEN_ENVIRONMENTS.
 *
 * @param {string[]} stored
 * @param {string[]} seen
 * @returns {string[]}
 */
function mergeSeenEnvironments(stored, seen) {
    const out = [...(stored || [])];
    for (const raw of seen) {
        const name = String(raw || '').trim().slice(0, 100);
        if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
    }
    return out.slice(0, MAX_SEEN_ENVIRONMENTS);
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
 * The deploy's workflow run link, only when it is one on GitHub for this very repository. `log_url` is set by
 * whoever creates the deployment status (anyone with deployments:write on the repo), and the dashboard turns it
 * into a link: anything else (another host, `javascript:`, `https://github.com@evil.example/`) is dropped.
 *
 * @param {unknown} url
 * @param {string} fullName owner/name of the repository the deployment belongs to
 * @returns {string|null}
 */
function trustedRunUrl(url, fullName) {
    if (typeof url !== 'string' || typeof fullName !== 'string') return null;
    const match = /^https:\/\/github\.com\/([^/?#@\s]+\/[^/?#@\s]+)\/actions\/runs\/\d+(?:\/(?:job|attempts)\/\d+)?\/?(?:[?#][^\s]*)?$/.exec(url);
    return match && match[1].toLowerCase() === fullName.toLowerCase() ? url : null;
}

/**
 * Turns fetched deployments + statuses into an ordered plan.
 * - unknown environment (environmentFor(): the repo's `envMap`, else the default rule): permanent skip;
 * - no terminal status yet: `blockedIds` (the cursor must not pass it), unless older than stuckMaxAgeHours,
 *   then a permanent skip so one abandoned pipeline can't hold the cursor back forever;
 * - otherwise a plan entry, sorted by status time, with `previousSha` = the previous successful deploy's
 *   sha on the same environment within this batch (the caller seeds it from the database for the first);
 *   its `workflowRunUrl` is the status's `log_url` only when trustedRunUrl() accepts it for `fullName`.
 *
 * @returns {{ plan: object[], blockedIds: number[], skipped: Array<{ id: number, reason: 'environment'|'stuck' }> }}
 */
function buildDeploymentPlan(deployments, statusesById, { now = Date.now(), stuckMaxAgeHours, previousShaByEnv = {}, fullName = null, envMap = {} }) {
    const withEnv = [];
    const blockedIds = [];
    const skipped = [];

    for (const dep of deployments) {
        const environment = environmentFor(dep.environment, envMap);
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
            workflowRunUrl: trustedRunUrl(latest.log_url, fullName),
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

// The flag ingest API's key rule (routes/flags.js FLAG_KEY): what a commit can name is what a source can report.
const FLAG_KEY = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
// A trailer line: `Flag:` then one or more keys separated by commas, nothing else on the line.
const FLAG_TRAILER = /^flag:[ \t]*([A-Za-z_][A-Za-z0-9_.:-]*(?:[ \t]*,[ \t]*[A-Za-z_][A-Za-z0-9_.:-]*)*)[ \t]*$/i;

/**
 * `Flag: <key>` trailers (tf talos-story-run writes them next to `Change: TSK-n`): each pairs the flag with the work
 * item keys of its own commit (lib/flags.js treats it as a strong link). Only a body line holding nothing but keys
 * separated by commas counts; a reserved key, the subject line and a commit naming no work item give nothing.
 *
 * @param {string[]} messages
 * @returns {Array<{ flag: string, keys: string[] }>} in commit order
 */
function flagLinksFromMessages(messages) {
    const out = [];
    for (const message of messages) {
        const keys = extractIssueKeys(message);
        if (!keys.length) continue;
        // Trailers live below the subject line.
        const flags = String(message || '').split('\n').slice(1)
            .map((line) => FLAG_TRAILER.exec(line.trim()))
            .filter(Boolean)
            .flatMap((m) => m[1].split(/[\s,]+/))
            .filter((k) => FLAG_KEY.test(k) && !isReservedKey(k));
        for (const flag of [...new Set(flags)]) out.push({ flag, keys });
    }
    return out;
}

/**
 * Each issue key's earliest commit author date among a deployment's commits (G3, design-docs/G3-FLOW-TIME-PLAN.pl.md).
 * Commits come from GitHub (compare or commit API), so every field is checked; a commit without a valid date counts for
 * nothing.
 *
 * @param {Array<{ commit?: { message?: string, author?: { date?: string } } }>|undefined} commits
 * @returns {Object<string, string>} key -> ISO date
 */
function firstCommitDates(commits) {
    const out = {};
    for (const c of Array.isArray(commits) ? commits : []) {
        const commit = c && typeof c === 'object' ? c.commit : null;
        if (!commit || typeof commit !== 'object' || typeof commit.message !== 'string') continue;
        const raw = commit.author && typeof commit.author.date === 'string' ? commit.author.date : null;
        const time = raw ? Date.parse(raw) : NaN;
        if (Number.isNaN(time)) continue;
        for (const key of extractIssueKeys(commit.message)) {
            if (!out[key] || time < Date.parse(out[key])) out[key] = new Date(time).toISOString();
        }
    }
    return out;
}

module.exports = {
    firstCommitDates,
    flagLinksFromMessages,
    mapEnvironment,
    environmentFor,
    mergeSeenEnvironments,
    MAX_SEEN_ENVIRONMENTS,
    extractIssueKeys,
    extractCommitType,
    pickLatestStatus,
    computeDeployDurationMs,
    trustedRunUrl,
    buildDeploymentPlan,
    computeNextCursor,
    issuesFromMessages,
};
