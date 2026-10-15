const { test } = require('node:test');
const assert = require('node:assert');
const { heartbeatTick } = require('../worker');

test('heartbeatTick: logs a successful ping', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const lines = [];
    await heartbeatTick(pool, (line) => lines.push(line));
    assert.match(lines[0], /heartbeat ok \(db latency \d+ms\)/);
});

test('heartbeatTick: logs a failure without throwing', async () => {
    const pool = { query: async () => { throw new Error('connection refused'); } };
    const lines = [];
    await heartbeatTick(pool, (line) => lines.push(line));
    assert.match(lines[0], /heartbeat failed: connection refused/);
});
