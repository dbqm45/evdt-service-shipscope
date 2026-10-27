// The pdi layer behind the connection (design-docs/PDI-GATE-PLAN.pl.md): without a connection the dashboard shows the
// core only, the service API answers 404 and no release events are looked for; while pending the API and events run so
// pdi can prove the connection; once connected people see the layer. Workspaces that already used events or a service
// token get a pending connection from backfillPdiConnections().
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { fakeGitHub, AUTH, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { refreshWorkItems } = require('../lib/work-items');
const { detectReleaseEvents } = require('../lib/outgoing-events');
const { backfillPdiConnections } = require('../lib/pdi-connection');

const KEY = crypto.randomBytes(32);
const sha = (n) => n.toString(16).padStart(40, 'a');
const DIR = 'docs/project/changes';
const INTENT_MD = '---\nartifact: intent\nchange: CHG-12\n---\n\n# Retry failed payments\n';
const PLAN_MD = '---\nartifact: plan\nchange: CHG-12\ntasks: [TSK-57]\n---\n\n- TSK-57: Retry endpoint (done)\n';
const RELEASE = 'change: CHG-12\nreleases:\n  - { id: R1, tasks: [TSK-57] }\n';

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const repo = { files: { [sha(1)]: { [`${DIR}/CHG-12/intent.md`]: INTENT_MD, [`${DIR}/CHG-12/plan.md`]: PLAN_MD, [`${DIR}/CHG-12/release.yaml`]: RELEASE } }, trees: {}, fileCommits: { [DIR]: [sha(1)] } };
    repo.trees[sha(1)] = { truncated: false, tree: Object.keys(repo.files[sha(1)]).map((p) => ({ path: p, type: 'blob', sha: 'x' })) };
    const fetch = fakeGitHub({ alice: { id: 850_600_001, login: 'alice' } }, { repos: { 'acme/pay': repo } });
    const receiver = async () => ({ status: 200, headers: {}, contentType: 'application/json', body: '{}' });
    const app = buildApp({ pool, auth: AUTH, fetch, encryptionKey: KEY, safeFetch: receiver });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const as = (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid: alice }, payload });
    const api = (url) => app.inject({ method: 'GET', url: `/api/tenants/${tenantId}${url}`, cookies: { sid: alice } });
    const service = (token, url) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    await rows("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 9, 'acme', 'Organization')", [tenantId]);
    await rows("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 9, 'acme/pay')", [tenantId]);
    await refreshWorkItems({ pool, token: 'inst-token-1', tenantId, repo: { repoId: 1, fullName: 'acme/pay' }, fetch });
    return { pool, app, tenantId, as, api, service, rows };
}

const layer = (data) => ({
    pdi: data.capabilities.pdi,
    changes: data.jiraIndex.pis.some((p) => p.pi === '@changes'),
    plans: data.releasePlan.plans.length,
    urls: Object.keys(data.workItemUrls).length,
    indexed: 'CHG-12' in data.issueStatusIndex,
});

test('without pdi: the dashboard shows the core only, the service API is 404, no release events are looked for', async (t) => {
    const { api, as, service, pool, tenantId, rows } = await setup(t);
    assert.deepStrictEqual(layer((await api('/dashboard-data')).json()), { pdi: false, changes: false, plans: 0, urls: 0, indexed: false });
    assert.deepStrictEqual((await api('/jira-issues?pi=@changes')).json(), []);

    const { token } = (await as('POST', '/service-tokens', { name: 'tf' })).json();
    const item = await service(token.token, '/api/service/v1/items/CHG-12');
    assert.strictEqual(item.statusCode, 404);
    assert.match(item.json().error, /not connected with pdi/);
    assert.strictEqual((await service(token.token, '/api/service/v1/connection')).json().pdi.state, 'none', 'the connection route always answers');

    await as('POST', '/event-subscriptions', { url: 'https://hooks.example.com/x', types: ['feature.released'] });
    assert.deepStrictEqual(await detectReleaseEvents(pool, { tenantId }), { events: 0, queued: 0 });
    assert.deepStrictEqual(await rows('SELECT kind FROM event_state'), [], 'not even a baseline');
});

test('pending: the service API and events run so pdi can prove it, the layer stays hidden; connected shows it', async (t) => {
    const { api, as, service, pool, tenantId, rows } = await setup(t);
    const { env } = (await as('POST', '/pdi-connection', { receiverUrl: 'https://pdi.example.com' })).json();
    assert.strictEqual(layer((await api('/dashboard-data')).json()).pdi, false);
    assert.strictEqual((await service(env.PDI_SHIPSCOPE_TOKEN, '/api/service/v1/items/CHG-12')).statusCode, 200);
    await detectReleaseEvents(pool, { tenantId });
    assert.ok((await rows('SELECT kind FROM event_state')).length, 'events are looked for while pending');

    assert.strictEqual((await as('POST', '/pdi-connection/test')).json().connection.state, 'connected');
    assert.deepStrictEqual(layer((await api('/dashboard-data')).json()), { pdi: true, changes: true, plans: 1, urls: 2, indexed: true });
    assert.deepStrictEqual((await api('/jira-issues?pi=@changes')).json().map((i) => i.key), ['CHG-12', 'TSK-57']);
});

test('backfill: a workspace that already used events or a service token gets a pending connection, once', async (t) => {
    const { as, service, pool, rows } = await setup(t);
    const sub = (await as('POST', '/event-subscriptions', { url: 'https://pdi.example.com/events/shipscope', types: ['release.stage_changed', 'feature.released'] })).json().subscription;
    await as('POST', '/service-tokens', { name: 'ci' });
    const { token } = (await as('POST', '/service-tokens', { name: 'pdi' })).json();
    await rows('UPDATE event_subscriptions SET last_delivered_at = now()');
    await service(token.token, '/api/service/v1/connection');

    assert.deepStrictEqual(await backfillPdiConnections(pool), { created: 1 });
    const [connection] = await rows('SELECT receiver_url, subscription_id, service_token_id FROM pdi_connections');
    const [pdiToken] = await rows("SELECT id FROM service_tokens WHERE name = 'pdi'");
    assert.deepStrictEqual(connection, { receiver_url: 'https://pdi.example.com', subscription_id: sub.id, service_token_id: pdiToken.id });
    assert.strictEqual((await as('GET', '/pdi-connection')).json().connection.state, 'connected', 'its past deliveries and reads count');
    assert.deepStrictEqual(await backfillPdiConnections(pool), { created: 0 }, 'once');
});

test('backfill: a token alone gives a connection without an address, pending until it is connected properly', async (t) => {
    const { as, pool, rows } = await setup(t);
    assert.deepStrictEqual(await backfillPdiConnections(pool), { created: 0 }, 'nothing used, nothing created');
    await as('POST', '/service-tokens', { name: 'tf' });
    assert.deepStrictEqual(await backfillPdiConnections(pool), { created: 1 });
    assert.deepStrictEqual((await rows('SELECT receiver_url FROM pdi_connections'))[0], { receiver_url: null });
    const { connection } = (await as('GET', '/pdi-connection')).json();
    assert.strictEqual(connection.state, 'pending');
});
