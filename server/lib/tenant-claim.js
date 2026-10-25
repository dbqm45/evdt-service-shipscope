// Spreading the worker's syncs over several instances (ROADMAP, Niezawodność: worker scaling). A pass no longer runs
// under one lock for everyone: each tenant is claimed on its own with a session advisory lock keyed by the job and
// the tenant, so two worker instances (or two tenants in one instance, WORKER_CONCURRENCY) work side by side and never
// on the same tenant at once. A tenant another instance holds is skipped for this pass; the caller re-reads what is
// due once it holds the claim, so a tenant finished elsewhere a moment ago is not synced twice.
//
// Two-key advisory locks (job class, hash of the tenant id) live in a key space apart from the single-key locks of
// worker.js; a hash collision only means two tenants never run at the same moment.

/** One lock class per job that is spread over instances. */
const CLAIM_CLASS = { deployments: 727_101, jira: 727_102, flags: 727_103 };
const MAX_CONCURRENCY = 8;

/**
 * Runs `fn` while holding the tenant's claim for `job`, on a connection of its own; `{ claimed: false }` when another
 * session holds it.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {{ job: 'deployments'|'jira'|'flags', tenantId: string }} input
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ claimed: false }|{ claimed: true, result: T }>}
 */
async function withTenantClaim(pool, { job, tenantId }, fn) {
    const classId = CLAIM_CLASS[job];
    if (!classId) throw new Error(`No claim class for ${job}`);
    const client = await pool.connect();
    try {
        const { rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked', [classId, tenantId]);
        if (!locked) return { claimed: false };
        try {
            return { claimed: true, result: await fn() };
        } finally {
            await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [classId, tenantId]);
        }
    } finally {
        client.release();
    }
}

/**
 * Runs `fn` over `items` in order, at most `concurrency` at a time; resolves when all are done. `fn` handles its own
 * errors: one that throws stops nothing else, and the first error is rethrown at the end.
 *
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function eachLimited(items, concurrency, fn) {
    let next = 0;
    let firstError = null;
    const lane = async () => {
        while (next < items.length) {
            const item = items[next];
            next += 1;
            try {
                await fn(item);
            } catch (err) {
                firstError = firstError || err;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
    if (firstError) throw firstError;
}

/**
 * WORKER_CONCURRENCY: how many tenants one worker instance syncs at a time per job, 1-8 (default 1).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 * @throws {Error}
 */
function workerConcurrency(env) {
    if (env.WORKER_CONCURRENCY === undefined || env.WORKER_CONCURRENCY === '') return 1;
    const value = Number(env.WORKER_CONCURRENCY);
    if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) throw new Error(`WORKER_CONCURRENCY must be a whole number, 1-${MAX_CONCURRENCY}`);
    return value;
}

/**
 * Wraps a fetch so that at most `max` requests to one host are in flight at a time (in this process); the rest wait
 * their turn. For customers' endpoints: several tenants polled side by side may share a host.
 *
 * @param {Function} fetchImpl `(url, init) => Promise`
 * @param {number} max
 * @returns {Function}
 */
function limitPerHost(fetchImpl, max) {
    const hosts = new Map(); // host -> { active, waiting: Function[] }
    return async (url, init) => {
        let host;
        try {
            host = new URL(String(url)).host;
        } catch {
            return fetchImpl(url, init);
        }
        const slot = hosts.get(host) || { active: 0, waiting: [] };
        hosts.set(host, slot);
        if (slot.active >= max) await new Promise((resolve) => slot.waiting.push(resolve));
        slot.active += 1;
        try {
            return await fetchImpl(url, init);
        } finally {
            slot.active -= 1;
            const wake = slot.waiting.shift();
            if (wake) wake();
            else if (!slot.active) hosts.delete(host);
        }
    };
}

module.exports = { CLAIM_CLASS, MAX_CONCURRENCY, withTenantClaim, eachLimited, workerConcurrency, limitPerHost };
