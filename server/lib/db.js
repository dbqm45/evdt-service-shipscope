const { Pool } = require('pg');

/**
 * Creates a connection pool from DATABASE_URL. Render's managed Postgres requires TLS, so TLS is on
 * unless DATABASE_SSL=false is set explicitly -- for a local Postgres (e.g. the Docker container in
 * server/README.md), which doesn't speak TLS.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('pg').Pool}
 */
function createPool(env = process.env) {
    return new Pool({
        connectionString: env.DATABASE_URL,
        ssl: env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
}

/** @param {import('pg').Pool} pool @returns {Promise<{ok: true, latencyMs: number}>} */
async function checkConnection(pool) {
    const start = Date.now();
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
}

module.exports = { createPool, checkConnection };
