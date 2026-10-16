/**
 * GitHub sign-in (FR-001) via the ShipScope GitHub App's user-authorization flow. A GitHub App takes
 * no OAuth scopes -- what the user token can do is set by the App's own permissions -- and ShipScope
 * only uses it once, to learn who signed in, then discards it.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

class GitHubOAuthError extends Error {}

/**
 * @param {{ clientId: string, redirectUri: string, state: string }} input
 * @returns {string}
 */
function buildAuthorizeUrl({ clientId, redirectUri, state }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
}

/**
 * Exchanges an authorization code for a user access token. GitHub answers a bad/expired code with
 * HTTP 200 and an `error` field, so the body is checked, not just the status.
 *
 * @param {{ clientId: string, clientSecret: string, code: string, redirectUri: string, fetch?: typeof fetch }} input
 * @returns {Promise<string>} the access token
 * @throws {GitHubOAuthError}
 */
async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetch: fetchFn = fetch }) {
    const res = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });
    if (!res.ok) throw new GitHubOAuthError(`token exchange failed with HTTP ${res.status}`);
    const body = await res.json();
    if (body && typeof body.error === 'string') throw new GitHubOAuthError(`token exchange rejected: ${body.error}`);
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
        throw new GitHubOAuthError('token exchange response has no access_token');
    }
    return body.access_token;
}

/**
 * Fetches the signed-in user's stable numeric id and current login.
 *
 * @param {{ accessToken: string, fetch?: typeof fetch }} input
 * @returns {Promise<{ githubUserId: number, githubLogin: string }>}
 * @throws {GitHubOAuthError}
 */
async function fetchGitHubUser({ accessToken, fetch: fetchFn = fetch }) {
    const res = await fetchFn(USER_URL, {
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${accessToken}`,
            'user-agent': 'shipscope',
            'x-github-api-version': '2022-11-28',
        },
    });
    if (!res.ok) throw new GitHubOAuthError(`GET /user failed with HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Number.isSafeInteger(body.id) || body.id <= 0 || typeof body.login !== 'string' || !body.login) {
        throw new GitHubOAuthError('GET /user response is missing a valid id/login');
    }
    return { githubUserId: body.id, githubLogin: body.login };
}

module.exports = { buildAuthorizeUrl, exchangeCode, fetchGitHubUser, GitHubOAuthError };
