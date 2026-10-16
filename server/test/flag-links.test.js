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

const USERS = { alice: { id: 880_000_001, login: 'alice' }, bob: { id: 880_000_002, login: 'bob' } };
const SITE = { id: 'cloud-a', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] };
const ATLASSIAN = { clientId: 'atl-client', clientSecret: 'atl-secret', encryptionKey: crypto.randomBytes(32), webhookUrl: null };

const story = (key, fields = {}) => ({
    key,
    fields: {
        summary: `${key} title`, issuetype: { name: 'Story', hierarchyLevel: 0 }, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        project: { key: 'ABC', name: 'Sparks' }, customfield_10020: [{ id: 103 }], labels: [], ...fields,
    },
});

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const atlassian = fakeAtlassian({
        codes: { c1: [SITE] },
        jira: {
            'cloud-a': {
                boards: [{ id: 10, name: 'Sparks', type: 'scrum', location: { projectKey: 'ABC', projectName: 'Sparks' } }],
                sprints: { 10: [{ id: 103, name: 'Sparks 27.3.2', state: 'active', startDate: '2026-10-01', endDate: '2026-10-30' }] },
                fields: [
                    { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
                    { id: 'customfield_10050', name: 'Feature flag', schema: { type: 'string' } },
                    { id: 'customfield_10051', name: 'Flags', schema: { type: 'array', items: 'string' } },
                    { id: 'customfield_10052', name: 'Rollout flags', schema: { type: 'array', items: 'option' } },
                    { id: 'customfield_10053', name: 'Story points', schema: { type: 'number' } },
                    { id: 'summary', name: 'Summary', schema: { type: 'string' } },
                ],
                issues: [
                    story('ABC-1', { customfield_10050: 'newCheckout' }),
                    story('ABC-2', { labels: ['flag:newCheckout', 'FLAG:darkMode', 'team'] }),
                    story('ABC-3'),
                ],
            },
        },
    });
    const github = fakeGitHub(USERS);
    const fetch = (url, init) => (/^https:\/\/(auth|api)\.atlassian\.com\//.test(url) ? atlassian.handler(url, init) : github(url, init));
    const app = buildApp({ pool, auth: AUTH, atlassian: ATLASSIAN, fetch });
    t.after(() => app.close());

    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const as = (sid) => (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid }, payload });
    const link = (await as(alice)('POST', '/invitations', { role: 'member' })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });

    const start = await as(alice)('GET', '/jira/connect');
    const state = new URL(start.headers.location).searchParams.get('state');
    await app.inject({ method: 'GET', url: `/auth/atlassian/callback?code=c1&state=${state}`, cookies: { sid: alice, jira_connect: start.cookies.find((c) => c.name === 'jira_connect').value } });
    await as(alice)('PUT', '/jira/boards', { boardIds: [10] });

    const { token } = (await as(alice)('POST', '/flag-sources', { name: 'LD', kind: 'runtime' })).json();
    const send = (body) => app.inject({ method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token.token}` }, payload: { schemaVersion: 2, ...body } });
    const sent = await send({
        observations: [{ key: 'newCheckout', env: 'prod', state: 'partial', rollout: 25 }, { key: 'darkMode', env: 'prod', state: 'on' }],
        flags: [{ key: 'newCheckout', description: 'From LD', jiraKeys: ['ABC-9'] }],
    });
    assert.strictEqual(sent.statusCode, 200, sent.body);
    const flags = async (sid = alice) => Object.fromEntries((await as(sid)('GET', '/flags')).json().flags.map((f) => [f.key, f]));
    const meta = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json().flagsMeta;
    return { app, as, alice, bob, send, flags, meta };
}

test('Jira names flags: admins pick a text/labels/select field or a label prefix; each sync links issues to flags', async (t) => {
    const { as, alice, bob, flags, meta } = await setup(t);
    const admin = as(alice);

    const fields = await admin('GET', '/jira/flag-fields');
    assert.deepStrictEqual(fields.json().fields, [
        { id: 'customfield_10050', name: 'Feature flag', type: 'text' },
        { id: 'customfield_10051', name: 'Flags', type: 'labels' },
        { id: 'customfield_10052', name: 'Rollout flags', type: 'options' },
    ], 'custom text/labels/select fields only, by name');
    assert.strictEqual((await as(bob)('GET', '/jira/flag-fields')).statusCode, 403);

    await admin('POST', '/jira/sync');
    assert.deepStrictEqual((await flags()).newCheckout.links, { sender: ['ABC-9'], manual: [], jira: [] }, 'no convention yet: nothing from Jira');

    assert.deepStrictEqual((await admin('PUT', '/jira/flag-link', { type: 'label', prefix: 'flag:' })).json(), { flagLink: { type: 'label', prefix: 'flag:' } });
    assert.deepStrictEqual((await admin('GET', '/jira')).json().flagLink, { type: 'label', prefix: 'flag:' });
    await admin('POST', '/jira/sync');
    let list = await flags();
    assert.deepStrictEqual(list.newCheckout.links.jira, ['ABC-2']);
    assert.deepStrictEqual(list.darkMode.links.jira, ['ABC-2'], 'the prefix matches case-insensitively');
    assert.deepStrictEqual((await meta()).newCheckout.jiraKeys, ['ABC-2', 'ABC-9'], 'the dashboard links every origin');

    assert.deepStrictEqual((await admin('PUT', '/jira/flag-link', { type: 'field', id: 'customfield_10050' })).json().flagLink,
        { type: 'field', id: 'customfield_10050', name: 'Feature flag' });
    await admin('POST', '/jira/sync');
    list = await flags();
    assert.deepStrictEqual([list.newCheckout.links.jira, list.darkMode.links.jira], [['ABC-1'], []], 'the next sync reads the new convention');

    await admin('PUT', '/jira/flag-link', { type: 'none' });
    assert.strictEqual((await admin('GET', '/jira')).json().flagLink, null);

    for (const [body, code] of [
        [{ type: 'field', id: 'customfield_10053' }, 400], // a number field can't name flags
        [{ type: 'field', id: 'summary' }, 400],
        [{ type: 'label', prefix: 'bad prefix!' }, 400],
        [{ type: 'label' }, 400],
        [{ type: 'none', prefix: 'x' }, 400],
        [{ type: 'other' }, 400],
    ]) {
        assert.strictEqual((await admin('PUT', '/jira/flag-link', body)).statusCode, code, JSON.stringify(body));
    }
    assert.strictEqual((await as(bob)('PUT', '/jira/flag-link', { type: 'label', prefix: 'flag:' })).statusCode, 403);
});

test('a flag set by hand: description and linked issues that a source\'s next message never overwrites', async (t) => {
    const { as, alice, bob, send, flags, meta } = await setup(t);
    const admin = as(alice);

    let list = await flags(bob);
    assert.deepStrictEqual(Object.keys(list).sort(), ['darkMode', 'newCheckout'], 'members read the flags');
    assert.deepStrictEqual(list.newCheckout.states.prod['runtime-be'].state, 'partial');
    assert.strictEqual(list.newCheckout.description, 'From LD');

    const put = await admin('PUT', '/flags/newCheckout', { description: '  Our new checkout ', jiraKeys: ['ABC-5', 'ABC-4'] });
    assert.deepStrictEqual(put.json(), { key: 'newCheckout', manualDescription: 'Our new checkout', manualJiraKeys: ['ABC-4', 'ABC-5'] });
    await send({ observations: [{ key: 'newCheckout', env: 'prod', state: 'on' }, { key: 'darkMode', env: 'prod', state: 'on' }], flags: [{ key: 'newCheckout', description: 'LD v2', jiraKeys: ['ABC-9'] }] });
    list = await flags();
    assert.deepStrictEqual([list.newCheckout.description, list.newCheckout.senderDescription, list.newCheckout.manualDescription], ['Our new checkout', 'LD v2', 'Our new checkout']);
    assert.deepStrictEqual(list.newCheckout.links, { sender: ['ABC-9'], manual: ['ABC-4', 'ABC-5'], jira: [] });
    const m = (await meta()).newCheckout;
    assert.deepStrictEqual([m.description, m.jiraKeys], ['Our new checkout', ['ABC-4', 'ABC-5', 'ABC-9']]);

    await admin('PUT', '/flags/newCheckout', { description: null, jiraKeys: [] });
    assert.strictEqual((await flags()).newCheckout.description, 'LD v2', 'cleared: the sender\'s description again');

    for (const [url, body, code] of [
        ['/flags/unknownFlag', { description: null, jiraKeys: [] }, 404],
        ['/flags/newCheckout', { description: null, jiraKeys: ['abc-1'] }, 400],
        ['/flags/newCheckout', { description: 'x'.repeat(501), jiraKeys: [] }, 400],
        ['/flags/newCheckout', { jiraKeys: [] }, 400],
        ['/flags/bad%20key', { description: null, jiraKeys: [] }, 400],
    ]) {
        assert.strictEqual((await admin('PUT', url, body)).statusCode, code, `${url} ${JSON.stringify(body)}`);
    }
    assert.strictEqual((await as(bob)('PUT', '/flags/newCheckout', { description: 'x', jiraKeys: [] })).statusCode, 403);
});
