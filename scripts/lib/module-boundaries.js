const fs = require('fs');
const path = require('path');

const REQUIRE_RE = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;

/** Recursively lists `.js` files under `dir`, skipping any directory named in `exclude`. */
function listJsFiles(dir, exclude = []) {
    if (!fs.existsSync(dir)) return [];
    const out = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (exclude.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) out.push(...listJsFiles(full, exclude));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }

    return out;
}

/** Every `require('<relative path>')` call in `file`, resolved to an absolute path, with its line number. */
function relativeRequiresIn(file) {
    const requires = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    lines.forEach((lineText, i) => {
        for (const match of lineText.matchAll(REQUIRE_RE)) {
            const specifier = match[2];
            if (!specifier.startsWith('.')) continue; // npm package or Node builtin — not a tree boundary
            requires.push({ line: i + 1, text: lineText.trim(), resolved: path.resolve(path.dirname(file), specifier) });
        }
    });

    return requires;
}

/** True when `resolved` is `root` itself or somewhere inside it. */
function isInside(resolved, root) {
    return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Finds `require()` calls that cross a module boundary this repo treats as a hard dependency edge:
 * root `scripts/` (file-based sync, zero npm dependencies) must never require from `server/` (the SaaS
 * backend, which has its own `package.json`/`node_modules`) and vice versa, and `docs/app-*.js` (classic
 * `<script>` tags, no CommonJS at all, loaded straight into a browser) must never call `require()`.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @returns {Array<{ file: string, line: number, text: string }>} relative-to-`repoRoot` violations, if any
 */
function findBoundaryViolations(repoRoot) {
    const violations = [];
    const scriptsRoot = path.join(repoRoot, 'scripts');
    const serverRoot = path.join(repoRoot, 'server');
    const docsRoot = path.join(repoRoot, 'docs');

    const forbid = (files, forbiddenRoot) => {
        for (const file of files) {
            for (const req of relativeRequiresIn(file)) {
                if (isInside(req.resolved, forbiddenRoot)) {
                    violations.push({ file: path.relative(repoRoot, file), line: req.line, text: req.text });
                }
            }
        }
    };

    forbid(listJsFiles(scriptsRoot), serverRoot);
    forbid(listJsFiles(serverRoot, ['node_modules']), scriptsRoot);

    for (const name of fs.readdirSync(docsRoot).filter((f) => /^app-.*\.js$/.test(f))) {
        const full = path.join(docsRoot, name);
        fs.readFileSync(full, 'utf8').split('\n').forEach((lineText, i) => {
            if (/\brequire\(/.test(lineText)) {
                violations.push({ file: path.relative(repoRoot, full), line: i + 1, text: lineText.trim() });
            }
        });
    }

    return violations;
}

module.exports = { findBoundaryViolations };
