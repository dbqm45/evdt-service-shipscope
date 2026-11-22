// The safe reader for customers' flags files (lib/flag-file-parser.js, ADR-003 point 5): the adapter's parsers in an
// isolated thread, with limits, and errors that never carry a value from the file.
const { test } = require('node:test');
const { Worker } = require('worker_threads');
const assert = require('node:assert');
const { parseFlagFile, formatFromName, FlagFileError, LIMITS } = require('../lib/flag-file-parser');

const refused = async (input, pattern) => {
    const err = await parseFlagFile(input).then(() => null, (e) => e);
    assert.ok(err instanceof FlagFileError, `refused: ${input.fileName}`);
    assert.match(err.message, pattern);
    return err.message;
};

test('reads every format the adapter reads, as states only', async () => {
    assert.deepStrictEqual(await parseFlagFile({ text: '{"newCheckout":true,"beta":25,"old":"off"}', fileName: 'flags.json' }),
        { newCheckout: { state: 'on' }, beta: { state: 'partial', rollout: 25 }, old: { state: 'off' } });
    assert.deepStrictEqual(await parseFlagFile({ text: 'features:\n  newCheckout: true\n  darkMode: false\n', fileName: 'config/flags.yml', options: { path: 'features' } }),
        { newCheckout: { state: 'on' }, darkMode: { state: 'off' } });
    assert.deepStrictEqual(await parseFlagFile({ text: 'export const flags = { newCheckout: true } as const;', fileName: 'src/flags.ts' }), { newCheckout: { state: 'on' } });
    assert.deepStrictEqual(await parseFlagFile({ text: 'ff.newCheckout=true\nserver.port=8080\n', fileName: 'application.properties', options: { prefix: 'ff.' } }), { newCheckout: { state: 'on' } });
    assert.deepStrictEqual(await parseFlagFile({ text: '[{"name":"a","enabled":true},{"name":"b","enabled":false}]', fileName: 'f.json', options: { keys: ['a'] } }), { a: { state: 'on' } }, 'a key list keeps only those');
    assert.deepStrictEqual([formatFromName('x/.env.prod'), formatFromName('flags.mjs'), formatFromName('README')], ['env', 'ts', null]);
});

test('a .env or .properties file is read only through a prefix or a key list: its other settings never become flags', async () => {
    await refused({ text: 'DB_PASSWORD=hunter2\nFF_NEW=true', fileName: '.env' }, /name the flags' prefix or their keys \(a \.env file/);
    assert.deepStrictEqual(await parseFlagFile({ text: 'DB_PASSWORD=hunter2\nFF_NEW=true\nFF_OLD=0', fileName: '.env', options: { prefix: 'FF_' } }), { NEW: { state: 'on' }, OLD: { state: 'off' } });
    assert.deepStrictEqual(await parseFlagFile({ text: 'DB_PASSWORD=hunter2\nFF_NEW=true', fileName: '.env', options: { keys: ['FF_NEW'] } }), { FF_NEW: { state: 'on' } });
});

test('no error message carries a value from the file', async () => {
    const secret = 'postgres://app:hunter2@db/prod';
    const messages = [
        await refused({ text: `{"dbUrl":"${secret}"}`, fileName: 'flags.json' }, /flag dbUrl is not on, off or a rollout percentage/),
        await refused({ text: `{"password":"${secret}" oops`, fileName: 'flags.json' }, /not valid JSON/),
        await refused({ text: `flags:\n  a: [${secret}\n`, fileName: 'flags.yaml' }, /not valid YAML/),
        await refused({ text: `export const flags = { beta: process.env.SECRET_${'X'.repeat(3)} }`, fileName: 'flags.ts' }, /flag beta is not on, off/),
        await refused({ text: `[{"name":"a","enabled":true,"pct":"${secret}"}]`, fileName: 'f.json', options: { rolloutPath: 'pct' } }, /a flag value is not on, off or a rollout percentage/),
    ];
    for (const message of messages) assert.ok(!/hunter2|SECRET_|postgres:/.test(message), message);
});

test('limits: size, nesting, an alias bomb, the number of flags and time each stop the read', async () => {
    await refused({ text: `{"a":"${'x'.repeat(LIMITS.maxBytes)}"}`, fileName: 'flags.json' }, /larger than 256 KB/);
    await refused({ text: `${'['.repeat(40)}${']'.repeat(40)}`, fileName: 'flags.json' }, /too large or too deeply nested/);
    let bomb = 'a: &a [x, x, x, x, x, x, x, x, x, x]\n';
    let prev = 'a';
    for (let i = 0; i < 8; i += 1) {
        bomb += `l${i}: &l${i} [${Array(10).fill(`*${prev}`).join(', ')}]\n`;
        prev = `l${i}`;
    }
    await refused({ text: bomb, fileName: 'flags.yaml' }, /too large or too deeply nested/);
    await refused({ text: JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, true]))), fileName: 'f.json', limits: { maxFlags: 20 } }, /more than 20 flags/);
    await refused({ text: JSON.stringify(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`f${i}`, true]))), fileName: 'f.json', limits: { timeoutMs: 1 } }, /took too long to read/);
});

// The heap a worker really gets with resourceLimits of `mb`. V8 flags are process-wide, so `--max-old-space-size` in
// NODE_OPTIONS (or on the command line) replaces the worker's own limit: the thread then gets the process's heap.
const workerHeapLimitMb = (mb) => new Promise((resolve, reject) => {
    const probe = new Worker("require('worker_threads').parentPort.postMessage(require('v8').getHeapStatistics().heap_size_limit)", {
        eval: true, resourceLimits: { maxOldGenerationSizeMb: mb, maxYoungGenerationSizeMb: 4 },
    });
    probe.once('message', (bytes) => { probe.terminate(); resolve(bytes / 1024 / 1024); });
    probe.once('error', reject);
});

test('limits: memory stops the read', async (t) => {
    const limitMb = await workerHeapLimitMb(8);
    if (limitMb > 64) {
        t.skip(`the worker heap limit is not in effect here (${Math.round(limitMb)} MB, not ~8): a V8 heap flag such as --max-old-space-size in NODE_OPTIONS overrides it`);
        return;
    }
    const big = JSON.stringify(Array.from({ length: 200_000 }, (_, i) => ({ name: `f${i}`, enabled: true, note: 'x'.repeat(40) })));
    await refused({ text: big, fileName: 'f.json', limits: { maxBytes: 50e6, maxNodes: 1e8, maxFlags: 1e6, memoryMb: 8, timeoutMs: 20_000 } }, /too large to read|could not be read/);
});

test('a reserved key, an unknown format or a key that is not a flag key is refused by name only', async () => {
    await refused({ text: '{"constructor":true}', fileName: 'f.json' }, /"constructor" cannot be a flag key/);
    await refused({ text: 'x', fileName: 'flags.toml' }, /unknown format/);
    await refused({ text: '{"has space":true}', fileName: 'f.json' }, /a key is not a valid flag key/);
});
