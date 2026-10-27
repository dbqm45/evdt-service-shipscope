// Service API (F5, design-docs/F5-API-PLAN.pl.md): what other services read with a service token
// (`Authorization: Bearer shps_…`). Read only; the token names its workspace.
const crypto = require('crypto');
const { createLimiter } = require('../lib/request-limiter');
const { serviceItemStatus, serviceMetrics, serviceFlow, metricsCsv, serviceChanges, serviceReleasePlan, serviceFlags, serviceEnvironments } = require('../lib/service-api');
const { serviceConnection } = require('../lib/pdi-connection');

// Per token, as for the flag ingest: a burst, then one a second.
const SERVICE_RATE_LIMIT = { capacity: 60, refillPerSecond: 1 };

class ServiceRateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super('Too many requests from this service token; slow down');
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ pool: import('pg').Pool, serviceRateLimit?: { capacity: number, refillPerSecond: number } }} ctx
 */
function registerServiceRoutes(app, ctx) {
    const { pool } = ctx;
    const limiter = createLimiter(ctx.serviceRateLimit || SERVICE_RATE_LIMIT);
    const tokenOf = (request) => {
        const match = /^Bearer (\S+)$/.exec(request.headers.authorization || '');
        const token = match ? match[1] : '';
        // Before the database; keyed by a hash, so the buckets never hold a token.
        const { ok, retryAfterSeconds } = limiter.take(crypto.createHash('sha256').update(token).digest('hex'));
        if (!ok) throw new ServiceRateLimitError(retryAfterSeconds);
        return token;
    };

    app.get('/api/service/v1/items/:key', {
        schema: { params: { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 50 } } } },
    }, async (request) => serviceItemStatus(pool, { token: tokenOf(request), key: request.params.key }));

    app.get('/api/service/v1/metrics', {
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: {
                    from: { type: 'string', maxLength: 10 },
                    to: { type: 'string', maxLength: 10 },
                    format: { type: 'string', enum: ['json', 'csv'] },
                },
            },
        },
    }, async (request, reply) => {
        const metrics = await serviceMetrics(pool, { token: tokenOf(request), from: request.query.from, to: request.query.to });
        if (request.query.format === 'csv') return reply.type('text/csv; charset=utf-8').send(metricsCsv(metrics));
        return metrics;
    });

    // Flow time per item and delivered change (G3 step 1): what tf and pdi calibrate the automatic forecast with.
    app.get('/api/service/v1/flow', {
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: { from: { type: 'string', maxLength: 10 }, to: { type: 'string', maxLength: 10 } },
            },
        },
    }, async (request) => serviceFlow(pool, { token: tokenOf(request), from: request.query.from, to: request.query.to }));

    // What the dashboard shows, for a conversation in Claude (K-1, adapters/mcp/): read only, no parameters.
    const views = { connection: serviceConnection, changes: serviceChanges, 'release-plan': serviceReleasePlan, flags: serviceFlags, environments: serviceEnvironments };
    for (const [path, view] of Object.entries(views)) {
        app.get(`/api/service/v1/${path}`, async (request) => view(pool, { token: tokenOf(request) }));
    }
}

module.exports = { registerServiceRoutes, ServiceRateLimitError, SERVICE_RATE_LIMIT };
