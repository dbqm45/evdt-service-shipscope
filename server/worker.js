const { createPool, checkConnection } = require('./lib/db');
const { loadGitHubAppConfig, loadAtlassianConfig } = require('./lib/config');
const { syncAllJira } = require('./lib/jira-sync');
const { syncAll } = require('./lib/deployment-sync');
const { cleanupAll } = require('./lib/retention');
const { pendingSyncRequests, finishSyncRequests } = require('./lib/webhooks');
const { recordRun } = require('./lib/worker-status');
const { createLogger, logLevel, logProcessFailures } = require('./lib/log');
const { APP_VERSION } = require('./lib/version');

const HEARTBEAT_INTERVAL_MS = 30_000;
const WEBHOOK_INTERVAL_MS = 30_000; // how often webhook-requested syncs are picked up
const CLEANUP_INTERVAL_MS = 24 * 3600_000;
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const DEFAULT_TENANT_BUDGET_SECONDS = 120;
// Postgres advisory lock keys: one sync and one cleanup at a time, even with more than one worker instance.
const SYNC_LOCK = 727_001;
const CLEANUP_LOCK = 727_002;
const JIRA_LOCK = 727_003;

const defaultLogger = createLogger({ service: 'worker', level: logLevel(process.env), base: { version: APP_VERSION } });

/**
 * The `log(message, fields)` the sync modules call: `fields.level` picks the level (default info), the rest are
 * fields of the line (tenantId, repo, err, ...).
 */
const syncLogger = (logger) => (msg, fields = {}) => {
    const { level = 'info', ...rest } = fields;
    (logger[level] || logger.info)(msg, rest);
};

/** Notes a job's run in worker_status (migration 020) for GET /health/worker. Never fails the job. */
async function noteRun(pool, logger, deps, run) {
    try {
        await (deps.recordRun || recordRun)(pool, run);
    } catch (err) {
        logger.warn('could not record the worker status', { job: run.job, err });
    }
}

/**
 * One heartbeat tick: pings Postgres, logs the result and records it. Extracted from the loop below so it's testable
 * without waiting on a real interval or a real database.
 */
async function heartbeatTick(pool, logger = defaultLogger, deps = {}) {
    try {
        const { latencyMs } = await checkConnection(pool);
        logger.debug('heartbeat ok', { dbLatencyMs: latencyMs });
        await noteRun(pool, logger, deps, { job: 'heartbeat', ok: true, details: { dbLatencyMs: latencyMs } });
    } catch (err) {
        logger.error('heartbeat failed: database unreachable', { err });
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

/**
 * SYNC_TENANT_BUDGET_SECONDS: 10-3600, default 120 -- how long one tenant may take in a sync pass before the next
 * tenant's turn (its remaining work continues next pass). Keeps one large tenant from holding up everyone else.
 */
function tenantBudgetSeconds(env) {
    if (env.SYNC_TENANT_BUDGET_SECONDS === undefined || env.SYNC_TENANT_BUDGET_SECONDS === '') return DEFAULT_TENANT_BUDGET_SECONDS;
    const value = Number(env.SYNC_TENANT_BUDGET_SECONDS);
    if (!Number.isInteger(value) || value < 10 || value > 3600) throw new Error('SYNC_TENANT_BUDGET_SECONDS must be a whole number of seconds, 10-3600');
    return value;
}

/**
 * Runs one job under its lock: logs the outcome with its duration and records it. Errors are logged, never thrown.
 * A pass in which some tenants failed still succeeded as a job; their count goes into the record (`failed`).
 */
async function runJob(pool, { job, lock, logger, deps, run, summary }) {
    const started = Date.now();
    const log = logger.child({ job });
    try {
        const outcome = await runExclusive(pool, lock, run);
        if (outcome.skipped) {
            log.info(`${job} skipped: another run holds the lock`);
            return;
        }
        const fields = { durationMs: Date.now() - started, ...outcome.result };
        (outcome.result?.failed ? log.warn : log.info)(summary(outcome.result), fields);
        await noteRun(pool, log, deps, { job, ok: true, details: outcome.result });
    } catch (err) {
        log.error(`${job} failed`, { durationMs: Date.now() - started, err });
        await noteRun(pool, log, deps, { job, ok: false, error: err.message });
    }
}

/** One deployment sync pass (FR-005), never overlapping another. */
async function syncTick(pool, app, logger = defaultLogger, deps = { syncAll }, tenantBudgetMs = DEFAULT_TENANT_BUDGET_SECONDS * 1000) {
    await runJob(pool, {
        job: 'deployments', lock: SYNC_LOCK, logger, deps,
        run: () => deps.syncAll({ pool, app, log: syncLogger(logger.child({ job: 'deployments' })), options: { tenantBudgetMs } }),
        summary: (r) => `deployment sync done: ${r.repos} repos, +${r.inserted} deployments, ${r.failed} failed, ${r.deferred} left for the next pass`,
    });
}

/** One Jira issue sync pass (FR-009), never overlapping another. */
async function jiraTick(pool, atlassian, logger = defaultLogger, deps = { syncAllJira }, tenantBudgetMs = DEFAULT_TENANT_BUDGET_SECONDS * 1000) {
    await runJob(pool, {
        job: 'jira', lock: JIRA_LOCK, logger, deps,
        run: () => deps.syncAllJira({ pool, atlassian, log: syncLogger(logger.child({ job: 'jira' })), tenantBudgetMs }),
        summary: (r) => `jira sync done: ${r.tenants} tenants, ${r.issues} issues, ${r.failed} failed, ${r.deferred} left for the next pass`,
    });
}

/**
 * Picks up what webhooks asked for (migration 013) and syncs just that: the named repos, the named Jira
 * connections. Under the same locks as the periodic syncs, so never alongside one; a request that couldn't run
 * (lock held, or the sync failed as a whole) stays queued for the next tick. Errors are logged, never thrown; the
 * tick is recorded as one job (`webhooks`), failed when any source failed.
 */
async function webhookTick(pool, { app, atlassian, tenantBudgetMs = DEFAULT_TENANT_BUDGET_SECONDS * 1000 }, logger = defaultLogger, deps = { syncAll, syncAllJira }) {
    const log = logger.child({ job: 'webhooks' });
    const sources = [
        app && ['github', SYNC_LOCK, (requests) => deps.syncAll({
            pool, app, log: syncLogger(log), options: { tenantBudgetMs }, repoIds: requests.map((r) => Number(r.key)).filter(Number.isSafeInteger),
        })],
        atlassian && ['jira', JIRA_LOCK, (requests) => deps.syncAllJira({ pool, atlassian, log: syncLogger(log), tenantBudgetMs, keys: requests.map((r) => r.key) })],
    ].filter(Boolean);
    const errors = [];
    const handled = {};
    for (const [source, lock, sync] of sources) {
        const started = Date.now();
        try {
            const requests = await pendingSyncRequests(pool, source);
            if (!requests.length) continue;
            const run = await runExclusive(pool, lock, () => sync(requests));
            if (run.skipped) continue;
            await finishSyncRequests(pool, source, requests);
            handled[source] = requests.length;
            log.info(`${source} webhook sync done: ${requests.length} request(s)`, { source, requests: requests.length, durationMs: Date.now() - started });
        } catch (err) {
            errors.push(`${source}: ${err.message}`);
            log.error(`${source} webhook sync failed`, { source, durationMs: Date.now() - started, err });
        }
    }
    await noteRun(pool, log, deps, { job: 'webhooks', ok: !errors.length, error: errors.join('; ') || null, details: handled });
}

/** The daily retention cleanup, never overlapping another. */
async function cleanupTick(pool, logger = defaultLogger, deps = { cleanupAll }) {
    await runJob(pool, {
        job: 'cleanup', lock: CLEANUP_LOCK, logger, deps,
        run: async () => ({ deleted: await deps.cleanupAll(pool) }),
        summary: (r) => `cleanup done: ${r.deleted} old deployment records deleted`,
    });
}

if (require.main === module) {
    const app = loadGitHubAppConfig(process.env);
    const syncMinutes = syncIntervalMinutes(process.env);
    const budgetMs = tenantBudgetSeconds(process.env) * 1000;
    const pool = createPool();
    logProcessFailures(defaultLogger);
    pool.on('error', (err) => defaultLogger.error('idle database connection failed', { err }));
    defaultLogger.info('worker started', { syncIntervalMinutes: syncMinutes, tenantBudgetSeconds: budgetMs / 1000, github: !!app, jira: !!loadAtlassianConfig(process.env) });
    const timers = [setInterval(() => heartbeatTick(pool), HEARTBEAT_INTERVAL_MS)];
    heartbeatTick(pool);

    if (app) {
        timers.push(setInterval(() => syncTick(pool, app, undefined, undefined, budgetMs), syncMinutes * 60_000));
        syncTick(pool, app, undefined, undefined, budgetMs);
    } else {
        defaultLogger.warn('GITHUB_APP_* not set: deployment sync is off');
    }
    const atlassian = loadAtlassianConfig(process.env);
    if (atlassian) {
        timers.push(setInterval(() => jiraTick(pool, atlassian, undefined, undefined, budgetMs), syncMinutes * 60_000));
        jiraTick(pool, atlassian, undefined, undefined, budgetMs);
    } else {
        defaultLogger.warn('ATLASSIAN_* not set: Jira sync is off');
    }
    if (app || atlassian) timers.push(setInterval(() => webhookTick(pool, { app, atlassian, tenantBudgetMs: budgetMs }), WEBHOOK_INTERVAL_MS));
    timers.push(setInterval(() => cleanupTick(pool), CLEANUP_INTERVAL_MS));
    cleanupTick(pool);

    process.on('SIGTERM', () => {
        defaultLogger.info('worker stopping (SIGTERM)');
        timers.forEach(clearInterval);
        pool.end(() => process.exit(0));
    });
}

module.exports = { heartbeatTick, runExclusive, syncIntervalMinutes, tenantBudgetSeconds, syncTick, jiraTick, webhookTick, cleanupTick };
