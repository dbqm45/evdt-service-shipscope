// The start-up check that the flag file parser's memory cap applies (lib/worker-heap-check.js): the pure decision,
// the logging around it, and the real probe in a child process with and without a heap flag in NODE_OPTIONS.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { judgeWorkerHeap, heapFlags, checkWorkerHeapLimit } = require('../lib/worker-heap-check');

test('judgeWorkerHeap: a limit near the cap, or below it, is in effect', () => {
    assert.strictEqual(judgeWorkerHeap({ reportedMb: 88, memoryMb: 64, execArgv: [] }), null);
    assert.strictEqual(judgeWorkerHeap({ reportedMb: 128, memoryMb: 64, execArgv: [] }), null);
    // A smaller heap flag replaces the cap too, but makes it tighter: no warning.
    assert.strictEqual(judgeWorkerHeap({ reportedMb: 56, memoryMb: 64, execArgv: [], nodeOptions: '--max-old-space-size=32' }), null);
});

test('judgeWorkerHeap: a limit far above the cap names the flag in NODE_OPTIONS and the effect', () => {
    const verdict = judgeWorkerHeap({ reportedMb: 8216.4, memoryMb: 64, execArgv: [], nodeOptions: '--use-openssl-ca --max-old-space-size=8192' });
    assert.match(verdict.msg, /memory limit is not in effect/);
    assert.match(verdict.msg, /limited to 64 MB gets a 8216 MB heap/);
    assert.match(verdict.msg, /--max-old-space-size=8192 in NODE_OPTIONS/);
    assert.match(verdict.msg, /bounded only by the size, nesting, count and time limits/);
    assert.ok(!verdict.msg.includes('--use-openssl-ca'), 'only the heap flag is named, not the rest of NODE_OPTIONS');
    assert.deepStrictEqual(verdict.fields, { workerHeapLimitMb: 8216, expectedMb: 64, heapFlags: ['--max-old-space-size=8192'] });
});

test('judgeWorkerHeap: a flag on the command line, or none it can name, is still a cause', () => {
    assert.match(judgeWorkerHeap({ reportedMb: 536, memoryMb: 64, execArgv: ['--max_old_space_size=512'] }).msg, /--max_old_space_size=512 on the command line/);
    assert.match(judgeWorkerHeap({ reportedMb: 256, memoryMb: 64, execArgv: ['--max-semi-space-size=64'] }).msg, /--max-semi-space-size=64 on the command line/);
    assert.match(judgeWorkerHeap({ reportedMb: 4000, memoryMb: 64, execArgv: [] }).msg, /a V8 heap flag \(such as --max-old-space-size in NODE_OPTIONS or on the command line\)/);
});

test('heapFlags keeps only V8 heap size flags', () => {
    assert.deepStrictEqual(heapFlags(['--inspect', '--max-old-space-size=1', '--max-heap-size=2', '--max-old-space-sizes', '--stack-size=900']), ['--max-old-space-size=1', '--max-heap-size=2']);
});

test('checkWorkerHeapLimit logs the warning once, nothing when the cap holds, and never throws', async (t) => {
    const log = { warn: t.mock.fn() };
    await checkWorkerHeapLimit(log, { env: { NODE_OPTIONS: '--max-old-space-size=8192' }, execArgv: [], measure: async () => 8216 });
    assert.strictEqual(log.warn.mock.callCount(), 1);
    assert.match(log.warn.mock.calls[0].arguments[0], /--max-old-space-size=8192 in NODE_OPTIONS/);
    await checkWorkerHeapLimit(log, { env: {}, execArgv: [], measure: async () => 88 });
    assert.strictEqual(log.warn.mock.callCount(), 1);
    await checkWorkerHeapLimit(log, { env: {}, execArgv: [], measure: async () => { throw new Error('boom'); } });
    assert.strictEqual(log.warn.mock.callCount(), 2);
    assert.match(log.warn.mock.calls[1].arguments[0], /could not check/);
});

// A real process: the warning appears with the flag in NODE_OPTIONS and not without it (NODE_OPTIONS removed, since
// a CI or container environment may set one of its own).
const runCheck = (nodeOptions) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
    const script = `require(${JSON.stringify(path.join(__dirname, '../lib/worker-heap-check.js'))}).checkWorkerHeapLimit({ warn: (msg) => console.log(msg) })`;
    return execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
};

test('the real probe: a warning with --max-old-space-size in NODE_OPTIONS, none without', () => {
    assert.match(runCheck('--max-old-space-size=8192'), /memory limit is not in effect.*--max-old-space-size=8192 in NODE_OPTIONS/);
    assert.strictEqual(runCheck(''), '');
});
