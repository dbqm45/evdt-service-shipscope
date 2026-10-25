// Checks a restored copy of the database before anything points at it (server/KOPIE.pl.md, lib/restore-check.js):
//
//   RESTORE_DATABASE_URL=postgres://... [TOKEN_ENCRYPTION_KEY=... SECRETS_PUBLIC_KEY=... SECRETS_PRIVATE_KEY=...] \
//     npm run verify-restore --prefix server
//
// Read only. Prints what the copy holds and exits 1 when it is not usable. Never takes DATABASE_URL, so it cannot be
// pointed at the live database by accident.
const fs = require('fs');
const path = require('path');
const { createPool } = require('../lib/db');
const { loadEncryptionKey, loadSealingKeys } = require('../lib/config');
const { collectRestoreFacts, judgeRestore } = require('../lib/restore-check');

async function main(env = process.env, out = (line) => process.stdout.write(`${line}\n`)) {
    if (!env.RESTORE_DATABASE_URL) {
        out('RESTORE_DATABASE_URL is not set: the connection string of the restored copy (Render: its External URL).');
        return 2;
    }
    const encryptionKey = env.TOKEN_ENCRYPTION_KEY ? loadEncryptionKey(env) : null;
    const sealingKeys = env.SECRETS_PUBLIC_KEY ? loadSealingKeys(env, { withPrivate: Boolean(env.SECRETS_PRIVATE_KEY) }) : null;
    const pool = createPool({ DATABASE_URL: env.RESTORE_DATABASE_URL, DATABASE_SSL: env.DATABASE_SSL });
    try {
        const facts = await collectRestoreFacts(pool, { encryptionKey, sealingKeys });
        const expectedMigrations = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
        const verdict = judgeRestore(facts, { expectedMigrations });
        const at = (d) => (d ? new Date(d).toISOString() : '—');
        out(`Migrations: ${facts.migrations.length} applied (this checkout has ${expectedMigrations.length})`);
        out(`Workspaces: ${facts.tenants}; ${Object.entries(facts.counts).map(([t, n]) => `${t} ${n}`).join(', ')}`);
        out(`Newest: deployment ${at(facts.newest.deployment)}, flag change ${at(facts.newest.flagChange)}, settings change ${at(facts.newest.auditEvent)}`);
        out(`Secrets: ${facts.secrets.readable} open, ${facts.secrets.unreadable} do not, ${facts.secrets.untried} not tried`);
        for (const w of verdict.warnings) out(`! ${w}`);
        for (const p of verdict.problems) out(`✗ ${p}`);
        out(verdict.ok ? '✓ The copy is usable.' : '✗ The copy is NOT usable as it is.');
        return verdict.ok ? 0 : 1;
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }, (err) => {
        process.stderr.write(`✗ ${err.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main };
