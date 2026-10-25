# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository. It states the rules the code relies on; the
history of how they came about is in git and `CHANGELOG.md`. Related documents:

- `docs/GLOSSARY.md` — terms that have more than one name (component / tracked repo, PI / increment, source / slot).
- `design-docs/REPORT_ARCH.md` — architecture and DDD analysis (2026-10-17, written while the file-based sync was
  still here); `ADR-001` (flags are pushed from outside), `ADR-002` (the three memory policies), `ADR-003`
  (flag sources ShipScope reads itself, state per service, explicit freshness; replaces ADR-001's "never reads");
  `ROADMAP.md` — decided future work, in order; `FEATURES(.pl).md` — undecided ideas; `TODO.md` — technical debt;
  `SECURITY.md` — security decisions (actions pinned to a commit SHA, Dependabot) and the settings still to set by
  hand.
- `FAQ.md` — how each number and badge on the dashboard is computed; `ONBOARDING.md` — setting up a workspace;
  `server/README.md` — routes, security model, local setup; `server/SETUP.pl.md` — setting up a server;
  `server/SEKRETY.pl.md` — the encryption keys (what each is for, first setup, rotation, troubleshooting);
  `server/KOPIE.pl.md` — database backups (Render's PITR and exports, a copy outside Render), restoring, and the
  quarterly restore test with `npm run verify-restore --prefix server` (`lib/restore-check.js`, read only, takes
  `RESTORE_DATABASE_URL`, never `DATABASE_URL`; `server/test/restore-check.test.js`); `server/SLO.pl.md` — the SLOs,
  error budget, alerts and the public status page;
  `RELEASING.md` — versions.

## What this repo is

ShipScope is a deployment / feature-flag / Jira status dashboard, run as a multi-tenant service: the backend in
`server/` (Fastify + Postgres on Render, scoped by `context/foundation/prd.md`) syncs GitHub deployments and Jira
issues per tenant, receives feature flags, and serves the static frontend in `docs/` (`docs/index.html` +
`docs/app-*.js`) at `/t/<tenantId>/` with data from its own API.

The original single-organization **file-based sync** (Node scripts run by GitHub Actions writing
`docs/data/*.json` to a `live` branch served by GitHub Pages) lives only in the original repository,
`circlek-global/evdt-service-shipscope`; it was removed from this one on 2026-10-17. Its deployment, version and
drift rules were ported into `server/lib/`, which is now the only copy here. Opened outside the server (`file://`,
any static file server) the frontend shows the built-in `FALLBACK` sample data and fetches nothing.

**Run it locally:** `npm run dev` (repo root or `server/`; `server/scripts/dev.js`, Node 20+ and Docker). It installs
the server's dependencies, creates `server/.env`, starts Postgres in Docker (`shipscope-dev-pg`, port 54329) with a
database owned by the non-superuser role `shipscope_app` (RLS applies, as on Render), creates a GitHub App on the
first run through GitHub's manifest flow (one click on a local page; the keys go to `server/.env`), applies the
migrations, starts `web.js` and `worker.js`, and prints `http://localhost:3000/`. A `DATABASE_URL` pointing elsewhere is
used as is. Pure helpers are tested in `server/test/dev.test.js`. `npm run dev:mock` (`--mock`) runs the same, but with
`SHIPSCOPE_MOCK_DATA=1`: the dashboard-data and jira-issues routes answer members with the `FALLBACK` sample dataset
(`server/lib/mock-dashboard.js` builds it once by running `docs/app-*.js` in a `vm` sandbox, so there is one copy of
it) and the badge reads "Mock". Sign-in, workspaces and settings stay real; refused unless `PUBLIC_BASE_URL` is
localhost.

## Layout and tooling

- No linter, bundler or TypeScript. Root `package.json` has no dependencies and only exposes scripts:
  `npm run dev`, `npm run dev:mock`, `npm test` (`node --test "test/*.test.js"`), `npm run release`, `npm run lint:commit`,
  `npm run hooks:install`.
- `adapters/flags/` is the flags adapter teams run in their own pipelines (GitHub Action `action.yml` and CLI
  `shipscope-flags.js` over `lib.js`, Node 20+, no dependencies): reads flags from files (JSON, YAML via `yaml.js`, `.properties`,
  `.env`, TypeScript/JavaScript read without running them by `script-objects.js`; objects or lists of flags;
  `{env}` in a pattern + `env-map` for one file per environment) or a URL and posts their state to `POST /api/flags/ingest`. Tested in
  `test/flags-adapter*.test.js` and end to end in `server/test/flags.test.js`.
- `scripts/` holds only tooling: the release scripts (`release.js`, `release-notes.js`, `check-commit-message.js`,
  `lib/conventional.js`, `lib/json-file.js`) and the module-boundary check.
- `server/` is a separate dependency boundary: its own `package.json`, `node_modules/` (gitignored) and `test/`.
  Root `npm test` never runs `server/test/`. Run `npm install && npm test` inside `server/` (real-Postgres tests need
  `TEST_DATABASE_URL`, see `server/README.md`).
- **Module boundaries** (`scripts/lib/module-boundaries.js`, `node scripts/check-module-boundaries.js`, tested in
  `test/module-boundaries.test.js`): `scripts/` never requires from `server/` and vice versa; `adapters/` requires
  from neither; `server/` may require only the adapter's readers (`adapters/flags/lib.js`); `docs/app-*.js` never
  calls `require()`.
- Workflow actions are pinned to a full commit SHA with `# vX.Y.Z` (`test/workflows.test.js`); Dependabot
  (`.github/dependabot.yml`) bumps them monthly in one PR. Why: `design-docs/SECURITY.md`.
- Workflows: `test.yml` (PR title check + root tests + actionlint in one job; a title edit re-checks only the title, a
  description edit is skipped; actionlint is a release binary checked against a pinned SHA-256, bumped by hand) and `server-test.yml` on PRs (a newer push cancels the older run), `release.yml` on every merge to `main`, whose `verify` job is main's only test run
  (both suites) and gates the tag. Each job bills at least a minute, so small steps share a job.

## Tests — `node:test`, not Jest

- `node:test` + `node:assert` only. No `jest.fn()`/`jest.mock()`/`expect(...)`; use `t.mock.fn()`/`t.mock.method()`
  and `assert.strictEqual`/`deepStrictEqual`/`rejects`. Copy the pattern from an existing test file.
- Root (~230 cases): every `docs/app-*.js`, the flags adapter, the release scripts and the boundary check. Files that touch disk use a
  gitignored `test/.tmp-*` path removed in `after()`.
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

## Versioning (`RELEASING.md`)

One SemVer number for the whole application, in `package.json`, `server/package.json` and
`server/package-lock.json` (kept equal, `test/release.test.js`), shown in `GET /health`. Commits and PR titles
follow Conventional Commits (`feat(SHP): ...`; PRs are squash-merged, so the title counts), checked by
the `Tests` workflow (`.github/workflows/test.yml`) and the optional `.githooks/commit-msg`. After each merge to `main`,
`release.yml` runs `scripts/release.js --ci`, commits `chore(release): X.Y.Z` with the versions and a
`CHANGELOG.md`/`CHANGELOG.pl.md` entry, tests that commit, tags `vX.Y.Z` and creates a GitHub Release
(`scripts/release-notes.js`, rules in `scripts/lib/conventional.js`). Never edit the version or a `## [X.Y.Z]`
changelog entry by hand outside a `chore(release)` PR.

## Backend (`server/`)

Deployed to Render per `context/foundation/infrastructure.md`: `render.yaml` builds both the Web Service and the
Background Worker from the repo root (`npm ci --prefix server`, `node server/web.js`), not `rootDir: server`, which
would hide `docs/` from the Web Service. Migrations (`server/migrations/001`–`036`, applied by the hand-rolled
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
invitations, github_installations, tracked_repos, deployments, issue_deployments, flag_sources, flag_source_repos, flag_source_envs, ingest_tokens, flags,
flag_values, flag_value_history, jira_connections, jira_boards, jira_pis, jira_issues, audit_events, endpoint_tests, jira_access_grants, release_lines, flag_commit_links) — must run inside
`withScope()`, which sets `app.current_tenant_id`/`app.current_user_id` with transaction-local
`set_config(..., true)`. An unscoped read returns zero rows; an unscoped write is an RLS error.
`lib/withscope-guard.js` (`server/test/withscope-guard.test.js`) fails on any `pool.query(...)` in `server/lib/`
that names an RLS table. Every tenant table cascades from `tenants`; `DELETE /tenants/:tenantId` (admin, name typed
back, `deleteTenant()`) relies on it, and `server/test/tenant-delete.test.js` checks every table in `RLS_TABLES` is
emptied. `sync_requests` (webhook, dashboard-refresh and worker-request queue: `github`/`jira`/`flags`/`endpoint-test`/`jira-token`), `worker_status` (migration `020`) and `status_samples` (`035`) are the non-RLS tables; none holds
tenant data.

**Logs and health.** Both services log JSON lines through `lib/log.js` (`createLogger()`, `LOG_LEVEL`; the web
service via Fastify's pino with `loggerOptions()`): `time`, `level`, `service`, `version`, `msg` plus fields, never a
credential (`redact()`, credential-named fields masked) or a flag value. Web request lines carry `requestId` (also
`X-Request-Id`), `tenantId` and `userId`; refusals log their `reason`. Worker jobs run through `runJob()` (outcome,
`durationMs`, `recordRun()` into `worker_status`); the sync modules call `log(msg, { level, tenantId, repo, err })`.
`GET /health/worker` (`lib/worker-status.js`, `judgeWorker()`) answers 503 for a missing heartbeat, a sync without
success for 3 × `SYNC_INTERVAL_MINUTES` + 5 minutes, or an undrained webhook queue; an uptime monitor alerts on it
(`server/README.md`, "Monitoring and logs"). Tested in `server/test/observability.test.js`. `GET /metrics`
(`lib/metrics.js`, only with `METRICS_TOKEN`, bearer, Prometheus text): the web process's in-memory counters (an
`onResponse` hook: ingest outcomes by status, webhook deliveries, status classes) plus `worker_status` (migration
`033`: any job name, `last_duration_ms`, `runs_total`, `failures_total`; `runJob()` passes `durationMs`) and the
worker's `sources` job (`sourcesTick()`, every 5 minutes, `flagSourceHealth()` in `lib/flags.js`: sources by origin,
environments by freshness, refused in the last hour, counts only) (`server/test/metrics.test.js`). The public
`GET /status` (HTML, no script) and `GET /status.json` (`lib/status-page.js`): judgeWorker()'s components now and per
day for 90 days, from `status_samples` (migration `035`, non-RLS, counts per component and day, kept 120 days) that
the web service fills once a minute (`sampleStatus()`, web.js); a day is an outage above 1% `down`
(`server/test/status-page.test.js`).

**Features, by PRD requirement:**

- **Sign-in (FR-001)** — the GitHub App's user-authorization flow (`lib/github-oauth.js`), server-side sessions
  (`lib/sessions.js`, only a SHA-256 of the cookie token stored; the GitHub user token is never stored).
- **Tenants and members (FR-002/003)** — `lib/tenants.js`; invitation links (`lib/invitations.js`: one-time hashed
  tokens, single-use claim by conditional `UPDATE`, last-admin guard). `GET /invitations/:token` answers HTML (a
  page with a Join button, `ui/invite.html`) to browsers and JSON to other clients.
- **GitHub App connection (FR-004/006)** — `lib/github-app.js` (App JWT, installation tokens; a GET failing with a
  5xx or a network error, not a timeout, is retried after 2/4/8 s, `RETRY`; writes and rate limits never are),
  `lib/github-connections.js`.
  An installation is linked only after the user's own token shows they can access it (`GET /user/installations` in
  the sign-in callback), never on the `installation_id` of GitHub's setup redirect alone.
- **Deployment ingestion (FR-005)** — the worker (`worker.js`) runs `lib/deployment-sync.js` and the Jira sync
  every `SYNC_INTERVAL_MINUTES` (default 15) and `lib/retention.js` daily (behind a Postgres advisory lock). The deployment,
  Jira and endpoint-flag passes take no global lock: each tenant is claimed per job (`withTenantClaim()`,
  `lib/tenant-claim.js`, `pg_try_advisory_lock(CLAIM_CLASS[job], hashtext(tenantId))`), so several worker instances
  share them; a tenant held elsewhere is skipped (`busy`), what is due is re-read under the claim, a periodic pass
  leaves out what was attempted after it began, `WORKER_CONCURRENCY` (1–8, default 1) tenants run at a time per job
  (`eachLimited()`), a tick is skipped while the job's previous pass still runs in the process, and endpoint polling
  sends at most 2 requests at a time to one host (`limitPerHost()`) (`server/test/tenant-claim.test.js`,
  `sync-fairness.test.js`, `jira-sync.test.js`, `flag-poll.test.js`). Retention is per tenant
  (`tenants.deployment_retention_days`, default 90, 7–730) and always keeps each repo/environment's latest and latest
  successful deployment; flag changes (`flag_value_history`, `cleanupFlagHistory()`, migration `034`) follow it too,
  keeping each source/flag/environment's latest, and the dashboard reads at most the newest `HISTORY_READ_LIMIT` (5000)
  (`server/test/flag-history-retention.test.js`). Version resolution (`lib/version-resolution.js`: release → tag → version file → commit
  message; compares use only a verified release/tag or the SHA, stored as `deployments.resolved_ref`). A version
  file's label goes through `matchVersionLabel()`: the tag as written, the `v` prefix toggled, the base `X.Y.Z` tag
  of a suffixed label (`1.4.25-okta`; label kept, tag used), and `latest` = the newest published non-prerelease
  release before the deployment's `created_at` (its tag becomes the label). Drift
  (`lib/env-drift.js` + `lib/tree-diff.js`) is stored per repo in `tracked_repos.drift = { inputs, failed, envs }`,
  recomputed only when a latest successful deploy changed or the last attempt failed; a failed comparison keeps the
  previous value. Per-repo `version_file`/`drift_ignore_paths` are set by an admin
  (`PUT /tenants/:tenantId/github/repos/:repoId/settings`). Installation tokens are minted read only
  (`TOKEN_PERMISSIONS` in `lib/github-app.js`: actions, contents, deployments, metadata; on a 422 the subset the
  installation has). `workflowRunUrl` is a status's `log_url` only when `trustedRunUrl()` sees a run of that very
  repository on github.com. `manual` (needs the App's Actions read permission) and
  the creator's display name come from `lib/deployment-people.js`: display-only, cached per tenant per pass, never
  failing the sync.
- **Feature flags** — today pushed from outside, never read by ShipScope (`ADR-001`); `ADR-003` decides the
  next model (flags in code read at the deployed commit, polled endpoints, per-service state, freshness), built in
  the increments of `design-docs/ROADMAP.md`. An admin names the tenant's flag
  sources (kind `build`/`runtime`, priority, the services it covers: `flag_source_repos`, migration `018`;
  `flag_sources.repo_id` keeps the first for older readers) and may declare a repo without flags
  (`tracked_repos.flag_stance`, `PUT …/github/repos/:repoId/flag-stance`); each sends the full state of its flags per
  environment with its own token to `POST /api/flags/ingest` (`schemaVersion: 2`: `off`/`on`/`partial` + rollout,
  the sender's `changedAt`, flags no longer listed are marked removed, an older message never undoes a newer one).
  A key every JavaScript object already has (`__proto__`, `constructor`, `toString`, …, `isReservedKey()` in
  `lib/flags-logic.js`) is refused on ingest, skipped when reading, and not taken from Jira; the adapter refuses it too.
  The ingest is guarded for a shared service: a per-token token bucket (`lib/request-limiter.js`, burst 60 then 1/s,
  429 + `Retry-After`) runs before any database work, and the wait for the per-tenant ingest lock is bounded
  (`lock_timeout` 10 s, then 503 + `Retry-After`); the adapter retries both. Tokens (migration `017`) expire after a
  chosen lifetime (default 365 days, or never; older tokens never) and may be limited to some environments; an
  expired token is a 401 and an out-of-scope message a 403, both noted on the source, and Settings plus the checklist
  warn `TOKEN_WARNING_DAYS` (30) before a source's last token runs out. Instead of a token, a GitHub Actions run may
  send GitHub's OIDC token with `X-ShipScope-Source: <tenantId>/<sourceId>` (migration `032`, `oidc_config`,
  `checkOidcConfig()`/`oidcRefAllowed()`): `lib/github-oidc.js` verifies it (RS256 with GitHub's JWKS only, cached an
  hour, refetched for an unknown key at most every 5 minutes; `iss`, `aud` = `PUBLIC_BASE_URL`, `exp`), and
  `ingestWithOidc()` accepts it only for a push source that covers the run's `repository_id` (a tracked repo) on an
  allowed ref and environment (`server/test/github-oidc.test.js`, `server/test/flags-oidc.test.js`); the adapter's
  `oidc`/`source` inputs ask GitHub for it (`requestIdToken()`), Settings → Sources has the switch (`OidcFields()`).
  The body schema is `server/schemas/flags-ingest.v2.schema.json`, used by the route and served at
  `GET /api/flags/ingest/schema`; the sender's guide (format, where flags live, the adapter, `jq` recipes) is
  `ONBOARDING.md`. Each source keeps its status (migration `016`): the last accepted message's summary
  (`last_ingest_at`/`last_ingest`) and the last refused one's reason (`last_error`/`last_error_at`, recorded by
  `recordIngestError()` after the rollback, schema refusals included via `attachValidation`), shown in Settings and
  the Getting started checklist. Freshness (ADR-003, migration `019`): every write goes through `applyObservations()`
  (`lib/flags.js`, pinned by `server/test/flags-ingest-characterization.test.js`); a complete message stamps
  `flag_source_envs.last_observed_at` for each environment it covers, and `freshnessOf()` (`lib/flags-logic.js`)
  gives `fresh`/`stale`/`error`/`unknown` per source and environment against the source's `stale_after_minutes`
  (default `STALE_AFTER_MINUTES`: runtime a day, build never) and its last refusal. A customer's flags file is read
  only through `parseFlagFile()` (`lib/flag-file-parser.js`): the adapter's readers in a `worker_threads` thread
  (`lib/flag-file-worker.js`, no env, 64 MB, 2 s) behind size/nesting/node/flag limits (`LIMITS`), `.env` and
  `.properties` only with a prefix or a key list, and errors that never carry a value from the file
  (`server/test/flag-file-parser.test.js`). `render.yaml` redeploys both services on `adapters/flags/*.js`.
  Flags in code (migration `021`, `lib/code-flags.js`): a source with `origin: 'code'` (a build source over exactly
  one repo, no token; `code_config` checked by `checkCodeConfig()`: `file` with at most one `{env}`, `envNames`,
  `path`/`valuePath`/`keyField`/`rolloutPath`/`prefix`/`keys`) is read by `refreshCodeFlags()` after each complete
  repo sync (`syncRepo()`, after drift): per environment, the file at the latest successful deployment's resolved ref,
  only when that ref differs from `flag_source_envs.last_ref`, under `lockTenantFlags()`, through
  `applyObservations()` (complete, `changedAt` = the deployment's time). A missing or unreadable file records the
  environment's `last_error` and keeps the flags; a rate limit is rethrown (`server/test/code-flags.test.js`).
  Suggested links (migration `026`, `lib/flag-link-suggestions.js`): flags a reading changes (`changedFlagKeys()`)
  get the Jira keys of the commits between the environment's previous `last_ref` and the new one that touched the file
  (compare ∩ `commits?path=`; none for a rollback) in `flags.suggested_jira_keys` (`planLinkSuggestions()`: never one
  already linked or in `dismissed_jira_keys`, at most 20); `listFlags()` returns `suggestions`, and
  `POST /tenants/:tenantId/flags/:key/suggestions` `{ jiraKey, accept }` links it by hand or dismisses it for good
  (Settings → Flags). A failure there is logged and never fails the reading.
  Every request to an address a customer gives goes through `safeFetch()` (`lib/safe-fetch.js`): https:443, every
  DNS answer public (`forbiddenAddress()`, a `net.BlockList`), the connection pinned to the checked address, no
  redirects, a time limit and a size limit after decompression (`server/test/safe-fetch.test.js`, a local TLS server).
  Flags from an endpoint (migration `023`, `lib/endpoint-flags.js`): a runtime source with `origin: 'endpoint'`,
  `endpoint_config` checked by `checkEndpointConfig()` (`urls` per environment through `checkUrl()`, `format`
  json/yaml else the content type, the file reading fields, `tokenHeader`), the customer's token sealed in
  `endpoint_token_enc` with `endpointTokenAad()` (tenant, source, purpose), never returned (`hasEndpointToken`); with a
  sealing key pair (`loadSealingKeys()`: `SECRETS_PUBLIC_KEY` on both services, `SECRETS_PRIVATE_KEY` on the worker only)
  it is sealed for the worker (`sealEndpointToken()`, `lib/sealed-box.js`, format `p1.`), so the web service cannot read
  it back: "Test" with a stored token is queued (`endpoint_tests`, migration `029`, `202 { pending, testId }`) and run by
  the worker's `endpointTestTick()` every 2 s (`runQueuedEndpointTest()`, `server/test/sealed-secrets.test.js`).
  Requests carry `X-ShipScope-Timestamp`/`X-ShipScope-Signature` (`signatureHeaders()`, HMAC-SHA256 with
  `tenantSigningSecret()`: stored sealed in `tenants.endpoint_signing_secret_enc`, migration `027`, first filled with
  `signingSecret()`, the HKDF value earlier versions derived from the key; `GET …/flag-endpoint-signing`; an admin
  replaces it with `POST …/flag-endpoint-signing/rotate`, `rotateSigningSecret()`, effective at once).
  Secret access is audited (migration `028`, `lib/audit-log.js`, `recordAuditEvent()` in the same transaction):
  the signing secret shown or replaced, an endpoint token set or removed, Jira connected or disconnected, never the
  secret; `GET …/secret-events` (admin), Settings → Sources "Secret activity" (`server/test/secret-audit.test.js`).
  So is every other settings change (migration `031` renamed the table `audit_events`, kinds in `AUDIT_EVENT_KINDS`,
  each with a label in `settings.js`): the workspace created, retention, invitations, members joining, leaving or
  removed, GitHub accounts linked or unlinked, repos tracked, untracked and their settings/environments/flag
  stance/role, flag sources and ingest tokens, a flag's hand-set details and answered suggestions, Jira's site,
  boards, board rhythm and flag convention; the subject names what changed, never a token. `GET …/audit-events`
  (admin, latest 100), Settings → General "Settings activity", reloaded after each admin action
  (`server/test/audit-log.test.js`).
  `refreshEndpointSource()` writes each environment's full state through `applyObservations()` (`changedAt` = now); a
  failure is `recordSourceEnvError()` and keeps the flags. `POST …/flag-endpoint-test` (admin, per-workspace limit)
  returns only parsed flags (`server/test/endpoint-flags.test.js`). Settings → Sources, Read flags from an endpoint
  (`EndpointSourceFields()`: `url_<env>`, path, token header, a password field that is never filled, "remove the stored
  token", interval; Test shows `EndpointTest()`, the signing secret shows once in a `SecretBox`). Polling (migration `024`, `lib/flag-poll.js`
  `pollEndpoints()`): the worker's `flagsTick()` every minute (`FLAGS_LOCK`) reads due sources (`next_poll_at`, at most
  `POLL.perTenantPerTick` per tenant) and schedules the next read with `nextPollAt()` (`pollIntervalMinutes`, default 5,
  min 2, ±10% jitter, doubling backoff to an hour on `poll_failures`); at most `POLL.maxSources` endpoint sources per
  tenant. The dashboard-data route queues a `flags` `sync_requests` row per tenant; `webhookTick()` drains it with
  `onDemand` (not read in the last minute, not failing). `/health/worker` checks `flags` when the key is set
  (`server/test/flag-poll.test.js`).
  Setting one up (`lib/flag-discovery.js`, admin, read only): `GET …/github/repos/:repoId/flag-files` proposes files
  named like flags (`flagFileCandidates()`: json/yaml/ts, outside tests/builds, a file per environment folded into one
  `{env}` template with `envNames`; never `.env`/`.properties`) at the latest prod deployment (else any, else `HEAD`),
  each read as is or under a common path (`flags`, `features`, …); `POST …/flag-preview` reads a config per
  environment at its own deployment. Settings → Sources: Find flags files, Use this, Preview, then Read from code
  (`server/test/flag-discovery.test.js`).
  Sources of one kind fold into the dashboard's `build`/`runtime-be` slot by priority. Flags link to Jira issues
  from four origins merged in `readDashboardFlags()`: the sender's `jira_keys`, hand-set
  `manual_jira_keys`/`manual_description` (`PUT /tenants/:tenantId/flags/:key`, never overwritten by a sender),
  Jira's own, read at sync time by the tenant's `jira_connections.flag_link` convention (a custom field or a label
  prefix, `extractFlagKeys()`), and deployed commits: a `Flag: <key>` trailer (tf talos-story-run, next to
  `Change: TSK-n`) links the flag to the keys of that same commit (`flagLinksFromMessages()` in
  `lib/deployment-logic.js`, stored by the deployment sync in `flag_commit_links`, migration `036`, read by
  `commitLinks()` without the flag's `dismissed_jira_keys`; Settings shows them as `links.commit`, and a commit-linked
  key is no longer a suggestion) (`server/test/flag-commit-links.test.js`). The file-based `schemaVersion: 1` contract was not ported.
- **Jira (FR-007–009)** — connected per tenant through Atlassian OAuth 2.0 (3LO) (`lib/atlassian.js`,
  `lib/jira-connections.js`). Only the refresh token is stored, AES-256-GCM-sealed with the tenant id as associated
  data (`lib/secret-box.js`, key `TOKEN_ENCRYPTION_KEY`; format `v2.<key id>…`, any key of the ring opens it, old keys
  in `TOKEN_ENCRYPTION_KEY_PREVIOUS`, the worker's `secretsTick()` re-seals with the current one, `lib/secret-rotation.js`,
  server/README.md "Rotating TOKEN_ENCRYPTION_KEY"; with the sealing key pair it is sealed for the worker instead,
  `sealRefreshToken()`, and the web service gets access tokens through `accessTokenViaWorker()`: a `jira-token` request
  the worker's `jiraTokenTick()` answers with `handOverAccessToken()` into `jira_access_grants`, migration `030`, cached
  until expiry, `WorkerUnavailableError` = 503, `server/test/jira-worker-tokens.test.js`); access tokens are minted per use under a row lock because
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
  Release lines (G1.3, pdi contract 0.4.0): each issue's line `R1…Rn` (R1 = MVP) by the tenant's
  `jira_connections.release_link` (migration `036`, default `{ type: 'label', prefix: 'release:' }`; `fixVersion` with
  an optional prefix, a text/select `field`, or `none`; `PUT …/jira/release-link`, audited `jira_release_link_changed`,
  Settings → Jira `ReleaseLinkForm()`), read by `extractReleaseLine()` in `lib/jira-model.js` (the lowest of several)
  into the issue's `releaseLine`; the sync keeps `release_lines` (origin `jira`) in step with every issue it read
  (`writeReleaseLines()`) (`server/test/release-lines.test.js`). The repo mode (`changes/CHG-n/release.yaml`, origin
  `repo`, a pinned copy of the contract's schema) waits for F1 (design-docs/G1.3-PLAN.pl.md).
- **Webhooks** (`lib/webhooks.js`, migration `013`) — `POST /webhooks/github` (HMAC, `GITHUB_APP_WEBHOOK_SECRET`)
  and `POST /webhooks/jira` (HS256 JWT signed with the Atlassian client secret; a token without `exp` is logged as
  `jira webhook token without exp` and accepted unless `JIRA_WEBHOOK_REQUIRE_EXP=1`, since Atlassian does not
  document the claims) only queue a key in `sync_requests`;
  the worker's `webhookTick()` drains it every 30 s with `syncAll({ repoIds })`/`syncAllJira({ keys })` under the
  same per-tenant claims; a request whose tenant was `busy` stays queued. Jira webhooks are registered and refreshed per tenant by `ensureWebhook()` in the Jira sync
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
  `docs/app-html.js`). `settings.js` is a classic script on `html` with pure `render*` pages and `data-action`
  buttons/forms calling the JSON routes (which enforce roles), tested in `server/test/settings-ui.test.js`. One page
  at a time by hash (`PAGES`, `pageFromHash()`: `#general`, `#members`, `#github`, `#jira`, `#flags`, `#sources`,
  `#danger` for admins, `#getting-started`; old `#workspace` = General), beside a sidebar (`renderSidebar()`: the
  workspace, the pages with counts, amber/red when a checklist step waits on the admin or has a problem, and the
  admins' Setup card). GitHub lists installations as cards and tracked repositories as a table; "Track repository"
  opens a picker over every installation's repositories, the pencil opens a row's card (`RepoFlagsCard()` below its
  form): version file, drift, its GitHub environments' map, whether it has flags, and its flags — the sources read
  from its code with each environment's state, or Find flags files / Preview / Read from code for this repo. Admins
  get a Getting started checklist (`onboardingSteps()`); an empty dashboard links to it (`#setupBanner`); the
  header's `#settingsLink` (a gear icon after the status badge) shows only in API mode. Every page and asset is
  served with `DASHBOARD_HEADERS` (`web.js`), including a Content-Security-Policy with `script-src 'self'` (no inline
  scripts; `server/test/content-security-policy.test.js` checks the sources).

## Dashboard data (what `GET /api/tenants/:id/dashboard-data` returns)

`lib/dashboard-data.js` keeps the shapes of the file-based `data/*.json` the frontend was written for (pinned by
`server/test/dashboard-contract.test.js`: both syncs against fake APIs, the real routes, the real `docs/app-*.js`
reading it through `loadData()` in a `vm`; `server-test.yml` also runs on `docs/app-*.js` changes for it):
`deployments`, `flagsMeta`, `flagStates`, `flagStateHistory`, `jiraIndex`, `issueStatusIndex`, `issueDeployments`,
`flagStatesByComponent`, `flagFreshness`, `componentsOrder` (the tracked repos), `lastSyncedAt`, `jiraBrowseUrl`,
`releasePlan` (`readReleasePlan()`: `{ mode: 'jira', lines: [{ key, release, title, type, epicKey, epicTitle,
subtaskKeys, blockedByKeys, dependencyBlocked, featureFlags }], plans: [] }`, every item with a line, from its newest
synced copy whatever its increment; `plans` = release.yaml objects in the contract's shape, none until the repo mode).
The `FALLBACK` sample data has the same shape.

- **Deployment record**: `component`, environment (`test`/`qa`/`prod`; `environmentFor()`: the repo's
  `tracked_repos.env_map` first — migration `022`, names without case, `skip`, set by
  `PUT …/github/repos/:repoId/environments`, which syncs the repo again from the start when it changes — else
  `mapEnvironment()` by substring, `production` → `prod`, `dev` → `test`, `preprod` never `prod`, anything else is
  skipped; the sync keeps the names it saw in `seen_environments` for Settings), status, `deployedAt`,
  `version`, `relatedIssues` (Jira keys from commit messages in the compare range), `workflowRunUrl`, `durationMs`
  (between the first and last status, ignoring GitHub's `inactive`), `manual`, `commitUrl`, `deployedBy` (display
  name, else login), `rollback: { toRef }` (GitHub's compare with the previous deploy on that env says `behind`).
  Each env's latest successful record may carry `driftBehind`: `{ behindEnv, commitCount }` and/or
  `{ untestedIn, untestedCommitCount }` (git history, context only) plus `diff: { files, paths (first 20), ignored }`
  or `diff: { unknown: true }` from the tree comparison, which alone decides whether drift exists. Ignore patterns:
  `dir/` = prefix from the repo root, a pattern with `/` = exact path, a bare name = that file name at any depth,
  `*` = anything but `/`.
- **Flags**: `flagsMeta` key → `{ description, source: 'build'|'runtime-be', jiraKeys[], components[] }`;
  `flagStates` key → env → slot (`build`/`runtime-be`) → `{ enabled, changedAt, changedBy, component }` plus the
  server's `state`/`rollout`; `effectiveFlagState()` prefers `runtime-be`. Per service (ADR-003, read by
  `issueStatusForEnv()`): `flagStatesByComponent` key → env → component → `{ state, rollout, enabled (strictly on),
  changedAt, changedBy, sourceName, kind, overridden[] }` from the sources covering that service (runtime over build,
  then priority, then the later change), and `componentsOrder[].flagCoverage` `tracked`/`none`/`unknown`.
  `flagFreshness` component → env → `{ state, observedAt (the oldest), sources: [{ name, state, observedAt }] }`, the
  worst state of the sources covering it (`freshnessByComponent()`).
- **Jira**: `jiraIndex` = `{ currentPi, pis: [{ pi, file, kind?, includes?, sprints: [{ name, startDate, endDate }] }] }`
  (an "increment" — PI, sprint, release or month — keeps the name `pi` in the data); issues of one increment come from
  `GET /api/tenants/:id/jira-issues`. Issue fields: `key`, `type`, `title`, `pi`, `sprint`, `status`,
  `statusCategory` (`new`/`indeterminate`/`done`), `projectName`, `epicKey`/`epicTitle` (`null` on Epics),
  `impediment` (Jira's Flagged), `subtasks: { done, total }` or `null`, `subtaskKeys` (`[]` without sub-tasks), `blockedByKeys` (every "is blocked by" issue, resolved or not), `priority`, `created`, `resolvedAt`,
  `dependencyBlocked`/`dependencyNote`, `featureFlags`. `issueStatusIndex` maps every key to `{ pi, statusCategory }`.
- **Release status**: an issue links to flags via `jiraKeys` and to deployments via `relatedIssues` (and
  `issueDeployments`, which outlives retention), matched on `issueKeys(issue)` — its key plus `subtaskKeys`, so a
  commit naming only a sub-task counts for the Story (issues synced before the field match on their own key until
  the next sync). An issue with no deployment of its own and no flag also counts as deployed where every issue in its
  `blockedByKeys` is (`deployedViaBlockers()`, one level, each blocker on its key plus its loaded `subtaskKeys`): a
  bug fixed in a Story's sub-task. `issueStatusForEnv()` (ADR-003) works per service the issue's code reached:
  a service with a linked flag is a gate (all on / all off / else partial, a rollout below 100% included; values from
  `flagStateFor()`: `flagStatesByComponent`, or the legacy slots for data without it), one without is neutral, one
  with a linked flag but not the code makes it partial. It gives `none` / `deployed` (every gate off) / `released`
  (every gate on) / `partial` / `deployed_code_only` (no gate), plus `uncertain`: reached services with
  `flagCoverage: 'unknown'` and gate services whose `flagFreshness` is not `fresh`, each
  `{ component, reason: 'untracked'|'stale'|'error'|'unknown', observedAt }`, shown as a "?" on the pill with
  `doubtText()` in the tooltip and the open row; and `mismatch` ("FE on, BE off"): a gate of a service whose
  `componentsOrder[].serviceType` is `FE` on or partial while one typed `BE` is off or `absent`, each
  `{ frontend, backend, backendGate }`, shown as a red outline and `ICONS.warn` on the pill (`StatusPill({ alert })`)
  with `mismatchText()` in the tooltip and the open row. `serviceType` comes from `tracked_repos.service_role`
  (migration `025`, `PUT …/github/repos/:repoId/role`, Settings → GitHub pencil → Role; null = no warning).

## Frontend (`docs/`)

**Files.** Classic `<script>` tags (not ES modules — those do not load over `file://`, which `FALLBACK` needs),
loaded by `docs/index.html` in this order: `app-html`, `app-icons`, `app-core`, `app-components`, `app-data`, `app-model`,
`app-product`, `app-technical`, `app-technical-matrix`, `app-technical-timeline`, `app-technical-flags`,
`app-release-notes`, `app-release-plan`, `app-insights`, `app-main` (last; it calls `init()`). They share one global scope. Function
declarations hoist only within one file, so code that *runs* at load time may use only the same or earlier files —
`const FALLBACK = buildFallbackData()` sits in `app-main.js` for that reason. New code goes in the file for its area;
`app-technical.js` keeps the helpers shared by the three `app-technical-*` files.

**Escaping.** `app-html.js` provides the `html` tagged template (and `escapeHtml`): every interpolated value is
escaped unless it is a nested `html` result, a `raw()` constant (every `ICONS` entry and `barsIcon()`/`envBadgeIcon()`
result in `app-icons.js` already is one, so icons go in without `raw()`) or an array of those. All
`innerHTML` code uses `html`. An array of results assigned to `innerHTML` is comma-joined — wrap it as
`` html`${arr}` ``. An already-built fragment interpolated into `html` must be `raw()` or it shows escaped. A plain
`.title =` DOM property is never HTML-parsed and takes the raw string. Commit messages, Jira fields, display names
and workflow inputs are untrusted.

**Components.** `app-components.js` holds the markup: pure PascalCase functions (`Tag`, `StatusPill`, `SummaryCard`,
`EpicHeader`, `DeployCard`, `FlagRow`, `BarRow`, `EmptyState`, …) taking one props object, reading no `state`/DOM,
returning `html`. Views compute data and call them; older view functions (`jiraStatusTagHtml`, `issueRowHtml`,
`renderDeployCard`, …) are thin wrappers. New markup goes there (`test/app-components.test.js`). Every `href` built from
data goes through `ExternalLink`, which links only `isSafeHttpsUrl()` (absolute `https://`, no user info) and shows
anything else as text. No inline `<script>` or `on…=` attributes anywhere (the pages' Content-Security-Policy blocks
them): behaviour goes on data attributes handled in `initDelegatedHandlers()` (`data-stop-click`,
`data-close-dialog`), the theme is applied by `docs/theme.js` (shared with the settings pages). Every `data-*`
the components write is listed with its reader in `test/app-handlers-contract.test.js`, which also clicks the real
handlers and checks the drift button's attributes against `openDriftModal()`'s parameters.

**Data loading.** Under `/t/<tenantId>/` `loadData()` reads the dashboard-data endpoint, then one increment's
issues (`loadJiraIssuesForPi()`); never more than one increment in memory (`state.jiraIssues`, `state.selectedPi`).
Anywhere else it returns `FALLBACK` (badge "Sample") without any request. Jira links: `jiraIssueUrl(key)`
(`app-core.js`) uses `state.jiraBrowseUrl`; `null` (no Jira connected, or the sample data) shows keys unlinked. Dates use `pl-PL`, except the Insights
rollbacks/drift chart axis (`en-US`).

**Global controls.** One PI `<select>` (`initGlobalPiSelect()`) in the tabs row serves Product view, Delivery summary
and Insights (hidden on Technical view). Options come from `index.json` with the server's `currentPi()` marked; a
change refetches the shard behind a "latest request wins" check, refreshes the Product/Delivery summary filter options
and re-renders. `currentPi()` (the org's active PI) and `state.selectedPi` (what the user browses) are different
things. `#filterSprint` (next to it, shown only on Product view) narrows to "All sprints", the current sprint
(default, "Current sprint (name)", resolved from `index.json` dates for the current PI only; with several active the
newest-started), "Current sprint + unresolved" (`SPRINT_CURRENT_PLUS_UNRESOLVED`: the current sprint plus
older-sprint items of the PI not yet released on prod; offered only when a current sprint exists) or one sprint.
It is a scope control: reapplied on load and PI switch (`refreshSprintSelect()`), not reset by "Clear".
`issuesInSprintScope()` feeds the issue list, the Epic rollup and the summary tiles.
The tiles (`renderProductSummary()`, by `prodStatusBucket()`) count PROD only and say so: "Released to PROD",
"Deployed to PROD (hidden)" (flag off, or no flag), "Partially on PROD", "Not on PROD".

**Product view.** Grouped by Epic (`groupIssuesByEpic()`): an Epic is a header, never a data row; children group by
`epicKey` even when the Epic itself was not synced (header from the child's `epicKey`/`epicTitle`); the rest goes to
"Ungrouped". Groups keep first-encounter order; children sort by `WORK_ITEM_TYPE_ORDER` (Bug, Story, Task; stable),
and the Type filter uses the same order prefixed by Epic. The header shows `epicRollup()` "N/M released to PROD"
(strict `prodStatusBucket() === 'released'`, same as the summary tiles), a "Fully released" tag when all are, an
open-bug icon (`epicHasOpenBug()`), and is scoped by date/sprint, not by Type/Priority. Rows show the Jira key, a
status tag (`jiraStatusTagClass()` by status text: done-ish green, in-flight blue, `Blocked` red; Jira's Flagged
marker folded in as `ICONS.flag`), a sub-task tag, a "Continued in PI-X" badge when `issueStatusIndex` places the
key in another PI (`piContinuationBadge()`), a ghost-flag age (`ghostFlagAge()`: prod `deployed`/`partial` for more
than `GHOST_FLAG_DAYS` = 30 since the later of deploy and last flag change) and per-env pills with plain-language
tooltips (`statusLabelTooltip()`, also in the `.table-legend` row). `#filterHideTasks` hides Tasks; it is an
ordinary filter reset by "Clear" and on PI switch. The `FALLBACK` dataset (`EBO-99001`, `legacyMigrationEnabled`,
deploy `d21` under `EVP-4288`) exercises the ghost-flag and open-bug badges in the `file://` preview, and its BFF
(`flagCoverage: 'unknown'`) and its charger service's stale prod source (`flagFreshness`) the "?" on the issues
whose code reached them; `ocppDeviationBadgeUiEnabled` (on in the back-office frontend on QA) the red "frontend on,
backend off" warning on EBO-16702.

**Technical view.** Summary cards, the component × env matrix (`app-technical-matrix.js`), Deployment history
(`app-technical-timeline.js`) and the flags list (`app-technical-flags.js`). Matrix rows have `min-height: 70px`
and `10px 12px` padding; after each render, every component's rows across the three env cards are snapped to the
tallest (no re-measure on resize). An env card shows only "Diff to ENV" (`driftNotesHtml()`); `openDriftModal()`
shows the file diff, the Git history counts and "What this does not show". The timeline defaults to "Last 90 days"
(`filterDeployRange`, display-only, unrelated to retention); clicking a deployment in the matrix clears it.
The flags panel uses `issueStatusIndex` for `flagBlastRadius()`/`flagStaleWarning()` (`STALE_FLAG_DAYS` = 60).

**Delivery summary** (always on; the code keeps the old name: `app-release-notes.js`,
`releaseNotes*` ids). Real-PI (`isRealPi`) issues released to users on prod (`issueIsReleasedToProd()`:
`released` or `deployed_code_only`), as `releaseNotesModel()` builds them: increments → sprints (newest first,
`compareVersionDesc`), each split into features and bugs, with the latest first-prod date of its items. No page
header; a toolbar with the Service (applications) and Type filters, then two columns: the sprint list (a card per
sprint: day/month of `lastProdAt`, name, "current", "N items · M bug fixes"; `data-sprint-key`) and the selected
sprint's panel (`selectedNotesSprint`, the newest when unset or filtered out): PROD badge, "Current sprint · last on
prod", four figures (items on prod / released to users = `released` / code deployed, no flag = `deployed_code_only` /
bugs fixed), "Features & improvements" and "Bug fixes". Each item: title (the link), type and key tags, PROD pill
and first prod date (`earliestProdDeployedAt()`, omitted when unknown). "Copy as Markdown" (`data-copy-notes`) puts
`releaseNotesMarkdown()` on the clipboard. A PI switch calls `resetReleaseNotesFilters()`. Unreleased issues are not
shown; empty with fallback stubs.

**Release plan** (G1.3; `app-release-plan.js`, `renderReleasePlan()` into `#releasePlanBody`; the PI and sprint
selectors are hidden there, lines span increments). `releasePlanModel()` (`app-model.js`): repo plans group by change
(lines from `releases`, flags from `flags`), Jira lines of items no plan lists group by Epic; each line R1…Rn lists
its items with `issueStatusForEnv()` on PROD (`StatusPill`), `onProdCount` and `released` (every item
`issueIsReleasedToProd()`, "R1 released"), the group's `mvpReleased`. `flagPlanStatus(planFlag, key)`: the PROD
exposure (`flagProdExposure()`: widest across services, on = 100, off = 0), the last planned stage reached (a `N%`
stage once the rollout is ≥ N, a named stage once on for anyone), `daysInStage` from the value's `changedAt` against
`min_days` (`waiting`/`ready`/`final`/`not_started`), `overdue`/`daysPastRemoveBy` after `remove_by`; without a plan
(Jira mode) `no_plan`. Markup: `ReleasePlanGroup`, `ReleaseLineCard`, `ReleasePlanItem`, `ReleasePlanFlag`
(`test/app-release-plan.test.js`). The `FALLBACK` shows the retry-queue Epic's lines and a `CHG-12` plan with a flag
past its remove-by.

**Insights** (behind `?insights=1`, `INSIGHTS_ENABLED`). Hand-rolled charts over existing data: release status per
sprint on prod (`sprintReleaseStatusBreakdown()`, labels from `sprintLabelFor()`) and lead time Done → prod
(`leadTimeToProdBySprint()`, median days, negative clamped to 0) side by side; release status per priority
(`priorityReleaseStatusBreakdown()`, `PRIORITY_ORDER` = Blocker/Critical/Major/Medium/Minor, issues without one
excluded); stale flags by days on in prod (`staleFlagDaysBreakdown()`); rollbacks and drift per month for the last
12 months (`rollbackDriftByMonth()`). The last two are cross-time, not PI-scoped, so untagged hotfixes still show.
