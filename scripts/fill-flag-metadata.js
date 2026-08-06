// scripts/fill-flag-metadata.js
//
// Fills in (or creates) one entry in flags-meta.json from structured inputs,
// instead of hand-editing JSON in the GitHub web UI. Backs the
// "Fill flag metadata" workflow_dispatch form in shipscope-test.

const fs = require('fs');

const DATA_PATH = process.env.FLAGS_META_PATH || 'docs/data/flags-meta.json';
const { FLAG_KEY, DESCRIPTION, SOURCE, JIRA_KEYS, COMPONENTS } = process.env;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

if (!FLAG_KEY) fail('Missing FLAG_KEY');
if (!SOURCE) fail('Missing SOURCE');
if (!['build', 'runtime-be'].includes(SOURCE)) {
    fail(`Invalid SOURCE "${SOURCE}" — must be "build" or "runtime-be"`);
}

const jiraKeys = (JIRA_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const components = (COMPONENTS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!jiraKeys.length) fail('JIRA_KEYS resolved to an empty list — provide at least one, comma-separated');
if (!components.length) fail('COMPONENTS resolved to an empty list — provide at least one, comma-separated');

const flagsMeta = fs.existsSync(DATA_PATH) ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) : {};

const isNew = !flagsMeta[FLAG_KEY];

flagsMeta[FLAG_KEY] = {
    description: DESCRIPTION || flagsMeta[FLAG_KEY]?.description || 'No description provided',
    source: SOURCE,
    jiraKeys,
    components,
};

fs.writeFileSync(DATA_PATH, JSON.stringify(flagsMeta, null, 2) + '\n');
console.log(`${isNew ? 'Created' : 'Updated'} metadata for "${FLAG_KEY}": jiraKeys=[${jiraKeys.join(', ')}], components=[${components.join(', ')}]`);