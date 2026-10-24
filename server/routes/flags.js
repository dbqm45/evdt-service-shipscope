const crypto = require('crypto');
const {
    createFlagSource, updateFlagSource, deleteFlagSource, listFlagSources, createIngestToken, revokeIngestToken, ingestFlags,
    recordIngestError, listFlags, setFlagDetails,
} = require('../lib/flags');
const { createLimiter } = require('../lib/request-limiter');

// Per token: a burst of 60 messages, then one a second. A sender posts once per environment per deployment or
// polling round, far below this; the limit only stops a runaway sender from crowding out everyone else.
const INGEST_RATE_LIMIT = { capacity: 60, refillPerSecond: 1 };

/** Too many messages from one token; the sender waits `retryAfterSeconds` (sent as Retry-After). */
class IngestRateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super('Too many flag messages from this token; slow down');
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
// The ingest contract, published as is at GET /api/flags/ingest/schema so senders can check a message before sending it.
const INGEST_SCHEMA = require('../schemas/flags-ingest.v2.schema.json');

/**
 * Feature flags, pushed from outside (lib/flags.js, contract schemaVersion 2): admins name the tenant's
 * flag sources ("LaunchDarkly", "Frontend CI", ...) and each sends the full state of its flags with its
 * own token. No session on the ingest: the token is the credential.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerFlagRoutes(app, ctx) {
    const { pool, requireUser, UUID_PARAM } = ctx;
    const limiter = createLimiter(ctx.ingestRateLimit || INGEST_RATE_LIMIT);
    const tenantOnlyParams = { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } };
    const { flagKey: FLAG_KEY, jiraKey: JIRA_KEY } = INGEST_SCHEMA.definitions;

    app.post('/api/flags/ingest', {
        bodyLimit: 2 * 1024 * 1024,
        schema: { body: INGEST_SCHEMA },
        // A body the schema refuses is still a 400, but noted on the sender's source first (Settings shows why).
        attachValidation: true,
    }, async (request) => {
        const match = /^Bearer (\S+)$/.exec(request.headers.authorization || '');
        const token = match ? match[1] : '';
        // Checked before anything touches the database. Keyed by a hash, so the buckets never hold a token.
        const { ok, retryAfterSeconds } = limiter.take(crypto.createHash('sha256').update(token).digest('hex'));
        if (!ok) throw new IngestRateLimitError(retryAfterSeconds);
        if (request.validationError) {
            await recordIngestError(pool, { token, message: request.validationError.message })
                .catch((err) => request.log.warn({ err: err.message }, 'could not record a refused flag message'));
            throw request.validationError;
        }
        return ingestFlags(pool, { token, payload: request.body });
    });

    app.get('/api/flags/ingest/schema', async (request, reply) => reply.type('application/schema+json').send(INGEST_SCHEMA));

    // A token's lifetime in days (null = never; left out = the default year) and the environments it may send.
    const EXPIRES_IN_DAYS = { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 730 }] };
    const TOKEN_ENVIRONMENTS = { anyOf: [{ type: 'null' }, { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['test', 'qa', 'prod'] } }] };
    const sourceBody = (required, extra = {}) => ({
        type: 'object',
        required,
        additionalProperties: false,
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            kind: { type: 'string', enum: ['build', 'runtime'] },
            priority: { type: 'integer', minimum: 0, maximum: 1000 },
            repoId: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] },
            ...extra,
        },
    });
    const sourceParams = { type: 'object', required: ['tenantId', 'sourceId'], properties: { tenantId: UUID_PARAM, sourceId: UUID_PARAM } };

    app.post('/tenants/:tenantId/flag-sources', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams, body: sourceBody(['name', 'kind'], { tokenExpiresInDays: EXPIRES_IN_DAYS, tokenEnvironments: TOKEN_ENVIRONMENTS }) },
    }, async (request, reply) => reply.code(201).send(await createFlagSource(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, ...request.body,
    })));

    // The flags themselves, for the settings page: descriptions and Jira links by origin, state per environment.
    app.get('/tenants/:tenantId/flags', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams },
    }, async (request) => ({ flags: await listFlags(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }) }));

    // What an admin sets by hand: a description over the sender's, and linked Jira issues. Never overwritten by
    // a sender's message.
    app.put('/tenants/:tenantId/flags/:key', {
        preHandler: requireUser,
        schema: {
            params: { type: 'object', required: ['tenantId', 'key'], properties: { tenantId: UUID_PARAM, key: FLAG_KEY } },
            body: {
                type: 'object',
                required: ['description', 'jiraKeys'],
                additionalProperties: false,
                properties: {
                    description: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 500 }] },
                    jiraKeys: { type: 'array', maxItems: 50, uniqueItems: true, items: JIRA_KEY },
                },
            },
        },
    }, async (request) => setFlagDetails(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, key: request.params.key, ...request.body,
    }));

    app.get('/tenants/:tenantId/flag-sources', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams },
    }, async (request) => ({ sources: await listFlagSources(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }) }));

    app.put('/tenants/:tenantId/flag-sources/:sourceId', {
        preHandler: requireUser,
        schema: { params: sourceParams, body: sourceBody(['name', 'kind', 'priority', 'repoId']) },
    }, async (request) => updateFlagSource(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, sourceId: request.params.sourceId, ...request.body,
    }));

    app.delete('/tenants/:tenantId/flag-sources/:sourceId', {
        preHandler: requireUser,
        schema: { params: sourceParams },
    }, async (request, reply) => {
        const removed = await deleteFlagSource(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, sourceId: request.params.sourceId });
        if (!removed) return reply.code(404).send({ error: 'No such flag source' });
        return reply.code(204).send();
    });

    app.post('/tenants/:tenantId/flag-sources/:sourceId/tokens', {
        preHandler: requireUser,
        schema: {
            params: sourceParams,
            body: { type: ['object', 'null'], additionalProperties: false, properties: { expiresInDays: EXPIRES_IN_DAYS, environments: TOKEN_ENVIRONMENTS } },
        },
    }, async (request, reply) => reply.code(201).send(await createIngestToken(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, sourceId: request.params.sourceId, ...(request.body || {}),
    })));

    app.delete('/tenants/:tenantId/ingest-tokens/:tokenId', {
        preHandler: requireUser,
        schema: { params: { type: 'object', required: ['tenantId', 'tokenId'], properties: { tenantId: UUID_PARAM, tokenId: UUID_PARAM } } },
    }, async (request, reply) => {
        const removed = await revokeIngestToken(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, tokenId: request.params.tokenId });
        if (!removed) return reply.code(404).send({ error: 'No such ingest token' });
        return reply.code(204).send();
    });
}

module.exports = { registerFlagRoutes, IngestRateLimitError, INGEST_RATE_LIMIT };
