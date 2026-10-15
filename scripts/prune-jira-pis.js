const fs = require('fs');
const path = require('path');
const { fail } = require('./lib/cli');
// JIRA_ISSUES_DIR is validated (safeRelativePath) once in jira-config; the read-side helpers are shared with
// sync-jira.js so both always agree on the pruned-PI list's path/shape and the in-directory guard.
const { JIRA_ISSUES_DIR } = require('./lib/jira-config');
// writePrunedPis is the shared one too (newest-PI-first order, no trailing newline) — a private copy with a
// different sort/format made every handoff between this script and sync-jira.js rewrite the whole file.
const { isWithinJiraIssuesDir, readPrunedPis, writePrunedPis } = require('./lib/jira-shards');

/** Same parsing convention as sync-jira.js's parseBackfillPis(); PRUNE_PIS/BACKFILL_PIS are deliberately
 *  separate env vars so a backfill run and a prune run can never be confused for one another. */
function parsePrunePis() {
    const raw = process.env.PRUNE_PIS || '';
    const labels = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
        .map(s => (/^\d+(\.\d+)+$/.test(s) ? `PI-${s}` : s.toUpperCase()));

    return [...new Set(labels)];
}

/**
 * One-off, manually-triggered cleanup: deletes the named PI shard file(s) and their `index.json` entries.
 * This is the *only* way an old PI shard ever goes away — the regular sync (`sync-jira.js`'s default
 * current-PI-only mode, and `BACKFILL_PIS`) never deletes any PI's data on its own; shards accumulate
 * indefinitely by design (see CLAUDE.md's "Jira issues" section). Refuses to prune whichever PI
 * `index.json` currently lists as `currentPi`, since that would leave the dashboard with no current PI to
 * default to — rerun this once that PI is no longer current, if it still needs pruning then.
 */
function main() {
    const requested = parsePrunePis();

    if (!requested.length) {
        fail('No PI(s) given — set PRUNE_PIS (comma/space-separated, e.g. "PI-26.4, PI-26.5" or "26.4 26.5").');
    }

    const indexPath = path.join(JIRA_ISSUES_DIR, 'index.json');

    if (!fs.existsSync(indexPath)) {
        fail(`${indexPath} does not exist — nothing to prune.`);
    }

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const pis = Array.isArray(index.pis) ? index.pis : [];

    const skippedCurrent = requested.filter(pi => pi === index.currentPi);

    skippedCurrent.forEach(pi => console.warn(`Skipping ${pi} — it's the current PI, refusing to prune it.`));

    // Everything except the current PI gets permanently excluded (added to PRUNED_PIS_PATH), regardless
    // of whether it currently has a shard/index entry at all — the point is "never let this come back,"
    // not just "remove it if it happens to exist right now."
    const toExclude = requested.filter(pi => pi !== index.currentPi);

    if (!toExclude.length) {
        console.log('Nothing to prune.');

        return;
    }

    const toPrune = toExclude.filter(pi => pis.some(e => e.pi === pi));
    const alreadyAbsent = toExclude.filter(pi => !pis.some(e => e.pi === pi));

    alreadyAbsent.forEach(pi =>
        console.log(`${pi} isn't currently in ${indexPath} — adding it to the pruned-PI list anyway, so it can't come back later.`)
    );

    toPrune.forEach(pi => {
        const entry = pis.find(e => e.pi === pi);
        const filePath = path.join(JIRA_ISSUES_DIR, entry.file);

        if (isWithinJiraIssuesDir(filePath) && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });

    const remaining = pis.filter(e => !toPrune.includes(e.pi));

    fs.writeFileSync(indexPath, JSON.stringify({ currentPi: index.currentPi, pis: remaining }, null, 2));
    writePrunedPis([...readPrunedPis(), ...toExclude]);

    console.log(`Pruned ${toPrune.length} PI shard(s) now, excluded ${toExclude.length} PI(s) permanently: ${toExclude.join(', ')}.`);
}

if (require.main === module) {
    main();
}

module.exports = { parsePrunePis };
