const { Pool } = require('pg');

/** Creates a connection pool from DATABASE_URL. Render's managed Postgres requires TLS. */
function createPool() {
    return new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });
}

/** @param {import('pg').Pool} pool @returns {Promise<{ok: true, latencyMs: number}>} */
async function checkConnection(pool) {
    const start = Date.now();
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
}

module.exports = { createPool, checkConnection };
