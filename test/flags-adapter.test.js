// The ShipScope flags adapter (adapters/flags/): reading flags from files or a URL, building the ingest message,
// sending it, and its two entry points (command line, GitHub Action). ShipScope itself is a mocked fetch here;
// server/test/flags-ingest-schema.test.js posts the adapter's messages through the real route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    AdapterError, toState, parseDocument, flagMap, mergeStates, buildPayload, expandFiles, envPatternRegExp, parseEnvMap, parseHeaders, formatOf, run,
} = require('../adapters/flags/lib');
const { optionsFromArgs } = require('../adapters/flags/shipscope-flags');
const { optionsFromInputs, setOutputs } = require('../adapters/flags/action');

const DIR = path.resolve('test', '.tmp-flags-adapter');

test.beforeEach(() => fs.rmSync(DIR, { recursive: true, force: true }));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

function write(relPath, content) {
    const full = path.join(DIR, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

/** A fetch that answers from `routes` (url -> { status, body }) and records every call. */
function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const route = routes[String(url)];
        if (!route) return { ok: false, status: 404, text: async () => 'not found' };
        const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
        return { ok: route.status < 400, status: route.status, text: async () => body };
    };
    fn.calls = calls;
    return fn;
}

const INGESTED = { source: 'Frontend CI', flags: 2, changed: 1, removed: 0, stale: 0, created: ['newCheckout'] };
const quiet = () => {};

test('toState: booleans, words, numbers and numeric strings; 0 is off, 100 is on', () => {
    assert.deepEqual(toState(true, 'x'), { state: 'on' });
    assert.deepEqual(toState(false, 'x'), { state: 'off' });
    for (const on of ['true', 'ON', 'enabled', 'yes', 100, '100']) assert.deepEqual(toState(on, 'x'), { state: 'on' }, String(on));
    for (const off of ['false', 'Off', 'disabled', 'no', 0, '0']) assert.deepEqual(toState(off, 'x'), { state: 'off' }, String(off));
    assert.deepEqual(toState(25, 'x'), { state: 'partial', rollout: 25 });
    assert.deepEqual(toState(' 12.5 ', 'x'), { state: 'partial', rollout: 12.5 });
    assert.deepEqual(toState('partial', 'x'), { state: 'partial' });
    assert.throws(() => toState({ enabled: true }, 'f'), /\(an object per flag: name its value with value-path\)/);
    for (const bad of ['maybe', '', null, {}, [], NaN, -5, 150, '8080']) assert.throws(() => toState(bad, 'flags.json, flag a'), /flags\.json, flag a: cannot read/);
});

test('parseDocument: JSON; .properties with = or :, comments and quotes; .env with export', () => {
    assert.deepEqual(parseDocument('{"a":true}', 'json', 'f'), { a: true });
    assert.throws(() => parseDocument('{', 'json', 'f.json'), /f\.json: not valid JSON/);
    assert.deepEqual(parseDocument('# c\n! c\nfeature.a=true\nfeature.b : 25\n\nbroken\n', 'properties', 'f'), { 'feature.a': 'true', 'feature.b': '25' });
    assert.deepEqual(parseDocument('export FLAG_A="on"\r\nFLAG_B=\'off\'\nURL=http://x:1\n', 'env', 'f'), { FLAG_A: 'on', FLAG_B: 'off', URL: 'http://x:1' });
    assert.throws(() => parseDocument('a=1', 'yaml', 'f'), /unknown format "yaml"/);
});

test('formatOf: by file name', () => {
    assert.equal(formatOf('config/flags.prod.json'), 'json');
    assert.equal(formatOf('application-prod.properties'), 'properties');
    for (const name of ['.env', '.env.prod', 'prod.env']) assert.equal(formatOf(name), 'env');
    for (const name of ['prod.ts', 'flags.mts', 'flags.cts', 'flags.js', 'flags.mjs', 'flags.cjs']) assert.equal(formatOf(name), 'ts');
    assert.throws(() => formatOf('flags.yaml'), /unknown format, name it with --format/);
});

test('flagMap: path, value path and prefix', () => {
    const doc = { data: { flags: { 'feature.a': { enabled: true }, 'feature.b': { enabled: false }, other: { enabled: true } } } };
    assert.deepEqual(flagMap(doc, { path: 'data.flags', valuePath: 'enabled', prefix: 'feature.' }, 'f'), { a: true, b: false });
    assert.throws(() => flagMap(doc, { path: 'data.missing' }, 'f'), /f: no "data\.missing" in it/);
    assert.throws(() => flagMap({ list: [1] }, { path: 'list' }, 'f'), /expected an object of flags at "list"/);
    assert.throws(() => flagMap({ a: { on: true } }, { valuePath: 'enabled' }, 'f'), /f, flag a: no "enabled" in it/);
});

test('mergeStates: files merge; the same flag with two values is an error naming both files', () => {
    assert.deepEqual(mergeStates([{ where: 'a', flags: { x: true } }, { where: 'b', flags: { x: 'on', y: 25 } }]),
        { x: { state: 'on' }, y: { state: 'partial', rollout: 25 } });
    assert.throws(() => mergeStates([{ where: 'a.json', flags: { x: true } }, { where: 'b.json', flags: { x: false } }]), /flag x differs between a\.json and b\.json/);
});

test('buildPayload: full state of each environment given, in env then key order; bad env or key is an error', () => {
    assert.deepEqual(buildPayload({ byEnv: { prod: { b: { state: 'off' }, a: { state: 'partial', rollout: 5 } } }, changedBy: 'ci' }), {
        schemaVersion: 2, environments: ['prod'], complete: true, changedBy: 'ci',
        observations: [{ key: 'a', env: 'prod', state: 'partial', rollout: 5 }, { key: 'b', env: 'prod', state: 'off' }],
    });
    assert.deepEqual(buildPayload({ byEnv: { prod: { a: { state: 'on' } }, test: { a: { state: 'off' } }, qa: {} } }), {
        schemaVersion: 2, environments: ['test', 'qa', 'prod'], complete: true,
        observations: [{ key: 'a', env: 'test', state: 'off' }, { key: 'a', env: 'prod', state: 'on' }],
    });
    assert.equal(buildPayload({ byEnv: { qa: {} }, complete: false }).complete, false);
    assert.throws(() => buildPayload({ byEnv: { staging: {} } }), /environment "staging" must be one of test, qa, prod/);
    assert.throws(() => buildPayload({ byEnv: {} }), /no environment to send/);
    for (const key of ['1a', 'a b', '__proto__', '']) assert.throws(() => buildPayload({ byEnv: { qa: { [key]: { state: 'on' } } } }), /is not a valid flag key/);
});

test('expandFiles: plain paths and patterns, sorted; a pattern matching nothing is an error', () => {
    write('config/flags.qa.json', '{}');
    write('config/flags.prod.json', '{}');
    write('config/nested/more.json', '{}');
    assert.deepEqual(expandFiles(['config/flags.prod.json'], DIR), [{ file: 'config/flags.prod.json', env: null }]);
    if (typeof fs.globSync === 'function') {
        assert.deepEqual(expandFiles(['config/**/*.json', 'config/flags.qa.json'], DIR).map((f) => f.file),
            ['config/flags.prod.json', 'config/flags.qa.json', 'config/nested/more.json'].map((p) => p.split('/').join(path.sep)));
        assert.deepEqual(expandFiles(['config/flags.{env}.json'], DIR).map((f) => f.env), ['prod', 'qa'], '{env} is taken from each path');
    }
    assert.throws(() => expandFiles(['config/missing.json'], DIR), /no file matches config\/missing\.json/);
});

test('parseHeaders: "Name: value" lines', () => {
    assert.deepEqual(parseHeaders(['Authorization: Bearer x:y', '', ' Accept: application/json ']), { Authorization: 'Bearer x:y', Accept: 'application/json' });
    assert.throws(() => parseHeaders(['secret-token']), /must look like "Name: value"/);
});

test('run, file mode: reads and merges files, posts the message with the token, reports the answer', async () => {
    write('flags.json', JSON.stringify({ newCheckout: true, search: 25 }));
    write('app.properties', 'server.port=8080\nfeature.darkMode=false\n');
    const fetch = fakeFetch({ 'https://ship.example.com/api/flags/ingest': { status: 200, body: INGESTED } });
    const lines = [];
    const { payload, result } = await run({
        env: 'prod', files: ['flags.json'], shipscopeUrl: 'https://ship.example.com/', token: 'shpi_t', changedBy: 'deploy',
    }, { fetch, cwd: DIR, log: (l) => lines.push(l) });
    assert.deepEqual(result, INGESTED);
    assert.deepEqual(payload.observations.map((o) => o.key), ['newCheckout', 'search']);
    const [call] = fetch.calls;
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.authorization, 'Bearer shpi_t');
    assert.deepEqual(JSON.parse(call.init.body), payload);
    assert.match(lines[0], /ShipScope \(Frontend CI\): 2 flags for prod, 1 changed, 0 removed, new: newCheckout\./);

    const { payload: props } = await run({ env: 'qa', files: ['app.properties'], prefix: 'feature.', dryRun: true }, { cwd: DIR, log: quiet });
    assert.deepEqual(props.observations, [{ key: 'darkMode', env: 'qa', state: 'off' }]);
});

test('run, URL mode: fetches with the given headers, reads AppConfig-style values', async () => {
    const fetch = fakeFetch({
        'https://app.example.com/flags': { status: 200, body: { newCheckout: { enabled: true }, darkMode: { enabled: false } } },
        'https://ship.example.com/api/flags/ingest': { status: 200, body: INGESTED },
    });
    const { payload } = await run({
        env: 'test', url: 'https://app.example.com/flags', headers: { Authorization: 'Bearer app' }, valuePath: 'enabled',
        shipscopeUrl: 'https://ship.example.com', token: 'shpi_t',
    }, { fetch, log: quiet });
    assert.deepEqual(fetch.calls[0].init.headers, { Authorization: 'Bearer app' });
    assert.deepEqual(payload.observations, [{ key: 'darkMode', env: 'test', state: 'off' }, { key: 'newCheckout', env: 'test', state: 'on' }]);
});

test('run: dry run prints the message and sends nothing, without URL or token', async () => {
    write('flags.json', '{"a":true}');
    const fetch = fakeFetch({});
    const lines = [];
    const { result } = await run({ env: 'qa', files: ['flags.json'], dryRun: true }, { fetch, cwd: DIR, log: (l) => lines.push(l) });
    assert.equal(result, null);
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(JSON.parse(lines[0]).observations, [{ key: 'a', env: 'qa', state: 'on' }]);
    assert.match(lines[1], /Dry run: 1 flags for qa, nothing sent\./);
});

test('run: errors are AdapterErrors with the reason', async () => {
    write('flags.json', '{"a":true}');
    const io = { cwd: DIR, log: quiet };
    await assert.rejects(run({ env: 'qa', files: [], url: undefined }, io), /either files or a url/);
    await assert.rejects(run({ env: 'qa', files: ['flags.json'], url: 'https://x' }, io), /either files or a url/);
    await assert.rejects(run({ env: 'qa', files: ['flags.json'], token: 't' }, io), /ShipScope URL is missing/);
    await assert.rejects(run({ env: 'qa', files: ['flags.json'], shipscopeUrl: 'https://s' }, io), /ingest token is missing/);
    const fetch = fakeFetch({
        'https://s/api/flags/ingest': { status: 400, body: { message: 'body/observations/0/key must match pattern' } },
    });
    await assert.rejects(run({ env: 'qa', files: ['flags.json'], shipscopeUrl: 'https://s', token: 't' }, { ...io, fetch }),
        (err) => err instanceof AdapterError && /ShipScope answered 400: .*must match pattern/.test(err.message));
    await assert.rejects(run({ env: 'qa', url: 'https://app/flags', dryRun: true }, { ...io, fetch }), /https:\/\/app\/flags answered 404/);
});

test('command line: options from arguments and environment; --help; exit code 1 with the reason', () => {
    assert.deepEqual(optionsFromArgs(['--env', 'prod', '--file', 'a.json', '--file', 'b/*.json', '--header', 'X-A: 1', '--changes-only', '--value-path', 'enabled'],
        { SHIPSCOPE_URL: 'https://s', SHIPSCOPE_FLAGS_TOKEN: 'shpi_t' }), {
        env: 'prod', files: ['a.json', 'b/*.json'], envMap: undefined, url: undefined, headers: { 'X-A': '1' }, format: undefined, path: undefined,
        valuePath: 'enabled', prefix: undefined, changedBy: undefined, complete: false, dryRun: false, shipscopeUrl: 'https://s', token: 'shpi_t',
    });
    assert.deepEqual(optionsFromArgs(['--file', 'f/{env}.ts', '--env-map', 'dev=test,prod=prod', '--env-map', 'uat=qa'], {}).envMap, { dev: 'test', prod: 'prod', uat: 'qa' });
    assert.equal(optionsFromArgs(['--help'], {}), null);
    assert.throws(() => optionsFromArgs(['--env', 'qa', '--nope'], {}), AdapterError);

    write('flags.json', '{"a":25}');
    const cli = path.resolve('adapters/flags/shipscope-flags.js');
    const out = execFileSync(process.execPath, [cli, '--env', 'qa', '--file', 'flags.json', '--dry-run'], { cwd: DIR, encoding: 'utf8' });
    assert.match(out, /"rollout": 25/);
    assert.throws(() => execFileSync(process.execPath, [cli, '--env', 'qa', '--file', 'missing.json'], { cwd: DIR, stdio: 'pipe' }),
        (err) => err.status === 1 && /✗ no file matches missing\.json/.test(err.stderr.toString()));
});

test('GitHub Action: inputs as INPUT_* variables, outputs appended to GITHUB_OUTPUT', () => {
    const options = optionsFromInputs({
        'INPUT_ENVIRONMENT': 'prod', 'INPUT_FILES': 'config/a.json\n  config/b.json \n', 'INPUT_URL-HEADERS': '', 'INPUT_VALUE-PATH': 'enabled',
        'INPUT_COMPLETE': 'true', 'INPUT_DRY-RUN': 'TRUE', 'INPUT_SHIPSCOPE-URL': 'https://s', 'INPUT_TOKEN': 'shpi_t',
    });
    assert.deepEqual(options, {
        env: 'prod', files: ['config/a.json', 'config/b.json'], envMap: undefined, url: undefined, headers: {}, format: undefined, path: undefined,
        valuePath: 'enabled', prefix: undefined, changedBy: undefined, complete: true, dryRun: true, shipscopeUrl: 'https://s', token: 'shpi_t',
    });
    assert.throws(() => optionsFromInputs({ 'INPUT_DRY-RUN': 'yes' }), /input dry-run must be true or false/);
    assert.deepEqual(optionsFromInputs({ 'INPUT_FILES': 'f/{env}.ts', 'INPUT_ENV-MAP': 'dev=test\nprod=prod' }).envMap, { dev: 'test', prod: 'prod' });
    assert.equal(optionsFromInputs({ 'INPUT_FILES': 'f/{env}.ts' }).env, undefined);

    write('out.txt', '');
    setOutputs({ GITHUB_OUTPUT: path.join(DIR, 'out.txt') }, { flags: 2, changed: 1, removed: 0 });
    assert.equal(fs.readFileSync(path.join(DIR, 'out.txt'), 'utf8'), 'flags=2\nchanged=1\nremoved=0\n');
});

test('action.yml declares every input action.js reads and runs action.js', () => {
    const yml = fs.readFileSync('adapters/flags/action.yml', 'utf8');
    const declared = [...yml.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);
    const read = [...fs.readFileSync('adapters/flags/action.js', 'utf8').matchAll(/(?:input|lines|flag)\('([a-z-]+)'/g)].map((m) => m[1]);
    for (const name of read) assert.ok(declared.includes(name), `action.yml declares ${name}`);
    assert.match(yml, /using: node24\n {2}main: action\.js/);
});

test('{env} patterns and env-map: the environment from the path, names outside the map skipped', () => {
    const re = envPatternRegExp('domains/*/config/flags/{env}.ts');
    assert.deepEqual(re.exec('domains/charger/config/flags/prod.ts').slice(1), ['prod']);
    assert.equal(re.exec('domains/charger/nested/config/flags/prod.ts'), null, '* is one directory');
    assert.deepEqual(envPatternRegExp('**/flags.{env}.json').exec('flags.qa.json').slice(1), ['qa']);
    assert.deepEqual(parseEnvMap(['dev=test, qa=qa', 'prod = prod']), { dev: 'test', qa: 'qa', prod: 'prod' });
    assert.equal(parseEnvMap([]), undefined);
    assert.throws(() => parseEnvMap(['dev']), /"dev" must look like name=env/);
    assert.throws(() => parseEnvMap(['dev=staging']), /staging must be one of test, qa, prod/);
});

test('run, an Nx monorepo: domains/*/config/flags/{env}.ts, one message for every mapped environment', async () => {
    write('domains/charger/config/flags/prod.ts', `import { FeatureFlags } from '@shared/flags';
// Production
export const flags: FeatureFlags = {
  newCheckout: true,
  'charger-map': false, // map view
  rolloutSearch: 25,
} as const;
`);
    write('domains/charger/config/flags/dev.ts', 'export default { newCheckout: true, rolloutSearch: 100 };\n');
    write('domains/charger/config/flags/local.ts', 'export const flags = { newCheckout: false };\n');
    write('domains/billing/config/flags/prod.ts', 'const base = { invoicesV2: false };\nexport const billingFlags = { ...base, paypal: true };\n');
    const lines = [];
    const { payload } = await run({
        files: ['domains/*/config/flags/{env}.ts'], envMap: { dev: 'test', qa: 'qa', prod: 'prod' }, dryRun: true,
    }, { cwd: DIR, log: (l) => lines.push(l) });
    assert.deepEqual(payload.environments, ['test', 'prod'], 'qa has no file: not covered, left alone');
    assert.deepEqual(payload.observations.map((o) => `${o.env}:${o.key}=${o.state}${o.rollout ? o.rollout : ''}`), [
        'test:newCheckout=on', 'test:rolloutSearch=on',
        'prod:charger-map=off', 'prod:invoicesV2=off', 'prod:newCheckout=on', 'prod:paypal=on', 'prod:rolloutSearch=partial25',
    ]);
    assert.match(lines[0], /Skipped domains\/charger\/config\/flags\/local\.ts: "local" is not in env-map/);
    assert.match(lines.at(-1), /Dry run: 5 flags for test, prod, nothing sent\./);

    // Default map: test, qa and prod only, so dev.ts and local.ts are skipped.
    const { payload: byDefault } = await run({ files: ['domains/*/config/flags/{env}.ts'], dryRun: true }, { cwd: DIR, log: quiet });
    assert.deepEqual(byDefault.environments, ['prod']);
});

test('run, {env} misuse and computed values are errors with the reason', async () => {
    write('f/prod.ts', 'export const flags = { a: true, b: process.env.B === "1" };\n');
    write('g/prod.ts', 'export const a = { x: true };\nexport const b = { y: true };\n');
    write('h/prod.json', '{"a":true}');
    const io = { cwd: DIR, log: quiet };
    await assert.rejects(run({ files: ['f/{env}.ts'], dryRun: true }, io), /f\/prod\.ts, flag b: "process\.env\.B === "1"" is not written out as a value/);
    await assert.rejects(run({ files: ['g/{env}.ts'], dryRun: true }, io), /several objects \(a, b\); name the one with the flags in path/);
    assert.deepEqual((await run({ files: ['g/{env}.ts'], path: 'b', dryRun: true }, io)).payload.observations, [{ key: 'y', env: 'prod', state: 'on' }]);
    await assert.rejects(run({ env: 'prod', files: ['h/{env}.json'], dryRun: true }, io), /either an environment or \{env\}/);
    await assert.rejects(run({ files: ['h/{env}.json', 'h/prod.json'], dryRun: true }, io), /\{env\} in every file pattern or in none/);
    await assert.rejects(run({ files: ['h/prod.json'], dryRun: true }, io), /environment is missing/);
    await assert.rejects(run({ files: ['h/{env}.json'], envMap: { dev: 'test' }, dryRun: true }, io), /no file is for a mapped environment/);
    write('h/qa.json', '{"a":false}');
    await assert.rejects(run({ files: ['h/{env}.json'], envMap: { qa: 'prod', prod: 'prod' }, dryRun: true }, io), /flag a differs between h\/prod\.json and h\/qa\.json/);
});
