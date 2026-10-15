const fs = require('fs');
const path = require('path');
const { safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');
const { discoverAllFlags } = require('./lib/extract-flags');

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

    const flagsMeta = readJson(FLAGS_META_PATH, {});

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

    writeJson(FLAGS_META_PATH, flagsMeta);
    console.log(`Scaffolded ${added.length} new flag(s): ${added.join(', ')}`);
    console.log('These need jiraKeys/components filled in by a human before the metadata check will pass.');
}

main();