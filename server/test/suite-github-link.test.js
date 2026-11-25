// Step 2 of the suite sign-in (design-docs/SUITE-LOGIN-PLAN.pl.md, "Krok 2"): a person signed in through the suite
// connects the GitHub App. GitHub's token only proves this browser can reach the installation; the session stays the
// suite person's, they are the one who linked it, and no GitHub user is created or stored.
const { test } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres suite GitHub link tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, testGitHubApp } = require('./helpers/auth');
const { SUITE, person, fakeSuite, suiteSignIn } = require('./helpers/suite');

const GITHUB_USERS = {
    gina: { id: 840_000_001, login: 'gina' },
    mallory: { id: 840_000_002, login: 'mallory' },
};
const ACME = 6001;

async function setUp(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { app: githubApp, publicKey } = testGitHubApp();
    const github = fakeGitHub(GITHUB_USERS, {
        publicKey,
        installations: { [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: [{ id: 71_000, full_name: 'acme/api', private: true }] } },
        userInstallations: { gina: [ACME], mallory: [] },
    });
    const fake = fakeSuite(github);
    const app = buildApp({ pool, auth: AUTH, suite: SUITE, githubApp, fetch: fake.fetchFn });
    t.after(() => app.close());
    return { pool, app, fake };
}

/** A suite person who opened the workspace Acme of their own (its admin). */
async function suiteAdmin(app, fake, sub = '00000000-0000-4000-8000-0000000000a1') {
    fake.state.claims = person(['editor'], ['acme'], sub);
    const { sid } = await suiteSignIn(app, fake);
    const created = await app.inject({ method: 'POST', url: '/tenants', cookies: { sid }, payload: { name: 'Acme' } });
    assert.strictEqual(created.statusCode, 201, created.body);
    return { sid, tenantId: created.json().tenant.id };
}

/** install → GitHub → setup → GitHub authorization → callback, sending `cookies` (the browser's) at the callback. */
async function connect(app, sid, tenantId, githubCode, { sendSession = true } = {}) {
    const install = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github/install`, cookies: { sid } });
    assert.strictEqual(install.statusCode, 302, install.body);
    const state = new URL(install.headers.location).searchParams.get('state');
    const ghInstall = install.cookies.find((c) => c.name === 'gh_install').value;
    const setupRes = await app.inject({
        method: 'GET', url: `/github/setup?installation_id=${ACME}&setup_action=install&state=${state}`, cookies: { sid, gh_install: ghInstall },
    });
    assert.strictEqual(setupRes.statusCode, 302, setupRes.body);
    const ghLink = setupRes.cookies.find((c) => c.name === 'gh_link').value;
    const login = await app.inject({ method: 'GET', url: setupRes.headers.location, cookies: { sid } });
    const oauthState = login.cookies.find((c) => c.name === 'oauth_state').value;
    return app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=${githubCode}&state=${oauthState}`,
        cookies: { ...(sendSession ? { sid } : {}), gh_link: ghLink, oauth_state: oauthState },
    });
}

const installations = async (app, sid, tenantId) =>
    (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github`, cookies: { sid } })).json().installations;

test('a suite admin connects the GitHub App: same session, they are the one who linked it, no GitHub user is stored', async (t) => {
    const { pool, app, fake } = await setUp(t);
    const { sid, tenantId } = await suiteAdmin(app, fake);

    const callback = await connect(app, sid, tenantId, 'gina');
    assert.strictEqual(callback.statusCode, 302, callback.body);
    assert.strictEqual(callback.headers.location, `/t/${tenantId}/settings#github`);
    assert.ok(!callback.cookies.some((c) => c.name === 'sid'), 'the session cookie is left as it was');

    assert.deepStrictEqual(await installations(app, sid, tenantId), [{ installationId: ACME, accountLogin: 'acme', accountType: 'Organization' }]);
    const me = (await app.inject({ method: 'GET', url: '/me', cookies: { sid } })).json();
    const events = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/audit-events`, cookies: { sid } })).json().events;
    const linked = events.find((e) => e.kind === 'github_linked');
    assert.ok(linked, JSON.stringify(events));
    assert.strictEqual(linked.actor, me.user.githubLogin, 'the suite person linked it');
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE github_login = 'gina'");
    assert.strictEqual(rows[0].n, 0, 'the GitHub account is only checked, never stored');
});

test('a GitHub account without access to the installation is refused and the suite session stays', async (t) => {
    const { app, fake } = await setUp(t);
    const { sid, tenantId } = await suiteAdmin(app, fake, '00000000-0000-4000-8000-0000000000a2');

    const callback = await connect(app, sid, tenantId, 'mallory');
    assert.strictEqual(callback.statusCode, 403, callback.body);
    assert.ok(!callback.cookies.some((c) => c.name === 'sid' && c.value), 'no other session');
    assert.deepStrictEqual(await installations(app, sid, tenantId), []);
    assert.strictEqual((await app.inject({ method: 'GET', url: '/me', cookies: { sid } })).statusCode, 200);
});

test('a GitHub admin with a session links as before, and their session stays too', async (t) => {
    const { app } = await setUp(t);
    const gina = await signIn(app, 'gina');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: gina }, payload: { name: 'Acme' } })).json().tenant.id;

    const callback = await connect(app, gina, tenantId, 'gina');
    assert.strictEqual(callback.statusCode, 302, callback.body);
    assert.ok(!callback.cookies.some((c) => c.name === 'sid'));
    assert.strictEqual((await installations(app, gina, tenantId)).length, 1);
});

test('without a session at the callback (it expired) the callback signs in through GitHub as today', async (t) => {
    const { app, fake } = await setUp(t);
    const { sid, tenantId } = await suiteAdmin(app, fake, '00000000-0000-4000-8000-0000000000a3');

    const callback = await connect(app, sid, tenantId, 'gina', { sendSession: false });
    // gina signs in through GitHub and is no member of the suite person's workspace: not found, as before this step.
    assert.strictEqual(callback.statusCode, 404, callback.body);
    assert.deepStrictEqual(await installations(app, sid, tenantId), []);
});

test('a suite member who is not an admin never gets to the GitHub authorization', async (t) => {
    const { app, fake } = await setUp(t);
    const { tenantId, sid: admin } = await suiteAdmin(app, fake, '00000000-0000-4000-8000-0000000000a4');
    const link = await app.inject({ method: 'PUT', url: `/tenants/${tenantId}/settings`, cookies: { sid: admin }, payload: { suiteOrganization: 'acme' } });
    assert.strictEqual(link.statusCode, 200, link.body);
    fake.state.claims = person(['viewer'], ['acme'], '00000000-0000-4000-8000-0000000000a5');
    const { sid: member } = await suiteSignIn(app, fake);

    const install = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github/install`, cookies: { sid: member } });
    assert.strictEqual(install.statusCode, 403, install.body);
});
