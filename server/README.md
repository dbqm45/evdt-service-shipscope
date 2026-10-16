# ShipScope server

The SaaS-pivot backend scoped by `@context/foundation/prd.md`, deployed to Render (see
`@context/foundation/infrastructure.md` for why Render). What exists so far:

- **Pipeline proof** (`web.js` health routes, `worker.js` heartbeat): a Web Service and a Background Worker
  both deploy and both reach a real Postgres instance.
- **Tenant data model** (FR-002/FR-003, `lib/tenants.js`): tenants, users and admin/member memberships, with
  Row-Level Security on `memberships`.
- **GitHub sign-in** (FR-001, `web.js` + `lib/github-oauth.js` + `lib/sessions.js`): sign in through the
  ShipScope GitHub App, server-side sessions, create a tenant and list its members over HTTP.

Not yet: inviting members over HTTP, installing the GitHub App on repos, Jira OAuth, any dashboard data.

This directory is a separate dependency boundary from the repo root: its own `package.json` and the **only
place in this repo with third-party dependencies** (`pg`, `fastify`, `@fastify/cookie` — see `@CLAUDE.md`'s
"Backend (server/)" section). Root `npm test` still only runs the top-level `test/*.test.js` scripts.

## HTTP API

| Route | Auth | What it does |
|---|---|---|
| `GET /health` | — | Liveness (Render health check). |
| `GET /health/db` | — | Postgres reachability; 503 if not. |
| `GET /auth/github/login` | — | Sets a short-lived `oauth_state` cookie and redirects to GitHub. |
| `GET /auth/github/callback` | — | Checks `state` against the cookie (CSRF), exchanges the code, upserts the user, sets the `sid` session cookie, redirects to `/me`. |
| `POST /auth/logout` | session | Deletes the session, clears the cookie. 204. |
| `GET /me` | session | `{ user, tenants: [{ id, name, role }] }`. |
| `POST /tenants` | session | Body `{ "name": "..." }`. Creates a tenant with the caller as admin. 201. |
| `GET /tenants/:tenantId/members` | session + member | Members with roles. 404 for a tenant you're not in, same as one that doesn't exist. |

Request bodies, query strings and params are validated strictly (unknown fields and wrong types are a 400,
not stripped or coerced).

## Security model

- **Sessions**: a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` when
  `PUBLIC_BASE_URL` is https), valid 14 days. Postgres stores only its SHA-256, so a database dump can't be
  replayed as a session. Expired rows are ignored on lookup (not yet deleted by any job).
- **GitHub token**: the user access token from sign-in is used once to read `GET /user` and then discarded,
  never stored.
- **Logs**: request logs strip the query string, so the OAuth `code`/`state` never reach them. Unexpected
  errors return a generic 500; details stay in the log.
- **Tenant isolation (RLS)**: every `memberships` query runs through `lib/scope.js`'s `withScope()`, which
  sets `app.current_tenant_id` / `app.current_user_id` with `set_config(..., true)` inside one transaction.
  Those settings end with the transaction, so a pooled connection can't carry a tenant into the next request.
  Policies (migration `002`): read your tenant's rows or your own rows; write only into the scoped tenant.
  An unscoped query fails closed: zero rows, or an RLS error for a write.

## Running locally

1. Start Postgres and apply migrations:

   ```bash
   docker run -d --name shipscope-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
   npm install
   cp .env.example .env            # gitignored
   node --env-file=.env scripts/migrate.js
   ```

   `DATABASE_SSL=false` (already in `.env.example`) is required for this local container: `lib/db.js`
   uses TLS by default because Render's Postgres requires it.

2. Register a GitHub App for development (GitHub → Settings → Developer settings → GitHub Apps → New):
   - **Callback URL**: `http://localhost:3000/auth/github/callback`
   - **Webhook**: untick "Active" (not used yet)
   - **Permissions**: none needed for sign-in
   - Copy the **Client ID**, generate a **client secret**, put both in `.env`.

   Use a separate GitHub App (or add a second callback URL) for the deployed environment.

3. `npm run dev`, then open `http://localhost:3000/auth/github/login`. After GitHub you land on `/me`.
   Create a tenant with e.g. `fetch('/tenants', { method: 'POST', headers: { 'content-type':
   'application/json' }, body: JSON.stringify({ name: 'Acme' }) })` from the browser console on that page.

Other commands: `npm start` (Web Service, env from the process), `npm run worker` (heartbeat loop),
`npm run migrate` (pending `migrations/*.sql`).

## Testing

`npm test` runs this directory's `node:test` suite. Unit tests (mocked pool, mocked GitHub via an injected
`fetch`, Fastify's `app.inject()` — no network, no credentials) always run. The real-Postgres tests
(`migrate`, `tenants`, `rls`, `auth-flow`) are skipped unless `TEST_DATABASE_URL` is set:

```bash
docker run -d --name shipscope-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node scripts/setup-test-db.js
TEST_DATABASE_URL=postgres://shipscope_app:shipscope_app@localhost:5432/postgres npm test
```

`setup-test-db.js` idempotently creates a non-superuser `shipscope_app` role. Tests run as this role (not
the container's superuser) so `FORCE ROW LEVEL SECURITY` is genuinely exercised, the same way Render's
single app role experiences it in production. Each test file gets its own ephemeral schema (migrated fresh,
dropped on teardown), so test files can run in parallel. CI (`.github/workflows/server-test.yml`) does the
same against a `postgres:16-alpine` service container. `auth-flow.test.js` drives the whole sign-in flow
against a fake GitHub, so CI needs no GitHub credentials.

## Deployment

Declared as Render Blueprint services in `@render.yaml` at the repo root (`rootDir: server` for both the Web
Service and the Background Worker). The Web Service refuses to start without `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET` and `PUBLIC_BASE_URL`; set them in Render's environment settings (they're declared
with `sync: false`, so Render asks for them and never reads them from the repo). Migrations are not run
automatically on deploy yet: run `npm run migrate` against the Render database after a deploy that adds one.
See `@context/foundation/infrastructure.md`'s "Getting Started" and "Operational Story" sections for the full
deploy/rollback/secrets workflow.
