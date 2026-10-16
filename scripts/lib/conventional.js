// Conventional Commits 1.0.0 and SemVer 2.0.0 helpers shared by check-commit-message.js and release.js.
// No dependencies: the rules are small and spelled out in RELEASING.md. Ported from dbqm45/ci_for_sdlc's
// scripts/lib/conventional.mjs; the differences are marked "ShipScope:".

/** Commit types accepted in this repository (the @commitlint/config-conventional set). */
const TYPES = ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'style', 'build', 'ci', 'chore', 'revert'];
const MAX_SUBJECT = 72;

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?: (?<subject>.*)$/;
// ShipScope: the history uses the uppercase project key as scope ("feat(SHP): ..."), so a scope may be
// uppercase here; ci_for_sdlc requires lowercase.
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: \S/m;
// Messages git or GitHub write on their own; they never reach main as-is (squash merge) and are not linted.
const GENERATED = /^(Merge |Revert "|(fixup|squash|amend)! )/;

const firstLine = (message) => message.split('\n', 1)[0] ?? '';
/** Drops the comment lines git puts into the commit message template. */
const clean = (message) => message.split('\n').filter((l) => !l.startsWith('#')).join('\n').replace(/^\s*\n/, '').trimEnd();

/** Parses the first line; null when it is not `type(scope)!: subject`. */
function parseHeader(header) {
    const m = HEADER.exec(header.trim());
    if (!m?.groups) return null;
    const { type, scope, bang, subject } = m.groups;
    return { type, scope, breaking: Boolean(bang), subject };
}

const isBreaking = (message) => Boolean(parseHeader(firstLine(message))?.breaking) || BREAKING_FOOTER.test(message);

/** Problems with a commit message or PR title; an empty list means it follows Conventional Commits. */
function lintMessage(raw) {
    const message = clean(raw);
    if (!message) return ['the message is empty'];
    const header = firstLine(message);
    if (GENERATED.test(header)) return [];
    const parsed = parseHeader(header);
    if (!parsed) return [`"${header}" is not "<type>(<scope>)!: <description>" — e.g. "fix(SHP): reject an empty tenant name"`];
    const problems = [];
    if (!TYPES.includes(parsed.type)) problems.push(`unknown type "${parsed.type}" — use one of: ${TYPES.join(', ')}`);
    if (parsed.scope !== undefined && !SCOPE.test(parsed.scope)) problems.push(`scope "${parsed.scope}" should be a single word, e.g. SHP, server, deps`);
    const subject = parsed.subject.replace(/ \(#\d+\)$/, ''); // GitHub appends the PR number on squash merge
    if (!subject.trim()) problems.push('the description after ": " is empty');
    if (subject.length > MAX_SUBJECT) problems.push(`the description has ${subject.length} characters (max ${MAX_SUBJECT})`);
    if (/\.$/.test(subject)) problems.push('the description should not end with a period');
    const lines = message.split('\n');
    if (lines.length > 1 && lines[1]?.trim()) problems.push('leave an empty line between the header and the body');
    if (/^breaking[ -]change:/im.test(message) && !BREAKING_FOOTER.test(message)) problems.push('write the footer as "BREAKING CHANGE: <what and how to migrate>" (uppercase)');
    return problems;
}

/** The SemVer bump the commits call for: breaking → major, feat → minor, fix/perf → patch, otherwise none. */
function bumpKind(messages) {
    let kind = null;
    for (const message of messages) {
        if (isBreaking(message)) return 'major';
        const type = parseHeader(firstLine(message))?.type;
        if (type === 'feat') kind = 'minor';
        else if ((type === 'fix' || type === 'perf') && !kind) kind = 'patch';
    }
    return kind;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Plain SemVer bump of X.Y.Z (rule 6–8): major → (X+1).0.0, minor → X.(Y+1).0, patch → X.Y.(Z+1). */
function bump(current, kind) {
    const m = VERSION.exec(current);
    if (!m) throw new Error(`"${current}" is not a release version X.Y.Z`);
    const [major, minor, patch] = m.slice(1).map(Number);
    if (kind === 'major') return `${major + 1}.0.0`;
    if (kind === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

/**
 * Next release version from the commits' bump. In the 0.y.z phase the API is not stable yet (SemVer rule 4):
 * a breaking change bumps the minor and everything else the patch. 1.0.0 is a human decision — never computed.
 */
const nextVersion = (current, kind) =>
    bump(current, current.startsWith('0.') ? (kind === 'major' ? 'minor' : 'patch') : kind);

const isVersion = (v) => VERSION.test(v);

/** Compares X.Y.Z versions: negative, 0 or positive. */
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
}

// ShipScope: CHANGELOG.md is English and CHANGELOG.pl.md its Polish mirror, so the section titles come in both.
const LABELS = {
    en: { breaking: 'Breaking', added: 'Added', fixed: 'Fixed', none: 'No user-visible changes (documentation, tests, CI).' },
    pl: { breaking: 'Niezgodne', added: 'Nowe', fixed: 'Poprawione', none: 'Bez zmian widocznych dla użytkownika (dokumentacja, testy, CI).' },
};

/**
 * A changelog entry (newest on top) built from commits since the last tag.
 *
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @param {string[]} messages full commit messages
 * @param {'en'|'pl'} [lang]
 * @returns {string}
 */
function changelogEntry(version, date, messages, lang = 'en') {
    const labels = LABELS[lang];
    const sections = [
        [labels.breaking, (c) => isBreaking(c.message)],
        [labels.added, (c) => c.type === 'feat'],
        [labels.fixed, (c) => c.type === 'fix' || c.type === 'perf'],
    ];
    const commits = messages.map((message) => ({ message, ...parseHeader(firstLine(message)) }));
    const out = [`## [${version}] - ${date}`, ''];
    const used = new Set();
    for (const [title, match] of sections) {
        const items = commits.filter((c) => c.type && !used.has(c) && match(c));
        if (!items.length) continue;
        items.forEach((c) => used.add(c));
        out.push(`### ${title}`, '', ...items.map((c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}`), '');
    }
    if (used.size === 0) out.push(labels.none, '');
    return out.join('\n');
}

/**
 * Puts an entry above the first `## ` heading. ShipScope: the changelogs also hold hand-written date sections
 * ("## 2026-10-16"), so the entry goes above any level-2 heading, not only a previous `## [X.Y.Z]`.
 */
function insertEntry(changelog, entry) {
    const first = changelog.search(/^## /m);
    if (first < 0) return `${changelog.trimEnd()}\n\n${entry}`;
    return `${changelog.slice(0, first)}${entry}\n${changelog.slice(first)}`;
}

/**
 * The body of the changelog entry for `version` (without its "## [X.Y.Z]" heading), or null if there is none.
 * ShipScope: the entry ends at the next level-2 heading of any kind, so a date section below is not swallowed.
 */
function releaseNotes(changelog, version) {
    const lines = changelog.replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
    if (start < 0) return null;
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    // Link reference definitions ("[0.1.0]: https://…") at the end of the file are not part of the entry.
    const body = lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => !/^\[[^\]]+\]:\s/.test(l));
    return body.join('\n').trim() || null;
}

module.exports = {
    TYPES,
    lintMessage,
    bumpKind,
    bump,
    nextVersion,
    isVersion,
    compareVersions,
    changelogEntry,
    insertEntry,
    releaseNotes,
};
