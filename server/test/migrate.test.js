const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createTestDb } = require('./helpers/test-db');
const { runMigrations } = require('../lib/migrate');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

test('runMigrations: applies cleanly from empty and creates the expected tables', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const { rows } = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name"
    );
    const tableNames = rows.map((row) => row.table_name);
    assert.ok(tableNames.includes('tenants'));
    assert.ok(tableNames.includes('users'));
    assert.ok(tableNames.includes('memberships'));
    assert.ok(tableNames.includes('sessions'));
    assert.ok(tableNames.includes('invitations'));
    assert.ok(tableNames.includes('github_installations'));
    assert.ok(tableNames.includes('tracked_repos'));
    assert.ok(tableNames.includes('deployments'));
    assert.ok(tableNames.includes('issue_deployments'));
    for (const table of ['flag_sources', 'ingest_tokens', 'flags', 'flag_values', 'flag_value_history']) assert.ok(tableNames.includes(table), table);
    assert.ok(tableNames.includes('schema_migrations'));

    const { rows: migrationRows } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    assert.deepStrictEqual(migrationRows.map((r) => r.filename), [
        '001_create_tenants_users_memberships.sql',
        '002_sessions_and_scoped_rls.sql',
        '003_invitations.sql',
        '004_github_connections.sql',
        '005_deployments.sql',
        '006_versions_and_drift.sql',
        '007_manual_and_display_names.sql',
        '008_flags.sql',
        '009_jira_connections.sql',
        '010_jira_issues.sql',
        '011_jira_rhythms.sql',
    ]);
});

test('runMigrations: re-running is a no-op', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const appliedAgain = await runMigrations(pool, path.join(__dirname, '..', 'migrations'));
    assert.deepStrictEqual(appliedAgain, []);
});
