const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
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
    assert.ok(tableNames.includes('sync_requests'));
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
        '012_jira_release_flow.sql',
        '013_webhooks.sql',
        '014_flag_links.sql',
        '015_sync_fairness.sql',
        '016_flag_source_status.sql',
        '017_ingest_token_limits.sql',
        '018_flag_source_scope.sql', '019_flag_source_freshness.sql', '020_worker_status.sql', '021_flag_code_sources.sql', '022_repo_environment_map.sql', '023_flag_endpoint_sources.sql', '024_flag_endpoint_polling.sql', '025_repo_service_role.sql', '026_flag_link_suggestions.sql', '027_tenant_signing_secret.sql', '028_secret_events.sql', '029_endpoint_tests.sql', '030_jira_access_grants.sql', '031_audit_events.sql', '032_flag_source_oidc.sql', '033_worker_metrics.sql', '034_flag_history_retention.sql', '035_status_samples.sql', '036_release_lines.sql', '037_work_items.sql', '038_release_plans.sql', '039_outgoing_events.sql', '040_service_tokens.sql', '041_work_item_problem.sql', '042_work_item_intent_created.sql', '043_work_item_source_reported.sql', '044_pdi_connection.sql', '045_pdi_connection_without_address.sql',
    ]);
});

test('runMigrations: two at once (the web and worker pre-deploys) apply every file exactly once', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    await pool.query('DROP TABLE schema_migrations');
    await pool.query('DROP TABLE sync_requests');
    await pool.query('ALTER TABLE jira_connections DROP COLUMN webhook_ids, DROP COLUMN webhook_jql, DROP COLUMN webhook_expires_at, DROP COLUMN webhook_error');
    await pool.query('CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const all = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    await pool.query('INSERT INTO schema_migrations (filename) SELECT unnest($1::text[])', [all.filter((f) => f !== '013_webhooks.sql')]);

    const dir = path.join(__dirname, '..', 'migrations');
    const [a, b] = await Promise.all([runMigrations(pool, dir), runMigrations(pool, dir)]);
    assert.deepStrictEqual([...a, ...b], ['013_webhooks.sql'], 'one of them applied it, the other found nothing pending');
});

test('runMigrations: re-running is a no-op', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);

    const appliedAgain = await runMigrations(pool, path.join(__dirname, '..', 'migrations'));
    assert.deepStrictEqual(appliedAgain, []);
});
