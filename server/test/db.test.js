const { test } = require('node:test');
const assert = require('node:assert');
const { checkConnection, createPool } = require('../lib/db');

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

test('createPool: TLS on by default (Render), off only for an explicit DATABASE_SSL=false', async () => {
    const tls = createPool({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    const plain = createPool({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', DATABASE_SSL: 'false' });
    const typo = createPool({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', DATABASE_SSL: 'no' });
    try {
        assert.deepStrictEqual(tls.options.ssl, { rejectUnauthorized: false });
        assert.strictEqual(plain.options.ssl, false);
        assert.deepStrictEqual(typo.options.ssl, { rejectUnauthorized: false });
    } finally {
        await Promise.all([tls.end(), plain.end(), typo.end()]);
    }
});
