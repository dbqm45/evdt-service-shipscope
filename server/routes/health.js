const { checkConnection } = require('../lib/db');
const { APP_VERSION } = require('../lib/version');

/**
 * `/health` and `/health/db` — the only routes that exist without an `auth` config (CLAUDE.md's
 * deploy-pipeline proof: GET /health, GET /health/db).
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ pool: import('pg').Pool }} ctx
 */
function registerHealthRoutes(app, { pool }) {
    app.get('/health', async () => ({ status: 'ok', version: APP_VERSION }));

    app.get('/health/db', async (request, reply) => {
        try {
            return await checkConnection(pool);
        } catch (err) {
            return reply.code(503).send({ ok: false, error: err.message });
        }
    });
}

module.exports = { registerHealthRoutes };
