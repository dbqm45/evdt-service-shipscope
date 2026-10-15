const { fetchWithRetry } = require('./jira-api');
const { JIRA_BASE_URL } = require('./jira-config');
const { extractPiFromSprintName, extractPiFromLabel, pickRelevantSprintInfo } = require('./jira-pi');
const { projectKeyOf } = require('./jira-jql');

const TYPE_PRIORITY = ['feat', 'fix', 'chore'];

// Jira issue type names (English and Polish localizations) → ShipScope's four recognized types.
const TYPE_MAP = {
    'Epik': 'Epic', 'Epic': 'Epic',
    'Zadanie': 'Task', 'Task': 'Task',
    'Story': 'Story',
    'Bug': 'Bug',
};

const ISSUE_SEARCH_PAGE_SIZE = 100;
const EPIC_TITLE_LOOKUP_CAP = 100;

function pickBestType(types) {
    for (const t of TYPE_PRIORITY) {
        if (types.includes(t)) {
            return t;
        }
    }

    return types[0] || 'other';
}

/**
 * `allowedProjectKeys` (same set `runFullScopeMode` already resolves from `docs/jira-spaces.json`, or
 * `null` for "no restriction") is applied here too — found and fixed as a real bug: this degraded,
 * Jira-unreachable fallback path used to pull `relatedIssues` from *every* synced deployment regardless of
 * project, meaning an outage could surface a foreign team's issue keys (anything a commit message
 * happened to reference) completely unfiltered, the exact opposite of every other code path's team-scoping
 * guard in this file.
 */
function buildFallbackIssuesFromDeployments(deployments, allowedProjectKeys) {
    const typesByKey = {};

    for (const dep of deployments) {
        for (const key of dep.relatedIssues || []) {
            if (allowedProjectKeys && !allowedProjectKeys.has(projectKeyOf(key))) {
                continue;
            }

            if (!typesByKey[key]) {
                typesByKey[key] = [];
            }

            const type = dep.issueCommitTypes ? dep.issueCommitTypes[key] : null;

            if (type) {
                typesByKey[key].push(type);
            }
        }
    }

    return Object.keys(typesByKey).sort().map(key => ({
        key,
        type: pickBestType(typesByKey[key]),
        title: '—',
        pi: '—',
        status: null,
        statusCategory: null,
        dependencyBlocked: false,
        projectName: null,
        epicKey: null,
        epicTitle: null,
        impediment: false,
        subtasks: null,
        priority: null,
        created: null,
        resolvedAt: null,
    }));
}

async function findSpecialFieldIds(headers) {
    const res = await fetchWithRetry(`${JIRA_BASE_URL}/rest/api/3/field`, { headers });

    if (!res.ok) {
        throw new Error(`Jira API error fetching fields: ${res.status} ${await res.text()}`);
    }

    const fields = await res.json();
    // Match by schema.custom, not by display name — these fields' `name` can be renamed by an admin or
    // returned localized, but every Jira Software instance carries these fixed custom field types
    // regardless of display name.
    const sprintField = fields.find(f => f.schema && f.schema.custom === 'com.pyxis.greenhopper.jira:gh-sprint');
    const epicLinkField = fields.find(f => f.schema && f.schema.custom === 'com.pyxis.greenhopper.jira:gh-epic-link');
    // Unlike Sprint/Epic Link, the "Flagged" impediment marker has no dedicated schema.custom type —
    // Atlassian implements it as an ordinary multi-select custom field, indistinguishable by schema from
    // any other project-specific select field. Name matching (case-insensitive) is the only practical
    // option, same limitation the regex-based flag extractors elsewhere in this repo already accept.
    const flaggedField = fields.find(f => (f.name || '').toLowerCase() === 'flagged');
    // "Team" (cross-team/Advanced Roadmaps planning) has no single, fixed schema.custom type across Jira
    // Cloud instances either (it's been reshaped more than once — legacy Portfolio field, newer "Teams in
    // Jira" field — and which one a given instance has isn't something to assume). Name matching is the
    // only option that doesn't require guessing a type string this repo has no way to verify against this
    // specific instance.
    const teamField = fields.find(f => (f.name || '').toLowerCase() === 'team');

    if (!sprintField) {
        console.warn('Warning: no field with schema "com.pyxis.greenhopper.jira:gh-sprint" found in this Jira instance — PI will not be detected.');
    } else {
        console.log(`Found Sprint field: ${sprintField.id}`);
    }

    // Not finding this one is normal, not a warning: team-managed ("next-gen") projects, and any
    // company-managed project already on Jira's newer issue hierarchy, expose the Epic parent via the
    // standard `parent` field instead of this legacy custom field — `parent` is always requested
    // regardless, so this is only a fallback for instances still on the old Epic Link field.
    if (epicLinkField) {
        console.log(`Found Epic Link field: ${epicLinkField.id}`);
    }

    // Also normal to be missing: not every Jira instance has the "Flagged" field enabled on its board(s)
    // — `impediment` just stays false for every issue when it isn't found.
    if (flaggedField) {
        console.log(`Found Flagged field: ${flaggedField.id}`);
    }

    // Also normal to be missing: the Team-mismatch double-check in mapRawIssue() simply never triggers
    // when this instance has no "Team" field at all.
    if (teamField) {
        console.log(`Found Team field: ${teamField.id}`);
    }

    return {
        sprintFieldId: sprintField ? sprintField.id : null,
        epicLinkFieldId: epicLinkField ? epicLinkField.id : null,
        flaggedFieldId: flaggedField ? flaggedField.id : null,
        teamFieldId: teamField ? teamField.id : null,
    };
}

/**
 * Normalizes a Jira "Team" field value into a plain team-name string, regardless of which shape this
 * instance's Team field happens to return it in (a plain string on some instances, an object with a
 * `name`/`title`/`value` property on others, or an array wrapping either). Returns `null` for anything
 * empty/unrecognized, same "nothing to show" convention as `pickRelevantSprintInfo()`.
 */
function extractTeamName(fieldValue) {
    if (fieldValue === null || fieldValue === undefined) {
        return null;
    }
    if (Array.isArray(fieldValue)) {
        return fieldValue.length ? extractTeamName(fieldValue[0]) : null;
    }
    if (typeof fieldValue === 'string') {
        return fieldValue.trim() || null;
    }
    if (typeof fieldValue === 'object') {
        const name = fieldValue.name || fieldValue.title || fieldValue.value || fieldValue.displayName || null;

        return typeof name === 'string' ? (name.trim() || null) : null;
    }

    return null;
}

/**
 * Like `extractTeamName`, but returns every team name present rather than just the first — the Team field
 * can carry more than one value on some instances, and only checking the first used to let a genuinely
 * matching second (or later) value go unnoticed, found and fixed as a real gap.
 */
function extractTeamNames(fieldValue) {
    if (fieldValue === null || fieldValue === undefined) {
        return [];
    }
    if (Array.isArray(fieldValue)) {
        return fieldValue.map(extractTeamName).filter(Boolean);
    }

    const name = extractTeamName(fieldValue);

    return name ? [name] : [];
}

/** Best-effort: resolves Epic titles for keys that only came from the legacy Epic Link field (which
 *  carries just the key, not a title) — the modern `parent` field already includes the title inline, so
 *  this only ever runs against Jira projects still on the legacy epic-link hierarchy. Capped to one page
 *  (Jira's search endpoint max page size) since this is a nice-to-have enrichment, not core data — any
 *  epic beyond that just keeps showing its bare key instead of a title. */
async function resolveEpicTitles(epicKeys, headers) {
    if (!epicKeys.length) {
        return {};
    }

    const capped = epicKeys.slice(0, EPIC_TITLE_LOOKUP_CAP);
    const jql = `key in (${capped.join(', ')})`;
    const res = await fetchWithRetry(
        `${JIRA_BASE_URL}/rest/api/3/search/jql?maxResults=${capped.length}&fields=summary&jql=${encodeURIComponent(jql)}`,
        { headers }
    );

    if (!res.ok) {
        console.warn(`Warning: could not resolve Epic title(s) for ${capped.join(', ')} (${res.status}) — these will show with just their key.`);
        return {};
    }

    const data = await res.json();
    const titles = {};

    (data.issues || []).forEach(i => { titles[i.key] = i.fields?.summary || null; });

    return titles;
}

/**
 * Best-effort enrichment run once against the merged issue set (primary + current-PI fetches combined),
 * rather than inside each fetch's own cache — an issue whose Epic only got resolved via the *other* fetch
 * would otherwise still show a bare epic key. Mutates `issues` in place.
 */
async function fillMissingEpicTitles(issues, headers) {
    const unresolvedEpicKeys = [...new Set(
        issues.filter(i => i.epicKey && !i.epicTitle).map(i => i.epicKey)
    )];

    if (!unresolvedEpicKeys.length) {
        return;
    }

    const epicTitles = await resolveEpicTitles(unresolvedEpicKeys, headers);

    issues.forEach(i => {
        if (i.epicKey && !i.epicTitle && epicTitles[i.epicKey]) {
            i.epicTitle = epicTitles[i.epicKey];
        }
    });
}

/** Pages through Jira's search/jql endpoint (token-based pagination) and returns every raw issue. */
async function fetchAllRawIssues(jql, headers, fieldsParam) {
    const rawIssues = [];
    let nextPageToken = null;
    let isLastPage = false;
    let pageCounter = 1;

    console.log(`Fetching issues from Jira for JQL: ${jql}`);

    while (!isLastPage) {
        // `jql` must be sent on every page, not just the first — the search/jql endpoint ties
        // nextPageToken to the JQL it was issued for, and rejects the token as invalid/expired if
        // the next request doesn't also carry the same jql.
        let url = `${JIRA_BASE_URL}/rest/api/3/search/jql?maxResults=${ISSUE_SEARCH_PAGE_SIZE}&fields=${fieldsParam}&jql=${encodeURIComponent(jql)}`;

        if (nextPageToken) {
            url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
        }

        const res = await fetchWithRetry(url, { headers });

        if (!res.ok) {
            throw new Error(`Jira API error on page ${pageCounter}: ${res.status} ${await res.text()}`);
        }

        const data = await res.json();

        if (data.warningMessages && data.warningMessages.length) {
            console.warn(`Jira returned warnings on page ${pageCounter}:`, data.warningMessages);
        }

        const pageIssues = data.issues || [];

        rawIssues.push(...pageIssues);

        console.log(`Page ${pageCounter}: fetched ${pageIssues.length} issues. (isLast: ${data.isLast})`);

        nextPageToken = data.nextPageToken || null;
        isLastPage = data.isLast === true || !nextPageToken;
        pageCounter++;
    }

    console.log(`Total raw issues fetched from Jira instance: ${rawIssues.length}`);

    return rawIssues;
}

/**
 * Team evidence for one issue against its own space's configured board/team names: a matching Jira
 * "Team" field value (positive), a populated-but-non-matching one (negative), or a plain label matching
 * one of the configured names (an equally valid positive — the Team field is often left empty in practice,
 * with a label used day to day instead). Nothing is hardcoded — everything is checked against the same
 * config-driven `allowedTeamNames` list.
 */
function evaluateTeamEvidence(issue, allowedTeamNames, teamFieldId) {
    // The Team field can be multi-value on some instances — found and fixed as a real gap: only the first
    // element used to be checked, so a second/later value that actually matched was silently ignored.
    const teamNames = teamFieldId ? extractTeamNames(issue.fields[teamFieldId]) : [];
    const issueLabels = issue.fields.labels || [];
    const lowerAllowed = allowedTeamNames.map(team => team.toLowerCase());
    const matchesAllowedTeamLabel = lowerAllowed.length > 0 &&
        issueLabels.some(label => lowerAllowed.includes(label.toLowerCase()));
    const teamFieldMatchesPositive = lowerAllowed.length > 0 && teamNames.length > 0 &&
        teamNames.some(tn => lowerAllowed.includes(tn.toLowerCase()));
    const teamFieldMatchesNegative = lowerAllowed.length > 0 && teamNames.length > 0 && !teamFieldMatchesPositive;

    return { teamNames, matchesAllowedTeamLabel, teamFieldMatchesPositive, teamFieldMatchesNegative };
}

/**
 * Maps one raw Jira issue to ShipScope's issue shape. Returns `null` for an unrecognized issue type, a
 * `{ __droppedForTeamMismatch }` marker for an issue rejected by the Team-field double-check, or the mapped
 * issue — possibly carrying `__droppedForLabelOnlyNoEvidence`, resolved by `applyScopeFilters()`.
 * Side effect: records the issue's sprint start/end dates into `sprintDates` (keyed by sprint name).
 */
function mapRawIssue(issue, ctx, sprintDates) {
    const {
        sprintFieldId, epicLinkFieldId, flaggedFieldId, teamFieldId,
        boardNamesByProjectName, teamNamesByProjectName, sprintIdsByProjectName,
    } = ctx;

    if (!issue.fields || !issue.fields.issuetype) {
        return null;
    }

    const type = TYPE_MAP[issue.fields.issuetype.name];

    if (!type) {
        return null;
    }

    // The Jira project this issue lives in (e.g. "eMobility Sparks") — shown in the UI as this issue's
    // "space", since one org can split related work across several Jira projects rather than one. Resolved
    // early (not just for the UI field below) so pickRelevantSprintInfo() can scope its sprint pick to this
    // issue's own space's configured board(s).
    const projectName = issue.fields.project?.name || null;
    const allowedBoardNames = (boardNamesByProjectName && projectName && boardNamesByProjectName[projectName]) || [];

    // Double-check against Jira's own "Team" field, independent of the sprint-name-based board match — an
    // Epic in particular often carries no Sprint field at all (its PI comes from a label instead), so the
    // board-name check never even runs for it. Checked against `teamNamesByProjectName` (boards + each
    // space's explicit `teams` config), not `allowedBoardNames` — a space with no board of its own used to
    // apply zero team filtering here no matter what.
    const allowedTeamNames = (teamNamesByProjectName && projectName && teamNamesByProjectName[projectName]) || [];
    const { teamNames, matchesAllowedTeamLabel, teamFieldMatchesPositive, teamFieldMatchesNegative } =
        evaluateTeamEvidence(issue, allowedTeamNames, teamFieldId);

    // Resolved before the Team-field check below so a genuine sprint match against this issue's *own*
    // configured board counts as positive team evidence too.
    const sprintInfo = sprintFieldId ? pickRelevantSprintInfo(issue.fields[sprintFieldId], allowedBoardNames) : null;
    const sprintName = sprintInfo ? sprintInfo.name : null;
    const matchesOwnBoardSprint = allowedBoardNames.length > 0 && sprintInfo !== null;

    if (sprintInfo && !(sprintName in sprintDates)) {
        sprintDates[sprintName] = { startDate: sprintInfo.startDate, endDate: sprintInfo.endDate };
    }

    if (allowedTeamNames.length) {
        // A populated-but-mismatched Team field is a strong negative signal — only forgiven by an equally
        // concrete positive signal: a matching label, OR a sprint that already matched this issue's own
        // configured board (found and fixed as a real bug: that used to lose to a Team-field mismatch).
        if (teamFieldMatchesNegative && !matchesAllowedTeamLabel && !matchesOwnBoardSprint) {
            return { __droppedForTeamMismatch: true, key: issue.key, team: teamNames.join(', ') || null };
        }

        // Fail closed, specifically for a boardless-but-teams-configured space: with no board at all, the
        // sprint-based match can *never* produce a team signal for any issue in this project, so an
        // unpopulated Team field *and* no matching label leaves zero team evidence. A *boarded* space keeps
        // its long-standing, more lenient fallback (mostly Epics whose sprint doesn't resolve).
        if (!teamFieldMatchesPositive && teamNames.length === 0 && !matchesAllowedTeamLabel && !matchesOwnBoardSprint && !allowedBoardNames.length) {
            return { __droppedForTeamMismatch: true, key: issue.key, team: null };
        }
    }

    const labels = issue.fields.labels || [];
    const labelPi = labels.map(extractPiFromLabel).find(Boolean) || null;
    const pi = extractPiFromSprintName(sprintName) || labelPi;
    const piNumber = pi ? pi.replace(/^PI-/, '') : null;

    // Did this issue actually land in the result via the current-PI query's `sprint in (ids)` disjunct, or
    // only via its separate `labels = "PI-X.Y"` one? Only decidable when the caller supplied real
    // sprint-ID knowledge for this project (the current-PI query context) — empty/absent for every other
    // caller, so this never second-guesses those.
    const projectSprintIds = (sprintIdsByProjectName && projectName && sprintIdsByProjectName[projectName]) || {};
    const hasSprintIdKnowledge = Object.keys(projectSprintIds).length > 0;
    const sprintIdsForPi = piNumber && projectSprintIds[piNumber] ? projectSprintIds[piNumber] : null;
    const matchedViaSprintIds = !!(sprintIdsForPi && sprintInfo && sprintInfo.id != null &&
        sprintIdsForPi.map(String).includes(String(sprintInfo.id)));

    // An issue that reached a boarded space's current-PI result ONLY through the `labels =` branch carries
    // no actual evidence it belongs to this board/team — a PI label is organization-wide (the whole ART
    // shares one PI numbering scheme). Still forgiven by the same positive evidence (Team-field or label
    // match) the Team-field check above accepts.
    const labelOnlyNoEvidence = hasSprintIdKnowledge && allowedBoardNames.length > 0 && !!piNumber &&
        !matchedViaSprintIds && !matchesAllowedTeamLabel && !teamFieldMatchesPositive;

    const blockers = (issue.fields.issuelinks || []).filter(link =>
        link.type?.inward === 'is blocked by' && link.inwardIssue &&
        link.inwardIssue.fields?.status?.statusCategory?.key !== 'done'
    );

    // Jira's own "Flagged" impediment marker (the orange flag icon on a card) — orthogonal to `status`: an
    // issue can be "In Progress" and flagged as blocked at the same time. The field's value is an array of
    // `{ value: "Impediment" }` when set, empty/absent otherwise.
    const flaggedValue = flaggedFieldId ? issue.fields[flaggedFieldId] : null;
    const impediment = Array.isArray(flaggedValue) && flaggedValue.length > 0;

    // Sub-task completion — surfaces exactly the gap a parent issue's own status can hide. `null` when
    // there are no sub-tasks at all.
    const rawSubtasks = issue.fields.subtasks || [];
    const subtasks = rawSubtasks.length
        ? { done: rawSubtasks.filter(st => st.fields?.status?.statusCategory?.key === 'done').length, total: rawSubtasks.length }
        : null;

    // Epics don't have an Epic parent of their own. Prefer the modern `parent` field (carries the Epic's
    // title inline); only fall back to the legacy Epic Link custom field (key only — resolved separately,
    // see `fillMissingEpicTitles`) when `parent` isn't populated.
    let epicKey = null;
    let epicTitle = null;

    if (type !== 'Epic') {
        if (issue.fields.parent) {
            epicKey = issue.fields.parent.key;
            epicTitle = issue.fields.parent.fields?.summary || null;
        } else if (epicLinkFieldId && issue.fields[epicLinkFieldId]) {
            epicKey = issue.fields[epicLinkFieldId];
        }
    }

    return {
        key: issue.key,
        type,
        title: issue.fields.summary,
        pi,
        sprint: sprintName,
        status: issue.fields.status?.name || null,
        statusCategory: issue.fields.status?.statusCategory?.key || null,
        dependencyBlocked: blockers.length > 0,
        projectName,
        epicKey,
        epicTitle,
        impediment,
        subtasks,
        priority: issue.fields.priority?.name || null,
        created: issue.fields.created || null,
        resolvedAt: issue.fields.resolutiondate || null,
        ...(blockers.length > 0 ? { dependencyNote: `Blocked by ${blockers[0].inwardIssue.key}: ${blockers[0].inwardIssue.fields.summary}` } : {}),
        ...(labelOnlyNoEvidence ? { __droppedForLabelOnlyNoEvidence: true } : {}),
    };
}

/**
 * Applies the three post-mapping drop rules in order — Team-field mismatch, label-only-no-evidence (with
 * the Epic rescue), then no-PI — logging each separately so it's clear which safety net caught an issue.
 */
function applyScopeFilters(mapped) {
    const droppedForTeamMismatch = mapped.filter(i => i && i.__droppedForTeamMismatch);

    if (droppedForTeamMismatch.length) {
        console.warn(
            `Warning: ${droppedForTeamMismatch.length} issue(s) dropped — either their Jira "Team" field didn't ` +
            "match this space's configured board/team name(s), or (boardless, teams-configured space only) the " +
            `Team field had no value at all: ${droppedForTeamMismatch.map(i => `${i.key} (${i.team || 'no Team value'})`).join(', ')}.`
        );
    }

    const afterTeamFilter = mapped.filter(i => i && !i.__droppedForTeamMismatch);

    // An issue that only reached this result via the current-PI query's `labels =` branch, with no real
    // sprint match and no other team evidence, is dropped too — except an Epic that still has at least one
    // in-scope child: an Epic typically carries no Sprint field of its own, so dropping it anyway would
    // silently lose Product view's own grouping header for children that otherwise correctly matched.
    const labelOnlyCandidates = afterTeamFilter.filter(i => i.__droppedForLabelOnlyNoEvidence);
    const notLabelOnlyFlagged = afterTeamFilter.filter(i => !i.__droppedForLabelOnlyNoEvidence);
    const epicKeysInScope = new Set(
        notLabelOnlyFlagged.filter(i => i.type !== 'Epic' && i.epicKey).map(i => i.epicKey)
    );
    const rescuedEpics = labelOnlyCandidates
        .filter(i => i.type === 'Epic' && epicKeysInScope.has(i.key))
        .map(({ __droppedForLabelOnlyNoEvidence, ...rest }) => rest);
    const droppedForLabelOnly = labelOnlyCandidates.filter(i => !(i.type === 'Epic' && epicKeysInScope.has(i.key)));

    if (droppedForLabelOnly.length) {
        console.warn(
            `Warning: ${droppedForLabelOnly.length} issue(s) dropped — matched the current-PI query only via its ` +
            'PI label, not a real sprint on this space\'s own configured board, with no Team-field or label ' +
            `evidence either: ${droppedForLabelOnly.map(i => i.key).join(', ')}.`
        );
    }

    const afterLabelOnlyFilter = notLabelOnlyFlagged.concat(rescuedEpics);

    // A recognized-type issue whose Sprint field/labels never resolved to a PI at all is dropped entirely:
    // the whole per-PI sharding model (see CLAUDE.md's Jira issues section) assumes every issue resolves to
    // *some* PI. This warning exists so a future move off SAFe/PI is loud, not a quietly-empty Product view.
    const droppedForNoPi = afterLabelOnlyFilter.filter(i => !i.pi).length;

    if (droppedForNoPi) {
        console.warn(
            `Warning: ${droppedForNoPi} issue(s) matched by this query had no PI-shaped Sprint field or label ` +
            '— dropped entirely (see CLAUDE.md\'s Jira issues section). If this project no longer uses PI ' +
            'Planning, the per-PI sharding model needs revisiting rather than treating this as noise.'
        );
    }

    return afterLabelOnlyFilter.filter(i => i.pi);
}

/**
 * Fetches every issue matching `jql` (paginated) and maps it to ShipScope's issue shape, returning
 * `{ issues, sprintDates }` — `sprintDates` (keyed by sprint name) is a side channel of `startDate`/
 * `endDate` pairs collected along the way, for the caller to roll up into each PI's `sprints` list in
 * `index.json`. `ctx` carries everything that doesn't vary per JQL, resolved once by the caller:
 * `{ sprintFieldId, epicLinkFieldId, flaggedFieldId, teamFieldId, boardNamesByProjectName,
 * teamNamesByProjectName, sprintIdsByProjectName? }`. `subtasks`/`priority`/`created`/`resolutiondate` are
 * system fields, always available without needing a resolved id.
 */
async function fetchAndMapIssuesForJql(jql, headers, ctx) {
    const fieldsParam = [
        'summary', 'issuetype', 'labels', 'issuelinks', 'status', 'project', 'parent', 'subtasks', 'priority',
        'created', 'resolutiondate', ctx.sprintFieldId, ctx.epicLinkFieldId, ctx.flaggedFieldId, ctx.teamFieldId,
    ].filter(Boolean).join(',');

    const rawIssues = await fetchAllRawIssues(jql, headers, fieldsParam);

    // JSON.stringify, not a bare console.log(label, object) — util.inspect's default depth (2) and
    // array-length (100) caps otherwise collapse exactly the fields most worth seeing here (`sprint`'s own
    // nested objects print as unhelpful "[Object]", and anything past the 100th issue prints as
    // "... N more items"). JSON.stringify has neither limit.
    console.log('Raw issues summary:', JSON.stringify(rawIssues.map(i => ({
        key: i.key,
        type: i.fields?.issuetype?.name,
        labels: i.fields?.labels,
        sprint: ctx.sprintFieldId ? i.fields?.[ctx.sprintFieldId] : undefined,
        project: i.fields?.project?.name,
        parent: i.fields?.parent?.key,
    })), null, 2));

    // Keyed by sprint name (not PI — several sprints share one PI) so the caller can roll these up into
    // each PI's `sprints` list for index.json without a second pass over the raw Jira response.
    const sprintDates = {};
    const mapped = rawIssues.map(issue => mapRawIssue(issue, ctx, sprintDates));

    return { issues: applyScopeFilters(mapped), sprintDates };
}

module.exports = {
    pickBestType,
    buildFallbackIssuesFromDeployments,
    findSpecialFieldIds,
    extractTeamName,
    extractTeamNames,
    resolveEpicTitles,
    fillMissingEpicTitles,
    fetchAndMapIssuesForJql,
};
