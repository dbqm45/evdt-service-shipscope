const crypto = require('crypto');
const { buildAuthorizeUrl, exchangeCode, fetchGitHubUser, GitHubOAuthError } = require('../lib/github-oauth');
const { createSession, getSessionUser, deleteSession } = require('../lib/sessions');
const { upsertUser, listTenantsForUser } = require('../lib/tenants');
const { getInstallation, userCanAccessInstallation } = require('../lib/github-app');
const { linkInstallation } = require('../lib/github-connections');

const STATE_COOKIE = 'oauth_state';
const RETURN_TO_COOKIE = 'oauth_return_to';

/**
 * Sign-in with GitHub (not the GitHub App): `/auth/github/login`, `/auth/github/callback`,
 * `POST /auth/logout`, `GET /me`. The callback also finishes the FR-004 installation-link round trip
 * (ctx's LINK_COOKIE) when one is pending, since that step needs this user's own fresh GitHub token.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerAuthRoutes(app, ctx) {
    const { pool, auth, githubApp, fetchFn, baseCookie, requireUser, safeEqual, splitCookie,
        cookies: { SESSION_COOKIE, LINK_COOKIE }, UUID_PATTERN, STATE_TTL_SECONDS, RETURN_TO_PATTERN, POST_LOGIN_REDIRECT } = ctx;
    const redirectUri = `${auth.publicBaseUrl}/auth/github/callback`;

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
            return reply.redirect(`/t/${tenantId}/settings#github`);
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
}

module.exports = { registerAuthRoutes };
