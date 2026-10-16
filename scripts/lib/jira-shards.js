const fs = require('fs');
const path = require('path');
const { JIRA_ISSUES_DIR, PRUNED_PIS_PATH } = require('./jira-config');
const { comparePiDesc, safeFileSlug } = require('./jira-pi');

const INDEX_PATH = path.join(JIRA_ISSUES_DIR, 'index.json');
const STATUS_INDEX_PATH = path.join(JIRA_ISSUES_DIR, 'status-index.json');
// Files in JIRA_ISSUES_DIR that are not PI shards — a 'full' recompute is never authoritative over them.
const INFRASTRUCTURE_FILE_NAMES = new Set(['index.json', 'status-index.json', path.basename(PRUNED_PIS_PATH)]);

/** Defense in depth for `index.json`'s own `pis[].file` values once they're read *back* off disk (as
 *  opposed to the `file` names this script itself just generated via `safeFileSlug()` a moment earlier,
 *  which are already safe by construction). `index.json` is trusted data written only by this script, but
 *  it still lives on `live` as a plain file — this check means a `file` value that somehow didn't go
 *  through `safeFileSlug()` (a manual edit, a bug in some future writer) can never make a path lookup
 *  escape `JIRA_ISSUES_DIR`. */
function isWithinJiraIssuesDir(candidatePath) {
    const resolvedDir = path.resolve(JIRA_ISSUES_DIR) + path.sep;

    return path.resolve(candidatePath).startsWith(resolvedDir);
}

/**
 * Persistent "stay pruned" memory for `prune-jira-pis.js`. Found necessary in practice: a PI shard that
 * had already been deleted came back on a later sync — not from `BACKFILL_PIS` (nobody asked for it), but
 * from `runFullScopeMode`'s fallback resolving a long-lived ticket's *old* PI (a ticket with several Sprint
 * entries, none currently `active`, falls back to the *last* one in Jira's list order —
 * `pickRelevantSprintInfo()`). `writePiShards()` reads this list and refuses to (re)write a shard for any
 * PI on it, in every scope, regardless of *how* that PI got rediscovered — the one exception is an explicit
 * `BACKFILL_PIS` request naming that exact PI, which un-prunes it.
 */
function readPrunedPis() {
    if (!fs.existsSync(PRUNED_PIS_PATH)) {
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(PRUNED_PIS_PATH, 'utf8'));

        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn(`Warning: could not parse ${PRUNED_PIS_PATH} (${e.message}) — treating the pruned-PI list as empty.`);

        return [];
    }
}

function writePrunedPis(list) {
    fs.mkdirSync(JIRA_ISSUES_DIR, { recursive: true });
    fs.writeFileSync(PRUNED_PIS_PATH, JSON.stringify([...new Set(list)].sort(comparePiDesc), null, 2));
}

/**
 * Reads the existing `index.json` (if any) so a partial-scope run — the default current-PI-only fetch, or
 * an explicit `BACKFILL_PIS` run — can upsert just the PI(s) it actually fetched without disturbing any
 * other PI's already-synced shard file or index entry. Malformed/missing file degrades to an empty index.
 */
function readExistingIndex() {
    if (!fs.existsSync(INDEX_PATH)) {
        return { currentPi: null, pis: [] };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));

        return { currentPi: parsed.currentPi || null, pis: Array.isArray(parsed.pis) ? parsed.pis : [] };
    } catch (e) {
        console.warn(`Warning: could not parse existing ${INDEX_PATH} (${e.message}) — starting from an empty index.`);
        return { currentPi: null, pis: [] };
    }
}

/** Groups a flat issue list (plus the `sprintDates` side-channel `fetchAndMapIssuesForJql` collects) by
 *  `pi` — shared by every mode, all of which eventually need the same one-shard-per-PI shape. */
function groupIssuesByPi(issues, sprintDates) {
    const issuesByPi = new Map();
    const sprintsByPi = new Map();

    issues.forEach(issue => {
        if (!issuesByPi.has(issue.pi)) {
            issuesByPi.set(issue.pi, []);
        }

        issuesByPi.get(issue.pi).push(issue);

        if (!issue.sprint) {
            return;
        }
        if (!sprintsByPi.has(issue.pi)) {
            sprintsByPi.set(issue.pi, new Map());
        }

        const sprintsForPi = sprintsByPi.get(issue.pi);

        if (!sprintsForPi.has(issue.sprint)) {
            const dates = sprintDates[issue.sprint] || {};

            sprintsForPi.set(issue.sprint, { name: issue.sprint, startDate: dates.startDate || null, endDate: dates.endDate || null });
        }
    });

    return { issuesByPi, sprintsByPi };
}

/**
 * Reconciles this run's fetched PI entries with the pruned-PI list: an explicit backfill naming a pruned PI
 * un-prunes it (that's the point of asking for it back by name); every other caller has a pruned PI
 * filtered out of what it just fetched, no matter how it got rediscovered. Returns the entries to write
 * and the (possibly updated) pruned set.
 */
function reconcilePrunedPis(fetchedEntries, isExplicitBackfill) {
    const prunedPis = new Set(readPrunedPis());

    if (isExplicitBackfill) {
        const unpruned = fetchedEntries.filter(e => prunedPis.has(e.pi)).map(e => e.pi);

        if (unpruned.length) {
            unpruned.forEach(pi => prunedPis.delete(pi));
            writePrunedPis([...prunedPis]);
            console.log(`Un-pruned ${unpruned.join(', ')} — explicitly requested by this backfill.`);
        }

        return { entries: fetchedEntries, prunedPis };
    }

    const kept = fetchedEntries.filter(e => !prunedPis.has(e.pi));

    if (kept.length < fetchedEntries.length) {
        console.warn(
            `::warning::Skipped (re)writing ${fetchedEntries.length - kept.length} PI shard(s) that are on the ` +
            `pruned-PI list (${PRUNED_PIS_PATH}): rediscovered this run, but explicitly excluded by an ` +
            'earlier prune-jira-pis.js run. Re-run that workflow with these PI(s) in BACKFILL_PIS to bring ' +
            'one back deliberately.'
        );
    }

    return { entries: kept, prunedPis };
}

/**
 * `'full'` scope: this run's result is the complete, authoritative answer — any shard file not part of it
 * is deleted (infrastructure files excepted — without that exclusion a 'full' run deleted pruned-pis.json
 * itself, silently undoing every previous prune). Refuses the delete step when the run resolved zero PIs
 * (or was a fallback-stub run) while 2+ shards already exist: that is far more likely an upstream failure
 * than a genuinely empty state. Returns `{ finalPiEntries, finalCurrentPi, fetchedEntries }`.
 */
function resolveFullScope(fetchedEntries, currentPi, isFallbackStubRun) {
    const existingPiCount = fs.existsSync(JIRA_ISSUES_DIR)
        ? fs.readdirSync(JIRA_ISSUES_DIR).filter(name => name.endsWith('.json') && !INFRASTRUCTURE_FILE_NAMES.has(name)).length
        : 0;

    // `isFallbackStubRun` is checked the same way even though `fetchedEntries.length` isn't actually 0 in
    // that case — found and fixed as a real bug: a fully-Jira-unreachable run always produces exactly one
    // shard (the `'—'` placeholder PI), a truthy length that silently bypassed this guard, letting a total
    // Jira outage wipe every real PI shard and replace them with one content-free stub bucket.
    if (existingPiCount >= 2 && (fetchedEntries.length === 0 || isFallbackStubRun)) {
        console.warn(
            `::warning::Refusing to delete ${existingPiCount} existing PI shard(s) in ${JIRA_ISSUES_DIR} — ` +
            "this 'full'-scope run resolved zero PIs, which looks like an upstream failure rather than a " +
            'genuine empty state. Leaving every existing shard/index entry untouched.'
        );

        const existing = readExistingIndex();

        // fetchedEntries is discarded so the shard-content write loop doesn't write this run's (refused)
        // entries to disk as orphan files, contradicting "leaving every existing shard untouched".
        return { finalPiEntries: existing.pis, finalCurrentPi: existing.currentPi, fetchedEntries: [] };
    }

    const validFileNames = new Set(fetchedEntries.map(e => e.file).concat([...INFRASTRUCTURE_FILE_NAMES]));

    fs.readdirSync(JIRA_ISSUES_DIR)
        .filter(name => !validFileNames.has(name))
        .forEach(name => fs.unlinkSync(path.join(JIRA_ISSUES_DIR, name)));

    return { finalPiEntries: fetchedEntries, finalCurrentPi: currentPi, fetchedEntries };
}

/**
 * `'partial'`/`'partial-merge'` scope: upsert only the fetched PI entries into the existing index, leaving
 * every other PI's entry alone. 'partial' already fetched a comprehensive sprint list for its one PI, so a
 * plain overwrite is correct (and drops a sprint that's genuinely gone); 'partial-merge''s fetch is narrow,
 * so each touched PI's `sprints` are merged by `name` instead. A pruned PI carried forward from the existing
 * index is cleaned up here too (its shard file deleted, entry dropped).
 */
function resolvePartialScope(fetchedEntries, currentPi, scope, prunedPis) {
    const existing = readExistingIndex();
    const byPi = new Map(existing.pis.map(e => [e.pi, e]));

    fetchedEntries.forEach(e => {
        if (scope === 'partial-merge' && byPi.has(e.pi)) {
            const bySprintName = new Map((byPi.get(e.pi).sprints || []).map(s => [s.name, s]));

            e.sprints.forEach(s => bySprintName.set(s.name, s));
            e.sprints = [...bySprintName.values()];
        }

        byPi.set(e.pi, e);
    });

    let finalPiEntries = [...byPi.values()].sort((a, b) => comparePiDesc(a.pi, b.pi));
    const finalCurrentPi = currentPi !== undefined ? currentPi : existing.currentPi;

    if (prunedPis.size) {
        finalPiEntries.filter(e => prunedPis.has(e.pi)).forEach(e => {
            const filePath = path.join(JIRA_ISSUES_DIR, e.file);

            if (isWithinJiraIssuesDir(filePath) && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        });

        finalPiEntries = finalPiEntries.filter(e => !prunedPis.has(e.pi));
    }

    return { finalPiEntries, finalCurrentPi, fetchedEntries };
}

/**
 * Writes each fetched PI's shard file. 'full' and 'partial' fully replace the file (the fetch behind them
 * is comprehensive for the PI, which is what gives "ghost removal" for an issue that moved out of it);
 * 'partial-merge' upserts by issue `key` into whatever's already on disk, since its fetch is deliberately
 * narrow and a wholesale replace used to silently drop every other issue already synced for that PI.
 */
function writeShardFiles(fetchedEntries, issuesByPi, scope) {
    fetchedEntries.forEach(({ pi, file }) => {
        const filePath = path.join(JIRA_ISSUES_DIR, file);
        let outputIssues = issuesByPi.get(pi);

        if (scope === 'partial-merge' && fs.existsSync(filePath)) {
            let existingIssues = [];

            try {
                existingIssues = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                console.warn(`Warning: could not parse existing shard ${filePath} for partial-merge scope (${e.message}) — treating as empty.`);
            }

            const byKey = new Map(existingIssues.map(i => [i.key, i]));

            outputIssues.forEach(i => byKey.set(i.key, i));
            outputIssues = [...byKey.values()];
        }

        fs.writeFileSync(filePath, JSON.stringify(outputIssues, null, 2));
    });
}

/**
 * Writes one shard file per PI in `issuesByPi`/`sprintsByPi` and updates `index.json`. Three scopes:
 *
 * - `'full'` — authoritative recompute of everything (explicit `JIRA_PROJECT_KEY` sync, and the fallback
 *   when no space has a board): any existing shard for a PI not part of this run's result gets deleted.
 * - `'partial'` — the default current-PI-only fetch and `BACKFILL_PIS`: only the PI(s) actually fetched
 *   are touched, each shard fully *replaced* (no merge — that's what gives ghost removal for free). Every
 *   other shard/index entry is kept as-is.
 * - `'partial-merge'` — only `main()`'s degraded fallback (board(s) configured but none resolved a current
 *   PI this run): same index handling as 'partial', but shard content and `sprints` are upserted into what
 *   is already on disk, because that fetch is narrower than whatever populated the shard.
 *
 * `currentPi` is written as given in `'full'` scope; in the partial scopes, `undefined` preserves whatever
 * the existing `index.json` had (`BACKFILL_PIS` never changes it).
 *
 * `isExplicitBackfill` (only ever `true` from `runBackfillMode`) un-prunes a requested pruned PI; every
 * other caller has a pruned PI filtered out of what it fetched.
 */
function writePiShards(issuesByPi, sprintsByPi, { scope, currentPi, isExplicitBackfill, isFallbackStubRun }) {
    fs.mkdirSync(JIRA_ISSUES_DIR, { recursive: true });

    const allEntries = [...issuesByPi.keys()].sort(comparePiDesc).map(pi => ({
        pi,
        file: `${safeFileSlug(pi)}.json`,
        sprints: [...(sprintsByPi.get(pi)?.values() || [])],
    }));
    const { entries, prunedPis } = reconcilePrunedPis(allEntries, isExplicitBackfill);
    const resolved = scope === 'full'
        ? resolveFullScope(entries, currentPi, isFallbackStubRun)
        : resolvePartialScope(entries, currentPi, scope, prunedPis);
    const { fetchedEntries, finalCurrentPi } = resolved;

    writeShardFiles(fetchedEntries, issuesByPi, scope);

    // `index.json` must never list a PI whose shard file doesn't actually exist — `docs/app-*.js`'s global PI
    // `<select>` trusts this list completely. Only ever catches a *pre-existing* entry (from a partial
    // scope's merge, or a stale/malformed index.json) whose file went missing externally.
    const finalPiEntries = resolved.finalPiEntries.filter(e => {
        const candidate = path.join(JIRA_ISSUES_DIR, e.file);

        return isWithinJiraIssuesDir(candidate) && fs.existsSync(candidate);
    });

    fs.writeFileSync(INDEX_PATH, JSON.stringify({ currentPi: finalCurrentPi, pis: finalPiEntries }, null, 2));

    const issueCount = [...issuesByPi.values()].reduce((n, list) => n + list.length, 0);

    console.log(
        `Wrote ${issueCount} issue(s) across ${fetchedEntries.length} PI file(s) to ${JIRA_ISSUES_DIR} ` +
        `(scope: ${scope}, current PI: ${finalCurrentPi || 'unknown'}).`
    );
}

/**
 * A tiny, cross-PI `key -> { pi, statusCategory }` map, rebuilt from whatever shard files exist on disk
 * after every run. Exists so `docs/app-*.js` doesn't have to fetch more than one PI's shard just to answer
 * "is every issue this flag is linked to actually Done" (Technical view's Flags panel). Pure local file
 * reads, so always recomputed in full.
 */
function buildStatusIndex() {
    if (!fs.existsSync(INDEX_PATH)) {
        return;
    }

    const { pis } = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const statusByKey = {};

    (pis || []).forEach(({ pi, file }) => {
        const shardPath = path.join(JIRA_ISSUES_DIR, file);

        if (!isWithinJiraIssuesDir(shardPath) || !fs.existsSync(shardPath)) {
            return;
        }

        // `pis` is sorted newest-PI-first — only the first sighting of a key is kept, so a stale copy in an
        // older, un-pruned shard can't override the issue's current PI (found and fixed as a real bug).
        JSON.parse(fs.readFileSync(shardPath, 'utf8')).forEach(issue => {
            if (!(issue.key in statusByKey)) {
                statusByKey[issue.key] = { pi, statusCategory: issue.statusCategory };
            }
        });
    });

    fs.writeFileSync(STATUS_INDEX_PATH, JSON.stringify(statusByKey, null, 2));
}

module.exports = {
    isWithinJiraIssuesDir,
    readPrunedPis,
    writePrunedPis,
    readExistingIndex,
    groupIssuesByPi,
    writePiShards,
    buildStatusIndex,
};
