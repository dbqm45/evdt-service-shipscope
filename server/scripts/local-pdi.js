#!/usr/bin/env node
// The connection with a pdi receiver on this machine without the browser, for `sdlc up` (pdi's docs/plan-l4-sdlc.md;
// design-docs/LOCAL-PDI-PLAN.pl.md). Local mode only (lib/local-mode.js: a localhost PUBLIC_BASE_URL outside
// production). It acts as the oldest workspace's first admin, so someone has signed in and created a workspace before.
//
//   node server/scripts/local-pdi.js connect [--receiver http://127.0.0.1:8787] [--replace]
//   node server/scripts/local-pdi.js test
//   node server/scripts/local-pdi.js track --repo <owner/name> [--flags '<code source config as JSON>']
//
// `connect` is Settings → Integrations → pdi → Connect: it prints { workspace, connection, env } as JSON on stdout, env
// being the three PDI_SHIPSCOPE_* values, shown once. `--replace` disconnects an active connection first. `test` pings
// the receiver as Settings' Test does and prints { workspace, connection }. `track` is Settings → GitHub → Track
// repository for a repo of an installation already linked to the workspace (installing the App is a click in the
// browser), plus, with `--flags`, a source read from that repo's code (Settings → Sources → Read from code; the JSON is
// its `code` config, e.g. {"file":"config/flags.{env}.json"}); both idempotent; it prints { workspace, repo, flagSource }.
// Messages go to stderr, never a secret.
// Exit codes: 0 done, 2 refused (configuration or input), 3 no workspace yet, 4 already connected, 5 the GitHub App
// is not installed on the repo's account or cannot see the repo yet.
// It reads server/.env like `npm run dev`; a variable set in the environment wins over the file.
const fs = require('fs');
const path = require('path');
const { parseEnvFile } = require('./dev');
const { localModeEnabled } = require('../lib/local-mode');

const ENV_FILE = path.join(__dirname, '..', '.env');
const DEFAULT_RECEIVER = 'http://127.0.0.1:8787';

/**
 * @param {{ argv: string[], env: Record<string, string|undefined>, pool: import('pg').Pool, io: { out: (s: string) => void, err: (s: string) => void }, fetchImpl?: Function, listRepos?: (installationId: number) => Promise<Array<{ id: number, fullName: string }>> }} input
 *   `listRepos` lists an installation's repositories (GitHub, through the App's installation token)
 * @returns {Promise<number>} the exit code
 */
async function run({ argv, env, pool, io, fetchImpl, listRepos }) {
    const { loadEncryptionKey } = require('../lib/config');
    const { checkUrl, safeFetch, SafeFetchError } = require('../lib/safe-fetch');
    const [command, ...rest] = argv;
    const refuse = (message) => {
        io.err(`✗ ${message}\n`);
        return 2;
    };
    if (!['connect', 'test', 'track'].includes(command)) return refuse('usage: local-pdi.js connect [--receiver <url>] [--replace] | test | track --repo <owner/name> [--flags <json>]');
    if (!localModeEnabled(env)) return refuse('only in local mode: PUBLIC_BASE_URL must be http://localhost or http://127.0.0.1 (and NODE_ENV not production)');
    let encryptionKey;
    try {
        encryptionKey = loadEncryptionKey(env);
    } catch (err) {
        return refuse(err.message);
    }
    if (!encryptionKey) return refuse('TOKEN_ENCRYPTION_KEY is not set (npm run dev writes one into server/.env)');
    if (command === 'track') return track({ rest, env, pool, io, refuse, listRepos });
    const at = rest.indexOf('--receiver');
    const receiverUrl = at >= 0 ? rest[at + 1] || '' : DEFAULT_RECEIVER;
    try {
        checkUrl(receiverUrl, { loopback: true });
    } catch (err) {
        if (err instanceof SafeFetchError) return refuse(`--receiver: ${err.message}`);
        throw err;
    }

    const { connectPdi, disconnectPdi, testPdiConnection, PdiConnectionConflictError, PdiConnectionError, NoPdiConnectionError } = require('../lib/pdi-connection');
    const found = await workspaceAndAdmin(pool, env, io);
    if (found.code) return found.code;
    const { tenant, actor } = found;
    const workspace = { id: tenant.id, name: tenant.name };
    try {
        if (command === 'test') {
            const connection = await testPdiConnection(pool, { ...actor, encryptionKey, fetchImpl: fetchImpl || safeFetch, localMode: true });
            io.out(`${JSON.stringify({ workspace, connection })}\n`);
            return 0;
        }
        if (rest.includes('--replace')) await disconnectPdi(pool, actor);
        const { connection, env: pdiEnv } = await connectPdi(pool, {
            ...actor, receiverUrl, publicBaseUrl: new URL(env.PUBLIC_BASE_URL).origin, encryptionKey, localMode: true,
        });
        io.out(`${JSON.stringify({ workspace, connection, env: pdiEnv })}\n`);
        io.err(`✓ ${tenant.name} connected with pdi at ${connection.receiverUrl} (${connection.state})\n`);
        return 0;
    } catch (err) {
        if (err instanceof PdiConnectionConflictError) {
            io.err(`✗ ${tenant.name} is already connected with pdi; run with --replace for new variables\n`);
            return 4;
        }
        if (err instanceof PdiConnectionError || err instanceof NoPdiConnectionError) return refuse(err.message);
        throw err;
    }
}

const valueOf = (rest, flag) => {
    const at = rest.indexOf(flag);
    return at >= 0 ? rest[at + 1] ?? '' : null;
};

/** The oldest workspace and its first admin, or an exit code. */
async function workspaceAndAdmin(pool, env, io) {
    const { withScope } = require('../lib/scope');
    const { rows: [tenant] } = await pool.query('SELECT id, name FROM tenants ORDER BY created_at LIMIT 1');
    if (!tenant) {
        io.err(`… no workspace yet: Sign in at ${env.PUBLIC_BASE_URL} and create a workspace, then run this again\n`);
        return { code: 3 };
    }
    const admin = await withScope(pool, { tenantId: tenant.id }, async (client) => (await client.query(
        "SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'admin' ORDER BY created_at LIMIT 1", [tenant.id]
    )).rows[0]);
    if (!admin) {
        io.err(`✗ the workspace ${tenant.name} has no admin\n`);
        return { code: 2 };
    }
    return { tenant, actor: { tenantId: tenant.id, actorUserId: admin.user_id } };
}

async function track({ rest, env, pool, io, refuse, listRepos }) {
    const { withScope } = require('../lib/scope');
    const { trackRepo } = require('../lib/github-connections');
    const { createFlagSource, FlagSourceConfigError } = require('../lib/flags');
    const { checkCodeConfig } = require('../lib/flags-logic');
    const fullName = valueOf(rest, '--repo') || '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return refuse('--repo owner/name');
    let code = null;
    const flags = valueOf(rest, '--flags');
    if (flags !== null) {
        try {
            code = checkCodeConfig(JSON.parse(flags), { kind: 'build', repoIds: [0] });
        } catch (err) {
            return refuse(`--flags: ${err instanceof SyntaxError ? 'not JSON' : err.message}`);
        }
    }
    const found = await workspaceAndAdmin(pool, env, io);
    if (found.code) return found.code;
    const { tenant, actor } = found;
    const owner = fullName.split('/')[0];
    const installations = await withScope(pool, { tenantId: tenant.id }, async (client) => (await client.query(
        'SELECT installation_id FROM github_installations WHERE tenant_id = $1 AND lower(account_login) = lower($2) ORDER BY created_at', [tenant.id, owner]
    )).rows);
    let repo = null;
    let installationId = null;
    for (const row of installations) {
        installationId = Number(row.installation_id);
        repo = (await listRepos(installationId)).find((r) => r.fullName.toLowerCase() === fullName.toLowerCase()) || null;
        if (repo) break;
    }
    if (!repo) {
        const slug = env.GITHUB_APP_SLUG ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : 'the App\'s page on GitHub';
        io.err(installations.length
            ? `… the ShipScope GitHub App on ${owner} cannot see ${fullName}: give it access at ${slug} (or wait a moment for a new repo)\n`
            : `… Install the ShipScope GitHub App on ${owner} (all repositories, or ${fullName}) at ${slug}, signed in to ShipScope, then run this again\n`);
        return 5;
    }
    const tracked = await trackRepo(pool, { ...actor, installationId, repo });
    let flagSource = null;
    if (code) {
        const existing = await withScope(pool, { tenantId: tenant.id }, async (client) => (await client.query(
            `SELECT s.id FROM flag_sources s JOIN flag_source_repos r ON r.tenant_id = s.tenant_id AND r.source_id = s.id
             WHERE s.tenant_id = $1 AND s.origin = 'code' AND r.repo_id = $2 AND s.code_config->>'file' = $3 LIMIT 1`, [tenant.id, repo.id, code.file]
        )).rows[0]);
        if (existing) {
            flagSource = { id: existing.id, created: false };
        } else {
            try {
                const { source } = await createFlagSource(pool, { ...actor, name: `${repo.fullName} flags`, kind: 'build', origin: 'code', repoIds: [repo.id], code });
                flagSource = { id: source.id, created: true };
            } catch (err) {
                if (err instanceof FlagSourceConfigError) return refuse(`--flags: ${err.message}`);
                throw err;
            }
        }
    }
    io.out(`${JSON.stringify({ workspace: { id: tenant.id, name: tenant.name }, repo: tracked, flagSource })}\n`);
    io.err(`✓ ${repo.fullName} tracked in ${tenant.name}${flagSource ? `, flags from ${code.file}` : ''}\n`);
    return 0;
}

if (require.main === module) {
    const fileEnv = fs.existsSync(ENV_FILE) ? parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8')) : {};
    const env = { ...fileEnv, ...process.env };
    const { createPool } = require('../lib/db');
    const pool = createPool(env);
    const listRepos = (installationId) => {
        const { loadGitHubAppConfig } = require('../lib/config');
        const { listInstallationRepos } = require('../lib/github-app');
        return listInstallationRepos({ app: loadGitHubAppConfig(env), installationId });
    };
    run({ argv: process.argv.slice(2), env, pool, io: { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, listRepos })
        .then((code) => { process.exitCode = code; })
        .catch((err) => {
            process.stderr.write(`✗ ${err.message}\n`);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = { run, DEFAULT_RECEIVER };
