/**
 * Atlassian OAuth 2.0 (3LO) and the Jira Cloud REST calls ShipScope makes with it (FR-007). Every response is
 * checked for the fields read before they are used (CLAUDE.md: validate third-party API responses).
 *
 * Tokens: the access token lives about an hour and is never stored; the refresh token (`offline_access`) is
 * stored encrypted (lib/jira-connections.js). Atlassian rotates refresh tokens: a refresh returns a new one
 * that must replace the stored one.
 */

const { retryAtFrom } = require('./rate-limit');

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const API_BASE = 'https://api.atlassian.com/ex/jira';
// Read-only: issues, users (assignees), boards and sprints (PI/sprint resolution), and the board's project (the
// Agile board list needs read:project:jira besides read:board-scope); offline_access for a refresh token, so the
// worker can sync without the user present. The authorize URL asks for exactly these: a scope only added in the
// developer console is not granted.
const SCOPES = [
    'read:jira-work', 'read:jira-user', 'read:board-scope:jira-software', 'read:sprint:jira-software', 'read:project:jira',
    // Registering the dynamic webhooks that tell ShipScope an issue changed (lib/jira-sync.js ensureWebhook()).
    'manage:jira-webhook',
    'offline_access',
];
const WEBHOOK_SCOPE = 'manage:jira-webhook';
const WEBHOOK_EVENTS = ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'];
const REQUIRED_SITE_SCOPE = 'read:jira-work';
const MAX_PAGES = 20;
/** Per request. Without it one stalled Jira site would hold up the whole sync pass, every other tenant included. */
const REQUEST_TIMEOUT_MS = 30_000;

class AtlassianError extends Error {
    /**
     * @param {string} message
     * @param {{ reconnect?: boolean, status?: number|null, retryAt?: Date|null }} [options] reconnect: the stored grant is no
     *   longer valid; status: Atlassian's HTTP status; retryAt: set on a rate limit (429), when to try again
     */
    constructor(message, { reconnect = false, status = null, retryAt = null } = {}) {
        super(message);
        this.reconnect = reconnect;
        this.status = status;
        this.retryAt = retryAt;
    }
}

const failureText = (err) => (err.name === 'TimeoutError' ? 'timed out' : err.message);

/** The error for a non-2xx answer; a 429 carries when to try again (Retry-After, which Jira Cloud doesn't always send). */
function httpError(method, url, res) {
    const path = new URL(url).pathname;
    if (res.status === 429) {
        const retryAt = retryAtFrom(res.headers);
        return new AtlassianError(`${method} ${path} hit Atlassian's rate limit until ${retryAt.toISOString()}`, { status: 429, retryAt });
    }
    return new AtlassianError(`${method} ${path} failed with HTTP ${res.status}`, { reconnect: res.status === 401, status: res.status });
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
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (err) {
        throw new AtlassianError(`token request failed: ${failureText(err)}`);
    }
    // Too many requests is not a lost grant: wait, don't ask the admin to reconnect.
    if (res.status === 429) throw httpError('POST', TOKEN_URL, res);
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
        res = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } });
    } catch (err) {
        throw new AtlassianError(`GET ${new URL(url).pathname} failed: ${failureText(err)}`);
    }
    if (!res.ok) throw httpError('GET', url, res);
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
 * The site's custom fields an issue can name feature flags in: text (`string`), labels (array of strings) or
 * select/checkbox options (`option`, or an array of them).
 *
 * @param {{ accessToken: string, cloudId: string, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ id: string, name: string, type: 'text'|'labels'|'options' }>>} sorted by name
 * @throws {AtlassianError}
 */
async function fetchFlagFieldCandidates({ accessToken, cloudId, fetch: fetchFn = fetch }) {
    const fields = await getJson(`${API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/field`, accessToken, fetchFn);
    if (!Array.isArray(fields)) throw new AtlassianError('field list response is not a list');
    const typeOf = (schema) => {
        if (schema?.type === 'string') return 'text';
        if (schema?.type === 'option') return 'options';
        if (schema?.type === 'array' && schema.items === 'string') return 'labels';
        if (schema?.type === 'array' && schema.items === 'option') return 'options';
        return null;
    };
    return fields
        .filter((f) => typeof f?.id === 'string' && /^customfield_\d+$/.test(f.id) && typeof f.name === 'string' && typeOf(f.schema))
        .map((f) => ({ id: f.id, name: f.name.slice(0, 200), type: typeOf(f.schema) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The ids of the custom fields the issue mapping reads. Sprint and Epic Link by their fixed schema type; Flagged
 * by name (it has no dedicated type) -- the same lookup as the file-based sync's jira-issues.js.
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

async function sendJson(method, url, accessToken, body, fetchFn) {
    let res;
    try {
        res = await fetchFn(url, {
            method,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
            body: JSON.stringify(body),
        });
    } catch (err) {
        throw new AtlassianError(`${method} ${new URL(url).pathname} failed: ${failureText(err)}`);
    }
    if (!res.ok) throw httpError(method, url, res);
    return res.status === 204 ? null : res.json().catch(() => null);
}

/**
 * Registers one dynamic webhook for issue changes matching `jql` (Atlassian keeps it 30 days unless refreshed).
 *
 * @param {{ accessToken: string, cloudId: string, url: string, jql: string, fetch?: typeof fetch }} input
 * @returns {Promise<number[]>} the created webhook ids
 * @throws {AtlassianError} also when Atlassian answers 2xx but refuses the webhook (e.g. an unsupported JQL)
 */
async function registerWebhooks({ accessToken, cloudId, url, jql, fetch: fetchFn = fetch }) {
    const body = await sendJson('POST', `${API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/webhook`, accessToken,
        { url, webhooks: [{ events: WEBHOOK_EVENTS, jqlFilter: jql }] }, fetchFn);
    const results = Array.isArray(body?.webhookRegistrationResult) ? body.webhookRegistrationResult : [];
    const ids = results.map((r) => r?.createdWebhookId).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) {
        const errors = results.flatMap((r) => (Array.isArray(r?.errors) ? r.errors : [])).filter((e) => typeof e === 'string');
        throw new AtlassianError(`webhook registration refused${errors.length ? `: ${errors.join('; ').slice(0, 200)}` : ''}`);
    }
    return ids;
}

/**
 * Extends the webhooks another 30 days.
 *
 * @param {{ accessToken: string, cloudId: string, ids: number[], fetch?: typeof fetch }} input
 * @returns {Promise<string|null>} their new expiry (ISO 8601), if Atlassian says
 * @throws {AtlassianError}
 */
async function refreshWebhooks({ accessToken, cloudId, ids, fetch: fetchFn = fetch }) {
    const body = await sendJson('PUT', `${API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/webhook/refresh`, accessToken, { webhookIds: ids }, fetchFn);
    return isDate(body?.expirationDate) ? new Date(body.expirationDate).toISOString() : null;
}

/**
 * @param {{ accessToken: string, cloudId: string, ids: number[], fetch?: typeof fetch }} input
 * @returns {Promise<void>}
 * @throws {AtlassianError}
 */
async function deleteWebhooks({ accessToken, cloudId, ids, fetch: fetchFn = fetch }) {
    await sendJson('DELETE', `${API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/webhook`, accessToken, { webhookIds: ids }, fetchFn);
}

module.exports = {
    WEBHOOK_SCOPE, registerWebhooks, refreshWebhooks, deleteWebhooks,
    SCOPES, AtlassianError, buildAuthorizeUrl, exchangeCode, refreshAccessToken, fetchJiraSites, fetchProjects,
    fetchBoards, fetchSprints, fetchVersions, fetchFieldIds, fetchFlagFieldCandidates, searchIssues,
};
