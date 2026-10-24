// Unit tests for the pure flag-domain rules extracted out of lib/flags.js's readDashboardFlags() and
// ingestFlags() (design-docs/REPORT_ARCH.md, Problem 2 / priority E) — no db/pg, no withScope, so these run
// without a Postgres connection, unlike the end-to-end tests in flags.test.js/flag-links.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    slotOf, enabledFrom, mergeJiraKeys, sameValue, planIngestWrites, sourceDescriptors, pickWinningValues, visibleFlagsMeta, historyRecords,
    isReservedKey, freshnessOf, freshnessByComponent, STALE_AFTER_MINUTES,
} = require('../lib/flags-logic');

test('freshnessOf: error over everything newer, unknown without a confirmation, stale past the threshold', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const ago = (minutes) => new Date(now - minutes * 60_000);
    assert.equal(freshnessOf({ observedAt: null, errorAt: null, staleAfterMinutes: 60, now }), 'unknown');
    assert.equal(freshnessOf({ observedAt: ago(10), errorAt: null, staleAfterMinutes: 60, now }), 'fresh');
    assert.equal(freshnessOf({ observedAt: ago(60), errorAt: null, staleAfterMinutes: 60, now }), 'fresh', 'exactly the threshold is still fresh');
    assert.equal(freshnessOf({ observedAt: ago(61), errorAt: null, staleAfterMinutes: 60, now }), 'stale');
    assert.equal(freshnessOf({ observedAt: ago(100_000), errorAt: null, staleAfterMinutes: null, now }), 'fresh', 'no threshold: never stale');
    assert.equal(freshnessOf({ observedAt: ago(10), errorAt: ago(5), staleAfterMinutes: 60, now }), 'error');
    assert.equal(freshnessOf({ observedAt: ago(5), errorAt: ago(10), staleAfterMinutes: 60, now }), 'fresh', 'a later confirmation clears the error');
    assert.equal(freshnessOf({ observedAt: null, errorAt: ago(10), staleAfterMinutes: 60, now }), 'error');
    assert.deepEqual(STALE_AFTER_MINUTES, { runtime: 1440, build: null });
});

test('freshnessByComponent: per service and env, every covering source and the worst state with the oldest confirmation', () => {
    const at = (iso) => new Date(iso);
    const out = freshnessByComponent([
        { name: 'Code', components: ['web'], envs: [{ env: 'prod', state: 'fresh', observedAt: at('2026-10-02T10:00:00Z') }] },
        { name: 'Endpoint', components: ['web', 'api'], envs: [
            { env: 'prod', state: 'stale', observedAt: at('2026-10-01T10:00:00Z') }, { env: 'qa', state: 'error', observedAt: null },
        ] },
        { name: 'Nowhere', components: [], envs: [{ env: 'prod', state: 'error', observedAt: null }] },
    ]);
    assert.deepEqual(out.web.prod, { state: 'stale', observedAt: '2026-10-01T10:00:00.000Z', sources: [
        { name: 'Code', state: 'fresh', observedAt: '2026-10-02T10:00:00.000Z' }, { name: 'Endpoint', state: 'stale', observedAt: '2026-10-01T10:00:00.000Z' },
    ] });
    assert.deepEqual(out.api.qa, { state: 'error', observedAt: null, sources: [{ name: 'Endpoint', state: 'error', observedAt: null }] });
    assert.deepEqual(Object.keys(out).sort(), ['api', 'web'], 'a source covering no service adds nothing');
});

test('isReservedKey: every name an object already has, plus prototype; ordinary keys pass', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', 'isPrototypeOf']) {
        assert.equal(isReservedKey(key), true, key);
    }
    for (const key of ['newCheckout', 'to_string', 'proto', 'Constructor', 'value.of']) assert.equal(isReservedKey(key), false, key);
});

test('a reserved key stored before the check is skipped on the way out, and no built-in is changed', () => {
    const sources = new Map([['s', { name: 'S', slot: 'build', priority: 0, component: 'web', components: ['web'] }]]);
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

test('sourceDescriptors: resolves kind to slot and the covered repos to component names via the given lookup', () => {
    const sources = sourceDescriptors(
        [{ id: 's1', name: 'FE', kind: 'build', priority: 10 }, { id: 's2', name: 'BE', kind: 'runtime', priority: 5 }, { id: 's3', name: 'Both', kind: 'runtime', priority: 0 }],
        (id) => ({ 7: 'web', 8: 'api' })[id] || null,
        new Map([['s1', [7]], ['s3', [8, 7, 99]]])
    );
    assert.deepEqual(sources.get('s1'), { name: 'FE', kind: 'build', slot: 'build', priority: 10, component: 'web', components: ['web'] });
    assert.deepEqual(sources.get('s2'), { name: 'BE', kind: 'runtime', slot: 'runtime-be', priority: 5, component: null, components: [] });
    assert.deepEqual(sources.get('s3').components, ['api', 'web'], 'sorted, an untracked repo (99) dropped');
});

test('pickWinningValues byComponent: one state per service; runtime over build inside a service, never across', () => {
    const sources = new Map([
        ['fe-code', { name: 'FE code', kind: 'build', slot: 'build', priority: 10, component: 'web', components: ['web'] }],
        ['be-endpoint', { name: 'BE endpoint', kind: 'runtime', slot: 'runtime-be', priority: 0, component: 'api', components: ['api'] }],
        ['web-runtime', { name: 'Web runtime', kind: 'runtime', slot: 'runtime-be', priority: 0, component: 'web', components: ['web'] }],
        ['unscoped', { name: 'Loose', kind: 'build', slot: 'build', priority: 99, component: null, components: [] }],
    ]);
    const at = new Date('2026-01-01');
    const v = (source_id, environment, state, rollout = null) => ({ source_id, key: 'checkout', environment, state, rollout, changed_at: at, changed_by: source_id });
    const { byComponent, flagStates } = pickWinningValues([
        v('fe-code', 'prod', 'on'), v('be-endpoint', 'prod', 'off'), v('unscoped', 'prod', 'on'),
        v('fe-code', 'qa', 'on'), v('web-runtime', 'qa', 'partial', 25),
    ], sources);
    assert.equal(byComponent.checkout.prod.web.state, 'on', 'the FE keeps its own value');
    assert.equal(byComponent.checkout.prod.api.state, 'off', 'the BE value does not leak into the FE');
    assert.equal(byComponent.checkout.prod.api.enabled, false);
    assert.deepEqual(Object.keys(byComponent.checkout.prod).sort(), ['api', 'web'], 'a source covering no service adds nothing');
    const qa = byComponent.checkout.qa.web;
    assert.deepEqual([qa.state, qa.rollout, qa.enabled, qa.sourceName, qa.kind], ['partial', 25, false, 'Web runtime', 'runtime'], 'runtime wins; partial is not enabled');
    assert.deepEqual(qa.overridden, [{ sourceName: 'FE code', kind: 'build', state: 'on' }]);
    assert.equal(flagStates.checkout.prod.build.sourceName, 'Loose', 'the legacy slots keep their old rule');
});

test('pickWinningValues: highest priority wins; a tie goes to the later changed_at', () => {
    const sources = new Map([
        ['low', { name: 'Low', slot: 'build', priority: 0, component: 'a', components: ['a'] }],
        ['high', { name: 'High', slot: 'build', priority: 10, component: 'b', components: ['b'] }],
        ['tie-early', { name: 'TieEarly', slot: 'build', priority: 5, component: null, components: [] }],
        ['tie-late', { name: 'TieLate', slot: 'build', priority: 5, component: null, components: [] }],
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
        ['winner', { name: 'Winner', slot: 'build', priority: 10, component: 'comp-a', components: ['comp-a'] }],
        ['loser', { name: 'Loser', slot: 'build', priority: 0, component: 'comp-b', components: ['comp-b'] }],
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
        ['be', { name: 'BE', slot: 'build', priority: 0, component: null, components: [] }],
        ['rt', { name: 'RT', slot: 'runtime-be', priority: 0, component: null, components: [] }],
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
