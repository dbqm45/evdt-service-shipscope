// Is a restored copy of the database usable? (ROADMAP, Niezawodność: backups with a periodic restore test,
// server/KOPIE.pl.md.) Run against the copy Render's point-in-time recovery or a logical export produced, before any
// service points at it: every migration applied, every tenant table under row-level security, the data as of when,
// and -- with the keys -- whether the stored secrets still open. Read only: it never writes to the copy.
const { withScope, RLS_TABLES } = require('./scope');
const { open, SecretBoxError } = require('./secret-box');
const { openWith, isSealedFor, SealedBoxError } = require('./sealed-box');
const { endpointTokenAad } = require('./flags');
const { signingSecretAad } = require('./endpoint-flags');

// Counted per tenant, under its scope (an unscoped count of an RLS table is always 0).
const COUNTED = ['memberships', 'tracked_repos', 'deployments', 'flag_sources', 'flags', 'flag_values', 'jira_issues', 'audit_events'];

/**
 * Reads what judgeRestore() needs from the copy.
 *
 * @param {import('pg').Pool} pool connected to the restored copy
 * @param {{ encryptionKey?: Buffer|{ current: Buffer, previous: Buffer[] }|null, sealingKeys?: { privateKeys: object[] }|null }} [keys]
 *   TOKEN_ENCRYPTION_KEY(_PREVIOUS) and the worker's SECRETS_PRIVATE_KEY(_PREVIOUS); without them secrets are not tried
 * @returns {Promise<{ migrations: string[], rls: Array<{ table: string, exists: boolean, enabled: boolean, forced: boolean }>, tenants: number, counts: Record<string, number>, newest: Record<string, Date|null>, secrets: { readable: number, unreadable: number, untried: number } }>}
 */
async function collectRestoreFacts(pool, { encryptionKey = null, sealingKeys = null } = {}) {
    const { rows: migrationRows } = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename").catch(() => ({ rows: [] }));
    const rls = [];
    for (const table of RLS_TABLES) {
        const { rows: [row] } = await pool.query(
            'SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced FROM pg_class c WHERE c.oid = to_regclass($1)', [table]
        );
        rls.push({ table, exists: Boolean(row), enabled: Boolean(row && row.enabled), forced: Boolean(row && row.forced) });
    }
    const { rows: tenants } = await pool.query('SELECT id FROM tenants ORDER BY created_at').catch(() => ({ rows: [] }));
    const counts = Object.fromEntries(COUNTED.map((t) => [t, 0]));
    const newest = { deployment: null, flagChange: null, auditEvent: null };
    const secrets = { readable: 0, unreadable: 0, untried: 0 };
    const later = (a, b) => (!a || (b && b > a) ? b : a);
    const tryOpen = (sealed, aad) => {
        if (!sealed) return;
        const sealedForWorker = isSealedFor(sealed);
        if (sealedForWorker ? !(sealingKeys && sealingKeys.privateKeys && sealingKeys.privateKeys.length) : !encryptionKey) {
            secrets.untried += 1;
            return;
        }
        try {
            if (sealedForWorker) openWith(sealingKeys.privateKeys, sealed, aad);
            else open(encryptionKey, sealed, aad);
            secrets.readable += 1;
        } catch (err) {
            if (!(err instanceof SecretBoxError || err instanceof SealedBoxError)) throw err;
            secrets.unreadable += 1;
        }
    };
    for (const { id: tenantId } of tenants) {
        await withScope(pool, { tenantId }, async (client) => {
            await client.query('SET TRANSACTION READ ONLY');
            for (const table of COUNTED) {
                const { rows: [{ n }] } = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
                counts[table] += n;
            }
            const { rows: [at] } = await client.query(
                `SELECT (SELECT max(deployed_at) FROM deployments WHERE tenant_id = $1) AS deployment,
                        (SELECT max(changed_at) FROM flag_value_history WHERE tenant_id = $1) AS flag_change,
                        (SELECT max(at) FROM audit_events WHERE tenant_id = $1) AS audit_event`,
                [tenantId]
            );
            newest.deployment = later(newest.deployment, at.deployment);
            newest.flagChange = later(newest.flagChange, at.flag_change);
            newest.auditEvent = later(newest.auditEvent, at.audit_event);
            const { rows: [jira] } = await client.query('SELECT refresh_token_enc FROM jira_connections WHERE tenant_id = $1', [tenantId]);
            if (jira) tryOpen(jira.refresh_token_enc, tenantId);
            const { rows: sources } = await client.query('SELECT id, endpoint_token_enc FROM flag_sources WHERE tenant_id = $1 AND endpoint_token_enc IS NOT NULL', [tenantId]);
            for (const s of sources) tryOpen(s.endpoint_token_enc, endpointTokenAad(tenantId, s.id));
            const { rows: [tenant] } = await client.query('SELECT endpoint_signing_secret_enc FROM tenants WHERE id = $1', [tenantId]);
            if (tenant) tryOpen(tenant.endpoint_signing_secret_enc, signingSecretAad(tenantId));
        });
    }
    return { migrations: migrationRows.map((r) => r.filename), rls, tenants: tenants.length, counts, newest, secrets };
}

/**
 * The verdict on a restored copy. Fails when a migration of this code is missing (or the copy has one this code does
 * not know: restored into an older checkout), when a tenant table is missing or not under forced row-level security,
 * or when a stored secret no longer opens with the keys given; warns when the copy holds no tenant, or when secrets
 * could not be tried for lack of keys.
 *
 * @param {Awaited<ReturnType<typeof collectRestoreFacts>>} facts
 * @param {{ expectedMigrations: string[] }} input the migration files of this checkout
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
function judgeRestore(facts, { expectedMigrations }) {
    const problems = [];
    const warnings = [];
    const applied = new Set(facts.migrations);
    const missing = expectedMigrations.filter((m) => !applied.has(m));
    const unknown = facts.migrations.filter((m) => !expectedMigrations.includes(m));
    if (missing.length) problems.push(`migrations not applied: ${missing.join(', ')}`);
    if (unknown.length) problems.push(`migrations this checkout does not have (restore with a newer one): ${unknown.join(', ')}`);
    for (const t of facts.rls) {
        if (!t.exists) problems.push(`table ${t.table} is missing`);
        else if (!t.enabled || !t.forced) problems.push(`table ${t.table} is not under forced row-level security`);
    }
    if (!facts.tenants) warnings.push('the copy holds no workspace');
    if (facts.secrets.unreadable) problems.push(`${facts.secrets.unreadable} stored secret(s) do not open with the keys given: restore the keys of that time too`);
    if (facts.secrets.untried) warnings.push(`${facts.secrets.untried} stored secret(s) not tried: give TOKEN_ENCRYPTION_KEY and SECRETS_PRIVATE_KEY to check them`);
    return { ok: problems.length === 0, problems, warnings };
}

module.exports = { COUNTED, collectRestoreFacts, judgeRestore };
