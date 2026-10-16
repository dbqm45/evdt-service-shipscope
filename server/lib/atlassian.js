/**
 * Atlassian OAuth 2.0 (3LO) and the Jira Cloud REST calls ShipScope makes with it (FR-007). Every response is
 * checked for the fields read before they are used (CLAUDE.md: validate third-party API responses).
 *
 * Tokens: the access token lives about an hour and is never stored; the refresh token (`offline_access`) is
 * stored encrypted (lib/jira-connections.js). Atlassian rotates refresh tokens: a refresh returns a new one
 * that must replace the stored one.
 */

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const API_BASE = 'https://api.atlassian.com/ex/jira';
// Read-only: issues, users (assignees), boards and sprints (PI/sprint resolution); offline_access for a refresh
// token, so the worker can sync without the user present.
const SCOPES = ['read:jira-work', 'read:jira-user', 'read:board-scope:jira-software', 'read:sprint:jira-software', 'offline_access'];
const REQUIRED_SITE_SCOPE = 'read:jira-work';
const MAX_PAGES = 20;

class AtlassianError extends Error {
    /** @param {string} message @param {{ reconnect?: boolean }} [options] reconnect: the stored grant is no longer valid */
    constructor(message, { reconnect = false } = {}) {
        super(message);
        this.reconnect = reconnect;
    }
}

/**
 * @param {{ clientId: string, redirectUri: string, state: string }} input
 * @returns {string}
 */
function buildAuthorizeUrl({ clientId, redirectUri, state }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('audience', 'api.atlassian.com');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('prompt', 'consent');
    return url.toString();
}

async function tokenRequest(body, fetchFn) {
    let res;
    try {
        res = await fetchFn(TOKEN_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (err) {
        throw new AtlassianError(`token request failed: ${err.message}`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
        const code = typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`;
        // 4xx on a refresh means the grant itself is gone (revoked, expired after 90 days unused, rotated
        // elsewhere): retrying won't help, the admin has to connect again.
        throw new AtlassianError(`token request rejected: ${code}`, { reconnect: res.status >= 400 && res.status < 500 });
    }
    if (typeof json?.access_token !== 'string' || !json.access_token) throw new AtlassianError('token response has no access_token');
    return {
        accessToken: json.access_token,
        refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
        scopes: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [],
    };
}

/**
 * @param {{ clientId: string, clientSecret: string, code: string, redirectUri: string, fetch?: typeof fetch }} input
 * @returns {Promise<{ accessToken: string, refreshToken: string|null, scopes: string[] }>}
 * @throws {AtlassianError}
 */
function exchangeCode({ clientId, clientSecret, code, redirectUri, fetch: fetchFn = fetch }) {
    return tokenRequest({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }, fetchFn);
}

/**
 * @param {{ clientId: string, clientSecret: string, refreshToken: string, fetch?: typeof fetch }} input
 * @returns {Promise<{ accessToken: string, refreshToken: string|null, scopes: string[] }>} refreshToken: the rotated one, to store
 * @throws {AtlassianError} with `reconnect` when the grant is no longer valid
 */
function refreshAccessToken({ clientId, clientSecret, refreshToken, fetch: fetchFn = fetch }) {
    return tokenRequest({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }, fetchFn);
}

async function getJson(url, accessToken, fetchFn) {
    let res;
    try {
        res = await fetchFn(url, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } });
    } catch (err) {
        throw new AtlassianError(`GET ${new URL(url).pathname} failed: ${err.message}`);
    }
    if (!res.ok) throw new AtlassianError(`GET ${new URL(url).pathname} failed with HTTP ${res.status}`, { reconnect: res.status === 401 });
    return res.json();
}

/**
 * The Jira Cloud sites the grant covers that ShipScope can read issues on.
 *
 * @param {{ accessToken: string, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ cloudId: string, url: string, name: string }>>}
 * @throws {AtlassianError}
 */
async function fetchJiraSites({ accessToken, fetch: fetchFn = fetch }) {
    const body = await getJson(RESOURCES_URL, accessToken, fetchFn);
    if (!Array.isArray(body)) throw new AtlassianError('accessible-resources response is not a list');
    return body
        .filter((r) => typeof r?.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(r.id)
            && typeof r.url === 'string' && /^https:\/\//.test(r.url) && typeof r.name === 'string'
            && Array.isArray(r.scopes) && r.scopes.includes(REQUIRED_SITE_SCOPE))
        .map((r) => ({ cloudId: r.id, url: r.url, name: r.name.slice(0, 200) }));
}

/**
 * The site's Jira projects the user who connected can see.
 *
 * @param {{ accessToken: string, cloudId: string, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ id: string, key: string, name: string }>>}
 * @throws {AtlassianError}
 */
async function fetchProjects({ accessToken, cloudId, fetch: fetchFn = fetch }) {
    const projects = [];
    for (let page = 0, startAt = 0; page < MAX_PAGES; page++) {
        const body = await getJson(`${API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/project/search?startAt=${startAt}&maxResults=50`, accessToken, fetchFn);
        if (!Array.isArray(body?.values)) throw new AtlassianError('project search response has no values list');
        for (const p of body.values) {
            if (typeof p?.id === 'string' && typeof p.key === 'string' && typeof p.name === 'string') projects.push({ id: p.id, key: p.key, name: p.name });
        }
        if (body.isLast !== false || body.values.length === 0) break;
        startAt += body.values.length;
    }
    return projects;
}

module.exports = { SCOPES, AtlassianError, buildAuthorizeUrl, exchangeCode, refreshAccessToken, fetchJiraSites, fetchProjects };
