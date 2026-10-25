// A restored copy's check (lib/restore-check.js, scripts/verify-restore.js, server/KOPIE.pl.md): every migration,
// forced RLS on every tenant table, counts and the newest data, secrets opening with the keys given. Against a real
// Postgres schema standing in for the copy.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { collectRestoreFacts, judgeRestore } = require('../lib/restore-check');
const { main } = require('../scripts/verify-restore');

const KEY = crypto.randomBytes(32);
const MIGRATIONS = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();

test('a sound copy passes; missing migrations, tables out of RLS and secrets the keys do not open fail', async (t) => {
    const { pool, schema, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 900_000_001, login: 'alice' } }), encryptionKey: KEY });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const created = await app.inject({
        method: 'POST', url: `/tenants/${tenantId}/flag-sources`, cookies: { sid: alice },
        payload: { name: 'Flags API', kind: 'runtime', origin: 'endpoint', endpoint: { urls: { prod: 'https://flags.acme.io/f' } }, endpointToken: 'cust-1' },
    });
    assert.strictEqual(created.statusCode, 201, created.body);
    await app.inject({ method: 'GET', url: `/tenants/${tenantId}/flag-endpoint-signing`, cookies: { sid: alice } }); // stores the signing secret

    let facts = await collectRestoreFacts(pool, { encryptionKey: KEY });
    assert.deepStrictEqual(facts.migrations, MIGRATIONS);
    assert.strictEqual(facts.tenants, 1);
    assert.deepStrictEqual([facts.counts.memberships, facts.counts.flag_sources], [1, 1]);
    assert.ok(facts.newest.auditEvent instanceof Date, 'the newest settings change says how recent the copy is');
    assert.deepStrictEqual(facts.secrets, { readable: 2, unreadable: 0, untried: 0 }, 'the endpoint token and the signing secret');
    assert.deepStrictEqual(judgeRestore(facts, { expectedMigrations: MIGRATIONS }), { ok: true, problems: [], warnings: [] });

    // Without keys the secrets are not tried (a warning); with another key they fail.
    assert.deepStrictEqual(judgeRestore(await collectRestoreFacts(pool), { expectedMigrations: MIGRATIONS }).warnings,
        ['2 stored secret(s) not tried: give TOKEN_ENCRYPTION_KEY and SECRETS_PRIVATE_KEY to check them']);
    const wrongKey = judgeRestore(await collectRestoreFacts(pool, { encryptionKey: crypto.randomBytes(32) }), { expectedMigrations: MIGRATIONS });
    assert.deepStrictEqual([wrongKey.ok, wrongKey.problems], [false, ['2 stored secret(s) do not open with the keys given: restore the keys of that time too']]);

    // A checkout newer than the copy, an older one, a table taken out of RLS.
    assert.match(judgeRestore(facts, { expectedMigrations: [...MIGRATIONS, '999_future.sql'] }).problems[0], /migrations not applied: 999_future\.sql/);
    assert.match(judgeRestore(facts, { expectedMigrations: MIGRATIONS.slice(0, -1) }).problems[0], /this checkout does not have.*034/);
    await pool.query('ALTER TABLE flags NO FORCE ROW LEVEL SECURITY');
    facts = await collectRestoreFacts(pool, { encryptionKey: KEY });
    assert.deepStrictEqual(judgeRestore(facts, { expectedMigrations: MIGRATIONS }).problems, ['table flags is not under forced row-level security']);
    await pool.query('ALTER TABLE flags FORCE ROW LEVEL SECURITY');

    // The script: read only, its own variable, exit code by the verdict.
    const lines = [];
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    assert.strictEqual(await main({ RESTORE_DATABASE_URL: url.toString(), DATABASE_SSL: 'false', TOKEN_ENCRYPTION_KEY: KEY.toString('base64') }, (l) => lines.push(l)), 0, lines.join('\n'));
    assert.match(lines.join('\n'), /Workspaces: 1;.*Secrets: 2 open, 0 do not, 0 not tried.*✓ The copy is usable\./s);
    assert.strictEqual(await main({ DATABASE_URL: process.env.TEST_DATABASE_URL }, () => {}), 2, 'never DATABASE_URL');
    const tenantRows = await pool.query('SELECT count(*)::int AS n FROM tenants');
    assert.strictEqual(tenantRows.rows[0].n, 1, 'nothing written');
});
