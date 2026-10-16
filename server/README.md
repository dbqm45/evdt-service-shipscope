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

- **Versions and environment drift** (`lib/version-resolution.js`, `lib/env-drift.js`, `lib/tree-diff.js`): each
  deploy's version comes from a GitHub Release or tag on its commit, else the repo's version file (`version=<ref>`
  at the deployed commit, for repos whose QA/PROD deploy trigger commits), else a version-like string in the
  commit message; commit ranges are compared between real refs only (a release/tag name or a sha, never that
  free-text label). After each pass the latest successful deploys of test -> qa -> prod are compared: commit
  counts are kept as context, the git trees decide (same tree, or a difference only in the repo's
  drift-ignore patterns, means no drift; a comparison that can't be trusted is "unknown", never "same"). Drift
  is stored on the tracked repo and only recomputed when a latest deploy changed or the last attempt failed.
  An admin sets the version file and ignore patterns per repo (`PUT .../github/repos/:repoId/settings`).

- **Dashboard** (`docs/`, served by the Web Service at `/t/<tenantId>/`): the existing page, whose
  `app-data.js` recognizes that path and loads the tenant's data from `/api/tenants/<tenantId>/dashboard-data`
  (same shapes as the file-based `data/*.json`) instead of static files.

Each deploy also records whether its GitHub Actions run was started by hand (`manual`, needs the App's
**Actions** read permission; without it the flag stays unknown) and the creator's public display name
(`lib/deployment-people.js`; both display-only, a failed lookup never fails the sync).

- **Feature flags** (`lib/flags.js`, contract `schemaVersion: 2`): pushed from outside, never read by ShipScope
  itself -- each tenant keeps flags its own way (build-time files, a runtime API, a flag service, or none). An admin
  names the tenant's *flag sources* ("LaunchDarkly", "Frontend CI", ...), each with a kind (`build`/`runtime`), a
  priority and optionally a component (tracked repo); each source sends the **full state** of its flags for the
  environments it covers, with its own token. Flags it no longer lists there are marked removed; values are
  `off`/`on`/`partial` (+ rollout %); a sender's `changedAt` is kept (within 7 days back / 5 minutes ahead) and an
  older message never undoes a newer one. Several sources of one kind fold into the dashboard's `build`/`runtime-be`
  slot by priority, then by the latest change. Not a port of `scripts/lib/flag-ingest.js` (schemaVersion 1, the
  single-tenant contract): this one replaces it for the server.

- **Jira connection** (FR-007, `lib/atlassian.js` + `lib/jira-connections.js`): an admin connects the tenant's
  Jira Cloud through Atlassian OAuth 2.0 (3LO), read-only scopes plus `offline_access`. Only the refresh token is
  stored, encrypted with AES-256-GCM (`lib/secret-box.js`, key `TOKEN_ENCRYPTION_KEY`, bound to the tenant id);
  access tokens are minted per use under a row lock, since Atlassian rotates refresh tokens. One Jira site per
  tenant (an admin picks it when the grant covers several). A revoked or expired grant shows up as `lastError`.

- **Jira issues** (FR-008/FR-009, `lib/jira-sync.js` + `lib/jira-model.js`): an admin picks boards of any type
  (company-managed `scrum`, team-managed `simple`, `kanban`); a board's
  sprints define the PIs (`Sparks 27.3.2` -> `PI-27.3`; a team that doesn't name sprints after a PI gets each sprint
  as its increment) and scope the sync to its team (only issues in that board's sprints). Each worker pass fully
  re-syncs every board's current PI (plus the Epics its issues belong to) and replaces what was stored for it; a
  board's first sync also takes the previous PI; earlier PIs stay as the snapshot taken while they were current
  (the file-based per-PI shard model). The dashboard reads the index from `dashboard-data` and one PI's issues from
  `/api/tenants/:id/jira-issues`.
- Each board has its own rhythm, so SAFe and non-SAFe teams can share a tenant: `auto` (default: PIs when any of the
  board's sprints follows the PI naming, else every sprint on its own), `pi` (sprints grouped by PI; an admin's
  template such as `PI {pi} / Iteration {n}` replaces the default `27.3.1` naming -- `{pi}` dotted digits, `{n}` a
  number, `*` any text, the rest literal, never a raw regex), `sprint`, `release` or `flow`. Increments are ordered by
  when their sprints started (names need not contain numbers).
  - `release`: the increment is a version of the board's project (`fixVersion`, named `<project key> <version>` unless
    the version already starts with the key): the unreleased one due first is current (else the last released one),
    and its issues are the project's issues with that fixVersion. Archived versions are ignored.
  - `flow` (Kanban): the increment is a calendar month (`Flow 2026-10`, UTC): issues resolved in it and, while it is the
    current month, everything in progress. A board's first sync also takes the previous month.
  - `auto` on a board without sprints (a kanban board, or a team-managed one with sprints off) picks `release` when its
    project has an unreleased version, else `flow`. Both are scoped by the board's project (its `location`), not its
    filter. A release or flow month is its own single "sprint" in the index and on its issues, so the dashboard's
    sprint filter and charts need no special case. Versions are read with `read:jira-work`: no new consent. When the selected boards are in more than one current increment, the index
  starts with `@now` (`kind: "now"`, `label: "Now: PI-27.3, Sprint 7"`, `includes`), the default, whose issues are every
  board's current increment together.

Not yet: GitHub webhooks.

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
| `GET /github/setup` | session | The App's Setup URL. Checks the state, then signs the user in again so the callback can verify the installation (below) and link it; ends on the settings page (`/t/:tenantId/settings#github`). `setup_action=request` (an org owner must approve) returns 202. |
| `GET /tenants/:tenantId/github/installations/:installationId/repositories` | session + admin | The installation's repos from GitHub, each with `tracked`. |
| `PUT /tenants/:tenantId/github/repos/:repoId` | session + admin | Body `{ "installationId": 123 }`. Tracks the repo if GitHub lists it for that installation. Idempotent. |
| `DELETE /tenants/:tenantId/github/repos/:repoId` | session + admin | Stops tracking. 204, or 404. |
| `PUT /tenants/:tenantId/github/repos/:repoId/settings` | session + admin | Body `{ "versionFile": "trigger.properties" \| null, "driftIgnorePaths": [".github/", "README.md"] }` (repo-relative, no leading `/` or `..`; at most 50 patterns; pattern rules as `driftIgnorePaths` in `docs/components.json`). Clears the stored drift so the next sync recomputes it. 404 if the repo isn't tracked. |
| `DELETE /tenants/:tenantId/github/installations/:installationId` | session + admin | Unlinks the installation and its tracked repos (it stays installed on GitHub). 204, or 404. |

Dashboard:

| Route | Auth | What it does |
|---|---|---|
| `GET /` | — | Signed out: to sign-in. Signed in: to the first tenant's dashboard, or `/start` without a tenant. |
| `GET /start` | session (else sign-in and back) | Get started: create a first workspace (the page posts to `POST /tenants`, then opens its settings). |
| `GET /t/:tenantId/settings` | session + member (else sign-in and back) | The settings page (`ui/settings.html` + `ui/settings.js`): workspace (retention, members, invitations), GitHub (installations, tracked repos and their version file / drift-ignore paths), Jira (connect, site, boards and each board's rhythm, sync now) and feature-flag sources (tokens shown once). It only calls the JSON routes below, which check roles; members see it read-only. Linked from the dashboard header (`#settingsLink`, shown only when served by this server). |
| `GET /ui/:asset` | — | The settings pages' scripts and styles (`ui/*.js`, `ui/settings.css`) and the dashboard files they reuse (`style.css`, `favicon.svg`, `app-html.js`); an allowlist, like `/t/:tenantId/:asset`. |
| `GET /api/features` | — | `{ githubApp, jira, githubWebhooks, jiraWebhooks }`: which optional parts this server has configured, so the settings page doesn't offer the others. |

Webhooks (migration `013`; the worker picks up what they ask for every 30 seconds):

| Route | Auth | What it does |
|---|---|---|
| `POST /webhooks/github` | `X-Hub-Signature-256` with `GITHUB_APP_WEBHOOK_SECRET` (route off without it) | A `deployment_status` (or `deployment`) event queues a sync of its repo, in every tenant that tracks it. Other events are accepted and ignored. 202 `{ queued }`; 401 for a missing or wrong signature, 400 for a body that isn't JSON, 415 for one that isn't `application/json`. |
| `POST /webhooks/jira` | `Authorization: Bearer <JWT>`, HS256 with `ATLASSIAN_CLIENT_SECRET` | An issue event from a webhook ShipScope registered queues a sync of the tenant(s) it names (`matchedWebhookIds`, else the issue's site). 202 `{ queued }`; 401 for a missing, forged, expired or non-HS256 token. |
| `GET /t/:tenantId/` | session + member (else sign-in and back) | The dashboard page (`docs/index.html`, minus its `data/*.json` preload hints). |
| `GET /t/:tenantId/:asset` | — | `style.css`, `favicon.svg`, `app-*.js` only (the same public code GitHub Pages serves). |
| `GET /api/tenants/:tenantId/jira-issues?pi=PI-27.3` | session + member | One PI's issues (what a `data/jira-issues/<PI>.json` shard holds); `pi=@now` gives every board's current increment together. |
| `GET /api/tenants/:tenantId/dashboard-data` | session + member | Everything the page loads, in the `data/*.json` shapes: `deployments` (repo short name as `component`; `version` is the resolved release/tag/version-file/message label, else the short sha; `driftBehind` on each environment's latest successful deploy), `issueDeployments`, `componentsOrder` (tracked repos), `lastSyncedAt`, `flagsMeta`/`flagStates`/`flagStateHistory` (flags some source still reports; each value also carries `state`, `rollout` and `sourceName`); `jiraIndex` (current increment -- `@now` when boards are in different ones -- and every synced increment with its `kind` (`pi`/`sprint`/`now`) and sprints) and `issueStatusIndex` (per issue key, its newest PI). |

Deployments and settings:

| Route | Auth | What it does |
|---|---|---|
| `GET /tenants/:tenantId/deployments` | session + member | Newest first. Optional `repoId`, `environment` (`test`/`qa`/`prod`), `limit` (default 100, max 500). Each: `deploymentId, repo, environment, status, sha, deployedAt, deployedByLogin, workflowRunUrl, durationMs, commitUrl, rollbackToSha, relatedIssues, issueCommitTypes`. |
| `GET /tenants/:tenantId/settings` | session + member | `{ name, deploymentRetentionDays }`. |
| `PUT /tenants/:tenantId/settings` | session + admin | Body `{ "deploymentRetentionDays": 7..730 }` (default 90). Applied by the next daily cleanup. |

Jira (only when the `ATLASSIAN_*` variables and `TOKEN_ENCRYPTION_KEY` are set):

| Route | Auth | What it does |
|---|---|---|
| `GET /tenants/:tenantId/jira/connect` | session + admin | Redirects to Atlassian's consent screen (state cookie naming the tenant). |
| `GET /auth/atlassian/callback` | session + admin | The app's callback URL. Checks the state, exchanges the code, keeps the Jira sites the grant can read; ends on the settings page (`/t/:tenantId/settings#jira`). 400 for a bad state, declined consent or no Jira site; 502 when Atlassian rejects the code or grants no offline access. |
| `GET /tenants/:tenantId/jira` | session + member | `{ connected: false }` or `{ connected: true, site: { cloudId, url, name } \| null, sites?, connectedAt, lastError }` (`sites` only while none is chosen). Never a token. |
| `PUT /tenants/:tenantId/jira/site` | session + admin | Body `{ "cloudId": "..." }`, one of the sites the grant covers. Choosing another site drops the chosen boards and synced issues (board ids belong to one site). |
| `GET /tenants/:tenantId/jira/boards` | session + admin | Every board of the site `{ boards: [{ boardId, name, type, projectKey, projectName, selected }] }`; `type` is `scrum`, `simple` (a team-managed project's board) or `kanban`. |
| `PUT /tenants/:tenantId/jira/boards` | session + admin | Body `{ "boardIds": [10, 11] }` (at most 50): the boards to sync, replacing the selection; each must be a board of the site (else 400); any type -- a kanban board syncs in the `flow` (or `release`) rhythm. Issues of boards no longer selected are removed. |
| `PUT /tenants/:tenantId/jira/boards/:boardId` | session + admin | Body `{ "rhythm": "auto" \| "pi" \| "sprint" \| "release" \| "flow", "piTemplate": null \| "PI {pi} / Iteration {n}" }` (both required): how a selected board's work groups into increments. A template only goes with `pi`/`auto` and must contain `{pi}` once (else 400). A change drops the board's stored issues; the next sync takes them again in the new rhythm. `GET .../jira/boards` returns `rhythm`, `piTemplate` and `currentIncrement` for selected boards. |
| `POST /tenants/:tenantId/jira/sync` | session + admin | Syncs now (the worker also does every pass). Returns `{ boards, issues, currentPi }`. |
| `GET /tenants/:tenantId/jira/projects` | session + admin | The chosen site's projects `{ projects: [{ id, key, name }] }`; proves the connection works. 409 when not connected, no site is chosen, or the grant was revoked. |
| `DELETE /tenants/:tenantId/jira` | session + admin | Forgets the connection and its token. 204, or 404. |

Feature flags:

| Route | Auth | What it does |
|---|---|---|
| `POST /tenants/:tenantId/flag-sources` | session + admin | Body `{ "name": "LaunchDarkly", "kind": "build" \| "runtime", "priority"?: 0..1000, "repoId"?: 123 \| null }` (priority defaults to 0 for build, 100 for runtime). Returns `{ source, token: { id, token } }`; the token (`shpi_...`) is shown only here, only its SHA-256 is stored. 201; 409 for a taken name, 404 for an untracked repo. |
| `GET /tenants/:tenantId/flag-sources` | session + admin | `{ sources: [{ id, name, kind, priority, repoId, createdAt, tokens: [{ id, createdAt, lastUsedAt }] }] }`, never the tokens. |
| `PUT /tenants/:tenantId/flag-sources/:sourceId` | session + admin | Body `{ name, kind, priority, repoId }`: rename, change the kind, the precedence or the component. |
| `DELETE /tenants/:tenantId/flag-sources/:sourceId` | session + admin | Deletes the source with its tokens, values and history. 204, or 404. |
| `POST /tenants/:tenantId/flag-sources/:sourceId/tokens` | session + admin | Another token for the source (rotation without downtime). Returns `{ id, token }`. 201. |
| `DELETE /tenants/:tenantId/ingest-tokens/:tokenId` | session + admin | Revokes a token. 204, or 404. |
| `POST /api/flags/ingest` | `Authorization: Bearer <ingest token>` | Body `{ "schemaVersion": 2, "observations": [{ "key", "env": "test"\|"qa"\|"prod", "state": "off"\|"on"\|"partial", "rollout"?: 0..100, "changedAt"?: ISO 8601 }], "complete"?: true, "environments"?: [...], "changedBy"?, "flags"?: [{ "key", "description"?, "jiraKeys"? }] }` (at most 5000 observations). `complete` (default `true`): flags of this source not listed for the covered `environments` (default: those in `observations`) are marked removed; `false` sends just changes. `flags` describes only keys observed in the same message. Returns `{ source, flags, changed, removed, stale, created }`; 401 for an unknown or revoked token. |

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
- **Webhooks**: verified before anything else -- GitHub's HMAC-SHA256 over the exact raw body (the JSON parser is
  bypassed on these routes), Atlassian's JWT pinned to HS256 with `exp`/`iat` checked (5 minutes of skew) -- and
  both compared in constant time. A delivery only ever queues a key (`sync_requests`: a repo id, a Jira webhook id
  or site), never data: the worker then reads the real state through the API, so a replayed or reordered delivery
  can at most cause one extra sync. `sync_requests` holds no tenant data and is the one table outside RLS: the web
  service can't know which tenants a repo belongs to; the worker matches them while walking tenants under their
  own scope, under the same advisory locks as the periodic syncs. Jira webhooks are registered by the worker per
  tenant with the `manage:jira-webhook` scope (filtered to the selected boards' projects, refreshed before
  Atlassian's 30-day expiry); a failure is shown in settings and never fails the sync.
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
  (migration `005`), `flag_sources`, `ingest_tokens`, `flags`, `flag_values` and `flag_value_history` (migration
  `008`), `jira_connections` (migration `009`), `jira_boards`, `jira_pis` and `jira_issues` (migration `010`) are
  tenant-scoped the same way. An ingest request carries no session: like an invitation, it can read
  exactly the one `ingest_tokens` row whose hash it holds (`app.ingest_token_hash`), then works under that row's
  tenant, one ingest per tenant at a time (a transaction advisory lock).
  An unscoped query fails closed: zero rows, or an RLS error for a write.

## Running locally

Everything to configure outside the code (GitHub App settings and permissions, environment variables,
first steps for a tenant) is collected in [SETUP.pl.md](SETUP.pl.md) (Polish).

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
   - **Repository permissions**: Metadata, **Deployments**, **Contents** and **Actions**, all read-only
     (Contents for the commit range of each deploy, tags, releases, the version file and the git trees compared
     for drift; Actions only to tell a manually started deploy run apart -- optional, without it that badge is
     never shown)
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

Declared as a Render Blueprint in `@render.yaml` at the repo root: the Web Service, the Background Worker and the
Postgres database. Step-by-step setup (in Polish): `SETUP.pl.md`, section 6.

- **Both services build and start from the repo root** (`npm ci --prefix server`, `node server/web.js` /
  `node server/worker.js`), not with `rootDir: server`: Render makes files outside a service's root directory
  unavailable at build and run time, and the Web Service serves the dashboard and settings pages from `docs/`
  (read from `../docs`, override with `DASHBOARD_DIR`). `buildFilter` limits auto-deploys to `server/**` (plus the
  dashboard's own `docs/*.{html,css,js,svg}` for the web service), so data commits never redeploy.
- **Migrations run before every deploy** (`preDeployCommand: node server/scripts/migrate.js` on both services).
  `lib/migrate.js` holds a Postgres advisory lock, so the two services' pre-deploys never apply a file twice; a
  migration that fails stops that deploy and the previous version keeps serving. Migrations are forward-only.
- **Configuration**: every secret is `sync: false` (Render asks for it; it never comes from the file). The Web
  Service refuses to start without `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` and `PUBLIC_BASE_URL` (or with
  only some of a group: `GITHUB_APP_ID`/`SLUG`/`PRIVATE_KEY`, `ATLASSIAN_*`/`TOKEN_ENCRYPTION_KEY`). For instant
  updates set `GITHUB_APP_WEBHOOK_SECRET` (web) and `PUBLIC_BASE_URL` on the worker too (it registers the Jira
  webhooks). `server/test/render-blueprint.test.js` checks the file against the code: no `rootDir`, the commands,
  the build filter, every variable the config reads declared on the service that reads it, secrets never inline.
- **Health**: `GET /health` (Render's health check, also reports the version) and `GET /health/db`.

See `@context/foundation/infrastructure.md`'s "Getting Started" and "Operational Story" sections for the full
deploy/rollback/secrets workflow.
