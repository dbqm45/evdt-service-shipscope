// scripts/check-flags-metadata.js
//
// Fails the build if any boolean flag found in a *.generated.ts file
// (per domain) is missing a complete entry in flags-meta.json.
//
// Usage in CI:
//   node scripts/check-flags-metadata.js

const fs = require('fs');
const { discoverAllFlags } = require('./lib/extract-flags');

const FLAGS_META_PATH = process.env.FLAGS_META_PATH || 'status-repo/docs/data/flags-meta.json';
const SEARCH_ROOT = process.env.FLAGS_SEARCH_ROOT || 'domains';
const STATUS_REPO_URL = process.env.STATUS_REPO_EDIT_URL || 'https://github.com/YOUR_ORG/shipscope-test/edit/main/docs/data/flags-meta.json';

function main() {
    const flags = discoverAllFlags(SEARCH_ROOT);

    if (!flags.length) {
        console.log(`No *.generated.ts files found under "${SEARCH_ROOT}" — nothing to check.`);
        return;
    }

    if (!fs.existsSync(FLAGS_META_PATH)) {
        console.error(`Could not find flags-meta.json at "${FLAGS_META_PATH}". Did the status-repo checkout step run?`);
        process.exit(1);
    }
    const flagsMeta = JSON.parse(fs.readFileSync(FLAGS_META_PATH, 'utf8'));

    const problems = [];
    for (const { key, file } of flags) {
        const meta = flagsMeta[key];
        if (!meta) {
            problems.push(`"${key}" (found in ${file}) — missing entirely from flags-meta.json`);
        } else if (!Array.isArray(meta.jiraKeys) || meta.jiraKeys.length === 0) {
            problems.push(`"${key}" (found in ${file}) — present in flags-meta.json but "jiraKeys" is empty`);
        } else if (!Array.isArray(meta.components) || meta.components.length === 0) {
            problems.push(`"${key}" (found in ${file}) — present in flags-meta.json but "components" is empty`);
        } else if (!meta.source) {
            problems.push(`"${key}" (found in ${file}) — missing "source" (build | runtime-be)`);
        }
    }

    if (problems.length) {
        console.error('\n❌ Flag metadata check failed:\n');
        problems.forEach(p => console.error('  - ' + p));
        console.error(
            `\nEvery flag must have a complete entry in flags-meta.json ` +
            `(source, jiraKeys, components) before merging.\n` +
            `Fill it in here: ${STATUS_REPO_URL}\n` +
            `(if this is a brand-new flag, a stub entry should already have been scaffolded for you — see "Scaffold flags-meta" step)\n`
        );
        process.exit(1);
    }

    console.log(`✅ All ${flags.length} flags have complete metadata.`);
}

main();