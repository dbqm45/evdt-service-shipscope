// Sign-in through the suite's identity service (design-docs/SUITE-LOGIN-PLAN.pl.md; ADR 17 in dbqm45/pdi): the
// authorization code flow with PKCE against dbqm45/di-identity (Keycloak, realm `suite`, client `di-release`), beside
// GitHub's. The ID token is checked here, as lib/github-oidc.js checks GitHub's: RS256 only, a key from the issuer's
// JWKS (never one the token names itself), `iss`, `aud`, `azp`, `exp` and `nonce`. It carries no e-mail (DI3).
const crypto = require('crypto');

const CLOCK_SKEW_SECONDS = 60;
const TIMEOUT_MS = 5000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The identity service refused the sign-in, or answered something this client does not accept (502). */
class SuiteSignInError extends Error {}

const random = () => crypto.randomBytes(32).toString('base64url');
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const decode = (segment) => {
    if (!SEGMENT.test(segment)) throw new SuiteSignInError('the ID token is not a JWT');
    let value;
    try {
        value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    } catch {
        throw new SuiteSignInError('the ID token is not valid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SuiteSignInError('the ID token is not a JSON object');
    return value;
};

/**
 * A client for one identity service.
 *
 * @param {{ issuer: string, clientId: string, clientSecret: string, redirectUri: string, fetch?: typeof fetch, now?: () => number }} input
 *   `now` in ms
 * @returns {{
 *   start: () => Promise<{ url: string, checks: { state: string, nonce: string, verifier: string } }>,
 *   finish: (input: { code: string, checks: { nonce: string, verifier: string } }) => Promise<{ sub: string, name: string, organizations: string[], roles: string[] }>,
 * }}
 */
function createSuiteClient({ issuer, clientId, clientSecret, redirectUri, fetch: fetchImpl = fetch, now = Date.now }) {
    let discovery = null;
    const getJson = async (url, init = {}) => {
        const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', ...(init.headers || {}) } });
        if (!res.ok) throw new SuiteSignInError(`${new URL(url).pathname} answered HTTP ${res.status}`);
        return res.json();
    };
    const discover = async () => {
        if (discovery && now() - discovery.at < DISCOVERY_TTL_MS) return discovery.value;
        const value = await getJson(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
        if (!value || value.issuer !== issuer) throw new SuiteSignInError('the identity service names another issuer');
        for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
            if (typeof value[key] !== 'string') throw new SuiteSignInError(`the identity service's metadata has no ${key}`);
        }
        discovery = { value, at: now() };
        return value;
    };

    async function start() {
        const meta = await discover();
        const checks = { state: random(), nonce: random(), verifier: random() };
        const url = new URL(meta.authorization_endpoint);
        url.search = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            scope: 'openid profile',
            redirect_uri: redirectUri,
            state: checks.state,
            nonce: checks.nonce,
            code_challenge: crypto.createHash('sha256').update(checks.verifier).digest('base64url'),
            code_challenge_method: 'S256',
        }).toString();
        return { url: url.toString(), checks };
    }

    async function finish({ code, checks }) {
        const meta = await discover();
        const tokens = await getJson(meta.token_endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code', code, redirect_uri: redirectUri,
                client_id: clientId, client_secret: clientSecret, code_verifier: checks.verifier,
            }).toString(),
        });
        if (!tokens || typeof tokens.id_token !== 'string') throw new SuiteSignInError('the identity service sent no ID token');
        const parts = tokens.id_token.split('.');
        if (parts.length !== 3) throw new SuiteSignInError('the ID token is not a JWT');
        const header = decode(parts[0]);
        if (header.alg !== 'RS256') throw new SuiteSignInError('the ID token is not signed with RS256');
        const jwks = await getJson(meta.jwks_uri);
        const jwk = jwks && Array.isArray(jwks.keys) && jwks.keys.find((k) => k && k.kid === header.kid && k.kty === 'RSA');
        if (!jwk || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new SuiteSignInError('the ID token is signed with an unknown key');
        const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
        if (!SEGMENT.test(parts[2]) || !crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) {
            throw new SuiteSignInError('the ID token signature does not match');
        }
        const c = decode(parts[1]);
        const seconds = Math.floor(now() / 1000);
        if (c.iss !== issuer) throw new SuiteSignInError('the ID token is from another issuer');
        if (!strings(c.aud).includes(clientId)) throw new SuiteSignInError('the ID token is for another application');
        // Keycloak adds to `aud` every application the person has roles in; `azp` says whom it was issued to.
        if (c.azp !== undefined && c.azp !== clientId) throw new SuiteSignInError('the ID token was issued to another application');
        if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_SECONDS < seconds) throw new SuiteSignInError('the ID token has expired');
        if (!sameText(c.nonce, checks.nonce)) throw new SuiteSignInError('the ID token answers another sign-in');
        if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 200) throw new SuiteSignInError('the ID token names no person');
        const access = c.resource_access && typeof c.resource_access === 'object' ? c.resource_access[clientId] : null;
        const name = [c.name, c.preferred_username].find((v) => typeof v === 'string' && v.trim()) || c.sub;
        return {
            sub: c.sub,
            name: name.trim().slice(0, 200),
            organizations: strings(c.organization),
            roles: strings(access && access.roles),
        };
    }

    return { start, finish };
}

module.exports = { createSuiteClient, SuiteSignInError };
