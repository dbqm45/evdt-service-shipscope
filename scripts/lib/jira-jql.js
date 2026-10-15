// Pure JQL builders and issue-key derivation — no I/O, safe to unit test directly.

/**
 * The full set of distinct issue keys actually referenced in synced commit messages. Used to scope a Jira
 * search to exactly the tickets ShipScope has evidence of (via a real commit), rather than every ticket in
 * whichever project(s) those tickets happen to belong to (see `main()`).
 */
function deriveIssueKeysFromDeployments(deployments) {
    const keys = new Set();

    for (const dep of deployments) {
        for (const issueKey of dep.relatedIssues || []) {
            if (/^[A-Z]{2,}-[0-9]+$/.test(issueKey)) {
                keys.add(issueKey);
            }
        }
    }

    return [...keys];
}

function projectKeyOf(issueKey) {
    return issueKey.split('-')[0];
}

function buildJql(projectKeys) {
    if (projectKeys.length === 1) {
        return `project = ${projectKeys[0]} ORDER BY updated DESC`;
    }

    return `project in (${projectKeys.join(', ')}) ORDER BY updated DESC`;
}

/**
 * Like `buildJql`, but scoped to exact issue keys instead of whole projects — this is the default search
 * shape (see `main()`): a ticket mentioned once in a commit message shouldn't pull in every other,
 * unrelated ticket that happens to share its project.
 */
function buildJqlForKeys(issueKeys) {
    if (issueKeys.length === 1) {
        return `key = ${issueKeys[0]} ORDER BY updated DESC`;
    }

    return `key in (${issueKeys.join(', ')}) ORDER BY updated DESC`;
}

/**
 * One JQL clause per space with a detected current PI, scoped to that space's own project so a PI-number
 * match on `sprint`/`labels` can't leak in an unrelated ticket from a different project that happens to
 * reuse the same PI numbering. The Sprint field only supports `=`/`!=`/`IN`/`NOT IN`/`IS`/`IS NOT` in JQL —
 * no `~` (CONTAINS) — so matching "every sprint whose name contains the PI number" (e.g. "27.3.1", "27.3.2"
 * for PI 27.3) has to go through real sprint IDs: `sprintIdsByPi[num]`, when the caller resolved one (see
 * `resolveCurrentPiForSpaces`), becomes `sprint in (id1, id2, …)`. A caller with no board context to
 * resolve sprint IDs from (e.g. `runBackfillMode`'s unscoped-project branch) just omits it, and this falls
 * back to the `labels` condition alone rather than ever emitting the invalid `sprint ~` clause — the
 * `labels` half of the OR catches issues tagged with a `PI-X.Y` label instead of (or in addition to) a
 * Sprint value, mirroring the same `pi` extraction priority `fetchAndMapIssuesForJql` already applies.
 */
function buildCurrentPiJql(spacePiResults) {
    const clauses = spacePiResults.map(({ projectKey, piNumbers, sprintIdsByPi }) => {
        const piConditions = [...piNumbers]
            .flatMap(num => {
                const ids = sprintIdsByPi ? sprintIdsByPi[num] : undefined;
                const conditions = [`labels = "PI-${num}"`];

                if (ids && ids.length) {
                    conditions.unshift(`sprint in (${ids.join(',')})`);
                }

                return conditions;
            })
            .join(' OR ');

        return `(project = ${projectKey} AND (${piConditions}))`;
    });

    return clauses.length ? clauses.join(' OR ') : null;
}

module.exports = {
    deriveIssueKeysFromDeployments,
    projectKeyOf,
    buildJql,
    buildJqlForKeys,
    buildCurrentPiJql,
};
