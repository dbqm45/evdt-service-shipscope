# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository. It states the rules the code relies on; the
history of how they came about is in git and `CHANGELOG.md`. Related documents:

- `docs/GLOSSARY.md` — terms that have more than one name (component / tracked repo, PI / increment, source / slot).
- `design-docs/REPORT_ARCH.md` — architecture and DDD analysis (2026-10-17, written while the file-based sync was
  still here); `ADR-001` (flags are pushed from outside), `ADR-002` (the three memory policies);
  `FEATURES(.pl).md` — undecided ideas; `TODO.md` — technical debt.
- `FAQ.md` — how each number and badge on the dashboard is computed; `ONBOARDING.md` — setting up a workspace;
  `server/README.md` — routes, security model, local setup; `RELEASING.md` — versions.

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
  `shipscope-flags.js` over `lib.js`, Node 20+, no dependencies): reads flags from files (JSON, `.properties`, `.env`,
  TypeScript/JavaScript read without running them by `script-objects.js`; `{env}` in a pattern + `env-map` for one
  file per environment) or a URL and posts their state to `POST /api/flags/ingest`. Tested in
  `test/flags-adapter*.test.js` and end to end in `server/test/flags.test.js`.
- `scripts/` holds only tooling: the release scripts (`release.js`, `release-notes.js`, `check-commit-message.js`,
  `lib/conventional.js`, `lib/json-file.js`) and the module-boundary check.
- `server/` is a separate dependency boundary: its own `package.json`, `node_modules/` (gitignored) and `test/`.
  Root `npm test` never runs `server/test/`. Run `npm install && npm test` inside `server/` (real-Postgres tests need
  `TEST_DATABASE_URL`, see `server/README.md`).
- **Module boundaries** (`scripts/lib/module-boundaries.js`, `node scripts/check-module-boundaries.js`, tested in
  `test/module-boundaries.test.js`): `scripts/` never requires from `server/` and vice versa; `adapters/` requires
  from neither; `docs/app-*.js` never calls `require()`.
- Workflows: `test.yml` and `server-test.yml` on every PR and push to `main`, `pr-title.yml`, `release.yml`.

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
`.github/workflows/pr-title.yml` and the optional `.githooks/commit-msg`. After each merge to `main`,
`release.yml` runs `scripts/release.js --ci`, commits `chore(release): X.Y.Z` with the versions and a
`CHANGELOG.md`/`CHANGELOG.pl.md` entry, tests that commit, tags `vX.Y.Z` and creates a GitHub Release
(`scripts/release-notes.js`, rules in `scripts/lib/conventional.js`). Never edit the version or a `## [X.Y.Z]`
changelog entry by hand outside a `chore(release)` PR.

## Backend (`server/`)

Deployed to Render per `context/foundation/infrastructure.md`: `render.yaml` builds both the Web Service and the
Background Worker from the repo root (`npm ci --prefix server`, `node server/web.js`), not `rootDir: server`, which
would hide `docs/` from the Web Service. Migrations (`server/migrations/001`–`016`, applied by the hand-rolled
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
  The body schema is `server/schemas/flags-ingest.v2.schema.json`, used by the route and served at
  `GET /api/flags/ingest/schema`; the sender's guide (format, where flags live, the adapter, `jq` recipes) is
  `ONBOARDING.md`. Each source keeps its status (migration `016`): the last accepted message's summary
  (`last_ingest_at`/`last_ingest`) and the last refused one's reason (`last_error`/`last_error_at`, recorded by
  `recordIngestError()` after the rollback, schema refusals included via `attachValidation`), shown in Settings and
  the Getting started checklist.
  Sources of one kind fold into the dashboard's `build`/`runtime-be` slot by priority. Flags link to Jira issues
  from three origins merged in `readDashboardFlags()`: the sender's `jira_keys`, hand-set
  `manual_jira_keys`/`manual_description` (`PUT /tenants/:tenantId/flags/:key`, never overwritten by a sender), and
  Jira's own, read at sync time by the tenant's `jira_connections.flag_link` convention (a custom field or a label
  prefix, `extractFlagKeys()`). The file-based `schemaVersion: 1` contract was not ported.
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
  header's `#settingsLink` (a gear icon after the status badge) shows only in API mode.

## Dashboard data (what `GET /api/tenants/:id/dashboard-data` returns)

`lib/dashboard-data.js` keeps the shapes of the file-based `data/*.json` the frontend was written for:
`deployments`, `flagsMeta`, `flagStates`, `flagStateHistory`, `jiraIndex`, `issueStatusIndex`, `issueDeployments`,
`componentsOrder` (the tracked repos), `lastSyncedAt`, `jiraBrowseUrl`. The `FALLBACK` sample data has the same shape.

- **Deployment record**: `component`, environment (`test`/`qa`/`prod`; `mapEnvironment()` maps by substring,
  `production` → `prod`, `dev` → `test`, `preprod` never `prod`, anything else is skipped), status, `deployedAt`,
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
  server's `state`/`rollout`; `effectiveFlagState()` prefers `runtime-be`.
- **Jira**: `jiraIndex` = `{ currentPi, pis: [{ pi, file, kind?, includes?, sprints: [{ name, startDate, endDate }] }] }`
  (an "increment" — PI, sprint, release or month — keeps the name `pi` in the data); issues of one increment come from
  `GET /api/tenants/:id/jira-issues`. Issue fields: `key`, `type`, `title`, `pi`, `sprint`, `status`,
  `statusCategory` (`new`/`indeterminate`/`done`), `projectName`, `epicKey`/`epicTitle` (`null` on Epics),
  `impediment` (Jira's Flagged), `subtasks: { done, total }` or `null`, `priority`, `created`, `resolvedAt`,
  `dependencyBlocked`/`dependencyNote`, `featureFlags`. `issueStatusIndex` maps every key to `{ pi, statusCategory }`.
- **Release status**: an issue links to flags via `jiraKeys` and to deployments via `relatedIssues` (and
  `issueDeployments`, which outlives retention); `issueStatusForEnv()` gives `none` / `deployed` (code shipped, flag
  off) / `released` (flag on) / `partial` / `deployed_code_only` (no flag to check).

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

**Data loading.** Under `/t/<tenantId>/` `loadData()` reads the dashboard-data endpoint, then one increment's
issues (`loadJiraIssuesForPi()`); never more than one increment in memory (`state.jiraIssues`, `state.selectedPi`).
Anywhere else it returns `FALLBACK` (badge "Sample") without any request. Jira links: `jiraIssueUrl(key)`
(`app-core.js`) uses `state.jiraBrowseUrl`; `null` (no Jira connected, or the sample data) shows keys unlinked. Dates use `pl-PL`, except the Insights
rollbacks/drift chart axis (`en-US`).

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
marker folded in as `ICONS.flag`), a sub-task tag, a "Continued in PI-X" badge when `issueStatusIndex` places the
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
(`filterDeployRange`, display-only, unrelated to retention); clicking a deployment in the matrix clears it.
The flags panel uses `issueStatusIndex` for `flagBlastRadius()`/`flagStaleWarning()` (`STALE_FLAG_DAYS` = 60).

**Release Notes** (always on). Real-PI (`isRealPi`) issues released to users on prod (`issueIsReleasedToProd()`:
`released` or `deployed_code_only`), grouped by PI → sprint (newest first, `compareVersionDesc`), split into
"Features & Improvements" and "Bug Fixes"; a Service filter over the applications narrows the list.
Unreleased issues are not shown. Each item: title + PROD pill on the first line, then the key (a plain
`<span class="tag mono">`; the title is already the link) and the first prod date (`earliestProdDeployedAt()`,
omitted when unknown). Empty with fallback stubs.

**Insights** (behind `?insights=1`, `INSIGHTS_ENABLED`). Hand-rolled charts over existing data: release status per
sprint on prod (`sprintReleaseStatusBreakdown()`, labels from `sprintLabelFor()`) and lead time Done → prod
(`leadTimeToProdBySprint()`, median days, negative clamped to 0) side by side; release status per priority
(`priorityReleaseStatusBreakdown()`, `PRIORITY_ORDER` = Blocker/Critical/Major/Medium/Minor, issues without one
excluded); stale flags by days on in prod (`staleFlagDaysBreakdown()`); rollbacks and drift per month for the last
12 months (`rollbackDriftByMonth()`). The last two are cross-time, not PI-scoped, so untagged hotfixes still show.
