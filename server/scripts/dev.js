#!/usr/bin/env node
// One command for a local ShipScope: `npm run dev` (repo root or server/); `npm run dev:mock` (`--mock`) does the
// same, but the dashboard shows the built-in sample data instead of the workspace's (lib/mock-dashboard.js). It installs the server's dependencies,
// starts Postgres in Docker, creates the database and its non-superuser role, creates a GitHub App for you on the
// first run (GitHub's manifest flow: one click), applies the migrations, starts the Web Service and the worker, and
// prints the address to open. Ctrl+C stops both; the database container keeps its data for the next run.
//
// Only Node built-ins at the top: `pg` is required after the dependencies are installed.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(SERVER_DIR, '.env');
const ENV_EXAMPLE = path.join(SERVER_DIR, '.env.example');
const PG_CONTAINER = 'shipscope-dev-pg';
// The container the earlier manual setup (server/README.md before `npm run dev`) told people to create.
const LEGACY_PG_CONTAINER = 'shipscope-pg';
// The DATABASE_URL that setup's .env.example had: when nothing answers there, nothing is lost by switching.
const LEGACY_DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const PG_VOLUME = 'shipscope-dev-pg';
const PG_IMAGE = 'postgres:16-alpine';
const DEFAULT_PG_PORT = 54329;
const devDatabaseUrl = (port) => `postgres://shipscope_app:shipscope_app@localhost:${port}/shipscope`;
const adminDatabaseUrl = (port) => `postgres://postgres:postgres@localhost:${port}/postgres`;
const MANIFEST_CALLBACK = '/__dev/github-app';

const bold = (s) => (process.stdout.isTTY ? `\u001b[1m${s}\u001b[0m` : s);
const step = (s) => console.log(`\n▸ ${s}`);

class DevError extends Error {}

/**
 * Parses a .env file: `KEY=value` lines, `#` comments, optional surrounding quotes. Escapes are kept as written
 * (lib/config.js turns a private key's literal "\n" into newlines itself).
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseEnvFile(text) {
    const env = {};
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        let value = m[2];
        if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
        env[m[1]] = value;
    }
    return env;
}

/**
 * Sets keys in .env text: replaces an existing `KEY=` line (also a commented-out `# KEY=` one), else appends.
 * Values are written unquoted on one line; newlines must already be escaped.
 *
 * @param {string} text
 * @param {Record<string, string>} updates
 * @returns {string}
 */
function setEnvValues(text, updates) {
    let out = text;
    for (const [key, value] of Object.entries(updates)) {
        if (/[\r\n]/.test(value)) throw new Error(`${key}: escape newlines before writing to .env`);
        const re = new RegExp(`^#?\\s*${key}\\s*=.*$`, 'm');
        const line = `${key}=${value}`;
        out = re.test(out) ? out.replace(re, () => line) : `${out ? out.replace(/\n*$/, '\n') : ''}${line}\n`;
    }
    return out;
}

/**
 * The port of the Docker Postgres this script manages, when `url` points at it (localhost, the shipscope_app role,
 * the shipscope database); null for any other database, which is then used as it is.
 *
 * @param {string|undefined} url
 * @returns {number|null}
 */
function devDatabasePort(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const local = ['localhost', '127.0.0.1'].includes(u.hostname);
        return local && u.username === 'shipscope_app' && u.pathname === '/shipscope' ? Number(u.port) || 5432 : null;
    } catch {
        return null;
    }
}

/**
 * The GitHub App this dev server needs, as a manifest for GitHub's "create from manifest" flow
 * (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
 *
 * @param {{ baseUrl: string, suffix: string }} input
 * @returns {object}
 */
function buildManifest({ baseUrl, suffix }) {
    return {
        name: `ShipScope dev ${suffix}`,
        url: baseUrl,
        hook_attributes: { url: `${baseUrl}/webhooks/github`, active: false },
        redirect_url: `${baseUrl}${MANIFEST_CALLBACK}`,
        callback_urls: [`${baseUrl}/auth/github/callback`],
        setup_url: `${baseUrl}/github/setup`,
        setup_on_update: true,
        public: false,
        request_oauth_on_install: false,
        default_permissions: { metadata: 'read', deployments: 'read', contents: 'read', actions: 'read' },
        default_events: [],
    };
}

/**
 * The .env entries for a GitHub App returned by POST /app-manifests/{code}/conversions.
 *
 * @param {{ id: number, slug: string, client_id: string, client_secret: string, pem: string }} app
 * @returns {Record<string, string>}
 */
function envFromConversion(app) {
    for (const key of ['id', 'slug', 'client_id', 'client_secret', 'pem']) {
        if (app[key] === undefined || app[key] === null || app[key] === '') throw new DevError(`GitHub's answer has no ${key}`);
    }
    return {
        GITHUB_APP_CLIENT_ID: String(app.client_id),
        GITHUB_APP_CLIENT_SECRET: String(app.client_secret),
        GITHUB_APP_ID: String(app.id),
        GITHUB_APP_SLUG: String(app.slug),
        GITHUB_APP_PRIVATE_KEY: String(app.pem).trim().replace(/\r?\n/g, '\\n'),
    };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2328}
button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:0;background:#1f883d;color:#fff;cursor:pointer}
code{background:#f0f0f0;padding:0 .3rem;border-radius:4px}</style></head><body>${body}</body></html>`;
}

function readEnvFile() {
    return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : null;
}

function writeEnvValues(updates) {
    fs.writeFileSync(ENV_FILE, setEnvValues(readEnvFile() || '', updates), { mode: 0o600 });
}

function ensureEnvFile() {
    if (readEnvFile() !== null) return;
    step('Creating server/.env (gitignored) from .env.example');
    fs.writeFileSync(ENV_FILE, setEnvValues(fs.readFileSync(ENV_EXAMPLE, 'utf8'), { DATABASE_URL: devDatabaseUrl(DEFAULT_PG_PORT), DATABASE_SSL: 'false' }), { mode: 0o600 });
}

function ensureDependencies() {
    if (fs.existsSync(path.join(SERVER_DIR, 'node_modules', 'pg')) && fs.existsSync(path.join(SERVER_DIR, 'node_modules', 'fastify'))) return;
    step('Installing the server\'s dependencies (npm ci)');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npm, ['ci'], { cwd: SERVER_DIR, stdio: 'inherit' });
    if (res.status !== 0) throw new DevError('npm ci failed');
}

function docker(args, options = {}) {
    return spawnSync('docker', args, { encoding: 'utf8', ...options });
}

function ensureDockerPostgres(port) {
    const info = docker(['info', '--format', '{{.ServerVersion}}']);
    if (info.error || info.status !== 0) {
        throw new DevError('Docker is not running (or not installed). Start Docker Desktop (or the Docker service) and run this again.');
    }
    const state = docker(['ps', '-a', '--filter', `name=^/${PG_CONTAINER}$`, '--format', '{{.State}}']).stdout.trim();
    if (state === 'running') return;
    if (state) {
        step(`Starting the Postgres container ${PG_CONTAINER}`);
        if (docker(['start', PG_CONTAINER], { stdio: 'inherit' }).status !== 0) throw new DevError(`docker start ${PG_CONTAINER} failed`);
        return;
    }
    if (docker(['image', 'inspect', PG_IMAGE]).status !== 0) {
        step(`Downloading ${PG_IMAGE}`);
        if (docker(['pull', PG_IMAGE], { stdio: 'inherit' }).status !== 0) throw new DevError(`docker pull ${PG_IMAGE} failed (network, or Docker Hub's rate limit: try again in a while)`);
    }
    step(`Creating the Postgres container ${PG_CONTAINER} (${PG_IMAGE}, port ${port}, data in volume ${PG_VOLUME})`);
    const res = docker(['run', '-d', '--name', PG_CONTAINER, '-e', 'POSTGRES_PASSWORD=postgres',
        '-p', `127.0.0.1:${port}:5432`, '-v', `${PG_VOLUME}:/var/lib/postgresql/data`, PG_IMAGE], { stdio: 'inherit' });
    if (res.status !== 0) throw new DevError(`docker run ${PG_IMAGE} failed (is port ${port} free? change the port in DATABASE_URL in server/.env)`);
}

const redact = (url) => url.replace(/:[^:@/]*@/, ':***@');

/** One connection attempt; resolves to whether the database answered. */
async function canConnect(url) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
        await client.connect();
        return true;
    } catch {
        return false;
    } finally {
        await client.end().catch(() => {});
    }
}

async function waitForPostgres(url, seconds = 60, hint = '') {
    for (let i = 0; i < seconds; i++) {
        if (await canConnect(url)) return;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new DevError(`Postgres did not answer at ${redact(url)} within ${seconds}s.${hint}`);
}

/**
 * A DATABASE_URL this script doesn't manage (e.g. from the earlier manual setup). When it doesn't answer and the old
 * setup's stopped container exists, start it. Resolves false when it is the old setup's default address with nothing
 * behind it (the caller then switches to the managed database); throws for any other address that doesn't answer.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function ensureOtherDatabase(url) {
    const hint = '\n  Start that database, or let `npm run dev` run its own in Docker: delete the DATABASE_URL line from server/.env.'
        + '\n  (That gives a new, empty database; workspaces created in the old one stay there.)';
    if (!(await canConnect(url))) {
        let host = '';
        try { host = new URL(url).hostname; } catch { /* reported by the wait below */ }
        const local = ['localhost', '127.0.0.1'].includes(host);
        const dockerUp = local && docker(['info', '--format', '{{.ServerVersion}}']).status === 0;
        const legacy = dockerUp ? docker(['ps', '-a', '--filter', `name=^/${LEGACY_PG_CONTAINER}$`, '--format', '{{.State}}']).stdout.trim() : '';
        if (legacy && legacy !== 'running') {
            step(`Starting the Postgres container ${LEGACY_PG_CONTAINER} (from the earlier setup)`);
            docker(['start', LEGACY_PG_CONTAINER], { stdio: 'inherit' });
        } else if (!legacy && url === LEGACY_DEFAULT_DATABASE_URL) {
            return false;
        } else if (!legacy) {
            throw new DevError(`Postgres does not answer at ${redact(url)} (DATABASE_URL in server/.env).${hint}`);
        }
    }
    await waitForPostgres(url, 30, hint);

    const { Client } = require('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
        const { rows } = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
        if (rows[0] && rows[0].rolsuper) {
            console.log('  Note: this database user is a superuser, so Row-Level Security is not enforced as it is on Render.'
                + '\n  Delete the DATABASE_URL line from server/.env to switch to the database `npm run dev` manages (a new, empty one).');
        }
    } finally {
        await client.end();
    }
    return true;
}

/** The app's own non-superuser role and database, as on Render: a superuser would bypass Row-Level Security. */
async function ensureDatabase(port) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: adminDatabaseUrl(port) });
    await client.connect();
    try {
        await client.query(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shipscope_app') THEN
                CREATE ROLE shipscope_app LOGIN PASSWORD 'shipscope_app';
            END IF;
        END $$`);
        const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'shipscope'");
        if (!exists.rowCount) await client.query('CREATE DATABASE shipscope OWNER shipscope_app');
    } finally {
        await client.end();
    }
    return true;
}

function assertPortFree(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
            socket.destroy();
            reject(new DevError(`Port ${port} is already in use. Stop whatever runs there, or set PORT (and PUBLIC_BASE_URL) in server/.env.`));
        });
        socket.once('error', () => resolve());
    });
}

/** GitHub's manifest flow: a local page with one button, GitHub creates the App, we exchange the code for its keys. */
function createGitHubApp({ port, baseUrl, org }) {
    const state = crypto.randomBytes(16).toString('hex');
    const manifest = buildManifest({ baseUrl, suffix: crypto.randomBytes(3).toString('hex') });
    const target = org
        ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
        : `https://github.com/settings/apps/new?state=${state}`;

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, baseUrl);
            if (url.pathname === MANIFEST_CALLBACK) {
                if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
                    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('ShipScope', '<p>That link is not from this run. Go back to <a href="/">the start page</a>.</p>'));
                    return;
                }
                try {
                    const gh = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get('code'))}/conversions`, {
                        method: 'POST',
                        headers: { accept: 'application/vnd.github+json', 'user-agent': 'shipscope-dev', 'x-github-api-version': '2022-11-28' },
                    });
                    if (!gh.ok) throw new DevError(`GitHub answered ${gh.status} to the manifest conversion`);
                    const app = await gh.json();
                    writeEnvValues(envFromConversion(app));
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('ShipScope',
                        `<h1>GitHub App created</h1><p><b>${escapeHtml(app.name || app.slug)}</b> is saved in <code>server/.env</code>.
                        ShipScope is starting; this page opens it in a few seconds.</p><meta http-equiv="refresh" content="6;url=/">`));
                    server.close();
                    resolve(app);
                } catch (err) {
                    // Keep waiting: the code is single-use, but the start page creates a fresh App on the next try.
                    console.error(`  Could not read the new App's keys from GitHub: ${err.message}`);
                    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' }).end(page('ShipScope',
                        `<p>Could not read the new App's keys from GitHub: ${escapeHtml(err.message)}.</p><p><a href="/">Try again</a></p>`));
                }
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('ShipScope — first run', `
                <h1>One step before ShipScope starts</h1>
                <p>Signing in to ShipScope goes through a GitHub App. GitHub will create one for this local server
                (callback, setup URL and read-only permissions are filled in) under ${org ? `the organization <b>${escapeHtml(org)}</b>` : 'your account'}.
                Its keys are saved to <code>server/.env</code>, so this happens only once.</p>
                <form action="${escapeHtml(target)}" method="post">
                  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
                  <button type="submit">Create the GitHub App on GitHub</button>
                </form>`));
        });
        server.once('error', reject);
        server.listen(port, () => {
            console.log(`\n  ${bold('Open this link to create the GitHub App ShipScope signs in with (first run only):')}`);
            console.log(`\n      ${bold(baseUrl + '/')}\n`);
        });
    });
}

function prefixed(name, stream) {
    let buffered = '';
    stream.on('data', (chunk) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) console.log(`[${name}] ${line}`);
    });
}

async function waitForHealth(baseUrl, child, seconds = 30) {
    for (let i = 0; i < seconds * 4; i++) {
        if (child.exitCode !== null) throw new DevError('The Web Service stopped while starting (see [web] above)');
        try {
            const res = await fetch(`${baseUrl}/health`);
            if (res.ok) return;
        } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new DevError(`${baseUrl}/health did not answer within ${seconds}s`);
}

async function main() {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new DevError(`Node.js 20 or newer is needed (this is ${process.version})`);

    ensureDependencies();
    ensureEnvFile();
    let fileEnv = parseEnvFile(readEnvFile());

    if (!fileEnv.DATABASE_URL) {
        writeEnvValues({ DATABASE_URL: devDatabaseUrl(DEFAULT_PG_PORT), DATABASE_SSL: 'false' });
        fileEnv = parseEnvFile(readEnvFile());
    }
    let pgPort = devDatabasePort(fileEnv.DATABASE_URL);
    if (!pgPort) {
        step('Using DATABASE_URL from server/.env');
        if (!(await ensureOtherDatabase(fileEnv.DATABASE_URL))) {
            console.log(`  Nothing answers at the earlier setup's default address and its ${LEGACY_PG_CONTAINER} container doesn't exist:`
                + '\n  switching server/.env to the database `npm run dev` manages.');
            writeEnvValues({ DATABASE_URL: devDatabaseUrl(DEFAULT_PG_PORT), DATABASE_SSL: 'false' });
            fileEnv = parseEnvFile(readEnvFile());
            pgPort = DEFAULT_PG_PORT;
        }
    }
    if (pgPort) {
        ensureDockerPostgres(pgPort);
        step('Waiting for Postgres');
        await waitForPostgres(adminDatabaseUrl(pgPort), 60);
        await ensureDatabase(pgPort);
    }
    fileEnv = parseEnvFile(readEnvFile());

    const port = Number(fileEnv.PORT) || 3000;
    const baseUrl = (fileEnv.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
    await assertPortFree(port);

    if (!fileEnv.GITHUB_APP_CLIENT_ID || !fileEnv.GITHUB_APP_CLIENT_SECRET) {
        step('No GitHub App in server/.env yet');
        await createGitHubApp({ port, baseUrl, org: process.env.SHIPSCOPE_DEV_GITHUB_ORG || fileEnv.SHIPSCOPE_DEV_GITHUB_ORG });
        fileEnv = parseEnvFile(readEnvFile());
        await assertPortFree(port);
    }

    const mock = process.argv.includes('--mock');
    const env = { ...process.env, ...fileEnv, PUBLIC_BASE_URL: baseUrl, PORT: String(port), ...(mock ? { SHIPSCOPE_MOCK_DATA: '1' } : {}) };

    step('Applying migrations');
    const migrate = spawnSync(process.execPath, ['scripts/migrate.js'], { cwd: SERVER_DIR, env, stdio: 'inherit' });
    if (migrate.status !== 0) throw new DevError('Migrations failed');

    step('Starting the Web Service and the worker');
    const children = ['web', 'worker'].map((name) => {
        // Own process group: Ctrl+C reaches only this script, which then stops both children in order.
        const child = spawn(process.execPath, [`${name}.js`], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        prefixed(name, child.stdout);
        prefixed(name, child.stderr);
        return child;
    });
    let stopping = false;
    const stop = (code) => {
        if (stopping) return;
        stopping = true;
        for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
        setTimeout(() => process.exit(code), 500).unref();
    };
    process.on('exit', () => children.forEach((child) => child.exitCode === null && child.kill('SIGTERM')));
    process.on('SIGINT', () => stop(0));
    process.on('SIGTERM', () => stop(0));
    for (const child of children) {
        child.on('exit', (code) => {
            if (!stopping) {
                console.error(`\nA ShipScope process stopped (exit ${code}); stopping the other one.`);
                stop(code || 1);
            }
        });
    }

    await waitForHealth(baseUrl, children[0]);
    console.log(`\n  ${bold('ShipScope is running:')}  ${bold(baseUrl + '/')}`);
    if (mock) console.log(`\n  ${bold('Mock data:')} every workspace's dashboard shows the built-in sample data.`);
    console.log('\n  Sign in with GitHub, create a workspace, then follow its Getting started checklist.');
    console.log(pgPort
        ? `  Ctrl+C stops ShipScope; the database keeps running (docker stop ${PG_CONTAINER} to stop it).\n`
        : '  Ctrl+C stops ShipScope.\n');
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`\n✗ ${err instanceof DevError ? err.message : err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { parseEnvFile, setEnvValues, devDatabasePort, buildManifest, envFromConversion };
