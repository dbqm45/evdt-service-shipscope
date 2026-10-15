const fs = require('fs');
const { readJson } = require('./lib/json-file');
const crypto = require('crypto');
const { loadOrCompute } = require('./lib/retry-cache');
const {
    JIRA_PROJECT_KEY, DEPLOYMENTS_PATH, SPACES_PATH, AUTH_HEADER_VALUE,
} = require('./lib/jira-config');
const {
    extractPiFromSprintName, extractPiFromLabel, pickRelevantSprintInfo, comparePiDesc, safeFileSlug,
} = require('./lib/jira-pi');
const {
    deriveIssueKeysFromDeployments, projectKeyOf, buildJql, buildJqlForKeys, buildCurrentPiJql,
} = require('./lib/jira-jql');
const {
    JiraSpacesConfigError, filterExistingProjectKeys, readSpacesConfig, resolveSpacesConfig,
    buildBoardNamesByProjectName, buildTeamNamesByProjectName,
} = require('./lib/jira-spaces');
const { JiraBoardLookupError, resolveCurrentPiForSpaces } = require('./lib/jira-boards');
const {
    pickBestType, buildFallbackIssuesFromDeployments, findSpecialFieldIds, extractTeamName, extractTeamNames,
    fillMissingEpicTitles, fetchAndMapIssuesForJql,
} = require('./lib/jira-issues');
const {
    readExistingIndex, groupIssuesByPi, writePiShards, buildStatusIndex,
} = require('./lib/jira-shards');

// This file is the orchestrator only: it decides *which* Jira query to run (backfill / current PI /
// full-scope fallback) and hands the result to the shard writer. The pieces live in scripts/lib/jira-*.js:
//   jira-config  — env-derived settings        jira-pi      — PI/sprint parsing and ordering
//   jira-jql     — JQL builders                 jira-spaces  — docs/jira-spaces.json + project resolution
//   jira-boards  — Agile board/sprint lookup    jira-issues  — fetching and mapping issues
//   jira-shards  — per-PI shard + index writing

function parseExplicitProjectKeys() {
    return JIRA_PROJECT_KEY ? JIRA_PROJECT_KEY.split(',').map(k => k.trim()).filter(Boolean) : [];
}

function readDeployments() {
    return readJson(DEPLOYMENTS_PATH, []);
}

/**
 * `BACKFILL_PIS`: comma/space-separated PI list (e.g. "PI-27.1, PI-26.5" or bare "27.1"), normalized to
 * `PI-X.Y` labels and deduped. Empty array when unset.
 */
function parseBackfillPis() {
    const raw = process.env.BACKFILL_PIS || '';
    const labels = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
        .map(s => (/^\d+(\.\d+)+$/.test(s) ? `PI-${s}` : s.toUpperCase()));

    return [...new Set(labels)];
}

/** Stable per-query cache key for `loadOrCompute` — keyed by a hash of the query so a genuinely different
 *  query still fetches fresh instead of serving a stale cached result. */
function cacheKeyFor(prefix, query) {
    return `${prefix}-${crypto.createHash('sha256').update(query).digest('hex')}`;
}

/** Resolves everything about the Jira instance/config that doesn't vary per JQL, once per mode run. */
async function buildFetchContext(headers, resolvedSpaces, sprintIdsByProjectName) {
    const fieldIds = await findSpecialFieldIds(headers);

    return {
        ...fieldIds,
        boardNamesByProjectName: buildBoardNamesByProjectName(resolvedSpaces),
        teamNamesByProjectName: buildTeamNamesByProjectName(resolvedSpaces),
        ...(sprintIdsByProjectName ? { sprintIdsByProjectName } : {}),
    };
}

/**
 * `BACKFILL_PIS`: an explicit, manually-triggered ask for one or more specific PIs' Jira data — the
 * escape hatch for anything the default current-PI-only sync (see `main()`) doesn't cover, since that only
 * ever auto-refreshes whichever PI is currently active: seeding a PI that predates this sync ever running,
 * or revisiting one that's since moved out of "current." Scoped to whichever project(s) are already
 * configured (explicit `JIRA_PROJECT_KEY`, else every resolved `docs/jira-spaces.json` space) via the same
 * `labels =` match `buildCurrentPiJql` uses for the real current-PI fetch, parameterized by the requested
 * PI(s) instead of an active sprint's derived one — but without that function's own board-derived sprint
 * IDs (there's no "active sprint" to start from here, just an arbitrary requested PI), so this only ever
 * matches on `labels`, not `sprint`: an issue carrying a Sprint value for the requested PI but no matching
 * label won't be picked up by this path. Never touches any other PI's shard file or `index.json`'s
 * `currentPi`.
 */
async function runBackfillMode(requestedPis, explicitProjectKeys, resolvedSpaces, headers) {
    const piNumbers = requestedPis.map(pi => pi.replace(/^PI-/i, ''));
    const projectKeys = explicitProjectKeys.length ? explicitProjectKeys : resolvedSpaces.map(s => s.projectKey);

    let jql;

    if (projectKeys.length) {
        jql = buildCurrentPiJql(projectKeys.map(projectKey => ({ projectKey, piNumbers: new Set(piNumbers) })));
    } else {
        console.warn(
            `Warning: no project scope configured (no JIRA_PROJECT_KEY, no space in ${SPACES_PATH}) — ` +
            `backfilling PI(s) ${requestedPis.join(', ')} with an unscoped label match only, which may ` +
            'pick up issues from an unrelated project that happens to reuse the same PI numbering.'
        );

        const piConditions = piNumbers.map(num => `labels = "PI-${num}"`).join(' OR ');

        jql = `(${piConditions})`;
    }

    console.log(`Backfilling PI(s): ${requestedPis.join(', ')}`);

    const ctx = await buildFetchContext(headers, resolvedSpaces);
    const { issues: rawIssues, sprintDates } = await loadOrCompute(
        cacheKeyFor('jira-backfill', jql),
        () => fetchAndMapIssuesForJql(jql, headers, ctx)
    );

    await fillMissingEpicTitles(rawIssues, headers);

    // Filter back down to exactly the requested PI(s) so an issue whose resolved `pi` (sprint- or
    // label-derived) doesn't match what was asked for — e.g. a multi-labelled issue the `labels =` query
    // matched on one PI label while its *resolved* `pi` comes from a different, higher-priority signal —
    // can't get written into a file nobody asked for.
    const requestedPiSet = new Set(requestedPis);
    const issues = rawIssues.filter(i => requestedPiSet.has(i.pi));
    const droppedCount = rawIssues.length - issues.length;

    if (droppedCount > 0) {
        console.warn(
            `Dropped ${droppedCount} issue(s) matched by the backfill query but resolved to a PI other ` +
            'than the one(s) requested (sprint/label text overlap) — not written to any file.'
        );
    }

    const foundPis = new Set(issues.map(i => i.pi));
    const emptyPis = requestedPis.filter(pi => !foundPis.has(pi));

    if (emptyPis.length) {
        console.warn(`No issues found for requested PI(s): ${emptyPis.join(', ')} — leaving them unwritten.`);
    }

    const { issuesByPi, sprintsByPi } = groupIssuesByPi(issues, sprintDates);

    writePiShards(issuesByPi, sprintsByPi, { scope: 'partial', currentPi: undefined, isExplicitBackfill: true });
}

/**
 * The default sync's preferred path: scoped to just the board-derived current PI (see
 * `resolveCurrentPiForSpaces`/`buildCurrentPiJql`) — a full, authoritative fetch of "everything currently
 * in this PI," replacing that PI's shard wholesale (`writePiShards`'s `'partial'` scope: only this PI's
 * file and `index.json` entry are touched; every other PI — including anything a manual `BACKFILL_PIS`
 * run ever seeded — is left exactly as it is). Deliberately a full *replace*, not an incremental merge: an
 * issue that moved out of this PI simply isn't in the fetch result, so it's naturally absent from the new
 * shard with no separate "ghost removal" step needed. ShipScope's job is showing the current, real state
 * — not maintaining a historical archive (see CLAUDE.md's Jira issues section) — so only the current PI
 * is ever auto-refreshed; any other PI visible in the UI is a point-in-time snapshot from whenever
 * `BACKFILL_PIS` last (re)fetched it, not something this default sync keeps in sync with Jira.
 */
async function runCurrentPiMode(currentPiJql, currentPiResults, headers, resolvedSpaces) {
    // Keyed by project *name* (matching fetchAndMapIssuesForJql's lookup), not projectKey — real sprint-ID
    // knowledge, only available here (the current-PI query context), is what lets that function tell a
    // genuine `sprint in (ids)` match apart from a label-only one (see its `labelOnlyNoEvidence` logic).
    const sprintIdsByProjectName = Object.fromEntries(
        currentPiResults.map(r => [r.name, r.sprintIdsByPi || {}])
    );
    const ctx = await buildFetchContext(headers, resolvedSpaces, sprintIdsByProjectName);
    const { issues: rawIssues, sprintDates } = await loadOrCompute(
        cacheKeyFor('jira-currentpi', currentPiJql),
        () => fetchAndMapIssuesForJql(currentPiJql, headers, ctx)
    );

    const resolvedCurrentPi = currentPiResults.flatMap(r => [...r.piNumbers]).map(n => `PI-${n}`).sort(comparePiDesc)[0] || null;

    // A space configured with only `teams` (no `boards` of its own — a Jira project genuinely shared
    // across more than one team with nothing to resolve an active sprint from) never contributes to
    // `currentPiJql` above (buildCurrentPiJql only ever reads board-derived `currentPiResults`) — found
    // and fixed as a real gap: that space's work never reached the everyday current-PI sync at all. Once
    // some *other* space's board has already resolved a current PI, extend the fetch with one
    // project-scoped query per boardless+teams space, labeled the same way the label-only branch of
    // buildCurrentPiJql already is — the Team-field/label double-check inside fetchAndMapIssuesForJql
    // (fail-closed for a boardless space) is what keeps this safe from pulling in a differently-teamed issue.
    const boardlessTeamsSpaces = resolvedSpaces.filter(s => !s.boards.length && s.teams.length);

    if (resolvedCurrentPi && boardlessTeamsSpaces.length) {
        const existingKeys = new Set(rawIssues.map(i => i.key));

        for (const space of boardlessTeamsSpaces) {
            const supplementJql = `project = ${space.projectKey} AND labels = "${resolvedCurrentPi}"`;

            try {
                const { issues: extraIssues, sprintDates: extraSprintDates } = await loadOrCompute(
                    cacheKeyFor('jira-currentpi-boardless', supplementJql),
                    () => fetchAndMapIssuesForJql(supplementJql, headers, ctx)
                );

                extraIssues.forEach(i => {
                    if (!existingKeys.has(i.key)) {
                        existingKeys.add(i.key);
                        rawIssues.push(i);
                    }
                });
                Object.assign(sprintDates, extraSprintDates);
            } catch (e) {
                console.warn(`Warning: boardless+teams current-PI supplement for space "${space.name}" failed (${e.message}) — proceeding without it.`);
            }
        }
    }

    await fillMissingEpicTitles(rawIssues, headers);

    // `labels = "PI-27.3"` can still coincidentally match an issue whose Sprint-derived `pi` resolves to
    // something else (an issue can carry more than one PI-shaped label) — filter back down to exactly the
    // resolved current PI so that can't get `writePiShards()` (in `'partial'` scope, which writes/overwrites
    // *every* PI key present in its input, not just one) to silently overwrite a completely unrelated PI's
    // shard as a side effect of the everyday current-PI sync.
    const issues = resolvedCurrentPi ? rawIssues.filter(i => i.pi === resolvedCurrentPi) : rawIssues;
    const droppedCount = rawIssues.length - issues.length;

    if (droppedCount > 0) {
        console.warn(
            `Dropped ${droppedCount} issue(s) matched by the current-PI query but resolved to a PI other ` +
            `than the resolved current PI (${resolvedCurrentPi}) — not written to any file.`
        );
    }

    if (!issues.length) {
        console.warn(
            "Board-derived current-PI query returned no usable issues this run — leaving index.json's " +
            'currentPi and every existing PI file untouched rather than pointing at an empty shard.'
        );
    }

    const { issuesByPi, sprintsByPi } = groupIssuesByPi(issues, sprintDates);

    writePiShards(issuesByPi, sprintsByPi, { scope: 'partial', currentPi: issues.length ? resolvedCurrentPi : undefined });
}

/**
 * Explicit `JIRA_PROJECT_KEY` opt-in: search whole project(s) end to end, not just issues already
 * referenced by a commit. Returns `{ JQL, fullyCoveredProjectKeys }` (both `null` when nothing usable).
 */
async function buildExplicitProjectQuery(explicitProjectKeys, allowedProjectKeys, resolvedSpaces, headers) {
    const validProjectKeys = await filterExistingProjectKeys(explicitProjectKeys, headers);
    const scopedProjectKeys = allowedProjectKeys
        ? validProjectKeys.filter(k => allowedProjectKeys.has(k))
        : validProjectKeys;

    if (!scopedProjectKeys.length) {
        return { JQL: null, fullyCoveredProjectKeys: null };
    }

    console.log(`Using project key(s): ${scopedProjectKeys.join(', ')}`);

    // JIRA_PROJECT_KEY intentionally fetches a whole project with no issue-key narrowing, but the
    // Team-field double-check only ever activates for a project that resolvedSpaces actually knows about
    // (via a matching space's boards/teams) — a project named here that isn't also configured in
    // jira-spaces.json gets zero team filtering. Worth a loud warning since this run was explicitly opted
    // into whole-project scope, not the default's narrower, safer behavior.
    const unscoped = scopedProjectKeys.filter(key =>
        !resolvedSpaces.some(s => s.projectKey === key && (s.boards.length || s.teams.length))
    );

    if (unscoped.length) {
        console.warn(
            `::warning::JIRA_PROJECT_KEY whole-project sync for ${unscoped.join(', ')} has no matching ` +
            `space with "boards"/"teams" configured in ${SPACES_PATH} — every issue in that project is ` +
            'fetched with zero Team-field/label scoping.'
        );
    }

    return { JQL: buildJql(scopedProjectKeys), fullyCoveredProjectKeys: new Set(scopedProjectKeys) };
}

/**
 * Default fallback query: scope strictly to issue keys actually referenced in synced commit messages — a
 * ticket mentioned once in a commit shouldn't pull in every other, unrelated ticket from whichever project
 * it happens to belong to. Returns the JQL, or `null` when no usable key resolved.
 */
async function buildReferencedKeysQuery(allowedProjectKeys, headers) {
    const referencedKeys = deriveIssueKeysFromDeployments(readDeployments());
    const referencedProjectKeys = [...new Set(referencedKeys.map(projectKeyOf))];
    const validProjectKeySet = new Set(await filterExistingProjectKeys(referencedProjectKeys, headers));
    let issueKeys = referencedKeys.filter(k => validProjectKeySet.has(projectKeyOf(k)));

    if (allowedProjectKeys) {
        issueKeys = issueKeys.filter(k => allowedProjectKeys.has(projectKeyOf(k)));
    }

    if (!issueKeys.length) {
        return null;
    }

    console.log(`Using referenced issue key(s): ${issueKeys.join(', ')}`);

    return buildJqlForKeys(issueKeys);
}

/**
 * The pre-sharding default, kept as a fallback for whenever `runCurrentPiMode` above can't run at all — no
 * space in `docs/jira-spaces.json` has a `boards` entry, or every configured board's active-sprint lookup
 * failed — and also the always-used path for the explicit `JIRA_PROJECT_KEY` opt-in. Scoped to the exact
 * issue keys referenced in `deployments.json` (or, with `JIRA_PROJECT_KEY` set, whole project(s) instead),
 * optionally topped up with the board-derived current-PI supplement for any space not already fully
 * covered by an explicit project. Defaults to a `'full'`-scope run: every PI it finds becomes the
 * complete, authoritative set — any other PI's existing shard file that isn't part of this run's result
 * gets deleted, exactly like the old single-file sync did.
 *
 * `scope: 'partial-merge'` is passed instead specifically when main() reaches this function because board
 * resolution was *attempted* (boards are configured) but came back with nothing — a transient 401/429/5xx
 * on the Agile API in non-strict mode (see `JIRA_BOARD_LOOKUP_STRICT`), not a deliberate "nothing is
 * configured" state. This narrower fallback scan routinely finds *fewer* PIs than what's genuinely tracked
 * (e.g. a past PI only seeded via `BACKFILL_PIS`) and fewer issues per PI, so it must only ever upsert and
 * never delete. `currentPi` is also left `undefined` in that case (preserving whatever `index.json`
 * already had) rather than overwritten with this narrower run's own heuristic.
 */
async function runFullScopeMode(explicitProjectKeys, allowedProjectKeys, currentPiJql, currentPiResults, headers, resolvedSpaces, scope = 'full') {
    let JQL = null;
    // Only set in explicit whole-project mode — used below to skip the board-derived current-PI fetch for
    // a project that's already being fetched in full, since it can't add anything there.
    let fullyCoveredProjectKeys = null;

    if (explicitProjectKeys.length) {
        ({ JQL, fullyCoveredProjectKeys } = await buildExplicitProjectQuery(explicitProjectKeys, allowedProjectKeys, resolvedSpaces, headers));
    } else {
        JQL = await buildReferencedKeysQuery(allowedProjectKeys, headers);
    }

    const effectiveCurrentPiJql = fullyCoveredProjectKeys
        ? buildCurrentPiJql(currentPiResults.filter(r => !fullyCoveredProjectKeys.has(r.projectKey)))
        : currentPiJql;

    let issues = [];
    const sprintDates = {};

    if (!JQL && !effectiveCurrentPiJql) {
        console.warn(
            'Could not determine any usable Jira issue/project key or board-derived current-PI query to ' +
            `search: JIRA_PROJECT_KEY is not set, none of the issue keys referenced in ${DEPLOYMENTS_PATH} ` +
            `resolved to a real, visible Jira project${allowedProjectKeys ? ` allowed by ${SPACES_PATH}` : ''}, ` +
            `and no space in ${SPACES_PATH} has a board with a detectable active-sprint PI. Skipping Jira ` +
            'fetch and falling back to deployment-derived issue stubs.'
        );
    } else {
        const ctx = await buildFetchContext(headers, resolvedSpaces);
        const issuesByKey = new Map();

        if (JQL) {
            // Fetching from Jira is expensive/rate-limited and depends only on JQL itself, not on `live`'s
            // git state — cached per exact query so a retry after a losing push (see
            // .github/actions/sync-with-retry) reuses this instead of re-querying Jira from scratch.
            //
            // Wrapped in try/catch — unlike a transient outage/rate-limit (where sync-with-retry's retry
            // loop re-running this same JQL can actually succeed on a later attempt), the exact-key fallback
            // shape of this JQL (buildJqlForKeys, `key in (...)`) can fail *deterministically*: a single
            // stale/typo'd issue key parsed out of a commit message would fail identically on every retry,
            // crashing this sync on every single run until a human manually prunes the bad key. Found and
            // fixed as a real bug — degrade to an empty result instead, same spirit as the best-effort
            // handling for effectiveCurrentPiJql just below.
            let primaryResult = { issues: [], sprintDates: {} };

            try {
                primaryResult = await loadOrCompute(cacheKeyFor('jira', JQL), () => fetchAndMapIssuesForJql(JQL, headers, ctx));
            } catch (err) {
                console.warn(`::warning::Primary Jira fetch failed for JQL "${JQL}": ${err.message}. Skipping — these issues will be missing from this sync.`);
            }

            primaryResult.issues.forEach(i => issuesByKey.set(i.key, i));
            Object.assign(sprintDates, primaryResult.sprintDates);
        }

        if (effectiveCurrentPiJql) {
            // Same best-effort reasoning as the primary JQL fetch above: if it fails, fall back to just
            // the primary result set rather than losing an otherwise-successful sync over the extra data.
            try {
                const currentPiResult = await loadOrCompute(
                    cacheKeyFor('jira-currentpi', effectiveCurrentPiJql),
                    () => fetchAndMapIssuesForJql(effectiveCurrentPiJql, headers, ctx)
                );

                currentPiResult.issues.forEach(i => { if (!issuesByKey.has(i.key)) issuesByKey.set(i.key, i); });
                Object.assign(sprintDates, currentPiResult.sprintDates);
            } catch (e) {
                console.warn(`Warning: board-derived current-PI Jira fetch failed (${e.message}) — proceeding with just the primary result set.`);
            }
        }

        issues = [...issuesByKey.values()];

        await fillMissingEpicTitles(issues, headers);
    }

    let isFallbackStubRun = false;

    if (!issues.length) {
        if (JQL || effectiveCurrentPiJql) {
            console.warn(
                'Jira returned no usable issues (either 0 results, or none with a detectable PI) — ' +
                'falling back to deployment-derived issue stubs.'
            );
        }

        issues = buildFallbackIssuesFromDeployments(readDeployments(), allowedProjectKeys);
        isFallbackStubRun = true;
        console.log(`Derived ${issues.length} fallback issue stub(s) from deployment commit history.`);
    }

    // Board-derived current-PI results (if any) are the most authoritative signal for "what PI is the team
    // actually in right now" — falls back to the highest PI seen among non-Epic issues (the same heuristic
    // docs/app.js's own currentPi() used client-side before this index existed) when no board is configured
    // or it couldn't be resolved this run, and to `null` when even that finds nothing (e.g. a fully
    // fallback-stub run with no real PI at all).
    const currentPiFromBoards = currentPiResults
        .flatMap(r => [...r.piNumbers])
        .map(n => `PI-${n}`)
        .sort(comparePiDesc)[0] || null;
    const currentPiFromIssues = [...new Set(issues.filter(i => i.type !== 'Epic' && i.pi).map(i => i.pi))]
        .sort(comparePiDesc)[0] || null;
    const currentPi = currentPiFromBoards || currentPiFromIssues || null;

    // One-time cleanup of the pre-sharding output this replaces — removed here (rather than left for
    // someone to notice and delete by hand) so its removal ships in the same commit as the new per-PI
    // files below, instead of sitting orphaned on `live` forever.
    const legacyOutputPath = 'docs/data/jira-issues.json';

    if (fs.existsSync(legacyOutputPath)) {
        fs.unlinkSync(legacyOutputPath);
    }

    const { issuesByPi, sprintsByPi } = groupIssuesByPi(issues, sprintDates);

    writePiShards(issuesByPi, sprintsByPi, {
        scope,
        currentPi: scope === 'full' ? currentPi : undefined,
        isFallbackStubRun,
    });
}

/**
 * Board-derived "what PI is currently in flight" resolution for every space with `boards` configured.
 * A `JiraBoardLookupError` (strict mode only) is deliberately NOT swallowed — letting it fail main() is
 * what lets sync-with-retry (and the daily cron) do the recovering, instead of this falling through to
 * routing into runFullScopeMode()'s destructive 'full' scope on every auth/outage blip. Any other error
 * (a genuine network blip unrelated to auth) still just degrades to "no boards".
 */
async function resolveCurrentPiResults(spacesNeedingCurrentPi, headers) {
    if (!spacesNeedingCurrentPi.length) {
        return [];
    }

    try {
        return await loadOrCompute('jira-current-pi-clauses', () => resolveCurrentPiForSpaces(spacesNeedingCurrentPi, headers));
    } catch (e) {
        if (e instanceof JiraBoardLookupError) {
            throw e;
        }

        console.warn(`Warning: could not resolve board-derived current-PI data (${e.message}) — proceeding without it, same as if no boards were configured.`);

        return [];
    }
}

async function main() {
    // Force English API responses regardless of the authenticating account's Jira profile language —
    // otherwise issue type names (and other localizable strings) come back translated (e.g. Chinese:
    // 任务/缺陷/故事/长篇故事/子任务 for Task/Bug/Story/Epic/Subtask), which jira-issues.js's TYPE_MAP
    // doesn't recognize, silently dropping every issue and triggering the deployment-derived fallback.
    const headers = { Authorization: AUTH_HEADER_VALUE, Accept: 'application/json', 'Accept-Language': 'en-US' };

    // `null` = no docs/jira-spaces.json (or it's empty) = don't restrict anything, same as before this
    // existed. Otherwise a Set of resolved project keys, intersected into whichever project/issue-key list
    // each branch below was about to search — so the allowlist applies no matter which mode is active.
    const spacesConfig = readSpacesConfig();
    const { allowedProjectKeys, resolvedSpaces } = await resolveSpacesConfig(spacesConfig, headers);
    const explicitProjectKeys = parseExplicitProjectKeys();
    const backfillPis = parseBackfillPis();

    if (backfillPis.length) {
        await runBackfillMode(backfillPis, explicitProjectKeys, resolvedSpaces, headers);
        buildStatusIndex();
        return;
    }

    // Board-derived low-cost "what PI is currently in flight" resolution — doubling as the *entire*
    // default sync's scope (see runCurrentPiMode) whenever it resolves anything. A space already fully
    // covered by an explicit JIRA_PROJECT_KEY project gets filtered back out inside runFullScopeMode.
    const spacesNeedingCurrentPi = resolvedSpaces.filter(s => s.boards.length);
    const currentPiResults = await resolveCurrentPiResults(spacesNeedingCurrentPi, headers);
    const currentPiJql = buildCurrentPiJql(currentPiResults);

    if (explicitProjectKeys.length) {
        // Explicit opt-in is unaffected by the current-PI-only default below — an operator who set
        // JIRA_PROJECT_KEY deliberately wants everything in that project, every run.
        await runFullScopeMode(explicitProjectKeys, allowedProjectKeys, currentPiJql, currentPiResults, headers, resolvedSpaces);
        buildStatusIndex();
        return;
    }

    if (currentPiJql) {
        await runCurrentPiMode(currentPiJql, currentPiResults, headers, resolvedSpaces);
        buildStatusIndex();
        return;
    }

    // A space with configured boards that nonetheless resolved nothing (every board's lookup degraded in
    // non-strict mode — see JiraBoardLookupError) is a *failure*, not a genuine "nothing is configured"
    // state — unlike spacesNeedingCurrentPi being empty from the start, which means no space anywhere has a
    // `boards` entry at all. Routing a transient failure through 'full' scope would let this narrower
    // fallback scan's incomplete result set destructively delete PI shards that are otherwise still valid.
    const boardResolutionAttemptedButFoundNothing = spacesNeedingCurrentPi.length > 0;

    console.warn(
        `No space in ${SPACES_PATH} has a board with a detectable active-sprint PI — falling back to the ` +
        "broad deploy-referenced-issue-key sync (see CLAUDE.md's Jira issues section). Configure a space's " +
        '"boards" to switch to the cheaper current-PI-only default.'
    );

    if (boardResolutionAttemptedButFoundNothing) {
        console.warn(
            '::warning::Board(s) were configured but none resolved a current PI this run — treating this as a ' +
            "degraded fallback and using 'partial-merge' scope so existing PI shards aren't deleted or " +
            'overwritten over what may just be a transient failure.'
        );
    }

    await runFullScopeMode(
        [], allowedProjectKeys, null, [], headers, resolvedSpaces,
        boardResolutionAttemptedButFoundNothing ? 'partial-merge' : 'full'
    );
    buildStatusIndex();
}

module.exports = {
    deriveIssueKeysFromDeployments,
    buildJql,
    buildJqlForKeys,
    buildCurrentPiJql,
    extractPiFromSprintName,
    extractPiFromLabel,
    pickRelevantSprintInfo,
    extractTeamName,
    extractTeamNames,
    comparePiDesc,
    safeFileSlug,
    pickBestType,
    buildFallbackIssuesFromDeployments,
    parseBackfillPis,
    groupIssuesByPi,
    writePiShards,
    readExistingIndex,
    buildStatusIndex,
    resolveCurrentPiForSpaces,
    JiraBoardLookupError,
    JiraSpacesConfigError,
    readSpacesConfig,
    buildBoardNamesByProjectName,
    buildTeamNamesByProjectName,
    fetchAndMapIssuesForJql,
};

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
