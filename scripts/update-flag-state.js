const fs = require('fs');
const { appendFlagHistoryEntries } = require('./lib/flag-history');
const DATA_PATH = 'docs/data/flag-states.json';
const FLAG_STATE_HISTORY_PATH = 'docs/data/flag-state-history.json';
const FLAGS_META_PATH = 'docs/data/flags-meta.json';
const VALID_ENVIRONMENTS = ['test', 'qa', 'prod'];
const { FLAG_KEY, ENVIRONMENT, ENABLED, CHANGED_BY } = process.env;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

if (!FLAG_KEY) {
    fail('Missing FLAG_KEY');
}
if (!ENVIRONMENT) {
    fail('Missing ENVIRONMENT');
}
if (ENABLED === undefined || ENABLED === '') {
    fail('Missing ENABLED (expected "true" or "false")');
}
if (!VALID_ENVIRONMENTS.includes(ENVIRONMENT)) {
    fail(`Unknown environment "${ENVIRONMENT}" — expected one of ${VALID_ENVIRONMENTS.join(', ')}`);
}

const states = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const flagsMeta = fs.existsSync(FLAGS_META_PATH) ? JSON.parse(fs.readFileSync(FLAGS_META_PATH, 'utf8')) : {};

if (!states[FLAG_KEY]) {
    fail(
        `Unknown flag "${FLAG_KEY}" — it must already exist in ${DATA_PATH}. ` +
        `New flags are created via a code PR (flags-meta.json), not via this endpoint.`
    );
}

const meta = flagsMeta[FLAG_KEY];
const source = meta && meta.source === 'runtime-be' ? 'runtime-be' : 'build';
const enabledBool = ENABLED === 'true' || ENABLED === true;
const changedAt = new Date().toISOString();
const changedBy = CHANGED_BY || 'backend-service';

if (!states[FLAG_KEY][ENVIRONMENT]) {
    states[FLAG_KEY][ENVIRONMENT] = {};
}

states[FLAG_KEY][ENVIRONMENT][source] = { enabled: enabledBool, changedAt, changedBy };

fs.writeFileSync(DATA_PATH, JSON.stringify(states, null, 2));
appendFlagHistoryEntries(FLAG_STATE_HISTORY_PATH, [
    { key: FLAG_KEY, env: ENVIRONMENT, source, enabled: enabledBool, changedAt, changedBy },
]);
console.log(`Updated ${FLAG_KEY}.${ENVIRONMENT}.${source} -> enabled=${enabledBool} (by ${changedBy})`);