// Guards design-docs/REPORT_ARCH.md's Problem 6: withScope() is the one correct way to touch an RLS table,
// but nothing stops a `pool.query(...)` added by mistake, outside any withScope() callback -- that query
// silently returns zero rows (RLS fail-safe) instead of a visible error. This file also pins RLS_TABLES
// (server/lib/scope.js) as the one place that list lives, instead of only in CLAUDE.md's prose and a
// second hardcoded copy in tenant-delete.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RLS_TABLES } = require('../lib/scope');
const { findMissingScopeQueries } = require('../lib/withscope-guard');

const DIR = path.join(__dirname, '.tmp-withscope-guard');

test.beforeEach(() => fs.rmSync(DIR, { recursive: true, force: true }));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

function write(name, content) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, name), content);
}

test('RLS_TABLES: the 15 RLS tables named in CLAUDE.md, in one place', () => {
    assert.deepEqual([...RLS_TABLES].sort(), [
        'deployments', 'flag_sources', 'flag_value_history', 'flag_values', 'flags', 'github_installations',
        'ingest_tokens', 'invitations', 'issue_deployments', 'jira_boards', 'jira_connections', 'jira_issues',
        'jira_pis', 'memberships', 'tracked_repos',
    ].sort());
});

test('findMissingScopeQueries: a direct pool.query() on an RLS table, outside withScope, is a violation', () => {
    write('bad.js', "async function f(pool) {\n  const { rows } = await pool.query('SELECT * FROM memberships WHERE tenant_id = $1', [1]);\n  return rows;\n}\n");
    const violations = findMissingScopeQueries(DIR, RLS_TABLES);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'bad.js');
    assert.equal(violations[0].table, 'memberships');
    assert.equal(violations[0].line, 2);
});

test('findMissingScopeQueries: client.query() is never flagged -- a client is assumed already scoped by its caller', () => {
    write('ok.js', "async function roleOf(client, { tenantId }) {\n  return client.query('SELECT role FROM memberships WHERE tenant_id = $1', [tenantId]);\n}\n");
    assert.deepEqual(findMissingScopeQueries(DIR, RLS_TABLES), []);
});

test('findMissingScopeQueries: a pool.query() on a non-RLS table (e.g. tenants) is never flagged', () => {
    write('ok.js', "async function f(pool) {\n  return pool.query('SELECT id FROM tenants ORDER BY created_at');\n}\n");
    assert.deepEqual(findMissingScopeQueries(DIR, RLS_TABLES), []);
});

test('findMissingScopeQueries: pool.query() inside withScope\'s own callback is still flagged -- querying pool, not the scoped client, never runs under the scope', () => {
    write('bad.js', "async function f(pool) {\n  return withScope(pool, {}, async () => pool.query('SELECT * FROM memberships'));\n}\n");
    assert.equal(findMissingScopeQueries(DIR, RLS_TABLES).length, 1);
});

test('findMissingScopeQueries: the real server/lib has zero violations today', () => {
    assert.deepEqual(findMissingScopeQueries(path.join(__dirname, '..', 'lib'), RLS_TABLES), []);
});
