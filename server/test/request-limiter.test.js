const { test } = require('node:test');
const assert = require('node:assert');
const { createLimiter } = require('../lib/request-limiter');

test('request limiter: a burst up to capacity, then the sustained rate, with how long to wait', () => {
    const limiter = createLimiter({ capacity: 3, refillPerSecond: 0.5 });
    const t0 = 1_000_000;
    assert.deepStrictEqual([1, 2, 3].map(() => limiter.take('a', t0).ok), [true, true, true]);
    assert.deepStrictEqual(limiter.take('a', t0), { ok: false, retryAfterSeconds: 2 }, 'one token every 2 s');
    assert.strictEqual(limiter.take('b', t0).ok, true, 'each key has its own bucket');
    assert.strictEqual(limiter.take('a', t0 + 1_000).ok, false, 'half a token after 1 s');
    assert.strictEqual(limiter.take('a', t0 + 2_000).ok, true, 'a whole one after 2 s');
    assert.strictEqual(limiter.take('a', t0 + 60_000).ok, true);
    assert.strictEqual(limiter.take('a', t0 + 60_000).ok, true);
    assert.strictEqual(limiter.take('a', t0 + 60_000).ok, true, 'refills up to capacity, no more');
    assert.strictEqual(limiter.take('a', t0 + 60_000).ok, false);
    assert.throws(() => createLimiter({ capacity: 0, refillPerSecond: 1 }), /capacity/);
});

test('request limiter: remembers at most maxKeys, dropping the longest unused', () => {
    const limiter = createLimiter({ capacity: 1, refillPerSecond: 0.001, maxKeys: 2 });
    limiter.take('a', 0);
    limiter.take('b', 0);
    assert.strictEqual(limiter.take('a', 0).ok, false, 'a is remembered and empty');
    limiter.take('c', 0);
    assert.strictEqual(limiter.take('b', 0).ok, true, 'b, the longest unused, was dropped and starts full');
});
