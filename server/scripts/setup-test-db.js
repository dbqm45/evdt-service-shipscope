const { Pool } = require('pg');

/** Idempotently creates the shipscope_app role used by server/test's real-Postgres suite. Safe to re-run. */
async function setupTestDb(adminDatabaseUrl) {
    const pool = new Pool({ connectionString: adminDatabaseUrl });
    try {
        await pool.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shipscope_app') THEN
                    CREATE ROLE shipscope_app LOGIN PASSWORD 'shipscope_app';
                END IF;
            END $$;
        `);
        await pool.query('GRANT CREATE ON DATABASE postgres TO shipscope_app');
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    setupTestDb(process.env.ADMIN_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres')
        .then(() => console.log('shipscope_app role ready'))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { setupTestDb };
