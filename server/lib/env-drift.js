const { githubGet } = require('./github-app');
const { diffTrees } = require('./tree-diff');

/**
 * Environment drift, ported from scripts/sync-github-deployments.js (computeEnvDrift/compareTrees; see
 * CLAUDE.md, "Deployments" -> `driftBehind`). For each stage after the first (qa vs test, prod vs qa), the
 * latest successful deploys are compared:
 * - commit counts (`behindEnv`/`commitCount`, `untestedIn`/`untestedCommitCount`) are raw git history, context
 *   only -- separate deployment branches create new commits for identical code;
 * - the git trees decide: the same tree, or trees differing only in ignored paths, means no drift; otherwise
 *   `diff: { files, paths, ignored }`, or `diff: { unknown: true }` when the trees couldn't be compared --
 *   never "no difference" for a comparison that didn't happen.
 */

const ENV_ORDER = ['test', 'qa', 'prod'];

/**
 * @returns {Promise<{ same: true }|{ same: false, diff: object|null }|null>} null when the comparison failed
 */
async function compareTrees({ token, fullName, refA, refB, ignorePatterns, fetch: fetchFn }) {
    try {
        const [a, b] = await Promise.all([
            githubGet({ token, path: `/repos/${fullName}/commits/${encodeURIComponent(refA)}`, fetch: fetchFn }),
            githubGet({ token, path: `/repos/${fullName}/commits/${encodeURIComponent(refB)}`, fetch: fetchFn }),
        ]);
        const shaA = a?.commit?.tree?.sha;
        const shaB = b?.commit?.tree?.sha;
        if (typeof shaA !== 'string' || typeof shaB !== 'string') return null;
        if (shaA === shaB) return { same: true };
        const [treeA, treeB] = await Promise.all([
            githubGet({ token, path: `/repos/${fullName}/git/trees/${shaA}?recursive=1`, fetch: fetchFn }),
            githubGet({ token, path: `/repos/${fullName}/git/trees/${shaB}?recursive=1`, fetch: fetchFn }),
        ]);
        return { same: false, diff: diffTrees(treeA, treeB, ignorePatterns) };
    } catch {
        return null;
    }
}

/**
 * @param {{ token: string, fullName: string, latestByEnv: Record<string, { ref: string, version: string|null }>, ignorePatterns: string[], fetch?: typeof fetch }} input
 * @returns {Promise<{ envs: Record<string, object>, failed: string[] }>} drift per later environment; `failed`
 *   lists environments whose comparison errored (their previous value should be kept, not cleared)
 */
async function computeEnvDrift({ token, fullName, latestByEnv, ignorePatterns, fetch: fetchFn = fetch }) {
    const envs = {};
    const failed = [];
    for (let i = 1; i < ENV_ORDER.length; i++) {
        const laterEnv = ENV_ORDER[i];
        const earlierEnv = ENV_ORDER[i - 1];
        const later = latestByEnv[laterEnv];
        const earlier = latestByEnv[earlierEnv];
        if (!later || !earlier || later.ref === earlier.ref) continue;

        let comparison;
        try {
            comparison = await githubGet({
                token,
                path: `/repos/${fullName}/compare/${encodeURIComponent(later.ref)}...${encodeURIComponent(earlier.ref)}`,
                fetch: fetchFn,
            });
        } catch {
            failed.push(laterEnv);
            continue;
        }
        const entry = {};
        if (comparison?.ahead_by > 0) Object.assign(entry, { behindEnv: earlierEnv, commitCount: comparison.ahead_by });
        // behind_by: commits the later stage has that the earlier one never saw -- a hotfix or direct deploy
        // that skipped the normal test -> qa -> prod promotion.
        if (comparison?.behind_by > 0) Object.assign(entry, { untestedIn: earlierEnv, untestedCommitCount: comparison.behind_by });
        if (!Object.keys(entry).length) continue;

        const trees = await compareTrees({ token, fullName, refA: later.ref, refB: earlier.ref, ignorePatterns, fetch: fetchFn });
        if (trees && trees.same) continue;
        if (trees && trees.diff) {
            if (trees.diff.files === 0) continue;
            entry.diff = trees.diff;
        } else {
            entry.diff = { unknown: true };
        }
        // The same displayed label on two different commits: two builds of "the same" version, not promotion lag.
        if (later.version && later.version === earlier.version) entry.sameVersion = true;
        envs[laterEnv] = entry;
    }
    return { envs, failed };
}

module.exports = { ENV_ORDER, computeEnvDrift };
