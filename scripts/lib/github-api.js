const RATE_LIMIT_MAX_ATTEMPTS = 4;
const RATE_LIMIT_MAX_DELAY_MS = 10 * 60_000;

/**
 * Call a GitHub REST API URL, retrying on a primary (429, or 403 with `x-ratelimit-remaining: 0`) or
 * secondary (403 with a `retry-after` header — GitHub's secondary limit has its own, separate counter,
 * so `x-ratelimit-remaining` can still read non-zero on a secondary-limited response) rate limit, by
 * sleeping until `retry-after` (if present), else `x-ratelimit-reset`, else 30s, before trying again. Any
 * other non-2xx status throws immediately — this is the one shared place that distinguishes "wait and
 * retry" from "fail the run," so every GitHub API caller in this repo gets the same behavior instead of
 * each one needing to reimplement it (or, as `backfill-deployment-metadata.js` found and fixed as a real
 * bug, silently not implementing it at all). `options` is passed straight through to `fetch`
 * (method/body/etc.) for non-GET callers.
 *
 * `etagCache` (optional, caller-owned plain object keyed by URL -> `{ etag, body }`) opts a GET call into
 * conditional requests: if a cached ETag exists for this exact URL, it's sent as `If-None-Match`, and a
 * `304` response (GitHub's confirmation that nothing changed since that ETag was issued) returns the
 * cached body instead of re-fetching — critically, a `304` does **not** count against the rate limit the
 * way a real `200` does. This only pays off for a URL that's re-fetched across separate runs with the
 * cache persisted in between (see `sync-github-deployments.js`'s `ETAG_CACHE_PATH` and the
 * `actions/cache` step wired around it in `orchestrate-full-sync.yml`) — a URL only ever hit once per the
 * lifetime of this process (most per-deployment lookups below) gets no benefit from it and shouldn't be
 * passed a cache.
 */
async function githubApiRequest(url, token, options = {}, etagCache = null) {
    const canCache = Boolean(etagCache) && (!options.method || options.method === 'GET');
    const cached = canCache ? etagCache[url] : null;

    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
        const res = await fetch(url, {
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                ...(cached ? { 'If-None-Match': cached.etag } : {}),
                ...(options.headers || {}),
            },
        });

        if (res.status === 304 && cached) {
            return cached.body;
        }

        if (res.ok) {
            const body = res.status === 204 ? null : await res.json();

            if (canCache) {
                const etag = res.headers.get('etag');

                if (etag) {
                    etagCache[url] = { etag, body };
                } else {
                    delete etagCache[url];
                }
            }

            return body;
        }

        const body = await res.text();
        const retryAfterSec = Number(res.headers.get('retry-after'));
        const isRateLimited = res.status === 429
            || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
            || (res.status === 403 && Number.isFinite(retryAfterSec) && retryAfterSec > 0);

        if (!isRateLimited || attempt === RATE_LIMIT_MAX_ATTEMPTS) {
            throw new Error(`GitHub API error on ${url}: ${res.status} ${body}`);
        }

        const resetAtMs = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, RATE_LIMIT_MAX_DELAY_MS)
            : Number.isFinite(resetAtMs) && resetAtMs > 0
                ? Math.min(Math.max(resetAtMs - Date.now(), 1000), RATE_LIMIT_MAX_DELAY_MS)
                : 30_000;

        console.warn(
            `Rate limited on ${url}; waiting ${Math.ceil(delayMs / 1000)}s before retry ${attempt + 1}/${RATE_LIMIT_MAX_ATTEMPTS}.`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
}

async function githubApiGet(url, token, etagCache = null) {
    return githubApiRequest(url, token, {}, etagCache);
}

module.exports = { githubApiGet, githubApiRequest };