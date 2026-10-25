/**
 * Pure (no db/pg, no network) flag-domain rules behind lib/flags.js's readDashboardFlags() and ingestFlags()
 * -- split out so the rules can be unit-tested without a Postgres connection, same pure-core/impure-shell
 * split the project already uses for deployments (lib/deployment-logic.js) and Jira rhythms (lib/jira-model.js).
 * See design-docs/REPORT_ARCH.md, Problem 2, for the reasoning. lib/flags.js stays the orchestrator: it
 * calls withScope, runs the SQL, and hands the raw rows to these functions.
 */

const { checkUrl, SafeFetchError } = require('./safe-fetch');

class IngestPayloadError extends Error {}

// A sender's own change time is trusted within these bounds; outside them the payload is rejected.
const MAX_CHANGED_AT_AGE_MS = 7 * 24 * 3600e3;
const MAX_CHANGED_AT_SKEW_MS = 5 * 60e3;
/**
 * Flag keys become object keys in the dashboard's flag data. A name every object already has (`__proto__`,
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty`, ...) would read or write the shared prototype there
 * instead of the flag's own entry: the flag vanishes, and the built-in it hit is changed for every tenant in the
 * process. Such keys are refused on the way in and skipped on the way out (rows stored before this check).
 *
 * @param {string} key
 * @returns {boolean}
 */
function isReservedKey(key) {
    return key === 'prototype' || key in Object.prototype;
}

/** 'runtime' sources fill the dashboard's 'runtime-be' slot; everything else fills 'build'. */
function slotOf(kind) {
    return kind === 'runtime' ? 'runtime-be' : 'build';
}

/** A flag's state counts as "enabled" for anything but 'off' -- true even for a 'partial' rollout. */
function enabledFrom(state) {
    return state !== 'off';
}

/** Keys from several independent origins (sender, hand-set, Jira itself), deduplicated and sorted. */
function mergeJiraKeys(...keyLists) {
    return [...new Set(keyLists.flat())].sort();
}

/** True when a stored value and an incoming observation already agree (state, and rollout as a number). */
function sameValue(row, obs) {
    return row.state === obs.state && (row.rollout === null ? null : Number(row.rollout)) === obs.rollout;
}

/**
 * Checks what the JSON schema can't express and normalizes the payload.
 *
 * @param {{ complete?: boolean, environments?: string[], observations: Array<{ key: string, env: string, state: string, rollout?: number, changedAt?: string }>, flags?: Array<{ key: string, description?: string|null, jiraKeys?: string[] }> }} payload
 * @param {Date} now
 * @returns {{ complete: boolean, environments: string[], observations: Array<{ key: string, env: string, state: string, rollout: number|null, changedAt: Date }>, metaByKey: Map<string, object> }}
 * @throws {IngestPayloadError}
 */
function checkPayload(payload, now) {
    const seen = new Map();
    const observations = [];
    payload.observations.forEach((obs, i) => {
        if (isReservedKey(obs.key)) throw new IngestPayloadError(`observations[${i}].key is not a valid flag key`);
        if (obs.rollout !== undefined && obs.state !== 'partial') throw new IngestPayloadError(`observations[${i}]: rollout is only meaningful with state "partial"`);
        let changedAt = now;
        if (obs.changedAt !== undefined) {
            changedAt = new Date(obs.changedAt);
            const t = changedAt.getTime();
            if (Number.isNaN(t)) throw new IngestPayloadError(`observations[${i}].changedAt is not a date`);
            if (t > now.getTime() + MAX_CHANGED_AT_SKEW_MS) throw new IngestPayloadError(`observations[${i}].changedAt is in the future`);
            if (t < now.getTime() - MAX_CHANGED_AT_AGE_MS) throw new IngestPayloadError(`observations[${i}].changedAt is more than 7 days old`);
        }
        const value = { key: obs.key, env: obs.env, state: obs.state, rollout: obs.rollout ?? null, changedAt };
        const id = `${obs.key}\u0000${obs.env}`;
        const previous = seen.get(id);
        if (previous) {
            if (previous.state !== value.state || previous.rollout !== value.rollout) throw new IngestPayloadError(`conflicting values for ${obs.key}.${obs.env}`);
            return;
        }
        seen.set(id, value);
        observations.push(value);
    });
    const environments = payload.environments || [...new Set(observations.map((o) => o.env))];
    const outside = observations.find((o) => !environments.includes(o.env));
    if (outside) throw new IngestPayloadError(`${outside.key}.${outside.env}: environment ${outside.env} is not in "environments"`);

    const observedKeys = new Set(observations.map((o) => o.key));
    const metaByKey = new Map();
    for (const [i, meta] of (payload.flags || []).entries()) {
        if (isReservedKey(meta.key)) throw new IngestPayloadError(`flags[${i}].key is not a valid flag key`);
        if (metaByKey.has(meta.key)) throw new IngestPayloadError(`flags[${i}]: ${meta.key} is listed twice`);
        // Metadata only travels with values: a sender describes the flags it reports, never someone else's.
        if (!observedKeys.has(meta.key)) throw new IngestPayloadError(`flags[${i}]: ${meta.key} has no observations in this payload`);
        metaByKey.set(meta.key, meta);
    }
    return { complete: payload.complete !== false, environments, observations, metaByKey };
}

/**
 * Which of a validated, normalized set of observations to write, and which existing rows to mark removed.
 * Per observation: skipped when the stored value changed later (a delayed message must never undo a newer
 * one already applied), skipped when it already matches what's stored and isn't removed, written otherwise.
 * With `complete`, every stored row in the covered environments that the message doesn't list is removed.
 *
 * @param {{ observations: Array<{ key: string, env: string, state: string, rollout: number|null, changedAt: Date }>, existing: Array<{ key: string, environment: string, state: string, rollout: number|string|null, changed_at: Date, removed_at: Date|null }>, complete: boolean, environments: string[] }} input
 * @returns {{ writes: object[], removals: object[], stale: number }}
 */
function planIngestWrites({ observations, existing, complete, environments }) {
    const current = new Map(existing.map((r) => [`${r.key}\u0000${r.environment}`, r]));
    const writes = [];
    let stale = 0;
    for (const obs of observations) {
        const before = current.get(`${obs.key}\u0000${obs.env}`);
        if (before && before.changed_at > obs.changedAt) { stale += 1; continue; }
        if (before && !before.removed_at && sameValue(before, obs)) continue;
        writes.push(obs);
    }
    const listed = new Set(observations.map((o) => `${o.key}\u0000${o.env}`));
    const removals = complete
        ? existing.filter((r) => environments.includes(r.environment) && !r.removed_at && !listed.has(`${r.key}\u0000${r.environment}`))
        : [];
    return { writes, removals, stale };
}

/**
 * Resolves raw flag_sources rows into the shape pickWinningValues() needs: slot instead of kind, and the
 * component names (via the given lookup) of the services the source covers (flag_source_repos, migration 018).
 * `component` is the first of them, for the slot records that carry one name; an untracked repo has no name.
 *
 * @param {Array<{ id: string, name: string, kind: string, priority: number }>} sourceRows
 * @param {(repoId: number) => string|null} componentOf
 * @param {Map<string, number[]>} scopes source id -> the repo ids it covers
 * @returns {Map<string, { name: string, kind: string, slot: string, priority: number, component: string|null, components: string[] }>}
 */
function sourceDescriptors(sourceRows, componentOf, scopes) {
    return new Map(sourceRows.map((s) => {
        const components = [...new Set((scopes.get(s.id) || []).map((id) => componentOf(Number(id))).filter(Boolean))].sort();
        return [s.id, { name: s.name, kind: s.kind, slot: slotOf(s.kind), priority: s.priority, component: components[0] || null, components }];
    }));
}

/** Which of two values wins inside one service: runtime over build, then the higher priority, then the later change. */
function beatsInService(a, b) {
    if (a.source.kind !== b.source.kind) return a.source.kind === 'runtime';
    if (a.source.priority !== b.source.priority) return a.source.priority > b.source.priority;
    return a.v.changed_at > b.v.changed_at;
}

/**
 * Per (key, env, slot), the winning value across every source that reports it: highest priority, then
 * latest changed_at on a tie. Also collects every component that ever reported each key (not just the
 * winner's) and which slots each key has a winner in -- visibleFlagsMeta()'s visibility rule needs that.
 *
 * @param {Array<{ source_id: string, key: string, environment: string, state: string, rollout: number|string|null, changed_at: Date, changed_by: string }>} values
 * @param {Map<string, { name: string, slot: string, priority: number, component: string|null }>} sources
 * Alongside, `byComponent`: per (key, env, service) the value that service actually runs, from the sources that
 * cover it (beatsInService()), with the values it overrode. A source covering no service adds nothing there.
 *
 * @returns {{ flagStates: object, byComponent: object, slotsOf: Map<string, Set<string>>, componentsOf: Map<string, Set<string>> }}
 */
function pickWinningValues(values, sources) {
    const winners = new Map();
    const componentsOf = new Map();
    const inService = new Map();
    for (const v of values.filter((row) => !isReservedKey(row.key))) {
        const source = sources.get(v.source_id);
        const id = `${v.key}\u0000${v.environment}\u0000${source.slot}`;
        const best = winners.get(id);
        if (!best || source.priority > best.source.priority || (source.priority === best.source.priority && v.changed_at > best.v.changed_at)) {
            winners.set(id, { v, source });
        }
        if (!componentsOf.has(v.key)) componentsOf.set(v.key, new Set());
        for (const component of source.components) {
            componentsOf.get(v.key).add(component);
            const serviceId = `${v.key}\u0000${v.environment}\u0000${component}`;
            if (!inService.has(serviceId)) inService.set(serviceId, { key: v.key, env: v.environment, component, all: [] });
            inService.get(serviceId).all.push({ v, source });
        }
    }

    const byComponent = {};
    for (const { key, env, component, all } of inService.values()) {
        const [win, ...rest] = [...all].sort((a, b) => (beatsInService(a, b) ? -1 : beatsInService(b, a) ? 1 : 0));
        ((byComponent[key] ||= {})[env] ||= {})[component] = {
            state: win.v.state,
            rollout: win.v.rollout === null ? null : Number(win.v.rollout),
            // Strictly "on": a partial rollout is not released to everybody (ADR-003).
            enabled: win.v.state === 'on',
            changedAt: win.v.changed_at.toISOString(),
            changedBy: win.v.changed_by,
            sourceName: win.source.name,
            kind: win.source.kind,
            overridden: rest.map(({ v, source }) => ({ sourceName: source.name, kind: source.kind, state: v.state })),
        };
    }

    const flagStates = {};
    const slotsOf = new Map();
    for (const { v, source } of winners.values()) {
        ((flagStates[v.key] ||= {})[v.environment] ||= {})[source.slot] = {
            enabled: enabledFrom(v.state),
            state: v.state,
            rollout: v.rollout === null ? null : Number(v.rollout),
            changedAt: v.changed_at.toISOString(),
            changedBy: v.changed_by,
            component: source.component,
            sourceName: source.name,
        };
        if (!slotsOf.has(v.key)) slotsOf.set(v.key, new Set());
        slotsOf.get(v.key).add(source.slot);
    }
    return { flagStates, byComponent, slotsOf, componentsOf };
}

/**
 * flags-meta.json shape for every flag some source still reports. A flag no source reports any more
 * (removed everywhere, or its sources deleted -- i.e. absent from `slotsOf`) is not shown: the dashboard's
 * visibility rule.
 *
 * @param {Array<{ key: string, description: string, manual_description: string|null, jira_keys: string[], manual_jira_keys: string[], created_at: Date }>} flags
 * @param {{ slotsOf: Map<string, Set<string>>, componentsOf: Map<string, Set<string>> }} winners
 * @param {Map<string, string[]>} fromJira flag key -> issue keys whose Jira issue names that flag
 * @returns {object}
 */
function visibleFlagsMeta(flags, { slotsOf, componentsOf }, fromJira) {
    const flagsMeta = {};
    for (const f of flags.filter((row) => slotsOf.has(row.key) && !isReservedKey(row.key))) {
        flagsMeta[f.key] = {
            description: f.manual_description || f.description || '',
            source: slotsOf.get(f.key).has('runtime-be') ? 'runtime-be' : 'build',
            jiraKeys: mergeJiraKeys(f.jira_keys, f.manual_jira_keys, fromJira.get(f.key) || []),
            components: [...componentsOf.get(f.key)].sort(),
            createdAt: f.created_at.toISOString(),
        };
    }
    return flagsMeta;
}

/**
 * flag-state-history.json shape for history rows already filtered to "not removed".
 *
 * @param {Array<{ source_id: string, key: string, environment: string, state: string, changed_at: Date, changed_by: string }>} history
 * @param {Map<string, { slot: string }>} sources
 * @returns {object[]}
 */
function historyRecords(history, sources) {
    return history.map((h) => ({
        key: h.key, env: h.environment, source: sources.get(h.source_id).slot, enabled: enabledFrom(h.state),
        changedAt: h.changed_at.toISOString(), changedBy: h.changed_by,
    }));
}

class FlagSourceConfigError extends Error {}

const CODE_FILE = /^(?!\/)(?!(.*\/)?\.\.(\/|$))[A-Za-z0-9._/{}-]{1,200}$/;
const ENV_NAME = /^[A-Za-z0-9._-]{1,50}$/;
const CODE_FORMATS = ['json', 'yaml', 'properties', 'env', 'ts', 'js'];

/** The format of a flags file from its name (the adapter's rule), or null when the name says nothing. */
function codeFileFormat(fileName) {
    const base = fileName.split('/').pop().toLowerCase();
    if (base.endsWith('.json')) return 'json';
    if (base.endsWith('.yaml') || base.endsWith('.yml')) return 'yaml';
    if (base.endsWith('.properties')) return 'properties';
    if (/\.[mc]?[tj]s$/.test(base)) return 'ts';
    if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'env';
    return null;
}

/**
 * Checks a source read from code (ADR-003, `flag_sources.code_config`) and returns it with only the fields it uses:
 * a build source over exactly one repository; a repo-relative `file`, optionally with one `{env}` (replaced by the
 * environment's name, `envNames[env]` or test/qa/prod); a known format; for .env/.properties a `prefix` or `keys`.
 *
 * @param {{ file: string, format?: string, path?: string, valuePath?: string, keyField?: string, rolloutPath?: string, prefix?: string, keys?: string[], envNames?: Partial<Record<'test'|'qa'|'prod', string>> }} code
 * @param {{ kind: string, repoIds: number[] }} source
 * @returns {object}
 * @throws {FlagSourceConfigError}
 */
function checkCodeConfig(code, { kind, repoIds }) {
    if (kind !== 'build') throw new FlagSourceConfigError('A source read from code is a build source');
    if (repoIds.length !== 1) throw new FlagSourceConfigError('A source read from code reads one repository: pick exactly one');
    if (!code || typeof code.file !== 'string' || !CODE_FILE.test(code.file) || (code.file.match(/\{env\}/g) || []).length > 1
        || /\{(?!env\})|(?<!\{env)\}/.test(code.file)) {
        throw new FlagSourceConfigError('The file is a path inside the repository (no leading / or ..), with at most one {env}');
    }
    const format = code.format || codeFileFormat(code.file.replace('{env}', 'prod'));
    if (!CODE_FORMATS.includes(format)) throw new FlagSourceConfigError(`Name the file's format (${CODE_FORMATS.join(', ')})`);
    const keys = Array.isArray(code.keys) ? code.keys : [];
    if ((format === 'env' || format === 'properties') && !code.prefix && !keys.length) {
        throw new FlagSourceConfigError('A .env or .properties file holds other settings too: name the flags\' prefix or their keys');
    }
    const envNames = {};
    for (const [env, name] of Object.entries(code.envNames || {})) {
        if (!['test', 'qa', 'prod'].includes(env) || typeof name !== 'string' || !ENV_NAME.test(name)) {
            throw new FlagSourceConfigError('Environment names map test, qa or prod to a name of letters, digits and . _ -');
        }
        envNames[env] = name;
    }
    const out = { file: code.file };
    if (code.format) out.format = code.format;
    for (const field of ['path', 'valuePath', 'keyField', 'rolloutPath', 'prefix']) if (code[field]) out[field] = code[field];
    if (keys.length) out.keys = keys;
    if (Object.keys(envNames).length) out.envNames = envNames;
    return out;
}

/** The file a code source reads for one environment: `{env}` replaced by its name there. */
function codeFileFor(code, env) {
    return code.file.replace('{env}', (code.envNames && code.envNames[env]) || env);
}

// What an endpoint may answer: a document of flags, read like a file of that format.
const ENDPOINT_FORMATS = ['json', 'yaml'];
// A token goes in Authorization as a bearer token, or as is in a header of the customer's own (x-...), never in one
// of ShipScope's signature headers.
const TOKEN_HEADER = /^x-(?!shipscope-)[a-z0-9-]{1,60}$/;

/**
 * Checks a source ShipScope polls (ADR-003, `flag_sources.endpoint_config`) and returns it with only the fields it
 * uses: a runtime source; an https address per environment (at least one, each passing safe-fetch's checkUrl(), which
 * does no I/O); json or yaml (else told by the answer's content type); the reading fields of a file; where the token goes.
 *
 * @param {{ urls: Partial<Record<'test'|'qa'|'prod', string>>, format?: 'json'|'yaml', path?: string, valuePath?: string, keyField?: string, rolloutPath?: string, prefix?: string, keys?: string[], tokenHeader?: string }} endpoint
 * @param {{ kind: string }} source
 * @returns {object}
 * @throws {FlagSourceConfigError}
 */
function checkEndpointConfig(endpoint, { kind }) {
    if (kind !== 'runtime') throw new FlagSourceConfigError('A source read from an endpoint is a runtime source');
    const urls = {};
    for (const [env, url] of Object.entries((endpoint && endpoint.urls) || {})) {
        if (!['test', 'qa', 'prod'].includes(env)) throw new FlagSourceConfigError('Addresses are given for test, qa or prod');
        try {
            urls[env] = checkUrl(url).href;
        } catch (err) {
            if (err instanceof SafeFetchError) throw new FlagSourceConfigError(`${env}: ${err.message}`);
            throw err;
        }
    }
    if (!Object.keys(urls).length) throw new FlagSourceConfigError('Give the address of at least one environment');
    if (endpoint.format && !ENDPOINT_FORMATS.includes(endpoint.format)) throw new FlagSourceConfigError(`An endpoint answers ${ENDPOINT_FORMATS.join(' or ')}`);
    const tokenHeader = endpoint.tokenHeader ? endpoint.tokenHeader.toLowerCase() : 'authorization';
    if (tokenHeader !== 'authorization' && !TOKEN_HEADER.test(tokenHeader)) {
        throw new FlagSourceConfigError('The token goes in Authorization or in a header of your own named x-...');
    }
    const out = { urls };
    if (endpoint.format) out.format = endpoint.format;
    for (const field of ['path', 'valuePath', 'keyField', 'rolloutPath', 'prefix']) if (endpoint[field]) out[field] = endpoint[field];
    if (Array.isArray(endpoint.keys) && endpoint.keys.length) out.keys = endpoint.keys;
    if (tokenHeader !== 'authorization') out.tokenHeader = tokenHeader;
    return out;
}

/** Minutes a confirmation stays fresh when the source sets no threshold: a runtime value can change any time, a
 *  build value only with a deployment (null = never stale). */
const STALE_AFTER_MINUTES = { runtime: 24 * 60, build: null };
const FRESHNESS_ORDER = ['fresh', 'unknown', 'stale', 'error'];

/**
 * One source's freshness on one environment (ADR-003): `error` when its last error is newer than its last full
 * confirmation, `unknown` when it never confirmed one, `stale` when the confirmation is older than the threshold,
 * else `fresh`.
 *
 * @param {{ observedAt: Date|null, errorAt: Date|null, staleAfterMinutes: number|null, now: Date }} input
 * @returns {'fresh'|'stale'|'error'|'unknown'}
 */
function freshnessOf({ observedAt, errorAt, staleAfterMinutes, now }) {
    if (errorAt && (!observedAt || errorAt > observedAt)) return 'error';
    if (!observedAt) return 'unknown';
    if (staleAfterMinutes && now - observedAt > staleAfterMinutes * 60_000) return 'stale';
    return 'fresh';
}

/**
 * Per service and environment, how sure the flag values are: every source covering the service, its own state, and
 * the worst of them (error > stale > unknown > fresh) with the oldest confirmation.
 *
 * @param {Array<{ name: string, components: string[], envs: Array<{ env: string, state: string, observedAt: Date|null }> }>} sources
 * @returns {Object<string, Object<string, { state: string, observedAt: string|null, sources: Array<{ name: string, state: string, observedAt: string|null }> }>>}
 */
function freshnessByComponent(sources) {
    const out = {};
    for (const source of sources) {
        for (const component of source.components) {
            for (const { env, state, observedAt } of source.envs) {
                const entry = ((out[component] ||= {})[env] ||= { state: 'fresh', observedAt: null, sources: [] });
                const at = observedAt ? observedAt.toISOString() : null;
                entry.sources.push({ name: source.name, state, observedAt: at });
                if (FRESHNESS_ORDER.indexOf(state) > FRESHNESS_ORDER.indexOf(entry.state)) entry.state = state;
                if (at && (!entry.observedAt || at < entry.observedAt)) entry.observedAt = at;
            }
        }
    }
    return out;
}

module.exports = {
    FlagSourceConfigError,
    checkCodeConfig,
    codeFileFor,
    codeFileFormat,
    checkEndpointConfig,
    STALE_AFTER_MINUTES,
    freshnessOf,
    freshnessByComponent,
    IngestPayloadError,
    isReservedKey,
    MAX_CHANGED_AT_AGE_MS,
    MAX_CHANGED_AT_SKEW_MS,
    slotOf,
    enabledFrom,
    mergeJiraKeys,
    sameValue,
    checkPayload,
    planIngestWrites,
    sourceDescriptors,
    pickWinningValues,
    visibleFlagsMeta,
    historyRecords,
};
