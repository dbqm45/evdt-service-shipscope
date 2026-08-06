// scripts/update-flag-state.js
//
// Updates one (flagKey, environment) entry in docs/data/flag-states.json.
// Called by the "Update flag state" GitHub Actions workflow, triggered either
// manually (workflow_dispatch) or by a real backend service (repository_dispatch).

const fs = require('fs');

const DATA_PATH = 'docs/data/flag-states.json';
const VALID_ENVIRONMENTS = ['dev', 'qa', 'prod'];

const { FLAG_KEY, ENVIRONMENT, ENABLED, CHANGED_BY } = process.env;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

if (!FLAG_KEY) fail('Missing FLAG_KEY');
if (!ENVIRONMENT) fail('Missing ENVIRONMENT');
if (ENABLED === undefined || ENABLED === '') fail('Missing ENABLED (expected "true" or "false")');
if (!VALID_ENVIRONMENTS.includes(ENVIRONMENT)) {
    fail(`Unknown environment "${ENVIRONMENT}" — expected one of ${VALID_ENVIRONMENTS.join(', ')}`);
}

const states = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

if (!states[FLAG_KEY]) {
    fail(
        `Unknown flag "${FLAG_KEY}" — it must already exist in ${DATA_PATH}. ` +
        `New flags are created via a code PR (flags-meta.json), not via this endpoint.`
    );
}

const enabledBool = ENABLED === 'true' || ENABLED === true;

states[FLAG_KEY][ENVIRONMENT] = {
    enabled: enabledBool,
    changedAt: new Date().toISOString(),
    changedBy: CHANGED_BY || 'backend-service',
};

fs.writeFileSync(DATA_PATH, JSON.stringify(states, null, 2));
console.log(`Updated ${FLAG_KEY}.${ENVIRONMENT} -> enabled=${enabledBool} (by ${CHANGED_BY || 'backend-service'})`);