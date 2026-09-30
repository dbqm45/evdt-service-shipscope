const fs = require('fs');
const path = require('path');

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

const DATA_PATH = safeRelativePath(process.env.SYNC_META_PATH || 'docs/data/sync-meta.json', 'SYNC_META_PATH');

// Only called from the branch of orchestrate-full-sync.yml's `prepare` job that syncs every tracked
// component (cron safety net, manual run, or an unknown/malformed dispatch) — never for a single-component
// repository_dispatch — so this timestamp means "every component's deployments, plus Jira, were
// successfully re-synced as of this time," not just "something ran."
const existing = fs.existsSync(DATA_PATH) ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) : {};
const lastFullSync = new Date().toISOString();

existing.lastFullSync = lastFullSync;

fs.writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2) + '\n');
console.log(`Recorded full sync at ${lastFullSync}`);