/**
 * Pure Jira rules for the server sync (FR-009): PIs from sprint names, the current sprint, and one raw Jira issue
 * mapped to the dashboard's issue shape (data/jira-issues/*.json). Ported in spirit from scripts/lib/jira-pi.js and
 * jira-issues.js, but scoped by board instead of by names: an issue's sprint is the one whose id belongs to the
 * board being synced, so the file-based Team-field and label heuristics are not needed.
 */

/** "Sparks 27.3.1" -> "PI-27.3" (the SAFe naming the file-based sync relies on). */
function extractPiFromSprintName(name) {
    const match = /(\d+\.\d+)\.\d+/.exec(name || '');
    return match ? `PI-${match[1]}` : null;
}

/**
 * The PI a sprint belongs to. Teams that don't name sprints after a PI ("Sprint 42") still get a dashboard: the
 * sprint itself is their increment.
 *
 * @param {string} name
 * @returns {string}
 */
function piOfSprint(name) {
    return extractPiFromSprintName(name) || name;
}

/** Descending by every embedded number, left to right ("PI-27.3" before "PI-27.2"); same as comparePiDesc in scripts/. */
function comparePiDesc(a, b) {
    const nums = (s) => (String(s).match(/\d+/g) || []).map(Number);
    const na = nums(a);
    const nb = nums(b);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        const diff = (nb[i] || 0) - (na[i] || 0);
        if (diff) return diff;
    }
    return String(a).localeCompare(String(b));
}

/**
 * The board's PI right now: its active sprint's; between sprints, the next one to start, else the last one that
 * ended (the gap between two sprints is not "no current PI" -- a real bug the file-based sync once had).
 *
 * @param {Array<{ name: string, state: string, startDate: string|null, endDate: string|null }>} sprints
 * @returns {string|null}
 */
function currentPiOf(sprints) {
    const active = sprints.filter((s) => s.state === 'active').map((s) => piOfSprint(s.name)).sort(comparePiDesc);
    if (active.length) return active[0];
    const time = (d, fallback) => (d ? Date.parse(d) : fallback);
    const future = sprints.filter((s) => s.state === 'future').sort((a, b) => time(a.startDate, Infinity) - time(b.startDate, Infinity));
    if (future.length) return piOfSprint(future[0].name);
    const closed = sprints.filter((s) => s.state === 'closed').sort((a, b) => time(b.endDate, -Infinity) - time(a.endDate, -Infinity));
    return closed.length ? piOfSprint(closed[0].name) : null;
}

/**
 * The PI just before `pi` among a board's sprints, or null.
 *
 * @param {Array<{ name: string }>} sprints
 * @param {string} pi
 * @returns {string|null}
 */
function previousPiOf(sprints, pi) {
    const pis = [...new Set(sprints.map((s) => piOfSprint(s.name)))].sort(comparePiDesc);
    const i = pis.indexOf(pi);
    return i >= 0 && i + 1 < pis.length ? pis[i + 1] : null;
}

// Localized names of the types the dashboard knows, for instances without hierarchyLevel on issue types.
const TYPE_NAMES = { epic: 'Epic', epik: 'Epic', story: 'Story', historyjka: 'Story', bug: 'Bug', 'błąd': 'Bug', task: 'Task', zadanie: 'Task' };

/** The dashboard's four types. Sub-tasks are counted on their parent, not listed; other standard types read as Task. */
function issueType(issuetype) {
    if (!issuetype || typeof issuetype.name !== 'string' || issuetype.subtask === true) return null;
    const named = TYPE_NAMES[issuetype.name.toLowerCase()];
    if (named) return named;
    if (issuetype.hierarchyLevel === 1) return 'Epic';
    if (issuetype.hierarchyLevel === 0) return 'Task';
    return null;
}

/** The fields an issue search asks for (the custom ones by the ids fetchFieldIds() found). */
function issueFields({ sprintFieldId, epicLinkFieldId, flaggedFieldId }) {
    return ['summary', 'issuetype', 'status', 'priority', 'created', 'resolutiondate', 'project', 'parent', 'subtasks', 'issuelinks', 'labels',
        sprintFieldId, epicLinkFieldId, flaggedFieldId].filter(Boolean);
}

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : null);

/**
 * One raw issue in the dashboard's shape, or null for something to skip (unknown type, malformed).
 *
 * @param {object} raw a /search/jql issue
 * @param {{ sprintFieldId: string|null, epicLinkFieldId: string|null, flaggedFieldId: string|null }} fieldIds
 * @param {{ pi: string, sprintsInScope: Map<number, { name: string, state: string }> }} scope the PI being synced and its board's sprints in it
 * @returns {object|null}
 */
function mapIssue(raw, fieldIds, { pi, sprintsInScope }) {
    const f = raw?.fields;
    if (typeof raw?.key !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/.test(raw.key) || !f) return null;
    const type = issueType(f.issuetype);
    if (!type) return null;

    // The issue's sprint is the one on this board in this PI (an issue carries its whole sprint history, possibly
    // from other teams' boards); the active one if it moved between sprints of this PI.
    const sprintEntries = fieldIds.sprintFieldId && Array.isArray(f[fieldIds.sprintFieldId]) ? f[fieldIds.sprintFieldId] : [];
    const inScope = sprintEntries.filter((s) => Number.isSafeInteger(s?.id) && sprintsInScope.has(s.id)).map((s) => sprintsInScope.get(s.id));
    const sprint = inScope.find((s) => s.state === 'active') || inScope[inScope.length - 1] || null;

    const blockers = (Array.isArray(f.issuelinks) ? f.issuelinks : []).filter((link) => link?.type?.inward === 'is blocked by'
        && link.inwardIssue && link.inwardIssue.fields?.status?.statusCategory?.key !== 'done');
    const subtasks = Array.isArray(f.subtasks) && f.subtasks.length
        ? { done: f.subtasks.filter((st) => st?.fields?.status?.statusCategory?.key === 'done').length, total: f.subtasks.length }
        : null;
    let epicKey = null;
    let epicTitle = null;
    if (type !== 'Epic') {
        if (typeof f.parent?.key === 'string') {
            epicKey = f.parent.key;
            epicTitle = str(f.parent.fields?.summary);
        } else if (fieldIds.epicLinkFieldId && typeof f[fieldIds.epicLinkFieldId] === 'string') {
            epicKey = f[fieldIds.epicLinkFieldId];
        }
    }
    const flagged = fieldIds.flaggedFieldId ? f[fieldIds.flaggedFieldId] : null;
    const statusCategory = f.status?.statusCategory?.key;

    return {
        key: raw.key,
        type,
        title: str(f.summary) || raw.key,
        pi,
        sprint: sprint ? sprint.name : null,
        status: str(f.status?.name, 100),
        statusCategory: ['new', 'indeterminate', 'done'].includes(statusCategory) ? statusCategory : null,
        dependencyBlocked: blockers.length > 0,
        projectName: str(f.project?.name, 200),
        epicKey,
        epicTitle,
        impediment: Array.isArray(flagged) && flagged.length > 0,
        subtasks,
        priority: str(f.priority?.name, 100),
        created: str(f.created, 40),
        resolvedAt: str(f.resolutiondate, 40),
        ...(blockers.length ? { dependencyNote: str(`Blocked by ${blockers[0].inwardIssue.key}: ${blockers[0].inwardIssue.fields?.summary || ''}`) } : {}),
    };
}

module.exports = { extractPiFromSprintName, piOfSprint, comparePiDesc, currentPiOf, previousPiOf, issueType, issueFields, mapIssue };
