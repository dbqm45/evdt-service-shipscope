// Insights as a workspace setting (design-docs/CORE-SIMPLIFY-PLAN.pl.md, D2): an admin turns it on under General, the
// change is in the settings activity, and the dashboard data says so in capabilities.insights.
const { test } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { fakeGitHub, AUTH, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');

test('Insights: off by default, an admin turns it on, members cannot, the dashboard data carries it', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const fetch = fakeGitHub({ alice: { id: 850_610_001, login: 'alice' }, bob: { id: 850_610_002, login: 'bob' } });
    const app = buildApp({ pool, auth: AUTH, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const link = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice }, payload: { role: 'member' } })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    const settings = (sid, method = 'GET', payload) => app.inject({ method, url: `/tenants/${tenantId}/settings`, cookies: { sid }, payload });
    const data = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: bob } })).json();

    assert.strictEqual((await settings(alice)).json().insightsEnabled, false);
    assert.strictEqual((await data()).capabilities.insights, false);

    assert.strictEqual((await settings(alice, 'PUT', {})).statusCode, 400, 'at least one setting');
    assert.strictEqual((await settings(alice, 'PUT', { insightsEnabled: 'yes' })).statusCode, 400);
    assert.strictEqual((await settings(bob, 'PUT', { insightsEnabled: true })).statusCode, 403);

    const on = await settings(alice, 'PUT', { insightsEnabled: true });
    assert.strictEqual(on.statusCode, 200);
    assert.deepStrictEqual({ insights: on.json().insightsEnabled, days: on.json().deploymentRetentionDays }, { insights: true, days: 90 }, 'retention untouched');
    assert.strictEqual((await data()).capabilities.insights, true);

    const retention = await settings(alice, 'PUT', { deploymentRetentionDays: 30 });
    assert.deepStrictEqual({ insights: retention.json().insightsEnabled, days: retention.json().deploymentRetentionDays }, { insights: true, days: 30 }, 'Insights untouched');

    const events = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/audit-events`, cookies: { sid: alice } })).json().events;
    assert.ok(events.some((e) => e.kind === 'insights_changed' && e.subject === 'on'), 'in the settings activity');
});
