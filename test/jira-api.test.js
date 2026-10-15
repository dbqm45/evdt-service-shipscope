const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { fetchWithRetry } = require('../scripts/lib/jira-api');

const realFetch = global.fetch;
const realSetTimeout = global.setTimeout;
const realWarn = console.warn;
afterEach(() => {
    global.fetch = realFetch;
    global.setTimeout = realSetTimeout;
    console.warn = realWarn;
});

function setup(responses) {
    const delays = [];
    let calls = 0;
    global.setTimeout = (fn, ms) => { delays.push(ms); fn(); return 0; };
    console.warn = () => {};
    global.fetch = async () => { calls++; return responses.shift(); };
    return { delays, calls: () => calls };
}
const r = (status, retry) => ({ status, headers: { get: () => retry ?? null } });

test('non-429 returned as-is', async () => {
    const s = setup([r(500)]);
    assert.strictEqual((await fetchWithRetry('u')).status, 500);
    assert.strictEqual(s.calls(), 1);
});

test('429 honors Retry-After', async () => {
    const s = setup([r(429, '7'), r(200)]);
    assert.strictEqual((await fetchWithRetry('u', {})).status, 200);
    assert.deepStrictEqual(s.delays, [7000]);
});

test('429 caps delay and defaults to 30s', async () => {
    const s = setup([r(429, '999999'), r(429), r(429, 'abc'), r(200)]);
    await fetchWithRetry('u');
    assert.deepStrictEqual(s.delays, [600000, 30000, 30000]);
});

test('returns last 429 after max attempts', async () => {
    const s = setup([r(429), r(429), r(429), r(429)]);
    assert.strictEqual((await fetchWithRetry('u')).status, 429);
    assert.strictEqual(s.calls(), 4);
});
