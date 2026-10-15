const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { applyObservations } = require('../scripts/lib/flag-ingest');

const NOW = '2026-10-13T10:00:00.000Z';
const base = (over = {}) => ({
    flagStates: {},
    flagsMeta: {},
    valuesByKey: { f: { test: true, prod: false } },
    component: 'svc-a',
    source: 'runtime-be',
    changedBy: 'bot',
    now: NOW,
    ...over,
});

describe('applyObservations', () => {
    test('writes states, scaffolds meta and reports history for new flags', () => {
        const args = base();
        const r = applyObservations(args);

        assert.equal(r.changedCount, 2);
        assert.deepEqual(args.flagStates.f.test['runtime-be'], { enabled: true, changedAt: NOW, changedBy: 'bot', component: 'svc-a' });
        assert.equal(args.flagStates.f.qa, undefined);
        assert.deepEqual(args.flagsMeta.f, {
            description: 'TODO — describe this flag', source: 'runtime-be', jiraKeys: [], components: ['svc-a'], createdAt: NOW,
        });
        assert.deepEqual(r.scaffolded, ['f']);
        assert.equal(r.metaChanged, true);
        assert.equal(r.historyEntries.length, 2);
    });

    test('is idempotent: a second identical run changes nothing', () => {
        const args = base();
        applyObservations(args);
        const r = applyObservations({ ...args, now: '2026-10-14T00:00:00.000Z' });

        assert.equal(r.changedCount, 0);
        assert.equal(r.metaChanged, false);
        assert.deepEqual(r.historyEntries, []);
        assert.equal(args.flagStates.f.test['runtime-be'].changedAt, NOW);
    });

    test('skips a key owned by another component and reports the collision', () => {
        const args = base({ flagStates: { f: { test: { 'runtime-be': { enabled: false, changedAt: 'x', changedBy: 'y', component: 'svc-b' } } } } });
        const r = applyObservations(args);

        assert.deepEqual(r.collisions, [{ key: 'f', existingOwner: 'svc-b', attemptedBy: 'svc-a' }]);
        assert.equal(r.changedCount, 0);
        assert.equal(args.flagsMeta.f, undefined);
        assert.equal(args.flagStates.f.test['runtime-be'].enabled, false);
    });

    test('unions components and corrects meta source; claims an untagged existing entry', () => {
        const args = base({
            flagsMeta: { f: { source: 'build', components: ['other'] } },
            correctMetaSource: true,
            flagStates: { f: { test: { 'runtime-be': { enabled: true, changedAt: 'x', changedBy: 'y' } } } },
        });
        const r = applyObservations(args);

        assert.equal(args.flagsMeta.f.source, 'runtime-be');
        assert.deepEqual(args.flagsMeta.f.components, ['other', 'svc-a']);
        assert.equal(args.flagStates.f.test['runtime-be'].component, 'svc-a');
        assert.equal(r.changedCount, 1);
    });

    test("leaves an existing meta source alone by default", () => {
        const args = base({ flagsMeta: { f: { source: "runtime-be", components: ["svc-a"] } }, source: "build" });
        const r = applyObservations(args);

        assert.equal(args.flagsMeta.f.source, "runtime-be");
        assert.deepEqual(r.scaffolded, []);
        assert.equal(r.metaChanged, false);
    });
});
