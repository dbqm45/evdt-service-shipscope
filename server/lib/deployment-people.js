const { githubGet } = require('./github-app');

/**
 * Who started a deployment and how, ported from the file-based sync (resolveManualFlag, resolveDisplayName). Both are display-only extras: every lookup degrades to
 * null on any error and never fails the sync. Results are cached per sync pass (`caches`), so a run that
 * triggered several deploys, or a person behind many, costs one call.
 */

// At most this many /actions/runs lookups per repo per pass: a large backlog shouldn't spend the
// installation's rate limit on a badge (same cap idea as MAX_MANUAL_LOOKUPS_PER_RUN in the file-based sync).
const MAX_RUN_LOOKUPS = 30;
// A GitHub login: alphanumerics and single hyphens, max 39 chars. Anything else (e.g. "dependabot[bot]") is not
// looked up, which also keeps unexpected input out of the request path.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** @returns {{ runs: Map<string, boolean|null>, names: Map<string, string|null> }} */
function createCaches() {
    return { runs: new Map(), names: new Map() };
}

/** The Actions run id in a deployment status's log URL, or null. */
function runIdOf(workflowRunUrl) {
    const match = /\/actions\/runs\/(\d+)/.exec(workflowRunUrl || '');
    return match ? match[1] : null;
}

/**
 * Whether the deploy's Actions run was started by hand. Needs the App's "Actions: read" permission; without it
 * GitHub answers 403 and this is null.
 *
 * @param {{ token: string, fullName: string, workflowRunUrl: string|null, caches: ReturnType<typeof createCaches>, budget: { runs: number }, fetch?: typeof fetch }} input
 * @returns {Promise<boolean|null>}
 */
async function resolveManual({ token, fullName, workflowRunUrl, caches, budget, fetch: fetchFn = fetch }) {
    const runId = runIdOf(workflowRunUrl);
    if (!runId) return null;
    const key = `${fullName}#${runId}`;
    if (caches.runs.has(key)) return caches.runs.get(key);
    if (budget.runs <= 0) return null;
    budget.runs -= 1;
    let manual = null;
    try {
        const run = await githubGet({ token, path: `/repos/${fullName}/actions/runs/${runId}`, fetch: fetchFn });
        if (typeof run?.event === 'string') manual = run.event === 'workflow_dispatch';
    } catch {
        // Display-only: unknown, not an error.
    }
    caches.runs.set(key, manual);
    return manual;
}

/**
 * The public display name ("Imię Nazwisko") behind a login, or null.
 *
 * @param {{ token: string, login: string|null, caches: ReturnType<typeof createCaches>, fetch?: typeof fetch }} input
 * @returns {Promise<string|null>}
 */
async function resolveDisplayName({ token, login, caches, fetch: fetchFn = fetch }) {
    if (!login || !GITHUB_LOGIN.test(login)) return null;
    if (caches.names.has(login)) return caches.names.get(login);
    let name = null;
    try {
        const user = await githubGet({ token, path: `/users/${login}`, fetch: fetchFn });
        if (typeof user?.name === 'string' && user.name.trim()) name = user.name.trim().slice(0, 200);
    } catch {
        // Display-only: fall back to the login.
    }
    caches.names.set(login, name);
    return name;
}

module.exports = { MAX_RUN_LOOKUPS, createCaches, resolveManual, resolveDisplayName };
