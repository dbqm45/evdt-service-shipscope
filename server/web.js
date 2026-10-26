const crypto = require('crypto');
const path = require('path');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const { createPool } = require('./lib/db');
const { loadAuthConfig, loadGitHubAppConfig, loadAtlassianConfig, loadEncryptionKey, loadSealingKeys, loadMetricsToken } = require('./lib/config');
const { AtlassianError } = require('./lib/atlassian');
const { JiraNotConnectedError, JiraSiteError, WorkerUnavailableError } = require('./lib/jira-connections');
const { JiraBoardError } = require('./lib/jira-sync');
const { APP_VERSION } = require('./lib/version');
const { createLogger, logLevel, loggerOptions, logProcessFailures } = require('./lib/log');
const { GitHubApiError } = require('./lib/github-app');
const {
    TenantNotFoundError, AlreadyMemberError, ForbiddenError, LastAdminError, ConfirmationMismatchError, assertAdmin,
} = require('./lib/tenants');
const { withScope } = require('./lib/scope');
const { InvitationNotFoundError, InvitationUnusableError, TOKEN_PATTERN } = require('./lib/invitations');
const { InstallationNotFoundError, InstallationTakenError } = require('./lib/github-connections');
const { IngestTokenError, IngestScopeError, IngestBusyError, IngestPayloadError, FlagSourceNotFoundError, FlagSourceConflictError, FlagSourceConfigError, FlagNotFoundError } = require('./lib/flags');
const { getSessionUser } = require('./lib/sessions');
const { mockDataEnabled, loadMockDashboard } = require('./lib/mock-dashboard');

const { registerHealthRoutes } = require('./routes/health');
const { registerAuthRoutes } = require('./routes/auth');
const { registerTenantRoutes } = require('./routes/tenants');
const { registerInvitationRoutes } = require('./routes/invitations');
const { registerFlagRoutes, IngestRateLimitError } = require('./routes/flags');
const { createOidcVerifier } = require('./lib/github-oidc');
const { createMetrics } = require('./lib/metrics');
const { sampleStatus } = require('./lib/status-page');
const { workerHealth } = require('./lib/worker-status');

const STATUS_SAMPLE_INTERVAL_MS = 60_000;
const { registerDashboardRoutes } = require('./routes/dashboard');
const { registerWebhookRoutes } = require('./routes/webhooks');
const { registerGitHubRoutes } = require('./routes/github');
const { registerJiraRoutes } = require('./routes/jira');

const SESSION_COOKIE = 'sid';
// FR-004: GitHub App installation round trip's last leg lives in both routes/github.js (sets it) and
// routes/auth.js (reads it in the callback) — the only cookie genuinely shared across two route files.
const LINK_COOKIE = 'gh_link';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The pages (dashboard, settings, start, invitation) load scripts only from this server, and none inline: an
// escaping slip in the markup can then not run script. Inline style attributes stay allowed (bar widths and the
// like are set from data); fonts come from Google Fonts; fetch() goes only to this server.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');
const DASHBOARD_HEADERS = {
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'content-security-policy': CONTENT_SECURITY_POLICY,
};
const STATE_TTL_SECONDS = 600;
const POST_LOGIN_REDIRECT = '/'; // which redirects on to the user's first tenant's dashboard
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Where sign-in may send the user back to: an invitation link or a tenant's dashboard. An allowlist, not
// "any relative path": a looser check (e.g. "starts with /") still lets "//evil.example" through as a
// protocol-relative open redirect.
const RETURN_TO_PATTERN = new RegExp(`^(/invitations/${TOKEN_PATTERN.source.slice(1, -1)}|/t/${UUID_SOURCE}/(settings)?|/start)$`);
const DEFAULT_DASHBOARD_DIR = path.join(__dirname, '..', 'docs');
const UI_DIR = path.join(__dirname, 'ui');

const UUID_PARAM = { type: 'string', format: 'uuid' };
const TOKEN_PARAM = { type: 'string', pattern: TOKEN_PATTERN.source };
const GITHUB_ID_PARAM = { type: 'string', pattern: '^[1-9][0-9]{0,14}$' };

/** Domain errors from lib/ and the HTTP status each one means. */
const { EventSubscriptionError } = require('./lib/outgoing-events');
const ERROR_STATUS = [
    [TenantNotFoundError, 404],
    [InvitationNotFoundError, 404],
    [ForbiddenError, 403],
    [AlreadyMemberError, 409],
    [LastAdminError, 409],
    [ConfirmationMismatchError, 400],
    [FlagNotFoundError, 404],
    [InvitationUnusableError, 410],
    [InstallationNotFoundError, 404],
    [InstallationTakenError, 409],
    [GitHubApiError, 502],
    [IngestTokenError, 401],
    [IngestPayloadError, 400],
    [IngestScopeError, 403],
    [IngestRateLimitError, 429],
    [IngestBusyError, 503],
    [FlagSourceNotFoundError, 404],
    [FlagSourceConflictError, 409],
    [FlagSourceConfigError, 400],
    [JiraNotConnectedError, 409],
    [WorkerUnavailableError, 503],
    [JiraSiteError, 400],
    [JiraBoardError, 400],
    [AtlassianError, 502],
    [EventSubscriptionError, 400],
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
 * The dashboard (docs/) is served at /t/<tenantId>/ from `dashboardDir`. With `mockDashboard`
 * (lib/mock-dashboard.js, `npm run dev:mock`), its data routes answer members with the sample dataset.
 *
 * Routes live one domain per file under routes/ (design-docs/REPORT_ARCH.md, Problem 1): this function is
 * the composition root — it builds the Fastify instance, the central error handler (every domain's error
 * types map to an HTTP status in one place, since Fastify has exactly one error handler per instance), and
 * the small set of cross-domain helpers (requireUser, assertAdminOf, ...) every route file receives through
 * `ctx` instead of its own copy.
 *
 * @param {{ pool: import('pg').Pool, auth?: ReturnType<typeof loadAuthConfig>, githubApp?: ReturnType<typeof loadGitHubAppConfig>, atlassian?: ReturnType<typeof loadAtlassianConfig>, fetch?: typeof fetch, logger?: boolean|object, dashboardDir?: string, mockDashboard?: { data: object, issuesByPi: Record<string, object[]> }|null, ingestRateLimit?: { capacity: number, refillPerSecond: number }, syncIntervalMinutes?: number, encryptionKey?: Buffer|null, sealingKeys?: { publicKey: object, privateKeys: object[] }|null, safeFetch?: Function, oidcVerifier?: { verify: Function }|null, metricsToken?: string|null }} options
 *   `encryptionKey` (TOKEN_ENCRYPTION_KEY, default the Atlassian config's) seals endpoint tokens and signs endpoint
 *   requests; `sealingKeys` (the public key only) seals endpoint tokens for the worker; `safeFetch` replaces
 *   lib/safe-fetch.js's in tests
 * @returns {import('fastify').FastifyInstance}
 */
function buildApp({ pool, auth, githubApp = null, atlassian = null, fetch: fetchFn = fetch, logger = false, dashboardDir = DEFAULT_DASHBOARD_DIR, mockDashboard = null, ingestRateLimit = null, syncIntervalMinutes = 15, encryptionKey = atlassian ? atlassian.encryptionKey : null, sealingKeys = null, safeFetch = null, oidcVerifier = undefined, metricsToken = null }) {
    const app = Fastify({
        // A request id on every log line of a request and in the response (X-Request-Id), so a user's report can be
        // matched to the logs; one sent by the caller (Render's proxy, a load balancer) is kept.
        requestIdHeader: 'x-request-id',
        requestIdLogLabel: 'requestId',
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
            if (err instanceof AtlassianError) request.log.warn({ err: err.message }, 'Atlassian API call failed');
            // Why a request was refused, next to its "request completed" line (the reason is ours, never a secret).
            else if (!(err instanceof GitHubApiError)) request.log.info({ reason: err.message, statusCode: mapped[1] }, 'request refused');
            const body = {
                error: err instanceof GitHubApiError ? 'GitHub request failed; please try again'
                    : err instanceof AtlassianError ? 'Jira request failed; please try again' : err.message,
            };
            if (err instanceof InvitationUnusableError) body.status = err.status;
            if (err.retryAfterSeconds) reply.header('Retry-After', String(err.retryAfterSeconds));
            return reply.code(mapped[1]).send(body);
        }
        if (err.statusCode && err.statusCode < 500) {
            request.log.info({ reason: err.message, statusCode: err.statusCode }, 'request refused');
            return reply.code(err.statusCode).send({ error: err.message });
        }
        request.log.error(err);
        return reply.code(500).send({ error: 'Internal Server Error' });
    });

    app.addHook('onRequest', async (request, reply) => {
        reply.header('X-Request-Id', request.id);
    });
    // Whose request it was, on every line logged for it (the "request completed" line included).
    app.addHook('preHandler', async (request) => {
        const tenantId = request.params && request.params.tenantId;
        if (tenantId && request.log.setBindings) request.log.setBindings({ tenantId });
    });

    // Counted for GET /metrics (lib/metrics.js): every answer, by its route's pattern, never its URL.
    const metrics = createMetrics();
    app.addHook('onResponse', async (request, reply) => metrics.observe(request.routeOptions && request.routeOptions.url, reply.statusCode));
    registerHealthRoutes(app, { pool, expectWorker: { deployments: !!githubApp, jira: !!atlassian, flags: !!encryptionKey }, syncIntervalMinutes, metrics, metricsToken, pageHeaders: DASHBOARD_HEADERS });

    if (!auth) return app;

    app.register(cookie);

    const baseCookie = { httpOnly: true, sameSite: 'lax', secure: auth.secureCookies };

    async function requireUser(request, reply) {
        request.user = await getSessionUser(pool, request.cookies[SESSION_COOKIE]);
        if (!request.user) return reply.code(401).send({ error: 'Not signed in' });
        if (request.log.setBindings) request.log.setBindings({ userId: request.user.id });
    }

    // For links people open in a browser (invitations): send them through sign-in and back, instead of a 401.
    async function requireUserOrSignIn(request, reply) {
        request.user = await getSessionUser(pool, request.cookies[SESSION_COOKIE]);
        if (!request.user) return reply.redirect(`/auth/github/login?returnTo=${encodeURIComponent(request.url.split('?')[0])}`);
    }

    async function assertAdminOf(tenantId, userId) {
        await withScope(pool, { tenantId }, (client) => assertAdmin(client, { tenantId, userId }));
    }

    const ctx = {
        pool, auth, githubApp, atlassian, fetchFn, baseCookie, encryptionKey, sealingKeys, safeFetch,
        // GitHub Actions OIDC tokens on the flags ingest are addressed to this server's public origin (lib/github-oidc.js).
        oidcVerifier: oidcVerifier !== undefined ? oidcVerifier : auth && auth.publicBaseUrl ? createOidcVerifier({ audience: auth.publicBaseUrl }) : null,
        requireUser, requireUserOrSignIn, assertAdminOf,
        safeEqual, splitCookie,
        cookies: { SESSION_COOKIE, LINK_COOKIE },
        UUID_PATTERN, UUID_PARAM, TOKEN_PARAM, GITHUB_ID_PARAM,
        STATE_TTL_SECONDS, POST_LOGIN_REDIRECT, RETURN_TO_PATTERN,
        DASHBOARD_HEADERS, dashboardDir, UI_DIR, mockDashboard, ingestRateLimit,
        // Set by registerDashboardRoutes() once ui/invite.html is confirmed deployed; read lazily by
        // registerInvitationRoutes() — a mutable slot instead of a return value because the invitation
        // route is registered before the dashboard routes, and only the *value at request time* matters.
        ui: { sendUiPage: null },
    };

    registerAuthRoutes(app, ctx);
    registerTenantRoutes(app, ctx);
    registerInvitationRoutes(app, ctx);
    registerFlagRoutes(app, ctx);
    registerDashboardRoutes(app, ctx);
    registerWebhookRoutes(app, ctx);
    if (githubApp) registerGitHubRoutes(app, ctx);
    if (atlassian) registerJiraRoutes(app, ctx);

    return app;
}

if (require.main === module) {
    const auth = loadAuthConfig(process.env);
    const githubApp = loadGitHubAppConfig(process.env);
    const atlassian = loadAtlassianConfig(process.env);
    const encryptionKey = loadEncryptionKey(process.env);
    // The public half only: the web service seals endpoint tokens it can never read back.
    const sealingKeys = loadSealingKeys(process.env, { withPrivate: false });
    // Jira refresh tokens too: sealed for the worker, which hands this service short-lived access tokens.
    if (atlassian) atlassian.sealingKeys = sealingKeys;
    const pool = createPool();
    const dashboardDir = process.env.DASHBOARD_DIR || DEFAULT_DASHBOARD_DIR;
    const mockDashboard = mockDataEnabled(process.env) ? loadMockDashboard(dashboardDir) : null;
    const level = logLevel(process.env);
    const log = createLogger({ service: 'web', level, base: { version: APP_VERSION } });
    logProcessFailures(log);
    pool.on('error', (err) => log.error('idle database connection failed', { err }));
    if (mockDashboard) log.warn('SHIPSCOPE_MOCK_DATA=1: every dashboard shows the built-in sample data');
    const syncIntervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES) || 15;
    const metricsToken = loadMetricsToken(process.env);
    const app = buildApp({ pool, auth, githubApp, atlassian, encryptionKey, sealingKeys, logger: loggerOptions({ level, version: APP_VERSION }), dashboardDir, mockDashboard, syncIntervalMinutes, metricsToken });
    // Once a minute, today's sample for the status page (lib/status-page.js); a failure is logged, never fatal.
    const expectWorker = { deployments: !!githubApp, jira: !!atlassian, flags: !!encryptionKey };
    setInterval(() => {
        workerHealth(pool, { expect: expectWorker, syncIntervalMinutes })
            .then((health) => sampleStatus(pool, { health }))
            .catch((err) => log.warn('status sample failed', { err }));
    }, STATUS_SAMPLE_INTERVAL_MS).unref();
    const port = Number(process.env.PORT) || 3000;
    app.listen({ port, host: '0.0.0.0' }).then(() => {
        log.info('web started', { port, github: !!githubApp, jira: !!atlassian, logLevel: level });
    }).catch((err) => {
        log.error('web failed to start', { err });
        process.exit(1);
    });

    process.on('SIGTERM', () => {
        log.info('web stopping (SIGTERM)');
        app.close().then(() => pool.end()).then(() => process.exit(0));
    });
}

module.exports = { buildApp };
