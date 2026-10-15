const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validatePayload } = require('../scripts/ingest-flags');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ingest-flags.js');
const ROOT = path.join(__dirname, '.tmp-ingest-flags');
const rel = p => path.relative(process.cwd(), p);

const good = (over = {}) => ({
    schemaVersion: 1,
    source: 'runtime-be',
    observations: [{ key: 'myFlag', env: 'prod', enabled: true }],
    ...over,
});

describe('validatePayload', () => {
    test('groups observations by key and env', () => {
        const r = validatePayload(good({ observations: [
            { key: 'a', env: 'test', enabled: true },
            { key: 'a', env: 'prod', enabled: false },
            { key: 'b', env: 'qa', enabled: true },
        ] }), 'svc');

        assert.equal(r.source, 'runtime-be');
        assert.deepEqual(r.valuesByKey, { a: { test: true, prod: false }, b: { qa: true } });
    });

    test('accepts a payload naming the same component', () => {
        assert.doesNotThrow(() => validatePayload(good({ component: 'svc' }), 'svc'));
    });

    for (const [name, payload, pattern] of [
        ['non-object', [], /JSON object/],
        ['wrong schemaVersion', good({ schemaVersion: 2 }), /schemaVersion/],
        ['other component', good({ component: 'evil' }), /does not match/],
        ['bad source', good({ source: 'nope' }), /source must be/],
        ['observations not array', good({ observations: {} }), /must be an array/],
        ['too many', good({ observations: Array.from({ length: 5001 }, () => ({})) }), /too many/],
        ['non-object observation', good({ observations: [1] }), /must be an object/],
        ['proto key', good({ observations: [{ key: '__proto__', env: 'test', enabled: true }] }), /valid flag key/],
        ['weird key', good({ observations: [{ key: 'a b', env: 'test', enabled: true }] }), /valid flag key/],
        ['bad env', good({ observations: [{ key: 'a', env: 'staging', enabled: true }] }), /env must be/],
        ['non-boolean', good({ observations: [{ key: 'a', env: 'test', enabled: 'true' }] }), /boolean/],
        ['conflict', good({ observations: [
            { key: 'a', env: 'test', enabled: true }, { key: 'a', env: 'test', enabled: false },
        ] }), /conflicting/],
    ]) {
        test(`rejects ${name}`, () => {
            assert.throws(() => validatePayload(payload, 'svc'), pattern);
        });
    }
});

describe('ingest-flags.js', () => {
    before(() => fs.mkdirSync(ROOT, { recursive: true }));
    after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

    function run(name, payload, env = {}) {
        const dir = path.join(ROOT, name);
        fs.mkdirSync(dir, { recursive: true });
        const payloadPath = path.join(dir, 'payload.json');
        fs.writeFileSync(payloadPath, JSON.stringify(payload));
        const paths = {
            PAYLOAD_PATH: rel(payloadPath),
            FLAG_STATES_PATH: rel(path.join(dir, 'states.json')),
            FLAG_STATE_HISTORY_PATH: rel(path.join(dir, 'history.json')),
            FLAGS_META_PATH: rel(path.join(dir, 'meta.json')),
            FLAG_INGEST_META_PATH: rel(path.join(dir, 'ingest-meta.json')),
        };
        const res = spawnSync(process.execPath, [SCRIPT], {
            env: { ...process.env, COMPONENT: 'svc', ...paths, ...env },
            encoding: 'utf8',
        });
        const read = f => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);

        return { res, states: read('states.json'), meta: read('meta.json'), ingestMeta: read('ingest-meta.json'), history: read('history.json'), paths };
    }

    test('writes state, meta and history, then is idempotent', () => {
        const first = run('ok', good());

        assert.equal(first.res.status, 0, first.res.stderr);
        assert.equal(first.states.myFlag.prod['runtime-be'].component, 'svc');
        assert.equal(first.states.myFlag.prod['runtime-be'].changedBy, 'ingest-flags-bot');
        assert.deepEqual(first.meta.myFlag.components, ['svc']);
        assert.equal(first.history.length, 1);
        assert.deepEqual(first.ingestMeta.svc, { lastMessageDay: new Date().toISOString().slice(0, 10), source: 'runtime-be' });
        assert.match(first.res.stdout, /Ingested 1 runtime-be flag\(s\) for svc; 1 state\(s\) changed/);

        const again = spawnSync(process.execPath, [SCRIPT], {
            env: { ...process.env, COMPONENT: 'svc', ...first.paths }, encoding: 'utf8',
        });
        const history = JSON.parse(fs.readFileSync(first.paths.FLAG_STATE_HISTORY_PATH, 'utf8'));

        assert.equal(again.status, 0, again.stderr);
        assert.match(again.stdout, /0 state\(s\) changed/);
        assert.equal(history.length, 1);
    });

    test('fails without COMPONENT, without PAYLOAD_PATH, and on an invalid payload', () => {
        assert.equal(run('nocomp', good(), { COMPONENT: '' }).res.status, 1);
        assert.equal(run('nopath', good(), { PAYLOAD_PATH: '' }).res.status, 1);

        const bad = run('bad', good({ component: 'evil' }));

        assert.equal(bad.res.status, 1);
        assert.match(bad.res.stderr, /Invalid flag payload/);
        assert.equal(bad.states, null);
    });

    test('rejects an unsafe PAYLOAD_PATH', () => {
        assert.equal(run('unsafe', good(), { PAYLOAD_PATH: '../x.json' }).res.status, 1);
    });
});
