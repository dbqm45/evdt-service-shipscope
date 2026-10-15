const path = require('path');
const { safeRelativePath } = require('./cli');

// Env-derived configuration shared by every sync-jira module. Read once at require time, exactly as the
// original single-file script did, so behavior (including the exit on an unsafe JIRA_ISSUES_DIR) is
// unchanged.
const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY } = process.env;
const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH || 'docs/data/deployments.json';
// Editable onboarding config, same "not bot-generated data" role as docs/components.json — deliberately
// not under docs/data/. Absent/empty = no restriction, same nullable-means-unconfirmed spirit as
// components.json's featureFlagsIncluded, so existing setups keep syncing every space unchanged until
// someone opts in.
const SPACES_PATH = process.env.SPACES_PATH || 'docs/jira-spaces.json';
// Default (unset/anything but 'true'): a board/active-sprint lookup failure degrades softly — warn and
// skip that board's contribution, same as a board that's genuinely not found. Opt-in 'true': throw
// `JiraBoardLookupError` and fail the whole run instead. Flipped back to soft-degrade-by-default after the
// strict behavior's first real-world trigger (a `401` on the Jira Agile API — see CLAUDE.md's "Jira issues"
// section). Kept as an env var so the stricter run-fails-loud behavior stays one setting away.
const JIRA_BOARD_LOOKUP_STRICT = process.env.JIRA_BOARD_LOOKUP_STRICT === 'true';

// One file per PI (docs/data/jira-issues/PI-27.3.json) plus an index.json — replaces the single, ever-
// growing jira-issues.json so Product view/Release Notes/Insights can each load just the one PI they're
// currently showing instead of every issue ShipScope has ever synced.
const JIRA_ISSUES_DIR = safeRelativePath(process.env.JIRA_ISSUES_DIR || 'docs/data/jira-issues', 'JIRA_ISSUES_DIR');
// Persistent "stay pruned" list — see readPrunedPis() in jira-shards.js.
const PRUNED_PIS_PATH = path.join(JIRA_ISSUES_DIR, 'pruned-pis.json');

const AUTH_HEADER_VALUE = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`;

module.exports = {
    JIRA_BASE_URL,
    JIRA_PROJECT_KEY,
    DEPLOYMENTS_PATH,
    SPACES_PATH,
    JIRA_BOARD_LOOKUP_STRICT,
    JIRA_ISSUES_DIR,
    PRUNED_PIS_PATH,
    AUTH_HEADER_VALUE,
};
