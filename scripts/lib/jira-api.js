const RATE_LIMIT_MAX_ATTEMPTS = 4;
const RATE_LIMIT_MAX_DELAY_MS = 10 * 60_000;
const RATE_LIMIT_DEFAULT_DELAY_MS = 30_000;

/**
 * Drop-in replacement for `fetch()` that transparently retries a `429` by sleeping for whatever
 * `Retry-After` (seconds) says, or 30s if that header is missing, before trying again — returns a
 * `Response` either way (even a non-ok, non-429 one), so every existing call site's own `res.ok`/`res.status`
 * handling keeps working unchanged. Found and fixed as a real gap: none of sync-jira.js's 7 direct `fetch()`
 * call sites against the Jira API had any rate-limit handling at all, unlike sync-github-deployments.js's
 * own githubApi() — a 429 just surfaced as a normal non-ok response (thrown or warned-and-degraded
 * depending on the call site), with no chance to recover within the same run.
 */
async function fetchWithRetry(url, options = {}) {
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
        const res = await fetch(url, options);

        if (res.status !== 429 || attempt === RATE_LIMIT_MAX_ATTEMPTS) {
            return res;
        }

        const retryAfterSec = Number(res.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, RATE_LIMIT_MAX_DELAY_MS)
            : RATE_LIMIT_DEFAULT_DELAY_MS;

        console.warn(
            `Rate limited (429) on ${url}; waiting ${Math.ceil(delayMs / 1000)}s before retry ${attempt + 1}/${RATE_LIMIT_MAX_ATTEMPTS}.`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
}

module.exports = { fetchWithRetry };