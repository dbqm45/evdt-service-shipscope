// scripts/resolve-flags.js
//
// Merges domains/{domain}/src/config/flag-parts/default.ts with the
// environment-specific override file, the same way Angular's
// fileReplacements does at build time — but as a standalone script so we can
// attach the resolved values to a deployment record without running a full
// Angular build.

const fs = require('fs');
const path = require('path');

const { DOMAIN, ENVIRONMENT } = process.env;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

if (!DOMAIN) fail('Missing DOMAIN (e.g. "vendor")');
if (!ENVIRONMENT) fail('Missing ENVIRONMENT (e.g. "test", "qa", "prod")');

function extractFlagParts(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const bodyMatch = content.match(/flagParts[^{]*\{([\s\S]*?)\};/);
    if (!bodyMatch) return {};
    const body = bodyMatch[1];
    const result = {};
    const propRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(true|false)/g;
    let m;
    while ((m = propRegex.exec(body)) !== null) {
        result[m[1]] = m[2] === 'true';
    }
    return result;
}

const base = `domains/${DOMAIN}/src/config/flag-parts`;
const defaults = extractFlagParts(path.join(base, 'default.ts'));
const envOverride = extractFlagParts(path.join(base, `${ENVIRONMENT}.ts`));

const resolved = { ...defaults, ...envOverride };
console.log(JSON.stringify(resolved));