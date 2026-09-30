const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadOrCompute } = require('./lib/retry-cache');
const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY } = process.env;
const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH || 'docs/data/deployments.json';
// Editable onboarding config, same "not bot-generated data" role as docs/components.json — deliberately
// not under docs/data/. Absent/empty = no restriction, same nullable-means-unconfirmed spirit as
// components.json's featureFlagsIncluded, so existing setups keep syncing every space unchanged until
// someone opts in.
const SPACES_PATH = process.env.SPACES_PATH || 'docs/jira-spaces.json';

function safeRelativePath(inputPath, label) {
    const normalized = path.normalize(inputPath);

    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        console.error(`Error: ${label} "${inputPath}" is not a safe relative path — refusing to use it.`);
        process.exit(1);
    }

    return normalized;
}

// One file per PI (docs/data/jira-issues/PI-27.3.json) plus an index.json — replaces the single, ever-
// growing jira-issues.json so Product view/Release Notes/Insights can each load just the one PI they're
// currently showing instead of every issue ShipScope has ever synced. See index.json's own shape at the
// bottom of main().
const JIRA_ISSUES_DIR = safeRelativePath(process.env.JIRA_ISSUES_DIR || 'docs/data/jira-issues', 'JIRA_ISSUES_DIR');

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

const TYPE_PRIORITY = ['feat', 'fix', 'chore'];

function pickBestType(types) {
    for (const t of TYPE_PRIORITY) {
        if (types.includes(t)) {
            return t;
        }
    }

    return types[0] || 'other';
}

function buildFallbackIssuesFromDeployments(deployments) {
    const typesByKey = {};

    for (const dep of deployments) {
        for (const key of dep.relatedIssues || []) {
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

/** Only handles the explicit opt-in (`JIRA_PROJECT_KEY` set) — the default, no-config path is scoped to
 *  exact referenced issue keys instead (see `main()`), not to whole projects. */
function parseExplicitProjectKeys() {
    return JIRA_PROJECT_KEY ? JIRA_PROJECT_KEY.split(',').map(k => k.trim()).filter(Boolean) : [];
}

function readDeployments() {
    return fs.existsSync(DEPLOYMENTS_PATH) ? JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf8')) : [];
}

function extractPiFromSprintName(sprintName) {
    if (!sprintName) {
        return null;
    }

    const match = sprintName.match(/(\d+\.\d+)\.\d+/);

    return match ? `PI-${match[1]}` : null;
}

/**
 * Resolves the Sprint field's most relevant entry (the active one, else the most recently listed) —
 * `startDate`/`endDate` are already present on this same field (Jira sends them whether or not anything
 * here used to read them), just previously discarded; carrying them through now lets `main()` build a
 * per-PI sprint-date index (for `docs/data/jira-issues/index.json`) without any extra Jira fetch. The
 * legacy string encoding renders a genuinely missing date as the literal text `<null>`, not absence —
 * normalized to a real `null` here so callers don't have to know about that quirk.
 */
function pickRelevantSprintInfo(sprintFieldValue) {
    if (!sprintFieldValue) {
        return null;
    }

    const list = Array.isArray(sprintFieldValue) ? sprintFieldValue : [sprintFieldValue];

    if (!list.length) {
        return null;
    }

    const parsed = list.map(entry => {
        if (typeof entry === 'string') {
            const field = key => {
                const m = entry.match(new RegExp(`${key}=([^,\\]]+)`));

                return m && m[1] !== '<null>' ? m[1] : null;
            };

            return { name: field('name'), state: field('state'), startDate: field('startDate'), endDate: field('endDate') };
        }

        return { name: entry.name, state: entry.state, startDate: entry.startDate || null, endDate: entry.endDate || null };
    }).filter(s => s.name);

    if (!parsed.length) {
        return null;
    }

    const active = parsed.find(s => (s.state || '').toLowerCase() === 'active');

    return active || parsed[parsed.length - 1];
}

/** Sorts PI labels ("PI-27.3") or sprint labels descending (newest first) by every embedded number, left
 *  to right — the same convention `docs/app.js`'s own `compareVersionDesc` already uses client-side, kept
 *  in sync here since `main()` now needs to pre-sort PI entries for `index.json` itself. */
function comparePiDesc(a, b) {
    const numsOf = s => (s.match(/\d+/g) || []).map(Number);
    const na = numsOf(a);
    const nb = numsOf(b);
    const len = Math.max(na.length, nb.length);

    for (let i = 0; i < len; i++) {
        const diff = (nb[i] || 0) - (na[i] || 0);

        if (diff) {
            return diff;
        }
    }

    return 0;
}

/** Keeps a PI label usable as a filename across every OS this might run on (and defends against a
 *  pathologically weird PI/label string ever escaping `JIRA_ISSUES_DIR`) — same defensive spirit as
 *  `safeRelativePath`, just for a path *segment* rather than a whole path. */
function safeFileSlug(value) {
    return String(value).replace(/[^A-Za-z0-9.-]/g, '_');
}

/**
 * Any `XXX-123`-shaped string found in a commit message (see `deriveIssueKeysFromDeployments`) is treated
 * as a candidate Jira key — that regularly picks up keys from unrelated ticketing systems or typos (e.g. a
 * ServiceNow change ticket, or a one-off misspelled key) whose *project* prefix doesn't correspond to a
 * real, visible Jira project here. A single bad project inside `project in (...)`/`key in (...)` makes the
 * whole JQL query fail, which would otherwise silently zero out *every* other project's results too, not
 * just the bad one's — so every candidate project key is checked against this Jira instance's real,
 * visible project list first, and anything that doesn't resolve is dropped with a warning rather than
 * taken on faith.
 */
async function filterExistingProjectKeys(keys, headers) {
    if (!keys.length) {
        return keys;
    }

    // Jira's `keys` query param is ampersand-separated (repeated `keys=`), not comma-separated —
    // see https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-search-get.
    // A single comma-joined value is treated as one literal (nonexistent) key, so every key would
    // come back "not found" regardless of the caller's actual project access.
    const keysParam = keys.map(k => `keys=${encodeURIComponent(k)}`).join('&');
    const res = await fetch(
        `${JIRA_BASE_URL}/rest/api/3/project/search?${keysParam}&maxResults=${keys.length}`,
        { headers }
    );

    if (!res.ok) {
        console.warn(
            `Warning: could not verify project keys against Jira (${res.status}) — proceeding with all ` +
            `derived keys unfiltered: ${keys.join(', ')}.`
        );
        return keys;
    }

    const data = await res.json();

    if (data.isLast === false) {
        console.warn('Warning: project key verification response was paginated — only the first page was checked.');
    }

    const valid = new Set((data.values || []).map(p => p.key));
    const dropped = keys.filter(k => !valid.has(k));

    if (dropped.length) {
        console.warn(
            `Dropping project key(s) not found in this Jira instance: ${dropped.join(', ')} (likely a ` +
            'false-positive match on a commit message that looks like a Jira key but isn\'t one here).'
        );
    }

    return keys.filter(k => valid.has(k));
}

async function fetchAllProjects(headers) {
    const projects = [];
    let startAt = 0;
    let isLast = false;

    while (!isLast) {
        const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/project/search?maxResults=100&startAt=${startAt}`, { headers });

        if (!res.ok) {
            throw new Error(`Jira API error fetching projects: ${res.status} ${await res.text()}`);
        }

        const data = await res.json();
        const values = data.values || [];

        projects.push(...values);
        isLast = data.isLast === true || !values.length;
        startAt += values.length;
    }

    return projects;
}

/**
 * Reads the optional `docs/jira-spaces.json` allowlist and normalizes each `spaces` entry to
 * `{ name, boards }` — a plain string entry (the original shape) means "no boards configured", while
 * `{ name, boards }` additionally opts that space into the low-cost current-PI fetch (see
 * `resolveCurrentPiForSpaces`). Malformed/missing file degrades to `[]` (no restriction), same spirit as
 * every other optional-config read in this codebase.
 */
function readSpacesConfig() {
    if (!fs.existsSync(SPACES_PATH)) {
        return [];
    }

    try {
        const config = JSON.parse(fs.readFileSync(SPACES_PATH, 'utf8'));
        const list = Array.isArray(config.spaces) ? config.spaces : [];

        return list.filter(Boolean).map(entry => {
            if (typeof entry === 'string') {
                return { name: entry, boards: [] };
            }

            return {
                name: entry.name,
                boards: Array.isArray(entry.boards) ? entry.boards.filter(Boolean) : [],
            };
        }).filter(e => e.name);
    } catch (e) {
        console.warn(`Warning: could not parse ${SPACES_PATH} (${e.message}) — proceeding with no space restriction.`);
        return [];
    }
}

/**
 * Resolves each configured space's name to a real Jira project key (the same allowlist role
 * `docs/jira-spaces.json` has always had), and — for any space that also configured board name(s) —
 * carries its resolved project key alongside those board names, so `resolveCurrentPiForSpaces` can look up
 * their active sprints without re-resolving project keys itself. Returns
 * `{ allowedProjectKeys: null, resolvedSpaces: [] }` when there's nothing configured (no restriction,
 * matching the original nullable-means-unconfirmed behavior).
 */
async function resolveSpacesConfig(spacesConfig, headers) {
    if (!spacesConfig.length) {
        return { allowedProjectKeys: null, resolvedSpaces: [] };
    }

    // Cached across sync-with-retry attempts in the same job — same rate-limit-safety reason
    // loadOrCompute already exists for the main issue search below, just keyed on a fixed name since this
    // fetch's shape never varies per run. A transient Jira error degrades to "no restriction" for this run
    // instead of failing the whole sync.
    let allProjects;

    try {
        allProjects = await loadOrCompute('jira-spaces-projects', () => fetchAllProjects(headers));
    } catch (e) {
        console.warn(`Warning: could not fetch Jira's project list to resolve ${SPACES_PATH} (${e.message}) — proceeding with no space restriction for this run.`);
        return { allowedProjectKeys: null, resolvedSpaces: [] };
    }

    // Two visible projects can share a display name (case-insensitively) even though keys are always
    // unique — track collisions so an ambiguous match is a loud warning, not a silent wrong-project
    // resolution.
    const byLowerName = new Map();
    const ambiguousNames = new Set();

    allProjects.forEach(p => {
        const lower = p.name.toLowerCase();

        if (byLowerName.has(lower)) {
            ambiguousNames.add(lower);
        } else {
            byLowerName.set(lower, p);
        }
    });

    const keys = new Set();
    const resolvedSpaces = [];

    spacesConfig.forEach(space => {
        const lower = space.name.toLowerCase();
        const project = byLowerName.get(lower);

        if (!project) {
            console.warn(
                `Warning: ${SPACES_PATH} lists space "${space.name}", but no Jira project with that exact name ` +
                'was found — check it matches the project name shown in Jira exactly (case-insensitive).'
            );
            return;
        }

        if (ambiguousNames.has(lower)) {
            console.warn(
                `Warning: ${SPACES_PATH} lists space "${space.name}", but more than one visible Jira project shares ` +
                `that name (case-insensitive) — resolved to "${project.key}", which may not be the one you meant.`
            );
        }

        keys.add(project.key);
        resolvedSpaces.push({ name: space.name, projectKey: project.key, boards: space.boards });
    });

    console.log(`Restricting sync to space(s): ${spacesConfig.map(s => s.name).join(', ')} (resolved project key(s): ${[...keys].join(', ') || 'none'})`);

    return { allowedProjectKeys: keys, resolvedSpaces };
}

async function findSpecialFieldIds(headers) {
    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/field`, { headers });

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

    if (!sprintField) {
        console.warn('Warning: no field with schema "com.pyxis.greenhopper.jira:gh-sprint" found in this Jira instance — PI will not be detected.');
    } else {
        console.log(`Found Sprint field: ${sprintField.id}`);
    }

    // Not finding this one is normal, not a warning: team-managed ("next-gen") projects, and any
    // company-managed project already on Jira's newer issue hierarchy, expose the Epic parent via the
    // standard `parent` field instead of this legacy custom field — `parent` is always requested
    // regardless (see main()), so this is only a fallback for instances still on the old Epic Link field.
    if (epicLinkField) {
        console.log(`Found Epic Link field: ${epicLinkField.id}`);
    }

    // Also normal to be missing: not every Jira instance has the "Flagged" field enabled on its board(s)
    // — `impediment` just stays false for every issue when it isn't found.
    if (flaggedField) {
        console.log(`Found Flagged field: ${flaggedField.id}`);
    }

    return {
        sprintFieldId: sprintField ? sprintField.id : null,
        epicLinkFieldId: epicLinkField ? epicLinkField.id : null,
        flaggedFieldId: flaggedField ? flaggedField.id : null,
    };
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

    const capped = epicKeys.slice(0, 100);
    const jql = `key in (${capped.join(', ')})`;
    const res = await fetch(
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
 * Resolves a board's display name to its numeric ID via the Jira Agile API — there's no other way to look
 * up a board's active sprint (see `fetchActiveSprintNames`) starting only from the name a human configured
 * in `docs/jira-spaces.json`. Jira's `name` filter on this endpoint does a fuzzy/partial, case-insensitive
 * match, so every candidate is still checked for an exact (case-insensitive) name match before being
 * trusted — same "warn and skip rather than silently pick the wrong one" pattern as
 * `filterExistingProjectKeys`.
 */
async function resolveBoardId(boardName, headers) {
    const res = await fetch(
        `${JIRA_BASE_URL}/rest/agile/1.0/board?name=${encodeURIComponent(boardName)}&maxResults=50`,
        { headers }
    );

    if (!res.ok) {
        console.warn(`Warning: could not look up board "${boardName}" (${res.status}) — skipping its current-PI fetch.`);
        return null;
    }

    const data = await res.json();
    const matches = (data.values || []).filter(b => (b.name || '').toLowerCase() === boardName.toLowerCase());

    if (!matches.length) {
        console.warn(`Warning: no board named "${boardName}" found in Jira — skipping its current-PI fetch.`);
        return null;
    }

    if (matches.length > 1) {
        console.warn(`Warning: more than one board named "${boardName}" found in Jira — skipping its current-PI fetch (ambiguous).`);
        return null;
    }

    return matches[0].id;
}

/**
 * A board's active sprint(s) — a Scrum board normally has exactly one, but Jira allows more than one to be
 * active at a time on some setups, so this always returns an array (possibly empty, e.g. a Kanban board
 * with no sprints at all, or one where nothing is currently active).
 */
async function fetchActiveSprintNames(boardId, headers) {
    const res = await fetch(
        `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/sprint?state=active&maxResults=50`,
        { headers }
    );

    if (!res.ok) {
        console.warn(`Warning: could not fetch active sprint(s) for board ${boardId} (${res.status}) — skipping its current-PI fetch.`);
        return [];
    }

    const data = await res.json();

    return (data.values || []).map(s => s.name).filter(Boolean);
}

/**
 * For every space that configured board name(s) in `docs/jira-spaces.json`, resolves each board's active
 * sprint(s) and derives the PI(s) currently in flight from their names, via the same PI-\d+\.\d+ sprint
 * naming convention `extractPiFromSprintName` already assumes elsewhere. Returns one entry per space that
 * found at least one PI: `{ name, projectKey, piNumbers }` (a `Set` of bare PI numbers, e.g. "27.3" — no
 * "PI-" prefix, for building JQL in `buildCurrentPiJql`). A space with no boards, an unresolvable board, or
 * a board with no detectable active-sprint PI is simply left out — never fails the run.
 */
async function resolveCurrentPiForSpaces(spaces, headers) {
    const results = [];

    for (const space of spaces) {
        const piNumbers = new Set();

        for (const boardName of space.boards) {
            // resolveBoardId/fetchActiveSprintNames only degrade gracefully on an HTTP error response
            // (!res.ok) — a thrown network-level error (timeout, DNS, etc.) would otherwise propagate all
            // the way out of main() and fail the *entire* sync over what's meant to be a best-effort,
            // additive fetch. Caught per board so one bad board can't even take down its own space's other
            // boards.
            try {
                const boardId = await resolveBoardId(boardName, headers);

                if (!boardId) {
                    continue;
                }

                const sprintNames = await fetchActiveSprintNames(boardId, headers);

                if (!sprintNames.length) {
                    console.warn(`Warning: board "${boardName}" (space "${space.name}") has no active sprint — skipping its current-PI fetch.`);
                }

                sprintNames.forEach(name => {
                    const pi = extractPiFromSprintName(name);

                    if (pi) {
                        piNumbers.add(pi.replace(/^PI-/, ''));
                    } else {
                        console.warn(`Warning: active sprint "${name}" on board "${boardName}" doesn't match the expected PI.SPRINT naming convention — can't derive its PI.`);
                    }
                });
            } catch (e) {
                console.warn(`Warning: unexpected error resolving board "${boardName}" (space "${space.name}") (${e.message}) — skipping its current-PI fetch.`);
            }
        }

        if (piNumbers.size) {
            results.push({ name: space.name, projectKey: space.projectKey, piNumbers });
        }
    }

    return results;
}

/**
 * One JQL clause per space with a detected current PI, scoped to that space's own project so a PI-number
 * match on `sprint`/`labels` can't leak in an unrelated ticket from a different project that happens to
 * reuse the same PI numbering. `sprint ~ "<num>"` relies on Jira Cloud's fuzzy text match against the
 * Sprint field's name (catches every sprint whose name contains the PI number, e.g. "27.3.1", "27.3.2" for
 * PI 27.3, without needing each sprint's ID) — the `labels` half of the OR catches issues tagged with a
 * `PI-X.Y` label instead of (or in addition to) a Sprint value, mirroring the same `pi` extraction priority
 * `fetchAndMapIssuesForJql` already applies.
 */
function buildCurrentPiJql(spacePiResults) {
    const clauses = spacePiResults.map(({ projectKey, piNumbers }) => {
        const piConditions = [...piNumbers]
            .flatMap(num => [`sprint ~ "${num}"`, `labels = "PI-${num}"`])
            .join(' OR ');

        return `(project = ${projectKey} AND (${piConditions}))`;
    });

    return clauses.length ? clauses.join(' OR ') : null;
}

/**
 * Fetches every issue matching `jql` (paginated) and maps it to ShipScope's issue shape, returning
 * `{ issues, sprintDates }` — `sprintDates` (keyed by sprint name) is a side channel of `startDate`/
 * `endDate` pairs collected along the way, for `main()` to roll up into each PI's `sprints` list in
 * `index.json`. `sprintFieldId`/`epicLinkFieldId`/`flaggedFieldId` are resolved once by the caller (see
 * `main()`) since they don't vary per JQL — only the query and its results do — so this can be called
 * once for the primary query and again for the board-derived current-PI query without re-resolving them.
 * `subtasks`/`priority`/`created`/`resolutiondate` are system fields, always available without needing a
 * resolved id.
 */
async function fetchAndMapIssuesForJql(jql, headers, sprintFieldId, epicLinkFieldId, flaggedFieldId) {
    const fieldsParam = ['summary', 'issuetype', 'labels', 'issuelinks', 'status', 'project', 'parent', 'subtasks', 'priority', 'created', 'resolutiondate', sprintFieldId, epicLinkFieldId, flaggedFieldId]
        .filter(Boolean)
        .join(',');

    let allRawIssues = [];
    let nextPageToken = null;
    let isLastPage = false;
    let pageCounter = 1;

    console.log(`Fetching issues from Jira for JQL: ${jql}`);

    while (!isLastPage) {
        // `jql` must be sent on every page, not just the first — the search/jql endpoint ties
        // nextPageToken to the JQL it was issued for, and rejects the token as invalid/expired if
        // the next request doesn't also carry the same jql.
        let url = `${JIRA_BASE_URL}/rest/api/3/search/jql?maxResults=100&fields=${fieldsParam}&jql=${encodeURIComponent(jql)}`;

        if (nextPageToken) {
            url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
        }

        const res = await fetch(url, { headers });

        if (!res.ok) {
            throw new Error(`Jira API error on page ${pageCounter}: ${res.status} ${await res.text()}`);
        }

        const data = await res.json();

        if (data.warningMessages && data.warningMessages.length) {
            console.warn(`Jira returned warnings on page ${pageCounter}:`, data.warningMessages);
        }

        const pageIssues = data.issues || [];
        allRawIssues = allRawIssues.concat(pageIssues);

        console.log(`Page ${pageCounter}: fetched ${pageIssues.length} issues. (isLast: ${data.isLast})`);

        nextPageToken = data.nextPageToken || null;
        isLastPage = data.isLast === true || !nextPageToken;
        pageCounter++;
    }

    console.log(`Total raw issues fetched from Jira instance: ${allRawIssues.length}`);

    console.log('Raw issues summary:', allRawIssues.map(i => ({
        key: i.key,
        type: i.fields?.issuetype?.name,
        labels: i.fields?.labels,
        sprint: sprintFieldId ? i.fields?.[sprintFieldId] : undefined,
        project: i.fields?.project?.name,
        parent: i.fields?.parent?.key,
    })));

    const TYPE_MAP = {
        'Epik': 'Epic', 'Epic': 'Epic',
        'Zadanie': 'Task', 'Task': 'Task',
        'Story': 'Story',
        'Bug': 'Bug',
    };

    // Keyed by sprint name (not PI — several sprints share one PI) so main() can roll these up into each
    // PI's `sprints` list for index.json without a second pass over the raw Jira response.
    const sprintDates = {};

    const issues = allRawIssues
        .map(issue => {
            if (!issue.fields || !issue.fields.issuetype) return null;

            const rawType = issue.fields.issuetype.name;
            const type = TYPE_MAP[rawType];

            if (!type) {
                return null;
            }

            const sprintInfo = sprintFieldId ? pickRelevantSprintInfo(issue.fields[sprintFieldId]) : null;
            const sprintName = sprintInfo ? sprintInfo.name : null;

            if (sprintInfo && !(sprintName in sprintDates)) {
                sprintDates[sprintName] = { startDate: sprintInfo.startDate, endDate: sprintInfo.endDate };
            }

            const labels = issue.fields.labels || [];
            const labelPi = labels.find(l => /^PI-?\d+\.\d+$/i.test(l)) || null;
            const pi = extractPiFromSprintName(sprintName) || labelPi;
            const blockers = (issue.fields.issuelinks || []).filter(link =>
                link.type?.inward === 'is blocked by' && link.inwardIssue &&
                link.inwardIssue.fields?.status?.statusCategory?.key !== 'done'
            );

            // The Jira project this issue lives in (e.g. "eMobility Sparks") — shown in the UI as
            // this issue's "space", since one org can split related work across several Jira
            // projects rather than one.
            const projectName = issue.fields.project?.name || null;

            // Jira's own "Flagged" impediment marker (the orange flag icon on a card) — orthogonal to
            // `status`: an issue can be "In Progress" and flagged as blocked at the same time. The field's
            // value is an array of `{ value: "Impediment" }` when set, empty/absent otherwise.
            const flaggedValue = flaggedFieldId ? issue.fields[flaggedFieldId] : null;
            const impediment = Array.isArray(flaggedValue) && flaggedValue.length > 0;

            // Sub-task completion — surfaces exactly the gap a parent issue's own status can hide (a
            // Story can read "In Test" or even "Done" while open sub-tasks/bugs remain). `null` when
            // there are no sub-tasks at all, same "nothing to show" convention as `epicRollup()`.
            const rawSubtasks = issue.fields.subtasks || [];
            const subtasks = rawSubtasks.length
                ? { done: rawSubtasks.filter(st => st.fields?.status?.statusCategory?.key === 'done').length, total: rawSubtasks.length }
                : null;

            // Epics don't have an Epic parent of their own — only resolve one for the other three
            // recognized types. Prefer the modern `parent` field (present on team-managed projects
            // and on any company-managed project already migrated to Jira's newer issue hierarchy)
            // since it carries the Epic's title inline; only fall back to the legacy Epic Link
            // custom field (key only — resolved separately, see `resolveEpicTitles`/
            // `fillMissingEpicTitles`) when `parent` isn't populated.
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
                ...(blockers.length > 0 ? { dependencyNote: `Blocked by ${blockers[0].inwardIssue.key}: ${blockers[0].inwardIssue.fields.summary}` } : {})
            };
        })
        .filter(i => i && i.pi);

    return { issues, sprintDates };
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

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

/**
 * Parses `BACKFILL_PIS` ("PI-27.1, PI-26.5" or "27.1 26.5") into a de-duplicated list of canonical
 * "PI-X.Y" labels — the manual-only escape hatch for pulling a specific PI's Jira data on demand (a past
 * one, or one that predates this sync ever running), without the default sync ever having to scan for it
 * (see `main()`/`runBackfillMode`).
 */
function parseBackfillPis() {
    const raw = process.env.BACKFILL_PIS || '';
    const labels = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
        .map(s => (/^\d+(\.\d+)+$/.test(s) ? `PI-${s}` : s.toUpperCase()));

    return [...new Set(labels)];
}

/**
 * Reads the existing `index.json` (if any) so a partial-scope run — the default current-PI-only fetch, or
 * an explicit `BACKFILL_PIS` run — can upsert just the PI(s) it actually fetched without disturbing any
 * other PI's already-synced shard file or index entry. Malformed/missing file degrades to an empty index,
 * same "start from scratch" spirit as every other optional-JSON read in this script.
 */
function readExistingIndex() {
    const indexPath = path.join(JIRA_ISSUES_DIR, 'index.json');

    if (!fs.existsSync(indexPath)) {
        return { currentPi: null, pis: [] };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

        return { currentPi: parsed.currentPi || null, pis: Array.isArray(parsed.pis) ? parsed.pis : [] };
    } catch (e) {
        console.warn(`Warning: could not parse existing ${indexPath} (${e.message}) — starting from an empty index.`);
        return { currentPi: null, pis: [] };
    }
}

/** Groups a flat issue list (plus the `sprintDates` side-channel `fetchAndMapIssuesForJql` collects) by
 *  `pi` — shared by every mode below, all of which eventually need the same one-shard-per-PI shape. */
function groupIssuesByPi(issues, sprintDates) {
    const issuesByPi = new Map();

    issues.forEach(issue => {
        if (!issuesByPi.has(issue.pi)) {
            issuesByPi.set(issue.pi, []);
        }

        issuesByPi.get(issue.pi).push(issue);
    });

    const sprintsByPi = new Map();

    issues.forEach(issue => {
        if (!issue.sprint) {
            return;
        }
        if (!sprintsByPi.has(issue.pi)) {
            sprintsByPi.set(issue.pi, new Map());
        }

        const sprintsForPi = sprintsByPi.get(issue.pi);

        if (!sprintsForPi.has(issue.sprint)) {
            const dates = sprintDates[issue.sprint] || {};

            sprintsForPi.set(issue.sprint, { name: issue.sprint, startDate: dates.startDate || null, endDate: dates.endDate || null });
        }
    });

    return { issuesByPi, sprintsByPi };
}

/**
 * Writes one shard file per PI in `issuesByPi`/`sprintsByPi` and updates `index.json`. Two scopes:
 *
 * - `'full'` — the historical, pre-partial-fetch behavior (still used by the explicit `JIRA_PROJECT_KEY`
 *   project sync, and by the default sync's own fallback when no current PI can be resolved from any
 *   configured board): `index.json` and the directory itself become an authoritative recompute of
 *   *everything* — any existing shard file for a PI that isn't part of this run's result gets deleted,
 *   since this scope's whole point is "here is the complete, current answer."
 * - `'partial'` — the default current-PI-only fetch, and `BACKFILL_PIS`: only the PI(s) actually fetched
 *   this run are touched. Every other existing shard file and index entry is read back and kept exactly
 *   as-is, so a narrow, cheap run can never accidentally erase a PI a previous, broader run already wrote.
 *
 * `currentPi` is written as given in `'full'` scope; in `'partial'` scope, passing `undefined` preserves
 * whatever `currentPi` the existing `index.json` already had (`BACKFILL_PIS` never changes it — only the
 * default sync's own current-PI resolution should).
 */
function writePiShards(issuesByPi, sprintsByPi, { scope, currentPi }) {
    fs.mkdirSync(JIRA_ISSUES_DIR, { recursive: true });

    const fetchedEntries = [...issuesByPi.keys()].sort(comparePiDesc).map(pi => ({
        pi,
        file: `${safeFileSlug(pi)}.json`,
        sprints: [...(sprintsByPi.get(pi)?.values() || [])],
    }));

    let finalPiEntries;
    let finalCurrentPi;

    if (scope === 'full') {
        finalPiEntries = fetchedEntries;
        finalCurrentPi = currentPi;

        const validFileNames = new Set(finalPiEntries.map(e => e.file).concat(['index.json']));

        fs.readdirSync(JIRA_ISSUES_DIR)
            .filter(name => !validFileNames.has(name))
            .forEach(name => fs.unlinkSync(path.join(JIRA_ISSUES_DIR, name)));
    } else {
        const existing = readExistingIndex();
        const byPi = new Map(existing.pis.map(e => [e.pi, e]));

        fetchedEntries.forEach(e => byPi.set(e.pi, e));

        finalPiEntries = [...byPi.values()].sort((a, b) => comparePiDesc(a.pi, b.pi));
        finalCurrentPi = currentPi !== undefined ? currentPi : existing.currentPi;
    }

    fetchedEntries.forEach(({ pi, file }) => {
        fs.writeFileSync(path.join(JIRA_ISSUES_DIR, file), JSON.stringify(issuesByPi.get(pi), null, 2));
    });

    fs.writeFileSync(
        path.join(JIRA_ISSUES_DIR, 'index.json'),
        JSON.stringify({ currentPi: finalCurrentPi, pis: finalPiEntries }, null, 2)
    );

    const issueCount = [...issuesByPi.values()].reduce((n, list) => n + list.length, 0);

    console.log(
        `Wrote ${issueCount} issue(s) across ${fetchedEntries.length} PI file(s) to ${JIRA_ISSUES_DIR} ` +
        `(scope: ${scope}, current PI: ${finalCurrentPi || 'unknown'}).`
    );
}

/**
 * `BACKFILL_PIS`: an explicit, manually-triggered ask for one or more specific PIs' Jira data — the
 * escape hatch for anything the default current-PI-only sync (see `main()`) doesn't cover, e.g.
 * re-fetching a past PI, or seeding one that predates this sync ever running. Scoped to whichever
 * project(s) are already configured (explicit `JIRA_PROJECT_KEY`, else every resolved
 * `docs/jira-spaces.json` space) via the exact same `sprint ~`/`labels =` match `buildCurrentPiJql` uses
 * for the real current-PI fetch, just parameterized by the requested PI(s) instead of an active sprint's
 * derived one. Never touches any other PI's shard file or `index.json`'s `currentPi`.
 */
async function runBackfillMode(requestedPis, explicitProjectKeys, resolvedSpaces, headers) {
    const piNumbers = requestedPis.map(pi => pi.replace(/^PI-/i, ''));
    const projectKeys = explicitProjectKeys.length ? explicitProjectKeys : resolvedSpaces.map(s => s.projectKey);

    let jql;

    if (projectKeys.length) {
        jql = buildCurrentPiJql(projectKeys.map(projectKey => ({ projectKey, piNumbers: new Set(piNumbers) })));
    } else {
        console.warn(
            `Warning: no project scope configured (no JIRA_PROJECT_KEY, no space in ${SPACES_PATH}) — ` +
            `backfilling PI(s) ${requestedPis.join(', ')} with an unscoped sprint/label match, which may ` +
            'pick up issues from an unrelated project that happens to reuse the same PI numbering.'
        );

        const piConditions = piNumbers.flatMap(num => [`sprint ~ "${num}"`, `labels = "PI-${num}"`]).join(' OR ');

        jql = `(${piConditions})`;
    }

    console.log(`Backfilling PI(s): ${requestedPis.join(', ')}`);

    const { sprintFieldId, epicLinkFieldId, flaggedFieldId } = await findSpecialFieldIds(headers);
    const cacheKey = `jira-backfill-${crypto.createHash('sha256').update(jql).digest('hex')}`;
    const { issues: rawIssues, sprintDates } = await loadOrCompute(
        cacheKey,
        () => fetchAndMapIssuesForJql(jql, headers, sprintFieldId, epicLinkFieldId, flaggedFieldId)
    );

    await fillMissingEpicTitles(rawIssues, headers);

    // `sprint ~ "<num>"` is a fuzzy text match — filter back down to exactly the requested PI(s) so a
    // coincidental substring match (e.g. a differently-numbered sprint that happens to contain "27.1")
    // can't get written into a file nobody asked for.
    const requestedPiSet = new Set(requestedPis);
    const issues = rawIssues.filter(i => requestedPiSet.has(i.pi));
    const droppedCount = rawIssues.length - issues.length;

    if (droppedCount > 0) {
        console.warn(
            `Dropped ${droppedCount} issue(s) matched by the backfill query but resolved to a PI other ` +
            'than the one(s) requested (sprint/label text overlap) — not written to any file.'
        );
    }

    const emptyPis = requestedPis.filter(pi => !issues.some(i => i.pi === pi));

    if (emptyPis.length) {
        console.warn(`No issues found for requested PI(s): ${emptyPis.join(', ')} — leaving them unwritten.`);
    }

    const { issuesByPi, sprintsByPi } = groupIssuesByPi(issues, sprintDates);

    writePiShards(issuesByPi, sprintsByPi, { scope: 'partial', currentPi: undefined });
}

/**
 * The default sync's preferred path: scoped to just the board-derived current PI(s) (see
 * `resolveCurrentPiForSpaces`/`buildCurrentPiJql`) rather than every issue key ever referenced across
 * `deployments.json`'s full history — bounded cost regardless of how much deployment history
 * accumulates, since it's always just "whatever's active right now," not "everything ever." Only the
 * resolved current PI's shard(s) are touched; every other PI's file is left as some earlier run (a
 * full-mode fallback run, or a `BACKFILL_PIS` run) wrote it.
 */
async function runCurrentPiOnlyMode(currentPiJql, currentPiResults, headers) {
    const { sprintFieldId, epicLinkFieldId, flaggedFieldId } = await findSpecialFieldIds(headers);
    const cacheKey = `jira-currentpi-${crypto.createHash('sha256').update(currentPiJql).digest('hex')}`;
    const { issues, sprintDates } = await loadOrCompute(
        cacheKey,
        () => fetchAndMapIssuesForJql(currentPiJql, headers, sprintFieldId, epicLinkFieldId, flaggedFieldId)
    );

    await fillMissingEpicTitles(issues, headers);

    const resolvedCurrentPi = currentPiResults.flatMap(r => [...r.piNumbers]).map(n => `PI-${n}`).sort(comparePiDesc)[0] || null;

    if (!issues.length) {
        console.warn(
            "Board-derived current-PI query returned no usable issues this run — leaving index.json's " +
            'currentPi and every existing PI file untouched rather than pointing at an empty shard.'
        );
    }

    const { issuesByPi, sprintsByPi } = groupIssuesByPi(issues, sprintDates);

    writePiShards(issuesByPi, sprintsByPi, { scope: 'partial', currentPi: issues.length ? resolvedCurrentPi : undefined });
}

/**
 * The pre-sharding default, kept as a fallback for whenever `runCurrentPiOnlyMode` above can't run at all
 * — no space in `docs/jira-spaces.json` has a `boards` entry, or every configured board's active sprint
 * failed to resolve — and also the always-used path for the explicit `JIRA_PROJECT_KEY` opt-in. Scoped to
 * the exact issue keys referenced in `deployments.json` (or, with `JIRA_PROJECT_KEY` set, whole
 * project(s) instead), same as before per-PI sharding existed, optionally topped up with the board-derived
 * current-PI supplement for any space not already fully covered by an explicit project. This is a
 * `'full'`-scope run: every PI it finds becomes the complete, authoritative set — any other PI's existing
 * shard file that isn't part of this run's result gets deleted, exactly like the old single-file sync did.
 */
async function runFullScopeMode(explicitProjectKeys, allowedProjectKeys, currentPiJql, currentPiResults, headers) {
    let JQL = null;
    // Only set in explicit whole-project mode — used below to skip the board-derived current-PI fetch for
    // a project that's already being fetched in full, since it can't add anything there.
    let fullyCoveredProjectKeys = null;

    if (explicitProjectKeys.length) {
        // Explicit opt-in: search whole project(s) end to end, not just issues already referenced by a
        // commit — useful for a project ShipScope should track completely from the start.
        const validProjectKeys = await filterExistingProjectKeys(explicitProjectKeys, headers);
        const scopedProjectKeys = allowedProjectKeys
            ? validProjectKeys.filter(k => allowedProjectKeys.has(k))
            : validProjectKeys;

        if (scopedProjectKeys.length) {
            console.log(`Using project key(s): ${scopedProjectKeys.join(', ')}`);
            JQL = buildJql(scopedProjectKeys);
            fullyCoveredProjectKeys = new Set(scopedProjectKeys);
        }
    } else {
        // Fallback: scope strictly to issue keys actually referenced in synced commit messages — a
        // ticket mentioned once in a commit shouldn't pull in every other, unrelated ticket from
        // whichever project it happens to belong to.
        const referencedKeys = deriveIssueKeysFromDeployments(readDeployments());
        const referencedProjectKeys = [...new Set(referencedKeys.map(projectKeyOf))];
        const validProjectKeys = await filterExistingProjectKeys(referencedProjectKeys, headers);
        const validProjectKeySet = new Set(validProjectKeys);
        let issueKeys = referencedKeys.filter(k => validProjectKeySet.has(projectKeyOf(k)));

        if (allowedProjectKeys) {
            issueKeys = issueKeys.filter(k => allowedProjectKeys.has(projectKeyOf(k)));
        }

        if (issueKeys.length) {
            console.log(`Using referenced issue key(s): ${issueKeys.join(', ')}`);
            JQL = buildJqlForKeys(issueKeys);
        }
    }

    const effectiveCurrentPiJql = fullyCoveredProjectKeys
        ? buildCurrentPiJql(currentPiResults.filter(r => !fullyCoveredProjectKeys.has(r.projectKey)))
        : currentPiJql;

    let issues = [];
    let sprintDates = {};

    if (!JQL && !effectiveCurrentPiJql) {
        console.warn(
            'Could not determine any usable Jira issue/project key or board-derived current-PI query to ' +
            `search: JIRA_PROJECT_KEY is not set, none of the issue keys referenced in ${DEPLOYMENTS_PATH} ` +
            `resolved to a real, visible Jira project${allowedProjectKeys ? ` allowed by ${SPACES_PATH}` : ''}, ` +
            `and no space in ${SPACES_PATH} has a board with a detectable active-sprint PI. Skipping Jira ` +
            'fetch and falling back to deployment-derived issue stubs.'
        );
    } else {
        const { sprintFieldId, epicLinkFieldId, flaggedFieldId } = await findSpecialFieldIds(headers);
        const issuesByKey = new Map();

        if (JQL) {
            // Fetching from Jira is expensive/rate-limited and depends only on JQL itself, not on `live`'s
            // git state — cached per exact query so a retry after a losing push (see
            // .github/actions/sync-with-retry) reuses this instead of re-querying Jira from scratch. Keying
            // on a hash of JQL (rather than a fixed key) means a genuinely different query — e.g. because
            // deployments.json picked up a new referenced issue in between — still fetches fresh instead of
            // serving a stale result.
            const cacheKey = `jira-${crypto.createHash('sha256').update(JQL).digest('hex')}`;
            const primaryResult = await loadOrCompute(cacheKey, () => fetchAndMapIssuesForJql(JQL, headers, sprintFieldId, epicLinkFieldId, flaggedFieldId));

            primaryResult.issues.forEach(i => issuesByKey.set(i.key, i));
            Object.assign(sprintDates, primaryResult.sprintDates);
        }

        if (effectiveCurrentPiJql) {
            // Unlike the primary JQL fetch above (a real failure there should fail the whole run — see
            // sync-with-retry), this one is additive/best-effort: if it fails, fall back to just the
            // primary result set rather than losing an otherwise-successful sync over the extra data.
            try {
                const cacheKey = `jira-currentpi-${crypto.createHash('sha256').update(effectiveCurrentPiJql).digest('hex')}`;
                const currentPiResult = await loadOrCompute(cacheKey, () => fetchAndMapIssuesForJql(effectiveCurrentPiJql, headers, sprintFieldId, epicLinkFieldId, flaggedFieldId));

                currentPiResult.issues.forEach(i => { if (!issuesByKey.has(i.key)) issuesByKey.set(i.key, i); });
                Object.assign(sprintDates, currentPiResult.sprintDates);
            } catch (e) {
                console.warn(`Warning: board-derived current-PI Jira fetch failed (${e.message}) — proceeding with just the primary result set.`);
            }
        }

        issues = [...issuesByKey.values()];

        await fillMissingEpicTitles(issues, headers);
    }

    if (!issues.length) {
        if (JQL || effectiveCurrentPiJql) {
            console.warn(
                'Jira returned no usable issues (either 0 results, or none with a detectable PI) — ' +
                'falling back to deployment-derived issue stubs.'
            );
        }

        issues = buildFallbackIssuesFromDeployments(readDeployments());
        console.log(`Derived ${issues.length} fallback issue stub(s) from deployment commit history.`);
    }

    // Board-derived current-PI results (if any) are the most authoritative signal for "what PI is the team
    // actually in right now" — falls back to the highest PI seen among non-Epic issues (the same heuristic
    // docs/app.js's own currentPi() used client-side before this index existed) when no board is configured
    // or it couldn't be resolved this run, and to `null` when even that finds nothing (e.g. a fully
    // fallback-stub run with no real PI at all).
    const currentPiFromBoards = currentPiResults
        .flatMap(r => [...r.piNumbers])
        .map(n => `PI-${n}`)
        .sort(comparePiDesc)[0] || null;
    const currentPiFromIssues = [...new Set(issues.filter(i => i.type !== 'Epic' && i.pi).map(i => i.pi))]
        .sort(comparePiDesc)[0] || null;
    const currentPi = currentPiFromBoards || currentPiFromIssues || null;

    // One-time cleanup of the pre-sharding output this replaces — removed here (rather than left for
    // someone to notice and delete by hand) so its removal ships in the same commit as the new per-PI
    // files below, instead of sitting orphaned on `live` forever.
    const legacyOutputPath = 'docs/data/jira-issues.json';

    if (fs.existsSync(legacyOutputPath)) {
        fs.unlinkSync(legacyOutputPath);
    }

    const { issuesByPi, sprintsByPi } = groupIssuesByPi(issues, sprintDates);

    writePiShards(issuesByPi, sprintsByPi, { scope: 'full', currentPi });
}

async function main() {
    // Force English API responses regardless of the authenticating account's Jira profile language —
    // otherwise issue type names (and other localizable strings) come back translated (e.g. Chinese:
    // 任务/缺陷/故事/长篇故事/子任务 for Task/Bug/Story/Epic/Subtask), which TYPE_MAP below doesn't recognize,
    // silently dropping every issue and triggering the deployment-derived fallback stub path.
    const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Accept-Language': 'en-US' };

    // `null` = no docs/jira-spaces.json (or it's empty) = don't restrict anything, same as before this
    // existed. Otherwise a Set of resolved project keys, intersected into whichever project/issue-key list
    // each branch below was about to search — so the allowlist applies no matter which mode is active.
    const spacesConfig = readSpacesConfig();
    const { allowedProjectKeys, resolvedSpaces } = await resolveSpacesConfig(spacesConfig, headers);
    const explicitProjectKeys = parseExplicitProjectKeys();
    const backfillPis = parseBackfillPis();

    if (backfillPis.length) {
        await runBackfillMode(backfillPis, explicitProjectKeys, resolvedSpaces, headers);
        return;
    }

    // Board-derived low-cost "what PI is currently in flight" resolution — same Agile-API lookup this
    // always had, just now doubling as the *entire* default sync's scope (see runCurrentPiOnlyMode)
    // instead of merely a supplement to a broader scan, whenever it resolves anything. A space already
    // fully covered by an explicit JIRA_PROJECT_KEY project gets filtered back out inside
    // runFullScopeMode, same as before this split existed.
    const spacesNeedingCurrentPi = resolvedSpaces.filter(s => s.boards.length);
    let currentPiResults = [];

    if (spacesNeedingCurrentPi.length) {
        try {
            currentPiResults = await loadOrCompute('jira-current-pi-clauses', () => resolveCurrentPiForSpaces(spacesNeedingCurrentPi, headers));
        } catch (e) {
            console.warn(`Warning: could not resolve board-derived current-PI data (${e.message}) — proceeding without it, same as if no boards were configured.`);
        }
    }

    const currentPiJql = buildCurrentPiJql(currentPiResults);

    if (explicitProjectKeys.length) {
        // Explicit opt-in is unaffected by the current-PI-only default below — an operator who set
        // JIRA_PROJECT_KEY deliberately wants everything in that project, every run.
        await runFullScopeMode(explicitProjectKeys, allowedProjectKeys, currentPiJql, currentPiResults, headers);
        return;
    }

    if (currentPiJql) {
        await runCurrentPiOnlyMode(currentPiJql, currentPiResults, headers);
        return;
    }

    console.warn(
        `No space in ${SPACES_PATH} has a board with a detectable active-sprint PI — falling back to the ` +
        "broad deploy-referenced-issue-key sync (see CLAUDE.md's Jira issues section). Configure a space's " +
        '"boards" to switch to the cheaper current-PI-only default.'
    );
    await runFullScopeMode([], allowedProjectKeys, null, [], headers);
}

module.exports = {
    deriveIssueKeysFromDeployments,
    buildJql,
    buildJqlForKeys,
    buildCurrentPiJql,
    extractPiFromSprintName,
    pickRelevantSprintInfo,
    comparePiDesc,
    safeFileSlug,
    pickBestType,
    buildFallbackIssuesFromDeployments,
    parseBackfillPis,
    groupIssuesByPi,
    writePiShards,
    readExistingIndex,
};

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
