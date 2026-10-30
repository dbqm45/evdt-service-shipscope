#!/usr/bin/env node
// The connection with a pdi receiver on this machine without the browser, for `sdlc up` (pdi's docs/plan-l4-sdlc.md;
// design-docs/LOCAL-PDI-PLAN.pl.md). Local mode only (lib/local-mode.js: a localhost PUBLIC_BASE_URL outside
// production). It acts as the oldest workspace's first admin, so someone has signed in and created a workspace before.
//
//   node server/scripts/local-pdi.js connect [--receiver http://127.0.0.1:8787] [--replace]
//   node server/scripts/local-pdi.js test
//
// `connect` is Settings → Integrations → pdi → Connect: it prints { workspace, connection, env } as JSON on stdout, env
// being the three PDI_SHIPSCOPE_* values, shown once. `--replace` disconnects an active connection first. `test` pings
// the receiver as Settings' Test does and prints { workspace, connection }. Messages go to stderr, never a secret.
// Exit codes: 0 done, 2 refused (configuration or input), 3 no workspace yet, 4 already connected.
// It reads server/.env like `npm run dev`; a variable set in the environment wins over the file.
const fs = require('fs');
const path = require('path');
const { parseEnvFile } = require('./dev');
const { localModeEnabled } = require('../lib/local-mode');

const ENV_FILE = path.join(__dirname, '..', '.env');
const DEFAULT_RECEIVER = 'http://127.0.0.1:8787';

/**
 * @param {{ argv: string[], env: Record<string, string|undefined>, pool: import('pg').Pool, io: { out: (s: string) => void, err: (s: string) => void }, fetchImpl?: Function }} input
 * @returns {Promise<number>} the exit code
 */
async function run({ argv, env, pool, io, fetchImpl }) {
    const { loadEncryptionKey } = require('../lib/config');
    const { checkUrl, safeFetch, SafeFetchError } = require('../lib/safe-fetch');
    const [command, ...rest] = argv;
    const refuse = (message) => {
        io.err(`✗ ${message}\n`);
        return 2;
    };
    if (command !== 'connect' && command !== 'test') return refuse('usage: local-pdi.js connect [--receiver <url>] [--replace] | test');
    if (!localModeEnabled(env)) return refuse('only in local mode: PUBLIC_BASE_URL must be http://localhost or http://127.0.0.1 (and NODE_ENV not production)');
    let encryptionKey;
    try {
        encryptionKey = loadEncryptionKey(env);
    } catch (err) {
        return refuse(err.message);
    }
    if (!encryptionKey) return refuse('TOKEN_ENCRYPTION_KEY is not set (npm run dev writes one into server/.env)');
    const at = rest.indexOf('--receiver');
    const receiverUrl = at >= 0 ? rest[at + 1] || '' : DEFAULT_RECEIVER;
    try {
        checkUrl(receiverUrl, { loopback: true });
    } catch (err) {
        if (err instanceof SafeFetchError) return refuse(`--receiver: ${err.message}`);
        throw err;
    }

    const { withScope } = require('../lib/scope');
    const { connectPdi, disconnectPdi, testPdiConnection, PdiConnectionConflictError, PdiConnectionError, NoPdiConnectionError } = require('../lib/pdi-connection');
    const { rows: [tenant] } = await pool.query('SELECT id, name FROM tenants ORDER BY created_at LIMIT 1');
    if (!tenant) {
        io.err(`… no workspace yet: Sign in at ${env.PUBLIC_BASE_URL} and create a workspace, then run this again\n`);
        return 3;
    }
    const admin = await withScope(pool, { tenantId: tenant.id }, async (client) => (await client.query(
        "SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'admin' ORDER BY created_at LIMIT 1", [tenant.id]
    )).rows[0]);
    if (!admin) return refuse(`the workspace ${tenant.name} has no admin`);
    const actor = { tenantId: tenant.id, actorUserId: admin.user_id };
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

if (require.main === module) {
    const fileEnv = fs.existsSync(ENV_FILE) ? parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8')) : {};
    const env = { ...fileEnv, ...process.env };
    const { createPool } = require('../lib/db');
    const pool = createPool(env);
    run({ argv: process.argv.slice(2), env, pool, io: { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) } })
        .then((code) => { process.exitCode = code; })
        .catch((err) => {
            process.stderr.write(`✗ ${err.message}\n`);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = { run, DEFAULT_RECEIVER };
