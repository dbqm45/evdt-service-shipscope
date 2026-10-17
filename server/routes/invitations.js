const {
    createInvitation, listPendingInvitations, revokeInvitation, previewInvitation, acceptInvitation,
} = require('../lib/invitations');

/**
 * FR-003: invitations. The link (with its token) is returned once, at creation; afterwards only its id is
 * listed. `GET /invitations/:token` answers either the settings UI's HTML page or a JSON preview, chosen by
 * `Accept` — the page is only available once `ctx.ui.sendUiPage` has been set by registerDashboardRoutes(),
 * which runs after this file registers; reading it lazily inside the handler (not at registration time)
 * is what makes registration order not matter here.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerInvitationRoutes(app, ctx) {
    const { pool, auth, requireUser, requireUserOrSignIn, UUID_PARAM, TOKEN_PARAM: TOKEN_PARAM_SCHEMA, ui } = ctx;
    const tenantOnlyParams = { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } };

    app.post('/tenants/:tenantId/invitations', {
        preHandler: requireUser,
        schema: {
            params: tenantOnlyParams,
            body: {
                type: 'object',
                required: ['role'],
                additionalProperties: false,
                properties: { role: { type: 'string', enum: ['admin', 'member'] } },
            },
        },
    }, async (request, reply) => {
        const invitation = await createInvitation(pool, {
            tenantId: request.params.tenantId, actorUserId: request.user.id, role: request.body.role,
        });
        return reply.code(201).send({
            invitation: { id: invitation.id, role: invitation.role, expiresAt: invitation.expiresAt },
            url: `${auth.publicBaseUrl}/invitations/${invitation.token}`,
        });
    });

    app.get('/tenants/:tenantId/invitations', {
        preHandler: requireUser,
        schema: { params: tenantOnlyParams },
    }, async (request) => ({
        invitations: await listPendingInvitations(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }),
    }));

    app.delete('/tenants/:tenantId/invitations/:invitationId', {
        preHandler: requireUser,
        schema: {
            params: { type: 'object', required: ['tenantId', 'invitationId'], properties: { tenantId: UUID_PARAM, invitationId: UUID_PARAM } },
        },
    }, async (request, reply) => {
        const revoked = await revokeInvitation(pool, {
            tenantId: request.params.tenantId, actorUserId: request.user.id, invitationId: request.params.invitationId,
        });
        if (!revoked) return reply.code(404).send({ error: 'No pending invitation with that id' });
        return reply.code(204).send();
    });

    // One URL, two answers: a browser opening the link it was sent gets the page to accept it (ui/invite.html,
    // which reads the JSON below with `accept: application/json`); any other client gets the JSON preview.
    app.get('/invitations/:token', {
        preHandler: requireUserOrSignIn,
        schema: { params: { type: 'object', required: ['token'], properties: { token: TOKEN_PARAM_SCHEMA } } },
    }, async (request, reply) => {
        if (/\btext\/html\b/.test(request.headers.accept || '') && ui.sendUiPage) return ui.sendUiPage(reply, 'invite.html');
        return previewInvitation(pool, { token: request.params.token, userId: request.user.id });
    });

    app.post('/invitations/:token/accept', {
        preHandler: requireUser,
        schema: { params: { type: 'object', required: ['token'], properties: { token: TOKEN_PARAM_SCHEMA } } },
    }, async (request, reply) => {
        const result = await acceptInvitation(pool, { token: request.params.token, userId: request.user.id });
        return reply.code(201).send(result);
    });
}

module.exports = { registerInvitationRoutes };
