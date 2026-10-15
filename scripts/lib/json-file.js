const fs = require('fs');

/**
 * Reads a JSON file. With a `fallback` argument, a missing file yields that fallback instead of throwing —
 * the "read existing JSON (or `{}`/`[]` if absent)" step every data-mutating script starts with. A file
 * that exists but isn't valid JSON still throws, on purpose: silently treating a corrupt data file as
 * empty would let the next write wipe it.
 */
function readJson(filePath, ...fallback) {
    if (fallback.length && !fs.existsSync(filePath)) {
        return fallback[0];
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Writes pretty-printed JSON with a trailing newline — the exact format every data file here uses. */
function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

module.exports = { readJson, writeJson };
