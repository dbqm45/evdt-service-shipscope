// The public status page (GET /status, GET /status.json; ROADMAP, Niezawodność; targets in server/SLO.pl.md): is
// ShipScope's background work running, and how it went in the last STATUS_DAYS days. The components are the checks of
// judgeWorker() (lib/worker-status.js); the web service judges them once a minute (sampleStatus(), web.js) and counts
// each outcome per component and day (migration 035). No tenant data, no error text: fixed labels and counts only.
// Whether the web service itself answers is for an outside monitor: a page that does not load says it.

const STATUS_DAYS = 90;
const STATUS_DAYS_KEPT = 120;
const COMPONENTS = [
    { id: 'heartbeat', label: 'Background worker', help: 'Runs every sync and check below' },
    { id: 'deployments', label: 'GitHub deployments', help: 'New deployments appear within a sync interval' },
    { id: 'jira', label: 'Jira issues', help: 'Issue status and sprints stay current' },
    { id: 'flags', label: 'Feature flags from endpoints', help: 'Flags ShipScope reads itself are read on time' },
    { id: 'webhookQueue', label: 'Webhook processing', help: 'Pushes from GitHub and Jira are picked up within minutes' },
];
const STATE_OF = { ok: 'operational', warn: 'degraded', fail: 'outage' };

/**
 * Counts one judgement of the worker (workerHealth()) for today, and drops days older than STATUS_DAYS_KEPT.
 *
 * @param {import('pg').Pool} pool
 * @param {{ health: { checks: Object<string, { status: 'ok'|'warn'|'fail' }> }, now?: Date }} input
 * @returns {Promise<void>}
 */
async function sampleStatus(pool, { health, now = new Date() }) {
    const day = now.toISOString().slice(0, 10);
    for (const { id } of COMPONENTS) {
        const check = health.checks[id];
        if (!check) continue;
        const column = check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'degraded' : 'down';
        await pool.query(
            `INSERT INTO status_samples (day, component, ${column}) VALUES ($1, $2, 1)
             ON CONFLICT (day, component) DO UPDATE SET ${column} = status_samples.${column} + 1`,
            [day, id]
        );
    }
    await pool.query('DELETE FROM status_samples WHERE day < $1::date - $2::int', [day, STATUS_DAYS_KEPT]);
}

/**
 * The page's model: each component's current state and its last `days` days. A day's state is its worst share: an
 * outage when more than 1% of its samples were down, degraded when any were not ok, else operational; `null` without
 * samples. Uptime counts degraded as up (work is done, some tenants' part failed).
 *
 * @param {{ health: { status: string, checks: Object<string, { status: string }> }|null, rows: Array<{ day: string|Date, component: string, ok: number, degraded: number, down: number }>, now: Date, days?: number }} input
 * @returns {{ overall: 'operational'|'degraded'|'outage'|'unknown', components: Array<{ id: string, label: string, help: string, state: string, uptime: number|null, days: Array<{ day: string, state: string|null, ok: number, degraded: number, down: number }> }> }}
 */
function statusModel({ health, rows, now, days = STATUS_DAYS }) {
    const dayKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    const byKey = new Map(rows.map((r) => [`${dayKey(r.day)}|${r.component}`, r]));
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) dayList.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
    const components = COMPONENTS.filter(({ id }) => !health || health.checks[id]).map((c) => {
        const series = dayList.map((day) => {
            const r = byKey.get(`${day}|${c.id}`);
            if (!r) return { day, state: null, ok: 0, degraded: 0, down: 0 };
            const total = r.ok + r.degraded + r.down;
            const state = r.down / total > 0.01 ? 'outage' : r.down + r.degraded > 0 ? 'degraded' : 'operational';
            return { day, state, ok: r.ok, degraded: r.degraded, down: r.down };
        });
        const total = series.reduce((n, d) => n + d.ok + d.degraded + d.down, 0);
        const up = series.reduce((n, d) => n + d.ok + d.degraded, 0);
        const check = health && health.checks[c.id];
        return { ...c, state: check ? STATE_OF[check.status] || 'unknown' : 'unknown', uptime: total ? up / total : null, days: series };
    });
    const states = components.map((c) => c.state);
    const overall = !health ? 'unknown' : states.includes('outage') ? 'outage' : states.includes('degraded') ? 'degraded' : 'operational';
    return { overall, components };
}

/**
 * Reads the samples of the last `days` days.
 *
 * @param {import('pg').Pool} pool
 * @param {{ now?: Date, days?: number }} [input]
 * @returns {Promise<Array<{ day: Date, component: string, ok: number, degraded: number, down: number }>>}
 */
async function readStatusSamples(pool, { now = new Date(), days = STATUS_DAYS } = {}) {
    const { rows } = await pool.query(
        "SELECT day::text AS day, component, ok, degraded, down FROM status_samples WHERE day > $1::date - $2::int ORDER BY day",
        [now.toISOString().slice(0, 10), days]
    );
    return rows;
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WORDS = { operational: 'Operational', degraded: 'Degraded', outage: 'Outage', unknown: 'Unknown' };
const HEADLINES = {
    operational: 'All systems operational',
    degraded: 'Some background work is degraded',
    outage: 'Part of ShipScope is down',
    unknown: 'Status unknown: the database could not be read',
};

/**
 * The HTML page: no script, inline styles only (the pages' Content-Security-Policy allows them), light and dark.
 *
 * @param {ReturnType<typeof statusModel> & { version: string, now: Date }} model
 * @returns {string}
 */
function renderStatusPage({ overall, components, version, now }) {
    const pct = (u) => (u === null ? 'no data' : `${(Math.floor(u * 10000) / 100).toFixed(2)}% uptime`);
    const bar = (d) => `<span class="d ${d.state || 'none'}" title="${escape(`${d.day}: ${d.state ? WORDS[d.state] : 'no data'}`)}"></span>`;
    const rows = components.map((c) => `<section class="c">
  <div class="h"><div><strong>${escape(c.label)}</strong><small>${escape(c.help)}</small></div><span class="s ${c.state}">${WORDS[c.state]}</span></div>
  <div class="bars" aria-label="${escape(`${c.label}, last ${c.days.length} days`)}">${c.days.map(bar).join('')}</div>
  <div class="f"><span>${c.days.length} days ago</span><span>${pct(c.uptime)}</span><span>Today</span></div>
</section>`).join('\n');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ShipScope status</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#15171a;--muted:#5c6168;--line:#d9dde2;--ok:#1a7f4b;--warn:#b26a00;--bad:#c21e1e;--none:#d2d6db}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--card:#16191d;--fg:#eceef1;--muted:#9aa0a6;--line:#2b2e33;--ok:#2fbf71;--warn:#f0a83a;--bad:#f26b6b;--none:#33373d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 48px;display:flex;flex-direction:column;gap:16px}
h1{font-size:22px;margin:0}.top{padding:18px 20px;border-radius:12px;color:#fff;font-weight:600}
.top.operational{background:var(--ok)}.top.degraded{background:var(--warn)}.top.outage{background:var(--bad)}.top.unknown{background:var(--muted)}
.c{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.h{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.h small{display:block;color:var(--muted)}
.s{font-weight:600;white-space:nowrap}.s.operational{color:var(--ok)}.s.degraded{color:var(--warn)}.s.outage{color:var(--bad)}.s.unknown{color:var(--muted)}
.bars{display:flex;gap:2px;height:28px}.d{flex:1;border-radius:2px;background:var(--none);min-width:2px}
.d.operational{background:var(--ok)}.d.degraded{background:var(--warn)}.d.outage{background:var(--bad)}
.f{display:flex;justify-content:space-between;color:var(--muted);font-size:12.5px}
footer{color:var(--muted);font-size:13px}
</style></head>
<body><main>
<h1>ShipScope status</h1>
<div class="top ${overall}">${HEADLINES[overall]}</div>
${rows}
<footer>Checked once a minute. Updated ${escape(now.toISOString().slice(0, 16).replace('T', ' '))} UTC · version ${escape(version)} · <a href="/status.json">JSON</a></footer>
</main></body></html>
`;
}

module.exports = { STATUS_DAYS, STATUS_DAYS_KEPT, COMPONENTS, sampleStatus, statusModel, readStatusSamples, renderStatusPage };
