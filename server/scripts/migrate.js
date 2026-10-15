const path = require('path');
const { createPool } = require('../lib/db');
const { runMigrations } = require('../lib/migrate');

async function main() {
    const pool = createPool();
    try {
        const applied = await runMigrations(pool, path.join(__dirname, '..', 'migrations'));
        console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
