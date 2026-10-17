const { loadDashboardAssets, loadUiAssets, ASSET_PATTERN } = require('../lib/dashboard-assets');
const { buildDashboardData } = require('../lib/dashboard-data');
const { listPiIssues } = require('../lib/jira-sync');
const { getSessionUser } = require('../lib/sessions');
const { listTenantsForUser, roleOf, TenantNotFoundError } = require('../lib/tenants');
const { withScope } = require('../lib/scope');

/**
 * The dashboard for one tenant (the existing docs/ page, whose app-data.js recognizes /t/<tenantId>/ and
 * loads its data from /api/tenants/<tenantId>/dashboard-data instead of data/*.json) AND the server's own
 * UI (settings per tenant, creating a first workspace, the invitation-accept page). Kept in one file,
 * unlike design-docs/REPORT_ARCH.md's proposed dashboard.js/ui.js split: both halves share the same loaded
 * `assets`/`ui` asset maps and the `sendUi` closure built from them, so splitting them would mean passing
 * that shared state across two files for no behavioral benefit.
 *
 * Sets `ctx.ui.sendUiPage` once `ui/invite.html` is confirmed deployed, for registerInvitationRoutes() to
 * read lazily — see that file's own comment for why a mutable, lazily-read slot is used instead of
 * depending on registration order.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerDashboardRoutes(app, ctx) {
    const {
        pool, githubApp, atlassian, requireUser, requireUserOrSignIn, dashboardDir, UI_DIR, DASHBOARD_HEADERS,
        UUID_PARAM, ui, cookies: { SESSION_COOKIE },
    } = ctx;
    const assets = loadDashboardAssets(dashboardDir);
    if (!assets.has('index.html')) app.log.warn(`dashboard files not found in ${dashboardDir}; /t/:tenantId/ will answer 503`);
    const tenantParams = { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } };

    app.get('/', async (request, reply) => {
        const user = await getSessionUser(pool, request.cookies[SESSION_COOKIE]);
        if (!user) return reply.redirect('/auth/github/login');
        const tenants = await listTenantsForUser(pool, user.id);
        return reply.redirect(tenants.length ? `/t/${tenants[0].id}/` : '/start');
    });

    async function assertMemberOf(tenantId, userId) {
        await withScope(pool, { tenantId }, async (client) => {
            if (!(await roleOf(client, { tenantId, userId }))) throw new TenantNotFoundError('Tenant not found');
        });
    }

    // The server's own pages: settings per tenant, and creating a first workspace.
    const uiAssets = loadUiAssets(UI_DIR, assets);
    const sendUi = (reply, name) => {
        const page = uiAssets.get(name);
        if (!page) return reply.code(503).send({ error: 'Settings files are not deployed' });
        return reply.headers({ ...DASHBOARD_HEADERS, 'content-type': page.type }).send(page.body);
    };
    if (uiAssets.has('invite.html')) ui.sendUiPage = sendUi;
    app.get('/start', { preHandler: requireUserOrSignIn }, async (request, reply) => sendUi(reply, 'start.html'));
    app.get('/t/:tenantId/settings', {
        preHandler: requireUserOrSignIn,
        schema: { params: tenantParams },
    }, async (request, reply) => {
        await assertMemberOf(request.params.tenantId, request.user.id);
        return sendUi(reply, 'settings.html');
    });
    app.get('/ui/:asset', {
        schema: { params: { type: 'object', required: ['asset'], properties: { asset: { type: 'string', pattern: '^[a-z-]+\\.(js|css|svg)$' } } } },
    }, async (request, reply) => {
        const asset = uiAssets.get(request.params.asset);
        if (!asset) return reply.code(404).send({ error: 'Not found' });
        return reply.headers({ ...DASHBOARD_HEADERS, 'content-type': asset.type }).send(asset.body);
    });
    // Which optional parts this server has, so the settings page doesn't offer what isn't there.
    app.get('/api/features', async () => ({
        githubApp: Boolean(githubApp), jira: Boolean(atlassian),
        githubWebhooks: Boolean(githubApp?.webhookSecret), jiraWebhooks: Boolean(atlassian?.webhookUrl),
    }));

    // Relative asset URLs in index.html only resolve under the trailing slash.
    app.get('/t/:tenantId', { schema: { params: tenantParams } }, async (request, reply) => reply.redirect(`/t/${request.params.tenantId}/`));

    app.get('/t/:tenantId/', {
        preHandler: requireUserOrSignIn,
        schema: { params: tenantParams },
    }, async (request, reply) => {
        await assertMemberOf(request.params.tenantId, request.user.id);
        const page = assets.get('index.html');
        if (!page) return reply.code(503).send({ error: 'Dashboard files are not deployed' });
        return reply.headers({ ...DASHBOARD_HEADERS, 'content-type': page.type }).send(page.body);
    });

    // Scripts, stylesheet, icon: the same public code GitHub Pages serves, so no session needed.
    app.get('/t/:tenantId/:asset', {
        schema: {
            params: { type: 'object', required: ['tenantId', 'asset'], properties: { tenantId: UUID_PARAM, asset: { type: 'string', pattern: ASSET_PATTERN.source } } },
        },
    }, async (request, reply) => {
        const asset = assets.get(request.params.asset);
        if (!asset || request.params.asset === 'index.html') return reply.code(404).send({ error: 'Not found' });
        return reply.headers({ ...DASHBOARD_HEADERS, 'content-type': asset.type }).send(asset.body);
    });

    app.get('/api/tenants/:tenantId/dashboard-data', {
        preHandler: requireUser,
        schema: { params: tenantParams },
    }, async (request, reply) => {
        reply.header('cache-control', 'no-store');
        return buildDashboardData(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id });
    });

    // One PI's Jira issues (what a data/jira-issues/<PI>.json shard holds); app-data.js's loadJiraIssuesForPi.
    app.get('/api/tenants/:tenantId/jira-issues', {
        preHandler: requireUser,
        schema: {
            params: tenantParams,
            querystring: { type: 'object', required: ['pi'], additionalProperties: false, properties: { pi: { type: 'string', minLength: 1, maxLength: 200 } } },
        },
    }, async (request, reply) => {
        reply.header('cache-control', 'no-store');
        return listPiIssues(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, pi: request.query.pi });
    });
}

module.exports = { registerDashboardRoutes };
