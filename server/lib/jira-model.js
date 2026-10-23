/**
 * Pure Jira rules for the server sync (FR-009): PIs from sprint names, the current sprint, and one raw Jira issue
 * mapped to the dashboard's issue shape (data/jira-issues/*.json). Ported in spirit from the file-based sync's
 * jira-pi.js and jira-issues.js, but scoped by board instead of by names: an issue's sprint is the one whose id belongs to the
 * board being synced, so the file-based Team-field and label heuristics are not needed.
 */

const DEFAULT_PI_PATTERN = /(\d+\.\d+)\.\d+/;
const TEMPLATE_MAX_LENGTH = 100;
// The dashboard's "Now" increment: every selected board's current one together (teams in different rhythms --
// a PI, a sprint -- are all "now" at once). Not a name Jira can produce: increments are PI labels or sprint names.
const NOW_KEY = '@now';

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
 * How a board's work groups into increments. `pi`: sprints by the PI in their names (the admin's template, else the
 * SAFe default), a sprint without one being its own increment; `sprint`: every sprint on its own; `release`: the
 * board project's versions (fixVersion); `flow`: calendar months (Kanban, no sprints). `auto`: `pi` when any sprint
 * follows the PI naming, else `sprint` when the board has sprints, else `release` when its project has an unreleased
 * version, else `flow`.
 *
 * @param {{ rhythm: 'auto'|'pi'|'sprint'|'release'|'flow', piTemplate: string|null }} board
 * @param {Array<{ name: string }>} sprints
 * @param {Array<{ released: boolean }>} [versions] the project's versions (only read by `auto` on a board without sprints)
 * @returns {{ kind: 'pi'|'sprint'|'release'|'flow', pattern: RegExp|null }}
 */
function rhythmOf({ rhythm, piTemplate }, sprints, versions = []) {
    if (rhythm === 'sprint' || rhythm === 'release' || rhythm === 'flow') return { kind: rhythm, pattern: null };
    const pattern = piTemplate ? compileTemplate(piTemplate) : DEFAULT_PI_PATTERN;
    if (rhythm === 'pi' || sprints.some((s) => pattern.test(s.name))) return { kind: 'pi', pattern };
    if (sprints.length) return { kind: 'sprint', pattern: null };
    return { kind: versions.some((v) => !v.released) ? 'release' : 'flow', pattern: null };
}

const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

/** A release's increment name: the version's own name, prefixed with the project key unless it already starts with it
 * (two projects' "1.0" are different releases). */
function releaseName(projectKey, versionName) {
    return versionName.toUpperCase().startsWith(projectKey.toUpperCase()) ? versionName : `${projectKey} ${versionName}`;
}

const versionTime = (v) => {
    const t = Date.parse(v.releaseDate || v.startDate || '');
    return Number.isNaN(t) ? null : t;
};

/**
 * A project's current release: the unreleased version due first (one without a date after every dated one), else the
 * last one released. Archived versions are not passed in.
 *
 * @param {Array<{ id: string, name: string, released: boolean, startDate: string|null, releaseDate: string|null }>} versions
 * @returns {object|null} the version
 */
function currentReleaseOf(versions) {
    const due = (v) => versionTime(v) ?? Infinity;
    const unreleased = versions.filter((v) => !v.released).sort((a, b) => (due(a) - due(b)) || compareNumbers(a.name, b.name) || a.name.localeCompare(b.name));
    if (unreleased.length) return unreleased[0];
    return releasedNewestFirst(versions)[0] || null;
}

function releasedNewestFirst(versions) {
    const at = (v) => versionTime(v) ?? -Infinity;
    return versions.filter((v) => v.released).sort((a, b) => (at(b) - at(a)) || comparePiDesc(a.name, b.name));
}

/**
 * The release before `current`: the newest released version other than it (after it in that order, when it was
 * released itself).
 *
 * @param {Array<{ id: string, name: string, released: boolean }>} versions
 * @param {{ id: string }} current
 * @returns {object|null}
 */
function previousReleaseOf(versions, current) {
    const released = releasedNewestFirst(versions);
    const i = released.findIndex((v) => v.id === current.id);
    return released[i + 1] || null;
}

/**
 * The calendar month (UTC) a Kanban board's flow increment covers, `offset` months from `now`'s.
 *
 * @param {Date} now
 * @param {number} [offset]
 * @returns {{ name: string, start: string, end: string }} name "Flow 2026-10"; start/end "YYYY-MM-DD", end exclusive
 */
function flowMonth(now, offset = 0) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const day = (d) => d.toISOString().slice(0, 10);
    return { name: `Flow ${day(start).slice(0, 7)}`, start: day(start), end: day(end) };
}

/** JQL for a release: the project's issues with that fixVersion. */
function releaseJql(projectKey, versionId) {
    if (!PROJECT_KEY.test(projectKey) || !/^\d+$/.test(versionId)) throw new Error('invalid project key or version id');
    return `project = "${projectKey}" AND fixVersion = ${versionId} ORDER BY key`;
}

/** JQL for a flow month: issues resolved in it, plus -- for the current month -- everything in progress now. */
function flowJql(projectKey, month, current) {
    if (!PROJECT_KEY.test(projectKey)) throw new Error('invalid project key');
    const resolved = `resolved >= "${month.start}" AND resolved < "${month.end}"`;
    return `project = "${projectKey}" AND (${current ? `statusCategory = "In Progress" OR ${resolved}` : resolved}) ORDER BY key`;
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

/** Ascending by every embedded number, left to right; 0 when they are all equal. */
function compareNumbers(a, b) {
    const nums = (s) => (String(s).match(/\d+/g) || []).map(Number);
    const na = nums(a);
    const nb = nums(b);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        const diff = (na[i] || 0) - (nb[i] || 0);
        if (diff) return diff;
    }
    return 0;
}

/** Descending by every embedded number, left to right ("PI-27.3" before "PI-27.2"); same as the file-based sync's comparePiDesc. */
function comparePiDesc(a, b) {
    return compareNumbers(b, a) || String(a).localeCompare(String(b));
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

/**
 * The increments to sync for a board, current first (none when it has nothing current: no sprints in a sprint
 * rhythm, no versions for a release, no project for a release or flow month): each with its JQL, the board's
 * sprints in it, and its entries for the index's sprint list. A board's first sync also takes the increment
 * before the current one. Pure: `sprints`/`versions` are already fetched (deciding *whether* to fetch them --
 * cheapest when the rhythm is already known -- is the caller's job, since that's about the API calls, not this
 * decision).
 *
 * @param {{ board: { project_key: string|null, rhythm: 'auto'|'pi'|'sprint'|'release'|'flow', pi_template: string|null }, sprints: array, versions?: array, firstSync: boolean, now: Date }} input
 * @returns {Array<{ pi: string, kind: 'pi'|'sprint'|'release'|'flow', jql: string, sprints: array, index: array }>}
 */
function planBoardIncrements({ board, sprints, versions = [], firstSync, now }) {
    const projectKey = typeof board.project_key === 'string' && PROJECT_KEY.test(board.project_key) ? board.project_key : null;
    const rhythm = rhythmOf({ rhythm: board.rhythm, piTemplate: board.pi_template }, sprints, versions);

    if (rhythm.kind === 'release') {
        const current = projectKey ? currentReleaseOf(versions) : null;
        if (!current) return [];
        const previous = firstSync ? previousReleaseOf(versions, current) : null;
        return [current, previous].filter(Boolean).map((v) => {
            const pi = releaseName(projectKey, v.name);
            return { pi, kind: 'release', jql: releaseJql(projectKey, v.id), sprints: [], index: [{ name: pi, startDate: v.startDate, endDate: v.releaseDate }] };
        });
    }
    if (rhythm.kind === 'flow') {
        if (!projectKey) return [];
        return (firstSync ? [0, -1] : [0]).map((offset) => {
            const month = flowMonth(now, offset);
            return {
                pi: month.name, kind: 'flow', jql: flowJql(projectKey, month, offset === 0), sprints: [],
                index: [{ name: month.name, startDate: `${month.start}T00:00:00.000Z`, endDate: `${month.end}T00:00:00.000Z` }],
            };
        });
    }
    const current = currentPiOf(sprints, rhythm);
    if (!current) return [];
    const previous = firstSync ? previousPiOf(sprints, current, rhythm) : null;
    return [current, previous].filter(Boolean).map((pi) => {
        const inPi = sprints.filter((s) => piOfSprint(s.name, rhythm) === pi);
        return {
            pi,
            kind: rhythm.kind === 'pi' && inPi.some((s) => extractPiFromSprintName(s.name, rhythm.pattern)) ? 'pi' : 'sprint',
            jql: `sprint in (${inPi.map((s) => s.id).join(',')}) ORDER BY key`,
            sprints: inPi,
            index: inPi.map((s) => ({ name: s.name, startDate: s.startDate, endDate: s.endDate })),
        };
    });
}

/**
 * The dashboard's jira-issues index (data/jira-issues/index.json shape) plus the per-issue newest-increment
 * status (status-index.json shape), given a tenant's synced PI rows, its raw issue (key, pi, statusCategory)
 * rows, and its boards' current increments. More than one current increment (teams in different rhythms)
 * joins them under NOW_KEY, so the dashboard opens on every team at once.
 *
 * @param {{ pis: Array<{ pi: string, kind: string, sprints: array }>, issues: Array<{ key: string, pi: string, status_category: string|null }>, current: string[] }} input
 * @returns {{ jiraIndex: { currentPi: string|null, pis: object[] }, issueStatusIndex: object }}
 */
function buildJiraIndex({ pis, issues, current }) {
    const sorted = [...pis].sort((a, b) => comparePiDesc(a.pi, b.pi));
    const rank = new Map(sorted.map((p, i) => [p.pi, i]));
    const issueStatusIndex = {};
    for (const i of [...issues].sort((a, b) => rank.get(a.pi) - rank.get(b.pi))) {
        if (!issueStatusIndex[i.key]) issueStatusIndex[i.key] = { pi: i.pi, statusCategory: i.status_category };
    }
    const entries = sorted.map((p) => ({ pi: p.pi, kind: p.kind, file: `${String(p.pi).replace(/[^A-Za-z0-9.-]/g, '_')}.json`, sprints: p.sprints }));
    if (current.length > 1) {
        const joined = entries.filter((e) => current.includes(e.pi));
        entries.unshift({
            pi: NOW_KEY, kind: 'now', label: `Now: ${current.join(', ')}`, file: 'now.json', includes: current,
            sprints: joined.flatMap((e) => e.sprints),
        });
    }
    return {
        jiraIndex: { currentPi: current.length > 1 ? NOW_KEY : current[0] || null, pis: entries },
        issueStatusIndex,
    };
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

/** The fields an issue search asks for (the custom ones by the ids fetchFieldIds() found, and the flag field if any). */
function issueFields({ sprintFieldId, epicLinkFieldId, flaggedFieldId, flagLink = null }) {
    return ['summary', 'issuetype', 'status', 'priority', 'created', 'resolutiondate', 'project', 'parent', 'subtasks', 'issuelinks', 'labels',
        sprintFieldId, epicLinkFieldId, flaggedFieldId, flagLink && flagLink.type === 'field' ? flagLink.id : null].filter(Boolean);
}

// The same key rule as the flag ingest API (web.js FLAG_KEY): what a sender can report is what Jira can link to.
const FLAG_KEY = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const MAX_FLAGS_PER_ISSUE = 20;

/**
 * The feature flags an issue names, by the tenant's convention: a field on the issue (text with keys separated by
 * commas or spaces, labels, or select options), or labels starting with a prefix (`flag:newCheckout`, prefix matched
 * case-insensitively). Anything that isn't a valid flag key is ignored.
 *
 * @param {object} fields a raw issue's `fields`
 * @param {{ type: 'field', id: string }|{ type: 'label', prefix: string }|null} flagLink
 * @returns {string[]} distinct flag keys, in order of appearance
 */
function extractFlagKeys(fields, flagLink) {
    if (!flagLink || !fields) return [];
    let candidates = [];
    if (flagLink.type === 'label') {
        const prefix = flagLink.prefix.toLowerCase();
        candidates = (Array.isArray(fields.labels) ? fields.labels : [])
            .filter((l) => typeof l === 'string' && l.toLowerCase().startsWith(prefix))
            .map((l) => l.slice(prefix.length));
    } else if (flagLink.type === 'field') {
        const value = fields[flagLink.id];
        const parts = Array.isArray(value) ? value : [value];
        candidates = parts.flatMap((v) => {
            const text = typeof v === 'string' ? v : typeof v?.value === 'string' ? v.value : '';
            return text.split(/[\s,;]+/);
        });
    }
    return [...new Set(candidates.filter((k) => FLAG_KEY.test(k)))].slice(0, MAX_FLAGS_PER_ISSUE);
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const MAX_SUBTASK_KEYS = 100;
const MAX_BLOCKED_BY_KEYS = 20;

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : null);

/**
 * One raw issue in the dashboard's shape, or null for something to skip (unknown type, malformed).
 *
 * @param {object} raw a /search/jql issue
 * @param {{ sprintFieldId: string|null, epicLinkFieldId: string|null, flaggedFieldId: string|null, flagLink?: object|null }} fieldIds
 * @param {{ pi: string, sprintsInScope: Map<number, { name: string, state: string }>, sprint?: string|null }} scope the PI being synced and
 *   its board's sprints in it; `sprint`: the name to use when none of those is the issue's (a release or flow month is its own "sprint")
 * @returns {object|null}
 */
function mapIssue(raw, fieldIds, { pi, sprintsInScope, sprint: fallbackSprint = null }) {
    const f = raw?.fields;
    if (typeof raw?.key !== 'string' || !ISSUE_KEY.test(raw.key) || !f) return null;
    const type = issueType(f.issuetype);
    if (!type) return null;

    // The issue's sprint is the one on this board in this PI (an issue carries its whole sprint history, possibly
    // from other teams' boards); the active one if it moved between sprints of this PI.
    const sprintEntries = fieldIds.sprintFieldId && Array.isArray(f[fieldIds.sprintFieldId]) ? f[fieldIds.sprintFieldId] : [];
    const inScope = sprintEntries.filter((s) => Number.isSafeInteger(s?.id) && sprintsInScope.has(s.id)).map((s) => sprintsInScope.get(s.id));
    const sprint = inScope.find((s) => s.state === 'active') || inScope[inScope.length - 1] || null;

    const blockedBy = (Array.isArray(f.issuelinks) ? f.issuelinks : []).filter((link) => link?.type?.inward === 'is blocked by'
        && link.inwardIssue);
    const blockers = blockedBy.filter((link) => link.inwardIssue.fields?.status?.statusCategory?.key !== 'done');
    // Every "is blocked by" issue, resolved or not: an issue whose code shipped in what blocks it (no commit of its own)
    // counts as deployed where all of them are (deployedViaBlockers() in docs/app-model.js).
    const blockedByKeys = [...new Set(blockedBy.map((link) => link.inwardIssue.key).filter((k) => typeof k === 'string' && ISSUE_KEY.test(k)))]
        .slice(0, MAX_BLOCKED_BY_KEYS);
    const subtasks = Array.isArray(f.subtasks) && f.subtasks.length
        ? { done: f.subtasks.filter((st) => st?.fields?.status?.statusCategory?.key === 'done').length, total: f.subtasks.length }
        : null;
    // A commit may name only a sub-task; the dashboard joins deployments on the issue's key plus these.
    const subtaskKeys = (Array.isArray(f.subtasks) ? f.subtasks : [])
        .map((st) => st?.key).filter((k) => typeof k === 'string' && ISSUE_KEY.test(k)).slice(0, MAX_SUBTASK_KEYS);
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
        sprint: sprint ? sprint.name : fallbackSprint,
        status: str(f.status?.name, 100),
        statusCategory: ['new', 'indeterminate', 'done'].includes(statusCategory) ? statusCategory : null,
        dependencyBlocked: blockers.length > 0,
        blockedByKeys,
        projectName: str(f.project?.name, 200),
        epicKey,
        epicTitle,
        impediment: Array.isArray(flagged) && flagged.length > 0,
        subtasks,
        subtaskKeys,
        priority: str(f.priority?.name, 100),
        created: str(f.created, 40),
        resolvedAt: str(f.resolutiondate, 40),
        featureFlags: extractFlagKeys(f, fieldIds.flagLink || null),
        ...(blockers.length ? { dependencyNote: str(`Blocked by ${blockers[0].inwardIssue.key}: ${blockers[0].inwardIssue.fields?.summary || ''}`) } : {}),
    };
}

module.exports = {
    NOW_KEY,
    RhythmTemplateError, extractPiFromSprintName, compileTemplate, rhythmOf, piOfSprint, comparePiDesc, currentPiOf, previousPiOf,
    releaseName, currentReleaseOf, previousReleaseOf, flowMonth, releaseJql, flowJql, issueType, issueFields, extractFlagKeys, mapIssue,
    planBoardIncrements, buildJiraIndex,
};
