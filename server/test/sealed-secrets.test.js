// Endpoint tokens only the worker can read (lib/sealed-box.js): the web service seals them with a public key and never
// opens them; the worker reads them with the private key, runs "Test" for a stored one, and moves older tokens over.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { sealFor, openWith, isSealedFor, sealingKeyId, generateSealingKeys, SealedBoxError } = require('../lib/sealed-box');
const { loadSealingKeys } = require('../lib/config');
const { seal } = require('../lib/secret-box');
const { endpointTokenAad } = require('../lib/flags');
const { runQueuedEndpointTest, refreshEndpointSource } = require('../lib/endpoint-flags');
const { resealSecrets } = require('../lib/secret-rotation');

const KEY = crypto.randomBytes(32);
const env = (pair) => ({ SECRETS_PUBLIC_KEY: pair.publicKey, SECRETS_PRIVATE_KEY: pair.privateKey });
const PAIR = generateSealingKeys();
const WORKER = loadSealingKeys(env(PAIR), { withPrivate: true });
const WEB = loadSealingKeys(env(PAIR), { withPrivate: false });

test('sealed box: sealed with the public key, opened only with its private key, bound to its place', () => {
    const sealed = sealFor(WEB.publicKey, 'cust-1', 'aad');
    assert.ok(isSealedFor(sealed) && !sealed.includes('cust-1'));
    assert.strictEqual(sealed.split('.')[1], sealingKeyId(WEB.publicKey));
    assert.notStrictEqual(sealFor(WEB.publicKey, 'cust-1', 'aad'), sealed, 'a fresh ephemeral key every time');
    assert.strictEqual(openWith(WORKER.privateKeys, sealed, 'aad'), 'cust-1');
    assert.throws(() => openWith(WORKER.privateKeys, sealed, 'other'), SealedBoxError, 'bound to its place');
    const other = loadSealingKeys(env(generateSealingKeys()), { withPrivate: true });
    assert.throws(() => openWith(other.privateKeys, sealed, 'aad'), /No private key/);
    assert.strictEqual(openWith([...other.privateKeys, ...WORKER.privateKeys], sealed, 'aad'), 'cust-1', 'a previous key still opens it');
    assert.throws(() => openWith(WORKER.privateKeys, seal(KEY, 'x', 'aad'), 'aad'), /Unknown sealed format/);
});

test('loadSealingKeys: optional; the web service takes the public key only, the worker needs the matching private one', () => {
    assert.strictEqual(loadSealingKeys({}, { withPrivate: true }), null);
    assert.deepStrictEqual(WEB.privateKeys, [], 'never the private key on the web service, even if set');
    assert.throws(() => loadSealingKeys({ SECRETS_PUBLIC_KEY: PAIR.publicKey }, { withPrivate: true }), /needs SECRETS_PRIVATE_KEY/);
    assert.throws(() => loadSealingKeys({ SECRETS_PRIVATE_KEY: PAIR.privateKey }, { withPrivate: true }), /SECRETS_PUBLIC_KEY is not/);
    assert.throws(() => loadSealingKeys({ ...env(PAIR), SECRETS_PRIVATE_KEY: generateSealingKeys().privateKey }, { withPrivate: true }), /does not belong/);
    assert.throws(() => loadSealingKeys({ SECRETS_PUBLIC_KEY: 'nope' }, { withPrivate: false }), /X25519 key/);
    const old = generateSealingKeys();
    assert.strictEqual(loadSealingKeys({ ...env(PAIR), SECRETS_PRIVATE_KEY_PREVIOUS: old.privateKey }, { withPrivate: true }).privateKeys.length, 2);
});

test('end to end: the web service stores a token it cannot read; Test and polling run on the worker', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const calls = [];
    const fetchImpl = async (url, { headers }) => {
        calls.push(headers);
        return { status: 200, contentType: 'application/json', body: '{"newCheckout": true}' };
    };
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 896_000_001, login: 'alice' } }), encryptionKey: KEY, sealingKeys: WEB, safeFetch: fetchImpl });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const api = (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid: alice }, payload });
    const endpoint = { urls: { prod: 'https://flags.acme.io/f' } };
    const { source } = (await api('POST', '/flag-sources', { name: 'API', kind: 'runtime', origin: 'endpoint', endpoint, endpointToken: 'cust-1' })).json();
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    const [{ endpoint_token_enc: stored }] = await rows('SELECT endpoint_token_enc FROM flag_sources WHERE id = $1', [source.id]);
    assert.ok(isSealedFor(stored), 'sealed for the worker');

    // Test with the stored token: the web service cannot read it, so the worker runs it.
    const queued = await api('POST', '/flag-endpoint-test', { endpoint, sourceId: source.id });
    assert.strictEqual(queued.statusCode, 202, queued.body);
    const { testId } = queued.json();
    assert.deepStrictEqual(calls, [], 'nothing was called from the web service');
    assert.deepStrictEqual((await api('GET', `/flag-endpoint-test/${testId}`)).json(), { status: 'pending' });
    const [{ external_key: key }] = (await pool.query("SELECT external_key FROM sync_requests WHERE source = 'endpoint-test'")).rows;
    assert.strictEqual(key, `${tenantId}/${testId}`);
    assert.strictEqual(await runQueuedEndpointTest(pool, { tenantId, testId, encryptionKey: KEY, sealingKeys: WORKER, fetchImpl }), true);
    assert.strictEqual(calls[0].authorization, 'Bearer cust-1', 'the worker opened it');
    assert.deepStrictEqual((await api('GET', `/flag-endpoint-test/${testId}`)).json(), { status: 'done', envs: [{ env: 'prod', host: 'flags.acme.io', flags: { newCheckout: { state: 'on' } } }] });
    assert.strictEqual(await runQueuedEndpointTest(pool, { tenantId, testId, encryptionKey: KEY, sealingKeys: WORKER, fetchImpl }), false, 'run once');
    // A typed token is tested right away, from the web service.
    assert.strictEqual((await api('POST', '/flag-endpoint-test', { endpoint, endpointToken: 'typed' })).json().envs[0].flags.newCheckout.state, 'on');

    // Polling: the worker reads it; without the private key the environment says why.
    assert.deepStrictEqual(await refreshEndpointSource(pool, { tenantId, sourceId: source.id, encryptionKey: KEY, sealingKeys: WORKER, fetchImpl }), { read: 1, failed: 0 });
    assert.deepStrictEqual(await refreshEndpointSource(pool, { tenantId, sourceId: source.id, encryptionKey: KEY, sealingKeys: WEB, fetchImpl }), { read: 0, failed: 1 });
    const [{ last_error: why }] = await rows('SELECT last_error FROM flag_source_envs WHERE source_id = $1', [source.id]);
    assert.match(why, /sealed for the worker: set SECRETS_PRIVATE_KEY/);
});

test('re-sealing moves endpoint tokens sealed with TOKEN_ENCRYPTION_KEY, or for an older key pair, to the current pair', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 896_000_002, login: 'alice' } }), encryptionKey: KEY });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const { source } = (await app.inject({ method: 'POST', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice },
        payload: { name: 'API', kind: 'runtime', origin: 'endpoint', endpoint: { urls: { prod: 'https://flags.acme.io/f' } }, endpointToken: 'cust-1' } })).json();
    const stored = async () => (await withScope(pool, { tenantId }, (c) => c.query('SELECT endpoint_token_enc FROM flag_sources WHERE id = $1', [source.id]))).rows[0].endpoint_token_enc;
    assert.match(await stored(), /^v2\./, 'before the key pair: the symmetric key');

    assert.strictEqual((await resealSecrets({ pool, encryptionKey: KEY, sealingKeys: WORKER })).resealed, 1);
    assert.strictEqual(openWith(WORKER.privateKeys, await stored(), endpointTokenAad(tenantId, source.id)), 'cust-1');

    // A new pair, the old private key kept as previous: moved to the new one.
    const next = generateSealingKeys();
    const rotated = loadSealingKeys({ ...env(next), SECRETS_PRIVATE_KEY_PREVIOUS: PAIR.privateKey }, { withPrivate: true });
    assert.strictEqual((await resealSecrets({ pool, encryptionKey: KEY, sealingKeys: rotated })).resealed, 1);
    assert.strictEqual((await stored()).split('.')[1], sealingKeyId(rotated.publicKey));
    assert.strictEqual((await resealSecrets({ pool, encryptionKey: KEY, sealingKeys: rotated })).resealed, 0, 'nothing left');
});
