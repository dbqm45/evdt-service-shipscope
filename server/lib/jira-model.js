/**
 * Pure Jira rules for the server sync (FR-009): PIs from sprint names, the current sprint, and one raw Jira issue
 * mapped to the dashboard's issue shape (data/jira-issues/*.json). Ported in spirit from scripts/lib/jira-pi.js and
 * jira-issues.js, but scoped by board instead of by names: an issue's sprint is the one whose id belongs to the
 * board being synced, so the file-based Team-field and label heuristics are not needed.
 */

const DEFAULT_PI_PATTERN = /(\d+\.\d+)\.\d+/;
const TEMPLATE_MAX_LENGTH = 100;

class RhythmTemplateError extends Error {}

/** "Sparks 27.3.1" -> "PI-27.3" (the SAFe naming the file-based sync relies on). */
function extractPiFromSprintName(name, pattern = DEFAULT_PI_PATTERN) {
    const match = pattern.exec(name || '');
    return match ? `PI-${match[1]}` : null;
}

/**
 * An admin's PI naming as a pattern. `{pi}` (required, once) is the PI number, dotted digits like "27.3"; `{n}` is
 * the sprint number within it; `*` is any text; everything else is literal (case-insensitive, matched anywhere in
 * the sprint name). Not a raw regular expression on purpose: a user-supplied regex can be made to backtrack for
 * ever, this only ever builds simple, bounded ones.
 *
 * @param {string} template e.g. "PI {pi} / Iteration {n}"
 * @returns {RegExp}
 * @throws {RhythmTemplateError}
 */
function compileTemplate(template) {
    if (typeof template !== 'string' || !template.trim() || template.length > TEMPLATE_MAX_LENGTH) {
        throw new RhythmTemplateError(`The PI template must be 1-${TEMPLATE_MAX_LENGTH} characters`);
    }
    if (template.split('{pi}').length !== 2) throw new RhythmTemplateError('The PI template must contain {pi} exactly once');
    const source = template.split(/(\{pi\}|\{n\}|\*)/).filter(Boolean).map((part) => {
        if (part === '{pi}') return '(\\d+(?:\\.\\d+)?)';
        if (part === '{n}') return '\\d+';
        if (part === '*') return '.*?';
        return part.replace(/[.+?^${}()|[\]\\*]/g, '\\$&').replace(/\s+/g, '\\s+');
    }).join('');
    return new RegExp(source, 'i');
}

/**
 * How a board's sprints group into increments. `pi`: by the PI in their names (the admin's template, else the SAFe
 * default), a sprint without one being its own increment; `sprint`: every sprint on its own; `auto`: `pi` when any
 * of the board's sprints follows the PI naming.
 *
 * @param {{ rhythm: 'auto'|'pi'|'sprint', piTemplate: string|null }} board
 * @param {Array<{ name: string }>} sprints
 * @returns {{ kind: 'pi'|'sprint', pattern: RegExp|null }}
 */
function rhythmOf({ rhythm, piTemplate }, sprints) {
    if (rhythm === 'sprint') return { kind: 'sprint', pattern: null };
    const pattern = piTemplate ? compileTemplate(piTemplate) : DEFAULT_PI_PATTERN;
    if (rhythm === 'pi' || sprints.some((s) => pattern.test(s.name))) return { kind: 'pi', pattern };
    return { kind: 'sprint', pattern: null };
}

/**
 * The increment a sprint belongs to under a rhythm (by default the SAFe one). A sprint not named after a PI is its
 * own increment, so a team that doesn't use PIs still gets a dashboard.
 *
 * @param {string} name
 * @param {{ kind: string, pattern: RegExp|null }} [rhythm]
 * @returns {string}
 */
function piOfSprint(name, rhythm = { kind: 'pi', pattern: DEFAULT_PI_PATTERN }) {
    return (rhythm.kind === 'pi' && extractPiFromSprintName(name, rhythm.pattern)) || name;
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
 * The board's increment right now: its active sprint's; between sprints, the next one to start, else the last one
 * that ended (the gap between two sprints is not "no current PI" -- a real bug the file-based sync once had).
 *
 * @param {Array<{ name: string, state: string, startDate: string|null, endDate: string|null }>} sprints
 * @param {{ kind: string, pattern: RegExp|null }} [rhythm]
 * @returns {string|null}
 */
function currentPiOf(sprints, rhythm) {
    const active = sprints.filter((s) => s.state === 'active').map((s) => piOfSprint(s.name, rhythm)).sort(comparePiDesc);
    if (active.length) return active[0];
    const time = (d, fallback) => (d ? Date.parse(d) : fallback);
    const future = sprints.filter((s) => s.state === 'future').sort((a, b) => time(a.startDate, Infinity) - time(b.startDate, Infinity));
    if (future.length) return piOfSprint(future[0].name, rhythm);
    const closed = sprints.filter((s) => s.state === 'closed').sort((a, b) => time(b.endDate, -Infinity) - time(a.endDate, -Infinity));
    return closed.length ? piOfSprint(closed[0].name, rhythm) : null;
}

/**
 * The increment just before `pi` among a board's sprints (by when its sprints started), or null.
 *
 * @param {Array<{ name: string, startDate?: string|null }>} sprints
 * @param {string} pi
 * @param {{ kind: string, pattern: RegExp|null }} [rhythm]
 * @returns {string|null}
 */
function previousPiOf(sprints, pi, rhythm) {
    // Ordered by time when every increment has a date ("Sprint 10" comes after "Sprint 9", and sprint names need
    // not contain numbers at all); a future sprint without one is the newest. Otherwise by name.
    const firstStart = new Map();
    for (const s of sprints) {
        const inc = piOfSprint(s.name, rhythm);
        const date = s.startDate || s.endDate;
        const t = date ? Date.parse(date) : s.state === 'future' ? Infinity : NaN;
        const before = firstStart.get(inc);
        firstStart.set(inc, before === undefined || t < before ? t : before);
    }
    const datedAll = [...firstStart.values()].every((t) => !Number.isNaN(t));
    const pis = [...firstStart.keys()].sort((a, b) => (datedAll && (firstStart.get(b) - firstStart.get(a))) || comparePiDesc(a, b));
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

module.exports = {
    RhythmTemplateError, extractPiFromSprintName, compileTemplate, rhythmOf, piOfSprint, comparePiDesc, currentPiOf, previousPiOf, issueType, issueFields, mapIssue,
};
