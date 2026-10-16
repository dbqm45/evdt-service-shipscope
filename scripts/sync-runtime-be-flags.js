const { fail, safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');
const { appendFlagHistoryEntries } = require('./lib/flag-history');
const { applyObservations } = require('./lib/flag-ingest');
const ENVIRONMENTS = ['test', 'qa', 'prod'];
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 30000;

const FLAG_STATES_PATH = safeRelativePath(process.env.FLAG_STATES_PATH || 'docs/data/flag-states.json', 'FLAG_STATES_PATH');
const FLAG_STATE_HISTORY_PATH = safeRelativePath(
    process.env.FLAG_STATE_HISTORY_PATH || 'docs/data/flag-state-history.json',
    'FLAG_STATE_HISTORY_PATH'
);
const FLAGS_META_PATH = safeRelativePath(process.env.FLAGS_META_PATH || 'docs/data/flags-meta.json', 'FLAGS_META_PATH');
const CHANGED_BY = process.env.CHANGED_BY || 'sync-runtime-be-flags-bot';
const COMPONENT = process.env.COMPONENT;

if (!COMPONENT) {
    fail('Missing COMPONENT');
}
const ENDPOINTS = {
    test: process.env.URL_TEST,
    qa: process.env.URL_QA,
    prod: process.env.URL_PROD,
};

function filterBooleanFlags(rawResponse) {
    const result = {};

    for (const [key, value] of Object.entries(rawResponse || {})) {
        if (typeof value === 'boolean') result[key] = value;
    }

    return result;
}

async function fetchEnvFlags(env, url) {
    if (!url) {
        console.warn(`Warning: no URL configured for "${env}" — skipping.`);
        return null;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (!res.ok) {
        throw new Error(`Request to ${env} endpoint failed: ${res.status} ${await res.text()}`);
    }

    const raw = await res.json();
    const flags = filterBooleanFlags(raw);

    console.log(`${env}: fetched ${Object.keys(raw).length} propert${Object.keys(raw).length === 1 ? 'y' : 'ies'}, ${Object.keys(flags).length} of them are boolean flags.`);

    return flags;
}

async function main() {
    const perEnvFlags = {};

    for (const env of ENVIRONMENTS) {
        perEnvFlags[env] = await fetchEnvFlags(env, ENDPOINTS[env]);
    }

    const flagStates = readJson(FLAG_STATES_PATH, {});
    const flagsMeta = readJson(FLAGS_META_PATH, {});
    const now = new Date().toISOString();

    // Grouped by key first (not env-then-key, as the raw per-env fetch is) — the shape applyObservations expects.
    const valuesByKey = {};

    for (const env of ENVIRONMENTS) {
        const flags = perEnvFlags[env];
        if (!flags) continue;

        for (const [key, newValue] of Object.entries(flags)) {
            if (!valuesByKey[key]) valuesByKey[key] = {};
            valuesByKey[key][env] = newValue;
        }
    }

    const { changedCount, metaChanged, scaffolded, historyEntries } = applyObservations({
        flagStates,
        flagsMeta,
        valuesByKey,
        component: COMPONENT,
        source: 'runtime-be',
        changedBy: CHANGED_BY,
        now,
        correctMetaSource: true,
    });

    if (metaChanged) {
        writeJson(FLAGS_META_PATH, flagsMeta);

        if (scaffolded.length) {
            console.log(`Created/corrected ${scaffolded.length} flags-meta.json entr${scaffolded.length===1?'y':'ies'} for BE-controlled flags: ${scaffolded.join(', ')}`);
        }
    }

    writeJson(FLAG_STATES_PATH, flagStates);
    appendFlagHistoryEntries(FLAG_STATE_HISTORY_PATH, historyEntries);
    console.log(`Done. ${changedCount} state(s) changed.`);
}

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
