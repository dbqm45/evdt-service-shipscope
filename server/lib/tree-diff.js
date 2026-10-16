// Pure helpers for comparing two git trees (the listing GitHub returns from
// GET /git/trees/{sha}?recursive=1) — used by lib/env-drift.js to answer "does the code of two environments
// actually differ", independent of how many commits separate them. A copy of scripts/lib/tree-diff.js
// (server/ deploys alone and can't require from scripts/); a fix to one belongs in both. Without the
// file-based parseIgnorePaths(): here the patterns come validated from tracked_repos.drift_ignore_paths.

/** Max changed paths kept on a drift record (and so shown in the modal); the full count is always kept. */
const MAX_DIFF_PATHS = 20;

/**
 * Compiles one `driftIgnorePaths` entry (tracked_repos.drift_ignore_paths) into a predicate over repo-relative paths:
 *  - `dir/`        — everything under that directory (anchored at the repo root);
 *  - `a/b.txt`     — that exact path (a pattern containing `/` is anchored at the repo root);
 *  - `README.md`   — a pattern without `/` matches the file name at any depth;
 *  - `*` inside a pattern matches any characters except `/`.
 */
function compileIgnorePattern(pattern) {
    const p = String(pattern).trim();

    if (!p) return () => false;

    if (p.endsWith('/')) {
        const dir = p.replace(/^\/+/, '');

        return path => path.startsWith(dir);
    }

    const source = p.replace(/^\/+/, '').split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    const re = new RegExp(p.includes('/') ? `^${source}$` : `(^|/)${source}$`);

    return path => re.test(path);
}

/**
 * Diffs two recursive tree listings by path + blob SHA. Returns every path that was added, removed or modified
 * (a rename is therefore two paths), split into those kept and those matched by an ignore pattern.
 * Returns null when either listing is missing or was truncated by GitHub (100k entries / 7 MB) — a partial
 * listing can't prove two trees equal, so the caller must treat that as "unknown", never as "no difference".
 */
function diffTrees(treeA, treeB, ignorePatterns = []) {
    if (!treeA || !treeB || treeA.truncated || treeB.truncated) return null;

    const toMap = tree => new Map((tree.tree || []).filter(e => e.type !== 'tree').map(e => [e.path, e.sha]));
    const a = toMap(treeA);
    const b = toMap(treeB);
    const changed = [];

    for (const [p, sha] of a) {
        if (b.get(p) !== sha) changed.push(p);
    }
    for (const p of b.keys()) {
        if (!a.has(p)) changed.push(p);
    }

    changed.sort();

    const ignorers = ignorePatterns.map(compileIgnorePattern);
    const paths = [];
    let ignored = 0;

    for (const p of changed) {
        if (ignorers.some(match => match(p))) ignored += 1;
        else paths.push(p);
    }

    return { files: paths.length, paths: paths.slice(0, MAX_DIFF_PATHS), ignored };
}

module.exports = { diffTrees };
