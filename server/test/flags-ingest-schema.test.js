// The published ingest contract (server/schemas/flags-ingest.v2.schema.json): the route validates with it, serves
// it as is, and the examples in the onboarding guide pass it. No database: a message that passes the schema stops at
// the token check (401), one that does not is a 400.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildApp } = require('../web');
const SCHEMA = require('../schemas/flags-ingest.v2.schema.json');

const GUIDES = ['ONBOARDING.md', 'ONBOARDING.pl.md'].map((name) => path.join(__dirname, '..', '..', name));
const AUTH = { githubClientId: 'x', githubClientSecret: 'y', publicBaseUrl: 'http://localhost:3000', secureCookies: false };
const app = () => buildApp({ pool: { query: async () => ({ rows: [] }) }, auth: AUTH });
const ingest = (server, payload) => server.inject({ method: 'POST', url: '/api/flags/ingest', payload });

test('GET /api/flags/ingest/schema: the schema file, unchanged, as application/schema+json, without a session', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/api/flags/ingest/schema' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^application\/schema\+json/);
    assert.deepEqual(res.json(), SCHEMA);
    assert.equal(res.json().$schema, 'http://json-schema.org/draft-07/schema#');
    await server.close();
});

test('the onboarding guides\' example messages pass the schema', async () => {
    const server = app();
    for (const file of GUIDES) {
        const blocks = [...fs.readFileSync(file, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
        assert.ok(blocks.length >= 1, `${path.basename(file)} has a JSON example`);
        for (const payload of blocks) {
            const res = await ingest(server, payload);
            assert.equal(res.statusCode, 401, `${path.basename(file)}: ${res.body}`);
        }
    }
    await server.close();
});

test('the route validates with the schema: wrong version, unknown field, bad env, key or Jira key are 400', async () => {
    const server = app();
    const ok = { schemaVersion: 2, observations: [{ key: 'newCheckout', env: 'prod', state: 'on' }] };
    assert.equal((await ingest(server, ok)).statusCode, 401);
    for (const bad of [
        { ...ok, schemaVersion: 1 },
        { ...ok, extra: true },
        { schemaVersion: 2, observations: [{ key: 'newCheckout', env: 'staging', state: 'on' }] },
        { schemaVersion: 2, observations: [{ key: '1bad', env: 'prod', state: 'on' }] },
        { schemaVersion: 2, observations: [{ key: 'newCheckout', env: 'prod', state: 'partial', rollout: 101 }] },
        { ...ok, flags: [{ key: 'newCheckout', jiraKeys: ['abc-1'] }] },
    ]) {
        assert.equal((await ingest(server, bad)).statusCode, 400, JSON.stringify(bad));
    }
    await server.close();
});

test('the Polish and English guides share the same converter', () => {
    const converter = (file) => /```bash\n# to-shipscope\.jq[^\n]*\n([\s\S]*?)```/.exec(fs.readFileSync(file, 'utf8'))[1];
    assert.equal(converter(GUIDES[0]), converter(GUIDES[1]));
});
