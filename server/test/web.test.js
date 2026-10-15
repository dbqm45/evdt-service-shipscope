const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createServer } = require('../web');

function listen(server) {
    return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

function get(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ port, path }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
    });
}

test('GET /health returns ok without touching the pool', async (t) => {
    const pool = { query: () => t.mock.fn()() };
    const server = createServer(pool);
    const port = await listen(server);
    t.after(() => server.close());

    const res = await get(port, '/health');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { status: 'ok' });
});

test('GET /health/db returns 200 when the database is reachable', async (t) => {
    const pool = { query: async () => ({ rows: [] }) };
    const server = createServer(pool);
    const port = await listen(server);
    t.after(() => server.close());

    const res = await get(port, '/health/db');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
});

test('GET /health/db returns 503 when the database is unreachable', async (t) => {
    const pool = { query: async () => { throw new Error('timeout'); } };
    const server = createServer(pool);
    const port = await listen(server);
    t.after(() => server.close());

    const res = await get(port, '/health/db');
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.ok, false);
});
