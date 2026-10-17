const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { fakeAtlassian } = require('./helpers/atlassian');
const { withScope, RLS_TABLES } = require('../lib/scope');

const USERS = { alice: { id: 870_000_001, login: 'alice' }, bob: { id: 870_000_002, login: 'bob' }, carol: { id: 870_000_003, login: 'carol' } };
const SITE = { id: 'cloud-a', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] };
const ATLASSIAN = { clientId: 'atl-client', clientSecret: 'atl-secret', encryptionKey: crypto.randomBytes(32), webhookUrl: 'https://shipscope.example/webhooks/jira' };
// Every RLS table holds tenant data (scope.js's RLS_TABLES): after deleting a tenant, none of them may keep a row of it.
const TENANT_TABLES = RLS_TABLES;

const sprint = { id: 103, name: 'Sparks 27.3.2', state: 'active', startDate: '2026-10-01', endDate: '2026-10-30' };
const issue = {
    key: 'ABC-1',
    fields: {
        summary: 'Checkout', issuetype: { name: 'Story', hierarchyLevel: 0 }, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        project: { key: 'ABC', name: 'Sparks' }, customfield_10020: [{ id: 103 }],
    },
};

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const atlassian = fakeAtlassian({
        codes: { c1: [SITE] },
        scope: 'read:jira-work manage:jira-webhook offline_access',
        jira: {
            'cloud-a': {
                boards: [{ id: 10, name: 'Sparks', type: 'scrum', location: { projectKey: 'ABC', projectName: 'Sparks' } }],
                sprints: { 10: [sprint] },
                fields: [{ id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }],
                issues: [issue],
            },
        },
    });
    const github = fakeGitHub(USERS);
    const fetch = (url, init) => (/^https:\/\/(auth|api)\.atlassian\.com\//.test(url) ? atlassian.handler(url, init) : github(url, init));
    const app = buildApp({ pool, auth: AUTH, atlassian: ATLASSIAN, fetch });
    t.after(() => app.close());
    const as = (sid) => (method, url, payload) => app.inject({ method, url, cookies: { sid }, payload });
    return { pool, app, atlassian, as };
}

/** A tenant with something in every table: a member, an invitation, a tracked repo and a deployment, a flag, Jira. */
async function populatedTenant({ pool, app, as }, owner, name, { jira = false } = {}) {
    const call = as(owner);
    const tenantId = (await call('POST', '/tenants', { name })).json().tenant.id;
    await call('POST', `/tenants/${tenantId}/invitations`, { role: 'member' });
    const { token } = (await call('POST', `/tenants/${tenantId}/flag-sources`, { name: 'LD', kind: 'runtime' })).json();
    const ingest = await app.inject({
        method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token.token}` },
        payload: { schemaVersion: 2, observations: [{ key: 'newCheckout', env: 'prod', state: 'on' }] },
    });
    assert.strictEqual(ingest.statusCode, 200, ingest.body);
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, $2, 'acme', 'Organization')", [tenantId, jira ? 5001 : 5002]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, $2, $3, 'acme/web')", [tenantId, jira ? 1 : 2, jira ? 5001 : 5002]);
        await c.query(
            `INSERT INTO deployments (tenant_id, repo_id, deployment_id, environment, status, sha, deployed_at, related_issues)
             VALUES ($1, $2, $3, 'prod', 'success', $4, now(), '{ABC-1}')`,
            [tenantId, jira ? 1 : 2, jira ? 11 : 22, 'a'.repeat(40)]
        );
        await c.query("INSERT INTO issue_deployments (tenant_id, issue_key, environment, repo_id, first_deployed_at) VALUES ($1, 'ABC-1', 'prod', $2, now())", [tenantId, jira ? 1 : 2]);
    });
    if (jira) {
        const start = await call('GET', `/tenants/${tenantId}/jira/connect`);
        const state = new URL(start.headers.location).searchParams.get('state');
        const cookie = start.cookies.find((c) => c.name === 'jira_connect').value;
        await app.inject({ method: 'GET', url: `/auth/atlassian/callback?code=c1&state=${state}`, cookies: { sid: owner, jira_connect: cookie } });
        await call('PUT', `/tenants/${tenantId}/jira/boards`, { boardIds: [10] });
        assert.strictEqual((await call('POST', `/tenants/${tenantId}/jira/sync`)).statusCode, 200);
    }
    return tenantId;
}

async function counts(pool, tenantId) {
    return withScope(pool, { tenantId }, async (c) => {
        const out = {};
        for (const table of TENANT_TABLES) out[table] = (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].n;
        return out;
    });
}

test('deleting a workspace: admins only, with its name typed back; everything it held goes, other workspaces stay', async (t) => {
    const ctx = await setup(t);
    const { pool, app, atlassian, as } = ctx;
    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const carol = await signIn(app, 'carol');
    const acme = await populatedTenant(ctx, alice, 'Acme', { jira: true });
    const other = await populatedTenant(ctx, carol, 'Other');
    // Bob joins Acme as a plain member.
    const link = (await as(alice)('POST', `/tenants/${acme}/invitations`, { role: 'member' })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    const before = await counts(pool, acme);
    for (const table of TENANT_TABLES) assert.ok(before[table] > 0, `the test fills ${table}`);
    const otherBefore = await counts(pool, other);

    const del = (sid, body) => as(sid)('DELETE', `/tenants/${acme}`, body);
    assert.strictEqual((await del(bob, { confirmName: 'Acme' })).statusCode, 403, 'a member can\'t');
    assert.strictEqual((await del(carol, { confirmName: 'Acme' })).statusCode, 404, 'an outsider sees no such tenant');
    for (const body of [{ confirmName: 'acme' }, { confirmName: 'Acme!' }, { confirmName: '' }, {}, { confirmName: 'Acme', force: true }]) {
        assert.strictEqual((await del(alice, body)).statusCode, 400, JSON.stringify(body));
    }
    assert.match((await del(alice, { confirmName: 'Acme Corp' })).json().error, /Type the workspace name exactly/);
    assert.deepStrictEqual(atlassian.webhookCalls.filter((c) => c.method === 'DELETE'), [], 'nothing outside ShipScope is touched before the checks pass');
    assert.deepStrictEqual(await counts(pool, acme), before, 'refused attempts delete nothing');

    const ok = await del(alice, { confirmName: '  Acme ' });
    assert.strictEqual(ok.statusCode, 204, ok.body);
    assert.deepStrictEqual(atlassian.webhookCalls.filter((c) => c.method === 'DELETE').map((c) => c.body), [{ webhookIds: [1000] }], 'the Jira webhook goes first');
    assert.deepStrictEqual(Object.values(await counts(pool, acme)), TENANT_TABLES.map(() => 0));
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [acme])).rows[0].n, 0);
    assert.deepStrictEqual(await counts(pool, other), otherBefore, 'another workspace is untouched');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 3, 'people stay: they may belong to other workspaces');

    assert.deepStrictEqual((await as(alice)('GET', '/me')).json().tenants, []);
    assert.strictEqual((await as(alice)('GET', '/')).headers.location, '/start');
    assert.strictEqual((await as(bob)('GET', `/t/${acme}/settings`)).statusCode, 404);
    assert.strictEqual((await del(alice, { confirmName: 'Acme' })).statusCode, 404, 'gone');
});

test('deleting a workspace whose Jira grant was revoked still works (the webhook then lingers until it expires)', async (t) => {
    const ctx = await setup(t);
    const alice = await signIn(ctx.app, 'alice');
    const acme = await populatedTenant(ctx, alice, 'Acme', { jira: true });
    ctx.atlassian.revokeAll();
    assert.strictEqual((await ctx.as(alice)('DELETE', `/tenants/${acme}`, { confirmName: 'Acme' })).statusCode, 204);
    assert.deepStrictEqual(Object.values(await counts(ctx.pool, acme)), TENANT_TABLES.map(() => 0));
});

test('disconnecting Jira removes ShipScope\'s webhook on Atlassian\'s side too', async (t) => {
    const ctx = await setup(t);
    const alice = await signIn(ctx.app, 'alice');
    const acme = await populatedTenant(ctx, alice, 'Acme', { jira: true });
    assert.strictEqual((await ctx.as(alice)('DELETE', `/tenants/${acme}/jira`)).statusCode, 204);
    assert.deepStrictEqual(ctx.atlassian.webhookCalls.filter((c) => c.method === 'DELETE').map((c) => c.body), [{ webhookIds: [1000] }]);
});
