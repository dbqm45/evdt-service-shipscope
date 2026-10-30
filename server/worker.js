const { createPool, checkConnection } = require('./lib/db');
const { loadGitHubAppConfig, loadAtlassianConfig, loadEncryptionKey, loadSealingKeys } = require('./lib/config');
const { syncAllJira } = require('./lib/jira-sync');
const { syncAll } = require('./lib/deployment-sync');
const { cleanupAll } = require('./lib/retention');
const { pollEndpoints } = require('./lib/flag-poll');
const { resealSecrets } = require('./lib/secret-rotation');
const { runQueuedEndpointTest } = require('./lib/endpoint-flags');
const { handOverAccessToken } = require('./lib/jira-connections');
const { flagSourceHealth } = require('./lib/flags');
const { detectReleaseEvents, deliverEvents } = require('./lib/outgoing-events');
const { pingPdiConnections, backfillPdiConnections } = require('./lib/pdi-connection');
const { localModeEnabled, LOCAL_MODE_WARNING } = require('./lib/local-mode');
const { safeFetch } = require('./lib/safe-fetch');
const { pendingSyncRequests, finishSyncRequests } = require('./lib/webhooks');
const { recordRun } = require('./lib/worker-status');
const { createLogger, logLevel, logProcessFailures } = require('./lib/log');
const { APP_VERSION } = require('./lib/version');
const { workerConcurrency } = require('./lib/tenant-claim');

const HEARTBEAT_INTERVAL_MS = 30_000;
const WEBHOOK_INTERVAL_MS = 30_000; // how often webhook-requested syncs are picked up
const CLEANUP_INTERVAL_MS = 24 * 3600_000;
const FLAGS_INTERVAL_MS = 60_000; // how often due endpoint sources are looked for (each has its own interval)
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const DEFAULT_TENANT_BUDGET_SECONDS = 120;
// Postgres advisory lock keys: one cleanup (and the other housekeeping jobs) at a time, even with more than one worker
// instance. The deployment, Jira and flag passes (formerly 727_001, 727_003, 727_004) claim each tenant instead
// (lib/tenant-claim.js), so several instances share them.
const CLEANUP_LOCK = 727_002;
const SECRETS_LOCK = 727_005;
const ENDPOINT_TEST_LOCK = 727_006;
const SOURCES_LOCK = 727_007;
const SOURCES_INTERVAL_MS = 5 * 60_000; // the flag sources' totals for GET /metrics
// Outgoing events (G1.5, lib/outgoing-events.js): looked for every 5 minutes, delivered every minute, each by one
// instance at a time (a delivery must not go out twice).
const EVENTS_LOCK = 727_008;
const EVENT_DELIVERY_LOCK = 727_009;
const EVENTS_INTERVAL_MS = 5 * 60_000;
const EVENT_DELIVERY_INTERVAL_MS = 60_000;
const PDI_PING_LOCK = 727_010;
const PDI_PING_INTERVAL_MS = 3600_000; // the pdi connection's ShipScope → pdi proof (lib/pdi-connection.js)
const ENDPOINT_TEST_INTERVAL_MS = 2_000; // an admin waits on these in Settings
const JIRA_TOKEN_INTERVAL_MS = 1_000; // the web service waits on these, a page in Settings with it

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

// Jobs running in this process without a global lock (their tenants are claimed one by one, lib/tenant-claim.js):
// a tick that comes while the previous pass still runs is skipped, so passes never pile up in one instance.
const running = new Set();

/**
 * Runs one job: under its lock when it has one (`lock`), else at most once at a time in this process, its tenants
 * shared with other instances through their claims. Logs the outcome with its duration and records it. Errors are
 * logged, never thrown. A pass in which some tenants failed still succeeded as a job; their count goes into the
 * record (`failed`).
 */
async function runJob(pool, { job, lock, logger, deps, run, summary }) {
    const started = Date.now();
    const log = logger.child({ job });
    if (!lock && running.has(job)) {
        log.info(`${job} skipped: the previous pass is still running`);
        return;
    }
    if (!lock) running.add(job);
    try {
        const outcome = lock ? await runExclusive(pool, lock, run) : { skipped: false, result: await run() };
        if (outcome.skipped) {
            log.info(`${job} skipped: another run holds the lock`);
            return;
        }
        const fields = { durationMs: Date.now() - started, ...outcome.result };
        (outcome.result?.failed ? log.warn : log.info)(summary(outcome.result), fields);
        await noteRun(pool, log, deps, { job, ok: true, details: outcome.result, durationMs: fields.durationMs });
    } catch (err) {
        const durationMs = Date.now() - started;
        log.error(`${job} failed`, { durationMs, err });
        await noteRun(pool, log, deps, { job, ok: false, error: err.message, durationMs });
    } finally {
        if (!lock) running.delete(job);
    }
}

/** The tenants another instance was syncing, when there were any (lib/tenant-claim.js). */
const busyNote = (r) => (r.busy ? `, ${r.busy} tenant(s) busy in another instance` : '');

/** One deployment sync pass (FR-005), never overlapping another in this process. */

async function syncTick(pool, app, logger = defaultLogger, deps = { syncAll }, tenantBudgetMs = DEFAULT_TENANT_BUDGET_SECONDS * 1000, concurrency = 1) {
    await runJob(pool, {
        job: 'deployments', lock: null, logger, deps,
        run: () => deps.syncAll({ pool, app, log: syncLogger(logger.child({ job: 'deployments' })), options: { tenantBudgetMs, concurrency } }),
        summary: (r) => `deployment sync done: ${r.repos} repos, +${r.inserted} deployments, ${r.failed} failed, ${r.deferred} left for the next pass${busyNote(r)}`,
    });
}

/** One Jira issue sync pass (FR-009), never overlapping another in this process. */
async function jiraTick(pool, atlassian, logger = defaultLogger, deps = { syncAllJira }, tenantBudgetMs = DEFAULT_TENANT_BUDGET_SECONDS * 1000, concurrency = 1) {
    await runJob(pool, {
        job: 'jira', lock: null, logger, deps,
        run: () => deps.syncAllJira({ pool, atlassian, log: syncLogger(logger.child({ job: 'jira' })), tenantBudgetMs, concurrency }),
        summary: (r) => `jira sync done: ${r.tenants} tenants, ${r.issues} issues, ${r.failed} failed, ${r.deferred} left for the next pass${busyNote(r)}`,
    });
}

/** One pass over the endpoint sources that are due (lib/flag-poll.js), never overlapping another or a dashboard's request. */
async function flagsTick(pool, encryptionKey, logger = defaultLogger, deps = { pollEndpoints }, sealingKeys = null, concurrency = 1) {
    await runJob(pool, {
        job: 'flags', lock: null, logger, deps,
        run: () => deps.pollEndpoints({ pool, encryptionKey, sealingKeys, concurrency, log: syncLogger(logger.child({ job: 'flags' })) }),
        summary: (r) => `flags poll done: ${r.sources} endpoint source(s) in ${r.tenants} tenant(s), ${r.failed} failed${busyNote(r)}`,
    });
}

/**
 * Runs the "Test" requests Settings queued for endpoint tokens only the worker can read (lib/endpoint-flags.js), every
 * couple of seconds. Logged only when it ran one; a failure leaves the request queued for the next tick.
 */
async function endpointTestTick(pool, { encryptionKey, sealingKeys }, logger = defaultLogger, deps = { runQueuedEndpointTest }) {
    try {
        const requests = await pendingSyncRequests(pool, 'endpoint-test');
        if (!requests.length) return;
        const run = await runExclusive(pool, ENDPOINT_TEST_LOCK, async () => {
            for (const { key } of requests) {
                const [tenantId, testId] = key.split('/');
                if (tenantId && testId) await deps.runQueuedEndpointTest(pool, { tenantId, testId, encryptionKey, sealingKeys });
            }
        });
        if (run.skipped) return;
        await finishSyncRequests(pool, 'endpoint-test', requests);
        logger.info(`endpoint tests run: ${requests.length}`, { job: 'endpoint-tests', requests: requests.length });
    } catch (err) {
        logger.error('endpoint tests failed', { job: 'endpoint-tests', err });
    }
}

/**
 * Hands the web service short-lived Jira access tokens it asked for (lib/jira-connections.js accessTokenViaWorker()):
 * where only the worker can open refresh tokens. Every second, since a page in Settings waits on it.
 */
async function jiraTokenTick(pool, atlassian, logger = defaultLogger, deps = { handOverAccessToken }) {
    try {
        const requests = await pendingSyncRequests(pool, 'jira-token');
        if (!requests.length) return;
        for (const { key } of requests) await deps.handOverAccessToken(pool, { tenantId: key, atlassian });
        await finishSyncRequests(pool, 'jira-token', requests);
        logger.info(`jira tokens handed over: ${requests.length}`, { job: 'jira-tokens', requests: requests.length });
    } catch (err) {
        logger.error('jira token hand-over failed', { job: 'jira-tokens', err });
    }
}

/**
 * Picks up what webhooks asked for (migration 013) and syncs just that: the named repos, the named Jira
 * connections. Under the same locks as the periodic syncs, so never alongside one; a request that couldn't run
 * (lock held, or the sync failed as a whole) stays queued for the next tick. Errors are logged, never thrown; the
 * tick is recorded as one job (`webhooks`), failed when any source failed.
 */
async function webhookTick(pool, { app, atlassian, encryptionKey = null, sealingKeys = null, tenantBudgetMs = DEFAULT_TENANT_BUDGET_SECONDS * 1000, concurrency = 1 }, logger = defaultLogger, deps = { syncAll, syncAllJira, pollEndpoints }) {
    const log = logger.child({ job: 'webhooks' });
    if (running.has('webhooks')) return;
    running.add('webhooks');
    try {
        await drainWebhooks();
    } finally {
        running.delete('webhooks');
    }

    async function drainWebhooks() {
        const sources = [
            app && ['github', (requests) => deps.syncAll({
                pool, app, log: syncLogger(log), options: { tenantBudgetMs, concurrency }, repoIds: requests.map((r) => Number(r.key)).filter(Number.isSafeInteger),
            })],
            atlassian && ['jira', (requests) => deps.syncAllJira({ pool, atlassian, log: syncLogger(log), tenantBudgetMs, concurrency, keys: requests.map((r) => r.key) })],
            // A dashboard was opened: its tenant's endpoint sources, unless just read (lib/flag-poll.js onDemand).
            encryptionKey && ['flags', (requests) => deps.pollEndpoints({ pool, encryptionKey, sealingKeys, concurrency, log: syncLogger(log), tenantIds: requests.map((r) => r.key), onDemand: true })],
        ].filter(Boolean);
        const errors = [];
        const handled = {};
        const tickStarted = Date.now();
        for (const [source, sync] of sources) {
            const started = Date.now();
            try {
                const requests = await pendingSyncRequests(pool, source);
                if (!requests.length) continue;
                const result = await sync(requests);
                // A tenant another instance was syncing: keep the requests for the next tick rather than lose its part.
                if (result && result.busy) {
                    log.info(`${source} webhook sync postponed: ${result.busy} tenant(s) busy elsewhere`, { source, busy: result.busy });
                    continue;
                }
                await finishSyncRequests(pool, source, requests);
                handled[source] = requests.length;
                log.info(`${source} webhook sync done: ${requests.length} request(s)`, { source, requests: requests.length, durationMs: Date.now() - started });
            } catch (err) {
                errors.push(`${source}: ${err.message}`);
                log.error(`${source} webhook sync failed`, { source, durationMs: Date.now() - started, err });
            }
        }
        await noteRun(pool, log, deps, { job: 'webhooks', ok: !errors.length, error: errors.join('; ') || null, details: handled, durationMs: Date.now() - tickStarted });
    }
}

/** Seals every stored secret with the current TOKEN_ENCRYPTION_KEY (lib/secret-rotation.js), at start and daily. */
async function secretsTick(pool, encryptionKey, logger = defaultLogger, deps = { resealSecrets }, sealingKeys = null) {
    await runJob(pool, {
        job: 'secrets', lock: SECRETS_LOCK, logger, deps,
        run: () => deps.resealSecrets({ pool, encryptionKey, sealingKeys, log: syncLogger(logger.child({ job: 'secrets' })) }),
        summary: (r) => `secrets re-sealed: ${r.resealed} in ${r.tenants} tenant(s), ${r.stale} still on an older key (${r.unreadable} unreadable)`,
    });
}

/** Counts every tenant's flag sources by origin and freshness (lib/flags.js) for GET /metrics, every 5 minutes. */
/** Release events for every tenant with a subscription (lib/outgoing-events.js detectReleaseEvents()). */
async function eventsTick(pool, logger = defaultLogger, deps = { detectReleaseEvents }) {
    await runJob(pool, {
        job: 'events', lock: EVENTS_LOCK, logger, deps,
        run: async () => {
            const log = syncLogger(logger.child({ job: 'events' }));
            const totals = { tenants: 0, events: 0, queued: 0, failed: 0 };
            const { rows } = await pool.query('SELECT id FROM tenants ORDER BY created_at');
            for (const { id: tenantId } of rows) {
                try {
                    const r = await deps.detectReleaseEvents(pool, { tenantId, log });
                    if (r.events || r.queued) totals.tenants += 1;
                    totals.events += r.events;
                    totals.queued += r.queued;
                } catch (err) {
                    totals.failed += 1;
                    log(`tenant ${tenantId}: release events not looked for: ${err.message}`, { level: 'warn', tenantId, err });
                }
            }
            return totals;
        },
        summary: (r) => `release events: ${r.events} in ${r.tenants} tenant(s), ${r.queued} queued, ${r.failed} failed`,
    });
}

/** Delivers the queued events that are due (lib/outgoing-events.js deliverEvents()), signed, through safeFetch(). */
async function eventDeliveryTick(pool, encryptionKey, logger = defaultLogger, deps = { deliverEvents, fetchImpl: safeFetch }, { localMode = false } = {}) {
    await runJob(pool, {
        job: 'event-delivery', lock: EVENT_DELIVERY_LOCK, logger, deps,
        run: () => deps.deliverEvents(pool, { encryptionKey, fetchImpl: deps.fetchImpl, localMode, log: syncLogger(logger.child({ job: 'event-delivery' })) }),
        summary: (r) => `events delivered: ${r.delivered}, ${r.retried} to retry, ${r.failed} given up`,
    });
}

/** Pings every active pdi connection (lib/pdi-connection.js pingPdiConnections()), signed, through safeFetch(). */
async function pdiPingTick(pool, encryptionKey, logger = defaultLogger, deps = { pingPdiConnections, fetchImpl: safeFetch }, { localMode = false } = {}) {
    await runJob(pool, {
        job: 'pdi-ping', lock: PDI_PING_LOCK, logger, deps,
        run: () => deps.pingPdiConnections(pool, { encryptionKey, fetchImpl: deps.fetchImpl, localMode, log: syncLogger(logger.child({ job: 'pdi-ping' })) }),
        summary: (r) => `pdi connections pinged: ${r.pinged}, ${r.failed} not reached`,
    });
}

async function sourcesTick(pool, logger = defaultLogger, deps = { flagSourceHealth }) {
    await runJob(pool, {
        job: 'sources', lock: SOURCES_LOCK, logger, deps,
        run: () => deps.flagSourceHealth(pool),
        summary: (r) => `flag sources counted: ${r.sources.push + r.sources.code + r.sources.endpoint} in ${r.tenants} tenant(s), ${r.environments.error} environment(s) failing, ${r.environments.stale} stale`,
    });
}

/** The daily retention cleanup, never overlapping another. */
async function cleanupTick(pool, logger = defaultLogger, deps = { cleanupAll }) {
    await runJob(pool, {
        job: 'cleanup', lock: CLEANUP_LOCK, logger, deps,
        run: () => deps.cleanupAll(pool),
        summary: (r) => `cleanup done: ${r.deployments} old deployment records and ${r.flagChanges} old flag changes deleted${r.pdiLayers ? `, the pdi layer of ${r.pdiLayers} disconnected workspace(s) removed` : ''}`,
    });
}

if (require.main === module) {
    const app = loadGitHubAppConfig(process.env);
    const syncMinutes = syncIntervalMinutes(process.env);
    const budgetMs = tenantBudgetSeconds(process.env) * 1000;
    const concurrency = workerConcurrency(process.env);
    const pool = createPool();
    logProcessFailures(defaultLogger);
    pool.on('error', (err) => defaultLogger.error('idle database connection failed', { err }));
    defaultLogger.info('worker started', { syncIntervalMinutes: syncMinutes, tenantBudgetSeconds: budgetMs / 1000, concurrency, github: !!app, jira: !!loadAtlassianConfig(process.env) });
    // Local mode (lib/local-mode.js): decided once here; only the connection with pdi uses it.
    const localMode = localModeEnabled(process.env);
    if (localMode) defaultLogger.warn(LOCAL_MODE_WARNING);
    const timers = [setInterval(() => heartbeatTick(pool), HEARTBEAT_INTERVAL_MS)];
    heartbeatTick(pool);

    if (app) {
        timers.push(setInterval(() => syncTick(pool, app, undefined, undefined, budgetMs, concurrency), syncMinutes * 60_000));
        syncTick(pool, app, undefined, undefined, budgetMs, concurrency);
    } else {
        defaultLogger.warn('GITHUB_APP_* not set: deployment sync is off');
    }
    // The private half too: only the worker reads customers' endpoint and Jira tokens (lib/sealed-box.js).
    const sealingKeys = loadSealingKeys(process.env, { withPrivate: true });
    const atlassian = loadAtlassianConfig(process.env);
    if (atlassian) {
        atlassian.sealingKeys = sealingKeys;
        if (sealingKeys) timers.push(setInterval(() => jiraTokenTick(pool, atlassian), JIRA_TOKEN_INTERVAL_MS));
        timers.push(setInterval(() => jiraTick(pool, atlassian, undefined, undefined, budgetMs, concurrency), syncMinutes * 60_000));
        jiraTick(pool, atlassian, undefined, undefined, budgetMs, concurrency);
    } else {
        defaultLogger.warn('ATLASSIAN_* not set: Jira sync is off');
    }
    const encryptionKey = loadEncryptionKey(process.env);
    if (encryptionKey) {
        timers.push(setInterval(() => flagsTick(pool, encryptionKey, undefined, undefined, sealingKeys, concurrency), FLAGS_INTERVAL_MS));
        flagsTick(pool, encryptionKey, undefined, undefined, sealingKeys, concurrency);
        timers.push(setInterval(() => secretsTick(pool, encryptionKey, undefined, undefined, sealingKeys), CLEANUP_INTERVAL_MS));
        secretsTick(pool, encryptionKey, undefined, undefined, sealingKeys);
        if (sealingKeys) timers.push(setInterval(() => endpointTestTick(pool, { encryptionKey, sealingKeys }), ENDPOINT_TEST_INTERVAL_MS));
    } else {
        defaultLogger.warn('TOKEN_ENCRYPTION_KEY not set: flags from endpoints are off');
    }
    if (app || atlassian || encryptionKey) timers.push(setInterval(() => webhookTick(pool, { app, atlassian, encryptionKey, sealingKeys, tenantBudgetMs: budgetMs, concurrency }), WEBHOOK_INTERVAL_MS));
    timers.push(setInterval(() => cleanupTick(pool), CLEANUP_INTERVAL_MS));
    cleanupTick(pool);
    timers.push(setInterval(() => sourcesTick(pool), SOURCES_INTERVAL_MS));
    sourcesTick(pool);
    if (encryptionKey) {
        // Events are signed with the workspace's signing secret, sealed by TOKEN_ENCRYPTION_KEY.
        timers.push(setInterval(() => eventsTick(pool), EVENTS_INTERVAL_MS));
        timers.push(setInterval(() => eventDeliveryTick(pool, encryptionKey, undefined, undefined, { localMode }), EVENT_DELIVERY_INTERVAL_MS));
        timers.push(setInterval(() => pdiPingTick(pool, encryptionKey, undefined, undefined, { localMode }), PDI_PING_INTERVAL_MS));
        pdiPingTick(pool, encryptionKey, undefined, undefined, { localMode });
    }
    // Workspaces that used the service API or events before the connection with pdi existed get one (pending), once.
    backfillPdiConnections(pool)
        .then((r) => r.created && defaultLogger.info(`pdi connections carried over: ${r.created}`))
        .catch((err) => defaultLogger.warn({ err: err.message }, 'pdi connections not carried over'));

    process.on('SIGTERM', () => {
        defaultLogger.info('worker stopping (SIGTERM)');
        timers.forEach(clearInterval);
        pool.end(() => process.exit(0));
    });
}

module.exports = { heartbeatTick, runExclusive, syncIntervalMinutes, tenantBudgetSeconds, syncTick, jiraTick, flagsTick, secretsTick, endpointTestTick, jiraTokenTick, webhookTick, sourcesTick, cleanupTick, eventsTick, eventDeliveryTick, pdiPingTick };
