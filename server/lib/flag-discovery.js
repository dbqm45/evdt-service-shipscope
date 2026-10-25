// Setting up flags in code without knowing the file's name (ADR-003, ROADMAP increment 3): ShipScope looks through a
// repository's files at what was last deployed, proposes the ones that look like flags files, and previews how a
// reading would come out per environment before an admin saves it. Read only, nothing stored.
//
// Files are read through lib/flag-file-parser.js (isolated, limited, value-free errors). A .env or .properties file is
// never proposed on its own: those hold credentials too, and only a prefix an admin names makes them readable.
const { withScope } = require('./scope');
const { githubGet, GitHubApiError, GitHubRateLimitError } = require('./github-app');
const { parseFlagFile, FlagFileError } = require('./flag-file-parser');
const { codeFileFormat, codeFileFor } = require('./flags-logic');

const ENVS = ['test', 'qa', 'prod'];
// A file name that says "flags" or "toggles" (newCheckout lives in flags.json, feature-flags.yaml, featureFlags.ts, ...).
const FLAG_NAME = /(^|[^a-z])(feature[-_ ]?)?(flags?|toggles?)([^a-z]|$)|featureflags|featuretoggles/i;
const READABLE = ['json', 'yaml', 'ts'];
const SKIP_DIRS = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|test|tests|__tests__|spec|fixtures|e2e)\//i;
const TEST_FILE = /\.(test|spec|stories)\.[a-z]+$|\.d\.ts$/i;
// Where a file nests its flags, tried in this order when the file itself is not a flat map of flags.
const COMMON_PATHS = ['flags', 'features', 'featureFlags', 'feature_flags', 'toggles', 'featureToggles'];
// File-name words that stand for an environment, so `flags.production.json` proposes `flags.{env}.json`.
const ENV_WORDS = { test: 'test', testing: 'test', dev: 'test', development: 'test', qa: 'qa', staging: 'qa', prod: 'prod', production: 'prod' };
const MAX_CANDIDATES = 8;
const MAX_FILE_BYTES = 256 * 1024;

/**
 * The flags-file candidates among a repository's paths: names that say flags or toggles, in a readable format, outside
 * tests, builds and dependencies; shallowest first. A file per environment becomes one `{env}` template.
 *
 * @param {string[]} paths
 * @returns {Array<{ file: string, envNames?: Record<string, string>, samplePath: string }>}
 */
function flagFileCandidates(paths) {
    const files = paths.filter((p) => !SKIP_DIRS.test(`${p}`) && !TEST_FILE.test(p)
        && READABLE.includes(codeFileFormat(p)) && FLAG_NAME.test(p.split('/').pop()));
    const byTemplate = new Map();
    for (const path of files) {
        const parts = path.split('/');
        const base = parts.pop();
        const word = base.split(/[._-]/).find((w) => ENV_WORDS[w.toLowerCase()]);
        if (!word) {
            byTemplate.set(path, { file: path, samplePath: path });
            continue;
        }
        const template = [...parts, base.replace(new RegExp(`(^|[._-])${word}(?=[._-]|$)`), '$1{env}')].join('/');
        const entry = byTemplate.get(template) || { file: template, envNames: {}, samplePath: path };
        const env = ENV_WORDS[word.toLowerCase()];
        if (word !== env && !entry.envNames[env]) entry.envNames[env] = word;
        if (env === 'prod') entry.samplePath = path;
        byTemplate.set(template, entry);
    }
    return [...byTemplate.values()]
        .map((c) => (c.envNames && !Object.keys(c.envNames).length ? { file: c.file, samplePath: c.samplePath } : c))
        .sort((a, b) => a.file.split('/').length - b.file.split('/').length || a.file.localeCompare(b.file))
        .slice(0, MAX_CANDIDATES);
}

/** A tracked repo with its installation and each environment's latest successful deployment ref, for one tenant. */
async function repoAndRefs(pool, { tenantId, repoId }) {
    return withScope(pool, { tenantId }, async (client) => {
        const { rows: [repo] } = await client.query('SELECT repo_id, full_name, installation_id FROM tracked_repos WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repoId]);
        if (!repo) return null;
        const { rows } = await client.query(
            `SELECT DISTINCT ON (environment) environment, COALESCE(resolved_ref, sha) AS ref FROM deployments
             WHERE tenant_id = $1 AND repo_id = $2 AND status = 'success' ORDER BY environment, deployed_at DESC, deployment_id DESC`,
            [tenantId, repoId]
        );
        return { fullName: repo.full_name, installationId: Number(repo.installation_id), refs: Object.fromEntries(rows.map((r) => [r.environment, r.ref])) };
    });
}

/** The text of a file at a ref, or null (not there). */
async function fileText({ token, fullName, file, ref, fetch: fetchFn }) {
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    let body;
    try {
        body = await githubGet({ token, path: `/repos/${fullName}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, fetch: fetchFn });
    } catch (err) {
        if (err instanceof GitHubApiError && !(err instanceof GitHubRateLimitError) && err.status === 404) return null;
        throw err;
    }
    if (!body || body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') throw new FlagFileError(`${file}: not a file`);
    if (typeof body.size === 'number' && body.size > MAX_FILE_BYTES) throw new FlagFileError(`${file}: larger than ${MAX_FILE_BYTES / 1024} KB`);
    return Buffer.from(body.content, 'base64').toString('utf8');
}

/** Reads a candidate as it is, else under a common path; the first reading that yields flags wins. */
async function readCandidate(text, file) {
    let firstError = null;
    for (const path of [undefined, ...COMMON_PATHS]) {
        try {
            const flags = await parseFlagFile({ text, fileName: file, options: path ? { path } : {} });
            if (Object.keys(flags).length) return { path, flags };
        } catch (err) {
            if (!(err instanceof FlagFileError)) throw err;
            firstError = firstError || err.message;
        }
    }
    return { error: firstError || `${file}: no flags found` };
}

/**
 * Looks through a tracked repo's files at its latest prod deployment (else any environment's, else the default branch)
 * and proposes flags files, each with how it reads: the reading options found and its flags' states, or why not.
 *
 * @param {{ pool: import('pg').Pool, tenantId: string, repoId: number, tokenFor: (installationId: number) => Promise<string>, fetch?: typeof fetch }} input
 * @returns {Promise<{ ref: string, truncated: boolean, candidates: Array<{ file: string, envNames?: object, path?: string, flags?: object, error?: string }> }|null>} null for an untracked repo
 */
async function discoverFlagFiles({ pool, tenantId, repoId, tokenFor, fetch: fetchFn = fetch }) {
    const repo = await repoAndRefs(pool, { tenantId, repoId });
    if (!repo) return null;
    const ref = repo.refs.prod || repo.refs.qa || repo.refs.test || 'HEAD';
    const token = await tokenFor(repo.installationId);
    const tree = await githubGet({ token, path: `/repos/${repo.fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, fetch: fetchFn });
    if (!tree || !Array.isArray(tree.tree)) throw new GitHubApiError('tree response has no list', 502);
    const paths = tree.tree.filter((e) => e && e.type === 'blob' && typeof e.path === 'string').map((e) => e.path);
    const candidates = [];
    for (const candidate of flagFileCandidates(paths)) {
        const text = await fileText({ token, fullName: repo.fullName, file: candidate.samplePath, ref, fetch: fetchFn }).catch((err) => {
            if (err instanceof GitHubRateLimitError) throw err;
            return null;
        });
        const reading = text === null ? { error: `${candidate.samplePath}: could not be read` } : await readCandidate(text, candidate.samplePath);
        const { samplePath, ...proposal } = candidate;
        candidates.push({ ...proposal, ...(reading.path ? { path: reading.path } : {}), ...(reading.flags ? { flags: reading.flags } : { error: reading.error }), readFrom: samplePath });
    }
    return { ref, truncated: tree.truncated === true, candidates };
}

/**
 * How a code source's reading would come out, per environment, at each one's latest successful deployment (or the
 * default branch when the repo has none yet): its flags' states, or the error a sync would record. Nothing is stored.
 *
 * @param {{ pool: import('pg').Pool, tenantId: string, repoId: number, code: object, tokenFor: (installationId: number) => Promise<string>, fetch?: typeof fetch }} input
 *   `code` already checked (checkCodeConfig())
 * @returns {Promise<Array<{ env: string, ref: string, file: string, flags?: object, error?: string }>|null>} null for an untracked repo
 */
async function previewCodeSource({ pool, tenantId, repoId, code, tokenFor, fetch: fetchFn = fetch }) {
    const repo = await repoAndRefs(pool, { tenantId, repoId });
    if (!repo) return null;
    const token = await tokenFor(repo.installationId);
    const envs = ENVS.filter((env) => repo.refs[env]);
    const targets = envs.length ? envs.map((env) => [env, repo.refs[env]]) : [['prod', 'HEAD']];
    const out = [];
    for (const [env, ref] of targets) {
        const file = codeFileFor(code, env);
        try {
            const text = await fileText({ token, fullName: repo.fullName, file, ref, fetch: fetchFn });
            if (text === null) throw new FlagFileError(`${file} is not in ${repo.fullName} at ${ref === 'HEAD' ? 'the default branch' : ref.slice(0, 12)}`);
            out.push({ env, ref, file, flags: await parseFlagFile({ text, fileName: file, format: code.format, options: code }) });
        } catch (err) {
            if (err instanceof GitHubRateLimitError || !(err instanceof FlagFileError || err instanceof GitHubApiError)) throw err;
            out.push({ env, ref, file, error: err instanceof FlagFileError ? err.message : `${file}: GitHub answered ${err.status || 'with an error'}` });
        }
    }
    return out;
}

module.exports = { flagFileCandidates, discoverFlagFiles, previewCodeSource };
