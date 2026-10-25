const crypto = require('crypto');
const {
    createFlagSource, updateFlagSource, deleteFlagSource, listFlagSources, createIngestToken, revokeIngestToken, ingestFlags,
    recordIngestError, listFlags, setFlagDetails,
} = require('../lib/flags');
const { createLimiter } = require('../lib/request-limiter');
const { testEndpoint, endpointTestResult, endpointSigning, rotateSigningSecret } = require('../lib/endpoint-flags');
const { listSecretEvents } = require('../lib/audit-log');
const { answerLinkSuggestion } = require('../lib/flag-link-suggestions');
const { CODE_CONFIG, ENDPOINT_CONFIG, ENDPOINT_TOKEN } = require('../schemas/flag-code-config');

// Per token: a burst of 60 messages, then one a second. A sender posts once per environment per deployment or
// polling round, far below this; the limit only stops a runaway sender from crowding out everyone else.
const INGEST_RATE_LIMIT = { capacity: 60, refillPerSecond: 1 };
// Per workspace: "Test" calls the customer's endpoints, so a burst of 10, then one every 6 s.
const ENDPOINT_TEST_LIMIT = { capacity: 10, refillPerSecond: 1 / 6 };

/** Too many messages from one token; the sender waits `retryAfterSeconds` (sent as Retry-After). */
class IngestRateLimitError extends Error {
    constructor(retryAfterSeconds, message = 'Too many flag messages from this token; slow down') {
        super(message);
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
    const { pool, requireUser, UUID_PARAM, encryptionKey } = ctx;
    const sealingKeys = ctx.sealingKeys || null;
    const limiter = createLimiter(ctx.ingestRateLimit || INGEST_RATE_LIMIT);
    const testLimiter = createLimiter(ENDPOINT_TEST_LIMIT);
    const fetchImpl = ctx.safeFetch || undefined;
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
        const result = await ingestFlags(pool, { token, payload: request.body });
        request.log.info({ source: result.source, flags: result.flags, changed: result.changed, removed: result.removed, stale: result.stale }, 'flag message accepted');
        return result;
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
            // The services the source covers; the older single `repoId` sets one (or none with null).
            repoIds: { type: 'array', maxItems: 200, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
            repoId: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] },
            // Minutes a confirmation of the full state stays fresh; null = the kind's default.
            staleAfterMinutes: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 5, maximum: 43200 }] },
            // A source ShipScope reads itself from a file in one repository (lib/code-flags.js); checked further by
            // checkCodeConfig().
            code: CODE_CONFIG,
            // A runtime source ShipScope polls (lib/endpoint-flags.js); checked further by checkEndpointConfig().
            endpoint: ENDPOINT_CONFIG,
            endpointToken: ENDPOINT_TOKEN,
            // How often ShipScope polls it; null = every 5 minutes (lib/flags-logic.js POLL).
            pollIntervalMinutes: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 2, maximum: 1440 }] },
            ...extra,
        },
    });
    const ONE_SCOPE = { not: { required: ['repoIds', 'repoId'] } };
    const sourceParams = { type: 'object', required: ['tenantId', 'sourceId'], properties: { tenantId: UUID_PARAM, sourceId: UUID_PARAM } };

    app.post('/tenants/:tenantId/flag-sources', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams, body: { ...sourceBody(['name', 'kind'], { tokenExpiresInDays: EXPIRES_IN_DAYS, tokenEnvironments: TOKEN_ENVIRONMENTS, origin: { type: 'string', enum: ['push', 'code', 'endpoint'] } }), ...ONE_SCOPE } },
    }, async (request, reply) => reply.code(201).send(await createFlagSource(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, ...request.body, encryptionKey, sealingKeys,
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

    // An admin's answer to a suggested link (an issue whose commits changed the flag): link it by hand, or dismiss it.
    app.post('/tenants/:tenantId/flags/:key/suggestions', {
        preHandler: requireUser,
        schema: {
            params: { type: 'object', required: ['tenantId', 'key'], properties: { tenantId: UUID_PARAM, key: FLAG_KEY } },
            body: { type: 'object', required: ['jiraKey', 'accept'], additionalProperties: false, properties: { jiraKey: JIRA_KEY, accept: { type: 'boolean' } } },
        },
    }, async (request) => answerLinkSuggestion(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, key: request.params.key, ...request.body,
    }));

    app.get('/tenants/:tenantId/flag-sources', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams },
    }, async (request) => ({ sources: await listFlagSources(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }) }));

    app.put('/tenants/:tenantId/flag-sources/:sourceId', {
        preHandler: requireUser,
        schema: { params: sourceParams, body: { ...sourceBody(['name', 'kind', 'priority']), anyOf: [{ required: ['repoIds'] }, { required: ['repoId'] }], ...ONE_SCOPE } },
    }, async (request) => updateFlagSource(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, sourceId: request.params.sourceId, ...request.body, encryptionKey, sealingKeys,
    }));

    // "Test" for an endpoint source, saved or not: only the parsed flags per environment come back, never the answer.
    // A saved token only the worker can read is tested there: 202 { pending, testId }, then GET .../:testId.
    app.post('/tenants/:tenantId/flag-endpoint-test', {
        preHandler: requireUser,
        schema: {
            params: tenantOnlyParams,
            body: { type: 'object', required: ['endpoint'], additionalProperties: false, properties: { endpoint: ENDPOINT_CONFIG, endpointToken: ENDPOINT_TOKEN, sourceId: UUID_PARAM } },
        },
    }, async (request, reply) => {
        const { ok, retryAfterSeconds } = testLimiter.take(request.params.tenantId);
        if (!ok) throw new IngestRateLimitError(retryAfterSeconds, 'Too many endpoint tests; wait a moment');
        const result = await testEndpoint(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, ...request.body, encryptionKey, sealingKeys, fetchImpl });
        return result.pending ? reply.code(202).send(result) : result;
    });

    app.get('/tenants/:tenantId/flag-endpoint-test/:testId', {
        preHandler: requireUser,
        schema: { params: { type: 'object', required: ['tenantId', 'testId'], properties: { tenantId: UUID_PARAM, testId: UUID_PARAM } } },
    }, async (request) => endpointTestResult(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, testId: request.params.testId }));

    // How the customer's endpoint checks a request came from ShipScope for this workspace (admins only).
    app.get('/tenants/:tenantId/flag-endpoint-signing', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams },
    }, async (request) => endpointSigning(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, encryptionKey }));

    // A new signing secret for the workspace (a leaked one): shown once; the old one stops working at once.
    app.post('/tenants/:tenantId/flag-endpoint-signing/rotate', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams },
    }, async (request) => rotateSigningSecret(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, encryptionKey }));

    // Who showed or replaced the signing secret, set or removed an endpoint token, connected Jira (admins only).
    app.get('/tenants/:tenantId/secret-events', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams },
    }, async (request) => ({ events: await listSecretEvents(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }) }));

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
