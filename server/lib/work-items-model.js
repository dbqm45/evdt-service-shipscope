// Work items from a repo, the pure rules (F1 of the pdi one-flow plan; contract 0.4.0 change.schema.json and
// task.schema.json). A change lives in docs/project/changes/<CHG>/: intent.md (what and why, its title) and plan.md
// (its tasks TSK-n). Both start with tf's "simple YAML" header between --- lines. The I/O is lib/work-items.js.

const { validate } = require('./json-schema-lite');

const WORK_ITEM_KEY = /^[A-Z][A-Z0-9]+-[0-9]+$/;
const CHANGES_DIR = 'docs/project/changes';
// The increment the dashboard shows work items in, next to PIs, sprints, releases and months (like NOW_KEY, not a name
// Jira can produce).
const CHANGES_KEY = '@changes';
const CHANGES_LABEL = 'Changes (repo)';
const TASK_STATUSES = ['planned', 'in_progress', 'in_review', 'done', 'dropped'];
const MAX_CHANGES = 200;
const MAX_TASKS_PER_CHANGE = 100;
const TITLE_MAX = 300;
const PROBLEM_MAX = 600;

class WorkItemFileError extends Error {}

const unquote = (v) => (/^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);
const scalar = (v) => {
    const s = unquote(v.trim());
    return /^-?[0-9]+$/.test(s) && s === v.trim() ? Number(s) : s;
};

/**
 * The header (`key: value`, `key: [a, b]`, no nesting) and the text after it.
 *
 * @param {string} text a whole file
 * @returns {{ header: Object<string, string|number|string[]>, body: string }}
 * @throws {WorkItemFileError} no header, or one that never ends
 */
function parseFrontMatter(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    if (lines[0].trim() !== '---') throw new WorkItemFileError('no YAML header');
    const end = lines.indexOf('---', 1);
    if (end < 0) throw new WorkItemFileError('the YAML header has no closing ---');
    const header = {};
    for (const line of lines.slice(1, end)) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
        if (!m) throw new WorkItemFileError(`header line "${line.slice(0, 40)}" is not key: value`);
        const raw = m[2].trim();
        header[m[1]] = raw.startsWith('[') && raw.endsWith(']')
            ? raw.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean)
            : scalar(raw);
    }
    return { header, body: lines.slice(end + 1).join('\n') };
}

// Markdown emphasis off (`**x**`, `` `x` ``, `_x_` around a word), whitespace folded; `in_progress` keeps its underscore.
const clean = (s) => s.replace(/[*`]+/g, '').replace(/(^|\s)_+|_+(\s|$)/g, '$1$2').replace(/\s+/g, ' ').trim();

/**
 * The title and status of each task from plan.md's body (the contract leaves its layout to tf's template): the first
 * line naming the whole key. In a table row, the title is the first non-empty cell after the key that is no status
 * and no release line; in a list item or heading, the text after the key. A status is one of task.schema.json's.
 *
 * @param {string} body
 * @param {string[]} keys the header's `tasks`
 * @returns {Array<{ key: string, title: string, status: string|null }>}
 */
function planTasks(body, keys) {
    const lines = String(body).split('\n');
    const isStatus = (s) => TASK_STATUSES.includes(s.toLowerCase());
    return keys.map((key) => {
        const word = new RegExp(`(^|[^A-Za-z0-9-])${key}(?![0-9])`);
        const line = lines.find((l) => word.test(l));
        if (!line) return { key, title: key, status: null };
        let title = null;
        let status = null;
        if (line.trim().startsWith('|')) {
            const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(clean);
            const at = cells.findIndex((c) => c.includes(key));
            for (const c of cells.slice(at + 1)) {
                if (!c) continue;
                if (isStatus(c)) status = status || c.toLowerCase();
                else if (!title && !/^R[0-9]+$/i.test(c) && !WORK_ITEM_KEY.test(c)) title = c;
            }
        } else {
            let rest = clean(line.slice(line.indexOf(key) + key.length)).replace(/^[\s:—–-]+/, '');
            const paren = /\((planned|in_progress|in_review|done|dropped)\)\s*$/i.exec(rest);
            const trailing = /,\s*(planned|in_progress|in_review|done|dropped)\s*$/i.exec(rest);
            const found = paren || trailing;
            if (found) {
                status = found[1].toLowerCase();
                rest = rest.slice(0, found.index).trim();
            }
            title = rest || null;
        }
        return { key, title: (title || key).slice(0, TITLE_MAX), status };
    });
}

/** The first `# ` heading of a body, or null. */
function firstHeading(body) {
    const m = /^#\s+(.+)$/m.exec(String(body));
    return m ? clean(m[1]).slice(0, TITLE_MAX) : null;
}

/**
 * The text of intent.md's `## Problem` section as one line, for the release notes (F5): up to the next `## ` heading,
 * without HTML comments and without the `<…>` placeholder lines of tf's template, at most 600 characters.
 *
 * @param {string} body intent.md after its header
 * @returns {string|null} null without the section or with only the template's placeholder
 */
function intentProblem(body) {
    const lines = String(body).replace(/<!--[\s\S]*?-->/g, '').split('\n');
    const start = lines.findIndex((l) => /^##\s+problem\s*$/i.test(l.trim()));
    if (start < 0) return null;
    const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
    const text = lines.slice(start + 1, end < 0 ? undefined : end)
        .map((l) => l.trim())
        .filter((l) => l && !/^<[^>]*>$/.test(l))
        .join(' ');
    const one = clean(text);
    return one ? one.slice(0, PROBLEM_MAX) : null;
}

/** The header of one artifact, checked against its folder (change.schema.json's fields this reads). */
function checkHeader(header, { dir, artifact }) {
    if (header.change !== dir) throw new WorkItemFileError(`change is ${header.change || 'missing'}, not ${dir}`);
    if (header.artifact !== undefined && header.artifact !== artifact) throw new WorkItemFileError(`artifact is ${header.artifact}, not ${artifact}`);
    if (header.source !== undefined && !WORK_ITEM_KEY.test(String(header.source))) throw new WorkItemFileError(`source ${header.source} is not a key`);
    if (artifact === 'plan') {
        const tasks = header.tasks === undefined ? [] : header.tasks;
        if (!Array.isArray(tasks) || tasks.some((k) => !WORK_ITEM_KEY.test(k))) throw new WorkItemFileError('tasks must be a list of keys like TSK-57');
        if (tasks.length > MAX_TASKS_PER_CHANGE) throw new WorkItemFileError(`more than ${MAX_TASKS_PER_CHANGE} tasks`);
    }
}

/**
 * The work items of a changes folder: per change folder its change (title from intent.md) and tasks (plan.md). A file
 * that can't be read is an error for its change only; the change is then left out.
 *
 * @param {Array<{ dir: string, intent?: string, plan?: string }>} changes the folders' files' text, as read
 * @returns {{ items: Array<{ key: string, kind: 'change'|'task', parent: string|null, title: string, status: string|null, source: string|null, path: string, problem: string|null }>, errors: Array<{ change: string, message: string }> }}
 */
function buildWorkItems(changes) {
    const items = [];
    const errors = [];
    for (const { dir, intent, plan } of changes.filter((c) => WORK_ITEM_KEY.test(c.dir)).slice(0, MAX_CHANGES)) {
        if (intent === undefined && plan === undefined) continue;
        const base = `${CHANGES_DIR}/${dir}`;
        let file = 'intent.md';
        try {
            let title = null;
            let status = null;
            let source = null;
            let problem = null;
            if (intent !== undefined) {
                const { header, body } = parseFrontMatter(intent);
                checkHeader(header, { dir, artifact: 'intent' });
                title = firstHeading(body);
                problem = intentProblem(body);
                status = typeof header.status === 'string' ? header.status : null;
                source = header.source || null;
            }
            let tasks = [];
            if (plan !== undefined) {
                file = 'plan.md';
                const { header, body } = parseFrontMatter(plan);
                checkHeader(header, { dir, artifact: 'plan' });
                tasks = planTasks(body, [...new Set(header.tasks || [])]);
                source = source || header.source || null;
            }
            items.push({ key: dir, kind: 'change', parent: null, title: title || dir, status, source, path: `${base}/${intent !== undefined ? 'intent' : 'plan'}.md`, problem });
            for (const t of tasks.filter((task) => task.status !== 'dropped')) {
                items.push({ key: t.key, kind: 'task', parent: dir, title: t.title, status: t.status, source: null, path: `${base}/plan.md`, problem: null });
            }
        } catch (err) {
            if (!(err instanceof WorkItemFileError)) throw err;
            errors.push({ change: dir, message: `${base}/${file}: ${err.message}` });
        }
    }
    return { items, errors };
}

const TASK_STATUS_TEXT = { planned: 'Planned', in_progress: 'In progress', in_review: 'In review', done: 'Done' };
const TASK_CATEGORY = { planned: 'new', in_progress: 'indeterminate', in_review: 'indeterminate', done: 'done' };

/**
 * Work items in the dashboard's issue shape, in the Changes increment: a change is an Epic whose `subtaskKeys` are its
 * tasks (so a commit naming a task counts for the change, issueKeys() in docs/app-model.js), a task a Story under it.
 *
 * @param {Array<{ key: string, kind: string, parent: string|null, title: string, status: string|null, problem?: string|null }>} items
 * @returns {object[]}
 */
function workItemIssues(items) {
    const tasksOf = new Map();
    for (const i of items.filter((x) => x.kind === 'task')) {
        if (!tasksOf.has(i.parent)) tasksOf.set(i.parent, []);
        tasksOf.get(i.parent).push(i);
    }
    const titleOf = new Map(items.filter((x) => x.kind === 'change').map((c) => [c.key, c.title]));
    const common = { pi: CHANGES_KEY, sprint: null, projectName: null, impediment: false, subtasks: null, blockedByKeys: [], dependencyBlocked: false, priority: null, created: null, resolvedAt: null, featureFlags: [], releaseLine: null };
    return items.map((i) => {
        if (i.kind === 'change') {
            const tasks = tasksOf.get(i.key) || [];
            const categories = tasks.map((t) => TASK_CATEGORY[t.status] || 'new');
            const statusCategory = tasks.length && categories.every((c) => c === 'done') ? 'done' : categories.some((c) => c !== 'new') ? 'indeterminate' : 'new';
            return {
                ...common, key: i.key, type: 'Epic', title: i.title, status: i.status ? i.status[0].toUpperCase() + i.status.slice(1) : null, statusCategory,
                epicKey: null, epicTitle: null, subtaskKeys: tasks.map((t) => t.key), problem: i.problem || null,
                subtasks: tasks.length ? { done: categories.filter((c) => c === 'done').length, total: tasks.length } : null,
            };
        }
        return {
            ...common, key: i.key, type: 'Story', title: i.title, status: TASK_STATUS_TEXT[i.status] || null, statusCategory: TASK_CATEGORY[i.status] || 'new',
            epicKey: i.parent, epicTitle: titleOf.get(i.parent) || i.parent, subtaskKeys: [],
        };
    });
}

/**
 * A change's release plan (release.yaml, pdi contract 0.4.0) checked against the pinned schema and its folder. Only
 * the structure: consistency (the MVP among the lines, a task in one line) is tf's to check, the dashboard only shows
 * it (releasePlanProblems() in docs/app-model.js).
 *
 * @param {unknown} doc the parsed file
 * @param {{ dir: string, schema: object }} input
 * @returns {{ change: string, mvp?: object, releases: object[], flags?: object[] }}
 * @throws {WorkItemFileError} the first few problems, by path
 */
function checkReleasePlan(doc, { dir, schema }) {
    const errors = validate(schema, doc);
    if (errors.length) throw new WorkItemFileError(errors.slice(0, 5).join('; ') + (errors.length > 5 ? `; and ${errors.length - 5} more` : ''));
    if (doc.change !== dir) throw new WorkItemFileError(`change is ${doc.change}, not ${dir}`);
    return doc;
}

module.exports = { checkReleasePlan, WORK_ITEM_KEY, CHANGES_DIR, CHANGES_KEY, CHANGES_LABEL, TASK_STATUSES, MAX_CHANGES, WorkItemFileError, parseFrontMatter, planTasks, intentProblem, buildWorkItems, workItemIssues };
