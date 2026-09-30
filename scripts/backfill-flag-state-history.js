const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function safeRelativePath(inputPath, label) {
    const normalized = path.normalize(inputPath);

    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        fail(`${label} "${inputPath}" is not a safe relative path — refusing to use it.`);
    }

    return normalized;
}

function toGitPath(inputPath) {
    return inputPath.split(path.sep).join('/');
}

// Git's tree paths always use forward slashes regardless of OS — path.normalize() above would turn
// this into a backslash path on Windows, which `git show <sha>:<path>` rejects outright.
const FLAG_STATES_PATH = toGitPath(safeRelativePath(process.env.FLAG_STATES_PATH || 'docs/data/flag-states.json', 'FLAG_STATES_PATH'));
const FLAG_STATE_HISTORY_PATH = safeRelativePath(
    process.env.FLAG_STATE_HISTORY_PATH || 'docs/data/flag-state-history.json',
    'FLAG_STATE_HISTORY_PATH'
);
const UNKNOWN_ACTOR = 'unknown (backfilled from git history)';

/** One-off, requires a full (non-shallow) checkout — needs the whole commit history for this file. */
function commitsTouchingFile(filePath) {
    const output = execFileSync('git', ['log', '--format=%H|%aI', '--follow', '--reverse', '--', filePath], {
        encoding: 'utf8',
    });

    return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
            const [sha, date] = line.split('|');

            return { sha, date };
        });
}

function fileAtCommit(sha, filePath) {
    try {
        const content = execFileSync('git', ['show', `${sha}:${filePath}`], { encoding: 'utf8' });

        return JSON.parse(content);
    } catch (e) {
        return {};
    }
}

/** Same "did the value actually change" semantics as resolve-all-flag-states.js/sync-runtime-be-flags.js. */
function diffFlagStates(before, after, changedAt) {
    const entries = [];

    for (const [key, envMap] of Object.entries(after || {})) {
        for (const [env, sources] of Object.entries(envMap || {})) {
            for (const [source, entry] of Object.entries(sources || {})) {
                if (!entry || typeof entry.enabled !== 'boolean') {
                    continue;
                }

                const previous = before?.[key]?.[env]?.[source];

                if (!previous || previous.enabled !== entry.enabled) {
                    entries.push({ key, env, source, enabled: entry.enabled, changedAt, changedBy: UNKNOWN_ACTOR });
                }
            }
        }
    }

    return entries;
}

function dedupeKey(entry) {
    return `${entry.key}|${entry.env}|${entry.source}|${entry.enabled}|${entry.changedAt}`;
}

function main() {
    const commits = commitsTouchingFile(FLAG_STATES_PATH);

    if (!commits.length) {
        console.log(`No commits found touching ${FLAG_STATES_PATH} — nothing to backfill.`);
        return;
    }

    const existingHistory = fs.existsSync(FLAG_STATE_HISTORY_PATH)
        ? JSON.parse(fs.readFileSync(FLAG_STATE_HISTORY_PATH, 'utf8'))
        : [];
    const seen = new Set(existingHistory.map(dedupeKey));

    let before = {};
    const minedEntries = [];

    for (const { sha, date } of commits) {
        const after = fileAtCommit(sha, FLAG_STATES_PATH);

        for (const entry of diffFlagStates(before, after, date)) {
            const key = dedupeKey(entry);

            if (!seen.has(key)) {
                minedEntries.push(entry);
                seen.add(key);
            }
        }

        before = after;
    }

    if (!minedEntries.length) {
        console.log(`Checked ${commits.length} commit(s) touching ${FLAG_STATES_PATH} — nothing new to backfill.`);
        return;
    }

    const merged = [...existingHistory, ...minedEntries].sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));

    fs.writeFileSync(FLAG_STATE_HISTORY_PATH, JSON.stringify(merged, null, 2) + '\n');
    console.log(`Backfilled ${minedEntries.length} historical flag change(s) from ${commits.length} commit(s) touching ${FLAG_STATES_PATH}.`);
}

module.exports = { diffFlagStates, dedupeKey };

if (require.main === module) {
    main();
}