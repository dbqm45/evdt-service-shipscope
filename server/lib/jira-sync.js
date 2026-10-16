const { withScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');
const { accessTokenFor, JiraNotConnectedError } = require('./jira-connections');
const {
    AtlassianError, WEBHOOK_SCOPE, fetchBoards, fetchSprints, fetchVersions, fetchFieldIds, searchIssues, registerWebhooks, refreshWebhooks, deleteWebhooks,
} = require('./atlassian');
const {
    RhythmTemplateError, compileTemplate, extractPiFromSprintName, rhythmOf, piOfSprint, comparePiDesc, currentPiOf, previousPiOf,
    releaseName, currentReleaseOf, previousReleaseOf, flowMonth, releaseJql, flowJql, issueFields, mapIssue,
} = require('./jira-model');

/**
 * FR-008 (which boards a tenant syncs) and FR-009 (syncing their issues, migration 010).
 *
 * Per pass and board: the board's current increment is fully re-synced -- every issue in it (in the board's sprints
 * of that PI or sprint; with that fixVersion in the board's project for a release; resolved in that month or in
 * progress for a flow month), plus the Epics they belong to -- and replaces what was stored for that board and
 * increment (an issue that left it is simply gone from it). Earlier PIs are kept as they were last synced; a board's first sync also takes the PI
 * before the current one, so a new tenant sees more than one increment. All Jira calls happen before the write
 * transaction.
 */

class JiraBoardError extends Error {}

// The dashboard's "Now" increment: every selected board's current one together (teams in different rhythms -- a PI,
// a sprint -- are all "now" at once). Not a name Jira can produce: increments are PI labels or sprint names.
const NOW_KEY = '@now';

const EPIC_BATCH = 100;
const DAY_MS = 24 * 3600_000;
const WEBHOOK_LIFETIME_MS = 30 * DAY_MS; // Atlassian drops a dynamic webhook 30 days after registering or refreshing it
const WEBHOOK_REFRESH_BEFORE_MS = 7 * DAY_MS;
const WEBHOOK_RECONNECT = 'Reconnect Jira to allow instant updates (this connection was made before ShipScope asked for webhooks)';
const ERROR_MAX_LENGTH = 300;

/**
 * The site's boards, each with its type and marked selected or not. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, atlassian: object, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ boardId: number, name: string, type: string|null, projectKey: string|null, projectName: string|null, selected: boolean, rhythm?: string, piTemplate?: string|null, currentIncrement?: string|null }>>}
 *   rhythm, piTemplate and currentIncrement on selected boards
 */
async function listBoards(pool, { tenantId, actorUserId, atlassian, fetch: fetchFn = fetch }) {
    const selected = await withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query('SELECT board_id, rhythm, pi_template, current_increment FROM jira_boards WHERE tenant_id = $1', [tenantId]);
        return new Map(rows.map((r) => [Number(r.board_id), { rhythm: r.rhythm, piTemplate: r.pi_template, currentIncrement: r.current_increment }]));
    });
    const { accessToken, cloudId } = await accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn });
    const boards = await fetchBoards({ accessToken, cloudId, fetch: fetchFn });
    return boards.map((b) => ({ ...b, selected: selected.has(b.boardId), ...(selected.get(b.boardId) || {}) }));
}

/**
 * Sets how a selected board's work groups into increments (lib/jira-model.js rhythmOf()). A change drops the
 * board's synced issues, so its next sync starts over under the new rhythm. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, boardId: number, rhythm: 'auto'|'pi'|'sprint'|'release'|'flow', piTemplate: string|null }} input
 * @returns {Promise<{ boardId: number, rhythm: string, piTemplate: string|null }>}
 * @throws {JiraBoardError} not a selected board, or an invalid template
 */
async function configureBoard(pool, { tenantId, actorUserId, boardId, rhythm, piTemplate }) {
    if (piTemplate !== null) {
        if (rhythm !== 'pi' && rhythm !== 'auto') throw new JiraBoardError('A PI template only applies to the "pi" or "auto" rhythm');
        try {
            compileTemplate(piTemplate);
        } catch (err) {
            if (err instanceof RhythmTemplateError) throw new JiraBoardError(err.message);
            throw err;
        }
    }
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows: [before] } = await client.query(
            'SELECT rhythm, pi_template FROM jira_boards WHERE tenant_id = $1 AND board_id = $2 FOR UPDATE',
            [tenantId, boardId]
        );
        if (!before) throw new JiraBoardError(`Board ${boardId} is not selected for sync`);
        if (before.rhythm !== rhythm || before.pi_template !== piTemplate) {
            await client.query(
                'UPDATE jira_boards SET rhythm = $3, pi_template = $4, current_increment = NULL WHERE tenant_id = $1 AND board_id = $2',
                [tenantId, boardId, rhythm, piTemplate]
            );
            await client.query('DELETE FROM jira_issues WHERE tenant_id = $1 AND board_id = $2', [tenantId, boardId]);
        }
        return { boardId, rhythm, piTemplate };
    });
}

/**
 * Sets the boards to sync (replacing the selection). Each must be a board of the connected site; any type (a kanban
 * board syncs in the `flow` rhythm). Issues of boards no longer selected are removed. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, boardIds: number[], atlassian: object, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ boardId: number, name: string, projectKey: string|null, projectName: string|null }>>} the selection
 * @throws {JiraBoardError} a board that isn't on the site
 */
async function setBoards(pool, { tenantId, actorUserId, boardIds, atlassian, fetch: fetchFn = fetch }) {
    await withScope(pool, { tenantId }, (client) => assertAdmin(client, { tenantId, userId: actorUserId }));
    const { accessToken, cloudId } = await accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn });
    const available = new Map((await fetchBoards({ accessToken, cloudId, fetch: fetchFn })).map((b) => [b.boardId, b]));
    const missing = boardIds.find((id) => !available.has(id));
    if (missing !== undefined) throw new JiraBoardError(`Board ${missing} is not on the connected Jira site`);
    const chosen = boardIds.map((id) => available.get(id));
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        // The connection may have been removed while Jira was being asked.
        const { rows } = await client.query('SELECT 1 FROM jira_connections WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
        if (!rows.length) throw new JiraNotConnectedError('Jira is not connected');
        await client.query('DELETE FROM jira_boards WHERE tenant_id = $1 AND NOT (board_id = ANY($2))', [tenantId, boardIds]);
        await client.query('DELETE FROM jira_issues WHERE tenant_id = $1 AND NOT (board_id = ANY($2))', [tenantId, boardIds]);
        for (const b of chosen) {
            await client.query(
                `INSERT INTO jira_boards (tenant_id, board_id, name, project_key, project_name) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (tenant_id, board_id) DO UPDATE SET name = EXCLUDED.name, project_key = EXCLUDED.project_key, project_name = EXCLUDED.project_name`,
                [tenantId, b.boardId, b.name, b.projectKey, b.projectName]
            );
        }
        return chosen;
    });
}

/**
 * All issues `jql` finds, plus the Epics they belong to, mapped for `pi`. `sprints`: the board's sprints in it (an
 * issue's sprint is the one among them); without sprints (a release, a flow month) the increment is its own sprint.
 */
async function fetchIncrementIssues({ accessToken, cloudId, fieldIds, pi, jql, sprints, fetch: fetchFn }) {
    const sprintsInScope = new Map(sprints.map((s) => [s.id, s]));
    const fields = issueFields(fieldIds);
    const scope = { pi, sprintsInScope };
    const raw = await searchIssues({ accessToken, cloudId, jql, fields, fetch: fetchFn });
    const issues = new Map();
    for (const r of raw) {
        const issue = mapIssue(r, fieldIds, { ...scope, sprint: sprints.length ? null : pi });
        if (issue) issues.set(issue.key, issue);
    }
    // Epics rarely sit in a sprint themselves; without them the dashboard's Epic headers would have no status.
    const epicKeys = [...new Set([...issues.values()].map((i) => i.epicKey).filter((k) => k && !issues.has(k) && /^[A-Z][A-Z0-9_]*-\d+$/.test(k)))];
    for (let i = 0; i < epicKeys.length; i += EPIC_BATCH) {
        const batch = epicKeys.slice(i, i + EPIC_BATCH);
        const epics = await searchIssues({ accessToken, cloudId, jql: `key in (${batch.join(',')})`, fields, fetch: fetchFn });
        for (const r of epics) {
            const epic = mapIssue(r, fieldIds, scope);
            if (epic && epic.type === 'Epic') issues.set(epic.key, epic);
        }
    }
    return [...issues.values()];
}

/**
 * The increments to sync for a board, current first (none when it has nothing current: no sprints in a sprint
 * rhythm, no versions for a release, no project for a release or flow month): each with its JQL, the board's
 * sprints in it, and its entries for the index's sprint list. A board's first sync also takes the increment before.
 */
async function boardIncrements({ accessToken, cloudId, board, firstSync, now, fetch: fetchFn }) {
    const boardId = Number(board.board_id);
    const projectKey = typeof board.project_key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(board.project_key) ? board.project_key : null;
    const sprints = ['release', 'flow'].includes(board.rhythm) ? [] : await fetchSprints({ accessToken, cloudId, boardId, fetch: fetchFn });
    const wantsVersions = projectKey && (board.rhythm === 'release' || (board.rhythm === 'auto' && !sprints.length));
    const versions = wantsVersions ? await fetchVersions({ accessToken, cloudId, projectKey, fetch: fetchFn }) : [];
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
 * One tenant's Jira sync. A failure is recorded on the connection (`last_error`) and rethrown.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, atlassian: object, fetch?: typeof fetch, now?: Date }} input
 * @returns {Promise<{ boards: number, issues: number, currentPi: string|null }>}
 * @throws {JiraNotConnectedError|AtlassianError}
 */
async function syncTenant(pool, { tenantId, atlassian, fetch: fetchFn = fetch, now = new Date() }) {
    try {
        return await syncTenantUnrecorded(pool, { tenantId, atlassian, fetch: fetchFn, now });
    } catch (err) {
        // accessTokenFor() already records why a connection can't be used; this records everything else.
        if (err instanceof AtlassianError) {
            await withScope(pool, { tenantId }, (client) => client.query(
                'UPDATE jira_connections SET last_error = $2 WHERE tenant_id = $1',
                [tenantId, `Jira sync failed: ${err.message}`.slice(0, ERROR_MAX_LENGTH)]
            ));
        }
        throw err;
    }
}

async function syncTenantUnrecorded(pool, { tenantId, atlassian, fetch: fetchFn, now }) {
    const { boards, boardsWithIssues } = await withScope(pool, { tenantId }, async (client) => ({
        boards: (await client.query('SELECT board_id, name, project_key, rhythm, pi_template FROM jira_boards WHERE tenant_id = $1 ORDER BY board_id', [tenantId])).rows,
        boardsWithIssues: new Set((await client.query('SELECT DISTINCT board_id FROM jira_issues WHERE tenant_id = $1', [tenantId])).rows.map((r) => Number(r.board_id))),
    }));
    if (!boards.length) return { boards: 0, issues: 0, currentPi: null };

    const { accessToken, cloudId } = await accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn });
    const fieldIds = await fetchFieldIds({ accessToken, cloudId, fetch: fetchFn });
    const plan = [];
    const currentByBoard = new Map();
    for (const board of boards) {
        const boardId = Number(board.board_id);
        const firstSync = !boardsWithIssues.has(boardId);
        const increments = await boardIncrements({ accessToken, cloudId, board, firstSync, now, fetch: fetchFn });
        currentByBoard.set(boardId, increments.length ? increments[0].pi : null);
        for (const inc of increments) {
            const issues = await fetchIncrementIssues({ accessToken, cloudId, fieldIds, pi: inc.pi, jql: inc.jql, sprints: inc.sprints, fetch: fetchFn });
            plan.push({ boardId, pi: inc.pi, kind: inc.kind, sprints: inc.index, issues });
        }
    }
    const currentPi = await withScope(pool, { tenantId }, async (client) => {
        const { rows: still } = await client.query('SELECT 1 FROM jira_connections WHERE tenant_id = $1', [tenantId]);
        if (!still.length) return null;
        for (const { boardId, pi, kind, sprints, issues } of plan) {
            const { rows: [existing] } = await client.query('SELECT sprints FROM jira_pis WHERE tenant_id = $1 AND pi = $2', [tenantId, pi]);
            const byName = new Map((existing?.sprints || []).map((s) => [s.name, s]));
            for (const s of sprints) byName.set(s.name, s);
            const merged = [...byName.values()].sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
            await client.query(
                `INSERT INTO jira_pis (tenant_id, pi, kind, sprints, synced_at) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (tenant_id, pi) DO UPDATE SET kind = EXCLUDED.kind, sprints = EXCLUDED.sprints, synced_at = EXCLUDED.synced_at`,
                [tenantId, pi, kind, JSON.stringify(merged), now]
            );
            if (issues.length) {
                await client.query(
                    `INSERT INTO jira_issues (tenant_id, pi, key, board_id, data, synced_at)
                     SELECT $1, $2, k, $3, d, $6 FROM unnest($4::text[], $5::jsonb[]) AS t(k, d)
                     ON CONFLICT (tenant_id, pi, key) DO UPDATE SET board_id = EXCLUDED.board_id, data = EXCLUDED.data, synced_at = EXCLUDED.synced_at`,
                    [tenantId, pi, boardId, issues.map((i) => i.key), issues.map((i) => JSON.stringify(i)), now]
                );
            }
            // Full replace: what this board no longer has in this PI is gone from it.
            await client.query(
                'DELETE FROM jira_issues WHERE tenant_id = $1 AND pi = $2 AND board_id = $3 AND NOT (key = ANY($4))',
                [tenantId, pi, boardId, issues.map((i) => i.key)]
            );
        }
        for (const [boardId, current] of currentByBoard) {
            await client.query('UPDATE jira_boards SET current_increment = $3 WHERE tenant_id = $1 AND board_id = $2', [tenantId, boardId, current]);
        }
        // What the dashboard opens on: only current increments with issues count (an empty flow month is not "now").
        const current = await currentIncrements(client, tenantId);
        const opensOn = current.length > 1 ? NOW_KEY : current[0] || null;
        await client.query(
            'UPDATE jira_connections SET current_pi = $2, last_synced_at = $3, last_error = NULL WHERE tenant_id = $1',
            [tenantId, opensOn, now]
        );
        return opensOn;
    });
    await ensureWebhook(pool, { tenantId, atlassian, accessToken, cloudId, fetch: fetchFn, now });
    return { boards: boards.length, issues: plan.reduce((n, p) => n + p.issues.length, 0), currentPi };
}

/**
 * Keeps the tenant's Jira webhook in line with its boards: registered for the selected boards' projects, refreshed
 * before Atlassian's 30 days run out, re-registered when the projects change. Best effort: a failure is recorded
 * in `webhook_error` and never fails the sync (the periodic sync still runs). Off without a public https URL
 * (`atlassian.webhookUrl`) or the `manage:jira-webhook` scope (a connection made before it was asked for).
 */
async function ensureWebhook(pool, { tenantId, atlassian, accessToken, cloudId, fetch: fetchFn, now }) {
    if (!atlassian.webhookUrl) return;
    const { conn, projectKeys } = await withScope(pool, { tenantId }, async (client) => ({
        conn: (await client.query('SELECT scopes, webhook_ids, webhook_jql, webhook_expires_at, webhook_error FROM jira_connections WHERE tenant_id = $1', [tenantId])).rows[0],
        projectKeys: (await client.query('SELECT DISTINCT project_key FROM jira_boards WHERE tenant_id = $1 AND project_key IS NOT NULL', [tenantId])).rows.map((r) => r.project_key),
    }));
    if (!conn) return;
    const save = (fields) => withScope(pool, { tenantId }, (client) => client.query(
        'UPDATE jira_connections SET webhook_ids = $2, webhook_jql = $3, webhook_expires_at = $4, webhook_error = $5 WHERE tenant_id = $1',
        [tenantId, fields.ids, fields.jql, fields.expiresAt, fields.error]
    ));
    if (!conn.scopes.includes(WEBHOOK_SCOPE)) {
        if (conn.webhook_error !== WEBHOOK_RECONNECT) await save({ ids: [], jql: null, expiresAt: null, error: WEBHOOK_RECONNECT });
        return;
    }
    const keys = [...new Set(projectKeys.filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k)))].sort();
    const jql = keys.length ? `project in (${keys.map((k) => `"${k}"`).join(', ')})` : null;
    let ids = conn.webhook_ids.map(Number);
    let expiresAt = conn.webhook_expires_at;
    let error = null;
    const unchanged = conn.webhook_jql === jql && ids.length > 0;
    const fresh = expiresAt && expiresAt.getTime() - now.getTime() > WEBHOOK_REFRESH_BEFORE_MS;
    if (unchanged && fresh && !conn.webhook_error) return;
    try {
        if (ids.length && !unchanged) {
            // Another set of projects: the old webhook goes (it may already be gone on Atlassian's side).
            await deleteWebhooks({ accessToken, cloudId, ids, fetch: fetchFn }).catch((err) => {
                if (!(err instanceof AtlassianError)) throw err;
            });
            ids = [];
            expiresAt = null;
        }
        if (jql && !ids.length) {
            ids = await registerWebhooks({ accessToken, cloudId, url: atlassian.webhookUrl, jql, fetch: fetchFn });
            expiresAt = new Date(now.getTime() + WEBHOOK_LIFETIME_MS);
        } else if (jql && !fresh) {
            const until = await refreshWebhooks({ accessToken, cloudId, ids, fetch: fetchFn });
            expiresAt = until ? new Date(until) : new Date(now.getTime() + WEBHOOK_LIFETIME_MS);
        }
    } catch (err) {
        if (!(err instanceof AtlassianError)) throw err;
        error = `Instant updates are off: ${err.message}`.slice(0, ERROR_MAX_LENGTH);
        // A refresh that failed: the webhook may be gone; register anew next time.
        if (ids.length && unchanged) ids = [];
    }
    await save({ ids, jql: ids.length ? jql : null, expiresAt: ids.length ? expiresAt : null, error });
}

/**
 * Removes the tenant's Jira webhook on Atlassian's side, before its connection (or the whole tenant) is deleted.
 * Best effort: a revoked grant or an Atlassian error only means the webhook lingers until its 30 days run out, and
 * its deliveries then match no tenant.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, atlassian: object, fetch?: typeof fetch }} input
 * @returns {Promise<boolean>} whether a webhook was removed
 */
async function removeJiraWebhooks(pool, { tenantId, atlassian, fetch: fetchFn = fetch }) {
    const conn = await withScope(pool, { tenantId }, async (client) => (
        await client.query('SELECT webhook_ids FROM jira_connections WHERE tenant_id = $1 AND cloud_id IS NOT NULL', [tenantId])
    ).rows[0]);
    const ids = conn ? conn.webhook_ids.map(Number) : [];
    if (!ids.length) return false;
    try {
        const { accessToken, cloudId } = await accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn });
        await deleteWebhooks({ accessToken, cloudId, ids, fetch: fetchFn });
        return true;
    } catch (err) {
        if (err instanceof AtlassianError || err instanceof JiraNotConnectedError) return false;
        throw err;
    }
}

/**
 * One pass over every tenant with a Jira connection. One failing tenant is logged and the pass moves on. `keys`
 * limits it to the tenants a webhook delivery names (lib/webhooks.js jiraSyncKeys(): `webhook:<id>` of the
 * connection's webhook, `cloud:<cloudId>` or `site:<url>`).
 *
 * @param {{ pool: import('pg').Pool, atlassian: object, fetch?: typeof fetch, log?: (msg: string) => void, now?: Date, keys?: string[] }} input
 * @returns {Promise<{ tenants: number, issues: number, failed: number }>}
 */
async function syncAllJira({ pool, atlassian, fetch: fetchFn = fetch, log = () => {}, now = new Date(), keys = null }) {
    const totals = { tenants: 0, issues: 0, failed: 0 };
    const wanted = keys && new Set(keys);
    const { rows: tenants } = await pool.query('SELECT id FROM tenants ORDER BY created_at');
    for (const { id: tenantId } of tenants) {
        const conn = await withScope(pool, { tenantId }, async (client) => (
            await client.query('SELECT cloud_id, site_url, webhook_ids FROM jira_connections WHERE tenant_id = $1 AND cloud_id IS NOT NULL', [tenantId])
        ).rows[0]);
        if (!conn) continue;
        if (wanted) {
            const own = [`cloud:${conn.cloud_id}`, `site:${String(conn.site_url || '').replace(/\/+$/, '')}`, ...conn.webhook_ids.map((id) => `webhook:${id}`)];
            if (!own.some((k) => wanted.has(k))) continue;
        }
        totals.tenants += 1;
        try {
            const result = await syncTenant(pool, { tenantId, atlassian, fetch: fetchFn, now });
            totals.issues += result.issues;
        } catch (err) {
            if (!(err instanceof AtlassianError) && !(err instanceof JiraNotConnectedError)) throw err;
            totals.failed += 1;
            log(`tenant ${tenantId}: Jira sync failed: ${err.message}`);
        }
    }
    return totals;
}

/** The current increments of the selected boards that have synced issues, newest first. */
async function currentIncrements(client, tenantId) {
    const { rows } = await client.query(
        `SELECT DISTINCT b.current_increment AS pi FROM jira_boards b
         WHERE b.tenant_id = $1 AND b.current_increment IS NOT NULL
           AND EXISTS (SELECT 1 FROM jira_issues i WHERE i.tenant_id = b.tenant_id AND i.pi = b.current_increment)`,
        [tenantId]
    );
    return rows.map((r) => r.pi).sort(comparePiDesc);
}

/**
 * The tenant's synced increments for the dashboard: `jiraIndex` (data/jira-issues/index.json, each entry with its
 * `kind`: pi, sprint, release or flow) and `issueStatusIndex` (status-index.json: per key, its newest increment). When the
 * selected boards are in different increments right now (a SAFe team in PI-27.3, a Scrum team in its Sprint 7), a
 * first "Now" entry joins them and is the current one, so the dashboard opens on every team at once. Call inside
 * the tenant's scope.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string }} input
 * @returns {Promise<{ jiraIndex: { currentPi: string|null, pis: object[] }, issueStatusIndex: object }>}
 */
async function readDashboardJira(client, { tenantId }) {
    const { rows: pis } = await client.query(
        'SELECT p.pi, p.kind, p.sprints FROM jira_pis p WHERE p.tenant_id = $1 AND EXISTS (SELECT 1 FROM jira_issues i WHERE i.tenant_id = p.tenant_id AND i.pi = p.pi)',
        [tenantId]
    );
    const { rows: issues } = await client.query("SELECT key, pi, data->>'statusCategory' AS status_category FROM jira_issues WHERE tenant_id = $1", [tenantId]);
    const sorted = pis.sort((a, b) => comparePiDesc(a.pi, b.pi));
    const rank = new Map(sorted.map((p, i) => [p.pi, i]));
    const issueStatusIndex = {};
    for (const i of issues.sort((a, b) => rank.get(a.pi) - rank.get(b.pi))) {
        if (!issueStatusIndex[i.key]) issueStatusIndex[i.key] = { pi: i.pi, statusCategory: i.status_category };
    }
    const entries = sorted.map((p) => ({ pi: p.pi, kind: p.kind, file: `${String(p.pi).replace(/[^A-Za-z0-9.-]/g, '_')}.json`, sprints: p.sprints }));
    const current = await currentIncrements(client, tenantId);
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

/**
 * One increment's issues (what a data/jira-issues/<PI>.json shard holds); for "Now", every board's current one,
 * each issue keeping its own increment in `pi`. Members only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, pi: string }} input
 * @returns {Promise<object[]>}
 * @throws {TenantNotFoundError}
 */
async function listPiIssues(pool, { tenantId, actorUserId, pi }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const pis = pi === NOW_KEY ? await currentIncrements(client, tenantId) : [pi];
        const { rows } = await client.query('SELECT key, data FROM jira_issues WHERE tenant_id = $1 AND pi = ANY($2) ORDER BY key, pi', [tenantId, pis]);
        const seen = new Set();
        return rows.filter((r) => !seen.has(r.key) && seen.add(r.key)).map((r) => r.data);
    });
}

module.exports = { WEBHOOK_RECONNECT, removeJiraWebhooks, NOW_KEY, JiraBoardError, listBoards, setBoards, configureBoard, syncTenant, syncAllJira, readDashboardJira, listPiIssues };
