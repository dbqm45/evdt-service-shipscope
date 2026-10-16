const crypto = require('crypto');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const { createPool, checkConnection } = require('./lib/db');
const { loadAuthConfig } = require('./lib/config');
const { APP_VERSION } = require('./lib/version');
const { buildAuthorizeUrl, exchangeCode, fetchGitHubUser, GitHubOAuthError } = require('./lib/github-oauth');
const { createSession, getSessionUser, deleteSession } = require('./lib/sessions');
const { upsertUser, createTenantWithOwner, listTenantsForUser, listMembersIfMember } = require('./lib/tenants');

const SESSION_COOKIE = 'sid';
const STATE_COOKIE = 'oauth_state';
const STATE_TTL_SECONDS = 600;
const POST_LOGIN_REDIRECT = '/me'; // no frontend yet; land on the JSON identity endpoint

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Builds the Web Service. Without `auth`, only the health routes exist (used by tests that don't
 * exercise sign-in); the real entry point below always passes a validated config.
 *
 * @param {{ pool: import('pg').Pool, auth?: ReturnType<typeof loadAuthConfig>, fetch?: typeof fetch, logger?: boolean|object }} options
 * @returns {import('fastify').FastifyInstance}
 */
function buildApp({ pool, auth, fetch: fetchFn = fetch, logger = false }) {
    const app = Fastify({
        // Fastify's defaults silently strip unknown body fields and coerce types (42 -> "42"). External
        // input is rejected instead of rewritten (CLAUDE.md: validate every external boundary).
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
        logger: logger && {
            ...(typeof logger === 'object' ? logger : {}),
            // The default serializer logs the full URL; the OAuth callback's query string carries the
            // one-time authorization code and state, which must never reach logs (prd.md: credential hygiene).
            serializers: {
                req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
            },
        },
    });

    // Unexpected errors keep their detail in the log only; clients get a generic 500.
    app.setErrorHandler((err, request, reply) => {
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

    app.get('/auth/github/login', async (request, reply) => {
        const state = crypto.randomBytes(16).toString('base64url');
        reply.setCookie(STATE_COOKIE, state, { ...baseCookie, path: '/auth/github', maxAge: STATE_TTL_SECONDS });
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
        reply.clearCookie(STATE_COOKIE, { ...baseCookie, path: '/auth/github' });
        // CSRF: the state must round-trip through this browser's own cookie, or anyone could log a
        // victim into the attacker's account by getting them to open a crafted callback URL.
        if (!expectedState || !safeEqual(expectedState, request.query.state)) {
            return reply.code(400).send({ error: 'Invalid or expired sign-in attempt; please start again' });
        }

        let identity;
        try {
            const accessToken = await exchangeCode({
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
        return reply.redirect(POST_LOGIN_REDIRECT);
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

    return app;
}

if (require.main === module) {
    const auth = loadAuthConfig(process.env);
    const pool = createPool();
    const app = buildApp({ pool, auth, logger: true });
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
