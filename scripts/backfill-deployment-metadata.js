const fs = require('fs');
const path = require('path');
const { fail, safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');
const { resolveDisplayName } = require('./lib/github-users');
const { githubApiGet } = require('./lib/github-api');
const { GITHUB_TOKEN, APP_REPO, COMPONENT } = process.env;

const DATA_PATH = safeRelativePath(process.env.DATA_PATH || 'docs/data/deployments.json', 'DATA_PATH');
const MAX_RECORDS_PER_RUN = Number(process.env.MAX_RECORDS_PER_RUN || 500);

if (!GITHUB_TOKEN) {
    fail('Missing GITHUB_TOKEN');
}
if (!APP_REPO) {
    fail('Missing APP_REPO (e.g. "myorg/evapl-service-frontend")');
}
if (!COMPONENT) {
    fail('Missing COMPONENT (e.g. "evapl-service-frontend")');
}

// Found and fixed as a real bug: this used to be a bare fetch with no rate-limit handling at all, unlike
// sync-github-deployments.js's own githubApi() — a backfill run (per-record /commits calls capped at
// MAX_RECORDS_PER_RUN, on top of statuses/compare/display-name lookups) is exactly the kind of bursty,
// high-volume caller most likely to actually hit a GitHub primary/secondary rate limit, and used to just
// crash the whole run instead of waiting it out like the sync script already does.
async function githubApi(pathSuffix) {
    return githubApiGet(`https://api.github.com/repos/${APP_REPO}${pathSuffix}`, GITHUB_TOKEN);
}

async function githubApiAllPages(basePathWithQuery) {
    const sep = basePathWithQuery.includes('?') ? '&' : '?';
    let page = 1;
    let all = [];

    while (true) {
        const pageResults = await githubApi(`${basePathWithQuery}${sep}page=${page}`);

        if (!pageResults.length) break;

        all = all.concat(pageResults);

        if (pageResults.length < 100) break;

        page += 1;
    }

    return all;
}

function extractPromotedVersion(commitMessage) {
    const match = (commitMessage || '').match(/\bv?\d+\.\d+\.\d+\b/);

    return match ? match[0] : null;
}

function looksLikeRawSha(version) {
    return /^[0-9a-f]{7,40}$/i.test(version || '');
}

function extractRunId(logUrl) {
    const match = (logUrl || '').match(/\/actions\/runs\/(\d+)/);

    return match ? match[1] : null;
}

function extractShaFromLink(url) {
    const match = (url || '').match(/([0-9a-f]{7,40})$/i);

    return match ? match[1] : null;
}

const TERMINAL_STATES = new Set(['success', 'failure', 'error']);

// Must stay in sync with sync-github-deployments.js's own buildDeploymentPlan: GitHub appends `inactive`
// to a deployment's *own* status history whenever a later deployment on the same environment succeeds
// (`auto_inactive`), so the newest entry in the list isn't necessarily this deployment's real outcome.
// Found and fixed as a real bug: this copy used to take `statuses[0]` (whatever's newest) instead of the
// first *terminal* entry, reintroducing the exact bug the sync script already fixed.
function firstTerminalStatus(statuses) {
    return (statuses || []).find(s => TERMINAL_STATES.has(s.state)) || null;
}

// Must stay in sync with sync-github-deployments.js's own computeDeployDurationMs: GitHub appends
// `inactive` to a deployment's *own* status history whenever a *later* deployment on the same environment
// succeeds (`auto_inactive`) — not part of this deployment's own lifecycle, so including it inflates
// `durationMs` to "however long until some unrelated future deploy happened." Found and fixed as a real
// bug: this copy was missing the filter the sync script already has, and since backfill specifically
// targets *older* records (more likely to have since accumulated an `inactive` marker from a later
// deploy), it was computing inflated durations for exactly the records most likely to need fixing.
function computeDeployDurationMs(statuses) {
    const lifecycle = (statuses || []).filter(s => s.state !== 'inactive');

    if (lifecycle.length < 2) return null;

    const times = lifecycle.map(s => new Date(s.created_at).getTime());

    return Math.max(...times) - Math.min(...times);
}

async function resolveManualFlag(logUrl, runEventCache) {
    const runId = extractRunId(logUrl);

    if (!runId) return null;

    if (runEventCache.has(runId)) {
        return runEventCache.get(runId);
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

function buildPerEnvSuccessChronology(componentRecords) {
    const perEnv = {};

    componentRecords
        .filter(d => d.status === 'success')
        .sort((a, b) => new Date(a.deployedAt) - new Date(b.deployedAt))
        .forEach(d => {
            (perEnv[d.environment] = perEnv[d.environment] || []).push(d);
        });

    return perEnv;
}

function previousShaFor(rec, perEnvChron) {
    const chron = perEnvChron[rec.environment] || [];
    const priors = chron.filter(r => new Date(r.deployedAt).getTime() < new Date(rec.deployedAt).getTime());

    for (let i = priors.length - 1; i >= 0; i--) {
        const sha = extractShaFromLink(priors[i].commitUrl);

        if (sha) return sha;
    }

    return null;
}

function backfillCompareLinks(componentRecords) {
    const perEnvChron = buildPerEnvSuccessChronology(componentRecords);
    let upgraded = 0;

    for (const rec of componentRecords) {
        if ((rec.commitUrl || '').includes('/compare/')) continue;

        const currentSha = extractShaFromLink(rec.commitUrl);
        const previousSha = previousShaFor(rec, perEnvChron);

        if (currentSha && previousSha && previousSha !== currentSha) {
            rec.commitUrl = `https://github.com/${APP_REPO}/compare/${previousSha}...${currentSha}`;
            upgraded += 1;
        }
    }

    return upgraded;
}

/**
 * Fixes the specific gap sync-github-deployments.js's `lastResolvedRangeByEnv` cache now prevents going
 * forward: GitHub can fire more than one deployment/status entry for the same commit on the same
 * env/component (e.g. a squash-merged release re-notified by a second workflow job a few minutes later).
 * Before that fix, a later record resolving to the same ref compared it against itself, collapsing to an
 * empty range — a single-commit `commitUrl` instead of a compare range, no `relatedIssues` — even though
 * an earlier sibling record for that exact resolvedRef/version on the same env already resolved the real
 * one. Finds, per environment, runs of consecutive-by-`deployedAt` successful records that share the same
 * resolved ref (`resolvedRef || version`) and copies whichever compareUrl/relatedIssues/issueCommitTypes/
 * rollback the earliest "donor" in that run already has onto every other member still showing the
 * single-commit fallback. Free — every answer needed is already sitting somewhere on disk, no GitHub API
 * calls, so this always runs in full regardless of `MAX_RECORDS_PER_RUN`.
 */
function backfillDuplicateReleaseGaps(componentRecords) {
    const perEnvChron = buildPerEnvSuccessChronology(componentRecords);
    let fixed = 0;

    for (const chron of Object.values(perEnvChron)) {
        let i = 0;

        while (i < chron.length) {
            const ref = chron[i].resolvedRef || chron[i].version;
            let j = i + 1;

            while (j < chron.length && (chron[j].resolvedRef || chron[j].version) === ref) {
                j += 1;
            }

            if (j - i > 1) {
                const group = chron.slice(i, j);
                const donor = group.find(r => (r.commitUrl || '').includes('/compare/')) || null;

                if (donor) {
                    group.forEach(rec => {
                        if (rec === donor || (rec.commitUrl || '').includes('/compare/')) {
                            return;
                        }

                        rec.commitUrl = donor.commitUrl;
                        rec.relatedIssues = donor.relatedIssues || [];
                        rec.issueCommitTypes = donor.issueCommitTypes || {};

                        if (donor.rollback) {
                            rec.rollback = donor.rollback;
                        }

                        fixed += 1;
                    });
                }
            }

            i = j;
        }
    }

    return fixed;
}

/**
 * Same rollback signal as sync-github-deployments.js: a GitHub compare between this record's commit
 * and the previous successful deploy on that env coming back `status: "behind"` means this commit is
 * an ancestor of what was already live — a rollback. Always sets `rollback` (even to `null`) so a
 * record is never re-checked once processed, same idempotent-once pattern as `manual`.
 */
async function backfillRollbacks(componentRecords) {
    const pending = componentRecords.filter(rec => !('rollback' in rec));
    const perEnvChron = buildPerEnvSuccessChronology(componentRecords);
    const batch = pending.slice(0, MAX_RECORDS_PER_RUN);
    let flagged = 0;

    for (const rec of batch) {
        const currentSha = extractShaFromLink(rec.commitUrl);
        const previousSha = previousShaFor(rec, perEnvChron);

        rec.rollback = null;

        if (!currentSha || !previousSha || previousSha === currentSha) continue;

        try {
            const comparison = await githubApi(`/compare/${previousSha}...${currentSha}`);

            if (comparison.status === 'behind') {
                rec.rollback = { toRef: currentSha }; // the ref the environment went back to
                flagged += 1;
            }
        } catch (e) {
            console.warn(`Warning: could not check rollback status for deployment ${rec.id}: ${e.message}`);
        }
    }

    return { checked: batch.length, flagged, remaining: pending.length - batch.length };
}

async function backfillRunMetadata(componentRecords) {
    const pending = componentRecords.filter(d => !('manual' in d));
    const batch = pending.slice(0, MAX_RECORDS_PER_RUN);
    const runEventCache = new Map();

    for (const rec of batch) {
        const depId = String(rec.id).replace(/^gh-/, '');

        try {
            const statuses = await githubApi(`/deployments/${depId}/statuses?per_page=10`);
            const latest = firstTerminalStatus(statuses);

            rec.workflowRunUrl = latest ? (latest.log_url || null) : null;
            rec.durationMs = computeDeployDurationMs(statuses);

            const manual = latest ? await resolveManualFlag(rec.workflowRunUrl, runEventCache) : null;

            rec.manual = manual === true;
        } catch (e) {
            console.warn(`Warning: could not backfill run metadata for deployment ${rec.id}: ${e.message}`);
            rec.workflowRunUrl = rec.workflowRunUrl || null;
            rec.durationMs = rec.durationMs || null;
            rec.manual = rec.manual === true;
        }
    }

    return { resolved: batch.length, remaining: pending.length - batch.length };
}

/**
 * Re-resolves `version` for records that currently only show a raw SHA, using the same priority as
 * sync-github-deployments.js: a GitHub Release on that commit, then a plain tag, then a version-like
 * substring in the commit message — checked in that order, cheapest/most-authoritative first.
 */
async function backfillVersions(componentRecords) {
    const pending = componentRecords.filter(rec => looksLikeRawSha(rec.version));

    if (!pending.length) {
        return { resolved: 0, remaining: 0 };
    }

    const tags = await githubApiAllPages('/tags?per_page=100');
    const shaToTag = new Map(tags.map(t => [t.commit.sha, t.name]));

    const releases = await githubApiAllPages('/releases?per_page=100');
    const tagNameToSha = new Map(tags.map(t => [t.name, t.commit.sha]));
    const shaToRelease = new Map(
        releases
            .map(r => [tagNameToSha.get(r.tag_name), r.tag_name])
            .filter(([sha]) => sha)
    );

    const batch = pending.slice(0, MAX_RECORDS_PER_RUN);
    let resolvedCount = 0;

    for (const rec of batch) {
        const sha = extractShaFromLink(rec.commitUrl);

        if (!sha) continue;

        // Same split as sync-github-deployments.js's own promotedVersion/currentRef: a verified
        // release/tag is both a safe *display* string and a safe `/compare` ref, but a free-text
        // regex match out of the commit message is display-only — resolvedRef must fall back to the
        // sha, not the regex match, or a later sync's seedLastResolvedRefByEnv() would compare against
        // an unverified ref string. Found and fixed as a real bug: this used to only ever set
        // `version`, never `resolvedRef`, so a backfilled regex-matched version silently became the
        // next sync's compare ref — exactly the bug sync-github-deployments.js itself already fixed.
        const verifiedRef = shaToRelease.get(sha) || shaToTag.get(sha) || null;
        let resolved = verifiedRef;

        if (!resolved) {
            try {
                const commit = await githubApi(`/commits/${sha}`);

                resolved = extractPromotedVersion(commit.commit?.message || '');
            } catch (e) {
                console.warn(`Warning: could not backfill version for deployment ${rec.id}: ${e.message}`);
            }
        }

        if (resolved) {
            rec.version = resolved;
            rec.resolvedRef = verifiedRef || sha;
            resolvedCount += 1;
        }
    }

    return { resolved: resolvedCount, remaining: pending.length - batch.length };
}

/**
 * Records created before `deployedByLogin` existed stored the raw GitHub login directly in `deployedBy`.
 * Targets those (`!('deployedByLogin' in rec)`, same idempotent-once pattern as `manual`/`rollback`),
 * preserves the login in the new field, and upgrades `deployedBy` to the user's public display name when
 * GitHub has one on file — falling back to leaving the login in place otherwise.
 */
async function backfillDeployedByNames(componentRecords) {
    const pending = componentRecords.filter(rec => !('deployedByLogin' in rec));
    const batch = pending.slice(0, MAX_RECORDS_PER_RUN);
    const nameCache = new Map();
    let resolved = 0;

    for (const rec of batch) {
        const login = rec.deployedBy && rec.deployedBy !== 'unknown' ? rec.deployedBy : null;

        rec.deployedByLogin = login;

        if (!login) continue;

        const displayName = await resolveDisplayName(login, GITHUB_TOKEN, nameCache);

        if (displayName) {
            rec.deployedBy = displayName;
            resolved += 1;
        }
    }

    return { resolved, checked: batch.length, remaining: pending.length - batch.length };
}

async function main() {
    if (!fs.existsSync(DATA_PATH)) {
        fail(`${DATA_PATH} does not exist — nothing to backfill.`);
    }

    const existing = readJson(DATA_PATH);
    const componentRecords = existing.filter(d => d.component === COMPONENT);

    if (!componentRecords.length) {
        console.log(`No deployment records found for component "${COMPONENT}" — nothing to backfill.`);
        return;
    }

    // Free: derived from data already on disk, no GitHub API calls needed. Runs before backfillCompareLinks
    // so a duplicate-release record's real relatedIssues (from its earlier, correctly-resolved sibling) win
    // over that more general "upgrade to a compare link" pass, which would otherwise leave it alone anyway
    // (its own immediate predecessor's sha, from previousShaFor(), is identical to its own).
    const duplicateReleaseGapsFixed = backfillDuplicateReleaseGaps(componentRecords);

    // Free: derived from data already on disk, no GitHub API calls needed.
    const compareLinksUpgraded = backfillCompareLinks(componentRecords);

    // Costly: one GitHub API call per deployment (+ one per distinct workflow run), capped per run.
    const { resolved, remaining } = await backfillRunMetadata(componentRecords);

    // Costly-ish: 2 list calls total (tags + releases) regardless of batch size, then at most one
    // /commits call per record that isn't resolved by a release/tag hit. Capped per run.
    const { resolved: versionsResolved, remaining: versionsRemaining } = await backfillVersions(componentRecords);

    // Costly: one compare call per deployment, capped per run.
    const { checked: rollbacksChecked, flagged: rollbacksFlagged, remaining: rollbacksRemaining } =
        await backfillRollbacks(componentRecords);

    // Costly: one /users call per distinct login, capped per run by records (not logins).
    const { resolved: namesResolved, remaining: namesRemaining } = await backfillDeployedByNames(componentRecords);

    writeJson(DATA_PATH, existing);

    console.log(
        `Component "${COMPONENT}": fixed ${duplicateReleaseGapsFixed} duplicate-release gap(s), ` +
        `upgraded ${compareLinksUpgraded} link(s) to commit ranges, ` +
        `resolved run metadata for ${resolved} deployment(s), resolved version for ${versionsResolved} deployment(s), ` +
        `checked rollback status for ${rollbacksChecked} deployment(s) (${rollbacksFlagged} flagged as rollbacks), ` +
        `resolved display name for ${namesResolved} deployment(s).` +
        (remaining > 0 ? ` ${remaining} run-metadata deployment(s) still pending.` : '') +
        (versionsRemaining > 0 ? ` ${versionsRemaining} version deployment(s) still pending.` : '') +
        (rollbacksRemaining > 0 ? ` ${rollbacksRemaining} rollback-check deployment(s) still pending.` : '') +
        (namesRemaining > 0 ? ` ${namesRemaining} display-name deployment(s) still pending.` : '') +
        (remaining > 0 || versionsRemaining > 0 || rollbacksRemaining > 0 || namesRemaining > 0 ? ' Rerun to continue.' : '')
    );
}

module.exports = {
    extractRunId,
    extractShaFromLink,
    extractPromotedVersion,
    looksLikeRawSha,
    computeDeployDurationMs,
    buildPerEnvSuccessChronology,
    previousShaFor,
    backfillCompareLinks,
    backfillDuplicateReleaseGaps,
};

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
