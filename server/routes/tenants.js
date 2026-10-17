const {
    createTenantWithOwner, listMembersIfMember, removeMember, assertDeletable, deleteTenant,
} = require('../lib/tenants');
const { withScope } = require('../lib/scope');
const { removeJiraWebhooks } = require('../lib/jira-sync');
const { listDeployments, getSettings, updateSettings, MAX_LIMIT } = require('../lib/deployments');

/**
 * Tenant CRUD, membership, retention settings, and FR-005's deployment listing — everything scoped to a
 * tenant that isn't its own larger subsystem (invitations, flags, GitHub, Jira each get their own file).
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerTenantRoutes(app, ctx) {
    const { pool, atlassian, fetchFn, requireUser, UUID_PARAM, GITHUB_ID_PARAM } = ctx;
    const tenantOnlyParams = { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } };

    app.post('/tenants', {
        preHandler: requireUser,
        schema: {
            body: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: { name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } },
            },
        },
    }, async (request, reply) => {
        const { tenant } = await createTenantWithOwner(pool, {
            name: request.body.name.trim(),
            githubUserId: request.user.githubUserId,
            githubLogin: request.user.githubLogin,
        });
        return reply.code(201).send({ tenant: { id: tenant.id, name: tenant.name }, role: 'admin' });
    });

    app.get('/tenants/:tenantId/members', {
        preHandler: requireUser,
        schema: {
            params: {
                type: 'object',
                required: ['tenantId'],
                properties: { tenantId: { type: 'string', format: 'uuid' } },
            },
        },
    }, async (request, reply) => {
        const members = await listMembersIfMember(pool, { tenantId: request.params.tenantId, userId: request.user.id });
        if (!members) return reply.code(404).send({ error: 'Tenant not found' });
        return { members };
    });

    // Deletes the whole tenant and its data (every table cascades from it). Admins only, with the tenant's name typed
    // back. What ShipScope registered elsewhere goes first (the Jira webhook); the GitHub App stays installed on
    // GitHub -- uninstalling it there is the owner's call, not this route's.
    app.delete('/tenants/:tenantId', {
        preHandler: requireUser,
        schema: {
            params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } },
            body: {
                type: 'object',
                required: ['confirmName'],
                additionalProperties: false,
                properties: { confirmName: { type: 'string', minLength: 1, maxLength: 200 } },
            },
        },
    }, async (request, reply) => {
        const input = { tenantId: request.params.tenantId, actorUserId: request.user.id, confirmName: request.body.confirmName };
        // Checked before anything outside ShipScope is touched; checked again in the deleting transaction.
        await withScope(pool, { tenantId: input.tenantId }, (client) => assertDeletable(client, input));
        if (atlassian) await removeJiraWebhooks(pool, { tenantId: input.tenantId, atlassian, fetch: fetchFn });
        await deleteTenant(pool, input);
        request.log.info({ tenantId: input.tenantId }, 'tenant deleted');
        return reply.code(204).send();
    });

    // Admin removes a member, or a member leaves (their own userId). Never the last admin.
    app.delete('/tenants/:tenantId/members/:userId', {
        preHandler: requireUser,
        schema: {
            params: { type: 'object', required: ['tenantId', 'userId'], properties: { tenantId: UUID_PARAM, userId: UUID_PARAM } },
        },
    }, async (request, reply) => {
        await removeMember(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, targetUserId: request.params.userId });
        return reply.code(204).send();
    });

    app.get('/tenants/:tenantId/settings', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams },
    }, async (request) => getSettings(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }));

    // How long deployment history is kept (the worker's daily cleanup applies it). Admins only.
    app.put('/tenants/:tenantId/settings', {
        preHandler: requireUser,
        schema: {
            params: tenantOnlyParams,
            body: {
                type: 'object',
                required: ['deploymentRetentionDays'],
                additionalProperties: false,
                properties: { deploymentRetentionDays: { type: 'integer', minimum: 7, maximum: 730 } },
            },
        },
    }, async (request) => updateSettings(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, deploymentRetentionDays: request.body.deploymentRetentionDays,
    }));

    // FR-005: the tenant's deployments as the worker ingested them, newest first.
    app.get('/tenants/:tenantId/deployments', {
        preHandler: requireUser,
        schema: {
            params: tenantOnlyParams,
            querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    repoId: GITHUB_ID_PARAM,
                    environment: { type: 'string', enum: ['test', 'qa', 'prod'] },
                    limit: { type: 'string', pattern: '^[1-9][0-9]{0,3}$' },
                },
            },
        },
    }, async (request) => ({
        deployments: await listDeployments(pool, {
            tenantId: request.params.tenantId,
            actorUserId: request.user.id,
            repoId: request.query.repoId ? Number(request.query.repoId) : undefined,
            environment: request.query.environment,
            limit: request.query.limit ? Math.min(Number(request.query.limit), MAX_LIMIT) : undefined,
        }),
    }));
}

module.exports = { registerTenantRoutes };
