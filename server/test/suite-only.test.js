// Step 3 of the suite sign-in (design-docs/SUITE-LOGIN-PLAN.pl.md, "Krok 3"): an admin of a workspace linked to a suite
// organization turns off GitHub sign-in for it (`suiteOnly`). Accounts signed in through GitHub keep their memberships
// but are refused on every route of that workspace until it is turned off again.
const { test } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres suite-only tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, testGitHubApp } = require('./helpers/auth');
const { SUITE, person, fakeSuite, suiteSignIn } = require('./helpers/suite');

const REFUSAL = 'This workspace signs in through the suite';

/** gina (GitHub) owns Acme, linked to the suite organization acme; sam (suite) is its admin too. */
async function setUp(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { app: githubApp, publicKey } = testGitHubApp();
    const fake = fakeSuite(fakeGitHub({ gina: { id: 850_000_001, login: 'gina' }, gus: { id: 850_000_002, login: 'gus' } }, { publicKey }));
    const app = buildApp({ pool, auth: AUTH, suite: SUITE, githubApp, fetch: fake.fetchFn });
    t.after(() => app.close());
    const gina = await signIn(app, 'gina');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: gina }, payload: { name: 'Acme' } })).json().tenant.id;
    const put = (sid, payload) => app.inject({ method: 'PUT', url: `/tenants/${tenantId}/settings`, cookies: { sid }, payload });
    assert.strictEqual((await put(gina, { suiteOrganization: 'acme' })).statusCode, 200);
    fake.state.claims = person(['admin'], ['acme'], '00000000-0000-4000-8000-0000000000b1');
    const { sid: sam } = await suiteSignIn(app, fake);
    return { pool, app, fake, gina, sam, tenantId, put };
}

/** Every method and full path the app registers, from Fastify's route tree. */
function routesOf(app) {
    const out = [];
    const stack = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
        const m = /^([│ ]*)(?:└── |├── )(\S*) \(([^)]*)\)/.exec(line.replace(/[└├]──/, (s) => s));
        if (!m) continue;
        const depth = Math.round(m[1].length / 4);
        stack.length = depth;
        const path = (stack[depth - 1] || '') + m[2];
        stack[depth] = path === '/' ? '' : path;
        for (const method of m[3].split(', ')) if (method !== 'HEAD') out.push({ method, path: path.startsWith('/') ? path : `/${path}` });
    }
    return out;
}

test('suite-only can be turned on only by a suite admin, only with a linked organization, and is audited', async (t) => {
    const { app, gina, sam, tenantId, put } = await setUp(t);

    const byGitHubAdmin = await put(gina, { suiteOnly: true });
    assert.strictEqual(byGitHubAdmin.statusCode, 409, byGitHubAdmin.body);
    assert.match(byGitHubAdmin.json().error, /signed in through the suite/);

    const on = await put(sam, { suiteOnly: true });
    assert.strictEqual(on.statusCode, 200, on.body);
    assert.strictEqual(on.json().suiteOnly, true);

    const unlink = await put(sam, { suiteOrganization: null });
    assert.strictEqual(unlink.statusCode, 409, unlink.body);
    assert.match(unlink.json().error, /suite-only/);

    const events = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/audit-events`, cookies: { sid: sam } })).json().events;
    assert.ok(events.some((e) => e.kind === 'suite_only_changed' && e.subject === 'on'), JSON.stringify(events));
});

test('suite-only needs a linked organization', async (t) => {
    const { app, fake } = await setUp(t);
    fake.state.claims = person(['admin'], ['globex'], '00000000-0000-4000-8000-0000000000b2');
    const { sid } = await suiteSignIn(app, fake);
    const own = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid }, payload: { name: 'Own' } })).json().tenant.id;
    const res = await app.inject({ method: 'PUT', url: `/tenants/${own}/settings`, cookies: { sid }, payload: { suiteOnly: true } });
    assert.strictEqual(res.statusCode, 409, res.body);
    assert.match(res.json().error, /organization/);
});

test('with suite-only on, every route of the workspace refuses a GitHub account; the suite admin still gets in', async (t) => {
    const { app, gina, sam, tenantId, put } = await setUp(t);
    assert.strictEqual((await put(sam, { suiteOnly: true })).statusCode, 200);

    const tenantRoutes = routesOf(app).filter((r) => r.path.includes(':tenantId'));
    assert.ok(tenantRoutes.length > 50, `found ${tenantRoutes.length} workspace routes`);
    for (const { method, path } of tenantRoutes) {
        const url = path.replace(':tenantId', tenantId).replace(/:[A-Za-z]+/g, '1');
        const res = await app.inject({ method, url, cookies: { sid: gina }, headers: { accept: 'application/json' }, payload: method === 'GET' || method === 'DELETE' ? undefined : {} });
        assert.strictEqual(res.statusCode, 403, `${method} ${path}: ${res.statusCode} ${res.body.slice(0, 120)}`);
        assert.match(res.body, new RegExp(REFUSAL), `${method} ${path}`);
    }
    const mine = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: sam } });
    assert.strictEqual(mine.statusCode, 200, mine.body);
});

test('a GitHub account still sees the workspace in its list, marked suite-only; turning it off gives access back with the same role', async (t) => {
    const { app, gina, sam, tenantId, put } = await setUp(t);
    assert.strictEqual((await put(sam, { suiteOnly: true })).statusCode, 200);

    const me = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: gina } })).json();
    assert.deepStrictEqual(me.tenants.find((x) => x.id === tenantId), { id: tenantId, name: 'Acme', role: 'admin', suiteOnly: true });

    assert.strictEqual((await put(sam, { suiteOnly: false })).statusCode, 200);
    const back = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: gina } });
    assert.strictEqual(back.statusCode, 200, back.body);
    assert.ok(back.json().members.some((m) => m.githubLogin === 'gina' && m.role === 'admin'));
});

test('an invitation to a suite-only workspace does not let a GitHub account in', async (t) => {
    const { app, sam, tenantId, put } = await setUp(t);
    const invite = await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: sam }, payload: { role: 'member' } });
    assert.strictEqual(invite.statusCode, 201, invite.body);
    const token = new URL(invite.json().url).pathname.split('/').pop();
    assert.strictEqual((await put(sam, { suiteOnly: true })).statusCode, 200);

    const gus = await signIn(app, 'gus');
    const accept = await app.inject({ method: 'POST', url: `/invitations/${token}/accept`, cookies: { sid: gus } });
    assert.strictEqual(accept.statusCode, 403, accept.body);
    assert.match(accept.body, new RegExp(REFUSAL));
});

test('a GitHub admin of a suite-only workspace cannot link a GitHub installation to it either', async (t) => {
    const { app, gina, sam, tenantId, put } = await setUp(t);
    const install = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/github/install`, cookies: { sid: gina } });
    assert.strictEqual(install.statusCode, 302, install.body);
    const state = new URL(install.headers.location).searchParams.get('state');
    const ghInstall = install.cookies.find((c) => c.name === 'gh_install').value;
    assert.strictEqual((await put(sam, { suiteOnly: true })).statusCode, 200);

    // The installation finished on GitHub after the switch: the setup redirect names the workspace only in a cookie.
    const setupRes = await app.inject({
        method: 'GET', url: `/github/setup?installation_id=7001&setup_action=install&state=${state}`, cookies: { sid: gina, gh_install: ghInstall },
    });
    assert.strictEqual(setupRes.statusCode, 403, setupRes.body);
    assert.match(setupRes.body, new RegExp(REFUSAL));
});

test('the members list says who signed in through the suite, so Settings can mark GitHub accounts while suite-only is on', async (t) => {
    const { app, sam, tenantId } = await setUp(t);
    const members = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: sam } })).json().members;
    assert.deepStrictEqual(members.map((m) => [m.githubLogin, m.viaSuite]).sort(), [['Person b1', true], ['gina', false]]);
});
