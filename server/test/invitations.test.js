const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { buildApp } = require('../web');
const { AUTH, fakeGitHub, signIn, signInWithRedirect } = require('./helpers/auth');
const { acceptInvitation } = require('../lib/invitations');
const { withScope } = require('../lib/scope');

if (!process.env.TEST_DATABASE_URL) {
    test('real-Postgres tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
    return;
}

const USERS = {
    alice: { id: 820_000_001, login: 'alice' },
    bob: { id: 820_000_002, login: 'bob' },
    carol: { id: 820_000_003, login: 'carol' },
    dave: { id: 820_000_004, login: 'dave' },
};

/** A fresh schema and app, alice signed in as admin of tenant "Acme". */
async function setup(t) {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH, fetch: fakeGitHub(USERS) });
    t.after(() => app.close());
    const alice = await signIn(app, 'alice');
    const tenantId = (await app.inject({ method: 'POST', url: '/tenants', cookies: { sid: alice }, payload: { name: 'Acme' } })).json().tenant.id;
    const invite = async (sid, role = 'member') => app.inject({ method: 'POST', url: `/tenants/${tenantId}/invitations`, cookies: { sid }, payload: { role } });
    const pathOf = (res) => new URL(res.json().url).pathname;
    return { pool, app, alice, tenantId, invite, pathOf };
}

test('invite → sign in through the link → preview → accept → member', async (t) => {
    const { app, alice, tenantId, invite, pathOf } = await setup(t);

    const created = await invite(alice);
    assert.strictEqual(created.statusCode, 201, created.body);
    assert.strictEqual(created.json().invitation.role, 'member');
    const link = pathOf(created);
    assert.match(link, /^\/invitations\/[A-Za-z0-9_-]{32}$/);
    assert.ok(created.json().url.startsWith('http://localhost:3000/invitations/'));

    // Not signed in yet: the link sends bob through GitHub sign-in and back to itself.
    const anonymous = await app.inject({ method: 'GET', url: link });
    assert.strictEqual(anonymous.statusCode, 302);
    assert.strictEqual(anonymous.headers.location, `/auth/github/login?returnTo=${encodeURIComponent(link)}`);
    const { sid: bob, location } = await signInWithRedirect(app, 'bob', anonymous.headers.location);
    assert.strictEqual(location, link);

    const preview = await app.inject({ method: 'GET', url: link, cookies: { sid: bob } });
    assert.strictEqual(preview.statusCode, 200);
    assert.deepStrictEqual(preview.json(), { tenant: { id: tenantId, name: 'Acme' }, role: 'member', status: 'pending', alreadyMember: false });

    const accepted = await app.inject({ method: 'POST', url: `${link}/accept`, cookies: { sid: bob } });
    assert.strictEqual(accepted.statusCode, 201, accepted.body);
    assert.deepStrictEqual(accepted.json(), { tenant: { id: tenantId, name: 'Acme' }, role: 'member' });

    const me = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: bob } })).json();
    assert.deepStrictEqual(me.tenants, [{ id: tenantId, name: 'Acme', role: 'member' }]);
    const members = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: alice } })).json().members;
    assert.deepStrictEqual(members.map((m) => [m.githubLogin, m.role]), [['alice', 'admin'], ['bob', 'member']]);

    // Single use: the same link no longer works, for anyone.
    const carol = await signIn(app, 'carol');
    const reused = await app.inject({ method: 'POST', url: `${link}/accept`, cookies: { sid: carol } });
    assert.strictEqual(reused.statusCode, 410);
    assert.strictEqual(reused.json().status, 'accepted');
});

test('an admin invitation makes the invitee an admin', async (t) => {
    const { app, alice, tenantId, invite, pathOf } = await setup(t);
    const link = pathOf(await invite(alice, 'admin'));
    const bob = await signIn(app, 'bob');
    await app.inject({ method: 'POST', url: `${link}/accept`, cookies: { sid: bob } });
    const me = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: bob } })).json();
    assert.deepStrictEqual(me.tenants, [{ id: tenantId, name: 'Acme', role: 'admin' }]);
});

test('only admins create, list and revoke invitations; outsiders see 404', async (t) => {
    const { app, alice, tenantId, invite, pathOf } = await setup(t);
    const bob = await signIn(app, 'bob');
    await app.inject({ method: 'POST', url: `${pathOf(await invite(alice))}/accept`, cookies: { sid: bob } });
    const carol = await signIn(app, 'carol');

    assert.strictEqual((await invite(bob)).statusCode, 403, 'member');
    assert.strictEqual((await invite(carol)).statusCode, 404, 'outsider');
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/invitations`, cookies: { sid: bob } })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/invitations`, cookies: { sid: carol } })).statusCode, 404);

    const pending = await invite(alice, 'admin');
    const list = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice } });
    assert.deepStrictEqual(list.json().invitations.map((i) => [i.id, i.role, i.createdBy]), [[pending.json().invitation.id, 'admin', 'alice']]);
    assert.ok(!list.body.includes(pathOf(pending).split('/').pop()), 'the token is never listed');

    const revokeUrl = `/tenants/${tenantId}/invitations/${pending.json().invitation.id}`;
    assert.strictEqual((await app.inject({ method: 'DELETE', url: revokeUrl, cookies: { sid: bob } })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'DELETE', url: revokeUrl, cookies: { sid: alice } })).statusCode, 204);
    assert.strictEqual((await app.inject({ method: 'DELETE', url: revokeUrl, cookies: { sid: alice } })).statusCode, 404, 'already revoked');
    assert.deepStrictEqual((await app.inject({ method: 'GET', url: `/tenants/${tenantId}/invitations`, cookies: { sid: alice } })).json().invitations, []);
});

test('revoked, expired and unknown links are refused', async (t) => {
    const { pool, app, alice, tenantId, invite, pathOf } = await setup(t);
    const bob = await signIn(app, 'bob');

    const revoked = await invite(alice);
    await app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/invitations/${revoked.json().invitation.id}`, cookies: { sid: alice } });
    const r = await app.inject({ method: 'POST', url: `${pathOf(revoked)}/accept`, cookies: { sid: bob } });
    assert.strictEqual(r.statusCode, 410);
    assert.strictEqual(r.json().status, 'revoked');

    const expired = await invite(alice);
    // Under the tenant's scope: an unscoped UPDATE would match nothing (RLS) and leave the invitation valid.
    const { rowCount } = await withScope(pool, { tenantId }, (client) =>
        client.query("UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.json().invitation.id]));
    assert.strictEqual(rowCount, 1);
    const e = await app.inject({ method: 'POST', url: `${pathOf(expired)}/accept`, cookies: { sid: bob } });
    assert.strictEqual(e.statusCode, 410);
    assert.strictEqual(e.json().status, 'expired');
    assert.strictEqual((await app.inject({ method: 'GET', url: pathOf(expired), cookies: { sid: bob } })).json().status, 'expired');

    const unknown = `/invitations/${'A'.repeat(32)}`;
    assert.strictEqual((await app.inject({ method: 'GET', url: unknown, cookies: { sid: bob } })).statusCode, 404);
    assert.strictEqual((await app.inject({ method: 'POST', url: `${unknown}/accept`, cookies: { sid: bob } })).statusCode, 404);
    assert.strictEqual((await app.inject({ method: 'GET', url: '/invitations/short', cookies: { sid: bob } })).statusCode, 400);

    const me = (await app.inject({ method: 'GET', url: '/me', cookies: { sid: bob } })).json();
    assert.deepStrictEqual(me.tenants, []);
});

test('accepting while already a member is a 409 and leaves the invitation usable', async (t) => {
    const { app, alice, invite, pathOf } = await setup(t);
    const link = pathOf(await invite(alice));

    const preview = await app.inject({ method: 'GET', url: link, cookies: { sid: alice } });
    assert.strictEqual(preview.json().alreadyMember, true);
    assert.strictEqual((await app.inject({ method: 'POST', url: `${link}/accept`, cookies: { sid: alice } })).statusCode, 409);

    const bob = await signIn(app, 'bob');
    assert.strictEqual((await app.inject({ method: 'POST', url: `${link}/accept`, cookies: { sid: bob } })).statusCode, 201);
});

test('two people accepting the same link at once: exactly one gets in', async (t) => {
    const { pool, app, alice, tenantId, invite, pathOf } = await setup(t);
    const token = pathOf(await invite(alice)).split('/').pop();
    await signIn(app, 'bob');
    await signIn(app, 'carol');
    const { rows } = await pool.query("SELECT id, github_login FROM users WHERE github_login IN ('bob', 'carol') ORDER BY github_login");

    const results = await Promise.allSettled(rows.map((u) => acceptInvitation(pool, { token, userId: u.id })));
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.reason?.message)));
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /no longer pending|accepted/);
    const members = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: alice } })).json().members;
    assert.strictEqual(members.length, 2, 'alice plus exactly one of bob/carol');
});

test('the database stores only a hash of the invitation token', async (t) => {
    const { pool, alice, invite, pathOf } = await setup(t);
    const token = pathOf(await invite(alice)).split('/').pop();
    // Read as the table owner bypassing nothing: scope to the tenant to see the row at all.
    const { rows: tenants } = await pool.query('SELECT id FROM tenants');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenants[0].id]);
        const { rows } = await client.query('SELECT * FROM invitations');
        assert.strictEqual(rows.length, 1);
        assert.ok(!JSON.stringify(rows).includes(token));
        await client.query('COMMIT');
    } finally {
        client.release();
    }
});

test('RLS: invitations are invisible unscoped, and a token scope sees only its own invitation', async (t) => {
    const { pool, alice, invite, pathOf } = await setup(t);
    await invite(alice);
    await invite(alice);
    const token = pathOf(await invite(alice)).split('/').pop();

    const { rows: unscoped } = await pool.query('SELECT id FROM invitations');
    assert.deepStrictEqual(unscoped, []);

    const crypto = require('crypto');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.invite_token_hash', $1, true)", [crypto.createHash('sha256').update(token).digest('hex')]);
        assert.strictEqual((await client.query('SELECT id FROM invitations')).rows.length, 1);
        // The token scope is read-only: it can't revoke or re-point the invitation.
        assert.strictEqual((await client.query('UPDATE invitations SET revoked_at = now()')).rowCount, 0);
        await client.query('COMMIT');
    } finally {
        client.release();
    }
});

test('removing members: admins remove anyone, members only themselves, never the last admin', async (t) => {
    const { app, alice, tenantId, invite, pathOf } = await setup(t);
    const join = async (code, role) => {
        const sid = await signIn(app, code);
        await app.inject({ method: 'POST', url: `${pathOf(await invite(alice, role))}/accept`, cookies: { sid } });
        return sid;
    };
    const bob = await join('bob', 'member');
    const carol = await join('carol', 'member');
    const dave = await join('dave', 'admin');
    const idOf = async (login) => (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: alice } }))
        .json().members.find((m) => m.githubLogin === login).userId;
    const remove = (sid, userId) => app.inject({ method: 'DELETE', url: `/tenants/${tenantId}/members/${userId}`, cookies: { sid } });

    assert.strictEqual((await remove(bob, await idOf('carol'))).statusCode, 403, 'member removing someone else');
    assert.strictEqual((await remove(bob, await idOf('bob'))).statusCode, 204, 'member leaving');
    assert.strictEqual((await remove(bob, await idOf('carol'))).statusCode, 404, 'ex-member is an outsider now');
    assert.strictEqual((await remove(alice, await idOf('carol'))).statusCode, 204, 'admin removing a member');

    const aliceId = await idOf('alice');
    assert.strictEqual((await remove(dave, aliceId)).statusCode, 204, 'admin removing another admin');
    const daveId = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: dave } })).json().members[0].userId;
    const last = await remove(dave, daveId);
    assert.strictEqual(last.statusCode, 409, 'the last admin cannot leave');

    const members = (await app.inject({ method: 'GET', url: `/tenants/${tenantId}/members`, cookies: { sid: dave } })).json().members;
    assert.deepStrictEqual(members.map((m) => [m.githubLogin, m.role]), [['dave', 'admin']]);
    assert.strictEqual((await remove(dave, '00000000-0000-0000-0000-000000000000')).statusCode, 404);
});

test('sign-in ignores a tampered return-to cookie', async (t) => {
    const { app } = await setup(t);
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const state = login.cookies.find((c) => c.name === 'oauth_state').value;
    const callback = await app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=bob&state=${state}`,
        cookies: { oauth_state: state, oauth_return_to: '//evil.example/invitations/x' },
    });
    assert.strictEqual(callback.statusCode, 302);
    assert.strictEqual(callback.headers.location, '/me');
});
