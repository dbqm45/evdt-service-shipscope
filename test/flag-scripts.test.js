'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeTmp, rmTmp, runScript, write, readJ, exists } = require('./flag-scripts-helpers');

let tmp;

before(() => { tmp = makeTmp('meta'); });
after(() => rmTmp(tmp));

describe('fill-flag-metadata.js', () => {
    const base = { FLAG_KEY: 'myFlag', SOURCE: 'build', JIRA_KEYS: 'A-1, B-2 ,', COMPONENTS: 'c1,c2', FLAGS_META_PATH: 'fill/meta.json' };

    test('rejects missing / invalid input', () => {
        assert.equal(runScript('fill-flag-metadata.js', { ...base, FLAG_KEY: '' }, tmp).code, 1);
        assert.match(runScript('fill-flag-metadata.js', { ...base, SOURCE: '' }, tmp).err, /Missing SOURCE/);
        assert.match(runScript('fill-flag-metadata.js', { ...base, SOURCE: 'x' }, tmp).err, /Invalid SOURCE/);
        assert.match(runScript('fill-flag-metadata.js', { ...base, JIRA_KEYS: ' , ' }, tmp).err, /JIRA_KEYS/);
        assert.match(runScript('fill-flag-metadata.js', { ...base, COMPONENTS: '' }, tmp).err, /COMPONENTS/);
        assert.match(runScript('fill-flag-metadata.js', { ...base, FLAGS_META_PATH: '../x.json' }, tmp).err, /not a safe relative path/);
        assert.equal(exists(tmp, 'fill/meta.json'), false);
    });

    test('creates, then updates preserving createdAt and description', () => {
        write(tmp, 'fill/.keep', '');
        const r1 = runScript('fill-flag-metadata.js', { ...base, DESCRIPTION: 'first' }, tmp);

        assert.equal(r1.code, 0);
        assert.match(r1.out, /Created metadata/);
        const m1 = readJ(tmp, 'fill/meta.json').myFlag;

        assert.deepEqual(m1.jiraKeys, ['A-1', 'B-2']);
        assert.deepEqual(m1.components, ['c1', 'c2']);
        assert.equal(m1.description, 'first');
        assert.ok(m1.createdAt);

        const r2 = runScript('fill-flag-metadata.js', { ...base, SOURCE: 'runtime-be', COMPONENTS: 'c3' }, tmp);

        assert.match(r2.out, /Updated metadata/);
        const m2 = readJ(tmp, 'fill/meta.json').myFlag;

        assert.equal(m2.description, 'first');
        assert.equal(m2.source, 'runtime-be');
        assert.deepEqual(m2.components, ['c3']);
        assert.equal(m2.createdAt, m1.createdAt);
    });

    test('default description for a brand-new flag without DESCRIPTION', () => {
        runScript('fill-flag-metadata.js', { ...base, FLAG_KEY: 'other' }, tmp);
        assert.equal(readJ(tmp, 'fill/meta.json').other.description, 'No description provided');
    });
});

describe('scaffold-flags-meta.js + check-flags-metadata.js', () => {
    const env = { FLAGS_META_PATH: 'sc/meta.json', FLAGS_SEARCH_ROOT: 'sc/domains', COMPONENT: 'comp-a' };

    test('no generated files: both are no-ops', () => {
        assert.match(runScript('scaffold-flags-meta.js', env, tmp).out, /nothing to scaffold/);
        assert.match(runScript('check-flags-metadata.js', env, tmp).out, /nothing to check/);
        assert.equal(exists(tmp, 'sc/meta.json'), false);
    });

    test('scaffold creates stubs, is idempotent; check fails then warns', () => {
        write(tmp, 'sc/domains/a/x.generated.ts', 'export const F = { alpha: true, beta: false };');
        write(tmp, 'sc/domains/node_modules/skip.generated.ts', 'export const F = { nope: true };');

        const missing = runScript('check-flags-metadata.js', env, tmp);

        assert.equal(missing.code, 1);
        assert.match(missing.err, /Could not find flags-meta.json/);

        const s1 = runScript('scaffold-flags-meta.js', env, tmp);

        assert.equal(s1.code, 0);
        assert.match(s1.out, /Scaffolded 2 new flag\(s\): alpha, beta/);
        const meta = readJ(tmp, 'sc/meta.json');

        assert.deepEqual(Object.keys(meta), ['alpha', 'beta']);
        assert.deepEqual(meta.alpha.components, ['comp-a']);
        assert.equal(meta.nope, undefined);

        const snapshot = JSON.stringify(meta);
        const s2 = runScript('scaffold-flags-meta.js', env, tmp);

        assert.match(s2.out, /No new flags found/);
        assert.equal(JSON.stringify(readJ(tmp, 'sc/meta.json')), snapshot);

        const fail = runScript('check-flags-metadata.js', env, tmp);

        assert.equal(fail.code, 1);
        assert.match(fail.err, /"alpha"/);
        assert.match(fail.err, /jiraKeys" is empty/);
        assert.match(fail.err, /YOUR_ORG/);

        const warn = runScript('check-flags-metadata.js', { ...env, WARN_ONLY: 'true', STATUS_REPO_EDIT_URL: 'http://edit' }, tmp);

        assert.equal(warn.code, 0);
        assert.match(warn.err, /::warning::Flag metadata check found 2 problem/);
        assert.match(warn.err, /http:\/\/edit/);
        assert.doesNotMatch(warn.err, /before merging/);
    });

    test('check reports each kind of problem, then passes when complete', () => {
        write(tmp, 'sc/meta.json', {
            alpha: { source: 'build', jiraKeys: ['A-1'], components: [] },
            beta: { jiraKeys: ['A-1'], components: ['c'] },
        });
        write(tmp, 'sc/domains/b/y.generated.ts', 'export const G = { gamma: true };');
        const r = runScript('check-flags-metadata.js', env, tmp);

        assert.equal(r.code, 1);
        assert.match(r.err, /"alpha".*"components" is empty/);
        assert.match(r.err, /"beta".*missing "source"/);
        assert.match(r.err, /"gamma".*missing entirely/);

        const full = { source: 'build', jiraKeys: ['A-1'], components: ['c'] };

        write(tmp, 'sc/meta.json', { alpha: full, beta: full, gamma: full });
        const ok = runScript('check-flags-metadata.js', env, tmp);

        assert.equal(ok.code, 0);
        assert.match(ok.out, /All 3 flags have complete metadata/);
    });

    test('scaffold without COMPONENT leaves components empty', () => {
        write(tmp, 'sc2/d/z.generated.ts', 'export const Z = { zed: true };');
        runScript('scaffold-flags-meta.js', { FLAGS_META_PATH: 'sc2/m.json', FLAGS_SEARCH_ROOT: 'sc2' }, tmp);
        assert.deepEqual(readJ(tmp, 'sc2/m.json').zed.components, []);
    });

    test('unsafe paths are rejected', () => {
        assert.equal(runScript('scaffold-flags-meta.js', { FLAGS_SEARCH_ROOT: '../x' }, tmp).code, 1);
        assert.equal(runScript('check-flags-metadata.js', { FLAGS_META_PATH: '../x' }, tmp).code, 1);
    });
});

describe('record-full-sync.js', () => {
    test('stamps lastFullSync, preserves other keys', () => {
        write(tmp, 'sync/meta.json', { other: 1 });
        const r = runScript('record-full-sync.js', { SYNC_META_PATH: 'sync/meta.json' }, tmp);

        assert.equal(r.code, 0);
        assert.match(r.out, /Recorded full sync at/);
        const m = readJ(tmp, 'sync/meta.json');

        assert.equal(m.other, 1);
        assert.ok(!Number.isNaN(Date.parse(m.lastFullSync)));
    });

    test('creates the file when absent; rejects unsafe path', () => {
        write(tmp, 'sync2/.keep', '');
        assert.equal(runScript('record-full-sync.js', { SYNC_META_PATH: 'sync2/meta.json' }, tmp).code, 0);
        assert.ok(readJ(tmp, 'sync2/meta.json').lastFullSync);
        assert.equal(runScript('record-full-sync.js', { SYNC_META_PATH: '/abs/x.json' }, tmp).code, 1);
    });
});
