/**
 * Pure (no db/pg, no network) flag-domain rules behind lib/flags.js's readDashboardFlags() and ingestFlags()
 * -- split out so the rules can be unit-tested without a Postgres connection, same pure-core/impure-shell
 * split the project already uses for deployments (lib/deployment-logic.js) and Jira rhythms (lib/jira-model.js).
 * See design-docs/REPORT_ARCH.md, Problem 2, for the reasoning. lib/flags.js stays the orchestrator: it
 * calls withScope, runs the SQL, and hands the raw rows to these functions.
 */

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

module.exports = {
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
