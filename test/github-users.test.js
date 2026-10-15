const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { resolveDisplayName, resolveActorName } = require('../scripts/lib/github-users');

const realFetch = global.fetch;
const realWarn = console.warn;
afterEach(() => { global.fetch = realFetch; console.warn = realWarn; });

test('empty login returns null without fetching', async () => {
    global.fetch = async () => { throw new Error('no'); };
    assert.strictEqual(await resolveDisplayName('', 't', new Map()), null);
});

test('returns cached value', async () => {
    global.fetch = async () => { throw new Error('no'); };
    assert.strictEqual(await resolveDisplayName('a', 't', new Map([['a', 'Ann']])), 'Ann');
});

test('resolves name and caches it', async () => {
    let n = 0;
    global.fetch = async (url, o) => {
        n++;
        assert.match(url, /users\/bob$/);
        assert.strictEqual(o.headers.Authorization, 'Bearer t');
        return { ok: true, json: async () => ({ name: 'Bob B' }) };
    };
    const cache = new Map();
    assert.strictEqual(await resolveDisplayName('bob', 't', cache), 'Bob B');
    assert.strictEqual(await resolveDisplayName('bob', 't', cache), 'Bob B');
    assert.strictEqual(n, 1);
});

test('missing name yields null; non-ok yields null', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ name: '' }) });
    assert.strictEqual(await resolveDisplayName('x', 't', new Map()), null);
    global.fetch = async () => ({ ok: false });
    const c = new Map();
    assert.strictEqual(await resolveDisplayName('y', 't', c), null);
    assert.ok(c.has('y'));
});

test('network error is swallowed with a warning', async () => {
    const warns = [];
    console.warn = m => warns.push(m);
    global.fetch = async () => { throw new Error('boom'); };
    assert.strictEqual(await resolveDisplayName('z', 't', new Map()), null);
    assert.match(warns[0], /boom/);
});

test('resolveActorName: display name when public, login otherwise', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ name: 'Jan Kowalski' }) });
    assert.strictEqual(await resolveActorName('jkowalski', 't'), 'Jan Kowalski');
    global.fetch = async () => ({ ok: true, json: async () => ({ name: null }) });
    assert.strictEqual(await resolveActorName('jkowalski', 't'), 'jkowalski');
    global.fetch = async () => ({ ok: false });
    assert.strictEqual(await resolveActorName('jkowalski', 't'), 'jkowalski');
});

test('resolveActorName: no token, no actor or a non-login string is returned as-is without fetching', async () => {
    global.fetch = async () => { throw new Error('must not fetch'); };
    assert.strictEqual(await resolveActorName('jkowalski', undefined), 'jkowalski');
    assert.strictEqual(await resolveActorName(undefined, 't'), undefined);
    assert.strictEqual(await resolveActorName('dependabot[bot]', 't'), 'dependabot[bot]');
    assert.strictEqual(await resolveActorName('../orgs/x', 't'), '../orgs/x');
});
