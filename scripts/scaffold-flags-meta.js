// scripts/scaffold-flags-meta.js
//
// Discovers all boolean flags across *-flags.ts interfaces, and for any flag
// not yet present in flags-meta.json, adds a stub entry with empty
// jiraKeys/components. Does NOT guess those values — that's a human decision.
// The metadata check (check-flags-metadata.js) will still fail on these
// stubs until someone fills them in; this script just removes the busywork
// of typing out the JSON structure by hand.

const fs = require('fs');
const { discoverAllFlags } = require('./lib/extract-flags');

const FLAGS_META_PATH = process.env.FLAGS_META_PATH || 'status-repo/docs/data/flags-meta.json';
const SEARCH_ROOT = process.env.FLAGS_SEARCH_ROOT || 'domains';

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
                source: 'build', // adjust to "runtime-be" if this flag can change without a FE deploy
                jiraKeys: [],
                components: [],
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