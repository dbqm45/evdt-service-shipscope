// Characterizes what one sequence of ingests leaves in the database (values, history, flags, the source's status,
// the token's use), so the write path can be reshaped (applyObservations(), ADR-003 increment 2) without changing
// it. The snapshot was taken from the code before that change.
const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { withScope } = require('../lib/scope');
const { createFlagSource, ingestFlags } = require('../lib/flags');

const t0 = Date.parse('2026-10-01T10:00:00Z');
const at = (minutes) => new Date(t0 + minutes * 60_000);
const iso = (d) => (d instanceof Date ? d.toISOString() : d);

test('characterizing: a sequence of ingests leaves the same rows', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const { rows: [user] } = await pool.query("INSERT INTO users (github_user_id, github_login) VALUES (1, 'alice') RETURNING id");
    const { rows: [tenant] } = await pool.query("INSERT INTO tenants (name) VALUES ('Acme') RETURNING id");
    const tenantId = tenant.id;
    await withScope(pool, { tenantId }, (c) => c.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [tenantId, user.id]));
    const { token } = await createFlagSource(pool, { tenantId, actorUserId: user.id, name: 'CI', kind: 'build' });
    const send = (minutes, payload) => ingestFlags(pool, { token: token.token, payload: { schemaVersion: 2, ...payload }, now: at(minutes) });

    const results = [
        await send(0, { changedBy: 'bot', observations: [{ key: 'a', env: 'prod', state: 'on' }, { key: 'b', env: 'prod', state: 'partial', rollout: 20 }, { key: 'a', env: 'qa', state: 'off' }], flags: [{ key: 'a', description: 'A', jiraKeys: ['X-1'] }] }),
        await send(1, { observations: [{ key: 'a', env: 'prod', state: 'on' }, { key: 'b', env: 'prod', state: 'partial', rollout: 20 }] }),
        await send(2, { observations: [{ key: 'a', env: 'prod', state: 'off' }], flags: [{ key: 'a', jiraKeys: [] }] }),
        await send(3, { complete: false, observations: [{ key: 'b', env: 'prod', state: 'on', changedAt: at(-10).toISOString() }, { key: 'c', env: 'test', state: 'on' }] }),
        await send(4, { environments: ['qa'], observations: [] }),
    ];
    const dump = await withScope(pool, { tenantId }, async (c) => ({
        flags: (await c.query('SELECT key, description, jira_keys, created_at FROM flags ORDER BY key')).rows,
        values: (await c.query('SELECT key, environment, state, rollout::text, changed_at, changed_by, removed_at FROM flag_values ORDER BY key, environment')).rows,
        history: (await c.query('SELECT key, environment, state, rollout::text, removed, changed_at, changed_by FROM flag_value_history ORDER BY id')).rows,
        source: (await c.query('SELECT last_ingest_at, last_ingest, last_error FROM flag_sources')).rows,
        token: (await c.query('SELECT last_used_at FROM ingest_tokens')).rows,
    }));
    const plain = JSON.parse(JSON.stringify({ results, dump }, (k, v) => iso(v)));
    assert.deepStrictEqual(plain, SNAPSHOT);
});

const SNAPSHOT = {
    results: [
        {"source": "CI", "flags": 2, "changed": 3, "removed": 0, "stale": 0, "created": ["a", "b"]},
        {"source": "CI", "flags": 2, "changed": 0, "removed": 0, "stale": 0, "created": []},
        {"source": "CI", "flags": 1, "changed": 1, "removed": 1, "stale": 0, "created": []},
        {"source": "CI", "flags": 2, "changed": 1, "removed": 0, "stale": 1, "created": ["c"]},
        {"source": "CI", "flags": 0, "changed": 0, "removed": 1, "stale": 0, "created": []},
    ],
    dump: {
        flags: [
            {"key": "a", "description": "A", "jira_keys": [], "created_at": "2026-10-01T10:00:00.000Z"},
            {"key": "b", "description": null, "jira_keys": [], "created_at": "2026-10-01T10:00:00.000Z"},
            {"key": "c", "description": null, "jira_keys": [], "created_at": "2026-10-01T10:03:00.000Z"},
        ],
        values: [
            {"key": "a", "environment": "prod", "state": "off", "rollout": null, "changed_at": "2026-10-01T10:02:00.000Z", "changed_by": "CI", "removed_at": null},
            {"key": "a", "environment": "qa", "state": "off", "rollout": null, "changed_at": "2026-10-01T10:00:00.000Z", "changed_by": "CI", "removed_at": "2026-10-01T10:04:00.000Z"},
            {"key": "b", "environment": "prod", "state": "partial", "rollout": "20.00", "changed_at": "2026-10-01T10:00:00.000Z", "changed_by": "CI", "removed_at": "2026-10-01T10:02:00.000Z"},
            {"key": "c", "environment": "test", "state": "on", "rollout": null, "changed_at": "2026-10-01T10:03:00.000Z", "changed_by": "CI", "removed_at": null},
        ],
        history: [
            {"key": "a", "environment": "prod", "state": "on", "rollout": null, "removed": false, "changed_at": "2026-10-01T10:00:00.000Z", "changed_by": "bot"},
            {"key": "b", "environment": "prod", "state": "partial", "rollout": "20.00", "removed": false, "changed_at": "2026-10-01T10:00:00.000Z", "changed_by": "bot"},
            {"key": "a", "environment": "qa", "state": "off", "rollout": null, "removed": false, "changed_at": "2026-10-01T10:00:00.000Z", "changed_by": "bot"},
            {"key": "a", "environment": "prod", "state": "off", "rollout": null, "removed": false, "changed_at": "2026-10-01T10:02:00.000Z", "changed_by": "CI"},
            {"key": "b", "environment": "prod", "state": null, "rollout": null, "removed": true, "changed_at": "2026-10-01T10:02:00.000Z", "changed_by": "CI"},
            {"key": "c", "environment": "test", "state": "on", "rollout": null, "removed": false, "changed_at": "2026-10-01T10:03:00.000Z", "changed_by": "CI"},
            {"key": "a", "environment": "qa", "state": null, "rollout": null, "removed": true, "changed_at": "2026-10-01T10:04:00.000Z", "changed_by": "CI"},
        ],
        source: [
            {"last_ingest_at": "2026-10-01T10:04:00.000Z", "last_ingest": {"flags": 0, "stale": 0, "changed": 0, "removed": 1}, "last_error": null},
        ],
        token: [
            {"last_used_at": "2026-10-01T10:04:00.000Z"},
        ],
    },
};
