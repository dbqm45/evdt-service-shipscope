'use strict';
// Shared helpers for the flag-scripts*/prune-and-retrigger* tests (not a *.test.js, so not run by itself).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'scripts');

const SCRUB = [
    'FLAGS_META_PATH', 'FLAGS_SEARCH_ROOT', 'FLAG_STATES_PATH', 'FLAG_STATE_HISTORY_PATH', 'COMPONENT', 'CHANGED_BY',
    'FLAG_KEY', 'DESCRIPTION', 'SOURCE', 'JIRA_KEYS', 'COMPONENTS', 'ENVIRONMENT', 'ENABLED', 'WARN_ONLY',
    'STATUS_REPO_EDIT_URL', 'SYNC_META_PATH', 'URL_TEST', 'URL_QA', 'URL_PROD', 'FETCH_TIMEOUT_MS', 'APP_REPO',
    'APP_REPO_RERUN_TOKEN', 'WORKFLOW_FILE', 'PRUNE_PIS', 'JIRA_ISSUES_DIR', 'NODE_OPTIONS',
];

function cleanEnv(extra) {
    const env = { ...process.env };

    for (const k of SCRUB) delete env[k];

    return { ...env, ...extra };
}

function makeTmp(prefix) {
    const dir = path.join(__dirname, `.tmp-flags-${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

    fs.mkdirSync(dir, { recursive: true });

    return dir;
}

function rmTmp(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function runScript(script, env, cwd) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
        cwd, env: cleanEnv(env), encoding: 'utf8',
    });

    return { code: r.status, out: r.stdout, err: r.stderr };
}

function runScriptAsync(script, env, cwd) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(SCRIPTS, script)], { cwd, env: cleanEnv(env) });
        let out = '';
        let err = '';

        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => resolve({ code, out, err }));
    });
}

function write(dir, rel, content) {
    const full = path.join(dir, rel);

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
}

function readJ(dir, rel) {
    return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
}

function exists(dir, rel) {
    return fs.existsSync(path.join(dir, rel));
}

module.exports = { REPO, SCRIPTS, makeTmp, rmTmp, runScript, runScriptAsync, write, readJ, exists, cleanEnv };
