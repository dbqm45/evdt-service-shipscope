// Unit tests for the pure flag-domain rules extracted out of lib/flags.js's readDashboardFlags() and
// ingestFlags() (design-docs/REPORT_ARCH.md, Problem 2 / priority E) — no db/pg, no withScope, so these run
// without a Postgres connection, unlike the end-to-end tests in flags.test.js/flag-links.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    slotOf, enabledFrom, mergeJiraKeys, sameValue, planIngestWrites, sourceDescriptors, pickWinningValues, visibleFlagsMeta, historyRecords,
    isReservedKey,
} = require('../lib/flags-logic');

test('isReservedKey: every name an object already has, plus prototype; ordinary keys pass', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', 'isPrototypeOf']) {
        assert.equal(isReservedKey(key), true, key);
    }
    for (const key of ['newCheckout', 'to_string', 'proto', 'Constructor', 'value.of']) assert.equal(isReservedKey(key), false, key);
});

test('a reserved key stored before the check is skipped on the way out, and no built-in is changed', () => {
    const sources = new Map([['s', { name: 'S', slot: 'build', priority: 0, component: 'web' }]]);
    const row = (key) => ({ source_id: 's', key, environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), changed_by: 'x' });
    const winners = pickWinningValues([row('toString'), row('valueOf'), row('ok')], sources);
    assert.deepEqual(Object.keys(winners.flagStates), ['ok']);
    assert.deepEqual([...winners.slotsOf.keys()], ['ok']);
    assert.equal(Object.hasOwn(Object.prototype.toString, 'prod'), false, 'Object.prototype.toString untouched');
    assert.equal(Object.hasOwn(Object.prototype.valueOf, 'prod'), false);
    const flag = (key) => ({ key, description: 'd', manual_description: null, jira_keys: [], manual_jira_keys: [], created_at: new Date('2026-01-01') });
    const slotsOf = new Map([['toString', new Set(['build'])], ['ok', new Set(['build'])]]);
    const componentsOf = new Map([['toString', new Set(['web'])], ['ok', new Set(['web'])]]);
    assert.deepEqual(Object.keys(visibleFlagsMeta([flag('toString'), flag('ok')], { slotsOf, componentsOf }, new Map())), ['ok']);
});

test('slotOf: runtime sources fill runtime-be, everything else fills build', () => {
    assert.equal(slotOf('runtime'), 'runtime-be');
    assert.equal(slotOf('build'), 'build');
});

test('enabledFrom: anything but off counts as enabled, including a partial rollout', () => {
    assert.equal(enabledFrom('off'), false);
    assert.equal(enabledFrom('on'), true);
    assert.equal(enabledFrom('partial'), true);
});

test('mergeJiraKeys: dedupes and sorts across several independent origins', () => {
    assert.deepEqual(mergeJiraKeys(['SHP-2', 'SHP-1'], ['SHP-1'], []), ['SHP-1', 'SHP-2']);
    assert.deepEqual(mergeJiraKeys([], [], []), []);
});

test('sameValue: equal only when state and (numeric) rollout both match', () => {
    assert.equal(sameValue({ state: 'on', rollout: null }, { state: 'on', rollout: null }), true);
    assert.equal(sameValue({ state: 'partial', rollout: '25' }, { state: 'partial', rollout: 25 }), true, 'numeric string from pg vs number');
    assert.equal(sameValue({ state: 'on', rollout: null }, { state: 'off', rollout: null }), false);
    assert.equal(sameValue({ state: 'partial', rollout: '25' }, { state: 'partial', rollout: 30 }), false);
});

test('planIngestWrites: a delayed message never undoes a newer stored value (stale, not written)', () => {
    const existing = [{ key: 'a', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-02'), removed_at: null }];
    const observations = [{ key: 'a', env: 'prod', state: 'off', rollout: null, changedAt: new Date('2026-01-01') }];
    const { writes, removals, stale } = planIngestWrites({ observations, existing, complete: true, environments: ['prod'] });
    assert.deepEqual(writes, []);
    assert.deepEqual(removals, []);
    assert.equal(stale, 1);
});

test('planIngestWrites: an identical, not-removed value is a no-op write', () => {
    const existing = [{ key: 'a', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), removed_at: null }];
    const observations = [{ key: 'a', env: 'prod', state: 'on', rollout: null, changedAt: new Date('2026-01-02') }];
    const { writes, stale } = planIngestWrites({ observations, existing, complete: true, environments: ['prod'] });
    assert.deepEqual(writes, []);
    assert.equal(stale, 0);
});

test('planIngestWrites: a changed value, and re-reporting a removed one, are both written', () => {
    const existing = [
        { key: 'a', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), removed_at: null },
        { key: 'b', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), removed_at: new Date('2026-01-02') },
    ];
    const observations = [
        { key: 'a', env: 'prod', state: 'off', rollout: null, changedAt: new Date('2026-01-02') },
        { key: 'b', env: 'prod', state: 'on', rollout: null, changedAt: new Date('2026-01-03') },
    ];
    const { writes } = planIngestWrites({ observations, existing, complete: true, environments: ['prod'] });
    assert.deepEqual(writes.map((w) => w.key).sort(), ['a', 'b']);
});

test('planIngestWrites: complete removes a covered, previously-reported key the message no longer lists', () => {
    const existing = [
        { key: 'a', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), removed_at: null },
        { key: 'b', environment: 'qa', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), removed_at: null }, // different env, not covered
        { key: 'c', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), removed_at: new Date('2026-01-01') }, // already removed
    ];
    const { removals } = planIngestWrites({ observations: [], existing, complete: true, environments: ['prod'] });
    assert.deepEqual(removals.map((r) => r.key), ['a']);
});

test('planIngestWrites: not complete (a partial-state message) never removes anything', () => {
    const existing = [{ key: 'a', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), removed_at: null }];
    const { removals } = planIngestWrites({ observations: [], existing, complete: false, environments: ['prod'] });
    assert.deepEqual(removals, []);
});

test('sourceDescriptors: resolves kind to slot and repo_id to a component name via the given lookup', () => {
    const sources = sourceDescriptors(
        [{ id: 's1', name: 'FE', kind: 'build', priority: 10, repo_id: 7 }, { id: 's2', name: 'BE', kind: 'runtime', priority: 5, repo_id: null }],
        (id) => (id === 7 ? 'evapl-service-frontend' : null)
    );
    assert.deepEqual(sources.get('s1'), { name: 'FE', slot: 'build', priority: 10, component: 'evapl-service-frontend' });
    assert.deepEqual(sources.get('s2'), { name: 'BE', slot: 'runtime-be', priority: 5, component: null });
});

test('pickWinningValues: highest priority wins; a tie goes to the later changed_at', () => {
    const sources = new Map([
        ['low', { name: 'Low', slot: 'build', priority: 0, component: 'a' }],
        ['high', { name: 'High', slot: 'build', priority: 10, component: 'b' }],
        ['tie-early', { name: 'TieEarly', slot: 'build', priority: 5, component: null }],
        ['tie-late', { name: 'TieLate', slot: 'build', priority: 5, component: null }],
    ]);
    const values = [
        { source_id: 'low', key: 'f', environment: 'prod', state: 'off', rollout: null, changed_at: new Date('2026-01-03'), changed_by: 'low' },
        { source_id: 'high', key: 'f', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), changed_by: 'high' },
    ];
    const { flagStates } = pickWinningValues(values, sources);
    assert.equal(flagStates.f.prod.build.sourceName, 'High', 'highest priority wins even with an older changed_at');

    const tieValues = [
        { source_id: 'tie-early', key: 'g', environment: 'prod', state: 'off', rollout: null, changed_at: new Date('2026-01-01'), changed_by: 'e' },
        { source_id: 'tie-late', key: 'g', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-02'), changed_by: 'l' },
    ];
    assert.equal(pickWinningValues(tieValues, sources).flagStates.g.prod.build.sourceName, 'TieLate', 'equal priority: later changed_at wins');
});

test('pickWinningValues: collects every component that ever reported a key, not just the winner\'s', () => {
    const sources = new Map([
        ['winner', { name: 'Winner', slot: 'build', priority: 10, component: 'comp-a' }],
        ['loser', { name: 'Loser', slot: 'build', priority: 0, component: 'comp-b' }],
    ]);
    const values = [
        { source_id: 'winner', key: 'f', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), changed_by: 'w' },
        { source_id: 'loser', key: 'f', environment: 'prod', state: 'off', rollout: null, changed_at: new Date('2026-01-01'), changed_by: 'l' },
    ];
    const { componentsOf } = pickWinningValues(values, sources);
    assert.deepEqual([...componentsOf.get('f')].sort(), ['comp-a', 'comp-b']);
});

test('pickWinningValues: build and runtime-be slots for the same key/env coexist independently', () => {
    const sources = new Map([
        ['be', { name: 'BE', slot: 'build', priority: 0, component: null }],
        ['rt', { name: 'RT', slot: 'runtime-be', priority: 0, component: null }],
    ]);
    const values = [
        { source_id: 'be', key: 'f', environment: 'prod', state: 'off', rollout: null, changed_at: new Date('2026-01-01'), changed_by: 'be' },
        { source_id: 'rt', key: 'f', environment: 'prod', state: 'on', rollout: null, changed_at: new Date('2026-01-01'), changed_by: 'rt' },
    ];
    const { flagStates } = pickWinningValues(values, sources);
    assert.equal(flagStates.f.prod.build.enabled, false);
    assert.equal(flagStates.f.prod['runtime-be'].enabled, true);
});

test('visibleFlagsMeta: a flag no source reports any more (no winning slot) is not shown', () => {
    const flags = [
        { key: 'live', description: 'd', manual_description: null, jira_keys: [], manual_jira_keys: [], created_at: new Date('2026-01-01') },
        { key: 'gone', description: 'd', manual_description: null, jira_keys: [], manual_jira_keys: [], created_at: new Date('2026-01-01') },
    ];
    const slotsOf = new Map([['live', new Set(['build'])]]); // 'gone' has no entry at all
    const componentsOf = new Map([['live', new Set(['comp-a'])]]);
    const meta = visibleFlagsMeta(flags, { slotsOf, componentsOf }, new Map());
    assert.deepEqual(Object.keys(meta), ['live']);
});

test('visibleFlagsMeta: source is runtime-be whenever any winning slot is runtime-be, else build', () => {
    const flags = [{ key: 'f', description: 'd', manual_description: null, jira_keys: [], manual_jira_keys: [], created_at: new Date('2026-01-01') }];
    const componentsOf = new Map([['f', new Set()]]);
    const buildOnly = visibleFlagsMeta(flags, { slotsOf: new Map([['f', new Set(['build'])]]), componentsOf }, new Map());
    assert.equal(buildOnly.f.source, 'build');
    const both = visibleFlagsMeta(flags, { slotsOf: new Map([['f', new Set(['build', 'runtime-be'])]]), componentsOf }, new Map());
    assert.equal(both.f.source, 'runtime-be');
});

test('visibleFlagsMeta: description prefers the manual one, and jiraKeys merge sender + manual + Jira-derived', () => {
    const flags = [{
        key: 'f', description: 'sender desc', manual_description: 'manual desc',
        jira_keys: ['SHP-1'], manual_jira_keys: ['SHP-2'], created_at: new Date('2026-01-01'),
    }];
    const componentsOf = new Map([['f', new Set()]]);
    const meta = visibleFlagsMeta(flags, { slotsOf: new Map([['f', new Set(['build'])]]), componentsOf }, new Map([['f', ['SHP-3']]]));
    assert.equal(meta.f.description, 'manual desc');
    assert.deepEqual(meta.f.jiraKeys, ['SHP-1', 'SHP-2', 'SHP-3']);
});

test('historyRecords: maps source_id to its slot and state to enabled', () => {
    const sources = new Map([['s1', { slot: 'runtime-be' }]]);
    const history = [{ source_id: 's1', key: 'f', environment: 'prod', state: 'partial', changed_at: new Date('2026-01-01T00:00:00Z'), changed_by: 'x' }];
    assert.deepEqual(historyRecords(history, sources), [
        { key: 'f', env: 'prod', source: 'runtime-be', enabled: true, changedAt: '2026-01-01T00:00:00.000Z', changedBy: 'x' },
    ]);
});
