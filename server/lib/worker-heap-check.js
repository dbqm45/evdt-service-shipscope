// Whether the flag file parser's memory cap (lib/flag-file-parser.js, LIMITS.memoryMb) really applies. V8 flags are
// process-wide: --max-old-space-size (or another heap flag) in NODE_OPTIONS or on the command line replaces a worker
// thread's own resourceLimits, and the parser's thread then gets the whole process's heap. web.js and worker.js
// measure it once at start and log a warning; they never refuse to start, and parsing is unchanged.
const { Worker } = require('worker_threads');
const { LIMITS, workerResourceLimits } = require('./flag-file-parser');

// V8's heap size flags; V8 accepts `_` for `-` in flag names.
const HEAP_FLAG = /^--max[-_](old[-_]space|semi[-_]space|heap|young[-_]generation)[-_]size(=|$)/;
// A thread gets a little more than its old generation (88 MB for 64 MB): only a limit well above it means the cap
// was replaced. A flag that makes the heap smaller is tighter, not looser, and is not warned about.
const TOLERANCE = 2;

/**
 * The V8 heap flags among `args`, as written (a flag only, never the rest of NODE_OPTIONS).
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function heapFlags(args) {
    return args.filter((arg) => HEAP_FLAG.test(arg));
}

/**
 * Decides from a probe's measurement whether the parser's memory cap is in effect; null when it is, else the
 * warning to log and its fields.
 *
 * @param {{ reportedMb: number, memoryMb: number, execArgv: string[], nodeOptions?: string }} input
 * @returns {null | { msg: string, fields: { workerHeapLimitMb: number, expectedMb: number, heapFlags: string[] } }}
 */
function judgeWorkerHeap({ reportedMb, memoryMb, execArgv, nodeOptions = '' }) {
    if (!(reportedMb > memoryMb * TOLERANCE)) return null;
    const fromEnv = heapFlags(nodeOptions.split(/\s+/).filter(Boolean));
    const fromArgv = heapFlags(execArgv);
    const named = [...fromEnv.map((f) => `${f} in NODE_OPTIONS`), ...fromArgv.map((f) => `${f} on the command line`)];
    const cause = named.length ? `the V8 heap flag ${named.join(' and ')}` : 'a V8 heap flag (such as --max-old-space-size in NODE_OPTIONS or on the command line)';
    const reported = Math.round(reportedMb);
    return {
        msg: `Flag file parser memory limit is not in effect: a parser thread limited to ${memoryMb} MB gets a ${reported} MB heap, because ${cause} applies to every thread of the process. Customers' flag files are then bounded only by the size, nesting, count and time limits; remove the flag to restore the cap`,
        fields: { workerHeapLimitMb: reported, expectedMb: memoryMb, heapFlags: [...fromEnv, ...fromArgv] },
    };
}

/**
 * Starts a tiny thread with `resourceLimits` and resolves with the heap limit V8 gives it, in MB.
 *
 * @param {object} resourceLimits
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<number>}
 */
function measureWorkerHeapMb(resourceLimits, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
        const probe = new Worker("require('worker_threads').parentPort.postMessage(require('v8').getHeapStatistics().heap_size_limit)", {
            eval: true, resourceLimits, env: {}, stdout: true, stderr: true,
        });
        let settled = false;
        const done = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            probe.terminate().catch(() => {});
            fn(value);
        };
        const timer = setTimeout(() => done(reject, new Error('the heap probe did not answer')), timeoutMs);
        probe.once('message', (bytes) => done(resolve, bytes / 1024 / 1024));
        probe.once('error', (err) => done(reject, err));
        probe.once('exit', () => done(reject, new Error('the heap probe exited without answering')));
    });
}

/**
 * Measures once whether the parser's memory cap applies and logs a warning when it does not. Never throws.
 *
 * @param {{ warn: (msg: string, fields?: object) => void }} log
 * @param {{ memoryMb?: number, env?: { NODE_OPTIONS?: string }, execArgv?: string[], measure?: typeof measureWorkerHeapMb }} [options]
 * @returns {Promise<void>}
 */
async function checkWorkerHeapLimit(log, { memoryMb = LIMITS.memoryMb, env = process.env, execArgv = process.execArgv, measure = measureWorkerHeapMb } = {}) {
    let reportedMb;
    try {
        reportedMb = await measure(workerResourceLimits(memoryMb));
    } catch (err) {
        log.warn('could not check the flag file parser memory limit', { err });
        return;
    }
    const verdict = judgeWorkerHeap({ reportedMb, memoryMb, execArgv, nodeOptions: env.NODE_OPTIONS });
    if (verdict) log.warn(verdict.msg, verdict.fields);
}

module.exports = { judgeWorkerHeap, heapFlags, measureWorkerHeapMb, checkWorkerHeapLimit };
