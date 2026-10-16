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
// Read-only: issues, users (assignees), boards and sprints (PI/sprint resolution), and the board's project (the
// Agile board list needs read:project:jira besides read:board-scope); offline_access for a refresh token, so the
// worker can sync without the user present. The authorize URL asks for exactly these: a scope only added in the
// developer console is not granted.
const SCOPES = [
    'read:jira-work', 'read:jira-user', 'read:board-scope:jira-software', 'read:sprint:jira-software', 'read:project:jira', 'offline_access',
];
const REQUIRED_SITE_SCOPE = 'read:jira-work';
const MAX_PAGES = 20;

class AtlassianError extends Error {
    /** @param {string} message @param {{ reconnect?: boolean, status?: number|null }} [options] reconnect: the stored grant is no longer valid; status: Atlassian's HTTP status */
    constructor(message, { reconnect = false, status = null } = {}) {
        super(message);
        this.reconnect = reconnect;
        this.status = status;
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
    if (!res.ok) throw new AtlassianError(`GET ${new URL(url).pathname} failed with HTTP ${res.status}`, { reconnect: res.status === 401, status: res.status });
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

const ISSUE_PAGE_SIZE = 100;
// A board's or a search's pages beyond this are not read: a guard against a runaway loop, far above any real PI.
const MAX_ISSUE_PAGES = 50;

/** Agile API pages (`values` + `isLast`), each value kept only if `pick` returns it. */
async function agilePages(url, accessToken, fetchFn, pick) {
    const out = [];
    for (let page = 0, startAt = 0; page < MAX_PAGES; page++) {
        const sep = url.includes('?') ? '&' : '?';
        const body = await getJson(`${url}${sep}startAt=${startAt}&maxResults=50`, accessToken, fetchFn);
        if (!Array.isArray(body?.values)) throw new AtlassianError(`${new URL(url).pathname} response has no values list`);
        for (const v of body.values) {
            const picked = pick(v);
            if (picked) out.push(picked);
        }
        if (body.isLast !== false || body.values.length === 0) break;
        startAt += body.values.length;
    }
    return out;
}

/**
 * The site's boards with their type: `scrum` (company-managed), `simple` (a team-managed project's board, which may
 * or may not use sprints) or `kanban` (no sprints). Not filtered by type: asking for `type=scrum` alone hides every
 * team-managed project's board, sprints or not.
 *
 * @param {{ accessToken: string, cloudId: string, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ boardId: number, name: string, type: string|null, projectKey: string|null, projectName: string|null }>>}
 * @throws {AtlassianError}
 */
function fetchBoards({ accessToken, cloudId, fetch: fetchFn = fetch }) {
    return agilePages(`${API_BASE}/${encodeURIComponent(cloudId)}/rest/agile/1.0/board`, accessToken, fetchFn, (b) => (
        Number.isSafeInteger(b?.id) && b.id > 0 && typeof b.name === 'string'
            ? {
                boardId: b.id,
                name: b.name.slice(0, 200),
                type: typeof b.type === 'string' ? b.type.slice(0, 20) : null,
                projectKey: typeof b.location?.projectKey === 'string' ? b.location.projectKey : null,
                projectName: typeof b.location?.projectName === 'string' ? b.location.projectName.slice(0, 200) : null,
            }
            : null
    ));
}

const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Every sprint of a board (active, future and closed); none for a board that doesn't use sprints (Atlassian answers
 * 400 for a kanban board, or a team-managed one with sprints turned off).
 *
 * @param {{ accessToken: string, cloudId: string, boardId: number, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ id: number, name: string, state: 'active'|'future'|'closed', startDate: string|null, endDate: string|null }>>}
 * @throws {AtlassianError}
 */
async function fetchSprints({ accessToken, cloudId, boardId, fetch: fetchFn = fetch }) {
    try {
        return await sprintPages({ accessToken, cloudId, boardId, fetchFn });
    } catch (err) {
        if (err instanceof AtlassianError && err.status === 400) return [];
        throw err;
    }
}

function sprintPages({ accessToken, cloudId, boardId, fetchFn }) {
    return agilePages(`${API_BASE}/${encodeURIComponent(cloudId)}/rest/agile/1.0/board/${boardId}/sprint`, accessToken, fetchFn, (sp) => (
        Number.isSafeInteger(sp?.id) && typeof sp.name === 'string' && ['active', 'future', 'closed'].includes(sp.state)
            ? { id: sp.id, name: sp.name.slice(0, 200), state: sp.state, startDate: isDate(sp.startDate) ? sp.startDate : null, endDate: isDate(sp.endDate) ? sp.endDate : null }
            : null
    ));
}

/**
 * A project's versions (its releases, the `fixVersion` of issues), archived ones left out. Read with the classic
 * `read:jira-work` scope, so no new consent.
 *
 * @param {{ accessToken: string, cloudId: string, projectKey: string, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ id: string, name: string, released: boolean, startDate: string|null, releaseDate: string|null }>>}
 * @throws {AtlassianError}
 */
function fetchVersions({ accessToken, cloudId, projectKey, fetch: fetchFn = fetch }) {
    const url = `${API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/project/${encodeURIComponent(projectKey)}/version`;
    return agilePages(url, accessToken, fetchFn, (v) => (
        typeof v?.id === 'string' && /^\d+$/.test(v.id) && typeof v.name === 'string' && v.archived !== true
            ? {
                id: v.id,
                name: v.name.slice(0, 200),
                released: v.released === true,
                startDate: isDate(v.startDate) ? v.startDate : null,
                releaseDate: isDate(v.releaseDate) ? v.releaseDate : null,
            }
            : null
    ));
}

/**
 * The ids of the custom fields the issue mapping reads. Sprint and Epic Link by their fixed schema type; Flagged
 * by name (it has no dedicated type) -- the same lookup as the file-based scripts/lib/jira-issues.js.
 *
 * @param {{ accessToken: string, cloudId: string, fetch?: typeof fetch }} input
 * @returns {Promise<{ sprintFieldId: string|null, epicLinkFieldId: string|null, flaggedFieldId: string|null }>}
 * @throws {AtlassianError}
 */
async function fetchFieldIds({ accessToken, cloudId, fetch: fetchFn = fetch }) {
    const fields = await getJson(`${API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/field`, accessToken, fetchFn);
    if (!Array.isArray(fields)) throw new AtlassianError('field list response is not a list');
    const idOf = (match) => {
        const f = fields.find((x) => typeof x?.id === 'string' && match(x));
        return f ? f.id : null;
    };
    return {
        sprintFieldId: idOf((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint'),
        epicLinkFieldId: idOf((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-epic-link'),
        flaggedFieldId: idOf((f) => typeof f.name === 'string' && f.name.toLowerCase() === 'flagged'),
    };
}

/**
 * All issues matching a JQL query (the token-paged /search/jql endpoint), raw.
 *
 * @param {{ accessToken: string, cloudId: string, jql: string, fields: string[], fetch?: typeof fetch }} input
 * @returns {Promise<object[]>}
 * @throws {AtlassianError}
 */
async function searchIssues({ accessToken, cloudId, jql, fields, fetch: fetchFn = fetch }) {
    const issues = [];
    let token = null;
    for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
        // The jql goes with every page: the endpoint ties nextPageToken to the query it was issued for.
        let url = `${API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/search/jql?maxResults=${ISSUE_PAGE_SIZE}`
            + `&fields=${encodeURIComponent(fields.join(','))}&jql=${encodeURIComponent(jql)}`;
        if (token) url += `&nextPageToken=${encodeURIComponent(token)}`;
        const body = await getJson(url, accessToken, fetchFn);
        if (!Array.isArray(body?.issues)) throw new AtlassianError('issue search response has no issues list');
        issues.push(...body.issues);
        token = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null;
        if (body.isLast === true || !token) return issues;
    }
    throw new AtlassianError(`issue search exceeded ${MAX_ISSUE_PAGES * ISSUE_PAGE_SIZE} issues`);
}

module.exports = {
    SCOPES, AtlassianError, buildAuthorizeUrl, exchangeCode, refreshAccessToken, fetchJiraSites, fetchProjects,
    fetchBoards, fetchSprints, fetchVersions, fetchFieldIds, searchIssues,
};
