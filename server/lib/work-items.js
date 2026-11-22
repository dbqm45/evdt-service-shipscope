// Work items from a repo (F1 of the pdi one-flow plan): after each repo sync (deployment-sync.js syncRepo()), the
// worker reads docs/project/changes/<CHG>/intent.md and plan.md from the repo's default branch, pinned to the newest
// commit that touched that folder, and keeps work_items (migration 037) as the folder is now. Unchanged folder = one
// GitHub request. A file that can't be read is recorded on the repo (tracked_repos.work_items_error, Settings) and the
// other changes still count; a GitHub failure keeps what was read before; a rate limit is rethrown like elsewhere.
const { withScope } = require('./scope');
const { pdiLayer } = require('./pdi-layer');
const { roleOf, TenantNotFoundError } = require('./tenants');
const { githubGet, GitHubApiError, GitHubRateLimitError } = require('./github-app');
const { CHANGES_DIR, CHANGES_KEY, MAX_CHANGES, WorkItemFileError, buildWorkItems, workItemIssues, checkReleasePlan } = require('./work-items-model');
const { parseDocumentFile, FlagFileError } = require('./flag-file-parser');
const RELEASE_PLAN_SCHEMA = require('../schemas/release-plan.v0.14.0.schema.json');

const MAX_FILE_BYTES = 256 * 1024;
const ARTIFACT = new RegExp(`^${CHANGES_DIR}/([^/]+)/(intent\\.md|plan\\.md|release\\.yaml)$`);
const ARTIFACT_FIELD = { 'intent.md': 'intent', 'plan.md': 'plan', 'release.yaml': 'release' };
// What a read understands (tracked_repos.work_items_version, migration 038): 1 = work items and release.yaml, 2 = the
// intent's Problem (migration 041), 3 = the intent's date (migration 042), 4 = the report day of its problem (migration
// 043), 5 = task titles from plan.md's title column and the task's own row (planTasks()). A folder read by an older
// version is read again even when no commit touched it.
const WORK_ITEMS_VERSION = 5;
const ERROR_MAX = 1000;

/** A file's text at a commit; null when it is too big or not a file. */
async function fileText({ token, fullName, path, ref, fetch: fetchFn }) {
    const body = await githubGet({ token, path: `/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`, fetch: fetchFn });
    if (!body || body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') return null;
    if (typeof body.size === 'number' && body.size > MAX_FILE_BYTES) return null;
    return Buffer.from(body.content, 'base64').toString('utf8').slice(0, MAX_FILE_BYTES);
}

/**
 * Reads the repo's changes folder again when its newest commit moved since the last read; replaces the repo's work
 * items with what the folder holds now.
 *
 * @param {{ pool: import('pg').Pool, token: string, tenantId: string, repo: { repoId: number, fullName: string }, fetch?: typeof fetch, log?: Function }} input
 * @returns {Promise<{ read: number, errors: number, plans: number, unchanged?: true }>} read: items stored; plans: release plans stored; errors: files (or the read) that failed
 * @throws {GitHubRateLimitError}
 */
async function refreshWorkItems({ pool, token, tenantId, repo, fetch: fetchFn = fetch, log = () => {} }) {
    const { repoId, fullName } = repo;
    const stored = await withScope(pool, { tenantId }, async (client) => (await client.query(
        'SELECT work_items_ref, work_items_version FROM tracked_repos WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repoId]
    )).rows[0]);
    if (!stored) return { read: 0, errors: 0, plans: 0, unchanged: true };

    let ref;
    let changes;
    try {
        const newest = await githubGet({ token, path: `/repos/${fullName}/commits?path=${encodeURIComponent(CHANGES_DIR)}&per_page=1`, fetch: fetchFn });
        ref = Array.isArray(newest) && typeof newest[0]?.sha === 'string' && /^[0-9a-f]{40}$/.test(newest[0].sha) ? newest[0].sha : null;
        if (ref === stored.work_items_ref && stored.work_items_version === WORK_ITEMS_VERSION) return { read: 0, errors: 0, plans: 0, unchanged: true };
        changes = [];
        if (ref) {
            const tree = await githubGet({ token, path: `/repos/${fullName}/git/trees/${ref}?recursive=1`, fetch: fetchFn });
            if (!tree || !Array.isArray(tree.tree)) throw new GitHubApiError('the tree could not be read', 0);
            if (tree.truncated) throw new GitHubApiError('the repository tree is too large to list', 0);
            const byDir = new Map();
            for (const entry of tree.tree) {
                const m = entry && entry.type === 'blob' && typeof entry.path === 'string' ? ARTIFACT.exec(entry.path) : null;
                if (!m) continue;
                if (!byDir.has(m[1])) {
                    if (byDir.size >= MAX_CHANGES) continue;
                    byDir.set(m[1], { dir: m[1] });
                }
                byDir.get(m[1])[ARTIFACT_FIELD[m[2]]] = entry.path;
            }
            for (const c of byDir.values()) {
                const change = { dir: c.dir };
                for (const artifact of ['intent', 'plan', 'release']) {
                    if (!c[artifact]) continue;
                    const text = await fileText({ token, fullName, path: c[artifact], ref, fetch: fetchFn });
                    change[artifact] = text === null ? '' : text;
                }
                changes.push(change);
            }
        }
    } catch (err) {
        if (err instanceof GitHubRateLimitError || !(err instanceof GitHubApiError)) throw err;
        const message = `Could not read ${CHANGES_DIR}: ${err.message}`.slice(0, ERROR_MAX);
        await withScope(pool, { tenantId }, (client) => client.query(
            'UPDATE tracked_repos SET work_items_error = $3 WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repoId, message]
        ));
        log(`${fullName}: ${message}`, { level: 'warn', tenantId, repo: fullName, err });
        return { read: 0, errors: 1, plans: 0 };
    }

    const { items, errors } = buildWorkItems(changes);
    const plans = [];
    for (const c of changes.filter((x) => x.release !== undefined)) {
        const where = `${CHANGES_DIR}/${c.dir}/release.yaml`;
        try {
            const doc = await parseDocumentFile({ text: c.release, fileName: where, format: 'yaml' });
            plans.push({ change: c.dir, plan: checkReleasePlan(doc, { dir: c.dir, schema: RELEASE_PLAN_SCHEMA }) });
        } catch (err) {
            if (err instanceof FlagFileError) errors.push({ change: c.dir, message: err.message });
            else if (err instanceof WorkItemFileError) errors.push({ change: c.dir, message: `${where}: ${err.message}` });
            else throw err;
        }
    }
    const errorText = errors.length ? errors.map((e) => e.message).join('; ').slice(0, ERROR_MAX) : null;
    await withScope(pool, { tenantId }, async (client) => {
        await client.query('DELETE FROM work_items WHERE tenant_id = $1 AND repo_id = $2 AND NOT (item_key = ANY($3))', [tenantId, repoId, items.map((i) => i.key)]);
        for (const i of items) {
            await client.query(
                `INSERT INTO work_items (tenant_id, item_key, kind, parent_key, repo_id, title, status, source_key, path, ref, problem, intent_created, source_reported_at, synced_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
                 ON CONFLICT (tenant_id, item_key) DO UPDATE SET kind = EXCLUDED.kind, parent_key = EXCLUDED.parent_key, repo_id = EXCLUDED.repo_id,
                     title = EXCLUDED.title, status = EXCLUDED.status, source_key = EXCLUDED.source_key, path = EXCLUDED.path, ref = EXCLUDED.ref,
                     problem = EXCLUDED.problem, intent_created = EXCLUDED.intent_created,
                     source_reported_at = EXCLUDED.source_reported_at, synced_at = now()`,
                [tenantId, i.key, i.kind, i.parent, repoId, i.title, i.status, i.source, i.path, ref, i.problem, i.created, i.reported]
            );
        }
        await client.query('DELETE FROM release_plans WHERE tenant_id = $1 AND repo_id = $2 AND NOT (change_key = ANY($3))', [tenantId, repoId, plans.map((p) => p.change)]);
        for (const p of plans) {
            await client.query(
                `INSERT INTO release_plans (tenant_id, change_key, repo_id, plan, ref, synced_at) VALUES ($1, $2, $3, $4, $5, now())
                 ON CONFLICT (tenant_id, change_key) DO UPDATE SET repo_id = EXCLUDED.repo_id, plan = EXCLUDED.plan, ref = EXCLUDED.ref, synced_at = now()`,
                [tenantId, p.change, repoId, JSON.stringify(p.plan), ref]
            );
        }
        await client.query(
            'UPDATE tracked_repos SET work_items_ref = $3, work_items_error = $4, work_items_version = $5 WHERE tenant_id = $1 AND repo_id = $2',
            [tenantId, repoId, ref, errorText, WORK_ITEMS_VERSION]
        );
    });
    if (errors.length) log(`${fullName}: ${errorText}`, { level: 'warn', tenantId, repo: fullName });
    return { read: items.length, errors: errors.length, plans: plans.length };
}

/**
 * The tenant's work items with the link to their file on GitHub.
 *
 * @param {import('pg').PoolClient} client inside withScope()
 * @param {string} tenantId
 * @returns {Promise<Array<{ key: string, kind: string, parent: string|null, title: string, status: string|null, problem: string|null, created: string|null, source: string|null, reported: string|null, url: string }>>}
 */
async function readWorkItems(client, tenantId) {
    const { rows } = await client.query(
        `SELECT w.item_key, w.kind, w.parent_key, w.title, w.status, w.problem, to_char(w.intent_created, 'YYYY-MM-DD') AS created, w.source_key,
                to_char(w.source_reported_at, 'YYYY-MM-DD') AS reported, w.path, w.ref, r.full_name
         FROM work_items w JOIN tracked_repos r ON r.tenant_id = w.tenant_id AND r.repo_id = w.repo_id
         WHERE w.tenant_id = $1 ORDER BY w.item_key`,
        [tenantId]
    );
    return rows.map((r) => ({
        key: r.item_key, kind: r.kind, parent: r.parent_key, title: r.title, status: r.status, problem: r.problem, created: r.created, source: r.source_key, reported: r.reported,
        url: `https://github.com/${r.full_name}/blob/${r.ref}/${r.path}`,
    }));
}

/**
 * The Changes increment's issues (GET /api/tenants/:id/jira-issues?pi=@changes). Members only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<object[]>}
 * @throws {TenantNotFoundError}
 */
async function listChangeIssues(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        if (!(await roleOf(client, { tenantId, userId: actorUserId }))) throw new TenantNotFoundError('Tenant not found');
        // The Changes increment is part of the pdi layer (design-docs/PDI-GATE-PLAN.pl.md).
        if (!(await pdiLayer(client, { tenantId })).visible) return [];
        return workItemIssues(await readWorkItems(client, tenantId));
    });
}

/**
 * The tenant's release plans from its repos, in the contract's shape.
 *
 * @param {import('pg').PoolClient} client inside withScope()
 * @param {string} tenantId
 * @returns {Promise<object[]>}
 */
async function readReleasePlans(client, tenantId) {
    const { rows } = await client.query('SELECT plan FROM release_plans WHERE tenant_id = $1 ORDER BY change_key', [tenantId]);
    return rows.map((r) => r.plan);
}

module.exports = { refreshWorkItems, readWorkItems, readReleasePlans, listChangeIssues, CHANGES_KEY, WORK_ITEMS_VERSION };
