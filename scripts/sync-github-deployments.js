const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDisplayName } = require('./lib/github-users');
const { loadOrCompute } = require('./lib/retry-cache');
const { GITHUB_TOKEN, APP_REPO, COMPONENT } = process.env;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function safeRelativePath(inputPath, label) {
    const normalized = path.normalize(inputPath);

    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        fail(`${label} "${inputPath}" is not a safe relative path — refusing to use it.`);
    }

    return normalized;
}

const DATA_PATH = safeRelativePath(process.env.DATA_PATH || 'docs/data/deployments.json', 'DATA_PATH');

if (!GITHUB_TOKEN) {
    fail('Missing GITHUB_TOKEN');
}
if (!APP_REPO) {
    fail('Missing APP_REPO (e.g. "myorg/evapl-service-frontend")');
}
if (!COMPONENT) {
    fail('Missing COMPONENT (e.g. "evapl-service-frontend")');
}

function mapEnvironment(rawEnv) {
    const e = (rawEnv || '').toLowerCase();

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

function computeDeployDurationMs(statuses) {
    if (!statuses || statuses.length < 2) return null;

    const times = statuses.map(s => new Date(s.created_at).getTime());

    return Math.max(...times) - Math.min(...times);
}

function buildDeploymentPlan(deployments, latestStatusById, statusesById) {
    const withEnv = [];

    for (const dep of deployments) {
        const environment = mapEnvironment(dep.environment);

        if (!environment) continue;

        const latest = latestStatusById[dep.id];

        if (!latest) continue;

        const status = STATE_MAP[latest.state];

        if (!status) continue;

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

    return plan;
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

const RATE_LIMIT_MAX_ATTEMPTS = 4;
const RATE_LIMIT_MAX_DELAY_MS = 10 * 60_000;

async function githubApi(pathSuffix) {
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
        const res = await fetch(`https://api.github.com/repos/${APP_REPO}${pathSuffix}`, {
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github+json',
            },
        });

        if (res.ok) {
            return res.json();
        }

        const body = await res.text();
        const isRateLimited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');

        if (!isRateLimited || attempt === RATE_LIMIT_MAX_ATTEMPTS) {
            throw new Error(`GitHub API error on ${pathSuffix}: ${res.status} ${body}`);
        }

        const resetAtMs = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const delayMs = Number.isFinite(resetAtMs) && resetAtMs > 0
            ? Math.min(Math.max(resetAtMs - Date.now(), 1000), RATE_LIMIT_MAX_DELAY_MS)
            : 30_000;

        console.warn(
            `Rate limited on ${pathSuffix}; waiting ${Math.ceil(delayMs / 1000)}s before retry ${attempt + 1}/${RATE_LIMIT_MAX_ATTEMPTS}.`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
}

function pageCachePathFor(key) {
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');

    return path.join(process.env.RUNNER_TEMP || os.tmpdir(), `shipscope-pages-${safeKey}.json`);
}

// Optional cacheKey persists pages to disk as they're fetched, so a failure partway through (e.g. rate
// limiting on a later page, even after githubApi's own retries are exhausted) doesn't force the *next*
// job attempt to re-fetch pages already fetched successfully in an earlier attempt of this same job.
async function githubApiAllPages(basePathWithQuery, cacheKey) {
    const sep = basePathWithQuery.includes('?') ? '&' : '?';
    const cachePath = cacheKey ? pageCachePathFor(cacheKey) : null;
    let all = cachePath && fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : [];
    let page = Math.floor(all.length / 100) + 1;

    if (all.length) {
        console.log(`Resuming "${basePathWithQuery}" from page ${page} (${all.length} record(s) already fetched earlier in this job).`);
    }

    while (true) {
        const pageResults = await githubApi(`${basePathWithQuery}${sep}page=${page}`);

        if (!pageResults.length) break;

        all = all.concat(pageResults);

        if (cachePath) {
            fs.writeFileSync(cachePath, JSON.stringify(all));
        }

        if (pageResults.length < 100) break;

        page += 1;
    }

    return all;
}

const MAX_MANUAL_LOOKUPS_PER_RUN = 30;

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

        return null;
    }
}

async function computeEnvDrift(latestByEnv) {
    const drift = {};

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
                drift[laterEnv] = entry;
            }
        } catch (e) {
            console.warn(`Warning: could not compute drift for ${laterEnv} vs ${earlierEnv}: ${e.message}`);
        }
    }

    return drift;
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
    const existing = fs.existsSync(DATA_PATH) ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) : [];
    const existingForComponent = existing.filter(d => d.component === COMPONENT);
    const otherComponents = existing.filter(d => d.component !== COMPONENT);
    const knownIds = new Set(existingForComponent.map(d => String(d.id).replace(/^gh-/, '')));

    // Fetching and resolving from GitHub is expensive (one API call per new deployment, plus more per
    // entry below) and its result doesn't depend on which run wins the push race on `live` — so it's
    // cached per job and only actually redone once, even if this script gets re-invoked by
    // sync-with-retry after a losing push. Redoing it on every retry is what exhausted the GitHub API
    // rate limit for a large, first-time backlog in practice.
    const records = await loadOrCompute(`deployments-${COMPONENT}`, async () => {
        const deployments = await githubApiAllPages('/deployments?per_page=100', `deployments-${COMPONENT}`);
        const newDeployments = deployments.filter(dep => !knownIds.has(String(dep.id)));
        const latestStatusById = {};
        const statusesById = {};

        // Two list calls per sync run (not per deployment) — cheap. Lets envs whose deployed commit isn't
        // itself a "release" commit (e.g. test, deployed straight from a feature branch with no version in
        // the commit message) still show a real version instead of falling back to a raw SHA. A GitHub
        // Release is the most deliberate/curated signal, a plain tag is still structured but less so, and
        // free-text commit-message parsing is the least reliable of the three (it can match an unrelated
        // version-like substring) — hence that priority order below.
        const tags = newDeployments.length ? await githubApiAllPages('/tags?per_page=100') : [];
        const shaToTag = new Map(tags.map(t => [t.commit.sha, t.name]));

        const releases = newDeployments.length ? await githubApiAllPages('/releases?per_page=100') : [];
        const tagNameToSha = new Map(tags.map(t => [t.name, t.commit.sha]));
        const shaToRelease = new Map(
            releases
                .map(r => [tagNameToSha.get(r.tag_name), r.tag_name])
                .filter(([sha]) => sha)
        );

        for (const dep of newDeployments) {
            const statuses = await githubApi(`/deployments/${dep.id}/statuses?per_page=10`);

            if (statuses.length) {
                latestStatusById[dep.id] = statuses[0];
                statusesById[dep.id] = statuses;
            }
        }

        const plan = buildDeploymentPlan(newDeployments, latestStatusById, statusesById);
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

            try {
                const commit = await githubApi(`/commits/${entry.dep.sha}`);
                const message = commit.commit?.message || '';

                promotedVersion = shaToRelease.get(entry.dep.sha)
                    || shaToTag.get(entry.dep.sha)
                    || extractPromotedVersion(message)
                    || null;
                currentRef = promotedVersion || entry.dep.sha;

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
                    const range = await issuesInRange(previousRef, currentRef, message);

                    relatedIssues = range.keys;
                    issueCommitTypes = range.typesByKey;

                    if (range.compareStatus === 'behind') {
                        entry.rollback = { toRef: previousRef };
                    }

                    if (previousRef && previousRef !== currentRef && APP_REPO) {
                        entry.compareUrl = `https://github.com/${APP_REPO}/compare/${previousRef}...${entry.dep.sha}`;
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

            resolvedRecords.push(buildRecord(entry, COMPONENT, relatedIssues, APP_REPO, promotedVersion, issueCommitTypes, currentRef));
        }

        console.log(
            `Checked ${deployments.length} deployment(s) for component "${COMPONENT}" from ${APP_REPO}, ` +
            `${newDeployments.length} new.`
        );

        return resolvedRecords;
    });

    // Guards the rarer case of a second, concurrent run *for this same component* already having pushed
    // some of these same new deployment IDs while this run was retrying — the cache above only protects
    // against re-fetching, not against double-adding, so re-check against the freshly re-read `live` here.
    const existingIds = new Set(existingForComponent.map(d => d.id));
    const freshRecords = records.filter(r => !existingIds.has(r.id));

    const componentRecords = [...existingForComponent, ...freshRecords];
    const latestByEnv = latestSuccessfulByEnv(componentRecords);
    const drift = await computeEnvDrift(latestByEnv);

    for (const env of Object.keys(latestByEnv)) {
        if (drift[env]) {
            latestByEnv[env].driftBehind = drift[env];
        } else {
            delete latestByEnv[env].driftBehind;
        }
    }

    const merged = [...otherComponents, ...componentRecords];

    fs.writeFileSync(DATA_PATH, JSON.stringify(merged, null, 2) + '\n');
    console.log(
        `Component "${COMPONENT}": ${freshRecords.length} deployment record(s) recorded this run` +
        (records.length !== freshRecords.length
            ? ` (${records.length - freshRecords.length} already present from a concurrent run, skipped).`
            : '.')
    );
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
    buildDeploymentPlan,
    buildRecord,
    seedLastResolvedRefByEnv,
};

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}