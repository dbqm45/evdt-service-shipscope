const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-release');
const RELEASE = path.join(ROOT, 'scripts', 'release.js');
const NOTES = path.join(ROOT, 'scripts', 'release-notes.js');
const CHECK = path.join(ROOT, 'scripts', 'check-commit-message.js');

const CHANGELOG = '# Changelog\n\nIntro.\n\n## [0.1.0] - 2026-10-16\n\n- First.\n\n## 2026-10-15\n\n- A date entry.\n';
const CHANGELOG_PL = '# Changelog\n\nWstęp.\n\n## [0.1.0] - 2026-10-16\n\n- Pierwsza.\n\n## 2026-10-15\n\n- Wpis z datą.\n';

let seq = 0;

/** A throwaway git repo shaped like ShipScope's release surface, tagged v0.1.0, plus the given commits after it. */
function makeRepo(commits) {
    const dir = path.join(TMP, `repo-${seq++}`);
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.test');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    const write = (file, value) => fs.writeFileSync(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    write('package.json', { name: 'root', version: '0.1.0', private: true });
    write('server/package.json', { name: 'shipscope-server', version: '0.1.0', private: true });
    write('server/package-lock.json', { name: 'shipscope-server', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'shipscope-server', version: '0.1.0' } } });
    write('CHANGELOG.md', CHANGELOG);
    write('CHANGELOG.pl.md', CHANGELOG_PL);
    git('add', '-A');
    git('commit', '-qm', 'chore(release): 0.1.0');
    git('tag', '-a', 'v0.1.0', '-m', 'Release 0.1.0');
    for (const message of commits) git('commit', '-q', '--allow-empty', '-m', message);
    return { dir, git, read: (file) => fs.readFileSync(path.join(dir, file), 'utf8'), json: (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) };
}

const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

before(() => fs.rmSync(TMP, { recursive: true, force: true }));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('release.js', () => {
    it('REL-CI-1: a feat after v0.1.0 sets 0.1.1 everywhere and adds both changelog entries above the old ones', () => {
        const repo = makeRepo(['feat(SHP): invite members (#8)', 'fix(server): reject empty names', 'docs: readme']);
        const res = run(RELEASE, ['--ci'], repo.dir);
        assert.equal(res.status, 0, res.stderr);

        assert.equal(repo.json('package.json').version, '0.1.1');
        assert.equal(repo.json('server/package.json').version, '0.1.1');
        const lock = repo.json('server/package-lock.json');
        assert.equal(lock.version, '0.1.1');
        assert.equal(lock.packages[''].version, '0.1.1');

        const en = repo.read('CHANGELOG.md');
        assert.match(en, /^# Changelog\n\nIntro\.\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- \*\*SHP:\*\* invite members \(#8\)\n\n### Fixed\n\n- \*\*server:\*\* reject empty names\n\n## \[0\.1\.0\]/);
        assert.ok(en.endsWith('## 2026-10-15\n\n- A date entry.\n'), 'older entries untouched');
        assert.match(repo.read('CHANGELOG.pl.md'), /## \[0\.1\.1\][^]*### Nowe[^]*### Poprawione[^]*## \[0\.1\.0\]/);
    });

    it('REL-CI-2: only docs/test/ci commits release nothing and change nothing', () => {
        const repo = makeRepo(['docs: readme', 'ci: workflow', 'test: more']);
        const res = run(RELEASE, ['--ci'], repo.dir);
        assert.equal(res.status, 0, res.stderr);
        assert.match(res.stdout, /nothing to release/);
        assert.equal(repo.git('status', '--porcelain'), '');
    });

    it('REL-CI-3: a breaking change in 0.y.z bumps the minor', () => {
        const repo = makeRepo(['feat(server)!: require a session for /health/db']);
        assert.equal(run(RELEASE, ['--ci'], repo.dir).status, 0);
        assert.equal(repo.json('package.json').version, '0.2.0');
        assert.match(repo.read('CHANGELOG.md'), /### Breaking\n\n- \*\*server:\*\* require a session/);
    });

    it('REL-MAN-1: an explicit version overrides the commits; --dry-run writes nothing', () => {
        const repo = makeRepo(['fix: a']);
        const dry = run(RELEASE, ['1.0.0', '--dry-run'], repo.dir);
        assert.equal(dry.status, 0, dry.stderr);
        assert.match(dry.stdout, /→ 1\.0\.0/);
        assert.equal(repo.git('status', '--porcelain'), '');

        assert.equal(run(RELEASE, ['1.0.0'], repo.dir).status, 0);
        assert.equal(repo.json('server/package.json').version, '1.0.0');
    });

    it('REL-ERR-1: refuses a dirty tree, an untagged package.json version, and an older version', () => {
        const dirty = makeRepo(['fix: a']);
        fs.writeFileSync(path.join(dirty.dir, 'x.txt'), 'x');
        assert.match(run(RELEASE, ['--ci'], dirty.dir).stderr, /uncommitted changes/);

        const untagged = makeRepo([]);
        fs.writeFileSync(path.join(untagged.dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
        untagged.git('commit', '-qam', 'chore(release): 0.2.0');
        assert.match(run(RELEASE, ['--ci'], untagged.dir).stderr, /release v0\.2\.0 first/);

        const older = makeRepo(['fix: a']);
        assert.match(run(RELEASE, ['0.0.9'], older.dir).stderr, /not newer/);
    });
});

describe('release-notes.js and check-commit-message.js', () => {
    it('NOTES-1: prints one version\'s entry, fails without one', () => {
        const repo = makeRepo([]);
        const ok = run(NOTES, ['0.1.0'], repo.dir);
        assert.equal(ok.status, 0);
        assert.equal(ok.stdout, '- First.\n');
        assert.equal(run(NOTES, ['0.9.0'], repo.dir).status, 1);
        assert.equal(run(NOTES, ['latest'], repo.dir).status, 1);
    });

    it('CHECK-1: accepts a Conventional Commit title and rejects a plain one, also from a file (commit-msg hook)', () => {
        assert.equal(run(CHECK, ['feat(SHP): invite members by GitHub login'], ROOT).status, 0);
        const bad = run(CHECK, ['Update user'], ROOT);
        assert.equal(bad.status, 1);
        assert.match(bad.stderr, /Not a Conventional Commit/);

        fs.mkdirSync(TMP, { recursive: true });
        const file = path.join(TMP, 'COMMIT_EDITMSG');
        fs.writeFileSync(file, 'fix: a.\n# comment\n');
        assert.match(run(CHECK, ['--file', file], ROOT).stderr, /period/);
    });
});

describe('repository version', () => {
    it('VER-1: package.json and server/ carry the same X.Y.Z, and both changelogs have its entry', () => {
        const { version } = require('../package.json');
        assert.match(version, /^\d+\.\d+\.\d+$/);
        assert.equal(require('../server/package.json').version, version);
        const lock = require('../server/package-lock.json');
        assert.equal(lock.version, version);
        assert.equal(lock.packages[''].version, version);
        for (const file of ['CHANGELOG.md', 'CHANGELOG.pl.md']) {
            assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').includes(`## [${version}]`), `${file} has ## [${version}]`);
        }
    });
});
