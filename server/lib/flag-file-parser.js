// Reads a customer's flags file (ADR-003, "flags in code") safely: the same readers the flags adapter uses
// (adapters/flags/lib.js), but in a worker thread of its own with a memory cap and a hard timeout, behind limits on
// size, nesting and the number of values. A file that is too big, too deep, an alias bomb or a parser stuck on
// crafted input costs one short-lived thread, never the worker that syncs every tenant.
//
// What comes back is only { key: { state, rollout } }. Error messages name the file, the flag key or the option at
// fault, never a value from the file (a .env with credentials must not end up in last_error or a log).
const path = require('path');
const { Worker } = require('worker_threads');

const LIMITS = {
    maxBytes: 256 * 1024,
    maxNodes: 100_000,
    maxDepth: 32,
    maxFlags: 5000,
    timeoutMs: 2000,
    memoryMb: 64,
};
const FORMATS = ['json', 'yaml', 'properties', 'env', 'ts', 'js'];
// In these formats every setting of a service lives in one file, credentials included: only the keys an admin
// names (a prefix, or a list) are read as flags.
const NEEDS_SELECTION = ['env', 'properties'];
const WORKER = path.join(__dirname, 'flag-file-worker.js');

class FlagFileError extends Error {}

/**
 * The format of a flags file from its name, as the adapter decides it (.json, .yaml/.yml, .properties, .env,
 * .ts/.js and their module variants), or null when the name says nothing.
 *
 * @param {string} fileName
 * @returns {'json'|'yaml'|'properties'|'env'|'ts'|null}
 */
function formatFromName(fileName) {
    const base = path.basename(fileName).toLowerCase();
    if (base.endsWith('.json')) return 'json';
    if (base.endsWith('.yaml') || base.endsWith('.yml')) return 'yaml';
    if (base.endsWith('.properties')) return 'properties';
    if (/\.[mc]?[tj]s$/.test(base)) return 'ts';
    if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'env';
    return null;
}

/**
 * Parses one flags file in an isolated thread.
 *
 * @param {{ text: string, fileName: string, format?: string, options?: { path?: string, valuePath?: string, keyField?: string, rolloutPath?: string, prefix?: string, keys?: string[] }, limits?: Partial<typeof LIMITS> }} input
 * @returns {Promise<Record<string, { state: 'on'|'off'|'partial', rollout?: number }>>}
 * @throws {FlagFileError} with a message free of the file's values
 */
async function parseFlagFile({ text, fileName, format, options = {}, limits = {} }) {
    const lim = { ...LIMITS, ...limits };
    const fmt = format || formatFromName(fileName);
    if (!FORMATS.includes(fmt)) throw new FlagFileError(`${fileName}: unknown format; name it (${FORMATS.join(', ')})`);
    if (typeof text !== 'string') throw new FlagFileError(`${fileName}: not a text file`);
    if (Buffer.byteLength(text, 'utf8') > lim.maxBytes) throw new FlagFileError(`${fileName}: larger than ${Math.round(lim.maxBytes / 1024)} KB`);
    if (NEEDS_SELECTION.includes(fmt) && !options.prefix && !(options.keys && options.keys.length)) {
        throw new FlagFileError(`${fileName}: name the flags' prefix or their keys (a .${fmt} file holds other settings too)`);
    }
    return inThread({ text, fileName, format: fmt, options, limits: { maxNodes: lim.maxNodes, maxDepth: lim.maxDepth, maxFlags: lim.maxFlags } }, lim, 'flags');
}

/**
 * Parses one JSON or YAML document a customer keeps in a repo (a release plan, pdi contract 0.4.0) in the same
 * isolated thread and limits as a flags file, and returns it whole: such a file holds plans, not credentials.
 *
 * @param {{ text: string, fileName: string, format?: 'json'|'yaml', limits?: Partial<typeof LIMITS> }} input
 * @returns {Promise<unknown>}
 * @throws {FlagFileError} with a message that names the file and at most a line number
 */
async function parseDocumentFile({ text, fileName, format, limits = {} }) {
    const lim = { ...LIMITS, ...limits };
    const fmt = format || formatFromName(fileName);
    if (fmt !== 'json' && fmt !== 'yaml') throw new FlagFileError(`${fileName}: not a JSON or YAML file`);
    if (typeof text !== 'string') throw new FlagFileError(`${fileName}: not a text file`);
    if (Buffer.byteLength(text, 'utf8') > lim.maxBytes) throw new FlagFileError(`${fileName}: larger than ${Math.round(lim.maxBytes / 1024)} KB`);
    return inThread({ text, fileName, format: fmt, document: true, limits: { maxNodes: lim.maxNodes, maxDepth: lim.maxDepth } }, lim, 'doc');
}

/** Runs flag-file-worker.js on `workerData` with the limits; resolves with the answer's `field`. */
function inThread(workerData, lim, field) {
    const { fileName } = workerData;
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER, {
            workerData,
            resourceLimits: { maxOldGenerationSizeMb: lim.memoryMb, maxYoungGenerationSizeMb: Math.max(4, Math.floor(lim.memoryMb / 4)), stackSizeMb: 4 },
            env: {}, // nothing of the service's environment (DATABASE_URL, keys) inside the parser's thread
            stdout: true,
            stderr: true,
        });
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.terminate().catch(() => {});
            fn(value);
        };
        const timer = setTimeout(() => finish(reject, new FlagFileError(`${fileName}: took too long to read`)), lim.timeoutMs);
        worker.once('message', (msg) => (msg.ok ? finish(resolve, msg[field]) : finish(reject, new FlagFileError(msg.error))));
        worker.once('error', (err) => finish(reject, new FlagFileError(
            err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `${fileName}: too large to read` : `${fileName}: could not be read`
        )));
        worker.once('exit', () => finish(reject, new FlagFileError(`${fileName}: could not be read`)));
    });
}

module.exports = { LIMITS, FlagFileError, formatFromName, parseFlagFile, parseDocumentFile };
