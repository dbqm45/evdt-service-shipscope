const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { githubApiGet, githubApiRequest } = require('../scripts/lib/github-api');

const realFetch = global.fetch;
const realSetTimeout = global.setTimeout;
const realWarn = console.warn;
let delays;
let calls;

function res(status, { headers = {}, json, text = '' } = {}) {
    const h = new Map(Object.entries(headers));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: k => (h.has(k) ? h.get(k) : null) },
        json: async () => json,
        text: async () => text,
    };
}

function mockFetch(responses) {
    calls = [];
    global.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return responses.shift();
    };
}

beforeEach(() => {
    delays = [];
    global.setTimeout = (fn, ms) => { delays.push(ms); fn(); return 0; };
    console.warn = () => {};
});
afterEach(() => {
    global.fetch = realFetch;
    global.setTimeout = realSetTimeout;
    console.warn = realWarn;
});

test('returns parsed json on 200 and sends auth headers', async () => {
    mockFetch([res(200, { json: { a: 1 } })]);
    assert.deepStrictEqual(await githubApiGet('u', 'tok'), { a: 1 });
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok');
});

test('204 returns null', async () => {
    mockFetch([res(204)]);
    assert.strictEqual(await githubApiRequest('u', 't', { method: 'POST' }), null);
});

test('custom headers override defaults', async () => {
    mockFetch([res(200, { json: 1 })]);
    await githubApiRequest('u', 't', { headers: { Accept: 'x' } });
    assert.strictEqual(calls[0].opts.headers.Accept, 'x');
});

test('non-rate-limit error throws immediately', async () => {
    mockFetch([res(404, { text: 'nope' })]);
    await assert.rejects(() => githubApiGet('u', 't'), /404 nope/);
    assert.strictEqual(calls.length, 1);
});

test('403 without rate-limit signals throws', async () => {
    mockFetch([res(403, { text: 'forbidden' })]);
    await assert.rejects(() => githubApiGet('u', 't'), /403/);
});

test('429 with retry-after retries with that delay', async () => {
    mockFetch([res(429, { headers: { 'retry-after': '5' } }), res(200, { json: 'ok' })]);
    assert.strictEqual(await githubApiGet('u', 't'), 'ok');
    assert.deepStrictEqual(delays, [5000]);
});

test('retry-after is capped', async () => {
    mockFetch([res(403, { headers: { 'retry-after': '99999' } }), res(200, { json: 1 })]);
    await githubApiGet('u', 't');
    assert.deepStrictEqual(delays, [600000]);
});

test('primary limit uses x-ratelimit-reset, floored at 1s', async () => {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    mockFetch([
        res(403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(soon) } }),
        res(403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' } }),
        res(200, { json: 1 }),
    ]);
    await githubApiGet('u', 't');
    assert.strictEqual(delays[0], 600000);
    assert.strictEqual(delays[1], 1000);
});

test('falls back to 30s with no headers', async () => {
    mockFetch([res(429), res(200, { json: 1 })]);
    await githubApiGet('u', 't');
    assert.deepStrictEqual(delays, [30000]);
});

test('gives up after max attempts', async () => {
    mockFetch([res(429), res(429), res(429), res(429, { text: 'slow' })]);
    await assert.rejects(() => githubApiGet('u', 't'), /429 slow/);
    assert.strictEqual(calls.length, 4);
});

test('etag cache: stores, sends If-None-Match, returns cached on 304', async () => {
    const cache = {};
    mockFetch([res(200, { json: [1], headers: { etag: 'E1' } }), res(304)]);
    assert.deepStrictEqual(await githubApiGet('u', 't', cache), [1]);
    assert.deepStrictEqual(cache.u, { etag: 'E1', body: [1] });
    assert.deepStrictEqual(await githubApiGet('u', 't', cache), [1]);
    assert.strictEqual(calls[1].opts.headers['If-None-Match'], 'E1');
});

test('etag cache: response without etag evicts entry; non-GET skips cache', async () => {
    const cache = { u: { etag: 'E', body: 0 } };
    mockFetch([res(200, { json: 2 })]);
    await githubApiGet('u', 't', cache);
    assert.ok(!('u' in cache));

    const cache2 = { u: { etag: 'E', body: 0 } };
    mockFetch([res(200, { json: 3, headers: { etag: 'X' } })]);
    await githubApiRequest('u', 't', { method: 'POST' }, cache2);
    assert.strictEqual(cache2.u.etag, 'E');
    assert.ok(!calls[0].opts.headers['If-None-Match']);
});
