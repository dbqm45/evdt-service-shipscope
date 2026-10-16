const fs = require('fs');
const os = require('os');
const path = require('path');
const { fail, safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');
const { resolveDisplayName } = require('./lib/github-users');
const { loadOrCompute } = require('./lib/retry-cache');
const { githubApiGet } = require('./lib/github-api');
const { parseIgnorePaths, diffTrees } = require('./lib/tree-diff');
const {
    STATE_MAP,
    ENV_ORDER,
    mapEnvironment,
    extractIssueKeys,
    extractCommitType,
    extractPromotedVersion,
    extractRunId,
    latestSuccessfulByEnv,
    trimOldRecords: trimOldRecordsPure,
    buildSummary,
    mergeIssueDeploymentHistory,
    computeDeployDurationMs,
    buildDeploymentPlan: buildDeploymentPlanPure,
    buildRecord,
    seedLastResolvedRefByEnv,
    seedLastResolvedRangeByEnv,
    pickLatestStatus,
    computeNextCursor,
    applyDrift,
} = require('./lib/deployment-records');
const { GITHUB_TOKEN, APP_REPO, COMPONENT } = process.env;
// Optional (docs/components.json `versionFile`): for a component whose QA/PROD deployments are *trigger commits*
// on a deployment branch (e.g. `deployment/qa` holding only `trigger.properties` with `version=v0.0.702`, which the
// workflow then checks out and builds), the deployment's own SHA is not the code that shipped — the ref named in
// that file is. Unset = every deployment SHA is the shipped code (the default for all other components).
const VERSION_FILE = process.env.VERSION_FILE ? safeRelativePath(process.env.VERSION_FILE, 'VERSION_FILE') : '';
// Optional (docs/components.json `driftIgnorePaths`, passed as a JSON array string): paths whose differences
// between two environments don't count as drift — deployment-branch plumbing (CODEOWNERS, workflows, READMEs,
// the version file) rather than shipped code. Unset/empty = every changed file counts. See lib/tree-diff.js.
const DRIFT_IGNORE_PATHS = (() => {
    try {
        return parseIgnorePaths(process.env.DRIFT_IGNORE_PATHS);
    } catch (e) {
        return fail(`Invalid DRIFT_IGNORE_PATHS: ${e.message}`);
    }
})();

const DATA_PATH = safeRelativePath(process.env.DATA_PATH || 'docs/data/deployments.json', 'DATA_PATH');
// Tiny, never-trimmed companion to DATA_PATH: `{ [component]: highestDeploymentIdEverSynced }`. GitHub
// deployment IDs are monotonically increasing per repo, so this is enough to know "have we already
// processed this one" without needing the full historical record to still be present in DATA_PATH —
// which, since RETENTION_DAYS physically removes old records (see trimOldRecords), it increasingly won't
// be. Without this, a trimmed-away deployment would look "new" again on the next run and pay the full
// per-deployment API cost (statuses, compare, display-name resolution) to re-process it, forever.
const CURSOR_PATH = safeRelativePath(process.env.CURSOR_PATH || 'docs/data/deployments-cursor.json', 'CURSOR_PATH');
// Tiny, never-trimmed companion to DATA_PATH, same spirit as CURSOR_PATH above but for a different gap:
// `{ [issueKey]: { [env]: { [component]: { deployedAt, commitUrl } } } }`, recording the *first* time an
// issue key was ever seen on a successful deployment, per env/component. Found and fixed as a real bug —
// `docs/app.js`'s release-status/Release Notes/lead-time joins all scan `deployments.json` directly for a
// record whose `relatedIssues` includes a given issue key; once RETENTION_DAYS trims that record away (and
// it isn't the one latest/latest-successful record `trimOldRecords()` always keeps), the issue silently
// reverts to looking "not deployed" even though it genuinely shipped once. This file is never trimmed, so
// that join can fall back to it once the live record is gone.
const ISSUE_DEPLOYMENTS_PATH = safeRelativePath(
    process.env.ISSUE_DEPLOYMENTS_PATH || 'docs/data/issue-deployments.json',
    'ISSUE_DEPLOYMENTS_PATH'
);
// Tiny, fully-recomputed-every-run companion to DATA_PATH: `{ [component]: { [env]: { current,
// latestOverall } } }`, where both are either a full deployment record (same shape as DATA_PATH's own
// entries — driftBehind/rollback/version included) or null. docs/app.js's currentVersion()/
// componentDeployments() repeat an O(n) filter+sort over the *entire* state.deployments array once per
// component and once per component×environment on every single first render (the Technical view's
// summary cards and component×env matrix) — for a tracked fleet with many components and up to
// RETENTION_DAYS of history each, that's real, repeated work blocking first paint. `current`/
// `latestOverall` here are exactly the two records trimOldRecords() already computes below (and always
// keeps, regardless of age) for that same purpose — writing them out separately costs nothing extra (no
// new API calls, no new computation, just reusing those two already-built maps) and lets the frontend do
// an O(1) lookup instead of re-deriving it from the full array. It's a fast-path cache, not a new source
// of truth — docs/app.js still falls back to deriving from the full deployments.json whenever a
// component/env is missing here (e.g. this file predates a component's onboarding) — and it only ever
// reflects whatever this component's own last *regular* sync wrote: a change made by the one-off,
// manually-triggered backfill-deployment-metadata.js (which doesn't go through trimOldRecords) won't be
// visible here until this component's next regular sync, acceptable since nothing depends on this file
// for correctness, only for render speed.
const SUMMARY_PATH = safeRelativePath(process.env.SUMMARY_PATH || 'docs/data/summary.json', 'SUMMARY_PATH');
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);

// A deployment can be fetched by `/deployments` before GitHub ever posts a terminal status for it at all
// (buildDeploymentPlan's `blockedIds`) — expected to resolve shortly. One that's still unresolved after
// this long never will (an abandoned/misconfigured deploy pipeline that posted `queued`/`in_progress` and
// nothing else, or whose only terminal status fell past the `?per_page=10` statuses page) — found and
// fixed as a real bug: an indefinitely-stuck deployment used to cap the sync cursor at `(its id) - 1`
// forever, forcing every higher-id deployment to be re-fetched and fully re-processed (statuses, compare,
// display-name resolution — real API cost) on every single future run, even though those deployments
// already have records in `deployments.json` and were just getting silently deduped at write time.
const STUCK_DEPLOYMENT_MAX_AGE_HOURS = Number(process.env.STUCK_DEPLOYMENT_MAX_AGE_HOURS || 48);

// Persists ETags for the few GitHub list endpoints fetched on *every single run* regardless of whether
// anything actually changed (`/deployments` page 1, `/tags`, `/releases` — see their githubApiAllPages
// call sites below) so a run where nothing changed on GitHub's side gets a free `304` instead of a real,
// rate-limit-counting `200` fetch. Unlike retry-cache.js's per-job cache, this is meant to survive *across*
// separate workflow runs — on its own, defaulting under RUNNER_TEMP, it only ever helps within one job
// attempt's own retries (same as the page cache), same safe no-op-if-missing behavior either way; the real
// cross-run win needs the caller to point GITHUB_API_ETAG_CACHE_DIR at a directory actually persisted
// between runs, which orchestrate-full-sync.yml does via an `actions/cache` step keyed by component.
const ETAG_CACHE_PATH = path.join(
    process.env.GITHUB_API_ETAG_CACHE_DIR || process.env.RUNNER_TEMP || os.tmpdir(),
    `shipscope-etags-${COMPONENT}.json`
);

function loadEtagCache() {
    try {
        return readJson(ETAG_CACHE_PATH, {});
    } catch (e) {
        console.warn(`Warning: could not read ETag cache at ${ETAG_CACHE_PATH}, starting fresh: ${e.message}`);

        return {};
    }
}

function saveEtagCache(etagCache) {
    fs.mkdirSync(path.dirname(ETAG_CACHE_PATH), { recursive: true });
    fs.writeFileSync(ETAG_CACHE_PATH, JSON.stringify(etagCache));
}

if (!GITHUB_TOKEN) {
    fail('Missing GITHUB_TOKEN');
}
if (!APP_REPO) {
    fail('Missing APP_REPO (e.g. "myorg/evapl-service-frontend")');
}
if (!COMPONENT) {
    fail('Missing COMPONENT (e.g. "evapl-service-frontend")');
}

// Thin bindings of the pure lib/deployment-records.js functions to this run's env-derived settings.
const trimOldRecords = records => trimOldRecordsPure(records, { retentionDays: RETENTION_DAYS });
const buildDeploymentPlan = (deployments, latestStatusById, statusesById, now = Date.now()) =>
    buildDeploymentPlanPure(deployments, latestStatusById, statusesById, { now, stuckMaxAgeHours: STUCK_DEPLOYMENT_MAX_AGE_HOURS });

function updateIssueDeploymentHistory(allRecords) {
    const history = readJson(ISSUE_DEPLOYMENTS_PATH, {});

    if (mergeIssueDeploymentHistory(history, allRecords)) {
        writeJson(ISSUE_DEPLOYMENTS_PATH, history);
    }
}

/** Pure: the `version` value from a `key=value` properties file body, or null. */
function parseVersionProperty(text) {
    const m = /^\s*version\s*[=:]\s*(\S+)\s*$/m.exec(text || '');

    return m ? m[1] : null;
}

/**
 * For VERSION_FILE components: reads the version file at the deployment's commit and resolves the ref it names.
 * `ref` is a git tag name when one exists, else the commit SHA the name resolves to (immutable, safe for
 * /compare); `label` is the version as written. Null (caller falls back to the deployment SHA) when the
 * file/ref is missing — never throws, a lookup problem must not fail the sync.
 */
async function resolveVersionFileRef(sha, tagNames) {
    if (!VERSION_FILE) return null;

    try {
        const file = await githubApi(`/contents/${VERSION_FILE.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`);
        const label = parseVersionProperty(Buffer.from(file.content || '', 'base64').toString('utf8'));

        if (!label) return null;
        if (tagNames.has(label)) return { ref: label, label };

        const commit = await githubApi(`/commits/${encodeURIComponent(label)}`);

        return commit.sha ? { ref: commit.sha, label } : null;
    } catch (e) {
        console.warn(`Warning: could not resolve ${VERSION_FILE} version for ${sha}: ${e.message}`);

        return null;
    }
}

async function githubApi(pathSuffix, etagCache = null) {
    return githubApiGet(`https://api.github.com/repos/${APP_REPO}${pathSuffix}`, GITHUB_TOKEN, etagCache);
}

function pageCachePathFor(key) {
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');

    return path.join(process.env.RUNNER_TEMP || os.tmpdir(), `shipscope-pages-${safeKey}.json`);
}

// A truncated/corrupt cache file (e.g. the job was killed mid-write) is treated as "no cache" — otherwise it
// would make every retry of this job throw on JSON.parse forever instead of simply re-fetching.
function readPageCache(cachePath) {
    if (!cachePath || !fs.existsSync(cachePath)) return [];

    try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

        return Array.isArray(cached) ? cached : [];
    } catch (e) {
        console.warn(`Warning: ignoring unreadable page cache ${cachePath}: ${e.message}`);

        return [];
    }
}

// Optional cacheKey persists pages to disk as they're fetched, so a failure partway through (e.g. rate
// limiting on a later page, even after githubApi's own retries are exhausted) doesn't force the *next*
// job attempt to re-fetch pages already fetched successfully in an earlier attempt of this same job.
//
// Optional `stopWhen(record)` lets a caller that knows the list is sorted newest-first (GitHub's
// `/deployments` is — reverse creation order, which tracks descending ID) stop paginating as soon as it
// sees a record it already has, instead of always walking every page back to the very first deployment.
// Found and fixed as a real bug: under a large backlog that already has thousands of synced deployments,
// every run used to re-paginate the *entire* list just to find the handful newer than the cursor — this
// is the dominant cost of a "does nothing new" run once a repo has enough history. Only ever applied to
// `/deployments` below, not `/tags`/`/releases` — those have no cursor-like "already seen" concept to stop
// at, and are small enough that paginating in full is cheap anyway.
async function githubApiAllPages(basePathWithQuery, cacheKey, stopWhen, etagCache = null) {
    const sep = basePathWithQuery.includes('?') ? '&' : '?';
    const cachePath = cacheKey ? pageCachePathFor(cacheKey) : null;
    const all = readPageCache(cachePath);
    const dedupeKey = r => (r.id != null ? r.id : r.name);
    // Built once and extended per page — rebuilding it from `all` on every page made this O(pages × records).
    const seenKeys = new Set(all.map(dedupeKey));
    let page = Math.floor(all.length / 100) + 1;

    if (all.length) {
        console.log(`Resuming "${basePathWithQuery}" from page ${page} (${all.length} record(s) already fetched earlier in this job).`);
    }

    while (true) {
        const pageResults = await githubApi(`${basePathWithQuery}${sep}page=${page}`, etagCache);

        if (!pageResults.length) break;

        // Deduped by a unique identifier — found and fixed as a real bug: resuming from a cached partial
        // fetch (above) picks up at a page number computed from how many records are already cached,
        // which assumes the underlying list hasn't shifted since. If a new item landed on an earlier page
        // between the original fetch and the resumed one (a real deployment firing mid-pagination, most
        // likely during a large first-sync backlog — exactly when this caching exists at all), the same
        // item can appear on two different fetched pages and get appended twice. This helper is also used
        // for `/tags` and `/releases`, which don't carry an `id` field the same way deployments do (a tag
        // is identified by its unique `name` instead) — `id ?? name` covers both shapes correctly, and
        // since each call only ever fetches one endpoint, there's no cross-endpoint key collision risk.
        for (const r of pageResults) {
            const k = dedupeKey(r);

            if (!seenKeys.has(k)) {
                seenKeys.add(k);
                all.push(r);
            }
        }

        if (cachePath) {
            fs.writeFileSync(cachePath, JSON.stringify(all));
        }

        if (pageResults.length < 100) break;
        if (stopWhen && pageResults.some(stopWhen)) break;

        page += 1;
    }

    return all;
}

const MAX_MANUAL_LOOKUPS_PER_RUN = 30;

// Caps how many new deployments a single run resolves (statuses + commit + compare + display-name — the
// expensive per-deployment work in main()'s loop below). Found and fixed as a real bug: with no cap, a
// large first-sync backlog (or one that's fallen behind for a while) processes every new deployment in one
// run, which can exhaust the GitHub API rate limit mid-run (see CLAUDE.md) and, since the cursor was only
// ever written after the *entire* loop finished, loses all of that run's progress on any failure instead
// of keeping whatever it already resolved. Oldest-first (ascending by id) so a capped run always makes
// forward progress from the front of the backlog rather than resolving an arbitrary subset; whatever
// doesn't fit this run is simply newer than the new cursor and picked up by the very next run.
const MAX_NEW_DEPLOYMENTS_PER_RUN = Number(process.env.MAX_NEW_DEPLOYMENTS_PER_RUN || 200);

async function resolveManualFlag(logUrl, runEventCache) {
    const runId = extractRunId(logUrl);

    if (!runId) return null;

    if (runEventCache.has(runId)) {
        return runEventCache.get(runId);
    }

    if (runEventCache.size >= MAX_MANUAL_LOOKUPS_PER_RUN) {
        // Backfill/catch-up runs can have dozens of new deployments at once; cap the extra
        // /actions/runs calls per invocation instead of resolving "manual" for all of them.
        return null;
    }

    try {
        const run = await githubApi(`/actions/runs/${runId}`);
        const manual = run.event === 'workflow_dispatch';

        runEventCache.set(runId, manual);

        return manual;
    } catch (e) {
        console.warn(`Warning: could not determine trigger type for run ${runId}: ${e.message}`);

        // Cached as a failure too: otherwise a persistent error (e.g. a 403 from a missing `actions: read`
        // permission, which isn't retried) never counts toward MAX_MANUAL_LOOKUPS_PER_RUN and re-fetches the
        // same run for every deployment sharing it. The returned value is unchanged (`null`).
        runEventCache.set(runId, null);

        return null;
    }
}

/**
 * Compares the repository content of two refs. Resolves to `{ same: true }` when both commits share a git tree,
 * `{ same: false, diff }` when they differ (`diff` = diffTrees() result: changed paths after DRIFT_IGNORE_PATHS, or
 * null when the recursive listing was truncated/unavailable), and `null` when the comparison could not be made
 * at all (API error) — unknown is never reported as "same".
 */
async function compareTrees(refA, refB) {
    try {
        const [a, b] = await Promise.all([githubApi(`/commits/${refA}`), githubApi(`/commits/${refB}`)]);
        const shaA = a.commit?.tree?.sha;
        const shaB = b.commit?.tree?.sha;

        if (!shaA || !shaB) return null;
        if (shaA === shaB) return { same: true };

        const [treeA, treeB] = await Promise.all([
            githubApi(`/git/trees/${shaA}?recursive=1`),
            githubApi(`/git/trees/${shaB}?recursive=1`),
        ]);

        return { same: false, diff: diffTrees(treeA, treeB, DRIFT_IGNORE_PATHS) };
    } catch (e) {
        console.warn(`Warning: could not compare trees for ${refA} and ${refB}: ${e.message}`);

        return null;
    }
}

async function computeEnvDrift(latestByEnv) {
    const drift = {};
    // Envs for which the compare call itself failed (transient error) — distinct from "compare
    // succeeded and found no drift." The caller must never treat a failed check as a confirmed
    // "no drift" result, since that would wipe out a previously-detected, still-real driftBehind.
    const failed = new Set();

    for (let i = 1; i < ENV_ORDER.length; i++) {
        const laterEnv = ENV_ORDER[i];
        const earlierEnv = ENV_ORDER[i - 1];
        const laterRef = latestByEnv[laterEnv] && (latestByEnv[laterEnv].resolvedRef || latestByEnv[laterEnv].version);
        const earlierRef = latestByEnv[earlierEnv] && (latestByEnv[earlierEnv].resolvedRef || latestByEnv[earlierEnv].version);

        if (!laterRef || !earlierRef || laterRef === earlierRef) continue;

        try {
            const comparison = await githubApi(`/compare/${laterRef}...${earlierRef}`);
            const entry = {};

            if (comparison.ahead_by > 0) {
                entry.behindEnv = earlierEnv;
                entry.commitCount = comparison.ahead_by;
            }

            // behind_by is commits laterEnv (e.g. prod) has that earlierEnv (e.g. qa) never saw — a
            // hotfix or direct deploy that skipped the normal test -> qa -> prod promotion path.
            if (comparison.behind_by > 0) {
                entry.untestedIn = earlierEnv;
                entry.untestedCommitCount = comparison.behind_by;
            }

            if (Object.keys(entry).length) {
                // The commit counts measure diverged *history*, not code: with separate per-env deployment branches,
                // every merge/squash creates a new SHA there, so two envs running byte-identical code can still report
                // hundreds of commits each way. The git trees are the authoritative "same code" signal: identical
                // trees — or trees differing only in DRIFT_IGNORE_PATHS — mean no drift. Otherwise `diff` carries the
                // changed paths, and the commit counts stay as raw history. A comparison that could not be made
                // (API error, truncated listing) is `diff: { unknown: true }`, never "identical".
                const trees = await compareTrees(laterRef, earlierRef);

                if (trees && trees.same) continue;

                if (trees && trees.diff) {
                    if (trees.diff.files === 0) continue;

                    entry.diff = trees.diff;
                } else {
                    entry.diff = { unknown: true };
                }

                // Same displayed version label but a different commit: the label is display-only (often
                // regex-matched from a commit message, no tag/Release behind it), so "N behind" would read as
                // ordinary promotion lag when it's really two builds of the "same" version — flag it for the UI.
                const laterVersion = latestByEnv[laterEnv].version;

                if (laterVersion && laterVersion === latestByEnv[earlierEnv].version) {
                    entry.sameVersion = true;
                }

                drift[laterEnv] = entry;
            }
        } catch (e) {
            console.warn(`Warning: could not compute drift for ${laterEnv} vs ${earlierEnv}: ${e.message}`);
            failed.add(laterEnv);
        }
    }

    return { drift, failed };
}

async function issuesInRange(previousRef, currentRef, currentCommitMessage) {
    if (!previousRef || previousRef === currentRef) {
        const message = currentCommitMessage !== undefined
            ? currentCommitMessage
            : (await githubApi(`/commits/${currentRef}`)).commit?.message;
        const keys = extractIssueKeys(message);
        const type = extractCommitType(message);
        const typesByKey = {};

        if (type) {
            keys.forEach(k => { typesByKey[k] = type; });
        }

        return { keys, typesByKey, compareStatus: null };
    }

    const comparison = await githubApi(`/compare/${previousRef}...${currentRef}`);

    // GitHub's compare endpoint caps `commits` at 250 regardless of `total_commits` — a release spanning
    // more than that (e.g. a long-overdue promotion, or the very first sync after onboarding a component)
    // silently loses `relatedIssues`/`issueCommitTypes` for whatever's missing, which then shows up as
    // "Not deployed" on prod for issues that genuinely are there. No cheap full fix (the only way to get
    // the rest is walking /commits page by page until previousRef is reached), so at minimum this makes
    // the gap loud instead of silent.
    if (comparison.total_commits > (comparison.commits || []).length) {
        console.warn(
            `::warning::Compare ${previousRef}...${currentRef} has ${comparison.total_commits} commits but ` +
            `GitHub only returned ${(comparison.commits || []).length} — relatedIssues for this deployment may ` +
            'be incomplete (issues from the missing commits won\'t show as deployed).'
        );
    }

    const keySet = new Set();
    const typesByKey = {};

    for (const c of comparison.commits || []) {
        const message = c.commit?.message;
        const type = extractCommitType(message);

        extractIssueKeys(message).forEach(k => {
            keySet.add(k);

            if (type) {
                typesByKey[k] = type;
            }
        });
    }

    // "behind" means currentRef is an ancestor of previousRef — this deploy moved the environment
    // backwards in history, i.e. a rollback, not a normal forward promotion.
    return { keys: [...keySet], typesByKey, compareStatus: comparison.status };
}

async function main() {
    const existing = readJson(DATA_PATH, []);
    const existingForComponent = existing.filter(d => d.component === COMPONENT);
    const otherComponents = existing.filter(d => d.component !== COMPONENT);

    const cursor = readJson(CURSOR_PATH, {});
    const lastSyncedId = cursor[COMPONENT] || 0;

    // Mutated in place by githubApi()/githubApiAllPages() for the three list endpoints below that get
    // fetched on every run regardless of whether anything changed — see ETAG_CACHE_PATH's own comment.
    const etagCache = loadEtagCache();

    // Fetching and resolving from GitHub is expensive (one API call per new deployment, plus more per
    // entry below) and its result doesn't depend on which run wins the push race on `live` — so it's
    // cached per job and only actually redone once, even if this script gets re-invoked by
    // sync-with-retry after a losing push. Redoing it on every retry is what exhausted the GitHub API
    // rate limit for a large, first-time backlog in practice.
    const { resolvedRecords: records, maxDeploymentId } = await loadOrCompute(`deployments-${COMPONENT}`, async () => {
        // GitHub returns `/deployments` newest-first (reverse creation order, which tracks descending ID)
        // — so once a page turns up an ID already at or below the cursor, every remaining page can only
        // contain IDs we've already synced. `stopWhen` short-circuits pagination there instead of always
        // walking all the way back to the repo's very first deployment on every single run.
        const deployments = await githubApiAllPages(
            '/deployments?per_page=100',
            `deployments-${COMPONENT}`,
            dep => dep.id <= lastSyncedId,
            etagCache
        );
        saveEtagCache(etagCache);
        // Compared against the cursor (highest deployment ID ever synced for this component), not against
        // which records are currently present in DATA_PATH — those get physically trimmed by RETENTION_DAYS
        // (see trimOldRecords), so a deployment this old would otherwise look "new" again forever.
        const allNewDeployments = deployments.filter(dep => dep.id > lastSyncedId).sort((a, b) => a.id - b.id);
        const newDeployments = allNewDeployments.slice(0, MAX_NEW_DEPLOYMENTS_PER_RUN);

        if (allNewDeployments.length > newDeployments.length) {
            console.warn(
                `::warning::${allNewDeployments.length} new deployment(s) found for "${COMPONENT}" — only ` +
                `processing the oldest ${newDeployments.length} this run (MAX_NEW_DEPLOYMENTS_PER_RUN); the ` +
                'rest will be picked up on a future run.'
            );
        }

        const latestStatusById = {};
        const statusesById = {};

        // Two list calls per sync run (not per deployment) — cheap. Lets envs whose deployed commit isn't
        // itself a "release" commit (e.g. test, deployed straight from a feature branch with no version in
        // the commit message) still show a real version instead of falling back to a raw SHA. A GitHub
        // Release is the most deliberate/curated signal, a plain tag is still structured but less so, and
        // free-text commit-message parsing is the least reliable of the three (it can match an unrelated
        // version-like substring) — hence that priority order below.
        const tags = newDeployments.length ? await githubApiAllPages('/tags?per_page=100', null, null, etagCache) : [];
        const shaToTag = new Map(tags.map(t => [t.commit.sha, t.name]));

        const releases = newDeployments.length ? await githubApiAllPages('/releases?per_page=100', null, null, etagCache) : [];
        if (newDeployments.length) saveEtagCache(etagCache);
        const tagNameToSha = new Map(tags.map(t => [t.name, t.commit.sha]));
        const shaToRelease = new Map(
            releases
                .map(r => [tagNameToSha.get(r.tag_name), r.tag_name])
                .filter(([sha]) => sha)
        );

        for (const dep of newDeployments) {
            const statuses = await githubApi(`/deployments/${dep.id}/statuses?per_page=10`);

            // The newest entry isn't necessarily the one that matters: GitHub appends `inactive` to a
            // deployment's own status history whenever a *later* deployment on the same environment
            // succeeds (`auto_inactive`, on by default outside an environment literally named
            // `production` — see computeDeployDurationMs's comment). If both deployments end up fetched
            // as "new" in the same sync run (e.g. a missed notify-deployment dispatch let two pile up
            // between syncs — a known gap, see CLAUDE.md/ONBOARDING.md), the earlier
            // one's newest status by the time this runs is that `inactive` marker, not its real outcome
            // — blindly taking `statuses[0]` would make `STATE_MAP` below find nothing and silently drop
            // this deployment from `withEnv` entirely, even though it genuinely succeeded or failed.
            // Skipping past non-terminal entries (currently just `inactive`; STATE_MAP already ignores
            // anything else it doesn't recognize) to find the most recent real outcome fixes that.
            if (statuses.length) {
                latestStatusById[dep.id] = pickLatestStatus(statuses);
                statusesById[dep.id] = statuses;
            }
        }

        const { plan, blockedIds } = buildDeploymentPlan(newDeployments, latestStatusById, statusesById);
        // The cursor must never advance past a deployment that doesn't have a terminal status yet — doing
        // so would permanently exclude it from every future `newDeployments` filter (which only compares
        // IDs against the cursor) even after it later resolves to a real success/failure. So the new
        // cursor only ever advances up to just below the lowest still-blocked ID in this batch; with none
        // blocked, it's free to advance to the highest ID seen at all (an unrecognized-environment
        // deployment is a permanent, not temporary, skip — see buildDeploymentPlan — so it's fine to
        // advance past those). Based on `newDeployments` (the capped, actually-processed batch), not the
        // full fetched `deployments` list — found and fixed as a real bug risk: with MAX_NEW_DEPLOYMENTS_PER_RUN
        // truncating the batch, advancing the cursor using the untruncated list's max ID would skip past
        // whatever didn't fit in this run, permanently excluding it the same way an unbounded blocked ID
        // used to (see H3's fix above).
        const maxDeploymentId = computeNextCursor(newDeployments, blockedIds, lastSyncedId);
        const lastResolvedRefByEnv = seedLastResolvedRefByEnv(existingForComponent);
        const lastResolvedRangeByEnv = seedLastResolvedRangeByEnv(existingForComponent);
        const runEventCache = new Map();
        const nameCache = new Map();
        const resolvedRecords = [];

        for (const entry of plan) {
            let relatedIssues = [];
            let issueCommitTypes = {};
            let promotedVersion = null;
            let currentRef = null;
            let fromVersionFile = false;

            try {
                const commit = await githubApi(`/commits/${entry.dep.sha}`);
                const message = commit.commit?.message || '';

                // `promotedVersion` is purely a *display* string (the `version` field) — a free-text regex
                // match (extractPromotedVersion) is the least reliable of the three sources, but still
                // fine to just show. `currentRef`, below, is different: it's used as a literal git ref in
                // the GitHub `/compare` call — a verified release/tag name is a real object GitHub already
                // confirmed exists, but a regex match from commit-message free text has no such guarantee.
                // Found and fixed as a real bug: using the unverified regex match directly as `currentRef`
                // risked a 404 (no such ref), or worse, silently comparing against some unrelated existing
                // tag/branch that happens to share that version-like substring. `currentRef` now only ever
                // uses a verified release/tag, falling straight back to the SHA (always resolvable, same
                // fallback `promotedVersion` itself used before this fix) when neither matched.
                const verifiedRef = shaToRelease.get(entry.dep.sha) || shaToTag.get(entry.dep.sha) || null;
                // VERSION_FILE components: the file names the ref that really shipped, which outranks
                // everything derived from the (trigger) commit itself.
                const sourceRef = await resolveVersionFileRef(entry.dep.sha, new Set(tagNameToSha.keys()));

                promotedVersion = sourceRef ? sourceRef.label : (verifiedRef || extractPromotedVersion(message) || null);
                currentRef = sourceRef ? sourceRef.ref : (verifiedRef || entry.dep.sha);
                fromVersionFile = !!sourceRef;

                const previousRef = lastResolvedRefByEnv[entry.environment] || null;
                const cachedRange = lastResolvedRangeByEnv[entry.environment];

                if (cachedRange && cachedRange.ref === currentRef) {
                    // Same logical release as the last successfully-resolved record for this env — GitHub
                    // can fire more than one deployment/status entry for what is, in git terms, one commit
                    // (e.g. a squash-merged release re-notified by a second workflow job a few minutes
                    // later). Comparing currentRef against itself here would silently collapse to an
                    // empty/self range — no compare URL, no relatedIssues — discarding the real range
                    // already resolved for this exact ref moments ago. Reuse it instead.
                    relatedIssues = cachedRange.relatedIssues;
                    issueCommitTypes = cachedRange.issueCommitTypes;

                    if (cachedRange.compareUrl) {
                        entry.compareUrl = cachedRange.compareUrl;
                    }
                    if (cachedRange.rollback) {
                        entry.rollback = cachedRange.rollback;
                    }
                } else {
                    const range = await issuesInRange(previousRef, currentRef, sourceRef ? undefined : message);

                    relatedIssues = range.keys;
                    issueCommitTypes = range.typesByKey;

                    if (range.compareStatus === 'behind') {
                        // toRef: where the environment went back to (this deploy), not where it came from -- what
                        // the UI's rollback badge names, and what the server stores too.
                        entry.rollback = { toRef: currentRef };
                    }

                    if (previousRef && previousRef !== currentRef && APP_REPO) {
                        entry.compareUrl = `https://github.com/${APP_REPO}/compare/${previousRef}...${sourceRef ? currentRef : entry.dep.sha}`;
                    }
                }

                if (entry.status === 'success') {
                    lastResolvedRefByEnv[entry.environment] = currentRef;
                    lastResolvedRangeByEnv[entry.environment] = {
                        ref: currentRef,
                        compareUrl: entry.compareUrl || null,
                        relatedIssues,
                        issueCommitTypes,
                        rollback: entry.rollback || null,
                    };
                }
            } catch (e) {
                console.warn(`Warning: could not determine commit range for deployment ${entry.dep.id}: ${e.message}`);
            }

            entry.manual = await resolveManualFlag(entry.workflowRunUrl, runEventCache);

            entry.deployedByLogin = entry.dep.creator ? entry.dep.creator.login : null;
            entry.deployedByName = await resolveDisplayName(entry.deployedByLogin, GITHUB_TOKEN, nameCache);

            const record = buildRecord(entry, COMPONENT, relatedIssues, APP_REPO, promotedVersion, issueCommitTypes, currentRef);

            if (record.resolvedRef && fromVersionFile) record.versionFromFile = true;
            resolvedRecords.push(record);
        }

        console.log(
            `Fetched ${deployments.length} deployment(s) for component "${COMPONENT}" from ${APP_REPO} ` +
            `(pagination stops once it reaches the cursor), ${allNewDeployments.length} new, ` +
            `${newDeployments.length} processed this run.`
        );

        return { resolvedRecords, maxDeploymentId };
    });

    // Guards the rarer case of a second, concurrent run *for this same component* already having pushed
    // some of these same new deployment IDs while this run was retrying — the cache above only protects
    // against re-fetching, not against double-adding, so re-check against the freshly re-read `live` here.
    const existingIds = new Set(existingForComponent.map(d => d.id));
    const freshRecords = records.filter(r => !existingIds.has(r.id));
    const componentRecords = [...existingForComponent, ...freshRecords];

    // Scans this component's *full current* set, not just freshRecords — a one-time, zero-API-cost
    // backfill effect: every record already sitting in deployments.json right now (synced before this
    // file existed, and not yet trimmed) gets captured into the never-trimmed companion on this component's
    // very next sync, instead of needing a separate one-off backfill script. Cheap and idempotent (only
    // first-seen entries are ever written) — safe to redo on every single run.
    updateIssueDeploymentHistory(componentRecords);

    const latestByEnv = latestSuccessfulByEnv(componentRecords);
    // Records synced before VERSION_FILE was enabled still point at the trigger commit, so drift for them is
    // computed from the ref the file names (looked up now, drift only ever needs each env's latest record) —
    // no reset of old data needed for the displayed drift to match the code that actually shipped.
    const driftInput = {};

    for (const [env, rec] of Object.entries(latestByEnv)) {
        const sourceRef = VERSION_FILE && rec.resolvedRef && !rec.versionFromFile
            ? await resolveVersionFileRef(rec.resolvedRef, new Set())
            : null;

        driftInput[env] = sourceRef ? { ...rec, resolvedRef: sourceRef.ref, version: sourceRef.label } : rec;
    }

    const { drift, failed } = await computeEnvDrift(driftInput);

    applyDrift(latestByEnv, drift, failed);

    // Trimmed across *every* component, not just COMPONENT — cheap (pure local filtering, no API calls)
    // and this run is already rewriting the whole file, so there's no reason to wait for each other
    // component's own next sync to shrink its share of it too. `latestOverall`/`latestSuccess` already
    // span every component for the same reason, so SUMMARY_PATH below is a full, fresh recompute each
    // run too — same idempotent-full-rewrite shape as DATA_PATH itself (no-op write when nothing actually
    // changed → sync-with-retry's `git diff --staged --quiet` finds nothing to commit).
    const { records: merged, latestOverall, latestSuccess } = trimOldRecords([...otherComponents, ...componentRecords]);

    writeJson(DATA_PATH, merged);
    writeJson(SUMMARY_PATH, buildSummary(latestOverall, latestSuccess));

    if (maxDeploymentId > lastSyncedId) {
        cursor[COMPONENT] = maxDeploymentId;
        writeJson(CURSOR_PATH, cursor);
    }

    console.log(
        `Component "${COMPONENT}": ${freshRecords.length} deployment record(s) recorded this run` +
        (records.length !== freshRecords.length
            ? ` (${records.length - freshRecords.length} already present from a concurrent run, skipped).`
            : '.')
    );

    // Early-warning only — even with RETENTION_DAYS trimming the bulk of history, a large enough tracked
    // fleet could still approach GitHub's hard 100 MB per-file push rejection faster than expected. This
    // just surfaces the trend long before that, so lowering RETENTION_DAYS (or sharding) can be a planned
    // decision instead of a surprise failed push.
    const sizeMb = Buffer.byteLength(JSON.stringify(merged)) / (1024 * 1024);
    const SIZE_WARNING_THRESHOLD_MB = Number(process.env.SIZE_WARNING_THRESHOLD_MB || 20);

    if (sizeMb >= SIZE_WARNING_THRESHOLD_MB) {
        console.warn(
            `::warning::${DATA_PATH} is now ~${sizeMb.toFixed(1)} MB (warning threshold: ${SIZE_WARNING_THRESHOLD_MB} MB, ` +
            'GitHub hard-rejects a push over 100 MB) — consider lowering RETENTION_DAYS before it gets there.'
        );
    }
}

module.exports = {
    mapEnvironment,
    extractIssueKeys,
    extractCommitType,
    extractPromotedVersion,
    computeDeployDurationMs,
    extractRunId,
    latestSuccessfulByEnv,
    computeEnvDrift,
    parseVersionProperty,
    buildDeploymentPlan,
    buildRecord,
    githubApiAllPages,
    updateIssueDeploymentHistory,
    seedLastResolvedRefByEnv,
    trimOldRecords,
    buildSummary,
};

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}