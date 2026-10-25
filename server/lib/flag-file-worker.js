// Runs inside a worker thread started by flag-file-parser.js, never on the main thread: it parses one customer file
// with the flags adapter's own readers (adapters/flags/lib.js) and posts back only the flag states. The file never
// leaves this thread except as { key: { state, rollout } }, and no error message carries a value from it.
const { parentPort, workerData } = require('worker_threads');
const { parseDocument, flagMap, toState } = require('../../adapters/flags/lib');

const FLAG_KEY = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const FORMAT_NAMES = { json: 'JSON', yaml: 'YAML', properties: '.properties', env: '.env', ts: 'TypeScript', js: 'JavaScript' };

class Refusal extends Error {}

/** Counts every value reachable from `doc` (an alias seen twice counts twice) and its depth; refuses past the limits. */
function checkShape(doc, { maxNodes, maxDepth }, where) {
    let nodes = 0;
    const visit = (value, depth) => {
        nodes += 1;
        if (nodes > maxNodes || depth > maxDepth) throw new Refusal(`${where}: too large or too deeply nested to read`);
        if (value !== null && typeof value === 'object') {
            for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
        }
    };
    visit(doc, 0);
}

/** An adapter error, without anything taken from the file's values: only names, paths and the file. */
function safeMessage(err, where) {
    const message = String(err && err.message ? err.message : err);
    if (/cannot read|is not written out as a value/.test(message)) return `${where}: a flag value is not on, off or a rollout percentage`;
    return message.slice(0, 300);
}

function parse({ text, fileName, format, options, limits }) {
    let doc;
    try {
        doc = parseDocument(text, format, fileName);
    } catch (err) {
        const line = /line (\d+)/i.exec(String(err.message || ''));
        throw new Refusal(`${fileName}: not valid ${FORMAT_NAMES[format] || format}${line ? ` (line ${line[1]})` : ''}`);
    }
    checkShape(doc, limits, fileName);
    let map;
    try {
        map = flagMap(doc, { path: options.path, valuePath: options.valuePath, keyField: options.keyField, rolloutPath: options.rolloutPath, prefix: options.prefix }, fileName);
    } catch (err) {
        throw new Refusal(safeMessage(err, fileName));
    }
    const wanted = options.keys && options.keys.length ? new Set(options.keys) : null;
    const flags = {};
    let count = 0;
    for (const [key, value] of Object.entries(map)) {
        if (wanted && !wanted.has(key)) continue;
        if (!FLAG_KEY.test(key)) throw new Refusal(`${fileName}: a key is not a valid flag key (letters, digits and _ . : -, starting with a letter or _)`);
        let state;
        try {
            state = toState(value, key);
        } catch {
            throw new Refusal(`${fileName}: flag ${key} is not on, off or a rollout percentage`);
        }
        count += 1;
        if (count > limits.maxFlags) throw new Refusal(`${fileName}: more than ${limits.maxFlags} flags`);
        flags[key] = state.rollout === undefined ? { state: state.state } : { state: state.state, rollout: state.rollout };
    }
    return flags;
}

try {
    parentPort.postMessage({ ok: true, flags: parse(workerData) });
} catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Refusal ? err.message : `${workerData.fileName}: could not be read` });
}
