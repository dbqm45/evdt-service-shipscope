/**
 * The ShipScope flags adapter: reads a team's feature flags from files or a URL, turns them into one ingest
 * message (schemaVersion 2, server/schemas/flags-ingest.v2.schema.json) for one environment, and posts it to
 * POST /api/flags/ingest. Shared by the CLI (shipscope-flags.js) and the GitHub Action (action.js); no
 * dependencies, so the Action runs straight from the repository. Self-contained on purpose: it never requires
 * from server/ or scripts/ (scripts/lib/module-boundaries.js).
 */
const fs = require('fs');
const path = require('path');

const ENVIRONMENTS = ['test', 'qa', 'prod'];
// The same rules as the server's schema; checked here so a wrong key fails before anything is sent.
const FLAG_KEY = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_OBSERVATIONS = 5000;
const FORMATS = ['json', 'properties', 'env'];

class AdapterError extends Error {}

/**
 * A flag value as teams write it, read as a ShipScope state: true/false, "on"/"off", "true"/"false",
 * "enabled"/"disabled", "partial", or a number 0–100 (or its string) for a percentage rollout, where 0 is off
 * and 100 is on. Any other number is an error, not a flag: a setting such as a port caught by a loose prefix.
 *
 * @param {unknown} value
 * @param {string} where the flag, for the error message
 * @returns {{ state: 'on'|'off'|'partial', rollout?: number }}
 * @throws {AdapterError}
 */
function toState(value, where) {
    let v = value;
    if (typeof v === 'string') {
        const text = v.trim().toLowerCase();
        if (['true', 'on', 'enabled', 'yes'].includes(text)) v = true;
        else if (['false', 'off', 'disabled', 'no'].includes(text)) v = false;
        else if (text === 'partial') return { state: 'partial' };
        else if (text !== '' && Number.isFinite(Number(text))) v = Number(text);
    }
    if (v === true) return { state: 'on' };
    if (v === false) return { state: 'off' };
    if (typeof v === 'number' && v >= 0 && v <= 100) {
        if (v === 0) return { state: 'off' };
        if (v === 100) return { state: 'on' };
        return { state: 'partial', rollout: v };
    }
    const hint = v !== null && typeof v === 'object' && !Array.isArray(v) ? ' (an object per flag: name its value with value-path)' : '';
    throw new AdapterError(`${where}: cannot read ${JSON.stringify(value)} as on, off or a rollout percentage${hint}`);
}

/**
 * The value at a dot path (`data.flags`), or the value itself for an empty path.
 *
 * @param {unknown} value
 * @param {string} [dotPath]
 * @param {string} where for the error message
 * @returns {unknown}
 * @throws {AdapterError}
 */
function pick(value, dotPath, where) {
    if (!dotPath) return value;
    let current = value;
    for (const part of dotPath.split('.')) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
            throw new AdapterError(`${where}: no "${dotPath}" in it`);
        }
        current = current[part];
    }
    return current;
}

/**
 * The format of a flags file from its name: .json, .properties, or .env (also `.env.prod`, `prod.env`).
 *
 * @param {string} file
 * @returns {'json'|'properties'|'env'}
 * @throws {AdapterError}
 */
function formatOf(file) {
    const base = path.basename(file).toLowerCase();
    if (base.endsWith('.json')) return 'json';
    if (base.endsWith('.properties')) return 'properties';
    if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'env';
    throw new AdapterError(`${file}: unknown format, name it with --format (${FORMATS.join(', ')})`);
}

/**
 * Parses a flags document: JSON, or `key=value` lines (Java .properties also take `key: value`; .env lines may
 * start with `export`; `#` and `!` lines are comments; matching quotes around a value are removed).
 *
 * @param {string} text
 * @param {'json'|'properties'|'env'} format
 * @param {string} where for the error message
 * @returns {unknown}
 * @throws {AdapterError}
 */
function parseDocument(text, format, where) {
    if (format === 'json') {
        try {
            return JSON.parse(text);
        } catch (err) {
            throw new AdapterError(`${where}: not valid JSON (${err.message})`);
        }
    }
    if (!FORMATS.includes(format)) throw new AdapterError(`unknown format "${format}" (${FORMATS.join(', ')})`);
    const separator = format === 'properties' ? /[=:]/ : /=/;
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
        let line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        if (format === 'env') line = line.replace(/^export\s+/, '');
        const at = line.search(separator);
        if (at <= 0) continue;
        const key = line.slice(0, at).trim();
        let value = line.slice(at + 1).trim();
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
        out[key] = value;
    }
    return out;
}

/**
 * The `{ key: value }` flag map inside a parsed document: the object at `path`, each value read at `valuePath`
 * (e.g. `enabled` for AWS AppConfig's `{ "flag": { "enabled": true } }`), only keys starting with `prefix`
 * (removed from the key).
 *
 * @param {unknown} doc
 * @param {{ path?: string, valuePath?: string, prefix?: string }} options
 * @param {string} where for the error message
 * @returns {Record<string, unknown>}
 * @throws {AdapterError}
 */
function flagMap(doc, { path: dotPath, valuePath, prefix }, where) {
    const map = pick(doc, dotPath, where);
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
        throw new AdapterError(`${where}: expected an object of flags${dotPath ? ` at "${dotPath}"` : ''}`);
    }
    const out = {};
    for (const [rawKey, value] of Object.entries(map)) {
        if (prefix && !rawKey.startsWith(prefix)) continue;
        const key = prefix ? rawKey.slice(prefix.length) : rawKey;
        out[key] = valuePath ? pick(value, valuePath, `${where}, flag ${key}`) : value;
    }
    return out;
}

/**
 * Merges the flag maps of several files; a flag given different values in two of them is an error.
 *
 * @param {Array<{ where: string, flags: Record<string, unknown> }>} maps
 * @returns {Record<string, { state: string, rollout?: number }>}
 * @throws {AdapterError}
 */
function mergeStates(maps) {
    const out = {};
    const from = {};
    for (const { where, flags } of maps) {
        for (const [key, value] of Object.entries(flags)) {
            const state = toState(value, `${where}, flag ${key}`);
            if (Object.hasOwn(out, key) && (out[key].state !== state.state || out[key].rollout !== state.rollout)) {
                throw new AdapterError(`flag ${key} differs between ${from[key]} and ${where}`);
            }
            out[key] = state;
            from[key] = where;
        }
    }
    return out;
}

/**
 * The ingest message for one environment's full state.
 *
 * @param {{ env: string, states: Record<string, { state: string, rollout?: number }>, changedBy?: string, complete?: boolean }} input
 * @returns {{ schemaVersion: 2, environments: string[], complete: boolean, changedBy?: string, observations: object[] }}
 * @throws {AdapterError}
 */
function buildPayload({ env, states, changedBy, complete = true }) {
    if (!ENVIRONMENTS.includes(env)) throw new AdapterError(`environment "${env}" must be one of ${ENVIRONMENTS.join(', ')}`);
    const keys = Object.keys(states).sort();
    if (keys.length > MAX_OBSERVATIONS) throw new AdapterError(`${keys.length} flags, at most ${MAX_OBSERVATIONS} per message`);
    const bad = keys.find((k) => !FLAG_KEY.test(k) || DANGEROUS_KEYS.has(k));
    if (bad !== undefined) throw new AdapterError(`"${bad}" is not a valid flag key (letters, digits and _ . : -, starting with a letter or _)`);
    const payload = { schemaVersion: 2, environments: [env], complete };
    if (changedBy) payload.changedBy = changedBy.slice(0, 100);
    payload.observations = keys.map((key) => ({ key, env, ...states[key] }));
    return payload;
}

/**
 * Expands file patterns (`*`, `**`, `?` need Node 22+); a pattern matching nothing is an error.
 *
 * @param {string[]} patterns
 * @param {string} cwd
 * @returns {string[]} sorted, without duplicates
 * @throws {AdapterError}
 */
function expandFiles(patterns, cwd) {
    const files = new Set();
    for (const pattern of patterns) {
        let matches;
        if (!/[*?[\]{}]/.test(pattern)) matches = fs.existsSync(path.resolve(cwd, pattern)) ? [pattern] : [];
        else if (typeof fs.globSync === 'function') matches = fs.globSync(pattern, { cwd });
        else throw new AdapterError(`file patterns need Node 22 or later: ${pattern}`);
        if (!matches.length) throw new AdapterError(`no file matches ${pattern}`);
        for (const m of matches) files.add(m);
    }
    return [...files].sort();
}

/**
 * `Name: value` header lines (one per line) into an object.
 *
 * @param {string[]} lines
 * @returns {Record<string, string>}
 * @throws {AdapterError}
 */
function parseHeaders(lines) {
    const headers = {};
    for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
        const at = line.indexOf(':');
        if (at <= 0) throw new AdapterError(`header "${line.split(':')[0]}" must look like "Name: value"`);
        headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return headers;
}

/**
 * @typedef {object} AdapterOptions
 * @property {string} env ShipScope environment: test, qa or prod
 * @property {string[]} [files] file mode: paths or patterns
 * @property {string} [url] URL mode: where to fetch the flags (JSON, or another format with `format`)
 * @property {Record<string, string>} [headers] request headers for `url`
 * @property {string} [format] json, properties or env; by file name, or json for a URL, when not given
 * @property {string} [path] dot path to the object of flags
 * @property {string} [valuePath] dot path to the value inside each flag's object
 * @property {string} [prefix] only keys starting with this, removed from the key
 * @property {string} [changedBy] shown as who changed the flags
 * @property {boolean} [complete] false: send only changes, remove nothing (default true)
 * @property {boolean} [dryRun] build and print the message, send nothing
 * @property {string} [shipscopeUrl] the ShipScope server, e.g. https://shipscope.example.com
 * @property {string} [token] the flag source's ingest token (shpi_...)
 */

/**
 * Reads the flags, builds the message and (unless `dryRun`) posts it.
 *
 * @param {AdapterOptions} options
 * @param {{ fetch?: typeof fetch, cwd?: string, log?: (line: string) => void }} [io]
 * @returns {Promise<{ payload: object, result: { source: string, flags: number, changed: number, removed: number, stale: number, created: string[] }|null }>}
 * @throws {AdapterError}
 */
async function run(options, { fetch: doFetch = globalThis.fetch, cwd = process.cwd(), log = console.log } = {}) {
    const { env, files = [], url, headers = {}, format, path: dotPath, valuePath, prefix, changedBy, complete = true, dryRun = false } = options;
    if (Boolean(files.length) === Boolean(url)) throw new AdapterError('give either files or a url to read the flags from');
    const shape = { path: dotPath, valuePath, prefix };

    const maps = [];
    if (url) {
        const res = await doFetch(url, { headers });
        if (!res.ok) throw new AdapterError(`${url} answered ${res.status}`);
        maps.push({ where: url, flags: flagMap(parseDocument(await res.text(), format || 'json', url), shape, url) });
    } else {
        for (const file of expandFiles(files, cwd)) {
            const text = fs.readFileSync(path.resolve(cwd, file), 'utf8');
            maps.push({ where: file, flags: flagMap(parseDocument(text, format || formatOf(file), file), shape, file) });
        }
    }
    const payload = buildPayload({ env, states: mergeStates(maps), changedBy, complete });

    if (dryRun) {
        log(JSON.stringify(payload, null, 2));
        log(`Dry run: ${payload.observations.length} flags for ${env}, nothing sent.`);
        return { payload, result: null };
    }
    const { shipscopeUrl, token } = options;
    if (!shipscopeUrl) throw new AdapterError('the ShipScope URL is missing (SHIPSCOPE_URL)');
    if (!token) throw new AdapterError('the ingest token is missing (SHIPSCOPE_FLAGS_TOKEN)');
    const res = await doFetch(`${shipscopeUrl.replace(/\/+$/, '')}/api/flags/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) throw new AdapterError(`ShipScope answered ${res.status}: ${body.slice(0, 500)}`);
    const result = JSON.parse(body);
    log(`ShipScope (${result.source}): ${result.flags} flags for ${env}, ${result.changed} changed, ${result.removed} removed`
        + `${result.stale ? `, ${result.stale} older than what it has` : ''}${result.created.length ? `, new: ${result.created.join(', ')}` : ''}.`);
    return { payload, result };
}

module.exports = {
    AdapterError, ENVIRONMENTS, toState, pick, formatOf, parseDocument, flagMap, mergeStates, buildPayload, expandFiles, parseHeaders, run,
};
