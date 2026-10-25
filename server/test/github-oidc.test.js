// GitHub Actions OIDC tokens (lib/github-oidc.js): only GitHub's issuer and published keys, RS256, this server as the
// audience, a live exp; keys cached, refetched for an unknown key at most every 5 minutes.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { ISSUER, OidcTokenError, looksLikeJwt, createOidcVerifier } = require('../lib/github-oidc');

const AUD = 'https://shipscope.example.com';
const NOW = Date.parse('2026-10-25T12:00:00Z');
const secs = (ms) => Math.floor(ms / 1000);
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** A key pair standing in for GitHub's, and a signer of Actions-shaped tokens with it. */
function githubKeys(kid = 'k1') {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
    const sign = (claims, header = {}) => {
        const head = b64({ alg: 'RS256', typ: 'JWT', kid, ...header });
        const body = b64(claims);
        return `${head}.${body}.${crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
    };
    return { jwk, sign };
}
const claims = (extra = {}) => ({
    iss: ISSUER, aud: AUD, iat: secs(NOW) - 10, nbf: secs(NOW) - 10, exp: secs(NOW) + 300,
    repository: 'acme/web', repository_id: '8001', repository_owner_id: '77', ref: 'refs/heads/main', environment: 'production',
    sha: 'abc123', job_workflow_ref: 'acme/web/.github/workflows/flags.yml@refs/heads/main', actor: 'alice', ...extra,
});

test('a token GitHub signed for this server gives the run\'s repository, ref and environment', async () => {
    const gh = githubKeys();
    const fetchJwks = async () => [gh.jwk];
    const verifier = createOidcVerifier({ audience: AUD, fetchJwks, now: () => NOW });
    assert.deepStrictEqual(await verifier.verify(gh.sign(claims())), {
        repository: 'acme/web', repositoryId: 8001, ref: 'refs/heads/main', environment: 'production', sha: 'abc123',
        workflowRef: 'acme/web/.github/workflows/flags.yml@refs/heads/main', actor: 'alice',
    });
    assert.ok(await verifier.verify(gh.sign(claims({ aud: ['other', AUD] }))), 'an audience list including this server');
    assert.ok(looksLikeJwt(gh.sign(claims())));
    assert.ok(!looksLikeJwt(`shpi_${'a'.repeat(43)}`));
});

test('anything else is refused: another issuer, audience, key, algorithm, expired, not yet valid, no repository', async () => {
    const gh = githubKeys();
    const other = githubKeys('k1'); // same key id, different key: a forger's
    const verifier = createOidcVerifier({ audience: AUD, fetchJwks: async () => [gh.jwk], now: () => NOW });
    const head = (h) => b64({ typ: 'JWT', kid: 'k1', ...h });
    const good = gh.sign(claims()).split('.');
    const cases = {
        'not a JWT': 'shpi_x',
        'token signature does not match': other.sign(claims()),
        'not from GitHub Actions': gh.sign(claims({ iss: 'https://evil.example.com' })),
        'another audience': gh.sign(claims({ aud: 'https://other.example.com' })),
        'has expired': gh.sign(claims({ exp: secs(NOW) - 120 })),
        'no exp': gh.sign(claims({ exp: undefined })),
        'not valid yet': gh.sign(claims({ nbf: secs(NOW) + 600 })),
        'names no repository': gh.sign(claims({ repository_id: 'acme/web' })),
        'RS256 (HS256)': `${head({ alg: 'HS256' })}.${good[1]}.${crypto.createHmac('sha256', 'x').update('y').digest('base64url')}`,
        'RS256 (none)': `${head({ alg: 'none' })}.${good[1]}.e30`,
        'key GitHub does not publish': gh.sign(claims(), { kid: 'k9' }),
        'tampered claims': `${good[0]}.${b64(claims({ repository_id: '9999' }))}.${good[2]}`,
    };
    for (const [why, token] of Object.entries(cases)) {
        await assert.rejects(verifier.verify(token), OidcTokenError, why);
    }
    await assert.rejects(verifier.verify(gh.sign(claims({ exp: undefined }))), /has expired/);
});

test('keys: fetched once, refetched for an unknown key only after 5 minutes, kept when GitHub is down', async () => {
    const first = githubKeys('k1');
    const second = githubKeys('k2');
    let clock = NOW;
    let published = [first.jwk];
    let calls = 0;
    let down = false;
    const fetchJwks = async () => {
        calls += 1;
        if (down) throw new Error('HTTP 503');
        return published;
    };
    const verifier = createOidcVerifier({ audience: AUD, fetchJwks, now: () => clock });
    const at = (c) => ({ ...c, iat: secs(clock) - 1, nbf: secs(clock) - 1, exp: secs(clock) + 300 });
    await verifier.verify(first.sign(at(claims())));
    await verifier.verify(first.sign(at(claims())));
    assert.strictEqual(calls, 1, 'cached');
    published = [first.jwk, second.jwk];
    await assert.rejects(verifier.verify(second.sign(at(claims()))), /does not publish/);
    assert.strictEqual(calls, 1, 'an unknown key right after a fetch does not refetch');
    clock += 6 * 60 * 1000;
    assert.ok(await verifier.verify(second.sign(at(claims()))), 'GitHub rotated its keys');
    assert.strictEqual(calls, 2);
    down = true;
    clock += 2 * 60 * 60 * 1000;
    assert.ok(await verifier.verify(first.sign(at(claims()))), 'the cached keys while GitHub is down');
    const cold = createOidcVerifier({ audience: AUD, fetchJwks: async () => { throw new Error('HTTP 503'); }, now: () => clock });
    await assert.rejects(cold.verify(first.sign(at(claims()))), /signing keys could not be read: HTTP 503/);

    // GitHub down and nothing cached: one attempt per 10 s, however many tokens arrive.
    let attempts = 0;
    const throttled = createOidcVerifier({ audience: AUD, fetchJwks: async () => { attempts += 1; throw new Error('HTTP 503'); }, now: () => clock });
    for (let i = 0; i < 5; i++) await assert.rejects(throttled.verify(first.sign(at(claims()))), /signing keys could not be read/);
    assert.strictEqual(attempts, 1);
    clock += 11 * 1000;
    await assert.rejects(throttled.verify(first.sign(at(claims()))), /HTTP 503/);
    assert.strictEqual(attempts, 2);
});
