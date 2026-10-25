// Rotating TOKEN_ENCRYPTION_KEY (lib/secret-box.js key rings, lib/secret-rotation.js): old values stay readable, the
// worker's pass seals them again with the new key, and a workspace's signing secret does not change.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb } = require('./helpers/test-db');
const { withScope } = require('../lib/scope');
const { seal, open, needsReseal, keyId, SecretBoxError } = require('../lib/secret-box');
const { loadEncryptionKey } = require('../lib/config');
const { resealSecrets } = require('../lib/secret-rotation');
const { createTenantWithOwner } = require('../lib/tenants');
const { createFlagSource, endpointTokenAad } = require('../lib/flags');
const { tenantSigningSecret, signingSecret } = require('../lib/endpoint-flags');

const OLD = crypto.randomBytes(32);
const NEW = crypto.randomBytes(32);
const RING = { current: NEW, previous: [OLD] };

/** A value in the format before key ids (v1), as the earlier secret box wrote it. */
function sealV1(key, plaintext, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

test('secret box with a key ring: sealed with the current key and its id, opened by whichever key sealed it', () => {
    const sealed = seal(RING, 'tok', 'a');
    assert.strictEqual(sealed.split('.')[1], keyId(NEW));
    assert.ok(!sealed.includes(NEW.toString('base64url')), 'the id is a hash, never the key');
    assert.strictEqual(open(NEW, sealed, 'a'), 'tok');
    const old = seal(OLD, 'tok', 'a');
    assert.strictEqual(open(RING, old, 'a'), 'tok', 'a value sealed with the previous key');
    assert.throws(() => open(NEW, old, 'a'), SecretBoxError, 'not without the previous key');
    assert.strictEqual(open(RING, sealV1(OLD, 'tok', 'a'), 'a'), 'tok', 'the older format, with any key of the ring');
    assert.deepStrictEqual([needsReseal(RING, sealed), needsReseal(RING, old), needsReseal(RING, sealV1(NEW, 'x', 'a'))], [false, true, true]);
});

test('loadEncryptionKey: TOKEN_ENCRYPTION_KEY_PREVIOUS makes a ring; old keys alone or malformed are refused', () => {
    const b64 = (k) => k.toString('base64');
    assert.deepStrictEqual(loadEncryptionKey({ TOKEN_ENCRYPTION_KEY: b64(NEW), TOKEN_ENCRYPTION_KEY_PREVIOUS: ` ${b64(OLD)} ,` }), RING);
    assert.throws(() => loadEncryptionKey({ TOKEN_ENCRYPTION_KEY_PREVIOUS: b64(OLD) }), /TOKEN_ENCRYPTION_KEY is not/);
    assert.throws(() => loadEncryptionKey({ TOKEN_ENCRYPTION_KEY: b64(NEW), TOKEN_ENCRYPTION_KEY_PREVIOUS: 'short' }), /PREVIOUS key must be 32 bytes/);
});

test('a rotation: every stored secret is sealed again with the new key; the signing secret stays what the customer has', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { tenant, user } = await createTenantWithOwner(pool, { name: 'Acme', githubUserId: 894_000_001, githubLogin: 'alice' });
    const userId = user.id;
    const tenantId = tenant.id;
    const rows = (sql, params = []) => withScope(pool, { tenantId }, async (c) => (await c.query(sql, params)).rows);
    // Before the rotation, under the old key: a Jira token in the old format, an endpoint source with its token, and a
    // signing secret the customer copied (derived, never stored, as earlier versions did).
    await rows("INSERT INTO jira_connections (tenant_id, refresh_token_enc, scopes, available_sites, connected_by) VALUES ($1, $2, '{}', '[]', $3)", [tenantId, sealV1(OLD, 'jira-rt', tenantId), userId]);
    const { source } = await createFlagSource(pool, {
        tenantId, actorUserId: userId, name: 'API', kind: 'runtime', origin: 'endpoint', endpoint: { urls: { prod: 'https://flags.acme.io/f' } }, endpointToken: 'cust-1', encryptionKey: OLD,
    });
    const customerHas = signingSecret(OLD, tenantId);

    const first = await resealSecrets({ pool, encryptionKey: RING });
    assert.deepStrictEqual(first, { tenants: 1, resealed: 2, unreadable: 0, stale: 0 });
    const [jira] = await rows('SELECT refresh_token_enc FROM jira_connections');
    const [src] = await rows('SELECT endpoint_token_enc FROM flag_sources WHERE id = $1', [source.id]);
    assert.strictEqual(open(NEW, jira.refresh_token_enc, tenantId), 'jira-rt', 'opens with the new key alone');
    assert.strictEqual(open(NEW, src.endpoint_token_enc, endpointTokenAad(tenantId, source.id)), 'cust-1');
    assert.strictEqual(await withScope(pool, { tenantId }, (c) => tenantSigningSecret(c, { tenantId, encryptionKey: NEW })), customerHas,
        'stored during the rotation from the old key: still the customer\'s secret once the old key is gone');

    assert.deepStrictEqual(await resealSecrets({ pool, encryptionKey: RING }), { tenants: 1, resealed: 0, unreadable: 0, stale: 0 }, 'nothing left: the old key can go');
    // A value no key opens is reported and left alone.
    await rows('UPDATE flag_sources SET endpoint_token_enc = $2 WHERE id = $1', [source.id, seal(crypto.randomBytes(32), 'x', endpointTokenAad(tenantId, source.id))]);
    const lost = [];
    assert.deepStrictEqual(await resealSecrets({ pool, encryptionKey: NEW, log: (msg, f) => lost.push([msg, f.what]) }), { tenants: 1, resealed: 0, unreadable: 1, stale: 1 });
    assert.deepStrictEqual(lost, [['a stored endpoint token cannot be opened with any key', 'endpoint token']]);
});
