// GitHub Actions OIDC tokens as the credential of a flag source's push (ROADMAP, Bezpieczeństwo): a workflow with
// `permissions: id-token: write` asks GitHub for a short-lived token whose audience is this ShipScope server, and sends
// it instead of a long-lived ingest token. The token is a JWT signed by GitHub (RS256, keys at ISSUER's JWKS); its
// claims say which repository (`repository_id`, which never changes, unlike its name), branch (`ref`) and GitHub
// environment the run belongs to. lib/flags.js then checks the source trusts that repository and ref.
//
// Only GitHub's own issuer and keys are trusted, never a key or algorithm the token names itself. The keys are cached
// for an hour; a token signed with a key not in the cache refetches them, at most once every 5 minutes.
const crypto = require('crypto');

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_MS = 5 * 60 * 1000;
const JWKS_TIMEOUT_MS = 5000;
// While GitHub's keys cannot be read, at most one attempt this often, whatever the traffic.
const JWKS_RETRY_MS = 10 * 1000;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The token is not a GitHub Actions OIDC token for this server (401); the message says why, never the token. */
class OidcTokenError extends Error {}

/** True for a string shaped like a JWT (three base64url parts), as opposed to a ShipScope ingest token. */
const looksLikeJwt = (token) => typeof token === 'string' && token.split('.').length === 3 && token.split('.').every((p) => SEGMENT.test(p));

const decode = (segment) => {
    try {
        return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    } catch {
        throw new OidcTokenError('the token is not valid JSON');
    }
};

/** GitHub's signing keys, from its JWKS endpoint, checked for shape. */
async function fetchGitHubJwks(fetchImpl = fetch) {
    const res = await fetchImpl(JWKS_URL, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GitHub's OIDC keys answered HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.keys)) throw new Error('GitHub\'s OIDC keys are not a JWKS');
    return body.keys.filter((k) => k && k.kty === 'RSA' && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string');
}

/**
 * A verifier for GitHub Actions OIDC tokens addressed to `audience` (this server's public origin).
 *
 * @param {{ audience: string, fetchJwks?: () => Promise<Array<{ kid: string, kty: string, n: string, e: string }>>, now?: () => number }} input
 *   `now` in ms
 * @returns {{ verify: (token: string) => Promise<{ repository: string, repositoryId: number, ref: string|null, environment: string|null, sha: string|null, workflowRef: string|null, actor: string|null }> }}
 */
function createOidcVerifier({ audience, fetchJwks = () => fetchGitHubJwks(), now = Date.now }) {
    let keys = new Map();
    let fetchedAt = 0;
    let attemptedAt = -Infinity;
    let pending = null;
    const refresh = async () => {
        if (!pending) {
            attemptedAt = now();
            pending = fetchJwks()
                .then((list) => {
                    keys = new Map(list.map((jwk) => [jwk.kid, crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' })]));
                    fetchedAt = now();
                })
                .finally(() => { pending = null; });
        }
        await pending;
    };
    const keyFor = async (kid) => {
        const due = !fetchedAt || now() - fetchedAt > JWKS_TTL_MS || (!keys.has(kid) && now() - fetchedAt > JWKS_REFETCH_MS);
        if (due && (pending || now() - attemptedAt > JWKS_RETRY_MS)) {
            try {
                await refresh();
            } catch (err) {
                if (!keys.size) throw new OidcTokenError(`GitHub's signing keys could not be read: ${err.message}`);
            }
        } else if (due && !keys.size) {
            throw new OidcTokenError('GitHub\'s signing keys could not be read; try again shortly');
        }
        return keys.get(kid);
    };

    return {
        async verify(token) {
            if (!looksLikeJwt(token)) throw new OidcTokenError('not a JWT');
            const [head, body, sig] = token.split('.');
            const header = decode(head);
            if (header?.alg !== 'RS256') throw new OidcTokenError('the token must be signed with RS256');
            if (typeof header.kid !== 'string' || !header.kid) throw new OidcTokenError('the token names no key');
            const key = await keyFor(header.kid);
            if (!key) throw new OidcTokenError('the token is signed with a key GitHub does not publish');
            if (!crypto.verify('sha256', Buffer.from(`${head}.${body}`), key, Buffer.from(sig, 'base64url'))) {
                throw new OidcTokenError('the token signature does not match');
            }
            const claims = decode(body);
            if (!claims || typeof claims !== 'object') throw new OidcTokenError('the token has no claims');
            if (claims.iss !== ISSUER) throw new OidcTokenError('the token is not from GitHub Actions');
            const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
            if (!audiences.includes(audience)) throw new OidcTokenError(`the token is for another audience; request it for ${audience}`);
            const seconds = Math.floor(now() / 1000);
            if (typeof claims.exp !== 'number' || claims.exp < seconds - CLOCK_SKEW_SECONDS) throw new OidcTokenError('the token has expired');
            for (const claim of ['nbf', 'iat']) {
                if (claims[claim] !== undefined && (typeof claims[claim] !== 'number' || claims[claim] > seconds + CLOCK_SKEW_SECONDS)) {
                    throw new OidcTokenError('the token is not valid yet');
                }
            }
            if (typeof claims.repository_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(claims.repository_id)) {
                throw new OidcTokenError('the token names no repository');
            }
            const text = (value) => (typeof value === 'string' && value.length <= 300 ? value : null);
            return {
                repository: text(claims.repository) || claims.repository_id,
                repositoryId: Number(claims.repository_id),
                ref: text(claims.ref),
                environment: text(claims.environment),
                sha: text(claims.sha),
                workflowRef: text(claims.job_workflow_ref),
                actor: text(claims.actor),
            };
        },
    };
}

module.exports = { ISSUER, JWKS_URL, OidcTokenError, looksLikeJwt, fetchGitHubJwks, createOidcVerifier };
