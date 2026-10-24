// A per-key token bucket, in memory, for routes callers reach without a session (the flags ingest). One web
// process holds the buckets: with several instances each enforces its own limit, which still bounds what one
// key can do. Pure apart from the clock passed in; tested in test/request-limiter.test.js.

/**
 * @param {{ capacity: number, refillPerSecond: number, maxKeys?: number }} options burst size, sustained rate,
 *   and how many keys to remember (the longest unused are dropped first, so memory stays bounded)
 * @returns {{ take: (key: string, nowMs?: number) => { ok: boolean, retryAfterSeconds: number } }}
 */
function createLimiter({ capacity, refillPerSecond, maxKeys = 10_000 }) {
    if (!(capacity >= 1) || !(refillPerSecond > 0)) throw new Error('capacity >= 1 and refillPerSecond > 0 are required');
    // Map keeps insertion order: a key is re-inserted on use, so the first entry is the longest unused.
    const buckets = new Map();

    function take(key, nowMs = Date.now()) {
        const known = buckets.get(key);
        let tokens = capacity;
        if (known) {
            buckets.delete(key);
            tokens = Math.min(capacity, known.tokens + ((nowMs - known.at) / 1000) * refillPerSecond);
        } else if (buckets.size >= maxKeys) {
            buckets.delete(buckets.keys().next().value);
        }
        const ok = tokens >= 1;
        if (ok) tokens -= 1;
        buckets.set(key, { tokens, at: nowMs });
        return { ok, retryAfterSeconds: ok ? 0 : Math.ceil((1 - tokens) / refillPerSecond) };
    }

    return { take };
}

module.exports = { createLimiter };
