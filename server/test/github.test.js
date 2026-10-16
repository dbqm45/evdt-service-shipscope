const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, signInWithRedirect, testGitHubApp } = require('./helpers/auth');
const { withScope } = require('../lib/scope');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const USERS = {
    alice: { id: 830_000_001, login: 'alice' },
    bob: { id: 830_000_002, login: 'bob' },
    mallory: { id: 830_000_003, login: 'mallory' },
};
const ACME = 5001; // alice's organization installation
const EVIL = 5002; // mallory's own installation

// More than one page of repos (100 per page), so pagination is exercised.
const acmeRepos = Array.from({ length: 105 }, (_, i) => ({ id: 70_000 + i, full_name: `acme/repo-${i}`, private: i % 2 === 0 }));

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { app: githubApp, publicKey } = testGitHubApp();
    const fetch = fakeGitHub(USERS, {
        publicKey,
        installations: {
            [ACME]: { account: { login: 'acme', type: 'Organization' }, repos: acmeRepos },
            [EVIL]: { account: { login: 'mallory', type: 'User' }, repos: [{ id: 90_000, full_name: 'mallory/x', private: false }] },
        },
        userInstallations: { alice: [ACME], bob: [ACME], mallory: [EVIL] },
    });
    const app = buildApp({ pool, auth: AUTH, githubApp, fetch });
    t.after(() => app.close());
    const newTenant = async (sid, name) =>
        (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid }, payload: { name } })).json().tenant.id;
    return { pool, app, newTenant };
}

/** Runs install → GitHub → setup → sign-in → callback for `code` and returns the callback response. */
async function connect(app, sid, code, tenantId, installationId) {
    const install = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github/install`, cookies: { sid } });
    assert.strictEqual(install.statusCode, 302, install.body);
    const target = new URL(install.headers.location);
    assert.strictEqual(target.origin + target.pathname, 'https://github.com/apps/shipscope-test/installations/new');
    const state = target.searchParams.get('state');
    const ghInstall = install.cookies.find((c) => c.name === 'gh_install').value;

    const setupRes = await app.inject({
        method: 'GET',
        url: `/github/setup?installation_id=${installationId}&setup_action=install&state=${state}`,
        cookies: { sid, gh_install: ghInstall },
    });
    assert.strictEqual(setupRes.statusCode, 302, setupRes.body);
    assert.strictEqual(setupRes.headers.location, '/auth/github/login');
    const ghLink = setupRes.cookies.find((c) => c.name === 'gh_link').value;

    const { callback } = await signInWithRedirect(app, code, '/auth/github/login', { gh_link: ghLink });
    return callback;
}

test('an admin connects the GitHub App and chooses tracked repos', async (t) => {
    const { app, newTenant } = await setup(t);
    const alice = await signIn(app, 'alice');
    const tenantId = await newTenant(alice, 'Acme');

    const callback = await connect(app, alice, 'alice', tenantId, ACME);
    assert.strictEqual(callback.statusCode, 302, callback.body);
    assert.strictEqual(callback.headers.location, `/tenants/${tenantId}/github`);

    const connections = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github`, cookies: { sid: alice } });
    assert.deepStrictEqual(connections.json(), {
        installations: [{ installationId: ACME, accountLogin: 'acme', accountType: 'Organization' }],
        repos: [],
    });

    const listUrl = `/tenants/${tenantId}/github/installations/${ACME}/repositories`;
    const available = (await app.inject({ method: 'GET', url: listUrl, cookies: { sid: alice } })).json().repositories;
    assert.strictEqual(available.length, 105, 'both pages');
    assert.deepStrictEqual(available[0], { id: 70_000, fullName: 'acme/repo-0', private: true, tracked: false });

    const track = await app.inject({ method: 'PUT', url: `/tenants/${tenantId}/github/repos/70104`, cookies: { sid: alice }, payload: { installationId: ACME } });
    assert.strictEqual(track.statusCode, 200, track.body);
    assert.deepStrictEqual(track.json(), { repoId: 70_104, fullName: 'acme/repo-104', installationId: ACME });
    // Idempotent.
    assert.strictEqual((await app.inject({ method: 'PUT', url: `/tenants/${tenantId}/github/repos/70104`, cookies: { sid: alice }, payload: { installationId: ACME } })).statusCode, 200);

    const after = (await app.inject({ method: 'GET', url: listUrl, cookies: { sid: alice } })).json().repositories;
    assert.deepStrictEqual(after.filter((r) => r.tracked).map((r) => r.fullName), ['acme/repo-104']);
    assert.deepStrictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github`, cookies: { sid: alice } })).json().repos,
        [{ repoId: 70_104, fullName: 'acme/repo-104', installationId: ACME, lastSyncedAt: null, lastSyncError: null, versionFile: null, driftIgnorePaths: [] }]);

    // A repo of a different installation, or one that doesn't exist, can't be tracked through this one.
    const foreign = await app.inject({ method: 'PUT', url: `/tenants/${tenantId}/github/repos/90000`, cookies: { sid: alice }, payload: { installationId: ACME } });
    assert.strictEqual(foreign.statusCode, 404);
    const notLinked = await app.inject({ method: 'PUT', url: `/tenants/${tenantId}/github/repos/90000`, cookies: { sid: alice }, payload: { installationId: EVIL } });
    assert.strictEqual(notLinked.statusCode, 404, 'installation not linked to this tenant');

    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/github/repos/70104`, cookies: { sid: alice } })).statusCode, 204);
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/github/repos/70104`, cookies: { sid: alice } })).statusCode, 404);
});

test('an edited installation_id for someone else\'s organization is refused (the user can\'t access it)', async (t) => {
    const { pool, app, newTenant } = await setup(t);
    const mallory = await signIn(app, 'mallory');
    const malloryTenant = await newTenant(mallory, 'Evil Co');

    // Mallory starts a real install flow for her own tenant but swaps in Acme's installation id.
    const callback = await connect(app, mallory, 'mallory', malloryTenant, ACME);
    assert.strictEqual(callback.statusCode, 403, callback.body);

    const linked = await withScope(pool, { tenantId: malloryTenant }, (c) => c.query('SELECT installation_id FROM github_installations'));
    assert.deepStrictEqual(linked.rows, []);
});

test('an installation already connected to one tenant cannot be claimed by another', async (t) => {
    const { app, newTenant } = await setup(t);
    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const aliceTenant = await newTenant(alice, 'Acme');
    const bobTenant = await newTenant(bob, 'Acme (again)');

    assert.strictEqual((await connect(app, alice, 'alice', aliceTenant, ACME)).statusCode, 302);
    const second = await connect(app, bob, 'bob', bobTenant, ACME);
    assert.strictEqual(second.statusCode, 409, second.body);

    // Reconnecting the same tenant is fine (GitHub's "Configure" flow comes back through setup too).
    assert.strictEqual((await connect(app, alice, 'alice', aliceTenant, ACME)).statusCode, 302);
});

test('setup rejects a missing or mismatched state, and reports an owner-approval request', async (t) => {
    const { app, newTenant } = await setup(t);
    const alice = await signIn(app, 'alice');
    const tenantId = await newTenant(alice, 'Acme');

    const noCookie = await app.inject({ method: 'GET', url: `/github/setup?installation_id=${ACME}&setup_action=install&state=x`, cookies: { sid: alice } });
    assert.strictEqual(noCookie.statusCode, 400);

    const install = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github/install`, cookies: { sid: alice } });
    const ghInstall = install.cookies.find((c) => c.name === 'gh_install').value;
    const wrong = await app.inject({ method: 'GET', url: `/github/setup?installation_id=${ACME}&setup_action=install&state=other`, cookies: { sid: alice, gh_install: ghInstall } });
    assert.strictEqual(wrong.statusCode, 400);
    assert.ok(!wrong.cookies.some((c) => c.name === 'gh_link' && c.value));

    const state = new URL(install.headers.location).searchParams.get('state');
    const requested = await app.inject({ method: 'GET', url: `/github/setup?setup_action=request&state=${state}`, cookies: { sid: alice, gh_install: ghInstall } });
    assert.strictEqual(requested.statusCode, 202);
    assert.strictEqual(requested.json().status, 'pending-approval');
});

test('only admins connect and manage; members can see what is connected; outsiders get 404', async (t) => {
    const { app, newTenant } = await setup(t);
    const alice = await signIn(app, 'alice');
    const tenantId = await newTenant(alice, 'Acme');
    await connect(app, alice, 'alice', tenantId, ACME);

    const invite = await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice }, payload: { role: 'member' } });
    const bob = await signIn(app, 'bob');
    await app.inject({ method: 'POST', url: `${new URL(invite.json().url).pathname}/accept`, cookies: { sid: bob } });
    const mallory = await signIn(app, 'mallory');

    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github`, cookies: { sid: bob } })).statusCode, 200);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github`, cookies: { sid: mallory } })).statusCode, 404);
    for (const [method, url, payload] of [
        ['GET', `/tenants/${tenantId}/github/install`],
        ['GET', `/tenants/${tenantId}/github/installations/${ACME}/repositories`],
        ['PUT', `/tenants/${tenantId}/github/repos/70000`, { installationId: ACME }],
        ['DELETE', `/tenants/${tenantId}/github/repos/70000`],
        ['DELETE', `/tenants/${tenantId}/github/installations/${ACME}`],
    ]) {
        assert.strictEqual((await app.inject({ method, url, payload, cookies: { sid: bob } })).statusCode, 403, `member: ${method} ${url}`);
        assert.strictEqual((await app.inject({ method, url, payload, cookies: { sid: mallory } })).statusCode, 404, `outsider: ${method} ${url}`);
    }
});

test('unlinking an installation also stops tracking its repos', async (t) => {
    const { app, newTenant } = await setup(t);
    const alice = await signIn(app, 'alice');
    const tenantId = await newTenant(alice, 'Acme');
    await connect(app, alice, 'alice', tenantId, ACME);
    await app.inject({ method: 'PUT', url: `/tenants/${tenantId}/github/repos/70001`, cookies: { sid: alice }, payload: { installationId: ACME } });

    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/github/installations/${ACME}`, cookies: { sid: alice } })).statusCode, 204);
    assert.deepStrictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github`, cookies: { sid: alice } })).json(), { installations: [], repos: [] });
    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/github/installations/${ACME}`, cookies: { sid: alice } })).statusCode, 404);
});

test('RLS and the composite key keep installations and repos inside their tenant', async (t) => {
    const { pool, app, newTenant } = await setup(t);
    const alice = await signIn(app, 'alice');
    const mallory = await signIn(app, 'mallory');
    const aliceTenant = await newTenant(alice, 'Acme');
    const malloryTenant = await newTenant(mallory, 'Evil Co');
    await connect(app, alice, 'alice', aliceTenant, ACME);
    await app.inject({ method: 'PUT', url: `/tenants/${aliceTenant}/github/repos/70001`, cookies: { sid: alice }, payload: { installationId: ACME } });

    assert.deepStrictEqual((await pool.query('SELECT installation_id FROM github_installations')).rows, [], 'unscoped: nothing');
    assert.deepStrictEqual((await pool.query('SELECT repo_id FROM tracked_repos')).rows, []);
    const asMallory = await withScope(pool, { tenantId: malloryTenant }, (c) => c.query('SELECT installation_id FROM github_installations'));
    assert.deepStrictEqual(asMallory.rows, []);

    // Even with a hand-written INSERT, a repo can't point at another tenant's installation.
    await assert.rejects(
        () => withScope(pool, { tenantId: malloryTenant }, (c) =>
            c.query('INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, $2, $3)', [malloryTenant, ACME, 'acme/x'])),
        /foreign key/
    );
});

test('without a GitHub App config the connection routes do not exist', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub(USERS) });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const res = await app.inject({ method: 'GET', url: '/tenants/00000000-0000-0000-0000-000000000000/github', cookies: { sid: alice } });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((await app.inject({ method: 'GET', url: '/github/setup?state=x&setup_action=install', cookies: { sid: alice } })).statusCode, 404);
});
