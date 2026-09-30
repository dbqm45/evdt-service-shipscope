const fs = require('fs');
const path = require('path');
const { appendFlagHistoryEntries } = require('./lib/flag-history');
const ENVIRONMENTS = ['test', 'qa', 'prod'];

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function safeRelativePath(inputPath, label) {
    const normalized = path.normalize(inputPath);

    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        fail(`${label} "${inputPath}" is not a safe relative path — refusing to use it.`);
    }

    return normalized;
}

const FLAG_STATES_PATH = safeRelativePath(process.env.FLAG_STATES_PATH || 'docs/data/flag-states.json', 'FLAG_STATES_PATH');
const FLAG_STATE_HISTORY_PATH = safeRelativePath(
    process.env.FLAG_STATE_HISTORY_PATH || 'docs/data/flag-state-history.json',
    'FLAG_STATE_HISTORY_PATH'
);
const FLAGS_META_PATH = safeRelativePath(process.env.FLAGS_META_PATH || 'docs/data/flags-meta.json', 'FLAGS_META_PATH');
const CHANGED_BY = process.env.CHANGED_BY || 'sync-runtime-be-flags-bot';
const COMPONENT = process.env.COMPONENT || '';
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
    const res = await fetch(url);

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

    const flagStates = fs.existsSync(FLAG_STATES_PATH) ? JSON.parse(fs.readFileSync(FLAG_STATES_PATH, 'utf8')) : {};
    const flagsMeta = fs.existsSync(FLAGS_META_PATH) ? JSON.parse(fs.readFileSync(FLAGS_META_PATH, 'utf8')) : {};
    const now = new Date().toISOString();
    let changedCount = 0;
    const scaffolded = [];
    const historyEntries = [];

    for (const env of ENVIRONMENTS) {
        const flags = perEnvFlags[env];
        if (!flags) continue;

        for (const [key, newValue] of Object.entries(flags)) {
            if (!flagsMeta[key]) {
                flagsMeta[key] = {
                    description: 'TODO — describe this flag',
                    source: 'runtime-be',
                    jiraKeys: [],
                    components: COMPONENT ? [COMPONENT] : [],
                    createdAt: now,
                };
                scaffolded.push(key);
            } else if (flagsMeta[key].source !== 'runtime-be') {
                flagsMeta[key].source = 'runtime-be';
                scaffolded.push(key);
            }

            if (!flagStates[key]) {
                flagStates[key] = {};
            }
            if (!flagStates[key][env]) {
                flagStates[key][env] = {};
            }

            const existing = flagStates[key][env]['runtime-be'];

            if (!existing || existing.enabled !== newValue) {
                flagStates[key][env]['runtime-be'] = { enabled: newValue, changedAt: now, changedBy: CHANGED_BY };
                historyEntries.push({ key, env, source: 'runtime-be', enabled: newValue, changedAt: now, changedBy: CHANGED_BY });
                changedCount++;
            }
        }
    }

    if (scaffolded.length) {
        fs.writeFileSync(FLAGS_META_PATH, JSON.stringify(flagsMeta, null, 2) + '\n');
        console.log(`Created/corrected ${scaffolded.length} flags-meta.json entr${scaffolded.length===1?'y':'ies'} for BE-controlled flags: ${scaffolded.join(', ')}`);
    }

    fs.writeFileSync(FLAG_STATES_PATH, JSON.stringify(flagStates, null, 2) + '\n');
    appendFlagHistoryEntries(FLAG_STATE_HISTORY_PATH, historyEntries);
    console.log(`Done. ${changedCount} state(s) changed.`);
}

module.exports = { filterBooleanFlags, main };

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}