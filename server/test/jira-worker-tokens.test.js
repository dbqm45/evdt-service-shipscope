// Jira refresh tokens only the worker can read (stage 2, lib/jira-connections.js): the web service seals them for the
// worker and, when Settings needs Jira, asks the worker for a short-lived access token it then caches until expiry.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { fakeAtlassian } = require('./helpers/atlassian');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { generateSealingKeys, isSealedFor, openWith } = require('../lib/sealed-box');
const { loadSealingKeys } = require('../lib/config');
const { seal } = require('../lib/secret-box');
const { handOverAccessToken, accessTokenViaWorker, WorkerUnavailableError, JiraNotConnectedError } = require('../lib/jira-connections');
const { resealSecrets } = require('../lib/secret-rotation');

const KEY = crypto.randomBytes(32);
const PAIR = generateSealingKeys();
const env = { SECRETS_PUBLIC_KEY: PAIR.publicKey, SECRETS_PRIVATE_KEY: PAIR.privateKey };
const BASE = { clientId: 'atl-client', clientSecret: 'atl-secret', encryptionKey: KEY, webhookUrl: null };
const SITE = { id: 'cloud-a', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] };

async function setup(t) {
    const { pool, teardown } = await createTestDb();
    const atlassian = fakeAtlassian({ codes: { c1: [SITE] }, jira: { 'cloud-a': { boards: [{ id: 10, name: 'Sparks', type: 'scrum', location: { projectKey: 'ABC', projectName: 'Sparks' } }] } } });
    const github = fakeGitHub({ alice: { id: 897_000_001, login: 'alice' } });
    const fetch = (url, init) => (/^https:\/\/(auth|api)\.atlassian\.com\//.test(url) ? atlassian.handler(url, init) : github(url, init));
    const web = { ...BASE, sealingKeys: loadSealingKeys(env, { withPrivate: false }) };
    const worker = { ...BASE, sealingKeys: loadSealingKeys(env, { withPrivate: true }) };
    const app = buildApp({ pool, auth: AUTH, atlassian: web, fetch });
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const start = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/connect`, cookies: { sid: alice } });
    const state = new URL(start.headers.location).searchParams.get('state');
    const cookie = start.cookies.find((c) => c.name === 'jira_connect').value;
    await app.inject({ method: 'GET', url: `/auth/atlassian/callback?code=c1&state=${state}`, cookies: { sid: alice, jira_connect: cookie } });
    // A worker loop: hands over a token whenever the web service asks.
    let handed = 0;
    const stop = { done: false };
    const loop = (async () => {
        while (!stop.done) {
            const { rows } = await pool.query("SELECT external_key FROM sync_requests WHERE source = 'jira-token'");
            for (const r of rows) {
                await pool.query("DELETE FROM sync_requests WHERE source = 'jira-token' AND external_key = $1", [r.external_key]);
                await handOverAccessToken(pool, { tenantId: r.external_key, atlassian: worker, fetch });
                handed += 1;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    })();
    const stopWorker = async () => {
        stop.done = true;
        await loop;
    };
    // In this order: the worker loop, then the app, then the database.
    t.after(async () => {
        await stopWorker();
        await app.close();
        await teardown();
    });
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    return { pool, app, alice, tenantId, rows, web, worker, fetch, handedCount: () => handed, atlassian, stopWorker };
}

test('the web service stores a Jira refresh token it cannot read, and gets short-lived access tokens from the worker', async (t) => {
    const { app, alice, tenantId, rows, worker, handedCount, atlassian } = await setup(t);
    const [{ refresh_token_enc: stored }] = await rows('SELECT refresh_token_enc FROM jira_connections');
    assert.ok(isSealedFor(stored), 'sealed for the worker');
    assert.strictEqual(openWith(worker.sealingKeys.privateKeys, stored, tenantId), 'refresh-1');

    const boards = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/boards`, cookies: { sid: alice } });
    assert.strictEqual(boards.statusCode, 200, boards.body);
    assert.deepStrictEqual(boards.json().boards.map((b) => b.name), ['Sparks']);
    assert.strictEqual(handedCount(), 1);
    const refreshes = () => atlassian.calls.filter((u) => u === 'https://auth.atlassian.com/oauth/token').length;
    const before = refreshes();
    await app.inject({ method: 'GET', url: `/tenants/${tenantId}/jira/boards`, cookies: { sid: alice } });
    assert.deepStrictEqual([handedCount(), refreshes()], [1, before], 'the handed-over token is reused while it lasts');

    const [grant] = await rows('SELECT access_token_enc, expires_at FROM jira_access_grants');
    assert.ok(!grant.access_token_enc.includes('access-'), 'sealed, never in the clear');
    const [{ refresh_token_enc: rotated }] = await rows('SELECT refresh_token_enc FROM jira_connections');
    assert.ok(isSealedFor(rotated), 'the rotated refresh token is sealed for the worker too');

    assert.strictEqual((await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/jira`, cookies: { sid: alice } })).statusCode, 204);
    assert.deepStrictEqual(await rows('SELECT * FROM jira_access_grants'), [], 'disconnecting drops the handed-over token');
});

test('the worker\'s reason reaches Settings; no worker means a 503, never a hang', async (t) => {
    const { pool, tenantId, rows, web, stopWorker } = await setup(t);
    await rows("UPDATE jira_connections SET refresh_token_enc = $2 WHERE tenant_id = $1", [tenantId, seal(KEY, 'x', 'y').replace(/^v2/, 'p1') + '.zz']);
    // Unopenable for the worker too: it records why, and the web service passes it on.
    await assert.rejects(accessTokenViaWorker(pool, { tenantId, atlassian: web }), (err) => err instanceof JiraNotConnectedError && /cannot be read/.test(err.message));
    await stopWorker();
    await rows('DELETE FROM jira_access_grants');
    await assert.rejects(accessTokenViaWorker(pool, { tenantId, atlassian: web, sleep: async () => {} }), WorkerUnavailableError);
});

test('re-sealing moves Jira refresh tokens sealed with TOKEN_ENCRYPTION_KEY to the worker\'s key pair', async (t) => {
    const { pool, tenantId, rows, worker } = await setup(t);
    await rows('UPDATE jira_connections SET refresh_token_enc = $2 WHERE tenant_id = $1', [tenantId, seal(KEY, 'refresh-1', tenantId)]);
    assert.strictEqual((await resealSecrets({ pool, encryptionKey: KEY, sealingKeys: worker.sealingKeys })).resealed, 1);
    const [{ refresh_token_enc: moved }] = await rows('SELECT refresh_token_enc FROM jira_connections');
    assert.strictEqual(openWith(worker.sealingKeys.privateKeys, moved, tenantId), 'refresh-1');
});
