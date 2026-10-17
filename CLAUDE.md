# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository. It states the rules the code relies on; the
history of how they came about is in git and `CHANGELOG.md`. Related documents:

- `docs/GLOSSARY.md` — terms that have more than one name (component / tracked repo, PI / increment, source / slot).
- `design-docs/REPORT_ARCH.md` — architecture and DDD analysis (2026-10-17); `ADR-001` (flags are pushed from
  outside), `ADR-002` (the three memory policies); `FEATURES(.pl).md` — undecided ideas; `TODO.md` — technical debt.
- `FAQ.md` — how each number and badge on the dashboard is computed; `ONBOARDING.md` — adding a component or a
  workspace; `server/README.md` — routes, security model, local setup; `RELEASING.md` — versions.

## What this repo is

ShipScope is a deployment / feature-flag / Jira status dashboard. Two ways of running it live side by side:

1. **File-based sync** (the original, single-organization setup): dependency-free Node scripts in `scripts/`, run
   by GitHub Actions, write JSON into `docs/data/`; a static page (`docs/index.html` + `docs/app-*.js`) renders it,
   served by GitHub Pages.
2. **SaaS backend** (`server/`, the pivot scoped by `context/foundation/prd.md`): Fastify + Postgres on Render,
   multi-tenant, serving the same `docs/` frontend at `/t/<tenantId>/` from its own API.

Both share the frontend. The domain rules for deployments and drift exist in both (see "Ports" below).

**This repository vs. the running file-based sync.** The file-based path runs from the original repository
(`circlek-global/evdt-service-shipscope`, which app repos reference in `uses:`), with its `live` branch and its own
workflows. This repository has no `live` branch, and its file-sync workflows (and `.github/actions/sync-with-retry`)
were removed on 2026-10-17 because every run failed here; its only workflows are CI and releases (`test.yml`,
`server-test.yml`, `pr-title.yml`, `release.yml`). `scripts/` and its tests stay: they are the reference for the
server's ports. Workflow names below refer to the original repository.

## Layout and tooling

- No linter, bundler or TypeScript. Root `package.json` has no dependencies and only exposes scripts:
  `npm test` (`node --test "test/*.test.js"`), `npm run release`, `npm run lint:commit`, `npm run hooks:install`.
- `server/` is a separate dependency boundary: its own `package.json`, `node_modules/` (gitignored) and `test/`.
  Root `npm test` never runs `server/test/`. Run `npm install && npm test` inside `server/` (real-Postgres tests need
  `TEST_DATABASE_URL`, see `server/README.md`).
- **Module boundaries** (`scripts/lib/module-boundaries.js`, `node scripts/check-module-boundaries.js`, tested in
  `test/module-boundaries.test.js`): `scripts/` never requires from `server/` and vice versa; `docs/app-*.js`
  never calls `require()`.
- **Ports** (`test/lib-parity.test.js`): `server/` cannot require from `scripts/`, so a few rules live twice —
  `server/lib/deployment-logic.js` (a subset of `scripts/lib/deployment-records.js`), `version-resolution.js`,
  `env-drift.js`, `tree-diff.js`. The copies differ in shape (the script parses `DRIFT_IGNORE_PATHS` from an env
  var, the server reads a column); what must match is behavior, which the parity test checks on shared fixtures.
  A fix to one of these rules belongs in both until the file-based sync is retired. Retention is expressed as SQL on
  the server (`lib/retention.js`), so it has no parity test.

## Tests — `node:test`, not Jest

- `node:test` + `node:assert` only. No `jest.fn()`/`jest.mock()`/`expect(...)`; use `t.mock.fn()`/`t.mock.method()`
  and `assert.strictEqual`/`deepStrictEqual`/`rejects`. Copy the pattern from an existing `test/*.test.js`.
- Root: ~475 cases covering every `scripts/*.js`, `scripts/lib/*.js` and `docs/app-*.js` (coverage:
  `node --test --experimental-test-coverage "test/*.test.js"`). CI: `.github/workflows/test.yml` and
  `server-test.yml` on every PR and push to `main`.
- Each test file runs in its own process (`scripts/lib/jira-config.js` reads env at require time). Files that touch
  disk use a gitignored `test/.tmp-*` path removed in `after()`.
- Top-level scripts run `main()` on require and export nothing, so their tests spawn them as child processes (temp
  data dirs via env paths, a `--require` preload replacing global `fetch` with a fixture router, or a local
  `http.createServer`; helpers in `test/sync-harness.js` and `test/flag-scripts-helpers.js`) and import
  `scripts/lib/*` directly.
- Frontend tests load `docs/app-*.js` into a `vm` context with a stub DOM, fixed clock and mocked `fetch`. The stub
  does not parse HTML, so tests assert on generated HTML strings; real layout (row-height equalization, scroll sync)
  is not verified. `test/frontend-load-order.test.js` loads every file in `docs/index.html` order. A view test's
  `FILES` list must include `app-components`.

## Type discipline (plain JavaScript)

- Every exported function gets a JSDoc `@param`/`@returns` stating the shape, not prose
  (`@param {{ tenantId: string, repoFullName: string }} input`).
- Every boundary receiving external input (HTTP bodies, OAuth callbacks, GitHub/Jira webhooks and API responses)
  validates the fields it reads before using them — never trust a third-party shape straight into a database write.
  Prefer `node:assert` or a small runtime check.

## Running scripts locally

Every script in `scripts/` reads env vars (no CLI args): `node scripts/check-flags-metadata.js`. Paths go through
`safeRelativePath` (`scripts/lib/cli.js`): absolute paths and `..` are rejected, so pass repo-relative paths. To
preview the dashboard, open `docs/index.html` or serve `docs/`; when `docs/data/*.json` cannot be fetched (e.g.
`file://`) it uses the built-in `FALLBACK` sample data and says so in the header.

## Versioning (`RELEASING.md`)

One SemVer number for the whole application, in `package.json`, `server/package.json` and
`server/package-lock.json` (kept equal, `test/release.test.js`), shown in `GET /health`. Commits and PR titles
follow Conventional Commits (`feat(SHP): ...`; PRs are squash-merged, so the title counts), checked by
`.github/workflows/pr-title.yml` and the optional `.githooks/commit-msg`. After each merge to `main`,
`release.yml` runs `scripts/release.js --ci`, commits `chore(release): X.Y.Z` with the versions and a
`CHANGELOG.md`/`CHANGELOG.pl.md` entry, tests that commit, tags `vX.Y.Z` and creates a GitHub Release
(`scripts/release-notes.js`, rules in `scripts/lib/conventional.js`). Never edit the version or a `## [X.Y.Z]`
changelog entry by hand outside a `chore(release)` PR.

## Backend (`server/`)

Deployed to Render per `context/foundation/infrastructure.md`: `render.yaml` builds both the Web Service and the
Background Worker from the repo root (`npm ci --prefix server`, `node server/web.js`), not `rootDir: server`, which
would hide `docs/` from the Web Service. Migrations (`server/migrations/001`–`015`, applied by the hand-rolled
`lib/migrate.js`) run as each service's `preDeployCommand` under an advisory lock (`test/render-blueprint.test.js`).
Dependencies, all in `server/package.json`: `pg`, `fastify`, `@fastify/cookie`. Fastify runs with
`removeAdditional: false, coerceTypes: false`: unknown fields and wrong types are a 400, never silently fixed.

**Structure.** `web.js` is bootstrap only (Fastify instance, cookie plugin, the `ERROR_STATUS` table mapping domain
errors to HTTP codes, shared constants) and registers one plugin per area from `server/routes/`: `health`, `auth`,
`tenants`, `invitations`, `github`, `jira`, `flags`, `dashboard` (dashboard, settings UI, `/api/features`),
`webhooks`. `server/test/web-routes-characterization.test.js` pins the route table. Business rules live in
`server/lib/`, with pure rules split from I/O: `deployment-logic.js` (vs. `deployment-sync.js`), `jira-model.js`
(rhythms, increments, `planBoardIncrements()`, `buildJiraIndex()`, issue mapping; vs. `jira-sync.js`),
`flags-logic.js` (payload check, `planIngestWrites()`, `pickWinningValues()`, `visibleFlagsMeta()`; vs. `flags.js`).
New rules go into the pure file; the I/O file orchestrates.

**Tenant isolation (RLS).** Every query on an RLS table — the list is `RLS_TABLES` in `lib/scope.js` (memberships,
invitations, github_installations, tracked_repos, deployments, issue_deployments, flag_sources, ingest_tokens, flags,
flag_values, flag_value_history, jira_connections, jira_boards, jira_pis, jira_issues) — must run inside
`withScope()`, which sets `app.current_tenant_id`/`app.current_user_id` with transaction-local
`set_config(..., true)`. An unscoped read returns zero rows; an unscoped write is an RLS error.
`lib/withscope-guard.js` (`server/test/withscope-guard.test.js`) fails on any `pool.query(...)` in `server/lib/`
that names an RLS table. Every tenant table cascades from `tenants`; `DELETE /tenants/:tenantId` (admin, name typed
back, `deleteTenant()`) relies on it, and `server/test/tenant-delete.test.js` checks every table in `RLS_TABLES` is
emptied. `sync_requests` (webhook queue) is the one non-RLS table; it holds no tenant data.

**Features, by PRD requirement:**

- **Sign-in (FR-001)** — the GitHub App's user-authorization flow (`lib/github-oauth.js`), server-side sessions
  (`lib/sessions.js`, only a SHA-256 of the cookie token stored; the GitHub user token is never stored).
- **Tenants and members (FR-002/003)** — `lib/tenants.js`; invitation links (`lib/invitations.js`: one-time hashed
  tokens, single-use claim by conditional `UPDATE`, last-admin guard). `GET /invitations/:token` answers HTML (a
  page with a Join button, `ui/invite.html`) to browsers and JSON to other clients.
- **GitHub App connection (FR-004/006)** — `lib/github-app.js` (App JWT, installation tokens), `lib/github-connections.js`.
  An installation is linked only after the user's own token shows they can access it (`GET /user/installations` in
  the sign-in callback), never on the `installation_id` of GitHub's setup redirect alone.
- **Deployment ingestion (FR-005)** — the worker (`worker.js`) runs `lib/deployment-sync.js` and the Jira sync
  every `SYNC_INTERVAL_MINUTES` (default 15) and `lib/retention.js` daily, each behind a Postgres advisory lock. Retention is per tenant
  (`tenants.deployment_retention_days`, default 90, 7–730) and always keeps each repo/environment's latest and latest
  successful deployment. Version resolution (`lib/version-resolution.js`: release → tag → version file → commit
  message; compares use only a verified release/tag or the SHA, stored as `deployments.resolved_ref`). Drift
  (`lib/env-drift.js` + `lib/tree-diff.js`) is stored per repo in `tracked_repos.drift = { inputs, failed, envs }`,
  recomputed only when a latest successful deploy changed or the last attempt failed; a failed comparison keeps the
  previous value. Per-repo `version_file`/`drift_ignore_paths` are set by an admin
  (`PUT /tenants/:tenantId/github/repos/:repoId/settings`). `manual` (needs the App's Actions read permission) and
  the creator's display name come from `lib/deployment-people.js`: display-only, cached per tenant per pass, never
  failing the sync.
- **Feature flags** — pushed from outside, never read by ShipScope (`ADR-001`). An admin names the tenant's flag
  sources (kind `build`/`runtime`, priority, optional component); each sends the full state of its flags per
  environment with its own token to `POST /api/flags/ingest` (`schemaVersion: 2`: `off`/`on`/`partial` + rollout,
  the sender's `changedAt`, flags no longer listed are marked removed, an older message never undoes a newer one).
  Sources of one kind fold into the dashboard's `build`/`runtime-be` slot by priority. Flags link to Jira issues
  from three origins merged in `readDashboardFlags()`: the sender's `jira_keys`, hand-set
  `manual_jira_keys`/`manual_description` (`PUT /tenants/:tenantId/flags/:key`, never overwritten by a sender), and
  Jira's own, read at sync time by the tenant's `jira_connections.flag_link` convention (a custom field or a label
  prefix, `extractFlagKeys()`). The server does not port `scripts/lib/flag-ingest.js` (`schemaVersion: 1`).
- **Jira (FR-007–009)** — connected per tenant through Atlassian OAuth 2.0 (3LO) (`lib/atlassian.js`,
  `lib/jira-connections.js`). Only the refresh token is stored, AES-256-GCM-sealed with the tenant id as associated
  data (`lib/secret-box.js`, key `TOKEN_ENCRYPTION_KEY`); access tokens are minted per use under a row lock because
  Atlassian rotates refresh tokens. Issues (`lib/jira-sync.js`) are scoped by the admin's chosen boards
  (company-managed `scrum`, team-managed `simple` or `kanban`): an issue's sprint is the one whose id is on the board
  being synced. Each pass fully re-syncs each board's current increment (plus its issues' Epics); a board's first
  sync also takes the previous one; older increments stay as snapshots. Each board has a rhythm
  (`auto`/`pi`/`sprint`/`release`/`flow`; `release` = the project's fixVersion, `flow` = a calendar month of resolved
  plus in-progress issues; `PUT /tenants/:tenantId/jira/boards/:boardId`) and an optional PI-name template
  (`{pi}`/`{n}`/`*`, compiled to a bounded regex, never a raw one). A sprint not named after a PI is its own
  increment. When boards are in different current increments the index starts with a synthetic `@now` entry
  (`kind: "now"`, `includes`), which `selectedIncrements()`/`incrementLabel()` in `docs/app-model.js` understand.
  The dashboard data carries `jiraBrowseUrl` (the tenant's site + `/browse`, `null` without Jira) for issue links.
- **Webhooks** (`lib/webhooks.js`, migration `013`) — `POST /webhooks/github` (HMAC, `GITHUB_APP_WEBHOOK_SECRET`)
  and `POST /webhooks/jira` (HS256 JWT signed with the Atlassian client secret) only queue a key in `sync_requests`;
  the worker's `webhookTick()` drains it every 30 s with `syncAll({ repoIds })`/`syncAllJira({ keys })` under the
  regular advisory locks. Jira webhooks are registered and refreshed per tenant by `ensureWebhook()` in the Jira sync
  (scope `manage:jira-webhook`, needs an https `PUBLIC_BASE_URL` on the worker); best effort, never failing the sync.
- **Fair syncs across tenants** (migration `015`) — longest-waiting first (`last_attempt_at`), a per-tenant time
  budget per pass (`SYNC_TENANT_BUDGET_SECONDS`, default 120). The deployment cursor never passes unfinished work
  (resolving runs in status order, not id order). A rate limit pauses only that GitHub installation or Jira
  connection (`rate_limited_until`, `lib/rate-limit.js`).
- **Dashboard and settings UI** — the Web Service serves an allowlist of `docs/` files at `/t/<tenantId>/`
  (`lib/dashboard-assets.js`); there `API_TENANT_ID` in `docs/app-data.js` switches `loadData()` to
  `/api/tenants/<tenantId>/dashboard-data` (`lib/dashboard-data.js`, the same `data/*.json` shapes) and never to
  `FALLBACK`. Settings live in `server/ui/` (`settings.html`/`settings.js` at `/t/<tenantId>/settings`, `start.html`
  at `/start` for a first workspace, assets at `/ui/<name>` from an allowlist that also reuses `docs/style.css` and
  `docs/app-html.js`). `settings.js` is a classic script on `html` with pure `render*` sections and `data-action`
  buttons/forms calling the JSON routes (which enforce roles), tested in `server/test/settings-ui.test.js`. Admins
  get a Getting started checklist (`onboardingSteps()`); an empty dashboard links to it (`#setupBanner`); the
  header's `#settingsLink` shows only in API mode.

## Branch model: `main` vs `live` (file-based sync, original repository)

- **`main`** holds source. **`live`** holds `docs/data/*.json`, which bots mutate continuously; GitHub Pages serves
  `live`. `sync-main-to-live.yml` merges `main` → `live` on pushes touching `scripts/**`, `docs/**`,
  `.github/workflows/**` or `.github/actions/**`, excluding `docs/data/**` (on `main` that path is only example data
  and would conflict with `live`'s real data).
- **`live` is never a source of executable code.** A data-mutating workflow checks out `main` at the workspace root
  (scripts, composite actions) and `live` into `data/` (JSON, `docs/components.json`, `docs/jira-spaces.json`), runs
  the composite action with `working-directory: data` and the script as `../scripts/...js`. Reason: `live` is
  writable with the shared `SHIPSCOPE_APP` credential every app repo holds, so code taken from it could run with the
  workflow's secrets. `check-flags.yml` uses the paths `shipscope` (main) / `shipscope-data` (live). Workflows that
  run no ShipScope script keep a single checkout. `retrigger-app-checks.yml` must be triggered by
  `repository_dispatch` (`flags-meta-changed`, fired after a successful push by `fill-flag-metadata.yml`,
  `check-flags.yml`, `sync-runtime-be-flags.yml`), not `push` to `live`: a push-triggered workflow runs the YAML on
  the pushed branch.
- **No shared `concurrency:` group** (GitHub keeps only one pending run per group, so a queued sync could be
  dropped). Instead every commit-and-push step is a retry loop (`.github/actions/sync-with-retry`): on a rejected
  push it re-runs the script against a freshly fetched `live`. This is safe because every script does a full
  read-existing-JSON → merge → write-back. Expensive external fetches are cached per job so a retry only redoes the
  merge: `scripts/lib/retry-cache.js` (`loadOrCompute`, under `RUNNER_TEMP`; `sync-jira.js` keys it by a hash of its
  JQL), and `githubApiAllPages()` persists fetched pages (deduped by `id`, or `name` for `/tags`) so a rate limit on
  a later page does not refetch earlier ones. `backfill-deployment-metadata.js` uses neither and is capped at
  `max-attempts: 2`.
- **ETags.** `scripts/lib/github-api.js`'s `githubApiRequest`/`githubApiGet` take a caller-owned `etagCache`
  (URL → `{ etag, body }`) and send `If-None-Match`; a `304` does not count against the rate limit. Used only for the
  three lists fetched on every run (`/deployments` page 1, `/tags`, `/releases`); per-deployment URLs are fetched
  once thanks to the cursor. `ETAG_CACHE_PATH` defaults under `RUNNER_TEMP`; `GITHUB_API_ETAG_CACHE_DIR` plus an
  `actions/cache` step in `orchestrate-full-sync.yml` keep it across runs.
- **Rate limits.** `github-api.js` retries a primary limit (`429`, or `403` with `x-ratelimit-remaining: 0`) and a
  secondary limit (`403` with `retry-after`), waiting for `retry-after`, else `x-ratelimit-reset`, else 30 s.
  `scripts/lib/jira-api.js` (`fetchWithRetry`) retries `429` by `Retry-After` (30 s default) and returns the raw
  `Response`.
- A change to a script that writes `docs/data/` reaches the real data only after `main` is merged into `live`.
- Every data-mutating script is idempotent: read existing JSON (or `{}`/`[]`) → merge, bumping
  `changedAt`/`changedBy` only when a value changes → write pretty-printed JSON with a trailing newline
  (`scripts/lib/json-file.js`). A run with no change writes identical bytes, so `git diff --staged --quiet` commits
  nothing. Keep it that way.
- `orchestrate-full-sync.yml`'s `sync_jira` job runs with `if: always()`, so one component's failed deployment sync
  does not skip Jira.

## Domain model (file-based data in `docs/data/`)

### Flags

- **`flags-meta.json`**: key → `{ description, source: 'build'|'runtime-be', jiraKeys[], components[], createdAt }`.
  `components[]` is a union every scaffold path adds its own `COMPONENT` to and never removes from;
  `fill-flag-metadata.js` is the one place to set it by hand. `createdAt` is stamped once at first scaffold/fill
  (older flags lack it).
- **`flag-states.json`**: key → env (`test`/`qa`/`prod`) → slot (`build`/`runtime-be`) →
  `{ enabled, changedAt, changedBy, component }`. Latest value only. Both slots may exist for one flag/env;
  `effectiveFlagState()` prefers `runtime-be`. `component` is the component whose sync last wrote that slot: if a
  *different* component already owns a key's slot, `resolve-all-flag-states.js`/`sync-runtime-be-flags.js` skip the
  write with an `::error::` (not a throw — the rest of the run must still commit). An entry without `component`
  (written before the field existed) is claimed by the next writer.
- **`flag-state-history.json`**: append-only array of `{ key, env, source, enabled, changedAt, changedBy }`, written
  by `scripts/lib/flag-history.js` at the point a value actually changes (no flip, no entry).
  `backfill-flag-state-history.js` mines `live`'s git history of `flag-states.json` for older flips, with
  `changedBy: "unknown (backfilled from git history)"` (the real actor was never stored); its dedup compares
  `changedAt` by calendar day, because live logging and git mining timestamp the same flip differently.
- `scripts/lib/flag-ingest.js` (`applyObservations`) is the shared core of `resolve-all-flag-states.js` (`build`) and
  `sync-runtime-be-flags.js` (`runtime-be`): collision guard, `flags-meta.json` scaffolding and `components` union,
  idempotent writes, history entries. It mutates in-memory objects; scripts own file I/O. Only
  `sync-runtime-be-flags.js` passes `correctMetaSource: true` (rewrites an existing entry's `source`).
  `update-flag-state.js` (one manual flip, no `COMPONENT`) does not use it and no-ops when the value already matches.

**Discovering build flags in app repos** — two regex-based extractors (not a TS parser) that are not
interchangeable: `discoverAllFlags(root)` (`scripts/lib/extract-flags.js`) finds `key: true|false` in the first
object literal of `*.generated.ts` files (used by `scaffold-flags-meta.js`, `check-flags-metadata.js`), and
`extractFlagParts` in `resolve-all-flag-states.js` reads `flag-parts/` directories (`default.ts` + optional
`test.ts`/`qa.ts`/`prod.ts`) to resolve per-env values. `resolve-all-flag-states.js` scaffolds a `flags-meta.json`
stub for any key it resolves that has none (it never corrects an existing entry's `source`). If an app repo changes
its generated file's shape, check these regexes first.

### Deployments

- **`deployments.json`**: one array for all components. A record carries `component`, env, status, `version`,
  `relatedIssues` (Jira keys from commit messages in the compare range), optional `resolvedFlags`,
  `workflowRunUrl`/`durationMs` (from the status history), `manual` (`workflow_dispatch` run), `commitUrl` (compare
  range to the previous successful deploy on that env, else one commit), `deployedBy` (display name via
  `GET /users/{login}`, `scripts/lib/github-users.js`, falling back to the login or `unknown`) with
  `deployedByLogin`, and `rollback: { toRef }` when GitHub's compare against the previous deploy on that env is
  `behind` (records before 2026-10-16 hold the previous ref instead). Records synced before a field existed get it
  from `backfill-deployment-metadata.js`, which marks processed records (`rollback` set even to `null`,
  `'deployedByLogin' in rec`).
- **Retention.** ShipScope shows the current state, not an archive (GitHub has the history). `trimOldRecords()`
  removes records older than `RETENTION_DAYS` (default 90) except, per component/env, the latest record and the
  latest *successful* one. `currentVersion()` reads only successful deploys; a failed attempt shows only in the
  timeline.
- **`deployments-cursor.json`** (never trimmed): `{ [component]: highestDeploymentIdEverSynced }`. Deployment ids
  increase per repo, so "already synced" is `id <= cursor`, independent of trimming. The cursor never advances past a
  deployment without a terminal status (`success`/`failure`/`error`, `buildDeploymentPlan()`'s `blockedIds`), nor
  past work a capped run did not process. Exceptions treated as permanent skips (with `::warning::`): an
  unrecognized environment, and a deployment still blocked after `STUCK_DEPLOYMENT_MAX_AGE_HOURS` (48) by its
  `created_at`. `/deployments` is paginated newest-first and stops at the cursor (`stopWhen`); at most
  `MAX_NEW_DEPLOYMENTS_PER_RUN` (200) new deployments are resolved per run, oldest first. Commit
  `deployments.json` and the cursor together.
- **`summary.json`**: `{ components: { [component]: { [env]: { current, latestOverall } } } }`, the two records
  `trimOldRecords()` already computes, rewritten in full each run. `currentVersion()` uses it as an O(1) fast path and
  falls back to scanning `deployments.json` when an entry is missing. `backfill-deployment-metadata.js` does not
  update it; the next regular sync does.
- **`issue-deployments.json`** (never trimmed): `{ [issueKey]: { [env]: { [component]: { deployedAt, commitUrl } } } }`,
  the first successful deploy of each issue per env/component, recomputed from the component's full record set each
  sync (adds only). `issueDeployedOnComponent()`/`anyDeploymentForIssue()`/`earliestProdDeployedAt()` fall back to
  it when trimmed records no longer show that an issue shipped.
- **Status and environment.** `mapEnvironment()` maps by substring to `test`/`qa`/`prod` (`production` → `prod`,
  `dev` → `test`), checks `preprod`/`pre-prod` first so it is not taken for `prod`, and drops anything else with a
  warning. A deployment's status is the first entry GitHub's list recognizes (`success`/`failure`/`error`), skipping
  `inactive` (GitHub adds it to an older deploy when a newer one succeeds); `computeDeployDurationMs()` ignores
  `inactive` too. GitHub's compare caps `commits` at 250, so a larger release loses some `relatedIssues` (logged).
- **Duplicates.** When a later record resolves to the same ref as the previous one on that env, the sync reuses the
  cached range (`lastResolvedRangeByEnv`) instead of comparing the ref with itself, which would give an empty range.
- **Version** — first match wins: a GitHub Release on that exact SHA (`/releases` `tag_name` matched against
  `/tags`) → a plain tag on that SHA → a version-like string in the commit message (`extractPromotedVersion`) → the
  short SHA. Releases and tags are fetched once per run. Only a verified release/tag (else the SHA) is used as a
  compare ref — a message match is display-only. `backfill-deployment-metadata.js` re-resolves records whose
  `version` looks like a raw SHA (`looksLikeRawSha`), trying the free lookups before a per-record `/commits` call
  (capped by `MAX_RECORDS_PER_RUN`).
- **`versionFile`** (per component, `VERSION_FILE`): for repos whose QA/PROD deploy from `deployment/*` branches
  holding only trigger commits (`version=v0.0.702`), the sync reads the file at the deployed commit and uses the
  named ref as `version`/`resolvedRef`/compare range; a missing file or ref falls back to the SHA. Drift resolves the
  file's ref on the fly for older records (no `versionFromFile` marker); their `version`/`relatedIssues` stay stale
  until trimmed.
- **Drift** (`driftBehind` on each env's latest successful record, recomputed every sync against the previous stage
  `test` → `qa` → `prod`): `{ behindEnv, commitCount }` and/or `{ untestedIn, untestedCommitCount }` from one
  compare call. Commit counts are history, not code (merges, squashes and deployment branches create commits for
  identical trees), so whether drift exists is decided by `compareTrees()` (`scripts/lib/tree-diff.js`): same tree
  SHA → none; otherwise the recursive listings are diffed by path + blob SHA, paths matching `driftIgnorePaths`
  (`DRIFT_IGNORE_PATHS`, JSON array; invalid fails the run) are dropped, zero left → none. A remaining difference is
  `diff: { files, paths (first 20), ignored }` (a rename = 2 files); an untrustworthy comparison (API error,
  truncated listing at 100k entries / 7 MB) is `diff: { unknown: true }`, never "no difference". Pattern rules:
  `dir/` = prefix from the repo root, a pattern with `/` = exact path, a bare name = that file name at any depth,
  `*` = anything but `/`.

### Jira issues (file-based)

- **Files**: one array per PI in `docs/data/jira-issues/{slug}.json` (`safeFileSlug(pi)`), plus `index.json`
  (`{ currentPi, pis: [{ pi, file, sprints: [{ name, startDate, endDate }] }] }`, newest first by `comparePiDesc()`),
  `status-index.json` (`key → { pi, statusCategory }` across every shard, first sighting in newest-first order wins;
  read by the Technical view's Flags panel, which has no PI selector) and `pruned-pis.json`.
- **Issue fields**: `type`, `title`, `pi`, `sprint`, `status`, `statusCategory` (`new`/`indeterminate`/`done`),
  `projectName`, `epicKey`/`epicTitle` (from `parent`, else the legacy Epic Link field with one batched title
  lookup; `null` on Epics), `impediment` (Jira's "Flagged", independent of `status`), `subtasks: { done, total }`
  or `null`, `priority`, `created`, `resolvedAt`, `dependencyBlocked`/`dependencyNote` ("is blocked by" links).
  Deployment-derived fallback stubs have `pi: "—"` and `null`/`false` for every Jira-only field.
- **PI and sprint**: `pickRelevantSprintInfo()` takes the issue's `active` sprint, else the last in Jira's order; when
  the issue's space has `boards`, only sprints whose name starts with a board name followed by a non-alphanumeric
  character (`matchesBoardPrefix()`) count. `pi` comes from that sprint's name (`extractPiFromSprintName()`), else a
  `PI-X.Y` or `PI-X.Y.Z` label (`extractPiFromLabel()`, only `PI-X.Y` used). An issue with no PI is dropped with a
  counted `::warning::` (a no-PI org is not supported).
- **Team check** (`fetchAndMapIssuesForJql()`): the allowlist is the space's `boards` + `teams`. Evidence is Jira's
  `Team` field (resolved by name, any element of a multi-value field, `extractTeamNames()`) or a label equal to an
  allowed name. A populated non-matching `Team` drops the issue unless a matching label or a sprint on the issue's
  own board rescues it. A boardless space with `teams` drops issues without evidence; a boarded space lets an issue
  with no evidence at all through. In the current-PI query, an issue that matched only the organization-wide
  `labels = "PI-X.Y"` branch (not `sprint in (ids)`) with no evidence is dropped, unless it is an Epic with an
  in-scope child.
- **Modes** (`scripts/sync-jira.js` orchestrates; logic in `scripts/lib/jira-*.js`):
  - *Default* (`runCurrentPiMode()`): resolve the current PI from configured boards (`resolveCurrentPiForSpaces()` —
    the active sprint; between sprints the nearest `future` sprint by `startDate`, else the latest `closed` by
    `endDate`), query `project = X AND (sprint in (ids of every sprint of that PI on the board) OR labels = "PI-X.Y")`
    (`buildCurrentPiJql()`; the Sprint field accepts only `= != IS IS NOT IN NOT IN`, hence ids, not `~`), add one
    `labels =` query per boardless space with `teams`, keep only the current PI, and **replace** that PI's shard
    (`writePiShards()` scope `'partial'`). An issue that left the PI is simply absent.
  - *`BACKFILL_PIS`* (`backfill-jira-issues.yml`): fetch named PIs into their shards (`'partial'`), never touching
    `currentPi`; past PIs are snapshots, not kept in sync. Naming a pruned PI here un-prunes it.
  - *`JIRA_PROJECT_KEY`*: whole-project sync, scope `'full'` (deletes shards not in the result); warns when the
    project has no entry in `docs/jira-spaces.json`.
  - *Fallback* when no board resolves a current PI: the deploy-referenced-key scan (`key in (...)`, keys whose
    project prefix exists, `filterExistingProjectKeys`). Scope `'full'` when no space has boards; `'partial-merge'`
    (upsert by issue `key` and sprint `name`, never delete) when boards exist but all lookups failed or found
    nothing. If Jira is unreachable, stubs are built from commit-derived keys.
- **Safety rules in `writePiShards()`**: a PI in `pruned-pis.json` is never written back (every scope); `'full'`
  never deletes `index.json`, `status-index.json` or `pruned-pis.json`, and refuses to delete anything when it
  resolved zero PIs while 2+ exist; every write drops `index.json` entries whose file is missing. Shards accumulate
  by design; `prune-jira-pis.js` is the only way to remove one (refuses the current PI; a PI not present is still
  added to the exclusion list).
- **Failure handling**: `resolveSpacesConfig()` throws when Jira's project list cannot be fetched (an empty result
  would route into the destructive `'full'` scope). A failed board/sprint lookup (`JiraBoardLookupError`, any non-2xx
  or network error) soft-degrades by default; `JIRA_BOARD_LOOKUP_STRICT=true` makes it fail the run instead. The
  account's Agile API access was fixed on 2026-10-08, so strict mode can be enabled in the original repository's
  workflow env; a 401 only on `/rest/agile/1.0/*` means the token lacks Jira Software scopes or the account
  lacks the product role (`ONBOARDING.md`).
- **Release status**: an issue links to flags via `flagsMeta[key].jiraKeys` and to deployments via
  `relatedIssues`; `issueStatusForEnv()` gives `none` / `deployed` (code shipped, flag off) / `released` (flag on) /
  `partial` / `deployed_code_only` (no flag to check).

### Sync metadata

`sync-meta.json` holds `lastFullSync`, stamped by `record-full-sync.js` only after a run that re-synced every
component's deployments plus Jira (cron, manual, unknown dispatch — never a single-component `repository_dispatch`,
which can go missing when a deploy branch lacks the notify step). The header shows it as "synced HH:MM".

## Configuration files in `docs/` (file-based)

**`docs/components.json`** — the tracked components, an array of
`{ name, description, serviceType, featureFlagsIncluded, application, versionFile?, driftIgnorePaths? }`, keyed by
`name` (the GitHub repo name). Read from `live` by `orchestrate-full-sync.yml`/`backfill-deployment-metadata.yml`
(`prepare` jobs build the matrices), over the Contents API by `notify-deployment.yml` (to validate its `component`
input), and by the frontend (`orderedComponents()` row order, tooltips). `description` is the name's tooltip;
`featureFlagsIncluded: false` shows a "flags not tracked" icon, `null` means unconfirmed and shows nothing;
`serviceType` (`"FE"`/`"BE"`/`null`) is stored but unused; `application` (array) groups components for the Release
Notes Service filter, a component without one stands for itself (`orderedApplications`); `versionFile` and
`driftIgnorePaths` are described under Deployments. The scripts themselves never read it (they take
`COMPONENT`/`APP_REPO`).

**`docs/jira-spaces.json`** — optional allowlist of Jira projects by display name (case-insensitive; an unknown name
logs a warning): `{ "spaces": ["Space A", { "name": "Space B", "boards": ["Board"], "teams": ["Team"] }] }`. A plain
string means "no team restriction". `boards` opts the space into the current-PI fetch and doubles as team names;
`teams` names teams for a project shared by several teams with no board of its own. A wrong type for
`boards`/`teams` throws `JiraSpacesConfigError`; an object with both empty logs a warning. It restricts what is
synced, not just what is shown.

## Scripts (`scripts/*.js`)

Shared helpers: `scripts/lib/cli.js` (`fail`, `safeRelativePath`), `json-file.js` (`readJson`, `writeJson`),
`github-api.js`, `jira-api.js`, `retry-cache.js`, `deployment-records.js` (retention, plan, cursor, drift),
`tree-diff.js`, `flag-ingest.js`, `flag-history.js`, `extract-flags.js`, `github-users.js`, and `jira-*.js`
(`jira-config` env read at require time, `jira-pi`, `jira-jql`, `jira-spaces`, `jira-boards`, `jira-issues`
— `fetchAndMapIssuesForJql(ctx)` —, `jira-shards`).

| Script | Workflow (original repo) | Purpose | Env |
|---|---|---|---|
| `scaffold-flags-meta.js` | check-flags.yml | Stub `flags-meta.json` entries for new build flags | `FLAGS_META_PATH`, `FLAGS_SEARCH_ROOT`, `COMPONENT` |
| `resolve-all-flag-states.js` | check-flags.yml | Per-env `build` states from `flag-parts/`, stubs for missing meta, collision guard | `FLAGS_SEARCH_ROOT`, `FLAGS_META_PATH`, `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH`, `CHANGED_BY`, `COMPONENT` (required) |
| `check-flags-metadata.js` | check-flags.yml | Fail CI on incomplete flag metadata; `WARN_ONLY=true` turns failures into `::warning::` (for onboarding) | `FLAGS_META_PATH`, `FLAGS_SEARCH_ROOT`, `STATUS_REPO_EDIT_URL`, `WARN_ONLY` |
| `fill-flag-metadata.js` | fill-flag-metadata.yml | Set one flag's metadata by hand; the workflow fires `flags-meta-changed` after a real push | `FLAG_KEY`, `DESCRIPTION`, `SOURCE`, `JIRA_KEYS`, `COMPONENTS` |
| `sync-runtime-be-flags.js` | sync-runtime-be-flags.yml | Poll BE flag endpoints per env, update states + meta | `URL_TEST`/`URL_QA`/`URL_PROD`, `COMPONENT` (required), `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH`, `FLAGS_META_PATH` |
| `update-flag-state.js` | update-flag-state.yml | Set one flag/env/slot (manual or `flag-changed` dispatch); no-op when unchanged | `FLAG_KEY`, `ENVIRONMENT`, `ENABLED`, `CHANGED_BY`, optional paths |
| `sync-github-deployments.js` | orchestrate-full-sync.yml | Deployments for one repo: records, cursor, summary, issue-deployments, drift; warns above `SIZE_WARNING_THRESHOLD_MB` (20) | `GITHUB_TOKEN`, `APP_REPO`, `COMPONENT`, `RETENTION_DAYS`, `CURSOR_PATH`, `ISSUE_DEPLOYMENTS_PATH`, `SUMMARY_PATH`, `SIZE_WARNING_THRESHOLD_MB`, `STUCK_DEPLOYMENT_MAX_AGE_HOURS`, `MAX_NEW_DEPLOYMENTS_PER_RUN`, `VERSION_FILE`, `DRIFT_IGNORE_PATHS`, `GITHUB_API_ETAG_CACHE_DIR` |
| `sync-jira.js` | orchestrate-full-sync.yml, backfill-jira-issues.yml | Jira shards (modes above) and `status-index.json` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `SPACES_PATH`, `JIRA_ISSUES_DIR`, `BACKFILL_PIS`, `JIRA_BOARD_LOOKUP_STRICT` |
| `prune-jira-pis.js` | prune-jira-pis.yml | Delete named PI shards and record them in `pruned-pis.json` | `JIRA_ISSUES_DIR`, `PRUNE_PIS` |
| `retrigger-app-checks.js` | retrigger-app-checks.yml | Re-run failed `check-flags` runs in one app repo (the workflow is meant to be a matrix over components with `featureFlagsIncluded: true`) | `APP_REPO`, `APP_REPO_RERUN_TOKEN`, `WORKFLOW_FILE` |
| `backfill-deployment-metadata.js` | backfill-deployment-metadata.yml | Fill newer fields on older records, re-resolve SHA-like versions, repair empty-range duplicates | `GITHUB_TOKEN`, `APP_REPO`, `COMPONENT`, `MAX_RECORDS_PER_RUN` |
| `backfill-flag-state-history.js` | backfill-flag-state-history.yml | Seed flag history from `live`'s git history | `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH` |
| `record-full-sync.js` | orchestrate-full-sync.yml | Stamp `sync-meta.json` | `SYNC_META_PATH` |
| `release.js`, `release-notes.js`, `check-commit-message.js` | release.yml, pr-title.yml | Versioning (`RELEASING.md`) | — |
| `check-module-boundaries.js` | — (also a test) | Module boundary check | — |

`check-flags.yml` is a reusable workflow called from app repos. Its writing step runs only
`if: github.event_name != 'pull_request'` (a PR's unmerged flags must not reach `live`); the read-only metadata
check runs on every trigger and is the pre-merge gate, softened only when the caller passes `WARN_ONLY: true`.

## Frontend (`docs/`)

**Files.** Classic `<script>` tags (not ES modules — those do not load over `file://`, which `FALLBACK` needs),
loaded by `docs/index.html` in this order: `app-html`, `app-core`, `app-components`, `app-data`, `app-model`,
`app-product`, `app-technical`, `app-technical-matrix`, `app-technical-timeline`, `app-technical-flags`,
`app-release-notes`, `app-insights`, `app-main` (last; it calls `init()`). They share one global scope. Function
declarations hoist only within one file, so code that *runs* at load time may use only the same or earlier files —
`const FALLBACK = buildFallbackData()` sits in `app-main.js` for that reason. New code goes in the file for its area;
`app-technical.js` keeps the helpers shared by the three `app-technical-*` files.

**Escaping.** `app-html.js` provides the `html` tagged template (and `escapeHtml`): every interpolated value is
escaped unless it is a nested `html` result, a `raw()` constant (e.g. an `ICONS` entry) or an array of those. All
`innerHTML` code uses `html`. An array of results assigned to `innerHTML` is comma-joined — wrap it as
`` html`${arr}` ``. An already-built fragment interpolated into `html` must be `raw()` or it shows escaped. A plain
`.title =` DOM property is never HTML-parsed and takes the raw string. Commit messages, Jira fields, display names
and workflow inputs are untrusted.

**Components.** `app-components.js` holds the markup: pure PascalCase functions (`Tag`, `StatusPill`, `SummaryCard`,
`EpicHeader`, `DeployCard`, `FlagRow`, `BarRow`, `EmptyState`, …) taking one props object, reading no `state`/DOM,
returning `html`. Views compute data and call them; older view functions (`jiraStatusTagHtml`, `issueRowHtml`,
`renderDeployCard`, …) are thin wrappers. New markup goes there (`test/app-components.test.js`).

**Data loading.** `loadData()` fetches `deployments.json`, `flags-meta.json`, `flag-states.json`,
`jira-issues/index.json`, `status-index.json`, `summary.json` and `components.json` (the last three best-effort), then
one PI shard (`loadJiraIssuesForPi()`); never more than one PI's issues in memory (`state.jiraIssues`,
`state.selectedPi`). The up-front files have `<link rel="preload" as="fetch" crossorigin>` in `index.html`
(`crossorigin` is what lets the later `fetch()` reuse it). Jira links: `jiraIssueUrl(key)` (`app-core.js`) uses the
API's `jiraBrowseUrl` in SaaS mode and the constant `JIRA_BASE_URL` in file mode (the sync's secret is the API
proxy URL, not the site). Dates use `pl-PL`, except the Insights rollbacks/drift chart axis (`en-US`).

**Global controls.** One PI `<select>` (`initGlobalPiSelect()`) in the tabs row serves Product view, Release Notes
and Insights (hidden on Technical view). Options come from `index.json` with the server's `currentPi()` marked; a
change refetches the shard behind a "latest request wins" check, refreshes the Product/Release Notes filter options
and re-renders. `currentPi()` (the org's active PI) and `state.selectedPi` (what the user browses) are different
things. `#filterSprint` (next to it, shown only on Product view) narrows to "All sprints", the current sprint
(default, "Current sprint (name)", resolved from `index.json` dates for the current PI only; with several active the
newest-started), "Current sprint + unresolved" (`SPRINT_CURRENT_PLUS_UNRESOLVED`: the current sprint plus
older-sprint items of the PI not yet released on prod; offered only when a current sprint exists) or one sprint.
It is a scope control: reapplied on load and PI switch (`refreshSprintSelect()`), not reset by "Clear".
`issuesInSprintScope()` feeds the issue list, the Epic rollup and the summary tiles.

**Product view.** Grouped by Epic (`groupIssuesByEpic()`): an Epic is a header, never a data row; children group by
`epicKey` even when the Epic itself was not synced (header from the child's `epicKey`/`epicTitle`); the rest goes to
"Ungrouped". Groups keep first-encounter order; children sort by `WORK_ITEM_TYPE_ORDER` (Bug, Story, Task; stable),
and the Type filter uses the same order prefixed by Epic. The header shows `epicRollup()` "N/M released to PROD"
(strict `prodStatusBucket() === 'released'`, same as the summary tiles), a "Fully released" tag when all are, an
open-bug icon (`epicHasOpenBug()`), and is scoped by date/sprint, not by Type/Priority. Rows show the Jira key, a
status tag (`jiraStatusTagClass()` by status text: done-ish green, in-flight blue, `Blocked` red; Jira's Flagged
marker folded in as `ICONS.flag`), a sub-task tag, a "Continued in PI-X" badge when `status-index.json` places the
key in another PI (`piContinuationBadge()`), a ghost-flag age (`ghostFlagAge()`: prod `deployed`/`partial` for more
than `GHOST_FLAG_DAYS` = 30 since the later of deploy and last flag change) and per-env pills with plain-language
tooltips (`statusLabelTooltip()`, also in the `.table-legend` row). `#filterHideTasks` hides Tasks; it is an
ordinary filter reset by "Clear" and on PI switch. The `FALLBACK` dataset (`EBO-99001`, `legacyMigrationEnabled`,
deploy `d21` under `EVP-4288`) exercises the ghost-flag and open-bug badges in the `file://` preview.

**Technical view.** Summary cards, the component × env matrix (`app-technical-matrix.js`), Deployment history
(`app-technical-timeline.js`) and the flags list (`app-technical-flags.js`). Matrix rows have `min-height: 70px`
and `10px 12px` padding; after each render, every component's rows across the three env cards are snapped to the
tallest (no re-measure on resize). An env card shows only "Diff to ENV" (`driftNotesHtml()`); `openDriftModal()`
shows the file diff, the Git history counts and "What this does not show". The timeline defaults to "Last 90 days"
(`filterDeployRange`, display-only, unrelated to `RETENTION_DAYS`); clicking a deployment in the matrix clears it.
The flags panel uses `status-index.json` for `flagBlastRadius()`/`flagStaleWarning()` (`STALE_FLAG_DAYS` = 60).

**Release Notes** (always on). Real-PI (`isRealPi`) issues released to users on prod (`issueIsReleasedToProd()`:
`released` or `deployed_code_only`), grouped by PI → sprint (newest first, `compareVersionDesc`), split into
"Features & Improvements" and "Bug Fixes"; a Service filter over `components.json` applications narrows the list.
Unreleased issues are not shown. Each item: title + PROD pill on the first line, then the key (a plain
`<span class="tag mono">`; the title is already the link) and the first prod date (`earliestProdDeployedAt()`,
omitted when unknown). Empty with fallback stubs.

**Insights** (behind `?insights=1`, `INSIGHTS_ENABLED`). Hand-rolled charts over existing data: release status per
sprint on prod (`sprintReleaseStatusBreakdown()`, labels from `sprintLabelFor()`) and lead time Done → prod
(`leadTimeToProdBySprint()`, median days, negative clamped to 0) side by side; release status per priority
(`priorityReleaseStatusBreakdown()`, `PRIORITY_ORDER` = Blocker/Critical/Major/Medium/Minor, issues without one
excluded); stale flags by days on in prod (`staleFlagDaysBreakdown()`); rollbacks and drift per month for the last
12 months (`rollbackDriftByMonth()`). The last two are cross-time, not PI-scoped, so untagged hotfixes still show.
