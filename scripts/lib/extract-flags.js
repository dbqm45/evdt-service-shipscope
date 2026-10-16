const fs = require('fs');
const path = require('path');

function findGeneratedFlagFiles(dir) {
    let results = [];

    if (!fs.existsSync(dir)) {
        return results;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            results = results.concat(findGeneratedFlagFiles(full));
        } else if (/\.generated\.ts$/.test(entry.name)) {
            results.push(full);
        }
    }
    return results;
}

function extractFlagKeys(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const bodyMatch = content.match(/=\s*{([\s\S]*?)}/);
    const body = bodyMatch ? bodyMatch[1] : content;
    const propRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(true|false)\b/g;
    const keys = [];
    let match;

    while ((match = propRegex.exec(body)) !== null) {
        keys.push(match[1]);
    }

    return keys;
}

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

module.exports = { extractFlagKeys, discoverAllFlags };