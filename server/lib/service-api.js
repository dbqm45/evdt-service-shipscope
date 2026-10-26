// Service API (F5 of the pdi one-flow plan, design-docs/F5-API-PLAN.pl.md): read-only tokens per workspace for other
// services (pdi, tf, a CI script), an item's status per environment and the PROD metrics per day. Status and lead
// time come from the dashboard's own scripts (lib/release-status.js), so they say exactly what the dashboard shows.
const crypto = require('crypto');
const { withScope, setScope } = require('./scope');
const { assertAdmin } = require('./tenants');
const { recordAuditEvent } = require('./audit-log');
const { readDashboardData } = require('./dashboard-data');
const { readWorkItems } = require('./work-items');
const { workItemIssues, WORK_ITEM_KEY } = require('./work-items-model');
const { itemStatus, leadTimes } = require('./release-status');

const TOKEN_PREFIX = 'shps_';
const TOKEN_PATTERN = /^shps_[A-Za-z0-9_-]{43}$/;
const MAX_TOKENS = 10;
const DEFAULT_LIFETIME_DAYS = 365;
const MAX_LIFETIME_DAYS = 730;
const DEFAULT_RANGE_DAYS = 90;
const MAX_RANGE_DAYS = 400;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400_000;
const CSV_COLUMNS = ['date', 'deployments', 'failed_deployments', 'rollbacks', 'lead_time_days_median', 'lead_time_count'];

class ServiceTokenError extends Error {}
class ServiceAuthError extends Error {}
class ServiceRequestError extends Error {}
class ServiceNotFoundError extends Error {}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Creates a token; it is returned once and only its hash is stored. Admins only; audited (the name, never the token).
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, name: string, lifetimeDays?: number|null, now?: Date }} input
 * @returns {Promise<{ id: string, name: string, token: string, expiresAt: string|null }>}
 * @throws {ServiceTokenError} a bad name or lifetime, or the limit reached
 */
async function createServiceToken(pool, { tenantId, actorUserId, name, lifetimeDays = DEFAULT_LIFETIME_DAYS, now = new Date() }) {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean || clean.length > 100) throw new ServiceTokenError('A token needs a name of 1–100 characters');
    if (lifetimeDays !== null && (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > MAX_LIFETIME_DAYS)) {
        throw new ServiceTokenError(`A token lives 1–${MAX_LIFETIME_DAYS} days, or without end (null)`);
    }
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const expiresAt = lifetimeDays === null ? null : new Date(now.getTime() + lifetimeDays * DAY_MS);
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM service_tokens WHERE tenant_id = $1', [tenantId]);
        if (n >= MAX_TOKENS) throw new ServiceTokenError(`A workspace has at most ${MAX_TOKENS} service tokens`);
        const { rows: [row] } = await client.query(
            'INSERT INTO service_tokens (tenant_id, name, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [tenantId, clean, hashToken(token), actorUserId, expiresAt]
        );
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'service_token_created', subject: clean });
        return { id: row.id, name: clean, token, expiresAt: expiresAt && expiresAt.toISOString() };
    });
}

/**
 * The workspace's tokens, without the token. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<{ id: string, name: string, createdAt: string, expiresAt: string|null, lastUsedAt: string|null }>>}
 */
async function listServiceTokens(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query('SELECT id, name, created_at, expires_at, last_used_at FROM service_tokens WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
        const iso = (d) => (d ? d.toISOString() : null);
        return rows.map((r) => ({ id: r.id, name: r.name, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), lastUsedAt: iso(r.last_used_at) }));
    });
}

/**
 * Revokes a token at once. Admins only; audited.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, id: string }} input
 * @returns {Promise<boolean>} whether there was one
 */
async function revokeServiceToken(pool, { tenantId, actorUserId, id }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query('DELETE FROM service_tokens WHERE tenant_id = $1 AND id = $2 RETURNING name', [tenantId, id]);
        if (!rows.length) return false;
        await recordAuditEvent(client, { tenantId, actorUserId, kind: 'service_token_revoked', subject: rows[0].name });
        return true;
    });
}

/**
 * Runs fn in one transaction under the token's workspace: the token row is found through its own RLS policy, its
 * expiry checked and its use noted.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {{ token: string, now?: Date }} input
 * @param {(client: import('pg').PoolClient, tenantId: string) => Promise<T>} fn
 * @returns {Promise<T>}
 * @throws {ServiceAuthError} unknown, malformed or expired token
 */
async function withServiceToken(pool, { token, now = new Date() }, fn) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new ServiceAuthError('A service token is required');
    return withScope(pool, { serviceTokenHash: hashToken(token) }, async (client) => {
        const { rows } = await client.query('SELECT id, tenant_id, expires_at FROM service_tokens WHERE token_hash = $1', [hashToken(token)]);
        if (!rows.length) throw new ServiceAuthError('Unknown service token');
        const { id, tenant_id: tenantId, expires_at: expiresAt } = rows[0];
        if (expiresAt && expiresAt <= now) throw new ServiceAuthError('The service token has expired');
        await setScope(client, { tenantId, serviceTokenHash: '' });
        await client.query('UPDATE service_tokens SET last_used_at = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, id, now]);
        return fn(client, tenantId);
    });
}

/** The item in the jira-issues shape: the newest synced copy of a Jira issue, else a work item from a repo. */
async function findItem(client, tenantId, key) {
    const { rows } = await client.query('SELECT data FROM jira_issues WHERE tenant_id = $1 AND key = $2 ORDER BY synced_at DESC LIMIT 1', [tenantId, key]);
    if (rows.length) return { issue: rows[0].data, source: 'jira' };
    const work = workItemIssues(await readWorkItems(client, tenantId)).find((i) => i.key === key);
    return work ? { issue: work, source: 'repo' } : null;
}

/**
 * An item's status per environment as the dashboard shows it.
 *
 * @param {import('pg').Pool} pool
 * @param {{ token: string, key: string, now?: Date }} input
 * @returns {Promise<{ key: string, title: string, type: string, source: 'jira'|'repo', envs: object, firstProdAt: string|null, releasedOnProd: boolean }>}
 * @throws {ServiceAuthError|ServiceRequestError|ServiceNotFoundError}
 */
async function serviceItemStatus(pool, { token, key, now = new Date() }) {
    if (typeof key !== 'string' || !WORK_ITEM_KEY.test(key)) throw new ServiceRequestError('An item key looks like PAY-12 or CHG-12');
    return withServiceToken(pool, { token, now }, async (client, tenantId) => {
        const found = await findItem(client, tenantId, key);
        if (!found) throw new ServiceNotFoundError(`No item ${key}`);
        const data = await readDashboardData(client, { tenantId });
        const status = itemStatus(data, found.issue, { now });
        return { key, title: found.issue.title, type: found.issue.type, source: found.source, ...status };
    });
}

function parseDay(value, name) {
    if (!DATE.test(value)) throw new ServiceRequestError(`${name} must be a date RRRR-MM-DD`);
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new ServiceRequestError(`${name} is not a real date`);
    return d;
}

const median = (values) => {
    if (!values.length) return null;
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};

/**
 * PROD metrics per day (UTC) over a range: deployments, failed deployments, rollbacks and the median lead time from
 * Jira resolution to the first PROD deployment of the items that reached PROD that day.
 *
 * @param {import('pg').Pool} pool
 * @param {{ token: string, from?: string, to?: string, now?: Date }} input
 * @returns {Promise<{ environment: 'prod', from: string, to: string, days: Array<{ date: string, deployments: number, failedDeployments: number, rollbacks: number, leadTimeDaysMedian: number|null, leadTimeCount: number }> }>}
 * @throws {ServiceAuthError|ServiceRequestError}
 */
async function serviceMetrics(pool, { token, from, to, now = new Date() }) {
    const end = to ? parseDay(to, 'to') : new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    const start = from ? parseDay(from, 'from') : new Date(end.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
    if (start > end) throw new ServiceRequestError('from must not be after to');
    const span = Math.round((end - start) / DAY_MS) + 1;
    if (span > MAX_RANGE_DAYS) throw new ServiceRequestError(`At most ${MAX_RANGE_DAYS} days at a time`);
    return withServiceToken(pool, { token, now }, async (client, tenantId) => {
        const data = await readDashboardData(client, { tenantId });
        const { rows } = await client.query('SELECT DISTINCT ON (key) data FROM jira_issues WHERE tenant_id = $1 ORDER BY key, synced_at DESC', [tenantId]);
        const days = new Map();
        for (let i = 0; i < span; i++) {
            const date = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
            days.set(date, { date, deployments: 0, failedDeployments: 0, rollbacks: 0, lead: [] });
        }
        for (const d of data.deployments) {
            if (d.environment !== 'prod' || !d.deployedAt) continue;
            const day = days.get(new Date(d.deployedAt).toISOString().slice(0, 10));
            if (!day) continue;
            if (d.status === 'failed') day.failedDeployments++;
            else day.deployments++;
            if (d.rollback) day.rollbacks++;
        }
        for (const l of leadTimes(data, rows.map((r) => r.data), { now })) {
            const day = days.get(l.firstProdAt.slice(0, 10));
            if (day) day.lead.push(l.days);
        }
        return {
            environment: 'prod',
            from: start.toISOString().slice(0, 10),
            to: end.toISOString().slice(0, 10),
            days: [...days.values()].map(({ lead, ...day }) => ({ ...day, leadTimeDaysMedian: median(lead), leadTimeCount: lead.length })),
        };
    });
}

/**
 * The metrics as CSV with a header, the shape tf's control_band.py reads (`--column rollbacks`); an empty cell where
 * a day has no lead time.
 *
 * @param {{ days: Array<object> }} metrics
 * @returns {string}
 */
function metricsCsv({ days }) {
    const lines = days.map((d) => [d.date, d.deployments, d.failedDeployments, d.rollbacks, d.leadTimeDaysMedian ?? '', d.leadTimeCount].join(','));
    return `${CSV_COLUMNS.join(',')}\n${lines.join('\n')}\n`;
}

module.exports = {
    MAX_TOKENS, ServiceTokenError, ServiceAuthError, ServiceRequestError, ServiceNotFoundError,
    createServiceToken, listServiceTokens, revokeServiceToken, serviceItemStatus, serviceMetrics, metricsCsv,
};
