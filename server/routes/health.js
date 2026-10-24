const { checkConnection } = require('../lib/db');
const { APP_VERSION } = require('../lib/version');
const { workerHealth } = require('../lib/worker-status');

/**
 * `/health`, `/health/db` and `/health/worker` — the only routes that exist without an `auth` config (CLAUDE.md's
 * deploy-pipeline proof: GET /health, GET /health/db). `/health/worker` is for an uptime monitor: 503 when the
 * worker stopped (no heartbeat), a sync has not succeeded for three intervals or the webhook queue is not drained;
 * 200 with `degraded` when syncs run but some tenants' fail. Ages and counts only, never tenant data or error text.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ pool: import('pg').Pool, expectWorker: { deployments: boolean, jira: boolean }, syncIntervalMinutes: number }} ctx
 */
function registerHealthRoutes(app, { pool, expectWorker, syncIntervalMinutes }) {
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
}

module.exports = { registerHealthRoutes };
