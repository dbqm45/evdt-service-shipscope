// A push source taking GitHub Actions OIDC tokens (migration 032, lib/flags.js ingestWithOidc()): only runs of the
// source's own repositories, on its refs, for its environments; refusals the source should know about are noted on
// it, the rest are a plain 401. Against a real Postgres, with a key pair standing in for GitHub's.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { ISSUER, createOidcVerifier } = require('../lib/github-oidc');
const { linkInstallation, trackRepo } = require('../lib/github-connections');

const AUD = 'https://shipscope.example.com';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'gh1' };
/** A token as GitHub Actions would mint it for a run of `repo` on `ref`. */
function actionsToken({ repo = 'acme/web', repoId = '8001', ref = 'refs/heads/main', aud = AUD } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'gh1' });
    const body = b64({ iss: ISSUER, aud, iat: now, nbf: now, exp: now + 300, repository: repo, repository_id: repoId, ref });
    return `${head}.${body}.${crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
const obs = (key, env, state) => ({ key, env, state });

test('GitHub Actions of a covered repository send with an OIDC token; other repositories, refs and environments are refused', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 897_000_001, login: 'alice' } }), oidcVerifier: createOidcVerifier({ audience: AUD, fetchJwks: async () => [JWK] }) });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const aliceId = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: alice } })).json().user.id;
    await linkInstallation(pool, { tenantId, actorUserId: aliceId, installation: { installationId: 7001, accountLogin: 'acme', accountType: 'Organization' } });
    await trackRepo(pool, { tenantId, actorUserId: aliceId, installationId: 7001, repo: { id: 8001, fullName: 'acme/web' } });
    await trackRepo(pool, { tenantId, actorUserId: aliceId, installationId: 7001, repo: { id: 8002, fullName: 'acme/api' } });
    const api = (method, url, payload) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid: alice }, payload });

    // Settings checks: push sources only, with at least one service, refs and environments in shape.
    const refused = async (payload, pattern) => {
        const res = await api('POST', '/flag-sources', payload);
        assert.strictEqual(res.statusCode, 400, res.body);
        assert.match(res.json().error, pattern);
    };
    await refused({ name: 'x', kind: 'build', oidc: {} }, /Choose the repositories/);
    await refused({ name: 'x', kind: 'build', repoIds: [8001], oidc: { refs: ['main'] } }, /refs\/heads\/main/);
    const created = await api('POST', '/flag-sources', { name: 'Web CI', kind: 'build', repoIds: [8001], oidc: { refs: ['refs/heads/main', 'refs/tags/v*'], environments: ['qa', 'prod'] } });
    assert.strictEqual(created.statusCode, 201, created.body);
    const { source } = created.json();
    assert.deepStrictEqual(source.oidc, { refs: ['refs/heads/main', 'refs/tags/v*'], environments: ['qa', 'prod'] });
    const sourceRef = `${tenantId}/${source.id}`;
    const send = (token, payload, ref = sourceRef) => app.inject({
        method: 'POST', url: '/api/flags/ingest', headers: { authorization: `Bearer ${token}`, 'x-shipscope-source': ref },
        payload: { schemaVersion: 2, ...payload },
    });

    let res = await send(actionsToken(), { observations: [obs('newCheckout', 'prod', 'on')] });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.deepStrictEqual(res.json(), { source: 'Web CI', flags: 1, changed: 1, removed: 0, stale: 0, created: ['newCheckout'] });
    assert.strictEqual((await send(actionsToken({ ref: 'refs/tags/v1.4.0' }), { observations: [obs('newCheckout', 'prod', 'on')] })).statusCode, 200, 'a tag matching v*');
    let [row] = (await api('GET', '/flag-sources')).json().sources;
    assert.strictEqual(row.lastIngest.sender, 'acme/web@refs/tags/v1.4.0', 'Settings shows which run sent last');

    // The source trusts its own services, refs and environments only; each refusal is noted on it.
    const cases = [
        [actionsToken({ repo: 'acme/api', repoId: '8002' }), {}, 403, /acme\/api may not send for this source: it does not cover/],
        [actionsToken({ repo: 'evil/web', repoId: '666' }), {}, 403, /evil\/web may not send/],
        [actionsToken({ ref: 'refs/heads/feature' }), {}, 403, /on refs\/heads\/feature may not send.*only on refs\/heads\/main, refs\/tags\/v\*/],
        [actionsToken(), { observations: [obs('newCheckout', 'test', 'on')] }, 403, /GitHub Actions may only send qa, prod, not test/],
    ];
    for (const [token, payload, status, pattern] of cases) {
        res = await send(token, { observations: [obs('newCheckout', 'prod', 'off')], ...payload });
        assert.strictEqual(res.statusCode, status, res.body);
        assert.match(res.json().error, pattern);
        [row] = (await api('GET', '/flag-sources')).json().sources;
        assert.match(row.lastError.message, pattern, 'noted on the source');
    }

    // Not GitHub's, not for this server, or a source that takes no OIDC tokens: a 401 that touches no source.
    const pushOnly = (await api('POST', '/flag-sources', { name: 'Tokens only', kind: 'runtime', repoIds: [8001] })).json().source;
    const before = row.lastError;
    for (const [token, ref, pattern] of [
        [actionsToken({ aud: 'https://other.example.com' }), sourceRef, /another audience; request it for https:\/\/shipscope\.example\.com/],
        [`${actionsToken().slice(0, -4)}AAAA`, sourceRef, /signature does not match/],
        [actionsToken(), `${tenantId}/${pushOnly.id}`, /takes no GitHub Actions tokens/],
        [actionsToken(), `${tenantId}/${crypto.randomUUID()}`, /takes no GitHub Actions tokens/],
        [actionsToken(), 'not-a-ref', /X-ShipScope-Source must be/],
    ]) {
        res = await send(token, { observations: [obs('newCheckout', 'prod', 'off')] }, ref);
        assert.strictEqual(res.statusCode, 401, res.body);
        assert.match(res.json().error, pattern);
    }
    row = (await api('GET', '/flag-sources')).json().sources.find((x) => x.id === source.id);
    assert.deepStrictEqual(row.lastError, before, 'an unverified sender writes nothing on the source');
    const values = await withScope(pool, { tenantId }, async (c) => (await c.query("SELECT state FROM flag_values WHERE environment = 'prod'")).rows);
    assert.deepStrictEqual(values.map((v) => v.state), ['on'], 'no refused message changed a value');

    // Untracking the repository ends its trust; switching OIDC off ends everyone's.
    assert.strictEqual((await api('PUT', `/flag-sources/${source.id}`, { name: 'Web CI', kind: 'build', priority: 0, repoIds: [8001], oidc: null })).statusCode, 200);
    assert.strictEqual((await send(actionsToken(), { observations: [obs('newCheckout', 'prod', 'on')] })).statusCode, 401);
    const noRepos = await api('PUT', `/flag-sources/${source.id}`, { name: 'Web CI', kind: 'build', priority: 0, repoIds: [], oidc: {} });
    assert.strictEqual(noRepos.statusCode, 400, 'trust needs a service');
});
