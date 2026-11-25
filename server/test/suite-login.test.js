// Sign-in through the suite's identity service (design-docs/SUITE-LOGIN-PLAN.pl.md; ADR 17 §3 in dbqm45/pdi), beside
// GitHub: a fake OpenID provider (discovery, JWKS, a token endpoint that checks PKCE and issues an RS256 ID token with
// the claims a test chooses). The claims have the shape the real realm gives the di-release client (Keycloak 26.4.7,
// dbqm45/di-identity 0.1.3): no email (DI3).
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadSuiteConfig } = require('../lib/config');
const { suiteRole } = require('../lib/suite-members');

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

test('the suite settings: all three or none; https, or http only on localhost', () => {
    assert.strictEqual(loadSuiteConfig({}), null);
    assert.deepStrictEqual(
        loadSuiteConfig({ SUITE_ISSUER: ISSUER, SUITE_CLIENT_SECRET: 's' }),
        { issuer: ISSUER, clientId: 'di-release', clientSecret: 's' },
    );
    assert.strictEqual(loadSuiteConfig({ SUITE_ISSUER: 'https://id.example.com/realms/suite', SUITE_CLIENT_ID: 'x', SUITE_CLIENT_SECRET: 's' }).clientId, 'x');
    assert.throws(() => loadSuiteConfig({ SUITE_ISSUER: ISSUER }), /SUITE_CLIENT_SECRET/);
    assert.throws(() => loadSuiteConfig({ SUITE_CLIENT_SECRET: 's' }), /SUITE_ISSUER/);
    assert.throws(() => loadSuiteConfig({ SUITE_ISSUER: 'http://id.example.com/realms/suite', SUITE_CLIENT_SECRET: 's' }), /https/);
});

test('the role in a workspace from the token: admin, else member for editor or viewer, else none', () => {
    assert.strictEqual(suiteRole(['viewer', 'admin']), 'admin');
    assert.strictEqual(suiteRole(['editor']), 'member');
    assert.strictEqual(suiteRole(['viewer']), 'member');
    assert.strictEqual(suiteRole([]), null);
    assert.strictEqual(suiteRole(['owner']), null);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres suite sign-in tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');

/** An app with both sign-ins, and a GitHub user `gina` who owns the workspace Acme. */
async function setUp(t, { suite = SUITE } = {}) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const fake = fakeSuite(fakeGitHub({ gina: { id: 820_000_001, login: 'gina' } }));
    const app = buildApp({ pool, auth: AUTH, suite, fetch: fake.fetchFn });
    t.after(() => app.close());
    const gina = await signIn(app, 'gina');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: gina }, payload: { name: 'Acme' } })).json().tenant.id;
    const link = (organization, sid = gina) => app.inject({ method: 'PUT', url: `/tenants/${tenantId}/settings`, cookies: { sid }, payload: { suiteOrganization: organization } });
    const members = async () => (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: gina } })).json().members
        .map((m) => [m.githubLogin, m.role]);
    return { pool, app, fake, gina, tenantId, link, members };
}

test('without the suite settings the suite sign-in is off and /auth/login goes straight to GitHub', async (t) => {
    const { app } = await setUp(t, { suite: null });
    assert.strictEqual((await app.inject({ method: 'GET', url: '/auth/suite/login' })).statusCode, 404);
    const login = await app.inject({ method: 'GET', url: '/auth/login?returnTo=/start' });
    assert.strictEqual(login.statusCode, 302);
    assert.strictEqual(login.headers.location, '/auth/github/login?returnTo=%2Fstart');
});

test('with them, /auth/login offers both, and the suite sign-in asks with PKCE, state and nonce, no email', async (t) => {
    const { app, fake } = await setUp(t);
    const page = await app.inject({ method: 'GET', url: '/auth/login?returnTo=/start' });
    assert.strictEqual(page.statusCode, 200);
    assert.match(page.body, /href="\/auth\/github\/login\?returnTo=%2Fstart"/);
    assert.match(page.body, /href="\/auth\/suite\/login\?returnTo=%2Fstart"/);
    assert.ok(!/<script/i.test(page.body), 'no script on the page');

    const start = await app.inject({ method: 'GET', url: '/auth/suite/login' });
    assert.strictEqual(start.statusCode, 302);
    const url = new URL(start.headers.location);
    assert.strictEqual(`${url.origin}${url.pathname}`, `${ISSUER}/protocol/openid-connect/auth`);
    assert.strictEqual(url.searchParams.get('client_id'), 'di-release');
    assert.strictEqual(url.searchParams.get('scope'), 'openid profile');
    assert.strictEqual(url.searchParams.get('redirect_uri'), `${AUTH.publicBaseUrl}/auth/suite/callback`);
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    for (const p of ['state', 'nonce', 'code_challenge']) assert.match(url.searchParams.get(p), /^[\w-]{20,}$/);
    const cookie = start.cookies.find((c) => c.name === 'suite_state');
    assert.ok(cookie && cookie.httpOnly && cookie.path === '/auth/suite');
    assert.strictEqual(fake.state.tokenForms.length, 0);
});

test('an admin links the workspace to a suite organization; the change is audited and the alias is unique', async (t) => {
    const { app, link, tenantId, gina } = await setUp(t);
    const set = await link('acme');
    assert.strictEqual(set.statusCode, 200);
    assert.strictEqual(set.json().suiteOrganization, 'acme');
    assert.strictEqual((await link('Not An Alias!')).statusCode, 400);
    const events = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/audit-events`, cookies: { sid: gina } })).json().events;
    assert.deepStrictEqual(events.filter((e) => e.kind === 'suite_organization_changed').map((e) => [e.subject, e.actor]), [['acme', 'gina']]);
    const other = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: gina }, payload: { name: 'Other' } })).json().tenant.id;
    const taken = await app.inject({ method: 'PUT', url: `/tenants/${other}/settings`, cookies: { sid: gina }, payload: { suiteOrganization: 'acme' } });
    assert.strictEqual(taken.statusCode, 409);
    assert.strictEqual((await link(null)).json().suiteOrganization, null);
});

test('people of the linked organization join with the role from their token; the same person stays one user', async (t) => {
    const { app, fake, link, members, pool } = await setUp(t);
    await link('acme');
    fake.state.claims = person(['editor'], ['acme'], '00000000-0000-4000-8000-0000000000a1');
    const first = await suiteSignIn(app, fake);
    assert.ok(first.sid);
    assert.strictEqual(first.back.headers.location, '/');
    const me = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: first.sid } })).json();
    assert.strictEqual(me.user.githubLogin, 'Person a1');
    assert.deepStrictEqual(me.tenants.map((x) => x.role), ['member']);
    await suiteSignIn(app, fake);
    assert.deepStrictEqual(await members(), [['gina', 'admin'], ['Person a1', 'member']]);
    const { rows } = await pool.query('SELECT github_user_id, github_login, suite_sub, display_name FROM users WHERE suite_sub IS NOT NULL');
    assert.deepStrictEqual(rows, [{ github_user_id: null, github_login: null, suite_sub: '00000000-0000-4000-8000-0000000000a1', display_name: 'Person a1' }]);
    // The client secret goes to the token endpoint only, with the PKCE verifier.
    assert.strictEqual(fake.state.tokenForms.at(-1).get('client_secret'), 'dummy-suite-secret');
    assert.match(fake.state.tokenForms.at(-1).get('code_verifier'), /^[\w-]{43,}$/);
});

test('a role change in the suite applies at the next sign-in; losing the organization or the role removes the membership', async (t) => {
    const { app, fake, link, members } = await setUp(t);
    await link('acme');
    const sub = '00000000-0000-4000-8000-0000000000b1';
    fake.state.claims = person(['admin'], ['acme'], sub);
    await suiteSignIn(app, fake);
    assert.deepStrictEqual(await members(), [['gina', 'admin'], ['Person b1', 'admin']]);
    fake.state.claims = person(['viewer'], ['acme'], sub);
    await suiteSignIn(app, fake);
    assert.deepStrictEqual(await members(), [['gina', 'admin'], ['Person b1', 'member']]);
    fake.state.claims = person([], ['acme'], sub);
    const noRole = await suiteSignIn(app, fake);
    assert.deepStrictEqual(await members(), [['gina', 'admin']]);
    // Signed in, but in no workspace: the same page as a new GitHub user.
    assert.ok(noRole.sid);
    assert.deepStrictEqual((await app.inject({ method: 'GET', url: '/me', cookies: { sid: noRole.sid } })).json().tenants, []);
    fake.state.claims = person(['admin'], ['acme'], sub);
    await suiteSignIn(app, fake);
    fake.state.claims = person(['admin'], ['globex'], sub);
    await suiteSignIn(app, fake);
    assert.deepStrictEqual(await members(), [['gina', 'admin']]);
});

test('the last admin of a workspace is never removed or lowered by the suite', async (t) => {
    const { app, fake, link, members, gina, tenantId } = await setUp(t);
    await link('acme');
    const sub = '00000000-0000-4000-8000-0000000000c1';
    fake.state.claims = person(['admin'], ['acme'], sub);
    const { sid } = await suiteSignIn(app, fake);
    // Gina leaves: the suite person is now the only admin.
    const ginaId = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: gina } })).json().user.id;
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/members/${ginaId}`, cookies: { sid } })).statusCode, 204);
    fake.state.claims = person(['viewer'], ['acme'], sub);
    await suiteSignIn(app, fake);
    fake.state.claims = person([], ['globex'], sub);
    await suiteSignIn(app, fake);
    const left = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid } })).json().members;
    assert.deepStrictEqual(left.map((m) => [m.githubLogin, m.role]), [['Person c1', 'admin']]);
    assert.ok(members);
});

test('memberships the suite did not give stay: an invited suite person in an unlinked workspace keeps it', async (t) => {
    const { app, fake, gina } = await setUp(t);
    const other = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: gina }, payload: { name: 'Unlinked' } })).json().tenant.id;
    fake.state.claims = person(['admin'], ['globex'], '00000000-0000-4000-8000-0000000000d1');
    const { sid } = await suiteSignIn(app, fake);
    const invite = (await app.inject({ method: 'POST', url: `/tenants/${other}/invitations`, cookies: { sid: gina }, payload: { role: 'member' } })).json();
    const token = invite.url.split('/').pop();
    assert.strictEqual((await app.inject({ method: 'POST', url: `/invitations/${token}/accept`, cookies: { sid } })).statusCode, 201);
    await suiteSignIn(app, fake);
    const tenants = (await app.inject({ method: 'GET', url: '/me', cookies: { sid } })).json().tenants;
    assert.deepStrictEqual(tenants.map((x) => [x.name, x.role]), [['Unlinked', 'member']]);
});

test('a token signed with another key, for another client, with another nonce or expired is refused, without a session', async (t) => {
    const { app, fake, link } = await setUp(t);
    await link('acme');
    fake.state.claims = person(['admin']);
    const bad = [
        ['key', () => { fake.state.key = fake.stranger; }],
        ['aud', () => { fake.state.tamper = (c) => ({ ...c, aud: 'di-release-control' }); }],
        ['azp', () => { fake.state.tamper = (c) => ({ ...c, azp: 'di-release-control' }); }],
        ['nonce', () => { fake.state.tamper = (c) => ({ ...c, nonce: 'forged' }); }],
        ['exp', () => { fake.state.tamper = (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 600 }); }],
        ['iss', () => { fake.state.tamper = (c) => ({ ...c, iss: 'http://localhost:8180/realms/other' }); }],
    ];
    for (const [name, spoil] of bad) {
        const key = fake.state.key;
        spoil();
        const r = await suiteSignIn(app, fake);
        assert.strictEqual(r.sid, undefined, name);
        assert.strictEqual(r.back.statusCode, 502, name);
        fake.state.key = key;
        fake.state.tamper = (c) => c;
    }
    // A callback without the state cookie is refused before any token request.
    const forms = fake.state.tokenForms.length;
    const noCookie = await app.inject({ method: 'GET', url: '/auth/suite/callback?code=x&state=y' });
    assert.strictEqual(noCookie.statusCode, 400);
    assert.strictEqual(fake.state.tokenForms.length, forms);
});

test('a suite person can open a workspace of their own and is its admin', async (t) => {
    const { app, fake } = await setUp(t);
    fake.state.claims = person(['viewer'], ['globex'], '00000000-0000-4000-8000-0000000000e1');
    const { sid } = await suiteSignIn(app, fake);
    const created = await app.inject({ method: 'POST', url: '/tenants', cookies: { sid }, payload: { name: 'Mine' } });
    assert.strictEqual(created.statusCode, 201);
    assert.strictEqual(created.json().role, 'admin');
});
