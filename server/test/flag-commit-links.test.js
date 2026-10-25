// `Flag: <key>` in a commit message (tf talos-story-run, next to `Change: TSK-n`): a strong link between the flag
// and the work items the same commit names (G1.3). Stronger than the file-commit suggestions
// (lib/flag-link-suggestions.js): linked at once, no admin answer needed. Never stronger than an admin: a dismissed
// key stays dismissed, a hand-set link stays.
const { test } = require('node:test');
const assert = require('node:assert');
const { flagLinksFromMessages } = require('../lib/deployment-logic');

test('flagLinksFromMessages: each Flag: trailer pairs with the keys of its own commit (Change: TSK-n and Jira keys)', () => {
    assert.deepStrictEqual(flagLinksFromMessages([
        'feat(pay): retry a failed payment\n\nChange: TSK-57\nFlag: payment-retry',
        'fix: ABC-7 double charge\n\nflag: payment-retry, retryBanner',
        'chore: bump ABC-8',
        'feat: no key here\n\nFlag: orphan',
        'feat: TSK-60 bad flag\n\nFlag: __proto__\nFlag: not a key!',
    ]), [
        { flag: 'payment-retry', keys: ['TSK-57'] },
        { flag: 'payment-retry', keys: ['ABC-7'] },
        { flag: 'retryBanner', keys: ['ABC-7'] },
    ]);
    assert.deepStrictEqual(flagLinksFromMessages(['Flag: x is in the subject, ABC-1']), [], 'only a trailer line counts');
    assert.deepStrictEqual(flagLinksFromMessages([]), []);
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, testGitHubApp } = require('./helpers/auth');
const { withScope } = require('../lib/scope');
const { syncAll } = require('../lib/deployment-sync');

const sha = (n) => n.toString(16).padStart(40, 'b');

test('a deployment\'s commits link flags strongly: on the dashboard and in Settings; a dismissed key never comes back', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { app: githubApp, publicKey } = testGitHubApp();
    const created = new Date(Date.now() - 3600_000).toISOString();
    const repo = {
        deployments: [
            { id: 2, environment: 'prod', sha: sha(2), created_at: new Date(Date.now() - 1800_000).toISOString() },
            { id: 1, environment: 'prod', sha: sha(1), created_at: created },
        ],
        statuses: { 1: [{ state: 'success', created_at: created }], 2: [{ state: 'success', created_at: new Date(Date.now() - 1700_000).toISOString() }] },
        commits: { [sha(1)]: 'feat: retry\n\nChange: TSK-57\nFlag: payment-retry', [sha(2)]: 'feat: banner' },
        compare: () => ({ status: 'ahead', commits: [
            { sha: sha(3), commit: { message: 'fix: ABC-7 double charge\n\nFlag: payment-retry' } },
            { sha: sha(2), commit: { message: 'chore: ABC-8 unrelated' } },
        ] }),
    };
    const fetch = fakeGitHub({ alice: { id: 860_000_001, login: 'alice' } }, {
        publicKey, installations: { 7: { account: { login: 'acme', type: 'Organization' }, repos: [] } }, repos: { 'acme/pay': repo },
    });
    const app = buildApp({ pool, auth: AUTH, githubApp, fetch });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const as = (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid: alice }, payload });
    await withScope(pool, { tenantId }, async (c) => {
        await c.query("INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type) VALUES ($1, 7, 'acme', 'Organization')", [tenantId]);
        await c.query("INSERT INTO tracked_repos (tenant_id, repo_id, installation_id, full_name) VALUES ($1, 1, 7, 'acme/pay')", [tenantId]);
    });

    const { token } = (await as('POST', '/flag-sources', { name: 'LD', kind: 'runtime' })).json();
    const sent = await app.inject({
        method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token.token}` },
        payload: { schemaVersion: 2, observations: [{ key: 'payment-retry', env: 'prod', state: 'partial', rollout: 10 }], flags: [{ key: 'payment-retry', jiraKeys: ['ABC-1'] }] },
    });
    assert.strictEqual(sent.statusCode, 200, sent.body);

    await syncAll({ pool, app: githubApp, fetch });
    const meta = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard-data`, cookies: { sid: alice } })).json().flagsMeta['payment-retry'];
    const settings = async () => (await as('GET', '/flags')).json().flags.find((f) => f.key === 'payment-retry');
    assert.deepStrictEqual((await meta()).jiraKeys, ['ABC-1', 'ABC-7', 'TSK-57'], 'the sender\'s plus both commits\' keys, not ABC-8');
    assert.deepStrictEqual((await settings()).links.commit, ['ABC-7', 'TSK-57']);

    // A commit link outranks a file-commit suggestion: the same key is no longer offered as one.
    await withScope(pool, { tenantId }, (c) => c.query("UPDATE flags SET suggested_jira_keys = '{ABC-7,ABC-9}' WHERE tenant_id = $1", [tenantId]));
    assert.deepStrictEqual((await settings()).suggestions, ['ABC-9']);

    // An admin's hand-set link and dismissal win: a dismissed key is not linked again by a commit.
    await as('PUT', '/flags/payment-retry', { description: null, jiraKeys: ['ABC-2'] });
    await withScope(pool, { tenantId }, (c) => c.query("UPDATE flags SET suggested_jira_keys = '{TSK-57}' WHERE tenant_id = $1", [tenantId]));
    assert.strictEqual((await as('POST', '/flags/payment-retry/suggestions', { jiraKey: 'TSK-57', accept: false })).statusCode, 200);
    await syncAll({ pool, app: githubApp, fetch });
    assert.deepStrictEqual((await meta()).jiraKeys, ['ABC-1', 'ABC-2', 'ABC-7']);
    assert.deepStrictEqual((await settings()).links, { sender: ['ABC-1'], manual: ['ABC-2'], jira: [], commit: ['ABC-7'] });
});
