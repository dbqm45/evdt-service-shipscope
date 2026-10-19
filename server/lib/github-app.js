const crypto = require('crypto');
const { retryAtFrom } = require('./rate-limit');

/**
 * GitHub App server-to-server calls (FR-004/FR-006). The App authenticates as itself with a short-lived
 * JWT signed by its private key (RS256, node:crypto -- no dependency), and as an installation with an
 * installation access token minted from that JWT. Installation tokens are minted per use and never
 * stored (prd.md: credential hygiene); they expire after an hour on GitHub's side anyway.
 */

const API = 'https://api.github.com';
const PER_PAGE = 100;
/** Safety cap on pagination: 20 pages x 100 = 2000 repos/installations, far beyond a real tenant. */
const MAX_PAGES = 20;
/** Per request. Without it one stalled connection would block the worker indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000;

class GitHubApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/** GitHub's primary or secondary rate limit: the installation's budget is spent until `retryAt`. */
class GitHubRateLimitError extends GitHubApiError {
    /** @param {string} message @param {number} status @param {Date} retryAt */
    constructor(message, status, retryAt) {
        super(message, status);
        this.retryAt = retryAt;
    }
}

/**
 * A rate-limited answer: 429, or 403 with no requests left (primary limit) or a Retry-After (secondary limit; its
 * own counter, so x-ratelimit-remaining may still be above 0). Any other 403 is a real permission error.
 */
function isRateLimited(res) {
    if (res.status === 429) return true;
    return res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null);
}

const base64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/**
 * The App's JWT. iat is backdated 60s for clock drift and exp kept under GitHub's 10-minute maximum.
 *
 * @param {{ appId: string, privateKey: import('crypto').KeyObject, now?: number }} input
 * @returns {string}
 */
function createAppJwt({ appId, privateKey, now = Date.now() }) {
    const seconds = Math.floor(now / 1000);
    const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
    const signature = crypto.sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url');
    return `${unsigned}.${signature}`;
}

async function githubFetch(fetchFn, path, { token, method = 'GET', body }) {
    let res;
    try {
        res = await fetchFn(`${API}${path}`, {
            method,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                accept: 'application/vnd.github+json',
                authorization: `Bearer ${token}`,
                'user-agent': 'shipscope',
                'x-github-api-version': '2022-11-28',
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    } catch (err) {
        throw new GitHubApiError(`${method} ${path.split('?')[0]} failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`, 0);
    }
    if (isRateLimited(res)) {
        // GitHub: without a header, wait at least a minute.
        const retryAt = retryAtFrom(res.headers, { fallbackMs: 60_000 });
        throw new GitHubRateLimitError(`${method} ${path.split('?')[0]} hit GitHub's rate limit (HTTP ${res.status}) until ${retryAt.toISOString()}`, res.status, retryAt);
    }
    if (!res.ok) throw new GitHubApiError(`${method} ${path.split('?')[0]} failed with HTTP ${res.status}`, res.status);
    return res.json();
}

/** Follows ?page=N until a short page; `pick` extracts the array from each response body. */
async function allPages(fetchFn, path, token, pick) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const batch = pick(await githubFetch(fetchFn, `${path}${sep}per_page=${PER_PAGE}&page=${page}`, { token }));
        if (!Array.isArray(batch)) throw new GitHubApiError(`${path} response has no list`, 502);
        items.push(...batch);
        if (batch.length < PER_PAGE) return items;
    }
    return items;
}

const isId = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * An installation's account, read as the App. Proves the installation exists and belongs to this App --
 * but not that the current user may use it; see userCanAccessInstallation for that.
 *
 * @param {{ app: { appId: string, privateKey: import('crypto').KeyObject }, installationId: number, fetch?: typeof fetch }} input
 * @returns {Promise<{ installationId: number, accountLogin: string, accountType: string }>}
 * @throws {GitHubApiError}
 */
async function getInstallation({ app, installationId, fetch: fetchFn = fetch }) {
    const body = await githubFetch(fetchFn, `/app/installations/${installationId}`, { token: createAppJwt(app) });
    if (!body || body.id !== installationId || typeof body.account?.login !== 'string' || typeof body.account?.type !== 'string') {
        throw new GitHubApiError('installation response is missing id/account', 502);
    }
    return { installationId, accountLogin: body.account.login, accountType: body.account.type };
}

/**
 * Whether the signed-in user (their user access token from this App) can access the installation. This is
 * the check that stops someone from linking another organization's installation to their own tenant by
 * editing installation_id in the setup redirect.
 *
 * @param {{ accessToken: string, installationId: number, fetch?: typeof fetch }} input
 * @returns {Promise<boolean>}
 * @throws {GitHubApiError}
 */
async function userCanAccessInstallation({ accessToken, installationId, fetch: fetchFn = fetch }) {
    const installations = await allPages(fetchFn, '/user/installations', accessToken, (body) => body?.installations);
    return installations.some((installation) => installation?.id === installationId);
}

/**
 * What ShipScope reads with an installation token, and nothing more: deployments and their statuses, releases,
 * tags, commits, compares, trees and version files (contents), workflow runs for "manual" (actions), and the
 * repository list (metadata). The token is cut down to these even when the installation was granted more, so a
 * leaked token can only read.
 */
const TOKEN_PERMISSIONS = { actions: 'read', contents: 'read', deployments: 'read', metadata: 'read' };

/**
 * A short-lived installation access token (about an hour on GitHub's side), limited to TOKEN_PERMISSIONS (read
 * only). Callers keep it in memory for the duration of one operation; it is never stored. GitHub refuses (422) a
 * permission the installation was not granted, e.g. Actions on an installation made before ShipScope asked for
 * it: then the token asks for the ones the installation has, still read only.
 *
 * @param {{ app: { appId: string, privateKey: import('crypto').KeyObject }, installationId: number, fetch?: typeof fetch }} input
 * @returns {Promise<string>}
 * @throws {GitHubApiError}
 */
async function createInstallationToken({ app, installationId, fetch: fetchFn = fetch }) {
    const mint = (permissions) => githubFetch(fetchFn, `/app/installations/${installationId}/access_tokens`, {
        token: createAppJwt(app), method: 'POST', body: { permissions },
    });
    let body;
    try {
        body = await mint(TOKEN_PERMISSIONS);
    } catch (err) {
        if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
        const installation = await githubFetch(fetchFn, `/app/installations/${installationId}`, { token: createAppJwt(app) });
        const granted = installation?.permissions && typeof installation.permissions === 'object' ? installation.permissions : {};
        const permissions = Object.fromEntries(Object.entries(TOKEN_PERMISSIONS).filter(([name]) => typeof granted[name] === 'string'));
        if (!Object.keys(permissions).length) throw err;
        body = await mint(permissions);
    }
    if (typeof body?.token !== 'string' || !body.token) throw new GitHubApiError('access token response has no token', 502);
    return body.token;
}

/**
 * GET an API path with an installation token, e.g. a repo's deployments.
 *
 * @param {{ token: string, path: string, fetch?: typeof fetch }} input
 * @returns {Promise<any>} the parsed JSON body
 * @throws {GitHubApiError}
 */
function githubGet({ token, path, fetch: fetchFn = fetch }) {
    return githubFetch(fetchFn, path, { token });
}

/**
 * Repositories the installation was granted, read with a freshly minted installation token.
 *
 * @param {{ app: { appId: string, privateKey: import('crypto').KeyObject }, installationId: number, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ id: number, fullName: string, private: boolean }>>}
 * @throws {GitHubApiError}
 */
async function listInstallationRepos({ app, installationId, fetch: fetchFn = fetch }) {
    const token = await createInstallationToken({ app, installationId, fetch: fetchFn });
    const repos = await allPages(fetchFn, '/installation/repositories', token, (body) => body?.repositories);
    return repos.map((repo) => {
        if (!isId(repo?.id) || typeof repo.full_name !== 'string') throw new GitHubApiError('repository entry is missing id/full_name', 502);
        return { id: repo.id, fullName: repo.full_name, private: repo.private === true };
    });
}

module.exports = {
    TOKEN_PERMISSIONS,
    createAppJwt,
    createInstallationToken,
    githubGet,
    getInstallation,
    userCanAccessInstallation,
    listInstallationRepos,
    GitHubApiError,
    GitHubRateLimitError,
};
