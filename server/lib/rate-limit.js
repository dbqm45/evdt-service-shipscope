/**
 * When to try again after GitHub or Atlassian said "too many requests". ShipScope pauses only the credential that got
 * the answer (a GitHub App installation -- GitHub's limits are per installation -- or a tenant's Atlassian connection)
 * and the sync pass moves on to the next tenant instead of waiting or hammering the API.
 *
 * Header precedence: `Retry-After` (seconds, or an HTTP date), then GitHub's `x-ratelimit-reset` (epoch seconds), then
 * `fallbackMs`. The result is clamped to [now + 1s, now + maxMs] so a malformed or hostile header can neither make the
 * worker retry at once nor park a tenant for days.
 */

const DEFAULT_FALLBACK_MS = 5 * 60_000;
const DEFAULT_MAX_MS = 3600_000;

/**
 * @param {{ get(name: string): string|null }} headers a fetch Response's headers
 * @param {{ now?: number, fallbackMs?: number, maxMs?: number }} [options]
 * @returns {Date}
 */
function retryAtFrom(headers, { now = Date.now(), fallbackMs = DEFAULT_FALLBACK_MS, maxMs = DEFAULT_MAX_MS } = {}) {
    let at = null;
    const retryAfter = headers.get('retry-after');
    if (retryAfter && /^\d{1,7}$/.test(retryAfter.trim())) at = now + Number(retryAfter.trim()) * 1000;
    else if (retryAfter && Number.isFinite(Date.parse(retryAfter))) at = Date.parse(retryAfter);
    if (at === null) {
        const reset = headers.get('x-ratelimit-reset');
        if (reset && /^\d{1,12}$/.test(reset.trim())) at = Number(reset.trim()) * 1000;
    }
    if (at === null) at = now + fallbackMs;
    return new Date(Math.min(Math.max(at, now + 1000), now + maxMs));
}

module.exports = { retryAtFrom };
