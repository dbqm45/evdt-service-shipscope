const { checkConnection } = require('../lib/db');
const { APP_VERSION } = require('../lib/version');
const crypto = require('crypto');
const { workerHealth } = require('../lib/worker-status');
const { renderMetrics, readWorkerMetrics } = require('../lib/metrics');

/**
 * `/health`, `/health/db` and `/health/worker` — the only routes that exist without an `auth` config (CLAUDE.md's
 * deploy-pipeline proof: GET /health, GET /health/db). `/health/worker` is for an uptime monitor: 503 when the
 * worker stopped (no heartbeat), a sync has not succeeded for three intervals or the webhook queue is not drained;
 * 200 with `degraded` when syncs run but some tenants' fail. Ages and counts only, never tenant data or error text.
 *
 * @param {import('fastify').FastifyInstance} app
 *
 * `/metrics` (lib/metrics.js) exists only with METRICS_TOKEN set, and answers only `Authorization: Bearer <it>`.
 *
 * @param {{ pool: import('pg').Pool, expectWorker: { deployments: boolean, jira: boolean, flags?: boolean }, syncIntervalMinutes: number, metrics?: ReturnType<typeof import('../lib/metrics').createMetrics>, metricsToken?: string|null }} ctx
 */
function registerHealthRoutes(app, { pool, expectWorker, syncIntervalMinutes, metrics = null, metricsToken = null }) {
    app.get('/health', async () => ({ status: 'ok', version: APP_VERSION }));

    app.get('/health/db', async (request, reply) => {
        try {
            return await checkConnection(pool);
        } catch (err) {
            return reply.code(503).send({ ok: false, error: err.message });
        }
    });

    app.get('/health/worker', async (request, reply) => {
        let health;
        try {
            health = await workerHealth(pool, { expect: expectWorker, syncIntervalMinutes });
        } catch (err) {
            request.log.error({ err }, 'worker health check could not read the database');
            return reply.code(503).send({ status: 'down', checks: { database: { status: 'fail' } } });
        }
        if (health.status !== 'ok') request.log.warn({ health }, `worker health: ${health.status}`);
        return reply.code(health.status === 'down' ? 503 : 200).header('Cache-Control', 'no-store').send(health);
    });

    if (metrics && metricsToken) {
        const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
        const expected = digest(`Bearer ${metricsToken}`);
        app.get('/metrics', async (request, reply) => {
            if (!crypto.timingSafeEqual(digest(request.headers.authorization || ''), expected)) {
                return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Metrics need Authorization: Bearer <METRICS_TOKEN>' });
            }
            const { rows, queue } = await readWorkerMetrics(pool);
            const text = renderMetrics({ version: APP_VERSION, counters: metrics.snapshot(), rows, queue, now: new Date() });
            return reply.type('text/plain; version=0.0.4; charset=utf-8').header('Cache-Control', 'no-store').send(text);
        });
    }
}

module.exports = { registerHealthRoutes };
