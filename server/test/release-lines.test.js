// Release lines in Jira mode (G1.3, pdi contract 0.4.0 "Konwencje"): each issue's line R1…Rn read by the tenant's
// convention (jira_connections.release_link: a `release:` label by default, else fixVersion or a field), kept in
// release_lines (migration 036, RLS) and returned as the dashboard's releasePlan.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { extractReleaseLine, issueFields, mapIssue } = require('../lib/jira-model');

const LABEL = { type: 'label', prefix: 'release:' };

test('extractReleaseLine: a release: label (any case), a fixVersion name, a field; the lowest of several; else null', () => {
    assert.strictEqual(extractReleaseLine({ labels: ['team', 'release:R1'] }, LABEL), 'R1');
    assert.strictEqual(extractReleaseLine({ labels: ['RELEASE:r2'] }, LABEL), 'R2', 'prefix and line without case');
    assert.strictEqual(extractReleaseLine({ labels: ['release:R3', 'release:R1'] }, LABEL), 'R1', 'the lowest line wins');
    assert.strictEqual(extractReleaseLine({ labels: ['release:MVP', 'release:R', 'release:R1x', 'team'] }, LABEL), null, 'only R<n>');
    assert.strictEqual(extractReleaseLine({ labels: ['mvp:R1'] }, { type: 'label', prefix: 'mvp:' }), 'R1', 'a prefix of the tenant\'s own');
    assert.strictEqual(extractReleaseLine({}, LABEL), null);

    const fv = { type: 'fixVersion' };
    assert.strictEqual(extractReleaseLine({ fixVersions: [{ id: '1', name: '2.4.0' }, { id: '2', name: 'R2' }] }, fv), 'R2');
    assert.strictEqual(extractReleaseLine({ fixVersions: [{ name: 'Release R1' }] }, { type: 'fixVersion', prefix: 'Release ' }), 'R1');
    assert.strictEqual(extractReleaseLine({ fixVersions: [{ name: '2.4.0' }] }, fv), null, 'a deploy version is not a line');
    assert.strictEqual(extractReleaseLine({ labels: ['release:R1'] }, fv), null, 'by fixVersion, labels do not count');

    const field = { type: 'field', id: 'customfield_10060' };
    assert.strictEqual(extractReleaseLine({ customfield_10060: 'R4' }, field), 'R4');
    assert.strictEqual(extractReleaseLine({ customfield_10060: { value: 'R1' } }, field), 'R1', 'a select option');
    assert.strictEqual(extractReleaseLine({ customfield_10060: [{ value: 'R2' }, { value: 'R1' }] }, field), 'R1');
    assert.strictEqual(extractReleaseLine({ customfield_10060: 7 }, field), null);
    assert.strictEqual(extractReleaseLine({ labels: ['release:R1'] }, { type: 'none' }), null);
    assert.strictEqual(extractReleaseLine({ labels: ['release:R1'] }, null), null);
});

test('issueFields asks for fixVersions and the line field; mapIssue carries releaseLine', () => {
    assert.ok(issueFields({}).includes('fixVersions'));
    assert.ok(issueFields({ releaseLink: { type: 'field', id: 'customfield_10060' } }).includes('customfield_10060'));
    const issue = mapIssue(
        { key: 'ABC-1', fields: { summary: 'Pay', issuetype: { name: 'Story', hierarchyLevel: 0 }, status: { name: 'To Do', statusCategory: { key: 'new' } }, labels: ['release:R1'] } },
        { sprintFieldId: null, epicLinkFieldId: null, flaggedFieldId: null, releaseLink: LABEL },
        { pi: 'PI-1', sprintsInScope: new Map() }
    );
    assert.strictEqual(issue.releaseLine, 'R1');
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { connectPdiForTest } = require('./helpers/pdi');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { fakeAtlassian } = require('./helpers/atlassian');
const { withScope } = require('../lib/scope');

const USERS = { alice: { id: 870_000_001, login: 'alice' }, bob: { id: 870_000_002, login: 'bob' } };
const SITE = { id: 'cloud-a', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] };
const ATLASSIAN = { clientId: 'atl-client', clientSecret: 'atl-secret', encryptionKey: crypto.randomBytes(32), webhookUrl: null };

const story = (key, fields = {}) => ({
    key,
    fields: {
        summary: `${key} title`, issuetype: { name: 'Story', hierarchyLevel: 0 }, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        project: { key: 'ABC', name: 'Sparks' }, customfield_10020: [{ id: 103 }], labels: [], parent: { key: 'ABC-10', fields: { summary: 'Payments' } }, ...fields,
    },
});

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const site = {
        boards: [{ id: 10, name: 'Sparks', type: 'scrum', location: { projectKey: 'ABC', projectName: 'Sparks' } }],
        sprints: { 10: [{ id: 103, name: 'Sparks 27.3.2', state: 'active', startDate: '2026-10-01', endDate: '2026-10-30' }] },
        fields: [
            { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
            { id: 'customfield_10060', name: 'Release line', schema: { type: 'option' } },
        ],
        issues: [
            story('ABC-1', { labels: ['release:R1'], fixVersions: [{ id: '1', name: 'R2' }] }),
            story('ABC-2', { labels: ['release:R2'] }),
            story('ABC-3', { fixVersions: [{ id: '1', name: 'R2' }] }),
            story('ABC-4'),
        ],
    };
    const atlassian = fakeAtlassian({ codes: { c1: [SITE] }, jira: { 'cloud-a': site } });
    const github = fakeGitHub(USERS);
    const fetch = (url, init) => (/^https:\/\/(auth|api)\.atlassian\.com\//.test(url) ? atlassian.handler(url, init) : github(url, init));
    const app = buildApp({ pool, auth: AUTH, atlassian: ATLASSIAN, fetch });
    t.after(() => app.close());

    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    await connectPdiForTest(pool, tenantId);
    const as = (sid) => (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid }, payload });
    const link = (await as(alice)('POST', '/invitations', { role: 'member' })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    const start = await as(alice)('GET', '/jira/connect');
    const state = new URL(start.headers.location).searchParams.get('state');
    await app.inject({ method: 'GET', url: `/auth/atlassian/callback?code=c1&state=${state}`, cookies: { sid: alice, jira_connect: start.cookies.find((c) => c.name === 'jira_connect').value } });
    await as(alice)('PUT', '/jira/boards', { boardIds: [10] });
    const plan = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: bob } })).json().releasePlan;
    const lines = async () => Object.fromEntries((await plan()).lines.map((l) => [l.key, l.release]));
    return { pool, app, as, alice, bob, tenantId, site, plan, lines };
}

test('sync: lines from release: labels by default, from fixVersion when an admin says so; a removed label removes the line', async (t) => {
    const { as, alice, bob, site, plan, lines } = await setup(t);
    const admin = as(alice);
    assert.deepStrictEqual((await admin('GET', '/jira')).json().releaseLink, { type: 'label', prefix: 'release:' }, 'the default');

    await admin('POST', '/jira/sync');
    assert.deepStrictEqual(await lines(), { 'ABC-1': 'R1', 'ABC-2': 'R2' });
    const first = (await plan()).lines.find((l) => l.key === 'ABC-1');
    assert.deepStrictEqual([first.title, first.type, first.epicKey, first.epicTitle], ['ABC-1 title', 'Story', 'ABC-10', 'Payments']);
    assert.strictEqual((await plan()).mode, 'jira');
    assert.deepStrictEqual((await plan()).plans, [], 'no repo plans in Jira mode');

    assert.deepStrictEqual((await admin('PUT', '/jira/release-link', { type: 'fixVersion' })).json(), { releaseLink: { type: 'fixVersion', prefix: '' } });
    await admin('POST', '/jira/sync');
    assert.deepStrictEqual(await lines(), { 'ABC-1': 'R2', 'ABC-3': 'R2' }, 'ABC-2 has no fixVersion: its line is gone');

    await admin('PUT', '/jira/release-link', { type: 'field', id: 'customfield_10060' });
    site.issues[3].fields.customfield_10060 = { value: 'R1' };
    await admin('POST', '/jira/sync');
    assert.deepStrictEqual(await lines(), { 'ABC-4': 'R1' });

    await admin('PUT', '/jira/release-link', { type: 'label', prefix: 'release:' });
    site.issues[0].fields.labels = [];
    await admin('POST', '/jira/sync');
    assert.deepStrictEqual(await lines(), { 'ABC-2': 'R2' });

    for (const [body, code] of [[{ type: 'label', prefix: 'no spaces' }, 400], [{ type: 'field', id: 'customfield_99999' }, 400], [{ type: 'sprint' }, 400], [{ type: 'label' }, 400]]) {
        assert.strictEqual((await admin('PUT', '/jira/release-link', body)).statusCode, code, JSON.stringify(body));
    }
    assert.strictEqual((await as(bob)('PUT', '/jira/release-link', { type: 'fixVersion' })).statusCode, 403, 'admins only');
    const events = (await admin('GET', '/audit-events')).json().events.filter((e) => e.kind === 'jira_release_link_changed');
    assert.ok(events.length >= 3, 'every change is in the settings activity');
});

test('RLS: release_lines and flag_commit_links are invisible and unwritable without the tenant\'s scope', async (t) => {
    const { pool, as, alice, tenantId } = await setup(t);
    await as(alice)('POST', '/jira/sync');
    await withScope(pool, { tenantId }, (c) => c.query("INSERT INTO flag_commit_links (tenant_id, flag_key, item_key, repo_id) VALUES ($1, 'payment-retry', 'TSK-57', 1)", [tenantId]));

    for (const table of ['release_lines', 'flag_commit_links']) {
        assert.ok((await withScope(pool, { tenantId }, (c) => c.query(`SELECT * FROM ${table}`))).rows.length > 0, `${table}: seen in scope`);
        assert.strictEqual((await pool.query(`SELECT * FROM ${table}`)).rows.length, 0, `${table}: unscoped reads see nothing`);
        const other = crypto.randomUUID();
        assert.strictEqual((await withScope(pool, { tenantId: other }, (c) => c.query(`SELECT * FROM ${table}`))).rows.length, 0, `${table}: another tenant sees nothing`);
    }
    await assert.rejects(() => pool.query("INSERT INTO release_lines (tenant_id, item_key, release, origin) VALUES ($1, 'ABC-9', 'R1', 'jira')", [tenantId]), /row-level security/);
    await assert.rejects(() => pool.query("INSERT INTO flag_commit_links (tenant_id, flag_key, item_key, repo_id) VALUES ($1, 'x', 'TSK-1', 1)", [tenantId]), /row-level security/);
    await assert.rejects(
        () => withScope(pool, { tenantId }, (c) => c.query("INSERT INTO release_lines (tenant_id, item_key, release, origin) VALUES ($1, 'ABC-9', 'MVP', 'jira')", [tenantId])),
        /check/, 'a line is R<n>'
    );
});
