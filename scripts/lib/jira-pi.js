// Pure PI / sprint parsing helpers — no I/O, no env, safe to unit test directly.

function extractPiFromSprintName(sprintName) {
    if (!sprintName) {
        return null;
    }

    const match = sprintName.match(/(\d+\.\d+)\.\d+/);

    return match ? `PI-${match[1]}` : null;
}

/**
 * A Jira label naming a PI — accepts both the plain form (`PI-27.3`) and the sprint-suffixed form
 * (`PI-27.3.1`, where the trailing `.1` names a sprint within that PI, same convention as a sprint's own
 * name). Either way, only the leading `PI-X.Y` portion is ever used as `pi` here — a label's trailing
 * sprint digit, when present, isn't a reliable source for which sprint an issue is actually in (the Sprint
 * field itself is: labels get added once and often not kept in sync as an issue moves sprints within the
 * same PI), so it's deliberately discarded rather than treated as a second source of truth for `sprint`.
 */
function extractPiFromLabel(label) {
    const match = label.match(/^PI-?(\d+\.\d+)(?:\.\d+)?$/i);

    return match ? `PI-${match[1]}` : null;
}

/**
 * `allowedBoardNames` (board names configured for the issue's own space in `docs/jira-spaces.json`,
 * e.g. `["Sparks"]`) scopes which sprint entries are even eligible to be picked, matched as a
 * case-insensitive prefix of the sprint's own name (e.g. "Sparks 27.3.1" matches board "Sparks"; "Rocket
 * 27.3.2" doesn't). An issue can carry sprints from more than one team's board across its history (a
 * shared Epic bouncing between teams, a sub-task reassigned mid-flight) — without this, the "no active
 * sprint, fall back to the last one in the list" rule below could just as easily land on a *different*
 * team's sprint, extracting a PI/sprint that has nothing to do with the board this sync is actually
 * tracking. Empty/missing `allowedBoardNames` (a space with no `boards` configured) applies no filtering
 * at all, preserving the exact prior behavior for that space. If no sprint matches, returns `null` — same
 * as "no sprint field data" — so the caller falls through to a label-derived PI, or drops the issue, same
 * as today.
 */
function pickRelevantSprintInfo(sprintFieldValue, allowedBoardNames) {
    if (!sprintFieldValue) {
        return null;
    }

    const list = Array.isArray(sprintFieldValue) ? sprintFieldValue : [sprintFieldValue];

    if (!list.length) {
        return null;
    }

    let parsed = list.map(entry => {
        if (typeof entry === 'string') {
            const field = key => {
                const m = entry.match(new RegExp(`${key}=([^,\\]]+)`));

                return m && m[1] !== '<null>' ? m[1] : null;
            };

            // `id` (the real Jira sprint ID) wasn't previously captured here — needed so
            // fetchAndMapIssuesForJql can tell whether an issue's own resolved sprint is actually one of
            // the sprint IDs the current-PI query scoped to via `sprint in (...)`, vs. one that only
            // matched via the query's separate `labels =` clause (see that function's "label-only" check).
            return { id: field('id'), name: field('name'), state: field('state'), startDate: field('startDate'), endDate: field('endDate') };
        }

        return { id: entry.id != null ? String(entry.id) : null, name: entry.name, state: entry.state, startDate: entry.startDate || null, endDate: entry.endDate || null };
    }).filter(s => s.name);

    if (allowedBoardNames && allowedBoardNames.length) {
        parsed = parsed.filter(s => allowedBoardNames.some(board => matchesBoardPrefix(s.name, board)));
    }

    if (!parsed.length) {
        return null;
    }

    const active = parsed.find(s => (s.state || '').toLowerCase() === 'active');

    return active || parsed[parsed.length - 1];
}

/**
 * A sprint-name/board-name prefix match that requires a word boundary right after the board name, not just
 * any substring match — found and fixed as a real bug: a plain `startsWith` let board "Spark" wrongly
 * match sprint "Sparkle 27.3.1" (an unrelated team's sprint that merely starts with the same letters).
 * Matches when the sprint name equals the board name exactly, or the character right after the board-name
 * prefix is not itself a letter/digit (so "Sparks 27.3.1" matches board "Sparks", "Sparkle 27.3.1" doesn't).
 */
function matchesBoardPrefix(sprintName, boardName) {
    if (!sprintName.toLowerCase().startsWith(boardName.toLowerCase())) {
        return false;
    }

    const nextChar = sprintName.charAt(boardName.length);

    return nextChar === '' || !/[a-z0-9]/i.test(nextChar);
}

/** Sorts PI labels ("PI-27.3") or sprint labels descending (newest first) by every embedded number, left
 *  to right — the same convention `docs/app.js`'s own `compareVersionDesc` already uses client-side, kept
 *  in sync here since `main()` now needs to pre-sort PI entries for `index.json` itself. */
function comparePiDesc(a, b) {
    const numsOf = s => (s.match(/\d+/g) || []).map(Number);
    const na = numsOf(a);
    const nb = numsOf(b);
    const len = Math.max(na.length, nb.length);

    for (let i = 0; i < len; i++) {
        const diff = (nb[i] || 0) - (na[i] || 0);

        if (diff) {
            return diff;
        }
    }

    return 0;
}

/** Keeps a PI label usable as a filename across every OS this might run on (and defends against a
 *  pathologically weird PI/label string ever escaping `JIRA_ISSUES_DIR`) — same defensive spirit as
 *  `safeRelativePath`, just for a path *segment* rather than a whole path. */
function safeFileSlug(value) {
    return String(value).replace(/[^A-Za-z0-9.-]/g, '_');
}

module.exports = {
    extractPiFromSprintName,
    extractPiFromLabel,
    pickRelevantSprintInfo,
    matchesBoardPrefix,
    comparePiDesc,
    safeFileSlug,
};
