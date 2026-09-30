const fs = require('fs');
const path = require('path');
const { appendFlagHistoryEntries } = require('./lib/flag-history');
const ENVIRONMENTS = ['test', 'qa', 'prod'];

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function safeRelativePath(inputPath, label) {
    const normalized = path.normalize(inputPath);

    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        fail(`${label} "${inputPath}" is not a safe relative path — refusing to use it.`);
    }

    return normalized;
}

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
const COMPONENT = process.env.COMPONENT || '';

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

function main() {
    const flagPartsDirs = findFlagPartsDirs(SEARCH_ROOT);

    if (!flagPartsDirs.length) {
        console.log(`No flag-parts directories found under "${SEARCH_ROOT}" — nothing to resolve.`);
        return;
    }

    console.log(`Found ${flagPartsDirs.length} flag-parts director${flagPartsDirs.length === 1 ? 'y' : 'ies'}.`);

    const resolved = resolveAllDomains(flagPartsDirs, extractFlagParts);
    const flagStates = fs.existsSync(FLAG_STATES_PATH) ? JSON.parse(fs.readFileSync(FLAG_STATES_PATH, 'utf8')) : {};
    // scaffold-flags-meta.js discovers flags via a different extractor (discoverAllFlags, over
    // *.generated.ts files) than this script (extractFlagParts, over flag-parts/ dirs) — a flag found
    // by only one of the two would otherwise end up with state/history but no metadata, invisible
    // anywhere that reads flagsMeta. Same idempotent-stub pattern sync-runtime-be-flags.js already uses.
    const flagsMeta = fs.existsSync(FLAGS_META_PATH) ? JSON.parse(fs.readFileSync(FLAGS_META_PATH, 'utf8')) : {};
    const now = new Date().toISOString();
    let changedCount = 0;
    const scaffolded = [];
    const historyEntries = [];

    for (const [key, envValues] of Object.entries(resolved)) {
        if (!flagsMeta[key]) {
            flagsMeta[key] = {
                description: 'TODO — describe this flag',
                source: 'build',
                jiraKeys: [],
                components: COMPONENT ? [COMPONENT] : [],
                createdAt: now,
            };
            scaffolded.push(key);
        }

        if (!flagStates[key]) {
            flagStates[key] = {};
        }

        for (const env of ENVIRONMENTS) {
            if (!(env in envValues)) continue;

            const newValue = envValues[env];

            if (!flagStates[key][env]) flagStates[key][env] = {};

            const existing = flagStates[key][env].build;

            if (!existing || existing.enabled !== newValue) {
                flagStates[key][env].build = { enabled: newValue, changedAt: now, changedBy: CHANGED_BY };
                historyEntries.push({ key, env, source: 'build', enabled: newValue, changedAt: now, changedBy: CHANGED_BY });
                changedCount++;
            }
        }
    }

    if (scaffolded.length) {
        fs.writeFileSync(FLAGS_META_PATH, JSON.stringify(flagsMeta, null, 2) + '\n');
    }

    fs.writeFileSync(FLAG_STATES_PATH, JSON.stringify(flagStates, null, 2) + '\n');
    appendFlagHistoryEntries(FLAG_STATE_HISTORY_PATH, historyEntries);
    console.log(
        `Resolved ${Object.keys(resolved).length} build-time flag(s); ${changedCount} state(s) changed` +
        (scaffolded.length ? `, scaffolded ${scaffolded.length} missing flags-meta.json stub(s): ${scaffolded.join(', ')}.` : '.')
    );
}

module.exports = { findFlagPartsDirs, extractFlagParts, resolveAllDomains };

if (require.main === module) {
    main();
}