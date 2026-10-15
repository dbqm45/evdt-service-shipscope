const path = require('path');

/** Logs `Error: <message>` and exits non-zero — the one failure shape every script's startup validation
 *  shares, so the message always looks the same in a workflow log. */
function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

/** Rejects absolute paths and `..` segments in an env-supplied path (every script here is meant to read
 *  and write only inside its checkout), returning the normalized relative path otherwise. */
function safeRelativePath(inputPath, label) {
    const normalized = path.normalize(inputPath);

    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        fail(`${label} "${inputPath}" is not a safe relative path — refusing to use it.`);
    }

    return normalized;
}

module.exports = { fail, safeRelativePath };
