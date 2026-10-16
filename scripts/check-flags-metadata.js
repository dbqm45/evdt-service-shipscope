const fs = require('fs');
const { safeRelativePath } = require('./lib/cli');
const { readJson } = require('./lib/json-file');
const { discoverAllFlags } = require('./lib/extract-flags');

const FLAGS_META_PATH = safeRelativePath(
    process.env.FLAGS_META_PATH || 'status-repo/docs/data/flags-meta.json',
    'FLAGS_META_PATH'
);
const SEARCH_ROOT = safeRelativePath(process.env.FLAGS_SEARCH_ROOT || 'domains', 'FLAGS_SEARCH_ROOT');
const STATUS_REPO_URL = process.env.STATUS_REPO_EDIT_URL || 'https://github.com/YOUR_ORG/shipscope-test/edit/main/docs/data/flags-meta.json';
// Opt-in, same spirit as sync-jira.js's JIRA_BOARD_LOOKUP_STRICT but inverted: this check's default
// behavior is already "fail the build", so WARN_ONLY is the opt-in that softens it, not the opt-in that
// hardens it. Meant for a caller repo onboarding its first flags, where every flag is incomplete by
// construction and a hard CI failure would block merging anything until metadata catches up.
const WARN_ONLY = process.env.WARN_ONLY === 'true';

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

    const flagsMeta = readJson(FLAGS_META_PATH);
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
        if (WARN_ONLY) {
            console.warn(`\n::warning::Flag metadata check found ${problems.length} problem(s) (WARN_ONLY — not failing the build):`);
            problems.forEach(p => console.warn('::warning::  - ' + p));
        } else {
            console.error('\n❌ Flag metadata check failed:\n');
            problems.forEach(p => console.error('  - ' + p));
        }
        console.error(
            `\nEvery flag must have a complete entry in flags-meta.json ` +
            `(source, jiraKeys, components)${WARN_ONLY ? '' : ' before merging'}.\n` +
            `Fill it in here: ${STATUS_REPO_URL}\n` +
            `(if this is a brand-new flag, a stub entry should already have been scaffolded for you — see "Scaffold flags-meta" step)\n`
        );
        if (!WARN_ONLY) {
            process.exit(1);
        }
        return;
    }

    console.log(`✅ All ${flags.length} flags have complete metadata.`);
}

main();
