const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-cache-'));

// cachePathFor reads RUNNER_TEMP at call time, so setting it before use is enough.
process.env.RUNNER_TEMP = dir;

const { loadOrCompute } = require('../scripts/lib/retry-cache');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('computes once, then reuses the cached result', async () => {
    let calls = 0;
    const compute = async () => { calls++; return { n: calls }; };

    assert.deepEqual(await loadOrCompute('a/b', compute), { n: 1 });
    assert.deepEqual(await loadOrCompute('a/b', compute), { n: 1 });
    assert.equal(calls, 1);
});

test('a corrupt cache file is ignored and recomputed instead of throwing', async () => {
    await loadOrCompute('corrupt', async () => 1);

    const file = fs.readdirSync(dir).find(f => f.includes('corrupt'));

    fs.writeFileSync(path.join(dir, file), '{"trunc');

    const realWarn = console.warn;

    console.warn = () => {};

    try {
        assert.equal(await loadOrCompute('corrupt', async () => 2), 2);
        assert.equal(await loadOrCompute('corrupt', async () => 3), 2);
    } finally {
        console.warn = realWarn;
    }
});
