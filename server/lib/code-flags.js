// Flags in code (ADR-003, ROADMAP increment 3): for each flag source read from code, the flags file at the commit
// each environment of its repository last deployed successfully. Runs after a repo's sync (deployment-sync.js), so a
// new deployment updates its flags within the same pass, without any workflow on the customer's side.
//
// - The file is read at the deployment's resolved ref (a release/tag, the version file's ref, or the sha): the code
//   that actually runs there. Each value's changedAt is the deployment's time.
// - It is read again only when that environment's latest successful deployment changed (`flag_source_envs.last_ref`).
// - A missing or unreadable file is an error on that environment, never a removal: the flags stay as they were and
//   the dashboard shows the doubt (flagFreshness). The next pass tries again.
// - Parsing happens in lib/flag-file-parser.js's isolated thread; errors never carry a value from the file.
const { withScope } = require('./scope');
const { githubGet, GitHubApiError, GitHubRateLimitError } = require('./github-app');
const { parseFlagFile, FlagFileError } = require('./flag-file-parser');
const { codeFileFor } = require('./flags-logic');
const { lockTenantFlags, applyObservations, recordSourceEnvError } = require('./flags');

// GitHub's contents API sends a file's content inline up to 1 MB; the parser's own limit is far below that.
const MAX_FILE_BYTES = 256 * 1024;

/** The code sources of one repo and each environment's latest successful deployment, under the tenant's scope. */
async function readPlan(pool, { tenantId, repoId }) {
    return withScope(pool, { tenantId }, async (client) => {
        const { rows: sources } = await client.query(
            `SELECT s.id, s.name, s.code_config FROM flag_sources s
             JOIN flag_source_repos r ON r.tenant_id = s.tenant_id AND r.source_id = s.id
             WHERE s.tenant_id = $1 AND r.repo_id = $2 AND s.origin = 'code'`,
            [tenantId, repoId]
        );
        if (!sources.length) return { sources, latest: [], envRows: [] };
        const { rows: latest } = await client.query(
            `SELECT DISTINCT ON (environment) environment, sha, resolved_ref, deployed_at
             FROM deployments WHERE tenant_id = $1 AND repo_id = $2 AND status = 'success'
             ORDER BY environment, deployed_at DESC, deployment_id DESC`,
            [tenantId, repoId]
        );
        const { rows: envRows } = await client.query(
            'SELECT source_id, environment, last_ref FROM flag_source_envs WHERE tenant_id = $1 AND source_id = ANY($2)',
            [tenantId, sources.map((s) => s.id)]
        );
        return { sources, latest, envRows };
    });
}

/**
 * The file's text at a ref, or null when it is not there (a 404). Throws GitHubApiError for anything else.
 *
 * @returns {Promise<string|null>}
 */
async function fetchFile({ token, fullName, file, ref, fetch: fetchFn }) {
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    let body;
    try {
        body = await githubGet({ token, path: `/repos/${fullName}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, fetch: fetchFn });
    } catch (err) {
        if (err instanceof GitHubApiError && !(err instanceof GitHubRateLimitError) && err.status === 404) return null;
        throw err;
    }
    if (!body || Array.isArray(body) || body.type !== 'file') throw new FlagFileError(`${file}: not a file`);
    if (typeof body.size === 'number' && body.size > MAX_FILE_BYTES) throw new FlagFileError(`${file}: larger than ${MAX_FILE_BYTES / 1024} KB`);
    if (body.encoding !== 'base64' || typeof body.content !== 'string') throw new FlagFileError(`${file}: could not be read`);
    return Buffer.from(body.content, 'base64').toString('utf8');
}

/**
 * Reads every code source of one repo where an environment's latest successful deployment changed since the last read.
 * Never fails the repo's sync: a read that fails is recorded on its environment and tried again next pass. A rate
 * limit is thrown, like everywhere else in the sync, so the pass pauses the installation.
 *
 * @param {{ pool: import('pg').Pool, token: string, tenantId: string, repo: { repoId: number, fullName: string }, fetch?: typeof fetch, now?: Date, log?: Function }} input
 * @returns {Promise<{ read: number, failed: number }>}
 * @throws {GitHubRateLimitError}
 */
async function refreshCodeFlags({ pool, token, tenantId, repo, fetch: fetchFn = fetch, now = new Date(), log = () => {} }) {
    const { sources, latest, envRows } = await readPlan(pool, { tenantId, repoId: repo.repoId });
    const lastRef = new Map(envRows.map((r) => [`${r.source_id}/${r.environment}`, r.last_ref]));
    const totals = { read: 0, failed: 0 };
    for (const source of sources) {
        for (const deployment of latest) {
            const env = deployment.environment;
            const ref = deployment.resolved_ref || deployment.sha;
            if (lastRef.get(`${source.id}/${env}`) === ref) continue;
            const file = codeFileFor(source.code_config, env);
            const fields = { tenantId, repo: repo.fullName, source: source.name, env, file, ref };
            try {
                const text = await fetchFile({ token, fullName: repo.fullName, file, ref, fetch: fetchFn });
                if (text === null) throw new FlagFileError(`${file} is not in ${repo.fullName} at ${ref.slice(0, 12)}`);
                const flags = await parseFlagFile({ text, fileName: file, format: source.code_config.format, options: source.code_config });
                const observations = Object.entries(flags).map(([key, v]) => ({ key, env, state: v.state, rollout: v.rollout ?? null, changedAt: deployment.deployed_at }));
                const result = await withScope(pool, { tenantId }, async (client) => {
                    await lockTenantFlags(client, tenantId);
                    const written = await applyObservations(client, {
                        tenantId, sourceId: source.id, observations, metaByKey: new Map(), complete: true, environments: [env],
                        changedBy: `deploy of ${ref.slice(0, 12)}`, now,
                    });
                    await client.query(
                        `UPDATE flag_source_envs SET last_ref = $4, last_error = NULL, last_error_at = NULL
                         WHERE tenant_id = $1 AND source_id = $2 AND environment = $3`,
                        [tenantId, source.id, env, ref]
                    );
                    const summary = { flags: written.flags, changed: written.changed, removed: written.removed, stale: written.stale };
                    await client.query('UPDATE flag_sources SET last_ingest_at = $3, last_ingest = $4 WHERE tenant_id = $1 AND id = $2', [tenantId, source.id, now, summary]);
                    return summary;
                });
                totals.read += 1;
                log(`${repo.fullName}: flags read from ${file} at ${ref.slice(0, 12)} (${env})`, { ...fields, ...result });
            } catch (err) {
                if (err instanceof GitHubRateLimitError) throw err;
                totals.failed += 1;
                // A file error is ours and value-free; a GitHub error says only the status.
                const message = err instanceof FlagFileError ? err.message
                    : err instanceof GitHubApiError ? `${file}: GitHub answered ${err.status || 'with an error'}` : `${file}: could not be read`;
                await recordSourceEnvError(pool, { tenantId, sourceId: source.id, env, message, now });
                log(`${repo.fullName}: flags not read from ${file} (${env}): ${message}`, { level: 'warn', ...fields, reason: message });
            }
        }
    }
    return totals;
}

module.exports = { refreshCodeFlags };
