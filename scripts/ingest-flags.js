const { fail, safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');
const { appendFlagHistoryEntries } = require('./lib/flag-history');
const { applyObservations } = require('./lib/flag-ingest');
const { resolveActorName } = require('./lib/github-users');

const ENVIRONMENTS = ['test', 'qa', 'prod'];
const SOURCES = ['build', 'runtime-be'];
const SUPPORTED_SCHEMA_VERSION = 1;
const MAX_OBSERVATIONS = 5000;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Validates a flag-ingest payload (see design-docs/FLAG-INGEST.pl.md) and groups it for applyObservations.
 * The payload comes from a repo we don't control, so nothing in it is trusted: shape, sizes, keys, envs and
 * types are all checked. `component` is deliberately NOT taken from the payload — the collision guard relies
 * on it, so the caller (workflow) supplies it from the caller's identity; a payload that names a different
 * component is rejected rather than ignored.
 * Throws an Error with a human-readable message on the first problem found.
 */
function validatePayload(payload, expectedComponent) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('payload must be a JSON object');
    }
    if (payload.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        throw new Error(`unsupported schemaVersion ${JSON.stringify(payload.schemaVersion)} (expected ${SUPPORTED_SCHEMA_VERSION})`);
    }
    if (payload.component !== undefined && payload.component !== expectedComponent) {
        throw new Error(`payload component ${JSON.stringify(payload.component)} does not match the calling component "${expectedComponent}"`);
    }
    if (!SOURCES.includes(payload.source)) {
        throw new Error(`source must be one of ${SOURCES.join(', ')}, got ${JSON.stringify(payload.source)}`);
    }
    if (!Array.isArray(payload.observations)) {
        throw new Error('observations must be an array');
    }
    if (payload.observations.length > MAX_OBSERVATIONS) {
        throw new Error(`too many observations (${payload.observations.length} > ${MAX_OBSERVATIONS})`);
    }

    const valuesByKey = {};

    payload.observations.forEach((obs, i) => {
        if (!obs || typeof obs !== 'object' || Array.isArray(obs)) {
            throw new Error(`observations[${i}] must be an object`);
        }
        if (typeof obs.key !== 'string' || !KEY_PATTERN.test(obs.key) || DANGEROUS_KEYS.includes(obs.key)) {
            throw new Error(`observations[${i}].key is not a valid flag key: ${JSON.stringify(obs.key)}`);
        }
        if (!ENVIRONMENTS.includes(obs.env)) {
            throw new Error(`observations[${i}].env must be one of ${ENVIRONMENTS.join(', ')}, got ${JSON.stringify(obs.env)}`);
        }
        if (typeof obs.enabled !== 'boolean') {
            throw new Error(`observations[${i}].enabled must be a boolean`);
        }
        if (!valuesByKey[obs.key]) valuesByKey[obs.key] = {};
        if (obs.env in valuesByKey[obs.key] && valuesByKey[obs.key][obs.env] !== obs.enabled) {
            throw new Error(`conflicting values for ${obs.key}.${obs.env}`);
        }
        valuesByKey[obs.key][obs.env] = obs.enabled;
    });

    return { source: payload.source, valuesByKey };
}

function main(resolvedChangedBy) {
    const component = process.env.COMPONENT;
    if (!component) fail('Missing COMPONENT');

    if (!process.env.PAYLOAD_PATH) fail('Missing PAYLOAD_PATH');

    const payloadPath = safeRelativePath(process.env.PAYLOAD_PATH, 'PAYLOAD_PATH');
    const flagStatesPath = safeRelativePath(process.env.FLAG_STATES_PATH || 'docs/data/flag-states.json', 'FLAG_STATES_PATH');
    const historyPath = safeRelativePath(
        process.env.FLAG_STATE_HISTORY_PATH || 'docs/data/flag-state-history.json',
        'FLAG_STATE_HISTORY_PATH'
    );
    const flagsMetaPath = safeRelativePath(process.env.FLAGS_META_PATH || 'docs/data/flags-meta.json', 'FLAGS_META_PATH');
    const ingestMetaPath = safeRelativePath(
        process.env.FLAG_INGEST_META_PATH || 'docs/data/flag-ingest-meta.json',
        'FLAG_INGEST_META_PATH'
    );
    const changedBy = resolvedChangedBy || process.env.CHANGED_BY || 'ingest-flags-bot';

    let parsed;
    try {
        parsed = validatePayload(readJson(payloadPath), component);
    } catch (e) {
        fail(`Invalid flag payload (${payloadPath}): ${e.message}`);
    }

    const flagStates = readJson(flagStatesPath, {});
    const flagsMeta = readJson(flagsMetaPath, {});
    const { changedCount, metaChanged, scaffolded, historyEntries } = applyObservations({
        flagStates,
        flagsMeta,
        valuesByKey: parsed.valuesByKey,
        component,
        source: parsed.source,
        changedBy,
        now: new Date().toISOString(),
    });

    if (metaChanged) {
        writeJson(flagsMetaPath, flagsMeta);
    }

    writeJson(flagStatesPath, flagStates);
    appendFlagHistoryEntries(historyPath, historyEntries);

    // "Last message from this component" marker for staleness detection (push fails silently). Day granularity
    // on purpose: a full timestamp would make every run a commit, breaking the no-change = no-commit idempotency.
    const ingestMeta = readJson(ingestMetaPath, {});
    const today = new Date().toISOString().slice(0, 10);

    if (!ingestMeta[component] || ingestMeta[component].lastMessageDay !== today || ingestMeta[component].source !== parsed.source) {
        ingestMeta[component] = { lastMessageDay: today, source: parsed.source };
        writeJson(ingestMetaPath, ingestMeta);
    }
    console.log(
        `Ingested ${Object.keys(parsed.valuesByKey).length} ${parsed.source} flag(s) for ${component}; ${changedCount} state(s) changed` +
        (scaffolded.length ? `, scaffolded ${scaffolded.length} missing flags-meta.json stub(s): ${scaffolded.join(', ')}.` : '.')
    );
}

module.exports = { validatePayload, main };

if (require.main === module) {
    // Store the actor's display name when they have one (as the Deployment History does), else the login.
    resolveActorName(process.env.CHANGED_BY, process.env.GITHUB_TOKEN)
        .then(name => main(name))
        .catch(e => { console.error(e); process.exit(1); });
}
