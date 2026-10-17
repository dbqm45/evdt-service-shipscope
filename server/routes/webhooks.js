const { WebhookAuthError, verifyGitHubSignature, verifyAtlassianJwt, githubSyncKeys, jiraSyncKeys, requestSync } = require('../lib/webhooks');

const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024; // GitHub's own cap is 25 MB, but deployment and issue events are a few KB

/**
 * Webhooks (migration 013): verified against the raw body, then only the key of what to sync is queued for
 * the worker. Answers fast and never says more than accepted / refused.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerWebhookRoutes(app, ctx) {
    const { pool, githubApp, atlassian } = ctx;
    if (!(githubApp && githubApp.webhookSecret) && !atlassian) return;
    app.register(async (scope) => {
        // The signature covers the exact bytes sent, so the body stays a Buffer until it is verified.
        scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (req, body, done) => done(null, body));
        const parse = (buffer) => {
            try {
                return JSON.parse(buffer.toString('utf8'));
            } catch {
                return undefined;
            }
        };
        const refused = (reply, err) => {
            if (!(err instanceof WebhookAuthError)) throw err;
            return reply.code(401).send({ error: 'Webhook signature is not valid' });
        };

        if (githubApp && githubApp.webhookSecret) {
            scope.post('/webhooks/github', async (request, reply) => {
                try {
                    verifyGitHubSignature({ secret: githubApp.webhookSecret, rawBody: request.body, signature: request.headers['x-hub-signature-256'] });
                } catch (err) {
                    return refused(reply, err);
                }
                const payload = parse(request.body);
                if (payload === undefined) return reply.code(400).send({ error: 'Body is not JSON' });
                const keys = githubSyncKeys(request.headers['x-github-event'], payload);
                await requestSync(pool, { source: 'github', keys });
                return reply.code(202).send({ queued: keys.length });
            });
        }
        if (atlassian) {
            scope.post('/webhooks/jira', async (request, reply) => {
                try {
                    verifyAtlassianJwt({ secret: atlassian.clientSecret, authorization: request.headers.authorization });
                } catch (err) {
                    return refused(reply, err);
                }
                const payload = parse(request.body);
                if (payload === undefined) return reply.code(400).send({ error: 'Body is not JSON' });
                const keys = jiraSyncKeys(payload);
                await requestSync(pool, { source: 'jira', keys });
                return reply.code(202).send({ queued: keys.length });
            });
        }
    });
}

module.exports = { registerWebhookRoutes };
