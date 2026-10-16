const { withScope } = require('./scope');
const { assertAdmin, roleOf, TenantNotFoundError } = require('./tenants');
const { accessTokenFor, JiraNotConnectedError } = require('./jira-connections');
const { AtlassianError, fetchBoards, fetchSprints, fetchFieldIds, searchIssues } = require('./atlassian');
const { piOfSprint, comparePiDesc, currentPiOf, previousPiOf, issueFields, mapIssue } = require('./jira-model');

/**
 * FR-008 (which boards a tenant syncs) and FR-009 (syncing their issues, migration 010).
 *
 * Per pass and board: the board's current PI is fully re-synced -- every issue in the board's sprints of that PI,
 * plus the Epics they belong to -- and replaces what was stored for that board and PI (an issue that left the PI
 * is simply gone from it). Earlier PIs are kept as they were last synced; a board's first sync also takes the PI
 * before the current one, so a new tenant sees more than one increment. All Jira calls happen before the write
 * transaction.
 */

class JiraBoardError extends Error {}

const EPIC_BATCH = 100;
const ERROR_MAX_LENGTH = 300;

/**
 * The site's boards, each with its type and marked selected or not. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, atlassian: object, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ boardId: number, name: string, type: string|null, projectKey: string|null, projectName: string|null, selected: boolean }>>}
 */
async function listBoards(pool, { tenantId, actorUserId, atlassian, fetch: fetchFn = fetch }) {
    const selected = await withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        return new Set((await client.query('SELECT board_id FROM jira_boards WHERE tenant_id = $1', [tenantId])).rows.map((r) => Number(r.board_id)));
    });
    const { accessToken, cloudId } = await accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn });
    const boards = await fetchBoards({ accessToken, cloudId, fetch: fetchFn });
    return boards.map((b) => ({ ...b, selected: selected.has(b.boardId) }));
}

/**
 * Sets the boards to sync (replacing the selection). Each must be a board of the connected site, and not a kanban
 * board (no sprints, so no PI). Issues of boards no longer selected are removed. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, boardIds: number[], atlassian: object, fetch?: typeof fetch }} input
 * @returns {Promise<Array<{ boardId: number, name: string, projectKey: string|null, projectName: string|null }>>} the selection
 * @throws {JiraBoardError} a board that isn't on the site, or is a kanban board
 */
async function setBoards(pool, { tenantId, actorUserId, boardIds, atlassian, fetch: fetchFn = fetch }) {
    await withScope(pool, { tenantId }, (client) => assertAdmin(client, { tenantId, userId: actorUserId }));
    const { accessToken, cloudId } = await accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn });
    const available = new Map((await fetchBoards({ accessToken, cloudId, fetch: fetchFn })).map((b) => [b.boardId, b]));
    const missing = boardIds.find((id) => !available.has(id));
    if (missing !== undefined) throw new JiraBoardError(`Board ${missing} is not on the connected Jira site`);
    const kanban = boardIds.find((id) => available.get(id).type === 'kanban');
    if (kanban !== undefined) throw new JiraBoardError(`Board ${kanban} is a kanban board: it has no sprints, so no PI to sync`);
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

/** All issues in `sprintIds`, plus the Epics they belong to, mapped for `pi`. */
async function fetchPiIssues({ accessToken, cloudId, fieldIds, pi, sprints, fetch: fetchFn }) {
    const sprintsInScope = new Map(sprints.map((s) => [s.id, s]));
    const fields = issueFields(fieldIds);
    const scope = { pi, sprintsInScope };
    const raw = await searchIssues({ accessToken, cloudId, jql: `sprint in (${sprints.map((s) => s.id).join(',')}) ORDER BY key`, fields, fetch: fetchFn });
    const issues = new Map();
    for (const r of raw) {
        const issue = mapIssue(r, fieldIds, scope);
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
        boards: (await client.query('SELECT board_id, name FROM jira_boards WHERE tenant_id = $1 ORDER BY board_id', [tenantId])).rows,
        boardsWithIssues: new Set((await client.query('SELECT DISTINCT board_id FROM jira_issues WHERE tenant_id = $1', [tenantId])).rows.map((r) => Number(r.board_id))),
    }));
    if (!boards.length) return { boards: 0, issues: 0, currentPi: null };

    const { accessToken, cloudId } = await accessTokenFor(pool, { tenantId, atlassian, fetch: fetchFn });
    const fieldIds = await fetchFieldIds({ accessToken, cloudId, fetch: fetchFn });
    const plan = [];
    const currentPis = [];
    for (const board of boards) {
        const boardId = Number(board.board_id);
        const sprints = await fetchSprints({ accessToken, cloudId, boardId, fetch: fetchFn });
        const current = currentPiOf(sprints);
        if (!current) continue;
        currentPis.push(current);
        const pis = [current];
        const previous = boardsWithIssues.has(boardId) ? null : previousPiOf(sprints, current);
        if (previous) pis.push(previous);
        for (const pi of pis) {
            const inPi = sprints.filter((s) => piOfSprint(s.name) === pi);
            const issues = await fetchPiIssues({ accessToken, cloudId, fieldIds, pi, sprints: inPi, fetch: fetchFn });
            plan.push({ boardId, pi, sprints: inPi, issues });
        }
    }
    const currentPi = currentPis.sort(comparePiDesc)[0] || null;

    await withScope(pool, { tenantId }, async (client) => {
        const { rows: still } = await client.query('SELECT 1 FROM jira_connections WHERE tenant_id = $1', [tenantId]);
        if (!still.length) return;
        for (const { boardId, pi, sprints, issues } of plan) {
            const { rows: [existing] } = await client.query('SELECT sprints FROM jira_pis WHERE tenant_id = $1 AND pi = $2', [tenantId, pi]);
            const byName = new Map((existing?.sprints || []).map((s) => [s.name, s]));
            for (const s of sprints) byName.set(s.name, { name: s.name, startDate: s.startDate, endDate: s.endDate });
            const merged = [...byName.values()].sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
            await client.query(
                `INSERT INTO jira_pis (tenant_id, pi, sprints, synced_at) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (tenant_id, pi) DO UPDATE SET sprints = EXCLUDED.sprints, synced_at = EXCLUDED.synced_at`,
                [tenantId, pi, JSON.stringify(merged), now]
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
        await client.query(
            'UPDATE jira_connections SET current_pi = $2, last_synced_at = $3, last_error = NULL WHERE tenant_id = $1',
            [tenantId, currentPi, now]
        );
    });
    return { boards: boards.length, issues: plan.reduce((n, p) => n + p.issues.length, 0), currentPi };
}

/**
 * One pass over every tenant with a Jira connection. One failing tenant is logged and the pass moves on.
 *
 * @param {{ pool: import('pg').Pool, atlassian: object, fetch?: typeof fetch, log?: (msg: string) => void, now?: Date }} input
 * @returns {Promise<{ tenants: number, issues: number, failed: number }>}
 */
async function syncAllJira({ pool, atlassian, fetch: fetchFn = fetch, log = () => {}, now = new Date() }) {
    const totals = { tenants: 0, issues: 0, failed: 0 };
    const { rows: tenants } = await pool.query('SELECT id FROM tenants ORDER BY created_at');
    for (const { id: tenantId } of tenants) {
        const connected = await withScope(pool, { tenantId }, async (client) => (
            await client.query('SELECT 1 FROM jira_connections WHERE tenant_id = $1 AND cloud_id IS NOT NULL', [tenantId])
        ).rows.length > 0);
        if (!connected) continue;
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

/**
 * The tenant's synced PIs for the dashboard: `jiraIndex` (data/jira-issues/index.json) and `issueStatusIndex`
 * (status-index.json: per key, its newest PI). Call inside the tenant's scope.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string }} input
 * @returns {Promise<{ jiraIndex: { currentPi: string|null, pis: object[] }, issueStatusIndex: object }>}
 */
async function readDashboardJira(client, { tenantId }) {
    const { rows: [connection] } = await client.query('SELECT current_pi FROM jira_connections WHERE tenant_id = $1', [tenantId]);
    const { rows: pis } = await client.query(
        'SELECT p.pi, p.sprints FROM jira_pis p WHERE p.tenant_id = $1 AND EXISTS (SELECT 1 FROM jira_issues i WHERE i.tenant_id = p.tenant_id AND i.pi = p.pi)',
        [tenantId]
    );
    const { rows: issues } = await client.query("SELECT key, pi, data->>'statusCategory' AS status_category FROM jira_issues WHERE tenant_id = $1", [tenantId]);
    const sorted = pis.sort((a, b) => comparePiDesc(a.pi, b.pi));
    const rank = new Map(sorted.map((p, i) => [p.pi, i]));
    const issueStatusIndex = {};
    for (const i of issues.sort((a, b) => rank.get(a.pi) - rank.get(b.pi))) {
        if (!issueStatusIndex[i.key]) issueStatusIndex[i.key] = { pi: i.pi, statusCategory: i.status_category };
    }
    return {
        jiraIndex: {
            currentPi: connection?.current_pi && rank.has(connection.current_pi) ? connection.current_pi : null,
            pis: sorted.map((p) => ({ pi: p.pi, file: `${String(p.pi).replace(/[^A-Za-z0-9.-]/g, '_')}.json`, sprints: p.sprints })),
        },
        issueStatusIndex,
    };
}

/**
 * One PI's issues (what a data/jira-issues/<PI>.json shard holds). Members only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, pi: string }} input
 * @returns {Promise<object[]>}
 * @throws {TenantNotFoundError}
 */
async function listPiIssues(pool, { tenantId, actorUserId, pi }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        const { rows } = await client.query('SELECT data FROM jira_issues WHERE tenant_id = $1 AND pi = $2 ORDER BY key', [tenantId, pi]);
        return rows.map((r) => r.data);
    });
}

module.exports = { JiraBoardError, listBoards, setBoards, syncTenant, syncAllJira, readDashboardJira, listPiIssues };
