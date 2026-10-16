const path = require('path');
const { safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');
const { execFileSync } = require('child_process');

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
        // null, not {}: the caller must be able to tell "unreadable at this commit" (a deletion commit, a
        // malformed file) apart from "empty" — treating it as empty made the *next* commit look like every
        // flag/env/source had just flipped.
        return null;
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

// Truncated to the calendar day, not the exact timestamp — found and fixed as a real bug: this used to
// compare `changedAt` exactly, but the same real-world flip gets two genuinely different timestamps
// depending on which source recorded it. Live logging (resolve-all-flag-states.js/
// sync-runtime-be-flags.js/update-flag-state.js) stamps `changedAt` from wall-clock `now()` at write time;
// this script stamps it from the git commit's *author* date instead (see `commitsTouchingFile`) — for the
// exact same flip, those two will almost never match to the second, so re-running this backfill over a
// period live logging already fully covers produced genuine, undetected duplicate entries. Truncating to
// the day is a deliberate trade-off: it can't tell apart two *genuinely different* flips back to the same
// `enabled` value on the same calendar day (a real but narrow edge case — rapid, same-day flapping,
// specifically only during a backfill re-run) from one real flip logged twice, but that's an acceptable
// cost for a one-off forensic recovery tool, not something live logging (which has no such date-source
// ambiguity at all) needs to guard against.
function dedupeKey(entry) {
    const day = (entry.changedAt || '').slice(0, 10);

    return `${entry.key}|${entry.env}|${entry.source}|${entry.enabled}|${day}`;
}

function main() {
    const commits = commitsTouchingFile(FLAG_STATES_PATH);

    if (!commits.length) {
        console.log(`No commits found touching ${FLAG_STATES_PATH} — nothing to backfill.`);
        return;
    }

    const existingHistory = readJson(FLAG_STATE_HISTORY_PATH, []);
    const seen = new Set(existingHistory.map(dedupeKey));

    let before = {};
    const minedEntries = [];

    for (const { sha, date } of commits) {
        const after = fileAtCommit(sha, FLAG_STATES_PATH);

        if (after === null) {
            console.warn(`Skipping ${sha.slice(0, 7)} — ${FLAG_STATES_PATH} is missing or unreadable at that commit.`);
            continue;
        }

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

    writeJson(FLAG_STATE_HISTORY_PATH, merged);
    console.log(`Backfilled ${minedEntries.length} historical flag change(s) from ${commits.length} commit(s) touching ${FLAG_STATES_PATH}.`);
}

if (require.main === module) {
    main();
}
