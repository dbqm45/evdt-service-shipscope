#!/usr/bin/env node
// Checks a commit message or a PR title against Conventional Commits (RELEASING.md).
//   node scripts/check-commit-message.js "feat(SHP): invite members by GitHub login"   # a title
//   node scripts/check-commit-message.js --file .git/COMMIT_EDITMSG                    # the commit-msg hook
const fs = require('fs');
const { lintMessage, TYPES } = require('./lib/conventional');

const args = process.argv.slice(2);
const fileAt = args.indexOf('--file');
const message = fileAt >= 0 ? fs.readFileSync(args[fileAt + 1] ?? '', 'utf8') : args.join(' ');

const problems = lintMessage(message);
if (problems.length) {
    console.error(`✗ Not a Conventional Commit:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.error(`\n  Format: <type>(<scope>)!: <description>   types: ${TYPES.join(', ')}`);
    console.error('  Example: feat(SHP): invite members by GitHub login   (see RELEASING.md)');
    process.exit(1);
}
console.log('✓ Conventional Commit');
