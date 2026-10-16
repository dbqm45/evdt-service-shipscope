const fs = require('fs');
const path = require('path');
const { fail, safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');
const { appendFlagHistoryEntries } = require('./lib/flag-history');
const { applyObservations } = require('./lib/flag-ingest');
const { resolveActorName } = require('./lib/github-users');
const ENVIRONMENTS = ['test', 'qa', 'prod'];

const SEARCH_ROOT = safeRelativePath(process.env.FLAGS_SEARCH_ROOT || 'domains', 'FLAGS_SEARCH_ROOT');
const FLAG_STATES_PATH = safeRelativePath(process.env.FLAG_STATES_PATH || 'status-repo/docs/data/flag-states.json', 'FLAG_STATES_PATH');
const FLAG_STATE_HISTORY_PATH = safeRelativePath(
    process.env.FLAG_STATE_HISTORY_PATH || 'status-repo/docs/data/flag-state-history.json',
    'FLAG_STATE_HISTORY_PATH'
);
const FLAGS_META_PATH = safeRelativePath(
    process.env.FLAGS_META_PATH || 'status-repo/docs/data/flags-meta.json',
    'FLAGS_META_PATH'
);
const CHANGED_BY = process.env.CHANGED_BY || 'resolve-all-flag-states-bot';
const COMPONENT = process.env.COMPONENT;

if (!COMPONENT) {
    fail('Missing COMPONENT');
}

function findFlagPartsDirs(dir) {
    let results = [];

    if (!fs.existsSync(dir)) {
        return results;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (entry.name === 'flag-parts') {
            results.push(full);
        } else {
            results = results.concat(findFlagPartsDirs(full));
        }
    }

    return results;
}

function extractFlagParts(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const bodyMatch = content.match(/=\s*{([\s\S]*?)};/);

    if (!bodyMatch) {
        return {};
    }

    const body = bodyMatch[1];
    const result = {};
    const propRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(true|false)/g;
    let m;

    while ((m = propRegex.exec(body)) !== null) {
        result[m[1]] = m[2] === 'true';
    }

    return result;
}

function resolveAllDomains(flagPartsDirs, readFlagParts) {
    const resolved = {};

    for (const dir of flagPartsDirs) {
        const defaults = readFlagParts(path.join(dir, 'default.ts'));

        for (const env of ENVIRONMENTS) {
            const override = readFlagParts(path.join(dir, `${env}.ts`));
            const merged = { ...defaults, ...override };

            for (const [key, value] of Object.entries(merged)) {
                if (!resolved[key]) {
                    resolved[key] = {};
                }

                resolved[key][env] = value;
            }
        }
    }

    return resolved;
}

function main(changedBy = CHANGED_BY) {
    const flagPartsDirs = findFlagPartsDirs(SEARCH_ROOT);

    if (!flagPartsDirs.length) {
        console.log(`No flag-parts directories found under "${SEARCH_ROOT}" — nothing to resolve.`);
        return;
    }

    console.log(`Found ${flagPartsDirs.length} flag-parts director${flagPartsDirs.length === 1 ? 'y' : 'ies'}.`);

    const resolved = resolveAllDomains(flagPartsDirs, extractFlagParts);
    const flagStates = readJson(FLAG_STATES_PATH, {});
    // scaffold-flags-meta.js discovers flags via a different extractor (discoverAllFlags, over
    // *.generated.ts files) than this script (extractFlagParts, over flag-parts/ dirs) — a flag found
    // by only one of the two would otherwise end up with state/history but no metadata, invisible
    // anywhere that reads flagsMeta. Same idempotent-stub pattern sync-runtime-be-flags.js already uses.
    const flagsMeta = readJson(FLAGS_META_PATH, {});
    const now = new Date().toISOString();

    const { changedCount, metaChanged, scaffolded, historyEntries } = applyObservations({
        flagStates,
        flagsMeta,
        valuesByKey: resolved,
        component: COMPONENT,
        source: 'build',
        changedBy,
        now,
    });

    if (metaChanged) {
        writeJson(FLAGS_META_PATH, flagsMeta);
    }

    writeJson(FLAG_STATES_PATH, flagStates);
    appendFlagHistoryEntries(FLAG_STATE_HISTORY_PATH, historyEntries);
    console.log(
        `Resolved ${Object.keys(resolved).length} build-time flag(s); ${changedCount} state(s) changed` +
        (scaffolded.length ? `, scaffolded ${scaffolded.length} missing flags-meta.json stub(s): ${scaffolded.join(', ')}.` : '.')
    );
}

if (require.main === module) {
    // CHANGED_BY is the GitHub login of whoever triggered the run; store their display name instead when
    // they have one (as the Deployment History does), else the login.
    resolveActorName(process.env.CHANGED_BY, process.env.GITHUB_TOKEN)
        .then(name => main(name || CHANGED_BY))
        .catch(e => { console.error(e); process.exit(1); });
}
