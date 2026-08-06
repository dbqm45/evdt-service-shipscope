// scripts/lib/extract-flags.js
//
// Shared by check-flags-metadata.js and scaffold-flags-meta.js so both
// always agree on exactly which properties count as "flags".
//
// IMPORTANT: the VendorFlags interface uses an index signature
// ([k: string]: unknown), so it carries no per-property type information —
// we can't tell a boolean flag from a string config value by looking at the
// interface anymore. Instead we read the *.generated.ts file (the actual
// merged object with concrete values) and classify by the VALUE'S literal
// type: `true`/`false` => flag, anything else (string, number, etc.) => config,
// intentionally excluded.

const fs = require('fs');
const path = require('path');

function findGeneratedFlagFiles(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            results = results.concat(findGeneratedFlagFiles(full));
        } else if (/\.generated\.ts$/.test(entry.name)) {
            // Matches e.g. flags.generated.ts in any domain's config folder
            results.push(full);
        }
    }
    return results;
}

function extractFlagKeys(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    // Grab the body of the exported object literal (after the first `= {`)
    const bodyMatch = content.match(/=\s*{([\s\S]*?)}/);
    const body = bodyMatch ? bodyMatch[1] : content;
    // Only properties whose VALUE is a literal true/false count as flags —
    // string/number values (URLs, config) are intentionally excluded.
    const propRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(true|false)\b/g;
    const keys = [];
    let match;
    while ((match = propRegex.exec(body)) !== null) {
        keys.push(match[1]);
    }
    return keys;
}

/** Returns [{ key, file }] for every boolean flag found across all *.generated.ts files under root. */
function discoverAllFlags(root) {
    const files = findGeneratedFlagFiles(root);
    const flags = [];
    for (const file of files) {
        for (const key of extractFlagKeys(file)) {
            flags.push({ key, file });
        }
    }
    return flags;
}

module.exports = { findGeneratedFlagFiles, extractFlagKeys, discoverAllFlags };