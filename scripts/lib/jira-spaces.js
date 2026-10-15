const fs = require('fs');
const { fetchWithRetry } = require('./jira-api');
const { loadOrCompute } = require('./retry-cache');
const { JIRA_BASE_URL, SPACES_PATH } = require('./jira-config');

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
    const res = await fetchWithRetry(
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
        const res = await fetchWithRetry(`${JIRA_BASE_URL}/rest/api/3/project/search?maxResults=100&startAt=${startAt}`, { headers });

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
 * Thrown for an actual schema violation in `docs/jira-spaces.json` (wrong field type, missing name) — a
 * real config bug, not the deliberate "no restriction" case a plain string/missing-file already covers, so
 * it's never silently degraded the way a JSON parse failure is below. Left uncaught here (and in `main()`,
 * which calls `readSpacesConfig()` directly, unwrapped) so it fails the whole run loudly instead of quietly
 * applying less filtering than configured.
 */
class JiraSpacesConfigError extends Error {}

/**
 * Reads the optional `docs/jira-spaces.json` allowlist and normalizes each `spaces` entry to
 * `{ name, boards, teams }` — a plain string entry (the original shape) is the deliberate "no boards/teams
 * configured, no restriction beyond the project allowlist itself" case, while `{ name, boards, teams }`
 * additionally opts that space into the low-cost current-PI fetch (see `resolveCurrentPiForSpaces`) and/or
 * the Team-field double-check (see `fetchAndMapIssuesForJql`). Malformed/unparsable file degrades to `[]`
 * (no restriction), same spirit as every other optional-config read in this codebase — but a well-formed
 * JSON file with a badly-shaped *entry* (wrong field type, missing name) throws `JiraSpacesConfigError`
 * instead of silently dropping or misreading that entry; see that class's own comment for why.
 */
function readSpacesConfig() {
    if (!fs.existsSync(SPACES_PATH)) {
        return [];
    }

    let config;

    try {
        config = JSON.parse(fs.readFileSync(SPACES_PATH, 'utf8'));
    } catch (e) {
        console.warn(`Warning: could not parse ${SPACES_PATH} (${e.message}) — proceeding with no space restriction.`);
        return [];
    }

    const list = Array.isArray(config.spaces) ? config.spaces : [];

    return list.filter(Boolean).map(entry => {
        if (typeof entry === 'string') {
            return { name: entry, boards: [], teams: [] };
        }

        if (typeof entry !== 'object') {
            throw new JiraSpacesConfigError(`${SPACES_PATH}: a "spaces" entry must be a string or an object, got ${typeof entry}.`);
        }

        if (typeof entry.name !== 'string' || !entry.name) {
            throw new JiraSpacesConfigError(`${SPACES_PATH}: a "spaces" entry is missing a valid, non-empty string "name".`);
        }

        if (entry.boards !== undefined && !Array.isArray(entry.boards)) {
            throw new JiraSpacesConfigError(
                `${SPACES_PATH}: space "${entry.name}" has "boards" of type ${typeof entry.boards} ` +
                `(${JSON.stringify(entry.boards)}) — expected an array of board name strings.`
            );
        }

        if (entry.teams !== undefined && !Array.isArray(entry.teams)) {
            throw new JiraSpacesConfigError(
                `${SPACES_PATH}: space "${entry.name}" has "teams" of type ${typeof entry.teams} ` +
                `(${JSON.stringify(entry.teams)}) — expected an array of team name strings.`
            );
        }

        // Independent of `boards`: a space whose Jira project is shared across more than one team,
        // with no single dedicated board of its own, has no way to populate `boards` at all — but
        // can still name its own allowed Jira "Team" field value(s) here so the Team-field
        // double-check below (which otherwise only ever activates when `boards` is non-empty) can
        // still reject a differently-teamed issue, instead of applying zero team filtering just
        // because no board happens to exist.
        const boards = (entry.boards || []).filter(Boolean);
        const teams = (entry.teams || []).filter(Boolean);

        // An object entry (as opposed to a plain string) is a deliberate opt-in to board/team scoping —
        // if it still ends up with nothing in either list (every entry filtered out as empty/falsy, or
        // both keys just never populated), that's a config mistake, not the equivalent of a plain-string
        // "no restriction" entry: found and fixed as a real fail-open gap, since this combination used to
        // silently apply zero team filtering with no signal anything was wrong. A genuine "no restriction"
        // intent should use a plain string entry instead, which this warning never fires for.
        if ((entry.boards !== undefined || entry.teams !== undefined) && !boards.length && !teams.length) {
            console.warn(
                `::warning::${SPACES_PATH}: space "${entry.name}" is configured as an object (opting into ` +
                'board/team scoping) but its "boards" and "teams" both end up empty — this applies ZERO team ' +
                'filtering, identical to not configuring the space at all. If that is genuinely intended, use a ' +
                'plain string entry instead; otherwise this is likely a typo (e.g. a board/team name that got ' +
                'filtered out as empty).'
            );
        }

        return { name: entry.name, boards, teams };
    }).filter(e => e.name);
}

/**
 * Resolves each configured space's name to a real Jira project key (the same allowlist role
 * `docs/jira-spaces.json` has always had), and — for any space that also configured board name(s) —
 * carries its resolved project key alongside those board names, so `resolveCurrentPiForSpaces` can look up
 * their active sprints without re-resolving project keys itself. Returns
 * `{ allowedProjectKeys: null, resolvedSpaces: [] }` only when `docs/jira-spaces.json` itself has nothing
 * configured (no restriction, matching the original nullable-means-unconfirmed behavior) — a *failure* to
 * resolve spaces that genuinely *are* configured now throws instead (see below), it never returns this
 * same "nothing configured" shape.
 */
async function resolveSpacesConfig(spacesConfig, headers) {
    if (!spacesConfig.length) {
        return { allowedProjectKeys: null, resolvedSpaces: [] };
    }

    // Cached across sync-with-retry attempts in the same job — same rate-limit-safety reason
    // loadOrCompute already exists for the main issue search below, just keyed on a fixed name since this
    // fetch's shape never varies per run.
    //
    // Deliberately NOT caught here (past tense: it used to degrade to "no restriction" on failure, i.e.
    // return the exact same `{ allowedProjectKeys: null, resolvedSpaces: [] }` shape as "nothing configured
    // at all"). That was safe before per-PI sharding existed, but main() now reads an empty `resolvedSpaces`
    // as "no space is configured" and routes to runFullScopeMode's `'full'` scope — an authoritative
    // recompute that deletes any existing PI shard not in its (now deploy-referenced-stub-only) result. A
    // transient Jira error here would otherwise silently wipe every PI's data instead of just failing this
    // run — letting it throw means sync-with-retry's retry loop (and the daily cron safety net) recover
    // transparently instead, same as any other real Jira fetch failure elsewhere in this file.
    const allProjects = await loadOrCompute('jira-spaces-projects', () => fetchAllProjects(headers));

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
        // `name` is the canonical Jira project name (`project.name`), not the config file's own spelling
        // (`space.name`) — found and fixed as a real bug: buildBoardNamesByProjectName/
        // buildTeamNamesByProjectName key their maps off this field, then look them up later via
        // `issue.fields.project.name` (always Jira's exact casing). The space-name resolution above is
        // deliberately case-insensitive so a config typo still finds the right project, but that same typo
        // used to then make the *map lookup* miss with an exact-match `[projectName]`, silently emptying
        // `allowedBoardNames`/`allowedTeamNames` — including the fail-closed "no board, but team confirmed"
        // rule a boardless space with `teams` configured relies on.
        resolvedSpaces.push({ name: project.name, projectKey: project.key, boards: space.boards, teams: space.teams });
    });

    console.log(`Restricting sync to space(s): ${spacesConfig.map(s => s.name).join(', ')} (resolved project key(s): ${[...keys].join(', ') || 'none'})`);

    return { allowedProjectKeys: keys, resolvedSpaces };
}

/** `resolvedSpaces` → `{ [space.name]: boards }`, so `fetchAndMapIssuesForJql` can scope
 *  `pickRelevantSprintInfo`'s sprint pick to each issue's own space's configured board(s) by looking it up
 *  via `issue.fields.project.name`. A space with no `boards` configured maps to `[]`, which
 *  `pickRelevantSprintInfo` already treats as "no filtering" — same behavior as before this existed. */
function buildBoardNamesByProjectName(resolvedSpaces) {
    const map = {};

    (resolvedSpaces || []).forEach(space => {
        map[space.name] = space.boards || [];
    });

    return map;
}

/** `resolvedSpaces` → `{ [space.name]: [...boards, ...teams] }` — the Team-field double-check's own
 *  allowlist, deliberately a *different* map than `buildBoardNamesByProjectName` even though board names
 *  are included here too (a board name already doubles as a valid Team-field value for a space like
 *  "eMobility Sparks" — see CLAUDE.md). The explicit `teams` list is what lets a space with no board of
 *  its own at all (a Jira project genuinely shared across more than one team, with no single dedicated
 *  board to configure) still have the Team-field check activate — previously, that check only ever ran
 *  when `boards` was non-empty, so a boardless space applied zero team filtering no matter what. */
function buildTeamNamesByProjectName(resolvedSpaces) {
    const map = {};

    (resolvedSpaces || []).forEach(space => {
        map[space.name] = [...(space.boards || []), ...(space.teams || [])];
    });

    return map;
}

module.exports = {
    JiraSpacesConfigError,
    filterExistingProjectKeys,
    fetchAllProjects,
    readSpacesConfig,
    resolveSpacesConfig,
    buildBoardNamesByProjectName,
    buildTeamNamesByProjectName,
};
