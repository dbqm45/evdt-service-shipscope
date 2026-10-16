#!/usr/bin/env node
// Prints the release notes of a version: its CHANGELOG.md entry, used as the GitHub Release body (RELEASING.md).
//   node scripts/release-notes.js 0.2.0 > notes.md
const fs = require('fs');
const { isVersion, releaseNotes } = require('./lib/conventional');

const version = process.argv[2] ?? '';
if (!isVersion(version)) {
    console.error(`✗ "${version}" is not X.Y.Z`);
    process.exit(1);
}
const notes = releaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), version);
if (!notes) {
    console.error(`✗ CHANGELOG.md has no entry "## [${version}]"`);
    process.exit(1);
}
console.log(notes);
