const fs = require('fs');
const path = require('path');
const { fail, safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');

const DATA_PATH = safeRelativePath(process.env.FLAGS_META_PATH || 'docs/data/flags-meta.json', 'FLAGS_META_PATH');
const { FLAG_KEY, DESCRIPTION, SOURCE, JIRA_KEYS, COMPONENTS } = process.env;

if (!FLAG_KEY) {
    fail('Missing FLAG_KEY');
}
if (!SOURCE) {
    fail('Missing SOURCE');
}
if (!['build', 'runtime-be'].includes(SOURCE)) {
    fail(`Invalid SOURCE "${SOURCE}" — must be "build" or "runtime-be"`);
}

const jiraKeys = (JIRA_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const components = (COMPONENTS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!jiraKeys.length) {
    fail('JIRA_KEYS resolved to an empty list — provide at least one, comma-separated');
}
if (!components.length) {
    fail('COMPONENTS resolved to an empty list — provide at least one, comma-separated');
}

const flagsMeta = readJson(DATA_PATH, {});
const isNew = !flagsMeta[FLAG_KEY];

flagsMeta[FLAG_KEY] = {
    description: DESCRIPTION || flagsMeta[FLAG_KEY]?.description || 'No description provided',
    source: SOURCE,
    jiraKeys,
    components,
    createdAt: flagsMeta[FLAG_KEY]?.createdAt || new Date().toISOString(),
};

writeJson(DATA_PATH, flagsMeta);
console.log(`${isNew ? 'Created' : 'Updated'} metadata for "${FLAG_KEY}": jiraKeys=[${jiraKeys.join(', ')}], components=[${components.join(', ')}]`);