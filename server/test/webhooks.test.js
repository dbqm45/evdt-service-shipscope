const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { WebhookAuthError, verifyGitHubSignature, verifyAtlassianJwt, githubSyncKeys, jiraSyncKeys } = require('../lib/webhooks');

const GH_SECRET = 'gh-webhook-secret-0123456789';
const ATL_SECRET = 'atl-secret';
const sign = (body, secret = GH_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** An Atlassian-style webhook JWT. */
function jwt(claims, { secret = ATL_SECRET, alg = 'HS256' } = {}) {
    const head = b64({ alg, typ: 'JWT' });
    const body = b64(claims);
    return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const NOW = Date.parse('2026-10-16T12:00:00Z');
const secs = (ms) => Math.floor(ms / 1000);

test('GitHub signature: HMAC-SHA256 of the exact raw body with the webhook secret, compared in constant time', () => {
    const raw = Buffer.from('{"action":"created"}');
    verifyGitHubSignature({ secret: GH_SECRET, rawBody: raw, signature: sign(raw) });
    for (const signature of [undefined, '', 'sha1=abc', sign(raw).toUpperCase(), sign(raw, 'another-secret-0123456789'), sign(Buffer.from('{"action":"created" }'))]) {
        assert.throws(() => verifyGitHubSignature({ secret: GH_SECRET, rawBody: raw, signature }), WebhookAuthError, String(signature));
    }
});

test('Atlassian JWT: HS256 with the client secret only; expired, future, unsigned or re-signed tokens are refused', () => {
    const good = jwt({ iss: 'atl', iat: secs(NOW) - 5, exp: secs(NOW) + 60 });
    assert.strictEqual(verifyAtlassianJwt({ secret: ATL_SECRET, authorization: `Bearer ${good}`, now: NOW }).iss, 'atl');
    assert.ok(verifyAtlassianJwt({ secret: ATL_SECRET, authorization: `Bearer ${jwt({ iss: 'x' })}`, now: NOW }), 'claims without exp/iat are fine');
    const none = `${b64({ alg: 'none' })}.${b64({ iss: 'x' })}.sig`;
    const tampered = good.split('.');
    tampered[1] = b64({ iss: 'atl', iat: secs(NOW), exp: secs(NOW) + 9999, admin: true });
    for (const authorization of [
        undefined, '', good, `Basic ${good}`, `Bearer ${jwt({ iss: 'x' }, { secret: 'wrong' })}`, `Bearer ${jwt({ iss: 'x' }, { alg: 'HS512' })}`, `Bearer ${none}`,
        `Bearer ${tampered.join('.')}`, `Bearer ${jwt({ exp: secs(NOW) - 600 })}`, `Bearer ${jwt({ iat: secs(NOW) + 600 })}`, `Bearer ${jwt({ exp: 'soon' })}`,
        `Bearer ${b64({ alg: 'HS256' })}.bm90IGpzb24.x`, `Bearer ${jwt('just a string')}`,
    ]) {
        assert.throws(() => verifyAtlassianJwt({ secret: ATL_SECRET, authorization, now: NOW }), WebhookAuthError, String(authorization));
    }
    assert.ok(verifyAtlassianJwt({ secret: ATL_SECRET, authorization: `Bearer ${jwt({ exp: secs(NOW) - 60 })}`, now: NOW }), 'a minute of clock skew is tolerated');
});

test('what a delivery asks to sync: a deployment\'s repo; the Jira webhook ids it matched, else its site', () => {
    assert.deepStrictEqual(githubSyncKeys('deployment_status', { repository: { id: 42 } }), ['42']);
    assert.deepStrictEqual(githubSyncKeys('deployment', { repository: { id: 42 } }), ['42']);
    for (const [event, payload] of [['push', { repository: { id: 42 } }], ['ping', {}], ['deployment_status', { repository: { id: '42' } }], ['deployment_status', {}], ['deployment_status', null]]) {
        assert.deepStrictEqual(githubSyncKeys(event, payload), [], JSON.stringify([event, payload]));
    }
    assert.deepStrictEqual(jiraSyncKeys({ matchedWebhookIds: [1001, '7', -1, 1002], issue: { self: 'https://acme.atlassian.net/rest/api/2/issue/1' } }), ['webhook:1001', 'webhook:1002']);
    assert.deepStrictEqual(jiraSyncKeys({ issue: { self: 'https://api.atlassian.com/ex/jira/cloud-a/rest/api/2/issue/1' } }), ['cloud:cloud-a']);
    assert.deepStrictEqual(jiraSyncKeys({ issue: { self: 'https://acme.atlassian.net/rest/api/2/issue/1' } }), ['site:https://acme.atlassian.net']);
    for (const payload of [{}, null, { issue: { self: 'http://x/' } }, { matchedWebhookIds: 'x' }]) assert.deepStrictEqual(jiraSyncKeys(payload), [], JSON.stringify(payload));
});

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, testGitHubApp } = require('./helpers/auth');
const { requestSync } = require('../lib/webhooks');
const { webhookTick } = require('../worker');

async function setup(t, { githubApp = { ...testGitHubApp().app, webhookSecret: GH_SECRET }, atlassian = { clientId: 'atl-client', clientSecret: ATL_SECRET, encryptionKey: crypto.randomBytes(32), webhookUrl: null } } = {}) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, githubApp, atlassian });
    t.after(() => app.close());
    const queued = async () => (await pool.query('SELECT source, external_key FROM sync_requests ORDER BY source, external_key')).rows.map((r) => `${r.source}:${r.external_key}`);
    return { pool, app, queued };
}

const post = (app, url, body, headers) => app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', ...headers } });

test('POST /webhooks/github: a signed deployment status queues its repo once; anything unsigned is refused', async (t) => {
    const { app, queued } = await setup(t);
    const body = JSON.stringify({ action: 'created', deployment_status: { state: 'success' }, repository: { id: 70104, full_name: 'acme/web' } });
    const ok = await post(app, '/webhooks/github', body, { 'x-github-event': 'deployment_status', 'x-hub-signature-256': sign(body) });
    assert.strictEqual(ok.statusCode, 202, ok.body);
    assert.deepStrictEqual(ok.json(), { queued: 1 });
    await post(app, '/webhooks/github', body, { 'x-github-event': 'deployment_status', 'x-hub-signature-256': sign(body) });
    assert.deepStrictEqual(await queued(), ['github:70104'], 'repeated deliveries coalesce');

    const other = JSON.stringify({ repository: { id: 1 } });
    assert.deepStrictEqual((await post(app, '/webhooks/github', other, { 'x-github-event': 'push', 'x-hub-signature-256': sign(other) })).json(), { queued: 0 });
    for (const headers of [{}, { 'x-hub-signature-256': sign(body, 'not-the-secret-0123456789') }, { 'x-hub-signature-256': sign(`${body} `) }]) {
        const res = await post(app, '/webhooks/github', body.replace('70104', '666'), { 'x-github-event': 'deployment_status', ...headers });
        assert.strictEqual(res.statusCode, 401, JSON.stringify(headers));
    }
    const notJson = 'not json';
    assert.strictEqual((await post(app, '/webhooks/github', notJson, { 'x-hub-signature-256': sign(notJson) })).statusCode, 400);
    const form = await app.inject({ method: 'POST', url: '/webhooks/github', payload: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-hub-signature-256': sign('a=b') } });
    assert.strictEqual(form.statusCode, 415);
    assert.deepStrictEqual(await queued(), ['github:70104'], 'nothing refused was queued');
});

test('POST /webhooks/jira: a delivery with a valid Atlassian JWT queues what it names; a forged one is refused', async (t) => {
    const { app, queued } = await setup(t);
    const body = JSON.stringify({ webhookEvent: 'jira:issue_updated', matchedWebhookIds: [1001], issue: { key: 'ABC-1', self: 'https://acme.atlassian.net/rest/api/2/issue/1' } });
    const ok = await post(app, '/webhooks/jira', body, { authorization: `Bearer ${jwt({ iat: secs(Date.now()), exp: secs(Date.now()) + 60 })}` });
    assert.strictEqual(ok.statusCode, 202, ok.body);
    for (const authorization of [undefined, `Bearer ${jwt({ iss: 'x' }, { secret: 'forged' })}`, `Bearer ${jwt({ exp: secs(Date.now()) - 3600 })}`]) {
        assert.strictEqual((await post(app, '/webhooks/jira', body.replace('1001', '2002'), authorization ? { authorization } : {})).statusCode, 401);
    }
    assert.deepStrictEqual(await queued(), ['jira:webhook:1001']);
});

test('webhook routes exist only when configured: no GitHub secret, no /webhooks/github', async (t) => {
    const { app } = await setup(t, { githubApp: { ...testGitHubApp().app, webhookSecret: null }, atlassian: null });
    assert.strictEqual((await post(app, '/webhooks/github', '{}', { 'x-hub-signature-256': sign('{}') })).statusCode, 404);
    assert.strictEqual((await post(app, '/webhooks/jira', '{}', {})).statusCode, 404);
});

test('worker: queued requests become a targeted sync under the regular locks; a newer request survives the round', async (t) => {
    const { pool } = await setup(t);
    await requestSync(pool, { source: 'github', keys: ['70104', '70105'] });
    await requestSync(pool, { source: 'jira', keys: ['webhook:1001'] });
    const seen = [];
    const deps = {
        syncAll: async ({ repoIds }) => {
            seen.push(['github', repoIds]);
            // A delivery arriving while the sync runs must not be swallowed by it.
            await pool.query("UPDATE sync_requests SET requested_at = now() + interval '1 second' WHERE external_key = '70105'");
            return { repos: 2, inserted: 0, failed: 0 };
        },
        syncAllJira: async ({ keys }) => {
            seen.push(['jira', keys]);
            return { tenants: 1, issues: 0, failed: 0 };
        },
    };
    const log = [];
    await webhookTick(pool, { app: {}, atlassian: {} }, (m) => log.push(m), deps);
    assert.deepStrictEqual(seen, [['github', [70104, 70105]], ['jira', ['webhook:1001']]]);
    assert.deepStrictEqual((await pool.query('SELECT external_key FROM sync_requests')).rows.map((r) => r.external_key), ['70105']);

    // The periodic sync holds the lock: nothing is taken, the request waits.
    const holder = await pool.connect();
    await holder.query('SELECT pg_advisory_lock(727001)');
    seen.length = 0;
    await webhookTick(pool, { app: {}, atlassian: null }, () => {}, deps);
    await holder.query('SELECT pg_advisory_unlock(727001)');
    holder.release();
    assert.deepStrictEqual(seen, []);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM sync_requests')).rows[0].n, 1);

    // A sync that throws as a whole keeps its requests and is logged.
    await webhookTick(pool, { app: {}, atlassian: null }, (m) => log.push(m), { syncAll: async () => { throw new Error('GitHub down'); } });
    assert.match(log.at(-1), /github webhook sync failed: GitHub down/);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM sync_requests')).rows[0].n, 1);
});
