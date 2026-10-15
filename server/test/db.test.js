const { test } = require('node:test');
const assert = require('node:assert');
const { checkConnection } = require('../lib/db');

test('checkConnection: resolves ok with latency on a successful query', async () => {
    const pool = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
    const result = await checkConnection(pool);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(typeof result.latencyMs, 'number');
});

test('checkConnection: rejects when the query fails', async () => {
    const pool = { query: async () => { throw new Error('connection refused'); } };
    await assert.rejects(() => checkConnection(pool), /connection refused/);
});
