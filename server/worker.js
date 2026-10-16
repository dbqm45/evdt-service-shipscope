const { createPool, checkConnection } = require('./lib/db');
const { loadGitHubAppConfig, loadAtlassianConfig } = require('./lib/config');
const { syncAllJira } = require('./lib/jira-sync');
const { syncAll } = require('./lib/deployment-sync');
const { cleanupAll } = require('./lib/retention');
const { pendingSyncRequests, finishSyncRequests } = require('./lib/webhooks');

const HEARTBEAT_INTERVAL_MS = 30_000;
const WEBHOOK_INTERVAL_MS = 30_000; // how often webhook-requested syncs are picked up
const CLEANUP_INTERVAL_MS = 24 * 3600_000;
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
// Postgres advisory lock keys: one sync and one cleanup at a time, even with more than one worker instance.
const SYNC_LOCK = 727_001;
const CLEANUP_LOCK = 727_002;
const JIRA_LOCK = 727_003;

const stamp = () => new Date().toISOString();

/**
 * One heartbeat tick: pings Postgres and logs the result. Extracted from the loop below so it's testable
 * without waiting on a real interval or a real database.
 */
async function heartbeatTick(pool, log = console.log) {
    try {
        const { latencyMs } = await checkConnection(pool);
        log(`${stamp()} heartbeat ok (db latency ${latencyMs}ms)`);
    } catch (err) {
        log(`${stamp()} heartbeat failed: ${err.message}`);
    }
}

/**
 * Runs fn while holding a Postgres session-level advisory lock; if another session holds it, skips.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {number} lockKey
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ skipped: true }|{ skipped: false, result: T }>}
 */
async function runExclusive(pool, lockKey, fn) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
        if (!rows[0].locked) return { skipped: true };
        try {
            return { skipped: false, result: await fn() };
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        }
    } finally {
        client.release();
    }
}

/** SYNC_INTERVAL_MINUTES: 1-1440, default 15. */
function syncIntervalMinutes(env) {
    if (env.SYNC_INTERVAL_MINUTES === undefined || env.SYNC_INTERVAL_MINUTES === '') return DEFAULT_SYNC_INTERVAL_MINUTES;
    const value = Number(env.SYNC_INTERVAL_MINUTES);
    if (!Number.isInteger(value) || value < 1 || value > 1440) throw new Error('SYNC_INTERVAL_MINUTES must be a whole number of minutes, 1-1440');
    return value;
}

/** One deployment sync pass (FR-005), never overlapping another. Errors are logged, never thrown. */
async function syncTick(pool, app, log = console.log, deps = { syncAll }) {
    try {
        const run = await runExclusive(pool, SYNC_LOCK, () => deps.syncAll({ pool, app, log: (m) => log(`${stamp()} ${m}`) }));
        if (run.skipped) log(`${stamp()} sync skipped: another run holds the lock`);
        else log(`${stamp()} sync done: ${run.result.repos} repos, +${run.result.inserted} deployments, ${run.result.failed} failed`);
    } catch (err) {
        log(`${stamp()} sync failed: ${err.message}`);
    }
}

/** One Jira issue sync pass (FR-009), never overlapping another. Errors are logged, never thrown. */
async function jiraTick(pool, atlassian, log = console.log, deps = { syncAllJira }) {
    try {
        const run = await runExclusive(pool, JIRA_LOCK, () => deps.syncAllJira({ pool, atlassian, log: (m) => log(`${stamp()} ${m}`) }));
        if (run.skipped) log(`${stamp()} jira sync skipped: another run holds the lock`);
        else log(`${stamp()} jira sync done: ${run.result.tenants} tenants, ${run.result.issues} issues, ${run.result.failed} failed`);
    } catch (err) {
        log(`${stamp()} jira sync failed: ${err.message}`);
    }
}

/**
 * Picks up what webhooks asked for (migration 013) and syncs just that: the named repos, the named Jira
 * connections. Under the same locks as the periodic syncs, so never alongside one; a request that couldn't run
 * (lock held, or the sync failed as a whole) stays queued for the next tick. Errors are logged, never thrown.
 */
async function webhookTick(pool, { app, atlassian }, log = console.log, deps = { syncAll, syncAllJira }) {
    const sources = [
        app && ['github', SYNC_LOCK, (requests) => deps.syncAll({ pool, app, log: (m) => log(`${stamp()} ${m}`), repoIds: requests.map((r) => Number(r.key)).filter(Number.isSafeInteger) })],
        atlassian && ['jira', JIRA_LOCK, (requests) => deps.syncAllJira({ pool, atlassian, log: (m) => log(`${stamp()} ${m}`), keys: requests.map((r) => r.key) })],
    ].filter(Boolean);
    for (const [source, lock, sync] of sources) {
        try {
            const requests = await pendingSyncRequests(pool, source);
            if (!requests.length) continue;
            const run = await runExclusive(pool, lock, () => sync(requests));
            if (run.skipped) continue;
            await finishSyncRequests(pool, source, requests);
            log(`${stamp()} ${source} webhook sync done: ${requests.length} request(s)`);
        } catch (err) {
            log(`${stamp()} ${source} webhook sync failed: ${err.message}`);
        }
    }
}

/** The daily retention cleanup, never overlapping another. Errors are logged, never thrown. */
async function cleanupTick(pool, log = console.log, deps = { cleanupAll }) {
    try {
        const run = await runExclusive(pool, CLEANUP_LOCK, () => deps.cleanupAll(pool));
        if (!run.skipped) log(`${stamp()} cleanup done: ${run.result} old deployment records deleted`);
    } catch (err) {
        log(`${stamp()} cleanup failed: ${err.message}`);
    }
}

if (require.main === module) {
    const app = loadGitHubAppConfig(process.env);
    const syncMinutes = syncIntervalMinutes(process.env);
    const pool = createPool();
    const timers = [setInterval(() => heartbeatTick(pool), HEARTBEAT_INTERVAL_MS)];
    heartbeatTick(pool);

    if (app) {
        timers.push(setInterval(() => syncTick(pool, app), syncMinutes * 60_000));
        syncTick(pool, app);
    } else {
        console.log(`${stamp()} GITHUB_APP_* not set: deployment sync is off`);
    }
    const atlassian = loadAtlassianConfig(process.env);
    if (atlassian) {
        timers.push(setInterval(() => jiraTick(pool, atlassian), syncMinutes * 60_000));
        jiraTick(pool, atlassian);
    } else {
        console.log(`${stamp()} ATLASSIAN_* not set: Jira sync is off`);
    }
    if (app || atlassian) timers.push(setInterval(() => webhookTick(pool, { app, atlassian }), WEBHOOK_INTERVAL_MS));
    timers.push(setInterval(() => cleanupTick(pool), CLEANUP_INTERVAL_MS));
    cleanupTick(pool);

    process.on('SIGTERM', () => {
        timers.forEach(clearInterval);
        pool.end(() => process.exit(0));
    });
}

module.exports = { heartbeatTick, runExclusive, syncIntervalMinutes, syncTick, jiraTick, webhookTick, cleanupTick };
