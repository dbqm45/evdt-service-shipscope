const { createPool, checkConnection } = require('./lib/db');

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * One heartbeat tick: pings Postgres and logs the result. Extracted from the loop below so it's testable
 * without waiting on a real interval or a real database.
 *
 * TODO (later PRD work, not this walking skeleton): once this worker does real GitHub/Jira sync, add
 * application-level timeout/circuit-breaker logic here — Render Background Workers have no execution-time
 * ceiling, so a stuck loop will keep billing compute until someone notices (see
 * context/foundation/infrastructure.md's risk register).
 */
async function heartbeatTick(pool, log = console.log) {
    try {
        const { latencyMs } = await checkConnection(pool);
        log(`${new Date().toISOString()} heartbeat ok (db latency ${latencyMs}ms)`);
    } catch (err) {
        log(`${new Date().toISOString()} heartbeat failed: ${err.message}`);
    }
}

if (require.main === module) {
    const pool = createPool();
    const interval = setInterval(() => heartbeatTick(pool), HEARTBEAT_INTERVAL_MS);
    heartbeatTick(pool);

    process.on('SIGTERM', () => {
        clearInterval(interval);
        pool.end(() => process.exit(0));
    });
}

module.exports = { heartbeatTick };
