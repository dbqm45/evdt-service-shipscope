const fs = require('fs');
const path = require('path');

// Held while migrating, so two runs (the web service's and the worker's pre-deploy command on Render start
// together) never apply the same file twice: the second waits, then finds nothing pending.
const MIGRATION_LOCK = 727_000;

/**
 * Applies pending `NNN_description.sql` files from migrationsDir, in filename order, each inside its
 * own transaction. Postgres DDL is transactional, so a failing file rolls back cleanly and stops --
 * later files are never attempted. Creates the schema_migrations tracking table if it doesn't exist.
 * Runs under a session advisory lock: concurrent calls apply each file once.
 *
 * @param {import('pg').Pool} pool
 * @param {string} migrationsDir
 * @returns {Promise<string[]>} filenames applied, in order (empty if nothing was pending)
 */
async function runMigrations(pool, migrationsDir) {
    const lock = await pool.connect();
    try {
        await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
        return await applyPending(pool, migrationsDir);
    } finally {
        await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
        lock.release();
    }
}

async function applyPending(pool, migrationsDir) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    `);

    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.filename));

    const pending = fs
        .readdirSync(migrationsDir)
        .filter((filename) => filename.endsWith('.sql') && !applied.has(filename))
        .sort();

    const appliedNow = [];
    for (const filename of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
            await client.query('COMMIT');
            appliedNow.push(filename);
        } catch (err) {
            await client.query('ROLLBACK');
            throw new Error(`Migration ${filename} failed: ${err.message}`, { cause: err });
        } finally {
            client.release();
        }
    }

    return appliedNow;
}

module.exports = { runMigrations };
