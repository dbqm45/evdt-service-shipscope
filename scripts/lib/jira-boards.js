const { fetchWithRetry } = require('./jira-api');
const { JIRA_BASE_URL, JIRA_BOARD_LOOKUP_STRICT } = require('./jira-config');
const { extractPiFromSprintName } = require('./jira-pi');

/**
 * Only ever thrown when `JIRA_BOARD_LOOKUP_STRICT=true` (see that constant) — a board/active-sprint call
 * that failed to successfully complete at all: any non-2xx HTTP response (401/403 — the Jira account
 * can't even ask the question; 429 — rate-limited; 5xx — Jira's own problem; anything else non-2xx, since
 * this endpoint has no legitimate "soft" failure status of its own — a zero/ambiguous match is a
 * *successful* response, handled separately, not an HTTP failure) or a raw network-level exception
 * (`fetch()` itself throwing — timeout, DNS failure, connection reset, no `res` at all). When thrown,
 * `resolveCurrentPiForSpaces()` and `main()` both re-throw this specific type instead of swallowing it,
 * exactly the same reasoning `resolveSpacesConfig()` already applies to its own project-list fetch:
 * silently degrading ANY failed call into "no board info" routes `main()` into `runFullScopeMode()`'s
 * destructive `'full'` scope — which deletes/overwrites PI data — instead of just failing the run for
 * `sync-with-retry`'s retry loop (or the daily cron) to recover from transparently. The strict mode this
 * class is now gated behind defaults *off* after its first real-world trigger turned out to be a `401` with
 * an unclear root cause (see `JIRA_BOARD_LOOKUP_STRICT`'s own comment) — soft-degrading is the safer
 * default until that's understood, even though it reintroduces the destructive-fallback risk this class
 * was built to close.
 */
class JiraBoardLookupError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'JiraBoardLookupError';
        this.status = status;
    }
}

/**
 * Resolves a board's display name to its numeric ID via the Jira Agile API — there's no other way to look
 * up a board's sprints (see `fetchAllSprintsForBoard`) starting only from the name a human configured
 * in `docs/jira-spaces.json`. Jira's `name` filter on this endpoint does a fuzzy/partial, case-insensitive
 * match, so every candidate is still checked for an exact (case-insensitive) name match before being
 * trusted — same "warn and skip rather than silently pick the wrong one" pattern as
 * `filterExistingProjectKeys`. Any failure to even get a successful response — network-level exception or
 * non-2xx status — throws `JiraBoardLookupError`; only a successful response that legitimately matches
 * zero or more-than-one board degrades softly (warn + `null`).
 */
async function resolveBoardId(boardName, headers) {
    let res;

    try {
        res = await fetchWithRetry(
            `${JIRA_BASE_URL}/rest/agile/1.0/board?name=${encodeURIComponent(boardName)}&maxResults=50`,
            { headers }
        );
    } catch (e) {
        if (JIRA_BOARD_LOOKUP_STRICT) {
            throw new JiraBoardLookupError(`Board lookup for "${boardName}" failed: ${e.message}`, null);
        }

        console.warn(`Warning: could not look up board "${boardName}" (${e.message}) — skipping its current-PI fetch.`);
        return null;
    }

    if (!res.ok) {
        if (JIRA_BOARD_LOOKUP_STRICT) {
            throw new JiraBoardLookupError(`Board lookup for "${boardName}" failed with HTTP ${res.status}`, res.status);
        }

        const hint = res.status === 401
            ? ' — likely a Jira Software/Agile API access or scope issue on the configured account; see ONBOARDING.md\'s Jira section.'
            : '';
        console.warn(`Warning: could not look up board "${boardName}" (${res.status}) — skipping its current-PI fetch.${hint}`);
        return null;
    }

    const data = await res.json();
    const matches = (data.values || []).filter(b => (b.name || '').toLowerCase() === boardName.toLowerCase());

    if (!matches.length) {
        console.warn(`Warning: no board named "${boardName}" found in Jira — skipping its current-PI fetch.`);
        return null;
    }

    if (matches.length > 1) {
        console.warn(`Warning: more than one board named "${boardName}" found in Jira — skipping its current-PI fetch (ambiguous).`);
        return null;
    }

    return matches[0].id;
}

/**
 * Every sprint on a board, any state (active/future/closed) — needed because a PI spans several sprints
 * (e.g. "27.3.1", "27.3.2", "27.3.3" for PI 27.3), not just whichever one is active right now, and the
 * Sprint field's JQL support (`=`/`!=`/`IN`/`NOT IN`/`IS`/`IS NOT` only — no `~`/CONTAINS) means the only
 * way to scope a query to "every sprint in this PI" is `sprint in (id1, id2, …)` with real sprint IDs, not
 * a name-based fuzzy match. Paginated via `startAt` (the Agile API's own pagination shape, distinct from
 * `fetchAndMapIssuesForJql`'s `nextPageToken`-based one). Same failure contract as `resolveBoardId`: a
 * network-level exception or non-2xx status throws `JiraBoardLookupError` only in strict mode; an
 * empty-but-successful result (or any failure outside strict mode) degrades softly (warn + `[]`).
 */
async function fetchAllSprintsForBoard(boardId, headers) {
    const sprints = [];
    let startAt = 0;
    let isLast = false;

    while (!isLast) {
        let res;

        try {
            res = await fetchWithRetry(
                `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=50`,
                { headers }
            );
        } catch (e) {
            if (JIRA_BOARD_LOOKUP_STRICT) {
                throw new JiraBoardLookupError(`Sprint lookup for board ${boardId} failed: ${e.message}`, null);
            }

            console.warn(`Warning: could not fetch sprints for board ${boardId} (${e.message}) — skipping its current-PI fetch.`);
            return [];
        }

        if (!res.ok) {
            if (JIRA_BOARD_LOOKUP_STRICT) {
                throw new JiraBoardLookupError(`Sprint lookup for board ${boardId} failed with HTTP ${res.status}`, res.status);
            }

            const hint = res.status === 401
                ? ' — likely a Jira Software/Agile API access or scope issue on the configured account; see ONBOARDING.md\'s Jira section.'
                : '';
            console.warn(`Warning: could not fetch sprints for board ${boardId} (${res.status}) — skipping its current-PI fetch.${hint}`);
            return [];
        }

        const data = await res.json();
        const pageValues = data.values || [];

        // startDate/endDate are carried through alongside id/name/state (not previously captured) so a
        // board with no *active* sprint right now (a gap between sprints, or a typo in the active one's
        // name) can still derive a current PI from the nearest upcoming or most recently closed sprint
        // instead of contributing nothing — see resolveCurrentPiForSpaces.
        sprints.push(...pageValues.map(s => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate || null, endDate: s.endDate || null })));

        isLast = data.isLast === true || pageValues.length === 0;
        startAt += 50;
    }

    return sprints;
}

/**
 * For every space that configured board name(s) in `docs/jira-spaces.json`, resolves each board's active
 * sprint(s) and derives the PI(s) currently in flight from their names, via the same PI-\d+\.\d+ sprint
 * naming convention `extractPiFromSprintName` already assumes elsewhere. For each PI found this way, also
 * collects every sprint (any state) on that same board whose own name resolves to the same PI, so the
 * eventual JQL can scope by real sprint IDs instead of a name-based fuzzy match the Sprint field doesn't
 * actually support. Returns one entry per space that found at least one PI: `{ name, projectKey, piNumbers,
 * sprintIdsByPi }` (`piNumbers`: bare PI numbers, e.g. "27.3" — no "PI-" prefix; `sprintIdsByPi`: plain
 * object `{ [piNumber]: [sprintId, …] }`, for building JQL in `buildCurrentPiJql`). A space with no boards,
 * an unresolvable board, or a board with no detectable active-sprint PI is simply left out — never fails
 * the run.
 */
async function resolveCurrentPiForSpaces(spaces, headers) {
    const results = [];

    for (const space of spaces) {
        const piNumbers = new Set();
        const sprintIdsByPi = new Map();

        for (const boardName of space.boards) {
            // resolveBoardId/fetchAllSprintsForBoard degrade gracefully only on a *successful* response
            // that legitimately found nothing (zero/ambiguous board match, no active sprint) — any
            // network-level exception or non-2xx status from either call now throws `JiraBoardLookupError`,
            // which is deliberately NOT swallowed here: re-thrown below, past this per-board loop, past this
            // function, and past `main()`'s own catch around it, so any failed call fails the whole run
            // instead of silently degrading into `runFullScopeMode()`'s destructive fallback. The remaining
            // generic `console.warn` below only ever catches a genuinely unexpected bug in this loop's own
            // processing (e.g. a typo), not a Jira call failure — one bad board can't take down its own
            // space's other boards over that kind of unrelated error.
            try {
                const boardId = await resolveBoardId(boardName, headers);

                if (!boardId) {
                    continue;
                }

                const sprints = await fetchAllSprintsForBoard(boardId, headers);
                const activeSprints = sprints.filter(s => s.state === 'active');

                // No active sprint right now (a gap between sprints, or a typo'd active sprint name) used
                // to make this board contribute nothing at all — found and fixed as a real bug: that
                // routed main() into runFullScopeMode's fallback, which (outside the narrow 'partial-merge'
                // safety net below) can lose most of this PI's already-synced data. Falling back to the
                // nearest upcoming (future) sprint, else the most recently closed one, covers the common
                // "between sprints" case using data fetchAllSprintsForBoard already pulled — zero extra API
                // calls — so a real sprint gap no longer has to fall all the way through to the fallback.
                let piSprints = activeSprints;

                if (!activeSprints.length) {
                    const futureSprints = sprints.filter(s => s.state === 'future' && s.startDate)
                        .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                    const closedSprints = sprints.filter(s => s.state === 'closed' && s.endDate)
                        .sort((a, b) => new Date(b.endDate) - new Date(a.endDate));

                    if (futureSprints.length) {
                        piSprints = [futureSprints[0]];
                        console.warn(
                            `Warning: board "${boardName}" (space "${space.name}") has no active sprint — using ` +
                            `nearest future sprint "${futureSprints[0].name}" to derive its current PI.`
                        );
                    } else if (closedSprints.length) {
                        piSprints = [closedSprints[0]];
                        console.warn(
                            `Warning: board "${boardName}" (space "${space.name}") has no active sprint — using ` +
                            `most recently closed sprint "${closedSprints[0].name}" to derive its current PI.`
                        );
                    } else {
                        console.warn(`Warning: board "${boardName}" (space "${space.name}") has no active, future, or closed sprint — skipping its current-PI fetch.`);
                    }
                }

                const boardPiNumbers = new Set();

                piSprints.forEach(sprint => {
                    const pi = extractPiFromSprintName(sprint.name);

                    if (pi) {
                        boardPiNumbers.add(pi.replace(/^PI-/, ''));
                        piNumbers.add(pi.replace(/^PI-/, ''));
                    } else {
                        console.warn(`Warning: sprint "${sprint.name}" on board "${boardName}" doesn't match the expected PI.SPRINT naming convention — can't derive its PI.`);
                    }
                });

                // Every sprint on this board belonging to one of the PI(s) just detected from its active
                // sprint(s) — past and future, not just active — becomes part of that PI's `sprint in (…)`
                // scope below.
                sprints.forEach(sprint => {
                    const pi = extractPiFromSprintName(sprint.name);

                    if (!pi) {
                        return;
                    }

                    const num = pi.replace(/^PI-/, '');

                    if (!boardPiNumbers.has(num)) {
                        return;
                    }

                    if (!sprintIdsByPi.has(num)) {
                        sprintIdsByPi.set(num, new Set());
                    }

                    sprintIdsByPi.get(num).add(sprint.id);
                });
            } catch (e) {
                if (e instanceof JiraBoardLookupError) {
                    throw e;
                }

                console.warn(`Warning: unexpected error resolving board "${boardName}" (space "${space.name}") (${e.message}) — skipping its current-PI fetch.`);
            }
        }

        if (piNumbers.size) {
            // Converted to plain arrays/objects here, not left as Sets/Maps: this result is cached across
            // retries via scripts/lib/retry-cache.js's loadOrCompute, which round-trips it through
            // JSON.stringify/parse — a Set/Map serializes to `{}` and silently loses every member, which
            // would otherwise only blow up later (uncaught, outside any try/catch) on the *second* attempt
            // of a losing push race, i.e. in the exact retry scenario this cache exists to make safe.
            const sprintIdsByPiPlain = {};

            for (const [num, ids] of sprintIdsByPi) {
                sprintIdsByPiPlain[num] = [...ids];
            }

            results.push({ name: space.name, projectKey: space.projectKey, piNumbers: [...piNumbers], sprintIdsByPi: sprintIdsByPiPlain });
        }
    }

    return results;
}

module.exports = {
    JiraBoardLookupError,
    resolveBoardId,
    fetchAllSprintsForBoard,
    resolveCurrentPiForSpaces,
};
