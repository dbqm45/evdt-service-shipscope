const fs = require('fs');
const path = require('path');
const { fail, safeRelativePath } = require('./lib/cli');
const { readJson, writeJson } = require('./lib/json-file');
const { appendFlagHistoryEntries } = require('./lib/flag-history');
const { resolveActorName } = require('./lib/github-users');

const DATA_PATH = safeRelativePath(process.env.FLAG_STATES_PATH || 'docs/data/flag-states.json', 'FLAG_STATES_PATH');
const FLAG_STATE_HISTORY_PATH = safeRelativePath(
    process.env.FLAG_STATE_HISTORY_PATH || 'docs/data/flag-state-history.json',
    'FLAG_STATE_HISTORY_PATH'
);
const FLAGS_META_PATH = safeRelativePath(process.env.FLAGS_META_PATH || 'docs/data/flags-meta.json', 'FLAGS_META_PATH');
const VALID_ENVIRONMENTS = ['test', 'qa', 'prod'];
const { FLAG_KEY, ENVIRONMENT, ENABLED, CHANGED_BY } = process.env;

if (!FLAG_KEY) {
    fail('Missing FLAG_KEY');
}

const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
if (DANGEROUS_KEYS.includes(FLAG_KEY)) {
    fail(`FLAG_KEY "${FLAG_KEY}" is not a valid flag key.`);
}
if (!ENVIRONMENT) {
    fail('Missing ENVIRONMENT');
}
if (ENABLED === undefined || ENABLED === '') {
    fail('Missing ENABLED (expected "true" or "false")');
}

if (ENABLED !== 'true' && ENABLED !== 'false') {
    fail(`ENABLED must be exactly "true" or "false", got "${ENABLED}"`);
}
if (!VALID_ENVIRONMENTS.includes(ENVIRONMENT)) {
    fail(`Unknown environment "${ENVIRONMENT}" — expected one of ${VALID_ENVIRONMENTS.join(', ')}`);
}

const states = readJson(DATA_PATH);
const flagsMeta = readJson(FLAGS_META_PATH, {});

if (!states[FLAG_KEY]) {
    fail(
        `Unknown flag "${FLAG_KEY}" — it must already exist in ${DATA_PATH}. ` +
        `New flags are created via a code PR (flags-meta.json), not via this endpoint.`
    );
}

const meta = flagsMeta[FLAG_KEY];
const source = meta && meta.source === 'runtime-be' ? 'runtime-be' : 'build';
const enabledBool = ENABLED === 'true';
const changedAt = new Date().toISOString();
const changedBy = CHANGED_BY || 'backend-service';

if (!states[FLAG_KEY][ENVIRONMENT]) {
    states[FLAG_KEY][ENVIRONMENT] = {};
}

const existing = states[FLAG_KEY][ENVIRONMENT][source];

// Same idempotency convention every other data-mutating script in this repo already follows (see
// CLAUDE.md) — a retried/duplicate `repository_dispatch: flag-changed` webhook for a value that's
// already current must be a no-op, not a fake "flip" that pollutes flag-state-history.json and churns
// an otherwise-unnecessary commit.
if (existing && existing.enabled === enabledBool) {
    console.log(`No change: ${FLAG_KEY}.${ENVIRONMENT}.${source} is already enabled=${enabledBool} — skipping write.`);
    return;
}

// CHANGED_BY is a GitHub login when a person triggered this; store their display name when they have one
// (as the Deployment History does), else the login. Resolved only after the no-op check above, so a
// duplicate dispatch costs no API call.
(async () => {
    const changedByName = await resolveActorName(changedBy, process.env.GITHUB_TOKEN);

    // Preserve the existing `component` tag (if any) rather than dropping it — this script only ever
    // flips enabled/changedAt/changedBy for a key/env/source that must already exist (see the "Unknown
    // flag" check above), it never re-attributes ownership the way resolve-all-flag-states.js/
    // sync-runtime-be-flags.js do, and it has no COMPONENT env var of its own to set one from. Found and
    // fixed as a real bug: dropping it silently un-owned every flag this script ever touched, defeating
    // the cross-component collision guard those two scripts enforce on their own writes.
    states[FLAG_KEY][ENVIRONMENT][source] = {
        enabled: enabledBool,
        changedAt,
        changedBy: changedByName,
        ...(existing && existing.component ? { component: existing.component } : {}),
    };

    writeJson(DATA_PATH, states);
    appendFlagHistoryEntries(FLAG_STATE_HISTORY_PATH, [
        { key: FLAG_KEY, env: ENVIRONMENT, source, enabled: enabledBool, changedAt, changedBy: changedByName },
    ]);
    console.log(`Updated ${FLAG_KEY}.${ENVIRONMENT}.${source} -> enabled=${enabledBool} (by ${changedByName})`);
})().catch(e => { console.error(e); process.exit(1); });
