const { withScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');
const { seal, open, SecretBoxError } = require('./secret-box');
const { AtlassianError, refreshAccessToken, fetchProjects } = require('./atlassian');

/**
 * FR-007: a tenant's Jira connection (migration 009). The refresh token is sealed with the tenant id as
 * associated data, so it only ever opens for that tenant. Using the connection refreshes the access token under
 * a row lock: Atlassian rotates refresh tokens, and two concurrent refreshes with the same token would leave one
 * caller holding a token that no longer works.
 */

class JiraNotConnectedError extends Error {}
class JiraSiteError extends Error {}

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
async function saveConnection(pool, { tenantId, actorUserId, refreshToken, scopes, sites, encryptionKey }) {
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
            [tenantId, seal(encryptionKey, refreshToken, tenantId), scopes, JSON.stringify(sites), site?.cloudId ?? null, site?.url ?? null, site?.name ?? null, actorUserId]
        );
        return { siteChosen: Boolean(site) };
    });
}

/**
 * The tenant's connection as members see it; `sites` (to choose from) only while no site is chosen. Never any token.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<{ connected: false }|{ connected: true, site: { cloudId: string, url: string, name: string }|null, sites?: object[], connectedAt: Date, lastError: string|null }>}
 * @throws {TenantNotFoundError}
 */
async function getConnection(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows: [row] } = await client.query(
            'SELECT available_sites, cloud_id, site_url, site_name, connected_at, last_error FROM jira_connections WHERE tenant_id = $1',
            [tenantId]
        );
        if (!row) return { connected: false };
        const site = row.cloud_id ? { cloudId: row.cloud_id, url: row.site_url, name: row.site_name } : null;
        return { connected: true, site, ...(site ? {} : { sites: row.available_sites }), connectedAt: row.connected_at, lastError: row.last_error };
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
        await client.query('UPDATE jira_connections SET cloud_id = $2, site_url = $3, site_name = $4 WHERE tenant_id = $1', [tenantId, site.cloudId, site.url, site.name]);
        return site;
    });
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
            refreshToken = open(atlassian.encryptionKey, row.refresh_token_enc, tenantId);
        } catch (err) {
            if (!(err instanceof SecretBoxError)) throw err;
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
            [tenantId, seal(atlassian.encryptionKey, tokens.refreshToken || refreshToken, tenantId)]
        );
        return { accessToken: tokens.accessToken, cloudId: row.cloud_id };
    });
    if (result) return result;
    // Recorded in its own transaction: the one above ended without a token to return.
    await withScope(pool, { tenantId }, (client) => client.query(
        'UPDATE jira_connections SET last_error = $2 WHERE tenant_id = $1',
        [tenantId, failure.slice(0, ERROR_MAX_LENGTH)]
    ));
    throw new JiraNotConnectedError(failure);
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

module.exports = { JiraNotConnectedError, JiraSiteError, saveConnection, getConnection, selectSite, disconnect, accessTokenFor, listProjects };
