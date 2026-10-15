const fs = require('fs');
const path = require('path');
const { safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');

const DATA_PATH = safeRelativePath(process.env.SYNC_META_PATH || 'docs/data/sync-meta.json', 'SYNC_META_PATH');

// Only called from the branch of orchestrate-full-sync.yml's `prepare` job that syncs every tracked
// component (cron safety net, manual run, or an unknown/malformed dispatch) — never for a single-component
// repository_dispatch — so this timestamp means "every component's deployments, plus Jira, were
// successfully re-synced as of this time," not just "something ran."
const existing = readJson(DATA_PATH, {});
const lastFullSync = new Date().toISOString();

existing.lastFullSync = lastFullSync;

writeJson(DATA_PATH, existing);
console.log(`Recorded full sync at ${lastFullSync}`);