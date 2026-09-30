const fs = require('fs');
const path = require('path');

function safeRelativePath(inputPath, label) {
    const normalized = path.normalize(inputPath);

    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        console.error(`Error: ${label} "${inputPath}" is not a safe relative path — refusing to use it.`);
        process.exit(1);
    }

    return normalized;
}

const DATA_PATH = safeRelativePath(process.env.FLAGS_META_PATH || 'docs/data/flags-meta.json', 'FLAGS_META_PATH');
const { FLAG_KEY, DESCRIPTION, SOURCE, JIRA_KEYS, COMPONENTS } = process.env;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

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

const flagsMeta = fs.existsSync(DATA_PATH) ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) : {};
const isNew = !flagsMeta[FLAG_KEY];

flagsMeta[FLAG_KEY] = {
    description: DESCRIPTION || flagsMeta[FLAG_KEY]?.description || 'No description provided',
    source: SOURCE,
    jiraKeys,
    components,
    createdAt: flagsMeta[FLAG_KEY]?.createdAt || new Date().toISOString(),
};

fs.writeFileSync(DATA_PATH, JSON.stringify(flagsMeta, null, 2) + '\n');
console.log(`${isNew ? 'Created' : 'Updated'} metadata for "${FLAG_KEY}": jiraKeys=[${jiraKeys.join(', ')}], components=[${components.join(', ')}]`);