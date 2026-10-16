# ShipScope server

The SaaS-pivot backend scoped by `@context/foundation/prd.md`, deployed to Render (see
`@context/foundation/infrastructure.md` for why Render). What exists so far:

- **Pipeline proof** (`web.js` health routes, `worker.js` heartbeat): a Web Service and a Background Worker
  both deploy and both reach a real Postgres instance.
- **Tenant data model** (FR-002/FR-003, `lib/tenants.js`): tenants, users and admin/member memberships, with
  Row-Level Security on `memberships`.
- **GitHub sign-in** (FR-001, `web.js` + `lib/github-oauth.js` + `lib/sessions.js`): sign in through the
  ShipScope GitHub App, server-side sessions, create a tenant and list its members over HTTP.
- **Invitations and member management** (FR-003, `lib/invitations.js`): admins create one-time invitation
  links; the invitee signs in and accepts. Admins remove members, members can leave, a tenant always keeps an admin.

- **GitHub App connection** (FR-004/FR-006, `lib/github-app.js` + `lib/github-connections.js`): an admin
  installs the ShipScope GitHub App on their organization's repos, links that installation to the tenant and
  chooses which of its repos to track.

- **Deployment ingestion** (FR-005, `worker.js` + `lib/deployment-sync.js`): every 15 minutes the Background
  Worker pulls new GitHub deployments of every tracked repo into the tenant's `deployments` table, with the
  Jira issue keys from each deploy's commit range and rollback detection. A daily cleanup applies the tenant's
  retention (`lib/retention.js`).

- **Dashboard** (`docs/`, served by the Web Service at `/t/<tenantId>/`): the existing page, whose
  `app-data.js` recognizes that path and loads the tenant's data from `/api/tenants/<tenantId>/dashboard-data`
  (same shapes as the file-based `data/*.json`) instead of static files.

Not yet: version from releases/tags/`versionFile`, environment drift (so the dashboard's "in sync" tiles have
nothing to flag yet), the `manual` flag and display names (the file-based sync has them; every record keeps its
sha so they can be added later), flags and Jira data in the database (those dashboard panels are empty), GitHub
webhooks, Jira OAuth.

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
| `DELETE /tenants/:tenantId/members/:userId` | session + admin, or yourself | Removes a member or leaves. 409 for the last admin. 204. |
| `POST /tenants/:tenantId/invitations` | session + admin | Body `{ "role": "member" \| "admin" }`. Returns `{ invitation: { id, role, expiresAt }, url }`; the URL is shown only here. 201. |
| `GET /tenants/:tenantId/invitations` | session + admin | Pending invitations (id, role, creator, expiry), never their tokens. |
| `DELETE /tenants/:tenantId/invitations/:invitationId` | session + admin | Revokes a pending invitation. 204, or 404 if not pending. |
| `GET /invitations/:token` | session (else sign-in and back) | `{ tenant, role, status, alreadyMember }`; `status` is `pending`, `accepted`, `revoked` or `expired`. |
| `POST /invitations/:token/accept` | session | Joins the tenant with the invitation's role. 201; 404 unknown, 410 no longer pending (with `status`), 409 already a member. |

GitHub App routes (only when the `GITHUB_APP_*` variables are set):

| Route | Auth | What it does |
|---|---|---|
| `GET /tenants/:tenantId/github` | session + member | `{ installations: [{ installationId, accountLogin, accountType }], repos: [{ repoId, fullName, installationId }] }`. |
| `GET /tenants/:tenantId/github/install` | session + admin | Redirects to GitHub to install the App (state cookie). |
| `GET /github/setup` | session | The App's Setup URL. Checks the state, then signs the user in again so the callback can verify the installation (below) and link it; ends on `/tenants/:tenantId/github`. `setup_action=request` (an org owner must approve) returns 202. |
| `GET /tenants/:tenantId/github/installations/:installationId/repositories` | session + admin | The installation's repos from GitHub, each with `tracked`. |
| `PUT /tenants/:tenantId/github/repos/:repoId` | session + admin | Body `{ "installationId": 123 }`. Tracks the repo if GitHub lists it for that installation. Idempotent. |
| `DELETE /tenants/:tenantId/github/repos/:repoId` | session + admin | Stops tracking. 204, or 404. |
| `DELETE /tenants/:tenantId/github/installations/:installationId` | session + admin | Unlinks the installation and its tracked repos (it stays installed on GitHub). 204, or 404. |

Dashboard:

| Route | Auth | What it does |
|---|---|---|
| `GET /` | — | Signed out: to sign-in. Signed in: to the first tenant's dashboard, or `/me` without a tenant. |
| `GET /t/:tenantId/` | session + member (else sign-in and back) | The dashboard page (`docs/index.html`, minus its `data/*.json` preload hints). |
| `GET /t/:tenantId/:asset` | — | `style.css`, `favicon.svg`, `app-*.js` only (the same public code GitHub Pages serves). |
| `GET /api/tenants/:tenantId/dashboard-data` | session + member | Everything the page loads, in the `data/*.json` shapes: `deployments` (repo short name as `component`, short sha as `version`), `issueDeployments`, `componentsOrder` (tracked repos), `lastSyncedAt`; flags and Jira parts empty for now. |

Deployments and settings:

| Route | Auth | What it does |
|---|---|---|
| `GET /tenants/:tenantId/deployments` | session + member | Newest first. Optional `repoId`, `environment` (`test`/`qa`/`prod`), `limit` (default 100, max 500). Each: `deploymentId, repo, environment, status, sha, deployedAt, deployedByLogin, workflowRunUrl, durationMs, commitUrl, rollbackToSha, relatedIssues, issueCommitTypes`. |
| `GET /tenants/:tenantId/settings` | session + member | `{ name, deploymentRetentionDays }`. |
| `PUT /tenants/:tenantId/settings` | session + admin | Body `{ "deploymentRetentionDays": 7..730 }` (default 90). Applied by the next daily cleanup. |

`GET /tenants/:tenantId/github` also reports each tracked repo's `lastSyncedAt` and `lastSyncError`.

A member who isn't an admin gets 403 on admin routes; someone outside the tenant gets 404, same as for a
tenant that doesn't exist.

Request bodies, query strings and params are validated strictly (unknown fields and wrong types are a 400,
not stripped or coerced).

## Security model

- **Sessions**: a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` when
  `PUBLIC_BASE_URL` is https), valid 14 days. Postgres stores only its SHA-256, so a database dump can't be
  replayed as a session. Expired rows are ignored on lookup (not yet deleted by any job).
- **GitHub token**: the user access token from sign-in is used once to read `GET /user` and then discarded,
  never stored.
- **Logs**: request logs strip the query string, so the OAuth `code`/`state` never reach them, and mask
  invitation tokens in paths (`/invitations/:token`). Unexpected errors return a generic 500; details stay in the log.
- **Invitations**: a 192-bit random token in the link, valid 7 days, single use; only its SHA-256 is stored.
  Accepting claims the invitation with one conditional `UPDATE`, so two people opening the same link at once
  can't both join. Opening a link signed out goes through sign-in and back; the return path is checked
  against an allowlist (`/invitations/<token>` only) both when it's set and before redirecting, so it can't be
  turned into an open redirect.
- **GitHub App installations**: the `installation_id` in GitHub's setup redirect comes back through the
  browser, so it can't be trusted on its own (installation ids are sequential numbers). The setup step
  sends the user through sign-in once more, and the callback links the installation only if
  `GET /user/installations`, called with that user's own token, lists it. An installation can be linked to
  one tenant only (a database-wide unique constraint), and a tracked repo can only reference an installation
  of its own tenant (a composite foreign key). The App authenticates with a JWT signed by its private key
  (RS256, `node:crypto`); installation tokens are minted per request and never stored.
- **Deployment sync** (worker): one pass every `SYNC_INTERVAL_MINUTES` (default 15) and one retention cleanup a
  day, each behind a Postgres advisory lock so two worker instances (or a slow pass) never overlap. Each
  tenant is read under its own RLS scope -- the worker has no cross-tenant view either. All GitHub calls for a
  repo happen before its database transaction (30 s timeout each), and a repo's records, issue facts and
  cursor are written together. A failing repo stores its error on `tracked_repos.last_sync_error` and the
  pass continues. Rules ported from `scripts/sync-github-deployments.js`: the cursor never passes a
  deployment that has no final status yet (unless it's stuck for 48 h); the newest *terminal* status
  decides (GitHub's `inactive` marker is ignored); a redeploy of the same commit inherits the previous
  record's issues instead of comparing a commit with itself; at most 200 new deployments per repo per pass,
  oldest first.
- **Retention**: records older than the tenant's `deployment_retention_days` are deleted daily, except each
  repo/environment's latest deployment and latest successful one. `issue_deployments` ("issue X first reached
  ENV") is never trimmed. Untracking a repo deletes its deployments.
- **Dashboard files**: only an allowlist from `docs/` (`index.html`, `style.css`, `favicon.svg`, `app-*.js`) is
  read at startup and served from memory -- `docs/data/`, `components.json` and `jira-spaces.json` are never
  reachable, and no request path touches the filesystem. Responses carry `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. In SaaS mode the page never falls back to
  its built-in sample data (it would read as the tenant's own): a 401 goes through sign-in and back, any other
  error shows an empty dashboard with an "Error" badge.
- **Tenant isolation (RLS)**: every `memberships` query runs through `lib/scope.js`'s `withScope()`, which
  sets `app.current_tenant_id` / `app.current_user_id` with `set_config(..., true)` inside one transaction.
  Those settings end with the transaction, so a pooled connection can't carry a tenant into the next request.
  Policies (migration `002`): read your tenant's rows or your own rows; write only into the scoped tenant.
  `invitations` (migration `003`) is tenant-scoped the same way, plus a read-only policy for exactly one
  invitation whose token hash is set as `app.invite_token_hash` (how a not-yet-member reads the link).
  `github_installations` and `tracked_repos` (migration `004`), `deployments` and `issue_deployments`
  (migration `005`) are tenant-scoped the same way.
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

   To connect repos (FR-004), configure the same App further and add its server-to-server credentials:
   - **Setup URL**: `http://localhost:3000/github/setup`, with **Redirect on update** ticked
   - **Request user authorization (OAuth) during installation**: leave unticked (ShipScope signs the user in
     itself after the setup redirect, to verify the installation)
   - **Repository permissions**: Metadata, **Deployments** and **Contents**, all read-only (Contents for the
     commit range of each deploy)
   - **Where can this GitHub App be installed?**: Any account, so other organizations can install it
   - Put the **App ID**, the App's URL name (**slug**, the last part of its public page URL) and a generated
     **private key** (the `.pem` file's contents) into `.env` as `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and
     `GITHUB_APP_PRIVATE_KEY`. Without these three, sign-in still works and the GitHub routes are off.

3. `npm run dev`, then open `http://localhost:3000/`. After GitHub you land on `/me` until you have a tenant,
   and on its dashboard (`/t/<tenantId>/`) afterwards.
   Create a tenant with e.g. `fetch('/tenants', { method: 'POST', headers: { 'content-type':
   'application/json' }, body: JSON.stringify({ name: 'Acme' }) })` from the browser console on that page.

Other commands: `npm start` (Web Service, env from the process), `npm run worker` (heartbeat, deployment sync when the `GITHUB_APP_*` variables are set, daily retention cleanup),
`npm run migrate` (pending `migrations/*.sql`).

## Testing

`npm test` runs this directory's `node:test` suite. Unit tests (mocked pool, mocked GitHub via an injected
`fetch`, Fastify's `app.inject()` — no network, no credentials) always run. The real-Postgres tests
(`migrate`, `tenants`, `rls`, `auth-flow`, `invitations`, `github`, `deployments`, `dashboard`) are skipped unless `TEST_DATABASE_URL` is set:

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
against a fake GitHub, so CI needs no GitHub credentials; `github.test.js` does the same for the App flow, with a
generated key pair whose public half the fake GitHub uses to verify every App JWT.

## Deployment

Declared as Render Blueprint services in `@render.yaml` at the repo root (`rootDir: server` for both the Web
Service and the Background Worker). The Web Service refuses to start without `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET` and `PUBLIC_BASE_URL` (or with only some of `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_PRIVATE_KEY`); set them in Render's environment settings (they're declared
with `sync: false`, so Render asks for them and never reads them from the repo). The dashboard files are read from `../docs` (override with `DASHBOARD_DIR`); with `rootDir: server`, check
after the first deploy that `/t/<tenantId>/` doesn't answer 503 (the log says "dashboard files not found" if
Render's build doesn't include the repo's `docs/`). Migrations are not run
automatically on deploy yet: run `npm run migrate` against the Render database after a deploy that adds one.
See `@context/foundation/infrastructure.md`'s "Getting Started" and "Operational Story" sections for the full
deploy/rollback/secrets workflow.
