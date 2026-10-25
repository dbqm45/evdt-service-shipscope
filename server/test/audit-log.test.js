// The workspace's audit log beyond secrets (lib/audit-log.js, migration 031): members and invitations, the GitHub
// connection and tracked repositories, flag sources and their tokens, flags' hand-set details, retention. Who did
// what, newest first; never a token; a refused change leaves no event. Against a real Postgres.
const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { AUTH, fakeGitHub, signIn } = require('./helpers/auth');
const { buildApp } = require('../web');
const { withScope } = require('../lib/scope');
const { recordAuditEvent } = require('../lib/audit-log');
const {
    linkInstallation, trackRepo, updateRepoSettings, setRepoEnvironments, setRepoFlagStance, setRepoServiceRole, untrackRepo, unlinkInstallation,
} = require('../lib/github-connections');

test('settings changes are events: members, repositories, flag sources and tokens, retention; admins only', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 896_000_001, login: 'alice' }, bob: { id: 896_000_002, login: 'bob' } }) });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const created = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json();
    const tenantId = created.tenant.id;
    const aliceId = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: alice } })).json().user.id;
    const api = (method, url, payload, sid = alice) => app.inject({ method, url: `/tenants/${tenantId}${url}`, cookies: { sid }, payload });
    const kinds = async () => (await api('GET', '/audit-events')).json().events.map((e) => [e.actor, e.kind, e.subject]).reverse();

    // Members and invitations.
    const revoked = (await api('POST', '/invitations', { role: 'admin' })).json().invitation;
    assert.strictEqual((await api('DELETE', `/invitations/${revoked.id}`)).statusCode, 204);
    const link = (await api('POST', '/invitations', { role: 'member' })).json().url;
    const bob = await signIn(app, 'bob');
    await app.inject({ method: 'POST', url: `${new URL(link).pathname}/accept`, cookies: { sid: bob } });
    assert.strictEqual((await api('PUT', '/settings', { deploymentRetentionDays: 30 })).statusCode, 200);

    // Repositories (through the library: the GitHub side is not what is tested here).
    const by = { tenantId, actorUserId: aliceId };
    await linkInstallation(pool, { ...by, installation: { installationId: 7001, accountLogin: 'acme', accountType: 'Organization' } });
    await trackRepo(pool, { ...by, installationId: 7001, repo: { id: 8001, fullName: 'acme/web' } });
    await updateRepoSettings(pool, { ...by, repoId: 8001, versionFile: 'VERSION', driftIgnorePaths: [] });
    await setRepoEnvironments(pool, { ...by, repoId: 8001, envMap: { live: 'prod' } });
    await setRepoEnvironments(pool, { ...by, repoId: 8001, envMap: { live: 'prod' } }); // unchanged: no event
    await setRepoFlagStance(pool, { ...by, repoId: 8001, flagStance: 'none' });
    await setRepoServiceRole(pool, { ...by, repoId: 8001, serviceRole: 'frontend' });

    // Flag sources and their tokens.
    const { source, token } = (await api('POST', '/flag-sources', { name: 'Build flags', kind: 'build', repoIds: [8001] })).json();
    assert.strictEqual((await api('PUT', `/flag-sources/${source.id}`, { name: 'Build', kind: 'build', priority: 10, repoIds: [8001] })).statusCode, 200);
    const second = (await api('POST', `/flag-sources/${source.id}/tokens`, {})).json();
    assert.strictEqual((await api('DELETE', `/ingest-tokens/${second.id}`)).statusCode, 204);
    assert.strictEqual((await api('DELETE', `/flag-sources/${source.id}`)).statusCode, 204);

    await untrackRepo(pool, { ...by, repoId: 8001 });
    await unlinkInstallation(pool, { ...by, installationId: 7001 });
    assert.strictEqual((await api('DELETE', `/members/${(await api('GET', '/members')).json().members.find((m) => m.githubLogin === 'bob').userId}`)).statusCode, 204);

    assert.deepStrictEqual(await kinds(), [
        ['alice', 'workspace_created', 'Acme'],
        ['alice', 'invitation_created', 'admin'],
        ['alice', 'invitation_revoked', 'admin'],
        ['alice', 'invitation_created', 'member'],
        ['bob', 'member_joined', 'member'],
        ['alice', 'retention_changed', '30 days'],
        ['alice', 'github_linked', 'acme'],
        ['alice', 'repo_tracked', 'acme/web'],
        ['alice', 'repo_settings_changed', 'acme/web'],
        ['alice', 'repo_environments_changed', 'acme/web'],
        ['alice', 'repo_flag_stance_changed', 'acme/web: no flags'],
        ['alice', 'repo_role_changed', 'acme/web: frontend'],
        ['alice', 'flag_source_created', 'Build flags'],
        ['alice', 'flag_source_updated', 'Build'],
        ['alice', 'ingest_token_created', 'Build'],
        ['alice', 'ingest_token_revoked', 'Build'],
        ['alice', 'flag_source_deleted', 'Build'],
        ['alice', 'repo_untracked', 'acme/web'],
        ['alice', 'github_unlinked', 'acme'],
        ['alice', 'member_removed', 'bob'],
    ]);
    const stored = await withScope(pool, { tenantId }, async (c) => JSON.stringify((await c.query('SELECT * FROM audit_events')).rows));
    assert.ok(![token.token, second.token].some((secret) => stored.includes(secret)), 'never a token in the log');

    // A member reads nothing and a refused change records nothing; leaving is an event of its own.
    const bob2 = (await api('POST', '/invitations', { role: 'member' })).json().url;
    await app.inject({ method: 'POST', url: `${new URL(bob2).pathname}/accept`, cookies: { sid: bob } });
    const before = (await kinds()).length;
    assert.strictEqual((await api('GET', '/audit-events', undefined, bob)).statusCode, 403);
    assert.strictEqual((await api('PUT', '/settings', { deploymentRetentionDays: 60 }, bob)).statusCode, 403);
    assert.strictEqual((await kinds()).length, before);
    const bobId = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: bob } })).json().user.id;
    assert.strictEqual((await api('DELETE', `/members/${bobId}`, undefined, bob)).statusCode, 204);
    assert.deepStrictEqual((await kinds()).at(-1), ['bob', 'member_left', null]);
    // The secret events stay readable on their own, as Settings → Sources shows them.
    assert.deepStrictEqual((await api('GET', '/secret-events')).json().events, []);
});

test('recordAuditEvent: an unknown kind is a programming error, a long subject is cut to 200 characters', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub({ alice: { id: 896_000_011, login: 'alice' } }) });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    await withScope(pool, { tenantId }, async (client) => {
        await assert.rejects(recordAuditEvent(client, { tenantId, actorUserId: null, kind: 'made_up' }), /Unknown audit event made_up/);
    });
    await withScope(pool, { tenantId }, (client) => recordAuditEvent(client, { tenantId, actorUserId: null, kind: 'repo_tracked', subject: 'x'.repeat(300) }));
    const events = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/audit-events`, cookies: { sid: alice } })).json().events;
    assert.deepStrictEqual([events[0].actor, events[0].subject.length], [null, 200]);
});
