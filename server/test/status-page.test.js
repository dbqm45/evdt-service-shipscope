// The public status page (lib/status-page.js, migration 035, server/SLO.pl.md): components from judgeWorker(), one
// sample a minute per component and day, 90 days of bars, no script and no tenant data.
const { test } = require('node:test');
const assert = require('node:assert');
const { createTestDb } = require('./helpers/test-db');
const { AUTH } = require('./helpers/auth');
const { buildApp } = require('../web');
const { recordRun, workerHealth } = require('../lib/worker-status');
const { sampleStatus, statusModel, readStatusSamples, renderStatusPage, STATUS_DAYS } = require('../lib/status-page');

const NOW = new Date('2026-10-25T12:00:00Z');

test('statusModel: each day by its worst share, uptime counting degraded as up, current state from the checks', () => {
    const health = { status: 'degraded', checks: { heartbeat: { status: 'ok' }, deployments: { status: 'warn' } } };
    const rows = [
        { day: '2026-10-25', component: 'heartbeat', ok: 700, degraded: 0, down: 0 },
        { day: '2026-10-24', component: 'heartbeat', ok: 1400, degraded: 0, down: 40 },   // 2.8% down: outage
        { day: '2026-10-23', component: 'heartbeat', ok: 1435, degraded: 0, down: 5 },    // 0.35% down: degraded
        { day: '2026-10-25', component: 'deployments', ok: 600, degraded: 100, down: 0 },
        { day: '2026-01-01', component: 'heartbeat', ok: 99, degraded: 0, down: 0 },      // outside the window
    ];
    const model = statusModel({ health, rows, now: NOW });
    assert.strictEqual(model.overall, 'degraded');
    assert.deepStrictEqual(model.components.map((c) => [c.id, c.state]), [['heartbeat', 'operational'], ['deployments', 'degraded']], 'only the checks this server runs');
    const heartbeat = model.components[0];
    assert.strictEqual(heartbeat.days.length, STATUS_DAYS);
    assert.deepStrictEqual(heartbeat.days.slice(-3).map((d) => d.state), ['degraded', 'outage', 'operational']);
    assert.strictEqual(heartbeat.days[0].state, null, 'no samples: no data');
    assert.strictEqual(heartbeat.uptime, (700 + 1400 + 1435) / (700 + 1440 + 1440));
    assert.strictEqual(model.components[1].uptime, 1, 'degraded is still up');
    assert.strictEqual(statusModel({ health: null, rows: [], now: NOW }).overall, 'unknown', 'the database could not be read');
});

test('renderStatusPage: one section per component, bars per day, no script', () => {
    const model = statusModel({ health: { status: 'down', checks: { heartbeat: { status: 'fail' } } }, rows: [], now: NOW });
    const page = renderStatusPage({ ...model, version: '0.2.45', now: NOW });
    assert.match(page, /<div class="top outage">Part of ShipScope is down<\/div>/);
    assert.match(page, /<strong>Background worker<\/strong>.*<span class="s outage">Outage<\/span>/s);
    assert.strictEqual((page.match(/class="d /g) || []).length, STATUS_DAYS);
    assert.match(page, /no data/);
    assert.doesNotMatch(page, /<script/i);
    assert.match(page, /Updated 2026-10-25 12:00 UTC · version 0\.2\.45/);
});

test('GET /status and /status.json: public, from the samples; the sampler counts per day and drops old days', async (t) => {
    const { pool, teardown } = await createTestDb();
    t.after(teardown);
    const app = buildApp({ pool, auth: AUTH });
    t.after(() => app.close());

    await recordRun(pool, { job: 'heartbeat', ok: true });
    const health = await workerHealth(pool, { expect: { deployments: false, jira: false, flags: false }, syncIntervalMinutes: 15 });
    await sampleStatus(pool, { health });
    await sampleStatus(pool, { health });
    await sampleStatus(pool, { health: { checks: { heartbeat: { status: 'fail' } } } });
    await sampleStatus(pool, { health, now: new Date(Date.now() - 200 * 86_400_000) });
    await sampleStatus(pool, { health }); // drops the 200-day-old one
    const rows = await readStatusSamples(pool, { days: 400 });
    assert.deepStrictEqual(rows.map((r) => [r.component, r.ok, r.down]), [['heartbeat', 3, 1]]);

    const page = await app.inject({ method: 'GET', url: '/status' });
    assert.strictEqual(page.statusCode, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.body, /All systems operational/);
    assert.match(page.body, /75\.00% uptime/);
    const json = (await app.inject({ method: 'GET', url: '/status.json' })).json();
    assert.strictEqual(json.status, 'operational');
    assert.deepStrictEqual(json.components.map((c) => [c.id, c.status, c.uptime]), [['heartbeat', 'operational', 0.75]]);
    assert.strictEqual(json.components[0].days.at(-1).status, 'outage', 'a quarter of today down');
});
