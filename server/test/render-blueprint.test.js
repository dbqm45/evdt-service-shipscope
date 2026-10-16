const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// render.yaml is the deployment; a mistake there only shows up on Render. These checks read it as text (the repo has
// no YAML parser and needs none for this) and compare it with what the code actually needs.
const REPO = path.join(__dirname, '..', '..');
const blueprint = fs.readFileSync(path.join(REPO, 'render.yaml'), 'utf8');

/** Each service's block: its name, `key: value` settings and declared env var names. */
function services() {
    const body = blueprint.split(/^databases:/m)[0];
    return body.split(/^ {2}- type: /m).slice(1).map((block) => {
        const setting = (key) => (new RegExp(`^ {4}${key}: (.+)$`, 'm').exec(block) || [])[1] || null;
        return {
            type: block.split('\n')[0].trim(),
            name: setting('name'),
            rootDir: setting('rootDir'),
            buildCommand: setting('buildCommand'),
            preDeployCommand: setting('preDeployCommand'),
            startCommand: setting('startCommand'),
            buildPaths: [...block.matchAll(/^ {8}- (\S+)$/gm)].map((m) => m[1]),
            env: [...block.matchAll(/^ {6}- key: (\S+)/gm)].map((m) => m[1]),
        };
    });
}

const byName = Object.fromEntries(services().map((s) => [s.name, s]));

test('render.yaml: both services build and start from the repo root, so docs/ (the dashboard and settings pages) is deployed', () => {
    assert.deepStrictEqual(Object.keys(byName).sort(), ['shipscope-web', 'shipscope-worker']);
    for (const service of Object.values(byName)) {
        assert.strictEqual(service.rootDir, null, `${service.name}: rootDir hides every file outside it, docs/ included`);
        assert.strictEqual(service.buildCommand, 'npm ci --prefix server');
        assert.strictEqual(service.preDeployCommand, 'node server/scripts/migrate.js', `${service.name}: migrations before the new code runs`);
        const script = /^node (\S+)$/.exec(service.startCommand)[1];
        assert.ok(fs.existsSync(path.join(REPO, script)), `${service.name}: ${script} exists`);
        assert.ok(service.buildPaths.includes('server/**'), `${service.name}: a server change deploys it`);
    }
    assert.strictEqual(byName['shipscope-web'].startCommand, 'node server/web.js');
    assert.strictEqual(byName['shipscope-worker'].startCommand, 'node server/worker.js');
    for (const pattern of ['docs/*.html', 'docs/*.css', 'docs/*.js', 'docs/*.svg']) {
        assert.ok(byName['shipscope-web'].buildPaths.includes(pattern), `a dashboard change (${pattern}) redeploys the web service`);
    }
    assert.ok(!byName['shipscope-web'].buildPaths.some((p) => p.startsWith('docs/data')), 'the bots\' data never triggers a deploy');
});

test('render.yaml: every variable the code reads is declared on the service that reads it', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const config = read('lib/config.js');
    const declaredInConfig = new Set([...config.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]).filter((k) => /^(GITHUB|ATLASSIAN|TOKEN|PUBLIC)_/.test(k)));
    const web = [...declaredInConfig, 'DATABASE_URL'];
    const worker = ['DATABASE_URL', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'ATLASSIAN_CLIENT_ID', 'ATLASSIAN_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'PUBLIC_BASE_URL'];
    for (const key of web) assert.ok(byName['shipscope-web'].env.includes(key), `shipscope-web declares ${key}`);
    for (const key of worker) assert.ok(byName['shipscope-worker'].env.includes(key), `shipscope-worker declares ${key}`);
    assert.ok(declaredInConfig.has('GITHUB_APP_WEBHOOK_SECRET') && declaredInConfig.has('PUBLIC_BASE_URL'), 'the scan finds the config\'s variables');
    // Secrets are never in the file: every one of them is `sync: false` (Render asks for the value).
    for (const key of ['GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET', 'ATLASSIAN_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY']) {
        for (const match of blueprint.matchAll(new RegExp(`- key: ${key}\\n\\s+(\\S+):`, 'g'))) assert.strictEqual(match[1], 'sync', `${key} is sync: false`);
    }
});
