// Suggested flag -> issue links (ADR-003, ROADMAP increment 5). When a deployment changes flags in a flags file read
// from code (lib/code-flags.js), the commits between the previous read and this one that touched that file are the
// ones that changed the flags; the Jira keys in their messages are suggested for each changed flag. A suggestion is
// only that: an admin links it (Settings → Flags) or dismisses it, and a dismissed one is never suggested again.
//
// Two GitHub calls, only when flags changed: the compare of the two refs (its commits, and whether the file is among
// its changed files) and the commits touching the file up to the new ref; the issue keys come from their intersection.
const { withScope } = require('./scope');
const { assertAdmin } = require('./tenants');
const { githubGet } = require('./github-app');
const { extractIssueKeys } = require('./deployment-logic');
const { planLinkSuggestions } = require('./flags-logic');
const { FlagNotFoundError } = require('./flags');

// GitHub's compare answers with at most 250 commits; the file's history is read as far as one page.
const FILE_COMMITS_PAGE = 100;

/**
 * The issue keys named by the commits between two refs that touched one file. Empty for a rollback (the new ref is
 * behind the old one) or when the file did not change between them.
 *
 * @param {{ token: string, fullName: string, file: string, fromRef: string, toRef: string, fetch?: typeof fetch }} input
 * @returns {Promise<string[]>}
 */
async function issueKeysOfFileCommits({ token, fullName, file, fromRef, toRef, fetch: fetchFn }) {
    const compare = await githubGet({ token, path: `/repos/${fullName}/compare/${encodeURIComponent(fromRef)}...${encodeURIComponent(toRef)}`, fetch: fetchFn });
    if (!compare || !Array.isArray(compare.commits) || compare.status === 'behind') return [];
    if (Array.isArray(compare.files) && !compare.files.some((f) => f && f.filename === file)) return [];
    const touching = await githubGet({
        token, path: `/repos/${fullName}/commits?sha=${encodeURIComponent(toRef)}&path=${encodeURIComponent(file)}&per_page=${FILE_COMMITS_PAGE}`, fetch: fetchFn,
    });
    const shas = new Set((Array.isArray(touching) ? touching : []).map((c) => c && c.sha).filter((sha) => typeof sha === 'string'));
    const keys = compare.commits
        .filter((c) => c && shas.has(c.sha) && c.commit && typeof c.commit.message === 'string')
        .flatMap((c) => extractIssueKeys(c.commit.message));
    return [...new Set(keys)].sort();
}

/**
 * Adds suggestions to the changed flags of one reading: the issue keys of the commits that changed the file.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, token: string, fullName: string, file: string, fromRef: string, toRef: string, changedKeys: string[], fetch?: typeof fetch }} input
 * @returns {Promise<{ issueKeys: string[], flags: number }>} what was suggested to how many flags
 */
async function suggestLinks(pool, { tenantId, token, fullName, file, fromRef, toRef, changedKeys, fetch: fetchFn }) {
    if (!changedKeys.length || !fromRef || fromRef === toRef) return { issueKeys: [], flags: 0 };
    const issueKeys = await issueKeysOfFileCommits({ token, fullName, file, fromRef, toRef, fetch: fetchFn });
    if (!issueKeys.length) return { issueKeys, flags: 0 };
    return withScope(pool, { tenantId }, async (client) => {
        const { rows } = await client.query(
            'SELECT key, jira_keys, manual_jira_keys, suggested_jira_keys, dismissed_jira_keys FROM flags WHERE tenant_id = $1 AND key = ANY($2)',
            [tenantId, changedKeys]
        );
        const plan = planLinkSuggestions({ flags: rows, issueKeys });
        for (const [key, suggested] of plan) {
            await client.query('UPDATE flags SET suggested_jira_keys = $3 WHERE tenant_id = $1 AND key = $2', [tenantId, key, suggested]);
        }
        return { issueKeys, flags: plan.size };
    });
}

/**
 * An admin's answer to one suggestion: `accept` links the issue to the flag by hand (manual_jira_keys), otherwise it
 * is dismissed for good. Either way it is no longer suggested.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, key: string, jiraKey: string, accept: boolean }} input
 * @returns {Promise<{ key: string, manualJiraKeys: string[], suggestedJiraKeys: string[] }>}
 * @throws {FlagNotFoundError}
 */
async function answerLinkSuggestion(pool, { tenantId, actorUserId, key, jiraKey, accept }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [row] } = await client.query(
            accept
                ? `UPDATE flags SET suggested_jira_keys = array_remove(suggested_jira_keys, $3),
                       manual_jira_keys = ARRAY(SELECT DISTINCT k FROM unnest(manual_jira_keys || ARRAY[$3]) AS k ORDER BY k)
                   WHERE tenant_id = $1 AND key = $2 RETURNING manual_jira_keys, suggested_jira_keys`
                : `UPDATE flags SET suggested_jira_keys = array_remove(suggested_jira_keys, $3),
                       dismissed_jira_keys = ARRAY(SELECT DISTINCT k FROM unnest(dismissed_jira_keys || ARRAY[$3]) AS k ORDER BY k)
                   WHERE tenant_id = $1 AND key = $2 RETURNING manual_jira_keys, suggested_jira_keys`,
            [tenantId, key, jiraKey]
        );
        if (!row) throw new FlagNotFoundError(`No flag ${key}`);
        return { key, manualJiraKeys: row.manual_jira_keys, suggestedJiraKeys: row.suggested_jira_keys };
    });
}

module.exports = { issueKeysOfFileCommits, suggestLinks, answerLinkSuggestion };
