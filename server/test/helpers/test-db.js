const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { runMigrations } = require('../../lib/migrate');

/**
 * Creates a fresh schema owned by shipscope_app inside TEST_DATABASE_URL's database, migrates it,
 * and returns a pool pinned to that schema plus a teardown function. Deliberately does not reuse
 * lib/db.js's createPool() -- that forces Render's TLS options, which a local/CI Postgres doesn't speak.
 *
 * @returns {Promise<{ pool: import('pg').Pool, schema: string, teardown: () => Promise<void> }>}
 */
async function createTestDb() {
    const base = process.env.TEST_DATABASE_URL;
    if (!base) throw new Error('TEST_DATABASE_URL not set -- see server/README.md');
    const schema = `test_${crypto.randomBytes(6).toString('hex')}`;

    const bootstrap = new Pool({ connectionString: base });
    await bootstrap.query(`CREATE SCHEMA "${schema}" AUTHORIZATION shipscope_app`);
    await bootstrap.end();

    const pool = new Pool({ connectionString: base, options: `-c search_path=${schema}` });
    await runMigrations(pool, path.join(__dirname, '..', '..', 'migrations'));

    async function teardown() {
        await pool.end();
        const admin = new Pool({ connectionString: base });
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    }

    return { pool, schema, teardown };
}

module.exports = { createTestDb };
