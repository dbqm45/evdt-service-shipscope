const crypto = require('crypto');
const { listInstallationRepos } = require('../lib/github-app');
const {
    listConnections, trackedRepoIdsForAdmin, trackRepo, untrackRepo, updateRepoSettings, unlinkInstallation,
} = require('../lib/github-connections');

const INSTALL_COOKIE = 'gh_install';

/**
 * FR-004/FR-006: connecting a tenant to GitHub through the App, and choosing tracked repos. Only
 * registered when `githubApp` is configured (see web.js's buildApp()).
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerGitHubRoutes(app, ctx) {
    const {
        pool, githubApp, fetchFn, requireUser, assertAdminOf, safeEqual, splitCookie, baseCookie,
        cookies: { LINK_COOKIE }, UUID_PATTERN, UUID_PARAM, GITHUB_ID_PARAM, STATE_TTL_SECONDS,
    } = ctx;
    const tenantParams = { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } };
    const installCookie = { ...baseCookie, path: '/github', maxAge: STATE_TTL_SECONDS };

    app.get('/tenants/:tenantId/github', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request) => listConnections(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }));

    // Step 1: an admin starts the installation on GitHub.
    app.get('/tenants/:tenantId/github/install', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request, reply) => {
        await assertAdminOf(request.params.tenantId, request.user.id);
        const state = crypto.randomBytes(16).toString('base64url');
        reply.setCookie(INSTALL_COOKIE, `${state}.${request.params.tenantId}`, installCookie);
        return reply.redirect(`https://github.com/apps/${githubApp.slug}/installations/new?state=${state}`);
    });

    // Step 2: GitHub's "Setup URL" redirect after installing (or reconfiguring) the App.
    app.get('/github/setup', {
        preHandler: requireUser,
        schema: {
            querystring: {
                type: 'object',
                required: ['state', 'setup_action'],
                properties: {
                    installation_id: GITHUB_ID_PARAM,
                    setup_action: { type: 'string', enum: ['install', 'update', 'request'] },
                    state: { type: 'string', minLength: 1, maxLength: 64 },
                },
            },
        },
    }, async (request, reply) => {
        const pending = splitCookie(request.cookies[INSTALL_COOKIE], /^[A-Za-z0-9_-]{22}$/, UUID_PATTERN);
        reply.clearCookie(INSTALL_COOKIE, installCookie);
        if (!pending || !safeEqual(pending[0], request.query.state)) {
            return reply.code(400).send({ error: 'Invalid or expired installation attempt; please start again from ShipScope' });
        }
        const tenantId = pending[1];
        // An organization member without owner rights can only request the installation; nothing to link yet.
        if (request.query.setup_action === 'request') {
            return reply.code(202).send({ status: 'pending-approval', message: 'An organization owner has to approve the installation on GitHub' });
        }
        if (!request.query.installation_id) return reply.code(400).send({ error: 'installation_id is missing' });
        await assertAdminOf(tenantId, request.user.id);

        // Step 3: a fresh sign-in, so the callback holds this user's token and can verify the installation.
        reply.setCookie(LINK_COOKIE, `${request.query.installation_id}.${tenantId}`, { ...baseCookie, path: '/auth/github', maxAge: STATE_TTL_SECONDS });
        return reply.redirect('/auth/github/login');
    });

    const installationParams = {
        type: 'object',
        required: ['tenantId', 'installationId'],
        properties: { tenantId: UUID_PARAM, installationId: GITHUB_ID_PARAM },
    };

    // The installation's repos as GitHub reports them now, each marked tracked or not. Admins only.
    app.get('/tenants/:tenantId/github/installations/:installationId/repositories', {
        preHandler: requireUser,
        schema: { params: installationParams },
    }, async (request) => {
        const installationId = Number(request.params.installationId);
        const tracked = await trackedRepoIdsForAdmin(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, installationId });
        const repos = await listInstallationRepos({ app: githubApp, installationId, fetch: fetchFn });
        return { repositories: repos.map((repo) => ({ ...repo, tracked: tracked.has(repo.id) })) };
    });

    app.delete('/tenants/:tenantId/github/installations/:installationId', {
        preHandler: requireUser,
        schema: { params: installationParams },
    }, async (request, reply) => {
        const removed = await unlinkInstallation(pool, {
            tenantId: request.params.tenantId, actorUserId: request.user.id, installationId: Number(request.params.installationId),
        });
        if (!removed) return reply.code(404).send({ error: 'No such installation in this tenant' });
        return reply.code(204).send();
    });

    const repoParams = { type: 'object', required: ['tenantId', 'repoId'], properties: { tenantId: UUID_PARAM, repoId: GITHUB_ID_PARAM } };

    // Track a repo. Only a repo GitHub lists for one of the tenant's own installations can be tracked.
    app.put('/tenants/:tenantId/github/repos/:repoId', {
        preHandler: requireUser,
        schema: {
            params: repoParams,
            body: {
                type: 'object',
                required: ['installationId'],
                additionalProperties: false,
                properties: { installationId: { type: 'integer', minimum: 1 } },
            },
        },
    }, async (request, reply) => {
        const { tenantId } = request.params;
        const repoId = Number(request.params.repoId);
        const { installationId } = request.body;
        await trackedRepoIdsForAdmin(pool, { tenantId, actorUserId: request.user.id, installationId });
        const repo = (await listInstallationRepos({ app: githubApp, installationId, fetch: fetchFn })).find((r) => r.id === repoId);
        if (!repo) return reply.code(404).send({ error: 'That repository is not part of this installation' });
        return trackRepo(pool, { tenantId, actorUserId: request.user.id, installationId, repo });
    });

    // Version file and drift-ignore patterns: repo-relative, never absolute or with a `..` segment. Only
    // ever sent to GitHub's API as a path inside the repo, but rejected here rather than trusted there.
    const repoPath = (chars) => ({ type: 'string', minLength: 1, maxLength: 200, pattern: `^(?!/)(?!(.*/)?\\.\\.(/|$))${chars}$` });
    app.put('/tenants/:tenantId/github/repos/:repoId/settings', {
        preHandler: requireUser,
        schema: {
            params: repoParams,
            body: {
                type: 'object',
                required: ['versionFile', 'driftIgnorePaths'],
                additionalProperties: false,
                properties: {
                    versionFile: { anyOf: [{ type: 'null' }, repoPath('[A-Za-z0-9._/-]*[A-Za-z0-9._-]')] }, // a file: no trailing /
                    driftIgnorePaths: { type: 'array', maxItems: 50, uniqueItems: true, items: repoPath('[A-Za-z0-9._*/-]+') },
                },
            },
        },
    }, async (request, reply) => {
        const updated = await updateRepoSettings(pool, {
            tenantId: request.params.tenantId,
            actorUserId: request.user.id,
            repoId: Number(request.params.repoId),
            ...request.body,
        });
        if (!updated) return reply.code(404).send({ error: 'That repository is not tracked' });
        return updated;
    });

    app.delete('/tenants/:tenantId/github/repos/:repoId', {
        preHandler: requireUser,
        schema: { params: repoParams },
    }, async (request, reply) => {
        const removed = await untrackRepo(pool, {
            tenantId: request.params.tenantId, actorUserId: request.user.id, repoId: Number(request.params.repoId),
        });
        if (!removed) return reply.code(404).send({ error: 'That repository is not tracked' });
        return reply.code(204).send();
    });
}

module.exports = { registerGitHubRoutes };
