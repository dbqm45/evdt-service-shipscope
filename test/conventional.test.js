const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    bump, bumpKind, changelogEntry, compareVersions, insertEntry, lintMessage, nextVersion, releaseNotes,
} = require('../scripts/lib/conventional');

// Expected values come from Conventional Commits 1.0.0 and SemVer 2.0.0 (RELEASING.md). Ported from
// dbqm45/ci_for_sdlc's scripts/lib/conventional.test.mjs; ShipScope-specific cases are marked.

describe('CC: lintMessage', () => {
    for (const ok of [
        'feat(web): zoom the context graph',
        'fix: reject an empty answer',
        'feat(server)!: drop the legacy settings format',
        'build(deps-dev): Bump vitest from 5.0.3 to 5.1.0',
        'ci(deps): bump the actions group with 6 updates (#13)',
        'chore(release): 0.2.0',
        'fix(server): handle IAM roles\n\nThe SDK resolves them lazily.\n\nRefs: #20',
        'refactor(core): rename blockade state\n\nBREAKING CHANGE: ResourceDto.isReserved removed; read blockade.state',
        'Merge branch \'main\' into feature',
        'fixup! feat(web): zoom',
        '# Please enter the commit message\nfeat(web): zoom the graph\n# Lines starting with # are ignored',
        // ShipScope: the project key as an uppercase scope, as in the existing history.
        'feat(SHP): GitHub sign-in, sessions and tenant-scoped HTTP routes (FR-001)',
        'fix(SHP): Restore walking-skeleton backend lost by revert-then-merge (#6)',
    ]) it(`CC-OK: ${JSON.stringify(ok.split('\n')[0])}`, () => assert.deepEqual(lintMessage(ok), []));

    for (const [bad, why] of [
        ['Czytelniejszy graf kontekstu', /not "<type>/],
        ['feature(web): zoom', /unknown type "feature"/],
        ['Feat(web): zoom', /not "<type>/],
        ['feat(my scope): zoom', /scope "my scope"/],
        ['feat(-x): zoom', /scope "-x"/],
        ['feat(web):zoom', /not "<type>/],
        ['feat(web): ', /empty/],
        ['fix: add the thing.', /period/],
        [`feat: ${'x'.repeat(73)}`, /73 characters/],
        ['fix: a\nbody without a blank line', /empty line/],
        ['fix: a\n\nbreaking change: lowercase footer', /uppercase/],
        ['', /empty/],
        ['Remove scheduled trigger from sync-jira workflow', /not "<type>/],
    ]) it(`CC-BAD: ${JSON.stringify(bad)}`, () => assert.match(lintMessage(bad).join('\n'), why));

    it('CC-LEN: 72 characters is the limit and the "(#NN)" GitHub adds does not count', () => {
        assert.deepEqual(lintMessage(`feat: ${'x'.repeat(72)} (#123)`), []);
    });
});

describe('SV: bump and next version', () => {
    it('SV-01: bumpKind takes the most serious change', () => {
        assert.equal(bumpKind(['docs: readme', 'test: more']), null);
        assert.equal(bumpKind(['fix: a', 'perf: b']), 'patch');
        assert.equal(bumpKind(['fix: a', 'feat: b', 'chore: c']), 'minor');
        assert.equal(bumpKind(['feat: b', 'fix(x)!: a']), 'major');
        assert.equal(bumpKind(['refactor: a\n\nBREAKING CHANGE: gone']), 'major');
        assert.equal(bumpKind(['refactor: a\n\nBREAKING-CHANGE: gone']), 'major');
    });

    it('SV-02: plain bumps reset the lower parts (rules 7, 8)', () => {
        assert.equal(bump('1.4.2', 'major'), '2.0.0');
        assert.equal(bump('1.4.2', 'minor'), '1.5.0');
        assert.equal(bump('1.4.2', 'patch'), '1.4.3');
        assert.equal(bump('0.9.3', 'major'), '1.0.0');
        assert.throws(() => bump('1.0.0-rc.1', 'patch'));
    });

    it('SV-03: from 1.0.0 the commits map straight onto the version', () => {
        assert.equal(nextVersion('1.4.2', 'major'), '2.0.0');
        assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0');
        assert.equal(nextVersion('1.4.2', 'patch'), '1.4.3');
    });

    it('SV-04: in 0.y.z a breaking change bumps the minor, everything else the patch (rule 4)', () => {
        assert.equal(nextVersion('0.1.0', 'major'), '0.2.0');
        assert.equal(nextVersion('0.1.0', 'minor'), '0.1.1');
        assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
    });

    it('SV-05: versions compare numerically, not as text', () => {
        assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
        assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
    });
});

describe('CL: changelogEntry', () => {
    const commits = [
        'feat(web): zoom the context graph (#21)',
        'fix(server): recognise IAM roles (#20)',
        'feat(server)!: drop the legacy settings format',
        'docs: readme',
        'Czytelniejszy graf',
    ];

    it('CL-01: groups user-visible commits under English sections and skips the rest', () => {
        assert.equal(changelogEntry('0.2.0', '2026-10-06', commits), [
            '## [0.2.0] - 2026-10-06', '',
            '### Breaking', '', '- **server:** drop the legacy settings format', '',
            '### Added', '', '- **web:** zoom the context graph (#21)', '',
            '### Fixed', '', '- **server:** recognise IAM roles (#20)', '',
        ].join('\n'));
    });

    it('CL-01-PL: the same entry with Polish sections for CHANGELOG.pl.md (ShipScope)', () => {
        assert.equal(changelogEntry('0.2.0', '2026-10-06', commits, 'pl'), [
            '## [0.2.0] - 2026-10-06', '',
            '### Niezgodne', '', '- **server:** drop the legacy settings format', '',
            '### Nowe', '', '- **web:** zoom the context graph (#21)', '',
            '### Poprawione', '', '- **server:** recognise IAM roles (#20)', '',
        ].join('\n'));
    });

    it('CL-02: an entry without user-visible changes says so', () => {
        assert.match(changelogEntry('0.1.1', '2026-10-06', ['ci: x']), /No user-visible changes/);
        assert.match(changelogEntry('0.1.1', '2026-10-06', ['ci: x'], 'pl'), /Bez zmian widocznych/);
    });
});

describe('IN: insertEntry (ShipScope: changelogs also hold date sections)', () => {
    const entry = '## [0.2.0] - 2026-10-20\n\n### Added\n\n- x\n';

    it('IN-1: goes above the first level-2 heading, whether a version or a date', () => {
        assert.equal(insertEntry('# Changelog\n\nIntro.\n\n## 2026-10-16\n\n- a\n', entry),
            '# Changelog\n\nIntro.\n\n## [0.2.0] - 2026-10-20\n\n### Added\n\n- x\n\n## 2026-10-16\n\n- a\n');
        assert.equal(insertEntry('# C\n\n## [0.1.0] - 2026-10-16\n\n- a\n', entry),
            '# C\n\n## [0.2.0] - 2026-10-20\n\n### Added\n\n- x\n\n## [0.1.0] - 2026-10-16\n\n- a\n');
    });

    it('IN-2: a changelog without entries gets it appended', () => {
        assert.equal(insertEntry('# Changelog\n', entry), `# Changelog\n\n${entry}`);
    });
});

describe('releaseNotes: changelog entry of one version', () => {
    const changelog = [
        '# Changelog', '', 'Intro.', '',
        '## [0.2.0] - 2026-10-10', '', '### Added', '', '- **web:** zoom', '',
        '## [0.1.0] - 2026-10-06', '', 'First version.', '', '### Added', '', '- MVP', '',
        '## 2026-10-05', '', '- an older, date-only entry', '',
        '[0.2.0]: https://example.test/v0.2.0',
    ].join('\n');

    it('REL-1: the newest entry stops before the next heading', () =>
        assert.equal(releaseNotes(changelog, '0.2.0'), '### Added\n\n- **web:** zoom'));
    it('REL-2: an entry stops before a date section too (ShipScope)', () =>
        assert.equal(releaseNotes(changelog, '0.1.0'), 'First version.\n\n### Added\n\n- MVP'));
    it('REL-3: a missing version gives null', () => assert.equal(releaseNotes(changelog, '0.3.0'), null));
    it('REL-4: a prefix of another version does not match', () => assert.equal(releaseNotes(changelog, '0.2'), null));
    it('REL-5: CRLF line endings', () =>
        assert.equal(releaseNotes(changelog.replace(/\n/g, '\r\n'), '0.2.0'), '### Added\n\n- **web:** zoom'));
    it('REL-6: the last entry leaves out link definitions', () =>
        assert.equal(releaseNotes('# C\n\n## [0.1.0] - 2026-10-06\n\n- MVP\n\n[0.1.0]: https://example.test', '0.1.0'), '- MVP'));
});
