const crypto = require('crypto');
const { buildAuthorizeUrl, exchangeCode, fetchGitHubUser, GitHubOAuthError } = require('../lib/github-oauth');
const { createSession, getSessionUser, deleteSession } = require('../lib/sessions');
const { upsertUser, listTenantsForUser } = require('../lib/tenants');
const { getInstallation, userCanAccessInstallation } = require('../lib/github-app');
const { linkInstallation } = require('../lib/github-connections');
const { createSuiteClient, SuiteSignInError } = require('../lib/suite-oidc');
const { suiteRole, upsertSuiteUser, syncSuiteMemberships } = require('../lib/suite-members');

const STATE_COOKIE = 'oauth_state';
const RETURN_TO_COOKIE = 'oauth_return_to';
const SUITE_STATE_COOKIE = 'suite_state';

/**
 * Sign-in with GitHub (not the GitHub App): `/auth/github/login`, `/auth/github/callback`,
 * `POST /auth/logout`, `GET /me`. The callback also finishes the FR-004 installation-link round trip
 * (ctx's LINK_COOKIE) when one is pending, since that step needs this user's own fresh GitHub token.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx see web.js's buildApp() for the full shape
 */
function registerAuthRoutes(app, ctx) {
    const { pool, auth, githubApp, fetchFn, baseCookie, requireUser, safeEqual, splitCookie, suite, DASHBOARD_HEADERS,
        cookies: { SESSION_COOKIE, LINK_COOKIE }, UUID_PATTERN, STATE_TTL_SECONDS, RETURN_TO_PATTERN, POST_LOGIN_REDIRECT } = ctx;
    const redirectUri = `${auth.publicBaseUrl}/auth/github/callback`;
    const returnToQuery = {
        type: 'object',
        additionalProperties: false,
        properties: { returnTo: { type: 'string', pattern: RETURN_TO_PATTERN.source } },
    };
    const withReturnTo = (path, returnTo) => (returnTo ? `${path}?returnTo=${encodeURIComponent(returnTo)}` : path);

    // Where a browser without a session signs in (design-docs/SUITE-LOGIN-PLAN.pl.md): straight to GitHub, or, with the
    // suite's identity service set up, a page offering both. No script, so the pages' Content-Security-Policy holds.
    app.get('/auth/login', { schema: { querystring: returnToQuery } }, async (request, reply) => {
        const { returnTo } = request.query;
        if (!suite) return reply.redirect(withReturnTo('/auth/github/login', returnTo));
        const github = withReturnTo('/auth/github/login', returnTo);
        const suiteUrl = withReturnTo('/auth/suite/login', returnTo);
        return reply.headers(DASHBOARD_HEADERS).type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ShipScope</title><link rel="stylesheet" href="/ui/style.css"></head>
<body class="sign-in"><main class="sign-in-card"><h1>Sign in to ShipScope</h1>
<p><a class="btn btn-primary" href="${github}">Sign in with GitHub</a></p>
<p><a class="btn" href="${suiteUrl}">Sign in with the suite</a></p>
</main></body></html>`);
    });

    if (suite) {
        const client = createSuiteClient({ ...suite, redirectUri: `${auth.publicBaseUrl}/auth/suite/callback`, fetch: fetchFn });
        const suiteCookie = { ...baseCookie, path: '/auth/suite', maxAge: STATE_TTL_SECONDS };
        const readChecks = (value) => {
            try {
                const c = JSON.parse(Buffer.from(value || '', 'base64url').toString('utf8'));
                const ok = c && ['state', 'nonce', 'verifier'].every((k) => typeof c[k] === 'string' && /^[\w-]{20,100}$/.test(c[k]))
                    && (c.returnTo === undefined || (typeof c.returnTo === 'string' && RETURN_TO_PATTERN.test(c.returnTo)));
                return ok ? c : null;
            } catch {
                return null;
            }
        };

        app.get('/auth/suite/login', { schema: { querystring: returnToQuery } }, async (request, reply) => {
            let started;
            try {
                started = await client.start();
            } catch (err) {
                request.log.warn({ err: err.message }, 'the suite identity service is not reachable');
                return reply.code(502).send({ error: 'The suite identity service is not reachable; please try again' });
            }
            const checks = { ...started.checks, ...(request.query.returnTo ? { returnTo: request.query.returnTo } : {}) };
            reply.setCookie(SUITE_STATE_COOKIE, Buffer.from(JSON.stringify(checks)).toString('base64url'), suiteCookie);
            return reply.redirect(started.url);
        });

        app.get('/auth/suite/callback', {
            schema: {
                querystring: {
                    type: 'object',
                    properties: {
                        code: { type: 'string', minLength: 1, maxLength: 2000 },
                        state: { type: 'string', minLength: 1, maxLength: 200 },
                        error: { type: 'string', maxLength: 200 },
                        error_description: { type: 'string', maxLength: 1000 },
                        session_state: { type: 'string', maxLength: 200 },
                        iss: { type: 'string', maxLength: 500 },
                    },
                },
            },
        }, async (request, reply) => {
            const checks = readChecks(request.cookies[SUITE_STATE_COOKIE]);
            reply.clearCookie(SUITE_STATE_COOKIE, { ...baseCookie, path: '/auth/suite' });
            // CSRF, as for GitHub: the state must come back through this browser's own cookie.
            if (!checks || !request.query.state || !safeEqual(checks.state, request.query.state)) {
                return reply.code(400).send({ error: 'Invalid or expired sign-in attempt; please start again' });
            }
            if (request.query.error || !request.query.code) {
                return reply.code(403).send({ error: 'The sign-in was cancelled or refused at the suite' });
            }
            let person;
            try {
                person = await client.finish({ code: request.query.code, checks });
            } catch (err) {
                if (!(err instanceof SuiteSignInError) && !(err instanceof TypeError) && err.name !== 'TimeoutError') throw err;
                request.log.warn({ err: err.message }, 'suite sign-in failed');
                return reply.code(502).send({ error: 'The suite sign-in failed; please try again' });
            }
            const user = await upsertSuiteUser(pool, { sub: person.sub, name: person.name });
            const changes = await syncSuiteMemberships(pool, {
                userId: user.id, displayName: user.displayName, organizations: person.organizations, role: suiteRole(person.roles),
            });
            for (const { tenantId, change } of changes) {
                if (change === 'kept_last_admin') request.log.warn({ tenantId, userId: user.id }, 'the suite would lower the last admin; kept as admin');
            }
            const session = await createSession(pool, user.id);
            reply.setCookie(SESSION_COOKIE, session.token, { ...baseCookie, path: '/', expires: session.expiresAt });
            return reply.redirect(checks.returnTo && RETURN_TO_PATTERN.test(checks.returnTo) ? checks.returnTo : POST_LOGIN_REDIRECT);
        });
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

        // Linking an installation for someone already signed in (a suite person, design-docs/SUITE-LOGIN-PLAN.pl.md
        // step 2, or a GitHub user): GitHub's token only proves this browser reaches the installation. The session stays
        // theirs, they are the one who links it, and no GitHub user is created or stored.
        const current = link ? await getSessionUser(pool, request.cookies[SESSION_COOKIE]) : null;
        let user = current;
        if (!user) {
            user = await upsertUser(pool, identity);
            const session = await createSession(pool, user.id);
            reply.setCookie(SESSION_COOKIE, session.token, { ...baseCookie, path: '/', expires: session.expiresAt });
        }

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
