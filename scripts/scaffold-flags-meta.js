const fs = require('fs');
const path = require('path');
const { discoverAllFlags } = require('./lib/extract-flags');

function safeRelativePath(inputPath, label) {
    const normalized = path.normalize(inputPath);

    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        console.error(`Error: ${label} "${inputPath}" is not a safe relative path — refusing to use it.`);
        process.exit(1);
    }

    return normalized;
}

const FLAGS_META_PATH = safeRelativePath(
    process.env.FLAGS_META_PATH || 'status-repo/docs/data/flags-meta.json',
    'FLAGS_META_PATH'
);
const SEARCH_ROOT = safeRelativePath(process.env.FLAGS_SEARCH_ROOT || 'domains', 'FLAGS_SEARCH_ROOT');
const COMPONENT = process.env.COMPONENT || '';

function main() {
    const flags = discoverAllFlags(SEARCH_ROOT);

    if (!flags.length) {
        console.log(`No *.generated.ts files found under "${SEARCH_ROOT}" — nothing to scaffold.`);
        return;
    }

    const flagsMeta = fs.existsSync(FLAGS_META_PATH)
        ? JSON.parse(fs.readFileSync(FLAGS_META_PATH, 'utf8'))
        : {};

    const added = [];

    for (const { key } of flags) {
        if (!flagsMeta[key]) {
            flagsMeta[key] = {
                description: 'TODO — describe this flag',
                source: 'build',
                jiraKeys: [],
                components: COMPONENT ? [COMPONENT] : [],
                createdAt: new Date().toISOString(),
            };
            added.push(key);
        }
    }

    if (!added.length) {
        console.log('No new flags found — flags-meta.json already covers everything.');
        return;
    }

    fs.writeFileSync(FLAGS_META_PATH, JSON.stringify(flagsMeta, null, 2) + '\n');
    console.log(`Scaffolded ${added.length} new flag(s): ${added.join(', ')}`);
    console.log('These need jiraKeys/components filled in by a human before the metadata check will pass.');
}

main();