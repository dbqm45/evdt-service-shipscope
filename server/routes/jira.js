const crypto = require('crypto');
const {
    buildAuthorizeUrl: buildAtlassianAuthorizeUrl, exchangeCode: exchangeAtlassianCode, fetchJiraSites,
} = require('../lib/atlassian');
const { saveConnection, getConnection, selectSite, disconnect, listProjects } = require('../lib/jira-connections');
const {
    listBoards, setBoards, configureBoard, syncTenant: syncJiraTenant, removeJiraWebhooks, listFlagFields, setFlagLink,
} = require('../lib/jira-sync');

const JIRA_CONNECT_COOKIE = 'jira_connect';

/**
 * FR-007/FR-008/FR-009: connecting the tenant's Jira Cloud through Atlassian OAuth 2.0 (3LO), choosing which
 * boards to sync, and triggering a sync on demand. Admins only. Only registered when `atlassian` is
 * configured (see web.js's buildApp()). The OAuth state round-trips through a cookie that also names the
 * tenant, so the callback knows where the grant belongs and a crafted callback URL can't attach someone's
 * grant to another tenant.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerJiraRoutes(app, ctx) {
    const { pool, auth, atlassian, fetchFn, requireUser, assertAdminOf, safeEqual, splitCookie, baseCookie, UUID_PATTERN, UUID_PARAM, GITHUB_ID_PARAM, STATE_TTL_SECONDS } = ctx;
    const tenantParams = { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } };
    const jiraCookie = { ...baseCookie, path: '/auth/atlassian', maxAge: STATE_TTL_SECONDS };
    const jiraRedirectUri = `${auth.publicBaseUrl}/auth/atlassian/callback`;

    app.get('/tenants/:tenantId/jira/connect', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request, reply) => {
        await assertAdminOf(request.params.tenantId, request.user.id);
        const state = crypto.randomBytes(16).toString('base64url');
        reply.setCookie(JIRA_CONNECT_COOKIE, `${state}.${request.params.tenantId}`, jiraCookie);
        return reply.redirect(buildAtlassianAuthorizeUrl({ clientId: atlassian.clientId, redirectUri: jiraRedirectUri, state }));
    });

    app.get('/auth/atlassian/callback', {
        preHandler: requireUser,
        schema: {
            querystring: {
                type: 'object',
                required: ['state'],
                properties: {
                    code: { type: 'string', minLength: 1, maxLength: 2048 },
                    state: { type: 'string', minLength: 1, maxLength: 64 },
                    error: { type: 'string', maxLength: 200 },
                },
            },
        },
    }, async (request, reply) => {
        const pending = splitCookie(request.cookies[JIRA_CONNECT_COOKIE], /^[A-Za-z0-9_-]{22}$/, UUID_PATTERN);
        reply.clearCookie(JIRA_CONNECT_COOKIE, jiraCookie);
        if (!pending || !safeEqual(pending[0], request.query.state)) {
            return reply.code(400).send({ error: 'Invalid or expired Jira connection attempt; please start again from ShipScope' });
        }
        const tenantId = pending[1];
        // The user declined on Atlassian's consent screen (or Atlassian refused): nothing to store.
        if (request.query.error || !request.query.code) {
            return reply.code(400).send({ error: 'Jira was not connected (access was not granted)' });
        }
        await assertAdminOf(tenantId, request.user.id);
        const tokens = await exchangeAtlassianCode({
            clientId: atlassian.clientId, clientSecret: atlassian.clientSecret, code: request.query.code, redirectUri: jiraRedirectUri, fetch: fetchFn,
        });
        if (!tokens.refreshToken) {
            return reply.code(502).send({ error: 'Atlassian did not grant offline access; check the app\'s permissions and connect again' });
        }
        const sites = await fetchJiraSites({ accessToken: tokens.accessToken, fetch: fetchFn });
        if (!sites.length) return reply.code(400).send({ error: 'This Atlassian account has no Jira site ShipScope can read' });
        await saveConnection(pool, {
            tenantId, actorUserId: request.user.id, refreshToken: tokens.refreshToken, scopes: tokens.scopes, sites, encryptionKey: atlassian.encryptionKey,
        });
        return reply.redirect(`/t/${tenantId}/settings#jira`);
    });

    app.get('/tenants/:tenantId/jira', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request) => getConnection(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }));

    app.put('/tenants/:tenantId/jira/site', {
        preHandler: requireUser,
        schema: {
            params: tenantParams,
            body: {
                type: 'object',
                required: ['cloudId'],
                additionalProperties: false,
                properties: { cloudId: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$' } },
            },
        },
    }, async (request) => selectSite(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, cloudId: request.body.cloudId }));

    app.delete('/tenants/:tenantId/jira', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request, reply) => {
        await assertAdminOf(request.params.tenantId, request.user.id);
        await removeJiraWebhooks(pool, { tenantId: request.params.tenantId, atlassian, fetch: fetchFn });
        const removed = await disconnect(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id });
        if (!removed) return reply.code(404).send({ error: 'Jira is not connected' });
        return reply.code(204).send();
    });

    // How Jira issues name their feature flags: a custom field (one of these candidates) or labels with a prefix.
    app.get('/tenants/:tenantId/jira/flag-fields', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request) => ({
        fields: await listFlagFields(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, atlassian, fetch: fetchFn }),
    }));

    app.put('/tenants/:tenantId/jira/flag-link', {
        preHandler: requireUser,
        schema: {
            params: tenantParams,
            body: {
                oneOf: [
                    { type: 'object', required: ['type'], additionalProperties: false, properties: { type: { const: 'none' } } },
                    {
                        type: 'object', required: ['type', 'prefix'], additionalProperties: false,
                        properties: { type: { const: 'label' }, prefix: { type: 'string', minLength: 1, maxLength: 30 } },
                    },
                    {
                        type: 'object', required: ['type', 'id'], additionalProperties: false,
                        properties: { type: { const: 'field' }, id: { type: 'string', pattern: '^customfield_[0-9]{1,10}$' } },
                    },
                ],
            },
        },
    }, async (request) => ({
        flagLink: await setFlagLink(pool, {
            tenantId: request.params.tenantId, actorUserId: request.user.id, atlassian, flagLink: request.body, fetch: fetchFn,
        }),
    }));

    // FR-008: which boards to sync (a board's sprints define the PIs and scope the issues to its team).
    app.get('/tenants/:tenantId/jira/boards', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request) => ({
        boards: await listBoards(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, atlassian, fetch: fetchFn }),
    }));

    app.put('/tenants/:tenantId/jira/boards', {
        preHandler: requireUser,
        schema: {
            params: tenantParams,
            body: {
                type: 'object',
                required: ['boardIds'],
                additionalProperties: false,
                properties: { boardIds: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'integer', minimum: 1 } } },
            },
        },
    }, async (request) => ({
        boards: await setBoards(pool, {
            tenantId: request.params.tenantId, actorUserId: request.user.id, boardIds: request.body.boardIds, atlassian, fetch: fetchFn,
        }),
    }));

    // How a selected board's work groups into increments: SAFe PIs (optionally the admin's own PI naming), every
    // sprint on its own, releases (fixVersion), calendar months (Kanban flow), or detected (lib/jira-model.js rhythmOf()).
    app.put('/tenants/:tenantId/jira/boards/:boardId', {
        preHandler: requireUser,
        schema: {
            params: { type: 'object', required: ['tenantId', 'boardId'], properties: { tenantId: UUID_PARAM, boardId: GITHUB_ID_PARAM } },
            body: {
                type: 'object',
                required: ['rhythm', 'piTemplate'],
                additionalProperties: false,
                properties: {
                    rhythm: { type: 'string', enum: ['auto', 'pi', 'sprint', 'release', 'flow'] },
                    piTemplate: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 100 }] },
                },
            },
        },
    }, async (request) => configureBoard(pool, {
        tenantId: request.params.tenantId, actorUserId: request.user.id, boardId: Number(request.params.boardId), ...request.body,
    }));

    // FR-009 on demand (the worker also runs it every pass), e.g. right after choosing boards.
    app.post('/tenants/:tenantId/jira/sync', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request) => {
        await assertAdminOf(request.params.tenantId, request.user.id);
        return syncJiraTenant(pool, { tenantId: request.params.tenantId, atlassian, fetch: fetchFn });
    });

    app.get('/tenants/:tenantId/jira/projects', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request) => ({
        projects: await listProjects(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, atlassian, fetch: fetchFn }),
    }));
}

module.exports = { registerJiraRoutes };
