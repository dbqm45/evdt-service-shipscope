/**
 * The ShipScope flags adapter: reads a team's feature flags from files or a URL, turns them into one ingest
 * message (schemaVersion 2, server/schemas/flags-ingest.v2.schema.json) for one environment, and posts it to
 * POST /api/flags/ingest. Shared by the CLI (shipscope-flags.js) and the GitHub Action (action.js); no
 * dependencies, so the Action runs straight from the repository. Self-contained on purpose: it never requires
 * from server/ or scripts/ (scripts/lib/module-boundaries.js).
 */
const fs = require('fs');
const path = require('path');
const { readScriptObjects, ScriptParseError, Unreadable } = require('./script-objects');

const ENVIRONMENTS = ['test', 'qa', 'prod'];
// The same rules as the server's schema; checked here so a wrong key fails before anything is sent.
const FLAG_KEY = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_OBSERVATIONS = 5000;
const FORMATS = ['json', 'properties', 'env', 'ts', 'js'];
// File names that become ShipScope environments with {env} in a pattern, unless env-map says otherwise.
const DEFAULT_ENV_MAP = { test: 'test', qa: 'qa', prod: 'prod' };

class AdapterError extends Error {}

// Marks a parsed TypeScript/JavaScript module (its value: the exported names); its top-level objects by name follow.
const SCRIPT = Symbol('script');

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
    if (v instanceof Unreadable) {
        throw new AdapterError(`${where}: "${v.text}" is not written out as a value (the adapter reads the file, it does not run it)`);
    }
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
 * The format of a flags file from its name: .json, .properties, .env (also `.env.prod`, `prod.env`), or a
 * TypeScript/JavaScript module (.ts, .mts, .cts, .js, .mjs, .cjs).
 *
 * @param {string} file
 * @returns {'json'|'properties'|'env'|'ts'}
 * @throws {AdapterError}
 */
function formatOf(file) {
    const base = path.basename(file).toLowerCase();
    if (base.endsWith('.json')) return 'json';
    if (base.endsWith('.properties')) return 'properties';
    if (/\.[mc]?[tj]s$/.test(base)) return 'ts';
    if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'env';
    throw new AdapterError(`${file}: unknown format, name it with --format (${FORMATS.join(', ')})`);
}

/**
 * Parses a flags document: JSON; `key=value` lines (Java .properties also take `key: value`; .env lines may
 * start with `export`; `#` and `!` lines are comments; matching quotes around a value are removed); or a
 * TypeScript/JavaScript module, read without running it (script-objects.js): its object literals by name.
 *
 * @param {string} text
 * @param {'json'|'properties'|'env'|'ts'|'js'} format
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
    if (format === 'ts' || format === 'js') {
        let read;
        try {
            read = readScriptObjects(text, where);
        } catch (err) {
            if (err instanceof ScriptParseError) throw new AdapterError(err.message);
            throw err;
        }
        return { [SCRIPT]: read.exported, ...read.objects };
    }
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
    let source = doc;
    if (doc && doc[SCRIPT] && !dotPath) {
        // A module: the object of flags is its only exported object (else its only object), or the one `path` names.
        const all = Object.keys(doc);
        const names = doc[SCRIPT].length ? doc[SCRIPT] : all;
        if (names.length !== 1) {
            throw new AdapterError(names.length
                ? `${where}: several objects (${names.join(', ')}); name the one with the flags in path`
                : `${where}: no object literal found (const NAME = { ... } or export default { ... })`);
        }
        source = doc[names[0]];
    }
    const map = pick(source, dotPath, where);
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
 * The ingest message: the full state of each environment given (environments not given are left alone).
 *
 * @param {{ byEnv: Record<string, Record<string, { state: string, rollout?: number }>>, changedBy?: string, complete?: boolean }} input
 * @returns {{ schemaVersion: 2, environments: string[], complete: boolean, changedBy?: string, observations: object[] }}
 * @throws {AdapterError}
 */
function buildPayload({ byEnv, changedBy, complete = true }) {
    const envs = Object.keys(byEnv);
    const wrong = envs.find((env) => !ENVIRONMENTS.includes(env));
    if (wrong !== undefined) throw new AdapterError(`environment "${wrong}" must be one of ${ENVIRONMENTS.join(', ')}`);
    if (!envs.length) throw new AdapterError('no environment to send');
    const observations = [];
    for (const env of ENVIRONMENTS.filter((e) => envs.includes(e))) {
        for (const key of Object.keys(byEnv[env]).sort()) {
            if (!FLAG_KEY.test(key) || DANGEROUS_KEYS.has(key)) {
                throw new AdapterError(`"${key}" is not a valid flag key (letters, digits and _ . : -, starting with a letter or _)`);
            }
            observations.push({ key, env, ...byEnv[env][key] });
        }
    }
    if (observations.length > MAX_OBSERVATIONS) throw new AdapterError(`${observations.length} values, at most ${MAX_OBSERVATIONS} per message`);
    const payload = { schemaVersion: 2, environments: ENVIRONMENTS.filter((e) => envs.includes(e)), complete };
    if (changedBy) payload.changedBy = changedBy.slice(0, 100);
    payload.observations = observations;
    return payload;
}

/**
 * The regular expression a pattern with `{env}` matches paths with, capturing the environment's name.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function envPatternRegExp(pattern) {
    let re = '';
    for (const part of pattern.split(/(\{env\}|\*\*\/|\*\*|\*|\?)/)) {
        if (part === '{env}') re += '([^/]+?)';
        else if (part === '**/') re += '(?:.*/)?';
        else if (part === '**') re += '.*';
        else if (part === '*') re += '[^/]*';
        else if (part === '?') re += '[^/]';
        else re += part.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

/**
 * Expands file patterns (`*`, `**`, `?` need Node 22+); a pattern matching nothing is an error. In a pattern,
 * `{env}` stands for the environment's name and is captured from each file's path.
 *
 * @param {string[]} patterns
 * @param {string} cwd
 * @returns {Array<{ file: string, env: string|null }>} sorted by file, without duplicates
 * @throws {AdapterError}
 */
function expandFiles(patterns, cwd) {
    const files = new Map();
    for (const pattern of patterns) {
        const glob = pattern.split('{env}').join('*');
        let matches;
        if (!/[*?[\]{}]/.test(glob)) matches = fs.existsSync(path.resolve(cwd, glob)) ? [glob] : [];
        else if (typeof fs.globSync === 'function') matches = fs.globSync(glob, { cwd });
        else throw new AdapterError(`file patterns need Node 22 or later: ${pattern}`);
        if (!matches.length) throw new AdapterError(`no file matches ${pattern}`);
        const envRe = pattern.includes('{env}') ? envPatternRegExp(pattern) : null;
        for (const m of matches) {
            const posix = m.split(path.sep).join('/');
            const env = envRe ? (envRe.exec(posix) || [])[1] ?? null : null;
            if (envRe && env === null) continue;
            files.set(m, { file: m, env });
        }
    }
    return [...files.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * `name=env` pairs (comma- or newline-separated): which file names become which ShipScope environment.
 *
 * @param {string[]} items
 * @returns {Record<string, string>|undefined} undefined when none are given (the default map applies)
 * @throws {AdapterError}
 */
function parseEnvMap(items) {
    const pairs = items.flatMap((i) => i.split(/[,\n]/)).map((p) => p.trim()).filter(Boolean);
    if (!pairs.length) return undefined;
    const map = {};
    for (const pair of pairs) {
        const [name, env, extra] = pair.split('=').map((x) => x.trim());
        if (!name || !env || extra !== undefined) throw new AdapterError(`env-map entry "${pair}" must look like name=env`);
        if (!ENVIRONMENTS.includes(env)) throw new AdapterError(`env-map entry "${pair}": ${env} must be one of ${ENVIRONMENTS.join(', ')}`);
        map[name] = env;
    }
    return map;
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
 * @property {string} [env] ShipScope environment: test, qa or prod; not with {env} in the file patterns
 * @property {string[]} [files] file mode: paths or patterns, optionally with {env} for the environment's name
 * @property {Record<string, string>} [envMap] with {env}: file name -> ShipScope environment (default test, qa,
 *   prod as themselves); other names are skipped
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
    const envMap = options.envMap || DEFAULT_ENV_MAP;
    if (Boolean(files.length) === Boolean(url)) throw new AdapterError('give either files or a url to read the flags from');
    const withEnv = files.filter((f) => f.includes('{env}'));
    if (withEnv.length && withEnv.length !== files.length) throw new AdapterError('use {env} in every file pattern or in none');
    if (withEnv.length && env) throw new AdapterError('give either an environment or {env} in the file patterns, not both');
    if (!withEnv.length && !env) throw new AdapterError('the environment is missing (or put {env} in the file patterns)');
    const shape = { path: dotPath, valuePath, prefix };

    const mapsByEnv = {};
    const add = (target, where, flags) => (mapsByEnv[target] ||= []).push({ where, flags });
    if (url) {
        const res = await doFetch(url, { headers });
        if (!res.ok) throw new AdapterError(`${url} answered ${res.status}`);
        add(env, url, flagMap(parseDocument(await res.text(), format || 'json', url), shape, url));
    } else {
        for (const { file, env: name } of expandFiles(files, cwd)) {
            const target = name === null ? env : (Object.hasOwn(envMap, name) ? envMap[name] : null);
            if (!target) {
                log(`Skipped ${file}: "${name}" is not in env-map (${Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join(', ')}).`);
                continue;
            }
            const text = fs.readFileSync(path.resolve(cwd, file), 'utf8');
            add(target, file, flagMap(parseDocument(text, format || formatOf(file), file), shape, file));
        }
        if (!Object.keys(mapsByEnv).length) throw new AdapterError('no file is for a mapped environment');
    }
    const byEnv = Object.fromEntries(Object.entries(mapsByEnv).map(([target, maps]) => [target, mergeStates(maps)]));
    const payload = buildPayload({ byEnv, changedBy, complete });
    const flagCount = new Set(payload.observations.map((o) => o.key)).size;
    const envList = payload.environments.join(', ');

    if (dryRun) {
        log(JSON.stringify(payload, null, 2));
        log(`Dry run: ${flagCount} flags for ${envList}, nothing sent.`);
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
    log(`ShipScope (${result.source}): ${result.flags} flags for ${envList}, ${result.changed} changed, ${result.removed} removed`
        + `${result.stale ? `, ${result.stale} older than what it has` : ''}${result.created.length ? `, new: ${result.created.join(', ')}` : ''}.`);
    return { payload, result };
}

module.exports = {
    AdapterError, ENVIRONMENTS, toState, pick, formatOf, parseDocument, flagMap, mergeStates, buildPayload, expandFiles, envPatternRegExp,
    parseEnvMap, parseHeaders, run,
};
