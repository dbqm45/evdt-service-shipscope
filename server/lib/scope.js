/**
 * Row-Level Security scoping. Every query against an RLS table (RLS_TABLES below) must run inside
 * withScope(), which opens a transaction and sets app.current_tenant_id / app.current_user_id with
 * set_config(..., is_local = true). Transaction-local settings end at COMMIT/ROLLBACK by themselves,
 * so a pooled connection can never carry one request's tenant into the next request -- the leak
 * test/rls.test.js documents for session-level set_config cannot happen through this path.
 */

/**
 * Every table migration 002 (and the ones that followed it) put under Row-Level Security -- the one place
 * this list lives, instead of only in CLAUDE.md's prose and a second hardcoded copy in a test. An unscoped
 * read against one of these returns zero rows; an unscoped write fails outright (RLS error) -- the
 * database's own fail-safe, which lib/withscope-guard.js adds a second, visible-at-review-time guard on top
 * of (design-docs/REPORT_ARCH.md, Problem 6).
 */
const RLS_TABLES = [
    'memberships', 'invitations', 'github_installations', 'tracked_repos', 'deployments', 'issue_deployments',
    'flag_sources', 'ingest_tokens', 'flags', 'flag_values', 'flag_value_history', 'jira_connections', 'jira_boards',
    'jira_pis', 'jira_issues',
];

/**
 * Sets the RLS scope for the rest of the current transaction. Must be called after BEGIN.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId?: string, userId?: string, inviteTokenHash?: string, ingestTokenHash?: string }} scope
 * @returns {Promise<void>}
 */
async function setScope(client, { tenantId, userId, inviteTokenHash, ingestTokenHash }) {
    if (tenantId !== undefined) await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    if (userId !== undefined) await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    if (inviteTokenHash !== undefined) await client.query("SELECT set_config('app.invite_token_hash', $1, true)", [inviteTokenHash]);
    if (ingestTokenHash !== undefined) await client.query("SELECT set_config('app.ingest_token_hash', $1, true)", [ingestTokenHash]);
}

/**
 * Runs fn inside one transaction scoped to the given tenant and/or user; commits on success, rolls
 * back and rethrows on failure, and always releases the client.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {{ tenantId?: string, userId?: string, inviteTokenHash?: string, ingestTokenHash?: string }} scope
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withScope(pool, scope, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setScope(client, scope);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { setScope, withScope, RLS_TABLES };
