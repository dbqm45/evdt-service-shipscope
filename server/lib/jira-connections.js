const { recordSecretEvent } = require('./secret-audit');
const { withScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');
const { seal, open, SecretBoxError } = require('./secret-box');
const { sealFor, openWith, isSealedFor, SealedBoxError } = require('./sealed-box');
const { requestSync } = require('./webhooks');
const { AtlassianError, refreshAccessToken, fetchProjects } = require('./atlassian');

/**
 * FR-007: a tenant's Jira connection (migration 009). The refresh token is sealed with the tenant id as
 * associated data, so it only ever opens for that tenant. Using the connection refreshes the access token under
 * a row lock: Atlassian rotates refresh tokens, and two concurrent refreshes with the same token would leave one
 * caller holding a token that no longer works.
 */

class JiraNotConnectedError extends Error {}
class JiraSiteError extends Error {}
/** The web service asked the worker for a Jira access token and got no answer in time. */
class WorkerUnavailableError extends Error {}

// A cached access token is used while it has at least this long left; the web service waits this long for the worker.
const GRANT_MARGIN_MS = 60_000;
const GRANT_WAIT_MS = 15_000;
const GRANT_POLL_MS = 250;

/**
 * Seals a Jira refresh token: for the worker alone when `atlassian.sealingKeys` has a public key (lib/sealed-box.js),
 * else with TOKEN_ENCRYPTION_KEY. Bound to the tenant either way.
 *
 * @param {{ encryptionKey: object, sealingKeys?: { publicKey: object }|null }} atlassian
 * @param {string} refreshToken
 * @param {string} tenantId
 * @returns {string}
 */
function sealRefreshToken(atlassian, refreshToken, tenantId) {
    return atlassian.sealingKeys && atlassian.sealingKeys.publicKey ? sealFor(atlassian.sealingKeys.publicKey, refreshToken, tenantId) : seal(atlassian.encryptionKey, refreshToken, tenantId);
}

const ERROR_MAX_LENGTH = 300;

/**
 * Stores (or replaces) the tenant's connection after a successful OAuth round trip. Admins only. With exactly
 * one site it is chosen right away; with several, an admin picks one (selectSite); a reconnect keeps the chosen
 * site when the grant still covers it.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, refreshToken: string, scopes: string[], sites: Array<{ cloudId: string, url: string, name: string }>, encryptionKey: Buffer }} input
 * @returns {Promise<{ siteChosen: boolean }>}
 */
async function saveConnection(pool, { tenantId, actorUserId, refreshToken, scopes, sites, encryptionKey, sealingKeys = null }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [previous] } = await client.query('SELECT cloud_id FROM jira_connections WHERE tenant_id = $1', [tenantId]);
        const site = sites.length === 1 ? sites[0] : sites.find((s) => s.cloudId === previous?.cloud_id) || null;
        await client.query(
            `INSERT INTO jira_connections (tenant_id, refresh_token_enc, scopes, available_sites, cloud_id, site_url, site_name, connected_by, connected_at, last_error)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), NULL)
             ON CONFLICT (tenant_id) DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc, scopes = EXCLUDED.scopes,
                 available_sites = EXCLUDED.available_sites, cloud_id = EXCLUDED.cloud_id, site_url = EXCLUDED.site_url,
                 site_name = EXCLUDED.site_name, connected_by = EXCLUDED.connected_by, connected_at = now(), last_error = NULL`,
            [tenantId, sealRefreshToken({ encryptionKey, sealingKeys }, refreshToken, tenantId), scopes, JSON.stringify(sites), site?.cloudId ?? null, site?.url ?? null, site?.name ?? null, actorUserId]
        );
        if (previous && previous.cloud_id !== (site?.cloudId ?? null)) await forgetSiteData(client, tenantId);
        // A token handed over for the previous grant must not outlive it.
        await client.query('DELETE FROM jira_access_grants WHERE tenant_id = $1', [tenantId]);
        await recordSecretEvent(client, { tenantId, actorUserId, kind: 'jira_connected', subject: site?.name ?? null });
        return { siteChosen: Boolean(site) };
    });
}

/**
 * The tenant's connection as members see it; `sites` (to choose from) only while no site is chosen. Never any token.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<{ connected: false }|{ connected: true, site: { cloudId: string, url: string, name: string }|null, sites?: object[], connectedAt: Date, lastError: string|null, currentPi: string|null, lastSyncedAt: Date|null, rateLimitedUntil: Date|null, webhook: { active: boolean, expiresAt: Date|null, error: string|null } }>}
 *   webhook.active: Jira tells ShipScope about issue changes right away (else only the periodic sync); flagLink: how
 *   issues name their feature flags (lib/jira-sync.js setFlagLink()), or null
 * @throws {TenantNotFoundError}
 */
async function getConnection(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows: [row] } = await client.query(
            `SELECT available_sites, cloud_id, site_url, site_name, connected_at, last_error, current_pi, last_synced_at,
                    webhook_ids, webhook_expires_at, webhook_error, flag_link,
                    CASE WHEN rate_limited_until > now() THEN rate_limited_until END AS rate_limited_until
             FROM jira_connections WHERE tenant_id = $1`,
            [tenantId]
        );
        if (!row) return { connected: false };
        const site = row.cloud_id ? { cloudId: row.cloud_id, url: row.site_url, name: row.site_name } : null;
        return {
            connected: true, site, ...(site ? {} : { sites: row.available_sites }), connectedAt: row.connected_at, lastError: row.last_error,
            currentPi: row.current_pi, lastSyncedAt: row.last_synced_at, rateLimitedUntil: row.rate_limited_until,
            webhook: {
                active: row.webhook_ids.length > 0 && row.webhook_expires_at !== null && row.webhook_expires_at > new Date(),
                expiresAt: row.webhook_expires_at,
                error: row.webhook_error,
            },
            flagLink: row.flag_link,
        };
    });
}

/**
 * Picks the Jira site, one of those the grant covers. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, cloudId: string }} input
 * @returns {Promise<{ cloudId: string, url: string, name: string }>}
 * @throws {JiraNotConnectedError|JiraSiteError}
 */
async function selectSite(pool, { tenantId, actorUserId, cloudId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [row] } = await client.query('SELECT available_sites FROM jira_connections WHERE tenant_id = $1', [tenantId]);
        if (!row) throw new JiraNotConnectedError('Jira is not connected');
        const site = row.available_sites.find((s) => s.cloudId === cloudId);
        if (!site) throw new JiraSiteError('That Jira site is not one this connection covers');
        const { rows: [before] } = await client.query('SELECT cloud_id FROM jira_connections WHERE tenant_id = $1', [tenantId]);
        await client.query('UPDATE jira_connections SET cloud_id = $2, site_url = $3, site_name = $4 WHERE tenant_id = $1', [tenantId, site.cloudId, site.url, site.name]);
        if (before.cloud_id !== site.cloudId) await forgetSiteData(client, tenantId);
        return site;
    });
}

/** Board ids and synced issues belong to one site: switching sites starts over (migration 010). */
async function forgetSiteData(client, tenantId) {
    await client.query('DELETE FROM jira_boards WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM jira_pis WHERE tenant_id = $1', [tenantId]); // and, by cascade, their issues
    // The webhook belongs to the old site too; that site stops calling once Atlassian's 30 days run out.
    await client.query(
        "UPDATE jira_connections SET current_pi = NULL, last_synced_at = NULL, webhook_ids = '{}', webhook_jql = NULL, webhook_expires_at = NULL, webhook_error = NULL WHERE tenant_id = $1",
        [tenantId]
    );
}

/**
 * Forgets the connection (and its token). Admins only. The grant stays listed under the user's Atlassian account
 * ("Connected apps") until they remove it there.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<boolean>} false if there was none
 */
async function disconnect(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rowCount } = await client.query('DELETE FROM jira_connections WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM jira_access_grants WHERE tenant_id = $1', [tenantId]);
        if (rowCount) await recordSecretEvent(client, { tenantId, actorUserId, kind: 'jira_disconnected' });
        return rowCount === 1;
    });
}

/**
 * A fresh access token for the tenant's chosen site. Refreshes under the connection row's lock and stores the
 * rotated refresh token; a grant that no longer works is recorded in `last_error` (kept even though the caller
 * gets the error) and reported as JiraNotConnectedError.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, atlassian: { clientId: string, clientSecret: string, encryptionKey: Buffer }, fetch?: typeof fetch }} input
 * @returns {Promise<{ accessToken: string, cloudId: string }>}
 * @throws {JiraNotConnectedError|AtlassianError}
 */
async function accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn = fetch }) {
    const privateKeys = (atlassian.sealingKeys && atlassian.sealingKeys.privateKeys) || [];
    if (!privateKeys.length) {
        const { rows: [row] } = await withScope(pool, { tenantId }, (client) => client.query('SELECT refresh_token_enc FROM jira_connections WHERE tenant_id = $1', [tenantId]));
        if (row && isSealedFor(row.refresh_token_enc)) return accessTokenViaWorker(pool, { tenantId, atlassian });
    }
    return mintAccessToken(pool, { tenantId, atlassian, fetch: fetchFn });
}

/** The refresh itself, where the refresh token can be opened (the worker, or anywhere without a sealing key pair). */
async function mintAccessToken(pool, { tenantId, atlassian, fetch: fetchFn = fetch }) {
    const privateKeys = (atlassian.sealingKeys && atlassian.sealingKeys.privateKeys) || [];
    let failure = null;
    const result = await withScope(pool, { tenantId }, async (client) => {
        const { rows: [row] } = await client.query(
            'SELECT refresh_token_enc, cloud_id FROM jira_connections WHERE tenant_id = $1 FOR UPDATE',
            [tenantId]
        );
        if (!row) throw new JiraNotConnectedError('Jira is not connected');
        if (!row.cloud_id) throw new JiraNotConnectedError('Choose which Jira site to use first');
        let refreshToken;
        try {
            refreshToken = isSealedFor(row.refresh_token_enc)
                ? openWith(privateKeys, row.refresh_token_enc, tenantId)
                : open(atlassian.encryptionKey, row.refresh_token_enc, tenantId);
        } catch (err) {
            if (!(err instanceof SecretBoxError || err instanceof SealedBoxError)) throw err;
            failure = 'The stored Jira token cannot be read (was TOKEN_ENCRYPTION_KEY changed?); connect Jira again';
            return null;
        }
        let tokens;
        try {
            tokens = await refreshAccessToken({ clientId: atlassian.clientId, clientSecret: atlassian.clientSecret, refreshToken, fetch: fetchFn });
        } catch (err) {
            if (!(err instanceof AtlassianError) || !err.reconnect) throw err;
            failure = 'Jira access was revoked or has expired; connect Jira again';
            return null;
        }
        await client.query(
            'UPDATE jira_connections SET refresh_token_enc = $2, last_error = NULL WHERE tenant_id = $1',
            [tenantId, sealRefreshToken(atlassian, tokens.refreshToken || refreshToken, tenantId)]
        );
        return { accessToken: tokens.accessToken, cloudId: row.cloud_id, expiresIn: tokens.expiresIn };
    });
    if (result) return result;
    // Recorded in its own transaction: the one above ended without a token to return.
    await withScope(pool, { tenantId }, (client) => client.query(
        'UPDATE jira_connections SET last_error = $2 WHERE tenant_id = $1',
        [tenantId, failure.slice(0, ERROR_MAX_LENGTH)]
    ));
    throw new JiraNotConnectedError(failure);
}

/** A grant row that can be used now: a token with time left, issued after `since` when given. */
function usableGrant(row, { now, since = null }) {
    return row && row.access_token_enc && row.expires_at && row.expires_at - now > GRANT_MARGIN_MS && (!since || row.updated_at >= since);
}

/**
 * Where the web service cannot open the refresh token: a cached access token the worker minted, or a fresh one asked
 * for through sync_requests (`jira-token`) and waited for (GRANT_WAIT_MS).
 *
 * @throws {JiraNotConnectedError} the worker could not refresh the grant (the reason it recorded)
 * @throws {WorkerUnavailableError} no answer in time
 */
async function accessTokenViaWorker(pool, { tenantId, atlassian, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const read = () => withScope(pool, { tenantId }, async (client) => (await client.query(
        'SELECT access_token_enc, cloud_id, expires_at, error, updated_at FROM jira_access_grants WHERE tenant_id = $1', [tenantId]
    )).rows[0]);
    const take = (row) => ({ accessToken: open(atlassian.encryptionKey, row.access_token_enc, `${tenantId}/jira-access`), cloudId: row.cloud_id });
    const cached = await read();
    if (usableGrant(cached, { now: now() })) return take(cached);
    const asked = (await pool.query('SELECT now() AS at')).rows[0].at;
    await requestSync(pool, { source: 'jira-token', keys: [tenantId] });
    for (let waited = 0; waited < GRANT_WAIT_MS; waited += GRANT_POLL_MS) {
        await sleep(GRANT_POLL_MS);
        const row = await read();
        if (row && row.updated_at >= asked) {
            if (row.error) throw new JiraNotConnectedError(row.error);
            if (usableGrant(row, { now: now() })) return take(row);
        }
    }
    throw new WorkerUnavailableError('The worker did not hand over a Jira token in time; try again shortly');
}

/**
 * The worker's side: refreshes the tenant's grant and leaves a short-lived access token for the web service (sealed
 * with TOKEN_ENCRYPTION_KEY, until it expires), or why it could not.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, atlassian: object, fetch?: typeof fetch, now?: Date }} input
 * @returns {Promise<boolean>} whether a token was handed over
 */
async function handOverAccessToken(pool, { tenantId, atlassian, fetch: fetchFn = fetch, now = new Date() }) {
    let grant;
    let error = null;
    try {
        grant = await mintAccessToken(pool, { tenantId, atlassian, fetch: fetchFn });
    } catch (err) {
        if (!(err instanceof JiraNotConnectedError || err instanceof AtlassianError)) throw err;
        error = err instanceof JiraNotConnectedError ? err.message : 'Jira did not answer; try again shortly';
    }
    await withScope(pool, { tenantId }, (client) => client.query(
        `INSERT INTO jira_access_grants (tenant_id, access_token_enc, cloud_id, expires_at, error, updated_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (tenant_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, cloud_id = EXCLUDED.cloud_id,
             expires_at = EXCLUDED.expires_at, error = EXCLUDED.error, updated_at = now()`,
        grant
            ? [tenantId, seal(atlassian.encryptionKey, grant.accessToken, `${tenantId}/jira-access`), grant.cloudId, new Date(now.getTime() + grant.expiresIn * 1000), null]
            : [tenantId, null, null, null, String(error).slice(0, ERROR_MAX_LENGTH)]
    ));
    return Boolean(grant);
}

/**
 * The connected site's projects (what FR-008 will choose from). Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, atlassian: object, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ id: string, key: string, name: string }>>}
 * @throws {JiraNotConnectedError|AtlassianError}
 */
async function listProjects(pool, { tenantId, actorUserId, atlassian, fetch: fetchFn = fetch }) {
    await withScope(pool, { tenantId }, (client) => assertAdmin(client, { tenantId, userId: actorUserId }));
    const { accessToken, cloudId } = await accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn });
    return fetchProjects({ accessToken, cloudId, fetch: fetchFn });
}

module.exports = { WorkerUnavailableError, accessTokenViaWorker, handOverAccessToken, sealRefreshToken, JiraNotConnectedError, JiraSiteError, saveConnection, getConnection, selectSite, disconnect, accessTokenFor, listProjects };
