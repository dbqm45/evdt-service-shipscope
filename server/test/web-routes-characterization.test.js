// Characterization test (eng-behavior-preserving-refactoring) for the server/web.js -> server/routes/*
// split (design-docs/REPORT_ARCH.md, Problem 1 / priority D): captures the exact route tree a fully
// configured app registers today, BEFORE the file is split into per-domain Fastify route modules. The
// split must not add, remove, or change the method/path of a single route — this is the proof. It is
// expected to pass immediately, not fail red; that's the point of a characterization test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../web');

const FULLY_CONFIGURED = {
    pool: { query: async () => ({ rows: [] }) },
    auth: { githubClientId: 'x', githubClientSecret: 'y', publicBaseUrl: 'http://localhost:3000', secureCookies: false },
    githubApp: { slug: 'x-app', webhookSecret: 'whs', appId: '1', privateKey: 'k' },
    atlassian: { clientId: 'a', clientSecret: 'b', encryptionKey: Buffer.alloc(32), webhookUrl: null },
};

// Captured from `app.printRoutes({ commonPrefix: false })`. Sibling order under /tenants/:tenantId changed
// harmlessly when the routes/ split grouped them one domain file at a time (tenants.js's /settings and
// /deployments now register together, instead of being interleaved with invitations as they were in the
// single-file version) — Fastify's router matches by path structure, not registration order, so this does
// not change behavior; what this test actually guards is that every method+path below still exists.
const EXPECTED_ROUTES = `\
└── / (GET, HEAD)
    ├── health (GET, HEAD)
    │   └── /db (GET, HEAD)
    ├── auth/github/login (GET, HEAD)
    ├── auth/github/callback (GET, HEAD)
    ├── auth/logout (POST)
    ├── auth/atlassian/callback (GET, HEAD)
    ├── api/flags/ingest (POST)
    │   └── /schema (GET, HEAD)
    ├── api/features (GET, HEAD)
    ├── api/tenants/:tenantId/dashboard-data (GET, HEAD)
    ├── api/tenants/:tenantId/jira-issues (GET, HEAD)
    ├── me (GET, HEAD)
    ├── tenants (POST)
    │   └── /:tenantId (DELETE)
    │       ├── /members (GET, HEAD)
    │       │   └── /:userId (DELETE)
    │       ├── /settings (GET, HEAD, PUT)
    │       ├── /deployments (GET, HEAD)
    │       ├── /invitations (POST, GET, HEAD)
    │       │   └── /:invitationId (DELETE)
    │       ├── /ingest-tokens/:tokenId (DELETE)
    │       ├── /flag-sources (POST, GET, HEAD)
    │       │   └── /:sourceId (PUT, DELETE)
    │       │       └── /tokens (POST)
    │       ├── /flags (GET, HEAD)
    │       │   └── /:key (PUT)
    │       ├── /github (GET, HEAD)
    │       │   ├── /install (GET, HEAD)
    │       │   │   └── ations/:installationId (DELETE)
    │       │   │       └── /repositories (GET, HEAD)
    │       │   └── /repos/:repoId (PUT, DELETE)
    │       │       ├── /settings (PUT)
    │       │       └── /flag-stance (PUT)
    │       └── /jira (GET, HEAD, DELETE)
    │           ├── /connect (GET, HEAD)
    │           ├── /site (PUT)
    │           ├── /sync (POST)
    │           ├── /flag-fields (GET, HEAD)
    │           ├── /flag-link (PUT)
    │           ├── /boards (GET, HEAD, PUT)
    │           │   └── /:boardId (PUT)
    │           └── /projects (GET, HEAD)
    ├── t/:tenantId (GET, HEAD)
    │   └── / (GET, HEAD)
    │       ├── settings (GET, HEAD)
    │       └── :asset (GET, HEAD)
    ├── invitations/:token (GET, HEAD)
    │   └── /accept (POST)
    ├── start (GET, HEAD)
    ├── ui/:asset (GET, HEAD)
    ├── github/setup (GET, HEAD)
    ├── webhooks/github (POST)
    └── webhooks/jira (POST)
`;

test('characterizing: the full route tree (every method + path) is unchanged by the routes/ split', async () => {
    const app = buildApp(FULLY_CONFIGURED);
    try {
        await app.ready();
        assert.equal(app.printRoutes({ commonPrefix: false }), EXPECTED_ROUTES);
    } finally {
        await app.close();
    }
});

test('characterizing: auth-only route tree (no githubApp/atlassian) is unchanged by the routes/ split', async () => {
    const app = buildApp({ pool: FULLY_CONFIGURED.pool, auth: FULLY_CONFIGURED.auth });
    try {
        await app.ready();
        assert.equal(
            app.printRoutes({ commonPrefix: false }),
            `\
└── / (GET, HEAD)
    ├── health (GET, HEAD)
    │   └── /db (GET, HEAD)
    ├── auth/github/login (GET, HEAD)
    ├── auth/github/callback (GET, HEAD)
    ├── auth/logout (POST)
    ├── api/flags/ingest (POST)
    │   └── /schema (GET, HEAD)
    ├── api/features (GET, HEAD)
    ├── api/tenants/:tenantId/dashboard-data (GET, HEAD)
    ├── api/tenants/:tenantId/jira-issues (GET, HEAD)
    ├── me (GET, HEAD)
    ├── tenants (POST)
    │   └── /:tenantId (DELETE)
    │       ├── /members (GET, HEAD)
    │       │   └── /:userId (DELETE)
    │       ├── /settings (GET, HEAD, PUT)
    │       ├── /deployments (GET, HEAD)
    │       ├── /invitations (POST, GET, HEAD)
    │       │   └── /:invitationId (DELETE)
    │       ├── /ingest-tokens/:tokenId (DELETE)
    │       ├── /flag-sources (POST, GET, HEAD)
    │       │   └── /:sourceId (PUT, DELETE)
    │       │       └── /tokens (POST)
    │       └── /flags (GET, HEAD)
    │           └── /:key (PUT)
    ├── t/:tenantId (GET, HEAD)
    │   └── / (GET, HEAD)
    │       ├── settings (GET, HEAD)
    │       └── :asset (GET, HEAD)
    ├── invitations/:token (GET, HEAD)
    │   └── /accept (POST)
    ├── start (GET, HEAD)
    └── ui/:asset (GET, HEAD)
`
        );
    } finally {
        await app.close();
    }
});

test('characterizing: health-only route tree (no auth config) is unchanged by the routes/ split', async () => {
    const app = buildApp({ pool: FULLY_CONFIGURED.pool });
    try {
        await app.ready();
        assert.equal(
            app.printRoutes({ commonPrefix: false }),
            `\
└── /health (GET, HEAD)
    └── /db (GET, HEAD)
`
        );
    } finally {
        await app.close();
    }
});
