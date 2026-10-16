#!/usr/bin/env node
// Prepares a release on the current branch: computes the next SemVer version from Conventional Commits since
// the last tag vX.Y.Z, sets it in every package.json (and server/'s lockfile) and adds an entry to CHANGELOG.md
// and CHANGELOG.pl.md. It does not commit, tag or push: on main the Release workflow runs it with --ci after every
// merge, commits "chore(release): X.Y.Z" and tags it (RELEASING.md). Run from the repository root.
//   npm run release                    # version from the commits
//   npm run release -- minor           # override: major | minor | patch | X.Y.Z (1.0.0 is always explicit)
//   npm run release -- --dry-run       # only print what would happen
//   npm run release -- --ci            # Release workflow on main: nothing to release is not an error, no hints
const { execFileSync } = require('child_process');
const fs = require('fs');
const { readJson, writeJson } = require('./lib/json-file');
const { bump, bumpKind, changelogEntry, compareVersions, insertEntry, isVersion, nextVersion } = require('./lib/conventional');

// One version for the whole application: server/ deploys on its own (rootDir: server), so it carries the
// number itself instead of reading the root package.json.
const PACKAGE_FILES = ['package.json', 'server/package.json'];
const LOCK_FILE = 'server/package-lock.json';
const CHANGELOGS = [['CHANGELOG.md', 'en'], ['CHANGELOG.pl.md', 'pl']];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const ci = args.includes('--ci');
const wanted = args.find((a) => !a.startsWith('--'));

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!dryRun && git('status', '--porcelain')) fail('the working tree has uncommitted changes — commit or stash them first');

const current = readJson('package.json').version;
const tags = git('tag', '--list', 'v*').split('\n').map((t) => t.slice(1)).filter(isVersion).sort(compareVersions);
const last = tags.at(-1);
if (!last) fail(`no tag vX.Y.Z yet — the first one (v${current}) is created on main by the Release workflow`);
if (last !== current) fail(`package.json has ${current}, the last tag is v${last} — release v${current} first (merge its PR)`);

const log = git('log', '--format=%B%x00', `v${last}..HEAD`);
const messages = log.split('\0').map((m) => m.trim()).filter(Boolean);
const kind = bumpKind(messages);

let version;
if (!wanted) {
    if (!kind && ci) {
        console.log(`No feat/fix/perf or breaking change since v${last} — nothing to release`);
        process.exit(0);
    }
    if (!kind) fail(`no feat/fix/perf or breaking change since v${last} — nothing to release (pass a version to force one)`);
    version = nextVersion(current, kind);
} else if (['major', 'minor', 'patch'].includes(wanted)) {
    version = bump(current, wanted); // explicit: `major` on 0.y.z gives 1.0.0
} else if (isVersion(wanted)) {
    version = wanted;
} else fail(`"${wanted}" is neither major/minor/patch nor X.Y.Z`);
if (compareVersions(version, current) <= 0) fail(`${version} is not newer than ${current}`);

const date = new Date().toISOString().slice(0, 10);
const entry = changelogEntry(version, date, messages, 'en');
console.log(`${messages.length} commit(s) since v${last}${kind ? ` call for a ${kind} change` : ''} → ${version}\n\n${entry}`);
if (dryRun) process.exit(0);

for (const file of PACKAGE_FILES) {
    writeJson(file, { ...readJson(file), version });
}
const lock = readJson(LOCK_FILE);
lock.version = version;
if (lock.packages?.['']) lock.packages[''].version = version;
writeJson(LOCK_FILE, lock);

for (const [file, lang] of CHANGELOGS) {
    fs.writeFileSync(file, insertEntry(fs.readFileSync(file, 'utf8'), changelogEntry(version, date, messages, lang)));
}

if (ci) {
    console.log(`✓ Version ${version} is set`);
    process.exit(0);
}
console.log(`
✓ Version ${version} is set. Next:
  1. Review CHANGELOG.md and CHANGELOG.pl.md (reword entries for users if needed).
  2. git switch -c release/v${version} && git commit -am "chore(release): ${version}"
  3. Push and open the PR "chore(release): ${version}". After the merge the Release workflow tags v${version}.`);
