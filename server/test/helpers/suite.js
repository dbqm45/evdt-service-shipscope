// A fake identity service of the suite (Keycloak realm `suite`, client di-release) for the app's tests: discovery,
// JWKS, a token endpoint that checks PKCE and issues an RS256 ID token with the claims a test chooses (no email, DI3).
const crypto = require('crypto');

const ISSUER = 'http://localhost:8180/realms/suite';
const SUITE = { issuer: ISSUER, clientId: 'di-release', clientSecret: 'dummy-suite-secret' };

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const jwt = (key, claims) => {
    const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('sha256', Buffer.from(input), key).toString('base64url')}`;
};

let subSeq = 0;
/** A person of the suite as the realm describes them in the di-release ID token. */
const person = (roles, organization = ['acme'], sub = `00000000-0000-4000-8000-00000000000${++subSeq}`) => ({
    sub, name: `Person ${sub.slice(-2)}`, preferred_username: `person.${sub.slice(-2)}`, organization,
    resource_access: { account: { roles: ['view-profile'] }, 'di-release': { roles }, 'di-release-control': { roles: ['admin'] } },
});

/** Fake identity service; `fallback` answers every other URL (GitHub in the app's tests). */
function fakeSuite(fallback = async () => new Response('not found', { status: 404 })) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const grants = new Map();
    const state = { claims: person(['editor']), tamper: (c) => c, key: privateKey, tokenForms: [] };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchFn = async (input, init = {}) => {
        const url = String(input);
        if (url === `${ISSUER}/.well-known/openid-configuration`) {
            return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`, token_endpoint: `${ISSUER}/protocol/openid-connect/token`, jwks_uri: `${ISSUER}/protocol/openid-connect/certs` });
        }
        if (url === `${ISSUER}/protocol/openid-connect/certs`) return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
        if (url === `${ISSUER}/protocol/openid-connect/token`) {
            const form = new URLSearchParams(String(init.body || ''));
            state.tokenForms.push(form);
            const grant = grants.get(form.get('code') || '');
            const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
            if (!grant || challenge !== grant.challenge) return json({ error: 'invalid_grant' }, 400);
            const now = Math.floor(Date.now() / 1000);
            const claims = state.tamper({ iss: ISSUER, aud: 'di-release', azp: 'di-release', typ: 'ID', iat: now, exp: now + 300, nonce: grant.nonce, ...state.claims });
            return json({ access_token: 'dummy-access', token_type: 'Bearer', expires_in: 300, id_token: jwt(state.key, claims) });
        }
        return fallback(input, init);
    };
    /** Plays the person signing in at the identity service: the callback query for the authorization request. */
    const approve = (location) => {
        const auth = new URL(location);
        const code = `code-${grants.size}`;
        grants.set(code, { nonce: auth.searchParams.get('nonce'), challenge: auth.searchParams.get('code_challenge') });
        return `code=${code}&state=${auth.searchParams.get('state')}`;
    };
    return { state, approve, stranger, fetchFn };
}

/** The whole suite sign-in through the app; `sid` is the session cookie's value when one was set. */
async function suiteSignIn(app, fake) {
    const start = await app.inject({ method: 'GET', url: '/auth/suite/login' });
    const stateCookie = start.cookies.find((c) => c.name === 'suite_state');
    const back = await app.inject({
        method: 'GET', url: `/auth/suite/callback?${fake.approve(start.headers.location)}`,
        cookies: stateCookie ? { suite_state: stateCookie.value } : {},
    });
    const sid = back.cookies.find((c) => c.name === 'sid' && c.value);
    return { start, back, sid: sid && sid.value };
}

module.exports = { ISSUER, SUITE, b64, jwt, person, fakeSuite, suiteSignIn };
