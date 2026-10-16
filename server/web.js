const crypto = require('crypto');
const path = require('path');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const { createPool, checkConnection } = require('./lib/db');
const { loadAuthConfig, loadGitHubAppConfig } = require('./lib/config');
const { APP_VERSION } = require('./lib/version');
const { buildAuthorizeUrl, exchangeCode, fetchGitHubUser, GitHubOAuthError } = require('./lib/github-oauth');
const { createSession, getSessionUser, deleteSession } = require('./lib/sessions');
const {
    upsertUser, createTenantWithOwner, listTenantsForUser, listMembersIfMember, removeMember,
    assertAdmin, roleOf, TenantNotFoundError, AlreadyMemberError, ForbiddenError, LastAdminError,
} = require('./lib/tenants');
const { withScope } = require('./lib/scope');
const {
    createInvitation, listPendingInvitations, revokeInvitation, previewInvitation, acceptInvitation,
    InvitationNotFoundError, InvitationUnusableError, TOKEN_PATTERN,
} = require('./lib/invitations');
const { getInstallation, userCanAccessInstallation, listInstallationRepos, GitHubApiError } = require('./lib/github-app');
const {
    linkInstallation, listConnections, trackedRepoIdsForAdmin, trackRepo, untrackRepo, updateRepoSettings, unlinkInstallation,
    InstallationNotFoundError, InstallationTakenError,
} = require('./lib/github-connections');
const { listDeployments, getSettings, updateSettings, MAX_LIMIT } = require('./lib/deployments');
const { buildDashboardData } = require('./lib/dashboard-data');
const {
    createIngestToken, listIngestTokens, revokeIngestToken, ingestFlags, IngestTokenError, IngestPayloadError,
} = require('./lib/flags');
const { loadDashboardAssets, ASSET_PATTERN } = require('./lib/dashboard-assets');

const SESSION_COOKIE = 'sid';
const STATE_COOKIE = 'oauth_state';
const RETURN_TO_COOKIE = 'oauth_return_to';
// FR-004: GitHub App installation round trip. INSTALL_COOKIE carries the install state + tenant from
// /tenants/:id/github/install to /github/setup; LINK_COOKIE carries the installation to verify from
// /github/setup through a fresh sign-in to the callback, where the user's own token proves access.
const INSTALL_COOKIE = 'gh_install';
const LINK_COOKIE = 'gh_link';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DASHBOARD_HEADERS = {
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
};
const STATE_TTL_SECONDS = 600;
const POST_LOGIN_REDIRECT = '/'; // which redirects on to the user's first tenant's dashboard
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Where sign-in may send the user back to: an invitation link or a tenant's dashboard. An allowlist, not
// "any relative path": a looser check (e.g. "starts with /") still lets "//evil.example" through as a
// protocol-relative open redirect.
const RETURN_TO_PATTERN = new RegExp(`^(/invitations/${TOKEN_PATTERN.source.slice(1, -1)}|/t/${UUID_SOURCE}/)$`);
const DEFAULT_DASHBOARD_DIR = path.join(__dirname, '..', 'docs');

const UUID_PARAM = { type: 'string', format: 'uuid' };
const TOKEN_PARAM = { type: 'string', pattern: TOKEN_PATTERN.source };
const GITHUB_ID_PARAM = { type: 'string', pattern: '^[1-9][0-9]{0,14}$' };

/** Domain errors from lib/ and the HTTP status each one means. */
const ERROR_STATUS = [
    [TenantNotFoundError, 404],
    [InvitationNotFoundError, 404],
    [ForbiddenError, 403],
    [AlreadyMemberError, 409],
    [LastAdminError, 409],
    [InvitationUnusableError, 410],
    [InstallationNotFoundError, 404],
    [InstallationTakenError, 409],
    [GitHubApiError, 502],
    [IngestTokenError, 401],
    [IngestPayloadError, 400],
];

/** Drops the query string and masks invitation tokens, which work like passwords until accepted. */
function redactUrl(url) {
    return url.split('?')[0].replace(/\/invitations\/[^/]+/, '/invitations/:token');
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** Parses "<a>.<b>" cookie values; null unless both parts match. */
function splitCookie(value, first, second) {
    const [a, b, ...rest] = String(value || '').split('.');
    return !rest.length && first.test(a || '') && second.test(b || '') ? [a, b] : null;
}

/**
 * Builds the Web Service. Without `auth`, only the health routes exist (used by tests that don't
 * exercise sign-in); the real entry point below always passes a validated config. Without `githubApp`,
 * sign-in works but the repo-connection routes (FR-004/FR-006) don't exist.
 *
 * The dashboard (docs/) is served at /t/<tenantId>/ from `dashboardDir`.
 *
 * @param {{ pool: import('pg').Pool, auth?: ReturnType<typeof loadAuthConfig>, githubApp?: ReturnType<typeof loadGitHubAppConfig>, fetch?: typeof fetch, logger?: boolean|object, dashboardDir?: string }} options
 * @returns {import('fastify').FastifyInstance}
 */
function buildApp({ pool, auth, githubApp = null, fetch: fetchFn = fetch, logger = false, dashboardDir = DEFAULT_DASHBOARD_DIR }) {
    const app = Fastify({
        // Fastify's defaults silently strip unknown body fields and coerce types (42 -> "42"). External
        // input is rejected instead of rewritten (CLAUDE.md: validate every external boundary).
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
        logger: logger && {
            ...(typeof logger === 'object' ? logger : {}),
            // The default serializer logs the full URL; the OAuth callback's query string carries the
            // one-time authorization code and state, which must never reach logs (prd.md: credential hygiene).
            serializers: {
                req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
            },
        },
    });

    // Unexpected errors keep their detail in the log only; clients get a generic 500.
    app.setErrorHandler((err, request, reply) => {
        const mapped = ERROR_STATUS.find(([type]) => err instanceof type);
        if (mapped) {
            if (err instanceof GitHubApiError) request.log.warn({ err: err.message }, 'GitHub API call failed');
            const body = { error: err instanceof GitHubApiError ? 'GitHub request failed; please try again' : err.message };
            if (err instanceof InvitationUnusableError) body.status = err.status;
            return reply.code(mapped[1]).send(body);
        }
        if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: 'Internal Server Error' });
    });

    app.get('/health', async () => ({ status: 'ok', version: APP_VERSION }));

    app.get('/health/db', async (request, reply) => {
        try {
            return await checkConnection(pool);
        } catch (err) {
            return reply.code(503).send({ ok: false, error: err.message });
        }
    });

    if (!auth) return app;

    app.register(cookie);

    const redirectUri = `${auth.publicBaseUrl}/auth/github/callback`;
    const baseCookie = { httpOnly: true, sameSite: 'lax', secure: auth.secureCookies };

    async function requireUser(request, reply) {
        request.user = await getSessionUser(pool, request.cookies[SESSION_COOKIE]);
        if (!request.user) return reply.code(401).send({ error: 'Not signed in' });
    }

    // For links people open in a browser (invitations): send them through sign-in and back, instead of a 401.
    async function requireUserOrSignIn(request, reply) {
        request.user = await getSessionUser(pool, request.cookies[SESSION_COOKIE]);
        if (!request.user) return reply.redirect(`/auth/github/login?returnTo=${encodeURIComponent(request.url.split('?')[0])}`);
    }

    app.get('/auth/github/login', {
        schema: {
            querystring: {
                type: 'object',
                additionalProperties: false,
                properties: { returnTo: { type: 'string', pattern: RETURN_TO_PATTERN.source } },
            },
        },
    }, async (request, reply) => {
        const state = crypto.randomBytes(16).toString('base64url');
        const stateCookie = { ...baseCookie, path: '/auth/github', maxAge: STATE_TTL_SECONDS };
        reply.setCookie(STATE_COOKIE, state, stateCookie);
        if (request.query.returnTo) reply.setCookie(RETURN_TO_COOKIE, request.query.returnTo, stateCookie);
        else reply.clearCookie(RETURN_TO_COOKIE, { ...baseCookie, path: '/auth/github' });
        return reply.redirect(buildAuthorizeUrl({ clientId: auth.githubClientId, redirectUri, state }));
    });

    app.get('/auth/github/callback', {
        schema: {
            querystring: {
                type: 'object',
                required: ['code', 'state'],
                properties: { code: { type: 'string', minLength: 1 }, state: { type: 'string', minLength: 1 } },
            },
        },
    }, async (request, reply) => {
        const expectedState = request.cookies[STATE_COOKIE];
        const returnTo = request.cookies[RETURN_TO_COOKIE];
        const link = githubApp && splitCookie(request.cookies[LINK_COOKIE], /^[1-9][0-9]{0,14}$/, UUID_PATTERN);
        reply.clearCookie(STATE_COOKIE, { ...baseCookie, path: '/auth/github' });
        reply.clearCookie(RETURN_TO_COOKIE, { ...baseCookie, path: '/auth/github' });
        reply.clearCookie(LINK_COOKIE, { ...baseCookie, path: '/auth/github' });
        // CSRF: the state must round-trip through this browser's own cookie, or anyone could log a
        // victim into the attacker's account by getting them to open a crafted callback URL.
        if (!expectedState || !safeEqual(expectedState, request.query.state)) {
            return reply.code(400).send({ error: 'Invalid or expired sign-in attempt; please start again' });
        }

        let identity;
        let accessToken;
        try {
            accessToken = await exchangeCode({
                clientId: auth.githubClientId,
                clientSecret: auth.githubClientSecret,
                code: request.query.code,
                redirectUri,
                fetch: fetchFn,
            });
            identity = await fetchGitHubUser({ accessToken, fetch: fetchFn });
        } catch (err) {
            if (!(err instanceof GitHubOAuthError)) throw err;
            request.log.warn({ err: err.message }, 'GitHub sign-in failed');
            return reply.code(502).send({ error: 'GitHub sign-in failed; please try again' });
        }

        const user = await upsertUser(pool, identity);
        const session = await createSession(pool, user.id);
        reply.setCookie(SESSION_COOKIE, session.token, { ...baseCookie, path: '/', expires: session.expiresAt });

        if (link) {
            const [installationIdText, tenantId] = link;
            const installationId = Number(installationIdText);
            // The installation_id came back through the browser, so anyone could have edited it. Link it only
            // if GitHub confirms, with this user's own token, that they can access that installation.
            if (!(await userCanAccessInstallation({ accessToken, installationId, fetch: fetchFn }))) {
                return reply.code(403).send({ error: 'You do not have access to that GitHub installation' });
            }
            const installation = await getInstallation({ app: githubApp, installationId, fetch: fetchFn });
            await linkInstallation(pool, { tenantId, actorUserId: user.id, installation });
            return reply.redirect(`/tenants/${tenantId}/github`);
        }

        // The cookie was validated when set, but it's client-controlled: check it again before redirecting.
        return reply.redirect(returnTo && RETURN_TO_PATTERN.test(returnTo) ? returnTo : POST_LOGIN_REDIRECT);
    });

    // POST (not GET) plus SameSite=Lax keeps a cross-site page from signing users out.
    app.post('/auth/logout', async (request, reply) => {
        await deleteSession(pool, request.cookies[SESSION_COOKIE]);
        reply.clearCookie(SESSION_COOKIE, { ...baseCookie, path: '/' });
        return reply.code(204).send();
    });

    app.get('/me', { preHandler: requireUser }, async (request) => ({
        user: { id: request.user.id, githubLogin: request.user.githubLogin },
        tenants: await listTenantsForUser(pool, request.user.id),
    }));

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

    // FR-003: invitations. The link (with its token) is returned once, here; afterwards only its id is listed.
    app.post('/tenants/:tenantId/invitations', {
        preHandler: requireUser,
        schema: {
            params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } },
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
        schema: { params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } } },
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

    app.get('/invitations/:token', {
        preHandler: requireUserOrSignIn,
        schema: { params: { type: 'object', required: ['token'], properties: { token: TOKEN_PARAM } } },
    }, async (request) => previewInvitation(pool, { token: request.params.token, userId: request.user.id }));

    app.post('/invitations/:token/accept', {
        preHandler: requireUser,
        schema: { params: { type: 'object', required: ['token'], properties: { token: TOKEN_PARAM } } },
    }, async (request, reply) => {
        const result = await acceptInvitation(pool, { token: request.params.token, userId: request.user.id });
        return reply.code(201).send(result);
    });

    const tenantOnlyParams = { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } };

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

    registerFlagRoutes();
    registerDashboardRoutes();
    if (githubApp) registerGitHubRoutes();

    // Feature flags, pushed from outside (lib/flags.js): admins issue an ingest token per tracked repo, and
    // whatever holds the tenant's flags (CI reading build-time files, a job polling a runtime API or a flag
    // service) posts observations with it. No session: the token is the credential.
    function registerFlagRoutes() {
        const FLAG_KEY = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$' };
        app.post('/api/flags/ingest', {
            bodyLimit: 1024 * 1024,
            schema: {
                body: {
                    type: 'object',
                    required: ['schemaVersion', 'source', 'observations'],
                    additionalProperties: false,
                    properties: {
                        schemaVersion: { const: 1 },
                        component: { type: 'string', maxLength: 200 },
                        // build: baked in at build time; runtime-be: switched live (a backend, a flag service, ...).
                        source: { type: 'string', enum: ['build', 'runtime-be'] },
                        changedBy: { type: 'string', minLength: 1, maxLength: 100 },
                        observations: {
                            type: 'array',
                            maxItems: 5000,
                            items: {
                                type: 'object',
                                required: ['key', 'env', 'enabled'],
                                additionalProperties: false,
                                properties: {
                                    key: FLAG_KEY,
                                    env: { type: 'string', enum: ['test', 'qa', 'prod'] },
                                    enabled: { type: 'boolean' },
                                    // Accepted by the contract (FLAG-INGEST.pl.md) but not used yet.
                                    observedAt: { type: 'string', maxLength: 64 },
                                    changedBy: { type: 'string', maxLength: 100 },
                                    value: {},
                                    kind: { type: 'string', maxLength: 32 },
                                },
                            },
                        },
                        flags: {
                            type: 'array',
                            maxItems: 5000,
                            items: {
                                type: 'object',
                                required: ['key'],
                                additionalProperties: false,
                                properties: {
                                    key: FLAG_KEY,
                                    description: { type: ['string', 'null'], maxLength: 500 },
                                    jiraKeys: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9}$' } },
                                },
                            },
                        },
                    },
                },
            },
        }, async (request) => {
            const match = /^Bearer (\S+)$/.exec(request.headers.authorization || '');
            return ingestFlags(pool, { token: match ? match[1] : '', payload: request.body });
        });

        const tokenRepoParams = { type: 'object', required: ['tenantId', 'repoId'], properties: { tenantId: UUID_PARAM, repoId: GITHUB_ID_PARAM } };
        app.post('/tenants/:tenantId/repos/:repoId/ingest-tokens', {
            preHandler: requireUser,
            schema: {
                params: tokenRepoParams,
                body: {
                    type: 'object',
                    required: ['label'],
                    additionalProperties: false,
                    properties: { label: { type: 'string', minLength: 1, maxLength: 100 } },
                },
            },
        }, async (request, reply) => {
            const created = await createIngestToken(pool, {
                tenantId: request.params.tenantId, actorUserId: request.user.id, repoId: Number(request.params.repoId), label: request.body.label,
            });
            if (!created) return reply.code(404).send({ error: 'That repository is not tracked' });
            return reply.code(201).send(created);
        });

        app.get('/tenants/:tenantId/ingest-tokens', {
            preHandler: requireUser,
            schema: { params: tenantOnlyParams },
        }, async (request) => ({ tokens: await listIngestTokens(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id }) }));

        app.delete('/tenants/:tenantId/ingest-tokens/:tokenId', {
            preHandler: requireUser,
            schema: { params: { type: 'object', required: ['tenantId', 'tokenId'], properties: { tenantId: UUID_PARAM, tokenId: UUID_PARAM } } },
        }, async (request, reply) => {
            const removed = await revokeIngestToken(pool, { tenantId: request.params.tenantId, actorUserId: request.user.id, tokenId: request.params.tokenId });
            if (!removed) return reply.code(404).send({ error: 'No such ingest token' });
            return reply.code(204).send();
        });
    }

    // The dashboard for one tenant: the existing docs/ page, whose app-data.js recognizes /t/<tenantId>/ and
    // loads its data from /api/tenants/<tenantId>/dashboard-data instead of data/*.json.
    function registerDashboardRoutes() {
        const assets = loadDashboardAssets(dashboardDir);
        if (!assets.has('index.html')) app.log.warn(`dashboard files not found in ${dashboardDir}; /t/:tenantId/ will answer 503`);
        const tenantParams = { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } };

        app.get('/', async (request, reply) => {
            const user = await getSessionUser(pool, request.cookies[SESSION_COOKIE]);
            if (!user) return reply.redirect('/auth/github/login');
            const tenants = await listTenantsForUser(pool, user.id);
            return reply.redirect(tenants.length ? `/t/${tenants[0].id}/` : '/me');
        });

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
    }

    async function assertMemberOf(tenantId, userId) {
        await withScope(pool, { tenantId }, async (client) => {
            if (!(await roleOf(client, { tenantId, userId }))) throw new TenantNotFoundError('Tenant not found');
        });
    }

    // FR-004/FR-006: connecting a tenant to GitHub through the App, and choosing tracked repos.
    function registerGitHubRoutes() {
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

    async function assertAdminOf(tenantId, userId) {
        await withScope(pool, { tenantId }, (client) => assertAdmin(client, { tenantId, userId }));
    }

    return app;
}

if (require.main === module) {
    const auth = loadAuthConfig(process.env);
    const githubApp = loadGitHubAppConfig(process.env);
    const pool = createPool();
    const app = buildApp({ pool, auth, githubApp, logger: true, dashboardDir: process.env.DASHBOARD_DIR || DEFAULT_DASHBOARD_DIR });
    const port = Number(process.env.PORT) || 3000;
    app.listen({ port, host: '0.0.0.0' }).catch((err) => {
        console.error(err);
        process.exit(1);
    });

    process.on('SIGTERM', () => {
        app.close().then(() => pool.end()).then(() => process.exit(0));
    });
}

module.exports = { buildApp };
