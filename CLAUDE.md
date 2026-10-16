# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

ShipScope is a cross-repo deployment/feature-flag/Jira status dashboard for the EVDT org. It has no
application server or build step: plain Node scripts (no dependencies — only Node built-ins and global
`fetch`; `package.json` exists only to expose `npm test`) are invoked by GitHub Actions workflows to sync
data into JSON files under `docs/data/`, and a static vanilla-JS page (`docs/index.html` + `docs/app-*.js`)
renders that JSON. There is no linter or bundler in this repo. Tests are `node:test` files in `test/`
(`npm test`, run in CI by `.github/workflows/test.yml` on every PR and push to `main`; i.e. `node --test "test/*.test.js"`; ~360 cases, ~99.8% line / ~97% branch coverage — measure with
`node --test --experimental-test-coverage "test/*.test.js"`) covering every `scripts/*.js` and `scripts/lib/*.js` file
and every `docs/app-*.js` file. Each test file runs in its own process because `jira-config.js` reads env at
require time, and the ones touching disk use a `test/.tmp-*` path (gitignored, removed in `after()`). Top-level
scripts run `main()` on require, so their tests spawn them as child processes (temp data dirs via env paths, a
`--require` preload replacing global `fetch` with a fixture router, or a local `http.createServer`; helpers in
`test/sync-harness.js` and `test/flag-scripts-helpers.js`, which are not `*.test.js` and so not run on their own).
Frontend tests load `docs/app-*.js` into a `vm` context with a stub DOM, fixed clock and mocked `fetch`; the stub DOM
does not parse HTML, so they assert on generated HTML strings, and real layout (row-height equalization, scroll sync)
is not verified. Pure deployment logic (retention, plan, cursor, drift) lives in `scripts/lib/deployment-records.js`.

**`docs/app.js` no longer exists as one file.** It is split into `docs/app-{core,data,model,product,technical,
release-notes,insights,main}.js`, loaded by `docs/index.html` as classic `<script>` tags in that order (not ES
modules — those don't load over `file://`, which the built-in `FALLBACK` preview depends on). They share one
global scope, so top-level `const`/`let`/functions are visible across files; concatenated in that order they
are byte-identical to the former `app.js`. Everywhere below, `docs/app.js` means "whichever `docs/app-*.js`
defines it" — functions keep their names, `grep` finds them. New code goes in the file matching its area
(`app-main.js` must stay last: it calls `init()`). Pitfall: function declarations are only hoisted within one
script, so a top-level statement that *runs* at load time may only use things from the same or an earlier file
— `const FALLBACK = buildFallbackData()` lives in `app-main.js` for exactly that reason (it calls helpers from
`app-model.js`); byte-identical concatenation did not guarantee this, a real load-order bug caught on `file://`.

`docs/app-html.js` (loaded first, before `app-core.js`; `escapeHtml` moved here) adds the `html` tagged template,
which escapes every interpolated value unless it is a nested `html` result, a `raw()` constant (e.g. an `ICONS`
entry) or an array of those — so a forgotten `escapeHtml()` cannot happen by construction. It is DOM-free and
unit-tested in `test/app-html.test.js` (and `test/frontend-render.test.js` smoke-renders migrated views in Node against a stub DOM). All views (`app-insights.js`, `app-release-notes.js`, `app-technical.js`, `app-product.js`) are migrated; new `innerHTML` code should use `html` too.
`docs/app-components.js` (loaded right after `app-core.js`, before every view) holds the presentational markup as atomic
components: pure PascalCase functions (`Tag`, `StatusPill`, `SummaryCard`, `EpicHeader`, `DeployCard`, `FlagRow`,
`BarRow`, `EmptyState`, ...) that take one props object, read no `state`/DOM, and return an `html` result; children and
slots are other components' results. Views compute the data (URLs, labels, counts) and call them; existing view
function names (`jiraStatusTagHtml`, `issueRowHtml`, `renderDeployCard`, ...) stay as thin wrappers. New markup goes in
there, not inline in a view. Unit-tested in `test/app-components.test.js`; the view tests' `FILES` lists must include
`app-components`.
An array of `html` results assigned straight to `innerHTML` is comma-joined — wrap it as `html\`${arr}\``.
When migrating, any already-built HTML fragment or `ICONS` value interpolated into `html` must be wrapped in
`raw()` (or built with `html`) or it will show up escaped.

## Running scripts locally

Every script in `scripts/` reads config from environment variables (no CLI args) and is run directly:

```bash
node scripts/check-flags-metadata.js
```

Set the env vars a script needs before running it (see "Scripts" below for each one's inputs). Paths are
validated with a `safeRelativePath` guard in most scripts — absolute paths or `..` segments are rejected,
so always pass repo-relative paths.

To preview the dashboard, just open `docs/index.html` in a browser, or serve `docs/` with any static file
server. If `docs/data/*.json` can't be fetched (e.g. opened via `file://`), `docs/app.js` falls back to an
embedded `FALLBACK` sample dataset and tags the UI with "built-in fallback data".

## Type discipline (no TypeScript in this repo)

This codebase is intentionally plain JavaScript with no build step. Compensate for the lack of static types
with explicit discipline, especially in any new backend/API code written for the SaaS-pivot work (see
`context/foundation/prd.md`):

- Every exported function gets a one-line JSDoc `@param`/`@returns` block stating the shape of its
  arguments and return value — not prose, the shape (e.g. `@param {{ tenantId: string, repoFullName: string }} input`).
- Any boundary that receives external input (HTTP request bodies, OAuth callback payloads, GitHub/Jira
  webhook or API responses) validates that input against an explicit schema before using it — do not trust
  shape from a third-party API response without checking the fields you read exist and are the expected type.
- Prefer `node:assert`'s type-checking helpers or a small runtime schema check over trusting an untyped
  object straight through to a database write.

## Test runner — node:test, not Jest

Tests use Node's built-in `node:test` + `node:assert`, not Jest/Mocha/Vitest. Do not use `jest.fn()`,
`jest.mock()`, or `expect(...).toHaveBeenCalledWith(...)` — none of that API exists here. Use `t.mock.fn()` /
`t.mock.method()` from the `node:test` context, and plain `assert.strictEqual` / `assert.deepStrictEqual` /
`assert.rejects` from `node:assert`. See any existing `test/*.test.js` file for the pattern before writing a
new one.

## Backend (`server/`)

`server/` is the SaaS-pivot backend scoped by `context/foundation/prd.md`, deployed to Render per
`context/foundation/infrastructure.md` (`render.yaml` at the repo root, `rootDir: server` for both the Web
Service and the Background Worker). It is a separate dependency boundary from the repo root: its own
`package.json`, its own `node_modules/` (gitignored), its own `test/` directory — nothing at the root changes
because of it, and root `npm test` still only ever runs the top-level `test/*.test.js` scripts.

It has the deploy-pipeline proof (`GET /health`, `GET /health/db`, a heartbeat Background Worker), the
tenant data model (FR-002/FR-003, `lib/tenants.js`, migrations in `server/migrations/`, applied by the
hand-rolled `lib/migrate.js`) and GitHub sign-in (FR-001): Fastify routes in `web.js`, the GitHub App's
user-authorization flow in `lib/github-oauth.js`, server-side sessions in `lib/sessions.js` (only a SHA-256 of
the cookie token is stored; the GitHub user token is never stored), and invitation links plus member removal
(FR-003, `lib/invitations.js`; one-time hashed tokens, single-use claim by conditional `UPDATE`, last-admin guard).
GitHub App connection (FR-004/FR-006, `lib/github-app.js` for App JWT/installation-token calls, `lib/github-connections.js`
for the data): an installation is linked only after the user's own token shows they can access it (`GET
/user/installations` in the sign-in callback) -- never on the `installation_id` from GitHub's setup redirect alone. Dependencies, all scoped to
`server/package.json` (the rest of the repo remains dependency-free): `pg`, `fastify`, `@fastify/cookie`.
Fastify was chosen for its built-in JSON-schema validation of request input; it runs with
`removeAdditional: false, coerceTypes: false`, so unknown fields and wrong types are a 400, never silently
fixed. **Every query on an RLS table (`memberships`, `invitations`, `github_installations`, `tracked_repos`) must go through `lib/scope.js`'s `withScope()`**, which
sets `app.current_tenant_id`/`app.current_user_id` with transaction-local `set_config(..., true)`; an unscoped
read returns zero rows and an unscoped write is an RLS error (migration `002`). Run `npm install && npm test`
inside `server/`; see `@server/README.md` for routes, the security model, local sign-in with a dev GitHub App,
and the real-Postgres test setup.

## Versioning (`RELEASING.md`)

One SemVer number for the whole application, in `package.json`, `server/package.json` and
`server/package-lock.json` (kept equal; `test/release.test.js` checks it), shown by the server in `GET /health`.
Commits and PR titles follow Conventional Commits (`feat(SHP): ...`; PRs are squash-merged, so the title counts),
checked by `.github/workflows/pr-title.yml` and the optional `.githooks/commit-msg` (`npm run hooks:install`).
After every merge to `main`, `.github/workflows/release.yml` runs `scripts/release.js --ci`, commits
`chore(release): X.Y.Z` with the bumped versions and an entry on top of `CHANGELOG.md`/`CHANGELOG.pl.md`, runs the
tests on that commit, then tags `vX.Y.Z` and creates a GitHub Release from `scripts/release-notes.js`. Same
mechanism as `dbqm45/ci_for_sdlc` (no Docker image here); `scripts/lib/conventional.js` holds the rules. Never
edit the version or the `## [X.Y.Z]` changelog entries by hand outside a `chore(release)` PR.

## Branch model: `main` vs `live`

This is the most important structural thing to understand:

- **`main`** holds source: `scripts/`, `.github/workflows/`, docs about the tooling.
- **`live`** is the "deployed" branch: it holds `docs/data/*.json`, which bots mutate continuously
  (deployment syncs, Jira syncs, flag-state updates). GitHub Pages likely serves off `live`.
- `.github/workflows/sync-main-to-live.yml` merges `main` → `live` automatically whenever
  `scripts/**`, `docs/**`, `.github/workflows/**`, or `.github/actions/**` change on `main` — the `docs/**`
  path matters as much as the others: it's what gets `docs/app.js`/`index.html`/`style.css` themselves
  (not just `docs/data/*.json`) onto `live`, which is what GitHub Pages actually serves. `docs/data/**`
  itself is excluded from this trigger (`!docs/data/**`) — found and fixed as a real gap: that path only
  ever holds stale/example data on `main` (see above), so a change there has nothing to usefully merge into
  `live`'s real data and previously risked a merge conflict blocking the rest of the same push (real code
  included) from ever reaching `live`.
- Every data-mutating workflow checks out **two** refs: `main` at the workspace root (`scripts/`,
  `.github/actions/**` — i.e. anything that gets *executed*), and `live` into a `path: data` subdirectory
  (anything that only gets *read or written as data*, `docs/data/*.json`/`docs/jira-spaces.json`/
  `docs/components.json`). The composite action calls then run with `working-directory: data` and the
  `run:` input points at the script via `../scripts/...js`, so `uses: ./.github/actions/sync-with-retry`
  itself still resolves from the trusted `main` checkout while the script's own relative reads/writes
  (`docs/data/...`) land in the `live` one. This split exists specifically so `live` — continuously
  mutated by bots, and the branch every app repo's shared `SHIPSCOPE_APP` credential can ultimately reach
  — is never a source of *executable* code: before this, several workflows ran `node scripts/*.js` (and
  resolved the composite action itself) straight off `live`, so anyone able to push a modified script
  there (e.g. via a leaked `SHIPSCOPE_APP_PRIVATE_KEY`/`CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY`, not
  through any of this repo's own commit paths, which only ever `git add` specific data files) would get
  that code executed with whatever secrets the run already held. `check-flags.yml` (a reusable workflow
  called from app repos) follows the same split but names the paths `shipscope` (main) / `shipscope-data`
  (live), since `shipscope` was already taken by the pre-split single checkout. The three workflows that
  never execute a ShipScope script at all are the exception and still use a single checkout:
  `sync-main-to-live.yml` (pure `git merge`, no script), `retrigger-app-checks.yml` (only calls the GitHub
  API; its `retrigger` job checks out `main`, and since it's triggered by a `flags-meta-changed`
  `repository_dispatch` rather than a `push` against `live`, GitHub resolves the workflow definition itself
  from `main` too — see that fix's rationale in the Scripts table below), and
  the `prepare` job in `orchestrate-full-sync.yml`/`backfill-deployment-metadata.yml` (reads
  `docs/components.json` with `jq`, data not code — single `ref: live` checkout is fine there).
- Data-mutating workflows do **not** serialize against each other via a shared `concurrency:` group (they
  used to — that caused a real bug: GitHub only keeps one *pending* run per concurrency group, so a
  deploy-triggered sync could get silently cancelled if it queued up behind a slow manual run and a third
  event arrived before it started). Instead, every "commit and push" step is a retry loop via the shared
  `.github/actions/sync-with-retry` composite action (or a bespoke equivalent for the two callers whose
  shape doesn't fit it — `check-flags.yml`, `sync-main-to-live.yml`): on a rejected push, it re-runs the
  sync command (or re-merges, for `sync-main-to-live.yml`) against a freshly-fetched `live` and tries again.
  This is safe specifically because every script here already does a full read-existing-JSON → merge →
  write-back cycle (see below) rather than an append — redoing that against current data naturally
  incorporates whatever another run already pushed, instead of replaying a stale diff. That guarantee only
  covers the local-merge part, though — redoing an *external, rate-limited* fetch on every retry is not
  cheap, and doing so for `sync-github-deployments.js` on a large first-sync backlog once exhausted a
  GitHub App's rate limit mid-run. `scripts/lib/retry-cache.js` (`loadOrCompute`) caches that expensive
  fetch-and-resolve part per job (via `RUNNER_TEMP`, cleaned up automatically), so only the cheap
  merge-with-fresh-`live` step actually redoes on each retry. `sync-github-deployments.js`'s own
  `githubApiAllPages()` has a second, finer-grained disk cache on top of that (persists pages as they're
  fetched, so a rate limit on a *later* page doesn't force re-fetching pages already fetched successfully
  earlier in the same job) — resuming from it picks up at a page number computed from how many records are
  already cached, which assumes the underlying list hasn't shifted in the meantime; if a new item landed on
  an earlier page between the original fetch and the resumed one, the same item could appear on two
  different fetched pages. Deduped by `id` (or `name` for `/tags`, which has no `id` field) when
  concatenating a newly-fetched page — found and fixed as a real bug. `sync-github-deployments.js` and
  `sync-jira.js` (keyed by a hash of its resolved JQL, so a genuinely different query still fetches fresh)
  both use it. `backfill-deployment-metadata.js` doesn't — mutates existing records in place across capped
  phases, doesn't fit the same cache shape, and is `workflow_dispatch`-only so the same race is rarer — its
  `sync-with-retry` call site is instead just capped at `max-attempts: 2` to bound wasted work.

  Separately from that per-job page cache, `sync-github-deployments.js` also supports conditional
  (ETag-based) requests for the three list endpoints it fetches on *every* run regardless of whether
  anything actually changed since the last one (`/deployments` page 1, `/tags`, `/releases`) —
  `scripts/lib/github-api.js`'s `githubApiRequest`/`githubApiGet` take an optional caller-owned
  `etagCache` object (keyed by URL -> `{ etag, body }`), send a cached ETag as `If-None-Match`, and return
  the cached body on a `304` instead of re-fetching. This matters specifically because a `304` doesn't
  count against GitHub's API rate limit the way a real `200` does — a steady-state cron run across every
  tracked component (the common case: most components have nothing new between runs) spends far less of
  the shared budget. The cache only pays off if it survives *across* separate runs, not just within one
  job's own retries — `ETAG_CACHE_PATH` defaults under `RUNNER_TEMP` (safe no-op degrade: works like
  before, cache-within-job-only, if nothing persists it further), and
  `orchestrate-full-sync.yml`'s `sync_deployments` job wires an `actions/cache` step (keyed by component,
  outside both git checkouts so it's never at risk of being swept into a commit) around
  `GITHUB_API_ETAG_CACHE_DIR` to actually extend that across runs. Not applied to any of the per-deployment
  calls (`/commits/{sha}`, `/compare/...`, `/deployments/{id}/statuses`, `/actions/runs/{id}`) — those hit
  a URL that's effectively immutable once it exists and, thanks to the cursor, is normally only ever
  fetched once in this script's lifetime, so there's nothing to revalidate against.

When changing a script that writes to `docs/data/`, remember the change ships to `main` first and only
reaches the running data on `live` after the sync workflow merges it — the data files on `main` itself are
stale/example data, not the live state.

## Domain model

- **Flags** (`docs/data/flags-meta.json`): key → `{ description, source: 'build'|'runtime-be', jiraKeys[], components[], createdAt }`.
  - `build` flags are baked into FE bundles at build time via generated TS files (see below).
  - `runtime-be` flags are toggled live by a backend service and fetched from HTTP endpoints.
  - `components[]` is auto-maintained as a true union by every scaffold path (`scaffold-flags-meta.js`,
    `resolve-all-flag-states.js`, `sync-runtime-be-flags.js` all add their own `COMPONENT` if it's missing,
    never remove one) — it used to only be set once at first scaffold, so a flag genuinely discovered by a
    second component later never got listed, understating real sharing. `fill-flag-metadata.js` remains the
    one place a human can set it explicitly/out of band (e.g. pre-registering a sharing relationship before
    either side has actually synced yet).
  - `createdAt` is stamped once, the first time a flag is scaffolded/filled in (`scaffold-flags-meta.js`,
    `sync-runtime-be-flags.js`, `fill-flag-metadata.js` all preserve it if it already exists) — flags that
    predate this field simply don't have it. It answers "when did this flag first show up," which is a
    different moment than any `flag-states.json` `changedAt` (those track state flips, not the flag's origin).
- **Flag states** (`docs/data/flag-states.json`): key → env (`test`/`qa`/`prod`) → source (`build`/`runtime-be`)
  → `{ enabled, changedAt, changedBy, component }`. Both a `build` and a `runtime-be` entry can coexist
  per flag/env — e.g. a FE's build flag and a BE's runtime flag deliberately sharing one key, see
  `components` above — and `effectiveFlagState()` in `docs/app.js` prefers `runtime-be` over `build` when
  both exist. This file only ever holds the *latest* value per flag/env/source — it's a snapshot, not a
  log. `component` records which component's sync run last wrote *this* source's value — not the same
  dimension as the cross-source build/runtime-be sharing just described, but the orthogonal, same-source
  case: two *different* components both resolving a `build` (or both a `runtime-be`) value for a flag with
  the same literal name is almost always two unrelated features that happen to collide, not deliberate
  sharing, since a `build` flag is inherently baked into exactly one bundle. `resolve-all-flag-states.js`/
  `sync-runtime-be-flags.js` both check this field before writing: if some *other* component already owns
  this key's state for that source, the write is skipped and logged as `::error::` (not thrown — the
  caller's commit/push loop still needs to commit every other, non-colliding flag from the same run) rather
  than silently clobbering the existing value — found and fixed as a real bug: before this field existed,
  there was no way to tell the two cases apart at all, so a same-named, same-source collision between two
  unrelated components silently overwrote whichever one synced second, forever. A pre-existing entry with
  no `component` tag (anything written before this fix shipped) is treated as unowned and silently
  claimed by whichever component writes it next — there's no way to retroactively know who really owned
  already-ambiguous historical data, so this only prevents the collision from *recurring*, same spirit as
  `backfill-flag-state-history.js`'s unrecoverable `changedBy` for pre-history flips.
- **Flag state history** (`docs/data/flag-state-history.json`): a flat, append-only array of every entry
  `resolve-all-flag-states.js`, `sync-runtime-be-flags.js`, and `update-flag-state.js` have ever written to
  `flag-states.json` — `{ key, env, source, enabled, changedAt, changedBy }` per flip, oldest first. Written via
  the shared `scripts/lib/flag-history.js` helper (`appendFlagHistoryEntries`), at the exact same point each
  script already decides a value actually changed — so it inherits the same idempotency (no flip = no entry).
  Entries from before this log existed can be mined from `live`'s own git history with
  `scripts/backfill-flag-state-history.js` (`backfill-flag-state-history.yml`, manually triggered, no
  GitHub App token needed since it never leaves this repo) — it walks every commit that ever touched
  `flag-states.json` (`git log --follow`), diffs consecutive versions to find what changed, and appends
  those as history entries with `changedBy: "unknown (backfilled from git history)"`. That placeholder is
  deliberate, not a bug: the real actor behind old `flag-states.json` changes was never persisted anywhere
  (commits to that file are always made by a bot, not the person who triggered the run — see the
  `check-flags.yml` `CHANGED_BY: ${{ github.actor }}` fix, which only helps *future* changes), so there's no
  way to recover who made a historical flip. The script is idempotent (re-running produces no duplicate
  entries) and safe to run alongside the live append-only logging — it only adds entries, never removes.
  Its dedup key truncates `changedAt` to the calendar day rather than comparing it exactly — found and
  fixed as a real bug: the same real flip gets a different exact timestamp depending on whether live
  logging recorded it (wall-clock `now()` at write time) or this script mined it later (the git commit's
  *author* date), so an exact-timestamp dedup let a backfill re-run over a period live logging already
  covers quietly double-log every flip in it.
- **Deployments** (`docs/data/deployments.json`): array of deployment records, keyed by `component`, with
  `relatedIssues` (Jira keys parsed out of commit messages) and optional `resolvedFlags`. Records also carry
  `workflowRunUrl`/`durationMs` (from the deployment's GitHub Actions status history), `manual` (whether the
  triggering workflow run was `workflow_dispatch`), `commitUrl` (a `.../compare/{prev}...{sha}` range
  once a previous successful deploy on that env exists, else a single-commit link), and `rollback: { toRef }`
  when the GitHub compare between this deploy's commit and the previous one on that same env came back
  `status: "behind"` — i.e. this commit is an *ancestor* of what was already live, so the environment moved
  backwards in history. Detected from the exact same compare call already made for `relatedIssues`/`commitUrl`,
  so it costs nothing extra. All of these are populated only for deployments synced after the fields were
  added; older records need `backfill-deployment-metadata.js`, which *does* also backfill `rollback` (one real
  compare call per record that doesn't have the key yet — it always sets `rollback`, even to `null`, so a
  record is never re-checked once processed).

  **ShipScope shows the current, real state of what's deployed, not a historical archive** — GitHub's own
  deployment/Actions history already owns that. So `sync-github-deployments.js` physically removes any
  record older than `RETENTION_DAYS` (default 90) from `deployments.json` on every run
  (`trimOldRecords()`), *except* the single latest record overall per component/env (so the Deployment
  History timeline, which shows every attempt including failures, never has its single most recent entry
  pruned away) and the single latest *successful* one (whatever `currentVersion()` in `docs/app.js` and
  drift/rollback detection both need — these can be a different, older record when the most recent attempt
  failed) — both of those are kept no matter how old, so trimming can never break either. Corrected a
  doc/code drift here: `currentVersion()` only ever reads successful deployments (same filter as
  `componentDeployments()`) — it does *not* read the "latest overall" record when the most recent attempt
  failed, despite this file previously claiming otherwise; a failed attempt is deliberately invisible to
  the component × env matrix's "current version" cell (there's nothing to show as "running" for a deploy
  that never shipped) and only surfaces in the unfiltered timeline instead. Trimming this
  way means a deployment the script already decided to skip re-processing (via the id-based cursor just
  below) can legitimately not exist in the file at all; it isn't a bug, it's the point.

  Because the file is trimmed, "have I already processed this GitHub deployment" can no longer be answered
  by checking whether its ID is present in `deployments.json` — a long-trimmed-away deployment would
  otherwise look "new" again on every future run and re-pay its full per-deployment API cost (statuses,
  compare, display-name resolution) forever. `docs/data/deployments-cursor.json` (`{ [component]:
  highestDeploymentIdEverSynced }`) is a tiny, **never-trimmed** companion file that answers this instead —
  GitHub deployment IDs are monotonically increasing per repo, so "already synced" just means `id <=
  cursor[component]`, independent of whether that deployment's own record still physically exists.
  `orchestrate-full-sync.yml`'s sync step commits both paths together so they can never drift apart across
  a losing-push retry.

  **`docs/data/summary.json`** — a different kind of companion file, not about retention but about render
  speed: `{ components: { [component]: { [env]: { current, latestOverall } } } }`, where both are either a
  full deployment record (same shape as a `deployments.json` entry) or `null`. `docs/app.js`'s
  `currentVersion()`/`componentDeployments()` repeat an O(n) filter+sort over the *entire* `state.deployments`
  array once per component and once per component×environment on every single first render (the Technical
  view's summary cards and component×env matrix) — for a tracked fleet with many components and up to
  `RETENTION_DAYS` of history each, that's real, repeated work standing between the page loading and the
  matrix actually painting. `current`/`latestOverall` here are exactly the two records `trimOldRecords()`
  already computes (and always keeps, regardless of age — see above) for that same purpose, so writing them
  out separately costs nothing extra: no new API calls, no new computation, just reusing those two maps.
  `currentVersion()` reads this file as a fast path (an O(1) lookup) and only falls back to the full scan
  when a component/env is missing from it (e.g. before a newly-onboarded component's first sync, or when
  `summary.json` itself is unreachable) — so it's a precomputed cache, not a new source of truth, and
  `docs/app.js` degrades to exactly today's behavior whenever it's absent. It's rewritten in full on every
  run from the same already-complete, all-components `latestOverall`/`latestSuccess` maps `trimOldRecords()`
  builds (same idempotent-full-rewrite shape as `deployments.json` itself — a run where nothing actually
  changed produces byte-identical output, so `sync-with-retry`'s `git diff --staged --quiet` finds nothing
  to commit). One real limitation, by construction: `backfill-deployment-metadata.js` mutates existing
  `deployments.json` records in place without going through `trimOldRecords()`, so a backfilled change to
  what happens to be a component's current record won't be reflected here until that component's next
  regular sync — acceptable since nothing depends on this file for correctness, only for how fast the first
  render is.

  The cursor must never advance past a deployment that doesn't have a terminal status yet (`success`/
  `failure`/`error`) — a deployment can be fetched by `/deployments` before GitHub has posted any status
  for it at all (`buildDeploymentPlan()`'s `blockedIds`), and the ID-based `dep.id > lastSyncedId` filter
  has no other way to tell "still pending" apart from "already fully processed." Advancing the cursor past
  one anyway (a real bug, found and fixed: `maxDeploymentId` used to be the max ID across *every* fetched
  deployment, including blocked ones) would permanently exclude it from every future sync's
  `newDeployments` filter even once it later resolves to a real success/failure — the deployment is just
  gone, forever, with no record ever written. The fix: the new cursor only ever advances up to just below
  the lowest still-blocked ID in the current batch; an unrecognized-environment deployment (dropped by
  `mapEnvironment()` returning `null`) is a *permanent* skip, not a temporary one, so it doesn't hold the
  cursor back the same way.

  A deployment can also be blocked *forever*, not just temporarily — an abandoned/misconfigured pipeline
  that posts `queued`/`in_progress` and nothing else, or one whose eventual terminal status falls past the
  `?per_page=10` statuses page this script fetches. Left in `blockedIds` indefinitely, that single
  deployment would cap `maxDeploymentId` below it on every run forever, forcing every higher-ID deployment
  to be fully re-fetched and re-processed (statuses, compare, display-name resolution — real API cost) on
  every future sync, even though those deployments already have records and just get silently deduped at
  write time — found and fixed as a real bug. `buildDeploymentPlan()` now takes the current time as a
  parameter and permanently skips (same treatment as an unrecognized environment, with a loud
  `::warning::`) any still-blocked deployment older than `STUCK_DEPLOYMENT_MAX_AGE_HOURS` (env-overridable,
  default 48h) by its own `created_at`, instead of adding it to `blockedIds`.

  Separately, under a large backlog, `/deployments` used to be paginated in full on every single run
  regardless of the cursor, with no cap on how many new deployments one run resolves, and the cursor only
  ever written after that entire resolve loop finished — so a mid-run rate limit or crash lost all of that
  run's progress, not just the one deployment that triggered it. `githubApiAllPages()` now takes an
  optional `stopWhen(record)` predicate; the `/deployments` call passes `dep => dep.id <= lastSyncedId`,
  since GitHub returns that list newest-first (reverse creation order, which tracks descending ID) — so
  pagination stops as soon as it reaches already-synced IDs instead of always walking all the way back to
  the repo's very first deployment. `MAX_NEW_DEPLOYMENTS_PER_RUN` (env-overridable, default 200) caps how
  many new deployments a single run resolves, oldest-first (ascending by ID) so a capped run still makes
  steady forward progress through the backlog rather than resolving an arbitrary subset; `maxDeploymentId`
  is computed from that capped, actually-processed batch — not the full fetched list — so the cursor can
  never advance past whatever didn't fit in this run (the same "advancing past unprocessed work loses it
  forever" failure mode `blockedIds` already guards against, just from a different cause).

  GitHub can fire more than one deployment/status entry for what is, in git terms, the same commit on the
  same env/component (e.g. a squash-merged release re-notified by a second workflow job a few minutes
  later) — `docs/app.js`'s `currentVersion()` always shows the *latest-by-`deployedAt`, successful* record
  for a given component/env, so a "duplicate" record's own compare range matters just as much as the
  original's.
  `sync-github-deployments.js` tracks, per env, both the last resolved ref *and* the range already computed
  for it (`lastResolvedRangeByEnv`) — a later record resolving to that same ref reuses that cached range
  instead of comparing the ref against itself, which would otherwise silently collapse to an empty range
  (no `compareUrl`, no `relatedIssues`) and could surface as the *visible* "current" record for that
  component/env despite being a content-free duplicate of the correct one moments earlier.

  `deployedBy` prefers the deployment creator's public GitHub display name ("Imię Nazwisko") over their raw
  login, resolved via `GET /users/{login}` (`scripts/lib/github-users.js`, shared with the backfill script);
  `deployedByLogin` always keeps the raw login (or `null`) alongside it, both so the login survives even
  once `deployedBy` shows a name, and so `backfill-deployment-metadata.js` can tell already-processed
  records apart from older ones (`!('deployedByLogin' in rec)`, same idempotent-once pattern as `rollback`).
  Resolution degrades to the login (or `unknown` if there's no creator at all) whenever the user has no
  public name set, the account is a bot/service account, or the `/users` call fails for any reason — it
  never blocks or fails the sync.

  `version` is resolved in this priority order, most-authoritative source first: the name of a GitHub Release
  pointing at that exact SHA (resolved by cross-referencing `/releases`' `tag_name` against `/tags`) → the name
  of a plain git tag pointing at that SHA → a version-like substring (`\bv?\d+\.\d+\.\d+\b`) pulled out of the
  deployed commit's message (`extractPromotedVersion`) → the raw SHA, truncated. Releases and tags are fetched
  once per sync run (not per deployment), so this whole chain costs 2 extra list calls total, regardless of how
  many deployments are being processed. Release/tag rank above the commit-message regex deliberately — free
  text can match an unrelated version-like substring, where a Release or tag is an unambiguous, deliberate
  signal. This priority is purely about the *displayed* `version` string, though — the git ref actually used
  for the GitHub `/compare` call that derives `relatedIssues`/`commitUrl` only ever uses a verified release
  or tag name, falling straight back to the raw SHA (not the regex match) when neither resolved. Found and
  fixed as a real bug: the regex match used to be used as the compare ref directly, risking a 404 (no such
  ref) or, worse, silently comparing against some unrelated existing tag/branch that happened to share that
  version-like substring — fine to merely *display*, not reliable enough to resolve against GitHub's API as
  if it were a real ref.

  The tag/release fallback also matters for environments whose deploy pipeline doesn't promote from a
  "release" commit at all — e.g. `test` deploying straight off a feature-branch commit — which would otherwise
  only ever show a bare SHA even when that commit is actually tagged. Unlike rollback detection,
  `backfill-deployment-metadata.js` *does* re-resolve `version` for existing records — it only targets records
  whose current `version` looks like a raw SHA (`looksLikeRawSha`), tries the free release/tag lookups first,
  and only falls back to a per-record `/commits` call (capped by `MAX_RECORDS_PER_RUN`) if neither matches.
  The latest successful record per component/env may also carry `driftBehind`, recomputed on every sync from
  a single GitHub compare call between it and the earlier-stage environment (`test` → `qa` → `prod`):
  `{ behindEnv, commitCount }` when it lags behind (missing commits the earlier env already has), and/or
  `{ untestedIn, untestedCommitCount }` when it has commits the earlier env never saw — i.e. a hotfix or
  direct deploy that skipped the normal promotion path. **Those commit counts are raw git history, not a
  measure of how different the code is** (merges/squashes/separate deployment branches create new commits for
  identical code — "786 behind TEST" can be zero changed files), so since the tree comparison below they are
  context only. What decides whether a drift entry exists at all, and what the card shows, is a **git tree
  comparison** (`compareTrees()`, `scripts/lib/tree-diff.js`): both deployed commits' trees are compared; the same tree SHA
  = no drift; otherwise the recursive tree listings (`/git/trees/{sha}?recursive=1`) are diffed by path + blob
  SHA, paths matching the component's `driftIgnorePaths` (`docs/components.json`, passed as the
  `DRIFT_IGNORE_PATHS` env var — a JSON array; an invalid value fails the run) are discarded, and zero
  remaining files = no drift. A remaining difference is stored as `diff: { files, paths (first 20), ignored }`
  next to the counts (a rename = 2 files); a comparison that can't be trusted (API error, or GitHub's 100k
  entries / 7 MB `truncated` listing) is stored as `diff: { unknown: true }` — never as "no difference". Records
  written before this have no `diff` and show no file-diff section in the modal (only Git history) until their next sync. The
  matrix card (`driftNotesHtml()`) shows only **"Diff to ENV"** (one `.drift-note` button, nothing else);
  `openDriftModal()` shows the file diff, then the raw Git history counts, then "What this does not show" (the
  tree comparison covers repository files only — not config, env vars, images or flags). The Technical view
  summary/env-card notes read "N service(s) differ" / "N differ from ENV". Pattern semantics: `dir/` = prefix from
  the repo root, a pattern with `/` = exact anchored path, a bare name = that file name at any depth, `*` =
  anything but `/`. The pre-tree-diff worked example below used the old wording; the case itself
  (`evapl-service-frontend`) is still a genuine signal, not a false positive from differing release
  cadence between environments — confirmed against a real production case (`evapl-service-frontend`,
  2026-10-06): two environments both displayed `v1.0.0` two minutes apart, but each resolved to a different
  commit carrying a completely non-overlapping set of Jira issues, and the later environment's commit never
  passed through the earlier one at any point, including in that environment's own subsequent deploys. Since
  that specific record won't survive `RETENTION_DAYS` trimming forever, the explanation of what this label
  can mean lives in `docs/app.js`'s `driftNoteTooltip()` (a plain-language `title="..."` on each `.drift-note`,
  same pattern as `statusLabelTooltip()`) and a general, always-visible `.drift-legend` block above the
  Technical view matrix (`docs/index.html`) — not a one-off table tied to that past deployment, which the
  worked example instead lives in as documentation (see `FAQ.md`/`FAQ.pl.md`).

  `mapEnvironment()` only ever recognizes `test`/`qa`/`prod` (loosely, by substring — `production` →
  `prod`, `dev` → `test`); anything else (`staging`, `uat`, a preview env) has nowhere to go and is
  dropped with a loud warning rather than silently. A pre-production environment
  (`preprod`/`pre-prod`) is checked *before* the substring match specifically so it's never
  miscategorized as `prod` just because its name contains that substring. A deployment's latest status is
  resolved by finding the first entry GitHub's statuses list actually recognizes (`success`/`failure`/
  `error`), not just taking whatever's newest — GitHub appends `inactive` to a deployment's *own* status
  history whenever a later deployment on the same environment succeeds (`auto_inactive`, on by default
  outside an environment literally named `production`), and if both end up fetched as "new" in the same
  sync run (two deploys piling up between syncs — see the `notify-deployment.yml` gap below), the earlier
  one's newest status by then is that `inactive` marker, not its real outcome; naively taking the newest
  entry would make it match nothing and silently vanish from `deployments.json` entirely.
  `computeDeployDurationMs()` excludes `inactive` for the same reason — including it would inflate
  `durationMs` to "until some unrelated future deploy happened" instead of the deploy's own duration.
  Separately, GitHub's compare endpoint caps `commits` at 250 regardless of `total_commits` — a release
  spanning more than that loses `relatedIssues`/`issueCommitTypes` for whatever's missing (logged loudly
  when detected, no cheap full fix: the only way to get the rest is paginating `/commits` directly rather
  than through compare).

  **`docs/data/issue-deployments.json`** — a tiny, **never-trimmed** companion, same spirit as
  `deployments-cursor.json`: `{ [issueKey]: { [env]: { [component]: { deployedAt, commitUrl } } } }`,
  recording the *first* time an issue key was ever seen on a successful deployment, per env/component.
  Exists specifically because `docs/app.js`'s release-status/Release Notes/lead-time joins all scan
  `deployments.json` directly for a record whose `relatedIssues` includes a given issue key — found and
  fixed as a real gap: once `RETENTION_DAYS` trims that record away (and it isn't the one
  latest/latest-successful record `trimOldRecords()` always keeps), the issue silently reverted to looking
  "not deployed" in those three views even though it genuinely shipped once, despite ShipScope's own
  "current, real state" framing never being meant to apply to *historical facts* like "did this ship,
  ever." `sync-github-deployments.js` writes it from this component's **full current** record set (not just
  this run's freshly-resolved ones) every sync — a one-time, zero-extra-API-cost backfill effect: any
  record already in `deployments.json` when this file was introduced gets captured on that component's very
  next sync, instead of needing a separate backfill script. Cheap and idempotent (only ever adds a missing
  `(issueKey, env, component)` entry, never overwrites one), so safe to recompute from the full set on every
  run. `docs/app.js`'s `issueDeployedOnComponent()`/`anyDeploymentForIssue()`/`earliestProdDeployedAt()`
  check this as a fallback only after `state.deployments` itself has no match.
- **Jira issues** (`docs/data/jira-issues/{PI-slug}.json`, one file per PI, plus `docs/data/jira-issues/index.json`):
  Epics/Stories/Tasks with a `pi` (program increment, e.g. `PI-24.4`) derived from the Jira Sprint field or a
  `PI-\d+\.\d+` label, plus the raw `sprint` name that same Sprint-field lookup (`pickRelevantSprintInfo()`)
  already resolved before `pi` was extracted out of it — a PI typically spans several sprints, so `sprint` is
  a finer-grained sibling of `pi`, not a replacement for it, and both come from the same Jira field read.
  `sync-jira.js` groups every issue it resolves by `pi` and writes one JSON array per PI to
  `docs/data/jira-issues/{slug}.json` (`safeFileSlug(pi)` — non-alphanumeric characters replaced with `_`).
  `index.json` sits alongside them: `{ currentPi, pis: [{ pi, file, sprints: [{ name, startDate, endDate }] }] }`,
  `pis` sorted newest-PI-first (`comparePiDesc()`, the same numeric-aware compare `docs/app.js`'s
  `compareVersionDesc()` mirrors) — `sprints` carries each PI's distinct sprint names plus their start/end
  dates, parsed straight out of the same Sprint field data already being read for `sprint` above (the legacy
  string encoding renders a missing date as literal `<null>` text; `pickRelevantSprintInfo()` parses that
  back to real `null`), at zero extra Jira API cost. `currentPi` is resolved server-side, most-authoritative
  source first: the PI(s) derived from a configured board's *active* sprint (see "Restricting which Jira
  spaces get synced" below) → the highest PI (`comparePiDesc()`) among synced non-Epic issues → `null`.

  `pickRelevantSprintInfo()` picks whichever of an issue's sprint entries is currently `active`, falling
  back to the *last* entry in Jira's own list order when none is — an issue carries its full sprint
  history, not just the current one, and Jira doesn't mark which entry is "most relevant" otherwise. An
  issue can carry sprints from more than one team's board across its lifetime (a shared Epic bouncing
  between teams, a sub-task reassigned mid-flight), so that fallback alone could just as easily land on a
  *different* team's sprint — extracting a PI/sprint that has nothing to do with the board this sync is
  actually tracking. When the issue's own space has `boards` configured in `docs/jira-spaces.json`,
  `pickRelevantSprintInfo()` is also given that space's board name(s) and only considers sprint entries
  whose name starts with one of them (case-insensitive) — e.g. board `"Sparks"` matches sprint
  `"Sparks 27.3.1"` but not `"Rocket 27.3.2"`. This is a name-convention match, not a real per-sprint
  board lookup (Jira doesn't expose "which board owns this sprint" without an extra Agile API call per
  sprint) — cheap, zero extra API cost, and correct as long as a team's sprints are actually named
  starting with its board name. The match requires a word boundary right after the board-name prefix
  (`matchesBoardPrefix()` — the next character must not be a letter/digit, or the names must match
  exactly) rather than a plain substring check — found and fixed as a real bug: board `"Spark"` used to
  also match sprint `"Sparkle 27.3.1"`, a different team's sprint that merely happens to start with the
  same letters. If none of an issue's sprints match the configured board(s) at all, it
  falls through to a label-derived PI (`extractPiFromLabel()`), or gets dropped same as "no PI at all"
  today — not a new failure path, just a tighter sprint-selection criterion feeding the existing one. A
  space with no `boards` configured applies no filtering, identical to behavior before this existed.

  A second, independent double-check runs against Jira's own `Team` field (`findSpecialFieldIds()` —
  resolved by field *name*, same reasoning as `Flagged`: Jira's Team field, whether the legacy Portfolio
  one or the newer "Teams in Jira" one, has no single fixed `schema.custom` type to match across
  instances) — `extractTeamName()` normalizes whatever shape this instance returns it in (plain string,
  or an object with `name`/`title`/`value`/`displayName`). The field can also be **multi-value** on some
  instances — `extractTeamNames()` checks every element, not just the first (found and fixed as a real
  gap: a second/later value that actually matched this space's allowlist used to be silently ignored). This
  exists specifically because the
  board-name sprint check above never even runs for an **Epic**: Epics typically carry no Sprint field
  value at all (their PI comes from a label instead), so a different team's Epic that happens to share a
  `PI-27.3`-shaped label — entirely plausible, since a whole ART shares one PI numbering scheme — sailed
  straight past the sprint check with a *correct* PI number but the *wrong* team. Checked against
  `teamNamesByProjectName` (the issue's own space's `boards` + `teams` from `docs/jira-spaces.json` — see
  "Restricting which Jira spaces get synced" below), not just `boards`: a space with no board at all used
  to apply zero filtering here regardless of `Team` field content, since this check only ever activated
  when the board-name list was non-empty. The signal itself is two-pronged, not just the `Team` field: a
  plain Jira *label* matching one of the same configured names counts as an equally valid positive match
  — the `Team` field is routinely left empty in practice, with a label used instead to record the same
  information day to day. A populated-but-non-matching `Team` field drops the issue (logged, listing which
  issue and which `Team` value caught it) *unless* a matching label rescues it — **or** (found and fixed as
  a real bug) unless the issue's own sprint already matched this issue's own configured board
  (`matchesOwnBoardSprint`, from the board-name sprint check above): that's just as concrete a positive
  signal as a label, and a populated-but-wrong `Team` field used to override it even when the issue was
  genuinely, verifiably in this team's own active sprint — an issue in the right place with a stale/wrong
  Team field no longer gets rejected over it. For a space with **no
  board of its own** but `teams` configured, an issue with neither a matching `Team` field nor a matching
  label (and, by construction, no sprint match either, since a boardless space has nothing to match a
  sprint against) is also dropped — found and fixed as a real bug: previously, "no board configured" meant "no team
  evidence at all" was silently treated the same as "team confirmed," the opposite of a boarded space's own
  degrade-safely-by-default behavior being appropriate. A *boarded* space (like "eMobility Sparks") keeps
  its original, more lenient fallback: an unpopulated `Team` field and no matching label on an issue whose
  sprint doesn't resolve either (mostly Epics) still passes through — the sprint-board check already
  carries most of the real team-scoping weight there, so this remains purely additive, same as before.

  A second, independent leak existed on the *other* side of this same check: the current-PI query's
  `labels = "PI-X.Y"` disjunct (see `buildCurrentPiJql()`) can match an issue that has no real sprint
  relationship to this board/team at all — a PI label is organization-wide (the whole ART shares one PI
  numbering scheme), so matching on it alone was never real team evidence, yet an issue that reached the
  result *only* that way sailed through once its project passed the checks above. Found and fixed as a real
  leak: for a boarded space, an issue is now tracked (`matchedViaSprintIds`, compared against the real
  sprint ID(s) `resolveCurrentPiForSpaces()` resolved for the current PI) through whether it actually
  landed in the result via `sprint in (ids)` or only via the separate `labels =` branch; one that matched
  *only* via the label branch, with no Team-field/label evidence either (`labelOnlyNoEvidence`), is dropped
  — **unless** it's an Epic that still has at least one in-scope child, since an Epic typically carries no
  Sprint field of its own and is disproportionately likely to hit this exact shape even when it's genuinely
  the right Epic; dropping it anyway would silently lose Product view's own grouping header for children
  that otherwise correctly matched (`docs/app.js`'s `groupIssuesByEpic()` already tolerates a header built
  from a child's own `epicKey`/`epicTitle` with no `epicIssue` of its own, so no frontend change was needed
  to make that rescue visible). This check only ever activates for the current-PI query context, where real
  sprint-ID knowledge is actually available — a plain whole-project sync, the exact-key fallback, and
  `BACKFILL_PIS` never second-guess their own results this way.

  **ShipScope's job here is showing the current, real state of the active PI — not maintaining a
  historical archive** (Jira and GitHub already own that, better). So `sync-jira.js`'s default run (no
  `JIRA_PROJECT_KEY`, no `BACKFILL_PIS`) only ever auto-refreshes the board-derived *current* PI
  (`resolveCurrentPiForSpaces()`/`buildCurrentPiJql()` — unchanged, Agile-API active-sprint lookup), and
  does so as a **full replace**, not a merge: `runCurrentPiMode()` fetches "everything currently in this
  PI" and that result becomes the *entire* new content of that one PI's shard file, written via
  `writePiShards()`'s `'partial'` scope (only this PI's file + `index.json` entry touched; every other PI
  — including anything a manual `BACKFILL_PIS` run ever seeded — is left exactly as it is). An issue that
  moved out of the PI simply isn't in the fetch result, so it's naturally absent from the new shard with no
  separate "ghost removal" step needed — the earlier incremental-sync design (asking "what changed
  recently" across the whole project, then merging/correcting per issue) was dropped specifically because
  that *merge* semantics is what required ghost-handling in the first place; a full replace of a narrowly-
  scoped fetch doesn't — as long as that fetch is actually comprehensive for the PI it's replacing, which is
  the one assumption `'partial-merge'` scope (see above) exists for the one caller where it doesn't hold.

  The number of PI shards on disk is **not** automatically capped — by design, it grows by one every time a
  new PI becomes current, exactly mirroring `flag-state-history.json`'s "cheap enough to just keep
  everything, no retention policy" spirit rather than `deployments.json`'s day-based `RETENTION_DAYS`
  trimming. Removing an old PI (or several) is a deliberate, one-off, manually-triggered action — see
  `scripts/prune-jira-pis.js` (`prune-jira-pis.yml`) below — not something the regular sync ever does on
  its own.

  A pruned PI stays pruned via `docs/data/jira-issues/pruned-pis.json`, a small persistent exclusion list
  `prune-jira-pis.js` writes to and `writePiShards()` checks on **every** future call, in every scope —
  confirmed necessary in practice: a pruned PI came back on a later sync that was neither a `BACKFILL_PIS`
  run nor anything that should have touched it, because `runFullScopeMode()`'s fallback (triggered by a
  board lookup failing with `401`, which routes every run through the broad `key in (...)`
  deploy-referenced-issue-key scan instead of the cheap current-PI-only default) resolved a long-lived
  ticket's *old* PI from its sprint history: a ticket with several Sprint entries, none currently `active`,
  falls back to the *last* one in Jira's own list order (`pickRelevantSprintInfo()`), which can land on an
  old sprint even for the right, correctly-configured board/team — the Team-field double-check above only
  catches a *different* team's sprint, not an old sprint from the *same* team. Without a persistent record
  of "this was deliberately pruned," nothing stopped that rediscovery from writing the shard right back.
  The one way a pruned PI is allowed back is an explicit `BACKFILL_PIS` run naming it by exact PI label —
  that un-prunes it (removes it from this list), since asking for a PI back by name is a deliberate reversal
  of the earlier prune; every other code path (the default current-PI sync, and `runFullScopeMode`'s own
  fallback) has a pruned PI filtered out of whatever it just fetched, regardless of *why* that PI resurfaced.

  `'full'` scope's own "delete anything not in this run's result" step (immediately below) must never
  touch `pruned-pis.json` itself (or `status-index.json`) — an architecture review of this exact fix caught
  that the original version didn't exclude them, so a `'full'`-scope fallback run would delete
  `pruned-pis.json` as a side effect, silently undoing every previous prune on the very next such run (the
  exclusion list surviving exactly one fallback run before erasing itself — confirmed and fixed; both are
  now listed alongside `index.json` as infrastructure files this scope is never authoritative over).
  `runCurrentPiMode()` also filters its own `sprint in (ids)`/`labels =` match down to only the resolved
  current PI before writing (same guard `runBackfillMode()` already had) — without it, an issue matching
  on a coincidental second `labels =` hit in the current-PI query could make the everyday sync silently
  overwrite a completely unrelated, already-backfilled PI's shard, since `'partial'`-scope `writePiShards()`
  writes every PI key present in whatever it's given, not just one.

  All three fixes above treat a symptom; the root cause is `resolveBoardId()`/`fetchAllSprintsForBoard()`
  degrading a board/active-sprint lookup that failed to successfully complete at all — originally just
  `401`/`403`/`5xx` — exactly the same as one that succeeded but legitimately found nothing (board not
  found, ambiguous name, no active sprint right now) — both used to just warn and move on. Degrading a
  failed call this way means `resolveCurrentPiForSpaces()` returns empty, `currentPiJql` ends up falsy, and
  `main()` routes into `runFullScopeMode()`'s fallback — the same destructive `'full'`-scope recompute
  discussed above — on every single affected run, not just once. A dedicated `JiraBoardLookupError` exists
  for this (thrown instead of swallowed by both `try/catch` layers above it — the per-board loop inside
  `resolveCurrentPiForSpaces()`, and `main()`'s own catch around the whole call — both re-throw it via
  `instanceof`), widened at one point to cover every way the call can fail (non-2xx status *or* a raw
  network exception, not just `401`/`403`/`5xx`) after a follow-up review found the narrower version still
  silently degraded a `429` or network blip into the same destructive fallback.

  Throwing it at all is now **opt-in**, gated behind `JIRA_BOARD_LOOKUP_STRICT=true` (default/unset:
  soft-degrade, the original behavior) — flipped back after this exact mechanism's first real production
  trigger turned out to be a `401` specifically on the Agile API (`/rest/agile/1.0/board`) with an unclear
  root cause: the same Jira credentials had just successfully resolved the project list moments earlier in
  the same run (`resolveSpacesConfig()`'s own, still-uncaught project-list fetch), so this isn't an
  obviously-expired/invalid token — more likely something Agile-API-specific (missing Jira Software
  license/board access on the account, a scoped API-token permission gap, or a genuine transient Atlassian
  issue). **Investigated 2026-10-05** (see the Atlassian KB article on 401s for service accounts:
  https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/):
  the selective failure pattern in the production trigger — plain Jira REST calls (`project/search`)
  succeeding while only `/rest/agile/1.0/board` 401'd with the same credentials — rules out a wholesale
  invalid/expired token or account (that would 401 every call, not just this one). That KB article's own
  leading theory, a wrong URL structure (classic site domain vs. the `api.atlassian.com/ex/jira/<cloudId>`
  proxy some service-account tokens require), was manually tested and **ruled out**: this repo's actual
  configured `JIRA_BASE_URL` already *is* the `api.atlassian.com/ex/jira/<cloudId>` proxy form, and hitting
  both endpoints through that exact same URL with the same credentials reproduced the exact same split —
  `project/search` 200, `/rest/agile/1.0/board` 401 — so the proxy URL alone doesn't fix it; the failure is
  specific to the Agile API's authorization, not request routing. It's the classic
  signature of one of two Atlassian-side account/credential issues, neither a bug in this repo's code:
  (a) a **scoped API token** (the only kind a Jira **service account** — a distinct Atlassian Cloud
  identity type for automation, not a regular human/bot user — can create) that was issued with Jira
  platform API scopes but never had the separate Jira Software/Agile scopes added (e.g.
  `read:board-scope:jira-software`, `read:sprint:jira-software`) — unlike a classic token, a scoped token
  only works for whatever API families were explicitly selected at creation time; or (b) the account having
  ordinary project read access but no actual Jira Software product role/license assigned, which plain
  issue-search doesn't care about but `/rest/agile/1.0/*` does. Resolving either requires a Jira admin to
  fix the token's scopes or the account's product access — nothing to change in `sync-jira.js` itself.
  **Decision**: `JIRA_BOARD_LOOKUP_STRICT` stays at its soft-degrade default until an admin has actually
  confirmed/fixed the token or account — flipping it now would just make every sync run hard-fail on the
  same still-broken credential instead of degrading gracefully. Flipping it on is a one-line env var change
  once that's done, not a code change.

  **Confirmed 2026-10-07**: hypothesis (a) above is the real cause. A separate manual repro (`curl` against
  the exact same `JIRA_BASE_URL`, with the configured `JIRA_API_TOKEN`) reproduced the Agile-API 401 and
  surfaced an Atlassian gateway response header, `X-Failure-Category: FAILURE_CLIENT_SCOPE_CHECK` — an
  explicit, authoritative scope-check failure, not an ambiguous 401. The apparent contradiction that
  triggered this re-investigation (the *same* request succeeding from Postman) turned out to be a false
  premise: side-by-side comparison showed Postman was authenticating with a *different* API token than the
  one actually configured as `JIRA_API_TOKEN` (same leading prefix, different trailing characters — i.e.
  visually similar, easy to mistake for identical, but not the same credential). Once that's accounted for,
  there is no remaining client/network/UA mystery — Postman's success says nothing about the configured
  token's own scopes. Resolving this still requires a Jira admin to either add the missing Jira
  Software/Agile scopes to the token actually configured in this repo's secrets, or confirm whether a
  differently-scoped token should be issued and swapped in — nothing to change in `sync-jira.js` itself, and
  `JIRA_BOARD_LOOKUP_STRICT` stays soft-degrade until that's done, per the decision above. The only *other* soft-degrade path,
  regardless of this flag, is a *successful* response that legitimately found nothing (board not found,
  ambiguous name, no active sprint right now) — a genuinely unrelated bug elsewhere in the per-board loop's
  own processing is still swallowed with a warning either way, so one bad board can't take down its own
  space's other boards over that. When strict mode *is* on, letting a failed call fail the whole run is
  what lets `sync-with-retry`'s retry loop (and the daily cron safety net) actually recover — though note
  `sync-with-retry`'s own retry loop only re-triggers on a losing *push* race, not on the sync script's own
  non-zero exit (that fails the whole step immediately, under the shell's `set -e`); the daily cron is the
  real recovery path for this specific failure mode.

  **Resolved 2026-10-08**: a Jira admin fixed the configured service account's access, and the sync now
  completes end to end in production (board/sprint lookup succeeds, PI/sprint resolution works, issues
  fetch normally). A follow-up local diagnostic against the real account, run after the fix, confirms *why*:
  identity, project permissions (`BROWSE_PROJECTS`/`ADMINISTER_PROJECTS`) in both tracked projects, and JQL
  search all returned 200 (as they already did before, per 2026-10-07's "selective failure" evidence), and
  — the one call that previously 401'd with `FAILURE_CLIENT_SCOPE_CHECK` — the Agile board/sprint endpoint
  through the `api.atlassian.com/ex/jira/{cloudId}` proxy, with the *exact same* plain Basic
  `email:token` auth this repo's `sync-jira.js` has always used — now also returns 200. No code or
  `JIRA_BASE_URL`/auth-scheme change was needed; the fix was entirely account/token-side, confirming
  hypothesis (a)/(b) above rather than either alternative theory floated during the investigation. Both
  alternatives were in fact actively tested and ruled out, not just left unconfirmed: Bearer-vs-Basic (the
  theory behind the `diagnose-jira-401.sh` step 5 addition) was never needed once the real fix landed, since
  plain Basic now works; and proxy-vs-direct-host was directly disproven — the same working Basic credential
  against the Jira instance's own direct host (instead of the proxy) still returns 401, the opposite of what
  that theory predicted. `JIRA_BOARD_LOOKUP_STRICT` can now safely be flipped to `true` per the original
  Decision above (the admin has confirmed/fixed the account) — still a one-line env var change outside this
  repo's code, not yet done as of this writing.

  In the default soft-degrade mode, though, `main()` still has to decide what scope to fall back into once
  `currentPiJql` ends up falsy — and it now distinguishes two cases that used to be treated identically
  (both routed into `runFullScopeMode`'s destructive `'full'` scope): a space with no `boards` configured
  at all has genuinely nothing PI-shard-shaped to lose, so that case still uses `'full'`; but a space whose
  board(s) *were* configured and simply all failed/found nothing this run is a different, far more likely
  transient-failure shape — found and fixed as a real bug, since routing that case into `'full'` too meant
  a single flaky Agile-API response could silently delete or narrow every existing PI shard, including
  ones only ever seeded by a manual `BACKFILL_PIS` run. That second case now calls `runFullScopeMode` with
  `scope: 'partial-merge'` instead (see "Jira issues" above for the full `'full'`/`'partial'`/
  `'partial-merge'` distinction), so a transient lookup failure can only ever add/refresh the narrow
  fallback scan's own results, never delete anything it didn't touch.

  A board having no *active* sprint right now (a gap between sprints, or a typo'd active sprint name) used
  to make `resolveCurrentPiForSpaces()` treat that board as contributing nothing at all — found and fixed
  as a real bug: that's exactly the shape that falls through to the `boardResolutionAttemptedButFoundNothing`
  fallback above on *every* sync run during a sprint gap, not just once, since `fetchAllSprintsForBoard()`
  always returns the same "no active sprint" result until a new sprint starts. `fetchAllSprintsForBoard()`
  already fetches every sprint on the board regardless of state (needed for `sprintIdsByPi` either way), so
  `resolveCurrentPiForSpaces()` now falls back, at zero extra API cost, to the nearest upcoming (`future`)
  sprint by `startDate` when one exists, else the most recently closed (`closed`) sprint by `endDate` — only
  when *neither* exists does the board genuinely contribute nothing. This closes the common "between
  sprints" case before it ever reaches the destructive-by-default fallback path.

  Even with that fix, the `'partial'` scope `runFullScopeMode()`'s fallback actually uses was itself
  mis-specified: `writePiShards()`'s `'partial'` scope only ever protected *which PI shard files/index
  entries* survive a narrow run (nothing outside `fetchedEntries` gets touched) — but for a PI it *did*
  touch, the shard file's own content was still fully replaced by whatever that run fetched, not merged.
  For `runCurrentPiMode()`'s everyday sync and `BACKFILL_PIS` that's correct and intentional (their fetch is
  already comprehensive for that one PI — see "ShipScope's job here..." below), but the
  `boardResolutionAttemptedButFoundNothing` fallback's own fetch is the narrow deploy-referenced-issue-key
  scan, nowhere near comprehensive for the PI it's writing into. Found and fixed as a real bug: that narrow
  fetch silently replaced the *entire* shard content for that PI with just the handful of issues it
  happened to find, discarding everything else already synced for it. A third scope value,
  `'partial-merge'`, now exists specifically for this one call site: same index-level protection as
  `'partial'` (leaves every other PI's shard/index entry alone), but for the PI(s) it does touch, the shard
  content is upserted by issue `key` (and each PI's `sprints` list upserted by `name`) into whatever's
  already on disk, instead of overwriting it outright.

  Any **other** PI visible in the UI (via the global PI selector) is a point-in-time snapshot from whenever
  `BACKFILL_PIS` (`backfill-jira-issues.yml`, workflow_dispatch, comma/space-separated PI list e.g.
  `"PI-27.1, PI-26.5"`) last (re)fetched it — the escape hatch for seeding a PI that predates this sync
  ever running, or revisiting one no longer current. It is **not** kept in sync with Jira automatically;
  if an issue in a past PI changes after that backfill, the shard simply won't reflect it until someone
  reruns the backfill for that PI. This is a deliberate tradeoff, not an oversight: a past PI is understood
  to be "whatever we last looked at," not a live view — re-fetching every PI on every run would cost far
  more in Jira API calls for a capability (continuously-accurate deep history) ShipScope isn't meant to
  provide. `BACKFILL_PIS` also uses `writePiShards()`'s `'partial'` scope, and never touches `currentPi`.

  `resolveSpacesConfig()` deliberately lets a failure to fetch Jira's project list (needed to resolve
  `docs/jira-spaces.json`'s space names to project keys) **throw**, rather than degrading to "no space
  configured" the way it used to. That distinction matters a lot more now than it did before per-PI
  sharding: an empty `resolvedSpaces`/`currentPiResults` makes `buildCurrentPiJql()` return `null`, which
  routes `main()` to `runFullScopeMode`'s `'full'` scope — an authoritative recompute that deletes any
  existing PI shard not in its result. A transient Jira error silently producing that same "nothing
  resolved" shape would otherwise wipe every PI's data instead of just failing the run (which
  `sync-with-retry`'s retry loop, and the daily cron safety net, recover from transparently). As defense in
  depth on top of that root-cause fix, `writePiShards()`'s `'full'` scope also refuses to delete existing
  shards if the run resolves zero PIs while 2+ already exist on disk — logging a loud warning and leaving
  everything untouched instead, since that combination is far more likely an upstream failure than a
  genuine empty state. Separately (not about failures — about everyday correctness), `writePiShards()`
  also prunes any `index.json` entry whose shard file doesn't actually exist on disk, every time it writes
  — `docs/app.js`'s global PI `<select>` trusts `index.json`'s `pis` list completely and has no other way
  to know a PI is a dead end before a user picks it, so a stale entry (left behind by a manual edit on
  `live`, or any other drift) is never carried forward silently.

  A PI is still resolved primarily from the Sprint field (`extractPiFromSprintName()`), falling back to a
  Jira label only when that fails. That label fallback (`extractPiFromLabel()`) accepts both the plain
  `PI-27.3` form and the sprint-suffixed `PI-27.3.1` form some issues carry instead — either way, only the
  leading `PI-X.Y` is ever used as `pi`; a label's own trailing sprint digit is discarded, not treated as a
  second source of truth for `sprint` alongside the Sprint field (which is the far more reliably-maintained
  one — labels get added once and often drift as an issue moves sprints within the same PI).

  Every per-PI sharding decision above rests on one assumption: that a project running PI Planning always
  names/labels its sprints in a way `extractPiFromSprintName()`/`extractPiFromLabel()` can parse a PI out
  of. An issue whose sprint matches neither (e.g. the org dropped SAFe/PI Planning entirely and sprints are
  now just "Sprint 42," with no `PI-X.Y` shape anywhere) resolves `pi: null` and is dropped from `issues`
  entirely — `fetchAndMapIssuesForJql()` counts and warns (`::warning::`) whenever this happens, specifically
  so that transition is loud (a sync log warning pointing at a real, growing problem) rather than Product
  view quietly going empty with no explanation. Actually *handling* a no-PI org (e.g. an alternate sharding
  strategy keyed on something other than PI) is intentionally not built — YAGNI until that decision is
  actually made, not before.

  `sync-jira.js` also writes `docs/data/jira-issues/status-index.json` after every run
  (`buildStatusIndex()`) — a flat `key -> { pi, statusCategory }` map spanning *every* PI's shard, not just
  whichever one is currently selected. It exists specifically for the Technical view's Flags panel
  (`flagBlastRadius()`/`flagStaleWarning()` in `docs/app.js`): a flag's `jiraKeys` can easily span issues
  from more than one PI, and that panel has no PI selector of its own (see "Frontend" below) to let a user
  pick which shard should be loaded for it — reading `state.jiraIssues` there would silently depend on
  whatever PI happened to be loaded last from Product view. Cheap to always recompute in full: pure local
  file reads over whatever shards already exist on disk, no Jira API calls. Built by walking `index.json`'s
  `pis` list — already sorted newest-PI-first — and keeping only the *first* sighting of a given issue key;
  found and fixed as a real bug: a plain overwrite-as-you-go would let whichever PI's shard happens to be
  processed *last* win for a key that moved PIs (e.g. a stale copy left behind in an older, un-pruned
  `BACKFILL_PIS` snapshot), showing that issue's old status instead of its current one.

  Two other modes still use the older, `'full'` scope (a complete recompute where any existing shard file
  for a PI *not* found this run gets deleted, same as the original single-file sync always did): the
  explicit `JIRA_PROJECT_KEY` opt-in (still a whole-project(s) sync every run), and the automatic fallback
  for whenever `buildCurrentPiJql()` can't resolve anything — no space in `docs/jira-spaces.json` has a
  `boards` entry, or every configured board's active-sprint lookup failed — which reverts to the original
  deploy-referenced-issue-key scan instead, so a sync still produces *something* useful with zero
  onboarding config.

  `docs/app.js` fetches only `index.json` up front, then fetches one PI's shard at a time
  (`loadJiraIssuesForPi()`) — whichever PI is currently picked in the one global PI `<select>` shared by
  Product view/Release Notes/Insights (see "Frontend" below); nothing client-side ever holds more than one
  PI's issues at once (`state.jiraIssues`/`state.selectedPi`). This sharded layout replaces a single,
  ever-growing consolidated `jira-issues.json` — `sync-jira.js` deletes that old file the first time it runs
  after this change, and `orchestrate-full-sync.yml`'s Jira sync step lists both the new directory and the
  old file in its `paths:` so that one-time deletion ships in the same commit as the new per-PI files.
  `dependencyBlocked`/`dependencyNote` come from "is blocked
  by" issue links, and `status`/`statusCategory` (Jira's stable 3-bucket enum: `new` / `indeterminate` /
  `done`) — `sprint`, `status`, and `statusCategory` are all `null` on the deployment-derived fallback stubs,
  since that degraded path has no way to know an issue's real sprint or status. `projectName` is the Jira
  project ("space") the issue lives in, e.g. `"eMobility Sparks"` — one org can split related work across
  several Jira projects rather than one, so this is what `docs/app.js` shows as an issue's origin. `epicKey`/
  `epicTitle` (both `null` on Epics themselves, and on fallback stubs) identify the Epic parent for the other
  three types: resolved from the modern `parent` field when present (carries the title inline), falling back
  to the legacy Epic Link custom field (key only, title resolved via one extra batched lookup) on Jira
  projects still on the old hierarchy. `impediment` is Jira's own "Flagged" marker (the orange flag icon on
  a card) — resolved by field *name* rather than `schema.custom` (unlike Sprint/Epic Link, "Flagged" has no
  dedicated custom-field type, so name matching is the only practical option) and deliberately orthogonal
  to `status`: an issue can be "In Progress" and flagged as an impediment at the same time. `subtasks` is
  `{ done, total }` counting each sub-task's own `statusCategory`, or `null` when the issue has none — added
  specifically because a parent issue's own `status` can read "Done" (or anything else) while open
  sub-tasks/bugs remain, which `docs/app.js` otherwise has no way to surface. Both are `false`/`null` on the
  deployment-derived fallback stubs, same as every other Jira-only field there. `priority` is Jira's own
  priority name (`Highest`/`High`/`Medium`/`Low`/`Lowest`, or a custom scheme's name on instances that
  don't use the standard one) — drives the Product view Priority filter and the Insights per-priority
  chart. `created`/`resolvedAt` are the issue's own creation/resolution timestamps (`resolutiondate` in
  Jira's API) — `resolvedAt` specifically feeds the Insights "Lead time: Done → PROD" chart (paired with a
  deployment's `deployedAt`, see below); both are `null` on issues that aren't resolved yet, or on fallback
  stubs.
- A Jira issue links to flags via `flagsMeta[key].jiraKeys`, and to deployments via
  `deployment.relatedIssues` — `docs/app.js` joins these to compute a per-environment release status
  (`none` / `deployed` (code shipped, flag off) / `released` (code shipped, flag on) / `partial`).
- **Sync metadata** (`docs/data/sync-meta.json`): a single `lastFullSync` timestamp, stamped by
  `record-full-sync.js` only on the branch of `orchestrate-full-sync.yml` that re-syncs every tracked
  component's deployments plus Jira (the cron safety net, a manual run, or an unknown/malformed dispatch)
  — never on a single-component `repository_dispatch`. It exists specifically because that per-component
  dispatch path can silently go missing (see "Branch model" above — a deploy branch whose workflow YAML
  never got the `notify_shipscope` step), so `docs/app.js` renders it under the `source: data/*.json (live)`
  tag as "Last sync: <date>" — a visible answer to "is this data actually current," distinct from the tag
  itself, which only confirms the files were fetched, not that they reflect a recent, complete sync.

## How flags are discovered in caller repos (`scripts/lib/extract-flags.js`)

Two different discovery mechanisms exist and are NOT interchangeable:

- `discoverAllFlags(root)` — recursively finds `*.generated.ts` files and regex-extracts `key: true|false`
  properties from inside the first `{...}` object literal. Used by `scaffold-flags-meta.js` and
  `check-flags-metadata.js` for **build-time** flags.
- `resolve-all-flag-states.js` has its own, separate extractor (`extractFlagParts`) that looks for
  directories literally named `flag-parts` containing `default.ts` + optional `test.ts`/`qa.ts`/`prod.ts`,
  merges `default` with the per-env override, and writes the resolved `build` state per env.

Because these two extractors scan different source patterns, a flag found by only one of them used to be
able to end up with real `flag-states.json`/history but no `flags-meta.json` entry at all — invisible to
every part of `docs/app.js` that reads `flagsMeta` (both Technical-view flag lists and the flags panel),
even though its state showed up in the Deployment history timeline (which reads `resolvedFlags`/flip
attachments directly off deployment records, not `flagsMeta`). `resolve-all-flag-states.js` now scaffolds a
stub `flags-meta.json` entry for any key it resolves that isn't already there (same idempotent
`!flagsMeta[key]` pattern `sync-runtime-be-flags.js` already used for `runtime-be` flags), closing that gap
for anything discoverable via `extractFlagParts`. It only creates missing entries — it never corrects an
existing entry's `source`, unlike `sync-runtime-be-flags.js`'s scaffold (which does self-correct `source`),
since a flag-parts-derived key landing on an already-non-`build` entry would be a stranger, more surprising
case worth a human looking at it rather than the script silently overwriting it.

Both extractors are regex-based (not a TS parser) and expect a single object literal shaped like
`{ someFlag: true, otherFlag: false }`. If a caller repo's generated flags file changes shape, these
regexes are the first thing to check (see the `d812a95` fix commit for a past incident here).

## Tracked components (`docs/components.json`)

The full list of app repos/components ShipScope syncs is a single JSON array of objects in
`docs/components.json` — `{ name, description, serviceType, featureFlagsIncluded, application }` — keyed by
`name` everywhere it's consumed (read on `live`, like the scripts themselves — same main→live lag as
everything else here). `description` is shown as a tooltip on the component name in the Technical view.
`featureFlagsIncluded` — `true`/`false`/`null` (unconfirmed) — is ShipScope's honest admission that it
doesn't discover flags for every component the same way: an explicit `false` renders a small warning icon
next to the component name, since otherwise a component with real feature flags that ShipScope simply
doesn't track yet (e.g. Spring-env-var-backed flags only visible via that service's own Actuator, see
`design-docs/ARCHITECTURE-NOTES.md`) would look, from an empty Flags panel alone, like it has no flags at all — `null`
renders nothing, since "unconfirmed" isn't the same claim as "confirmed untracked". `serviceType` (`"FE"` /
`"BE"` / `null`) is stored but intentionally unused today — reserved for a future per-type icon once there's
a reliable way to set it, not something to guess at now. `versionFile` (optional repo-relative path, e.g. `"trigger.properties"`) opts a component into
resolving what really shipped from a file instead of the deployment SHA: for repos whose QA/PROD deploy from
`deployment/*` branches holding only trigger commits (`version=v0.0.702`, which the workflow then checks out),
`sync-github-deployments.js` (`VERSION_FILE` env, wired from this field by `orchestrate-full-sync.yml`) reads the
file at the deployed commit and uses the named tag/ref as `version`/`resolvedRef`/compare range, so drift,
`relatedIssues` and rollback reflect real code; any missing file/ref falls back to the SHA. Drift is recomputed
every sync and, for older records still pointing at the trigger commit (no `versionFromFile` marker), resolves the
file's ref on the fly — so displayed drift is right without touching old data. Only newly synced deployments get
the correct `version`/`relatedIssues`; `backfill-deployment-metadata.js` does not redo those, so old records keep their
stale `version`/`relatedIssues` until `RETENTION_DAYS` trims them. Drift also drops entirely when both refs have
an identical git tree, or differ only in `driftIgnorePaths` (see `compareTrees()` above), since commit counts measure history, not code. `driftIgnorePaths` (optional array of strings, repo-relative patterns for deployment plumbing such as `.github/`, `README.md`, `trigger.properties`; wired to `DRIFT_IGNORE_PATHS` by `orchestrate-full-sync.yml`) is empty by default, i.e. every differing file counts. `application` (array of strings, or `null`/absent
— unconfirmed, same spirit as `featureFlagsIncluded`) groups one or more components under a shared
business-facing name, e.g. `evboweb-service-bff` and `evboweb-service-frontend` both carrying `["EBO"]` — the
only consumer today is the Release Notes tab (see "Frontend" below), which rolls Jira issues up per
application instead of per component. It's an array, not a single string, because one component can
genuinely serve more than one application (e.g. a shared BFF) — such a component's issues then surface
under every application it's listed under, not just one (`applicationsForComponent`/`applicationsForIssue`
in `docs/app.js`); a missing/empty `application` falls back to the component's own name as a singleton
group (`orderedApplications`). It lives under
`docs/` — not `scripts/` — specifically so `docs/app.js` can `fetch` it directly: GitHub Pages serves only
`docs/`, and this is the one config file the frontend needs that isn't bot-generated sync output. It's the
one place to edit when onboarding a new component: `orchestrate-full-sync.yml`'s `prepare` job reads it to
build both the single-component matrix (`repository_dispatch`) and the sync-all matrix (cron/manual/unknown
dispatch); `backfill-deployment-metadata.yml` has its own equivalent `prepare` job for the same purpose; the
reusable `notify-deployment.yml` (called from each app repo, so it can't `checkout` this repo directly)
fetches the file over the GitHub Contents API instead to validate the `component` input before firing
`repository_dispatch`; and `docs/app.js` (`orderedComponents()`) fetches it client-side to render the
Technical view's component rows in onboarding order instead of alphabetically — a component missing from
the fetched list (or the fetch itself failing) just falls back to alphabetical for that component, same as
before this ordering existed. None of the `scripts/*.js` sync/backfill scripts know about this list —
they're all already component-agnostic via `COMPONENT`/`APP_REPO` env vars, so this file only exists to
avoid maintaining the same array in multiple places. Onboarding a new component still requires, outside
this repo: installing the shared GitHub App on that repo, and wiring a call to `notify-deployment.yml` (and,
if it has build-time flags, to `check-flags.yml`) into its own workflows.

## Restricting which Jira spaces get synced (`docs/jira-spaces.json`)

An optional allowlist, same "editable onboarding config, not bot-generated data" role as
`docs/components.json` — `{ "spaces": ["eMobility Sparks", "eMobility - EV Product"] }`, an array of
Jira project *names* exactly as shown in Jira's own UI (not project keys, which aren't visible there).
`sync-jira.js` resolves those names to project keys once per run and intersects them into whichever
project/issue-key scope it was about to search — this is a hard restriction on what ever reaches the per-PI
files under `docs/data/jira-issues/`, not a display-only filter in `docs/app.js`. Missing or empty file = no restriction
(same nullable-means-unconfirmed spirit as `components.json`'s `featureFlagsIncluded`), so it's opt-in: a
name that doesn't match any real Jira project exactly (case-insensitive) just logs a warning and is
otherwise ignored, rather than failing the sync.

Each entry can also be an object instead of a plain string — `{ "name": "eMobility Sparks", "boards": ["Sparks Board"] }` —
to opt that space into a second, low-cost fetch: `sync-jira.js` resolves each listed board name to its
Jira Agile board ID (`GET /rest/agile/1.0/board?name=...`), then reads that board's **full** sprint list
(`fetchAllSprintsForBoard()`, paginated over `GET /rest/agile/1.0/board/{id}/sprint`, not just
`state=active`) and derives the PI(s) currently in flight from whichever sprint(s) are active (same
`PI-\d+\.\d+` sprint-naming convention used everywhere else). It then collects the `id`s of every sprint on
that board — active, future, or closed — whose name resolves to the same PI number (a PI typically spans
several sprints, e.g. `27.3.1`/`27.3.2`/`27.3.3`, not just whichever one is active right now), and runs an
additional JQL query scoped to `project = <that space> AND (sprint in (<id1>,<id2>,…) OR labels = "PI-<PI>")`
— merged into the normal (deploy-referenced-only) issue set. This exists specifically so Product View can
show *every* work item currently planned for the PI the team is in — not just the ones that already have
code deployed somewhere — without paying for a full whole-project sync (see `JIRA_PROJECT_KEY` below): the
query is bounded to one PI's sprints, not the whole project's history. Querying by real sprint `id`s rather
than a text match against the Sprint field's name is deliberate, not incidental — found and fixed as a real
bug: the Sprint field's JQL operator set is `= != IS IS NOT IN NOT IN` only, so an earlier `sprint ~ "<PI>"`
attempt (CONTAINS/fuzzy-match) was rejected outright by Jira with a non-2xx response on every call where
board/active-sprint resolution actually succeeded — not a degrade, a hard crash of `runCurrentPiMode`
(the default sync path) propagating unguarded to `main()`'s top-level `catch` and exiting non-zero. Any
failure along this chain — board not found (or ambiguously matching more than one), no active sprint, an
active sprint whose name doesn't match the PI convention — logs a warning and skips just that board's
contribution; it never fails the sync, and a space with no `boards` configured behaves exactly as before.
`runBackfillMode()`'s own project-scoped branch doesn't currently resolve sprint `id`s this way (it has no
board context when invoked without `JIRA_PROJECT_KEY`), so its fallback query matches on `labels =` alone —
narrower recall, but never risks the same invalid-operator crash.

An entry can also carry `"teams": ["Sparks"]` — independent of `boards`, for a Jira project that's
genuinely shared across more than one team with no single dedicated board of its own (e.g.
"eMobility - EV Product": one broad project several teams file work into). `boards` and `teams` feed the
*same* allowlist for the Team-field double-check described below (board names already double as valid team
names for a boarded space like "eMobility Sparks" — `teams` is the explicit equivalent for a space that has
no board to lean on at all). Without `teams`, a boardless space applied **zero** team filtering no matter
what — found and fixed as a real bug (see `fetchAndMapIssuesForJql()`'s Team-field check in the "Jira
issues" section above).

A boardless-but-`teams`-configured space used to never contribute to the default (everyday, no
`JIRA_PROJECT_KEY`) sync run at all, though — `buildCurrentPiJql()` only ever reads board-derived
`currentPiResults`, so a space with nothing in `boards` simply has nothing to add to that query, no matter
how `teams` is set. Its work only ever reached a PI shard via `BACKFILL_PIS` or via the destructive-by-
default fallback — found and fixed as a real gap: `runCurrentPiMode()` now, once some *other* space's
board has already resolved a current PI, runs one additional `project = <this space's key> AND labels =
"PI-<resolved current PI>"` query per boardless+`teams` space and merges its (deduped-by-key) results into
the current-PI fetch before writing. The same fail-closed Team-field/label check already described above
applies to these results unchanged (a boardless space has `allowedBoardNames.length === 0`, which is
exactly the branch that requires a positive Team-field or label match) — so this is additive reach, not
additive risk: an issue from this space still needs real evidence of belonging to it, same as before.

A badly-shaped `jira-spaces.json` entry degrades silently in a way that's easy to miss, so it's validated
on every read (`readSpacesConfig()`): a plain string entry (`"eMobility Sparks"`) is the deliberate "no
restriction" case described above and is never warned about. An *object* entry whose `boards`/`teams` are
present but of the wrong type (e.g. `"teams": "Sparks"` instead of `["Sparks"]`) throws a dedicated
`JiraSpacesConfigError` with the space's name and the bad field, rather than being silently misread as
empty/no-restriction. An object entry that *parses* fine but still ends up with both `boards` and `teams`
empty (e.g. `"boards": []` and no `teams` at all) is a config mistake, not the plain-string "no
restriction" case — it logs `::warning::` naming the space, since this combination used to apply zero team
filtering with no signal anything was wrong. Separately, an explicit `JIRA_PROJECT_KEY` whole-project sync
also logs `::warning::` when the named project has no matching space entry in this file at all (zero
Team-field/label scoping for a run that was deliberately opted into whole-project scope, not the default's
narrower, safer behavior).

The Team-field check itself doesn't only look at Jira's dedicated "Team" field — a plain **label** matching
one of the same configured `boards`/`teams` names (e.g. a `"Sparks"` label sitting among an issue's other
labels) counts as an equally valid positive signal. This matters in practice: the Team field is often left
empty, with the label used instead as the day-to-day way of recording which team an issue belongs to.
Both signals are checked against the same config-driven list — nothing about a specific team/label name is
hardcoded in `scripts/sync-jira.js` itself.

## Scripts (`scripts/*.js`) — one job each, invoked by one workflow each

`scripts/sync-jira.js` is a thin orchestrator (modes + `main()`); its logic lives in `scripts/lib/jira-*.js`:
`jira-config` (env-derived settings, read once at require time), `jira-pi` (PI/sprint parsing and ordering),
`jira-jql` (JQL builders), `jira-spaces` (`docs/jira-spaces.json` + project resolution), `jira-boards` (Agile
board/sprint lookup, `JiraBoardLookupError`), `jira-issues` (fetching and mapping issues; `fetchAndMapIssuesForJql`
takes a single `ctx` object instead of a long positional list), `jira-shards` (per-PI shard + `index.json` +
`status-index.json` writing). `sync-jira.js` re-exports the same public names as before. `scripts/lib/cli.js`
(`fail`, `safeRelativePath`) replaces the per-script copies; `scripts/lib/json-file.js` (`readJson(path, fallback?)`, `writeJson`) is the shared read-existing-JSON / pretty-print-with-trailing-newline pair the data-mutating scripts use. Behavior is unchanged by this split.

`scripts/lib/flag-ingest.js` (`applyObservations`) is the shared core that `resolve-all-flag-states.js` (`source: 'build'`) and `sync-runtime-be-flags.js` (`source: 'runtime-be'`) both call: the cross-component collision guard, `flags-meta.json` scaffolding/`components` union, idempotent `flag-states.json` writes and the history entries — they used to carry two copies of this. It mutates the in-memory objects and returns what changed; the scripts own file I/O and how values are obtained (adapters). `correctMetaSource` (default `false`) is the one deliberate difference: only `sync-runtime-be-flags.js` rewrites an existing `flags-meta` entry's `source`. `update-flag-state.js` does not use it (single manual flip, no `COMPONENT`). The generic payload adapter is `ingest-flags.js`; design in `design-docs/FLAG-INGEST.pl.md`.

| Script | Workflow | Purpose | Key env vars |
|---|---|---|---|
| `scaffold-flags-meta.js` | check-flags.yml | Create stub `flags-meta.json` entries for newly discovered build flags | `FLAGS_META_PATH`, `FLAGS_SEARCH_ROOT`, `COMPONENT` |
| `resolve-all-flag-states.js` | check-flags.yml | Resolve build-time flag states per env from `flag-parts/` dirs, scaffolding a `flags-meta.json` stub for any resolved key that doesn't have one yet; refuses (loud `::error::`, not thrown) to overwrite a key's `build` state already owned by a different `COMPONENT` — a same-source cross-component name collision | `FLAGS_SEARCH_ROOT`, `FLAGS_META_PATH`, `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH`, `CHANGED_BY`, `COMPONENT` (required) |
| `check-flags-metadata.js` | check-flags.yml | Fail CI if any discovered flag lacks complete metadata, unless `WARN_ONLY=true` (opt-in via the workflow's own `WARN_ONLY` input — default `false`, i.e. still fails), in which case the same problems are logged as `::warning::` annotations instead and the script exits `0`; meant for onboarding a new component, where every flag is incomplete by construction and a hard failure would block merging anything until metadata catches up | `FLAGS_META_PATH`, `FLAGS_SEARCH_ROOT`, `STATUS_REPO_EDIT_URL`, `WARN_ONLY` (optional, default `false`) |
| `fill-flag-metadata.js` | fill-flag-metadata.yml | Manually fill/update one flag's metadata (workflow_dispatch); the workflow pushes to `live` using a real GitHub App token (not the default `GITHUB_TOKEN`), and — only when that push actually happened — fires a `flags-meta-changed` `repository_dispatch` so `retrigger-app-checks.yml` reacts. This replaced an earlier design where `retrigger-app-checks.yml` itself listened on `on: push: branches: [live]` — found and fixed as a real security gap: a push-triggered workflow always runs whatever version of *its own YAML* exists on the pushed-to branch, so a `live` compromised via a leaked `SHIPSCOPE_APP` credential (`contents: write`, reachable from any onboarded app repo) could have gotten a modified copy of that workflow executed with its `CIRCLEK_GLOBAL_GITHUB_EVDT_APP` secret. `repository_dispatch` always resolves against `main` instead, closing that path. `check-flags.yml` and `sync-runtime-be-flags.yml` fire the same event after their own successful pushes. | `FLAG_KEY`, `DESCRIPTION`, `SOURCE`, `JIRA_KEYS`, `COMPONENTS` |
| `sync-runtime-be-flags.js` | sync-runtime-be-flags.yml | Poll BE flag endpoints per env, update `flag-states.json` + auto-scaffold `flags-meta.json` for BE flags; same cross-component collision refusal as `resolve-all-flag-states.js`, for the `runtime-be` source | `URL_TEST`/`URL_QA`/`URL_PROD`, `COMPONENT` (required), `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH`, `FLAGS_META_PATH` |
| `update-flag-state.js` | update-flag-state.yml | Set a single flag/env/source state (manual or `repository_dispatch: flag-changed`); no-ops (no write, no history entry) when the requested value already matches — found and fixed as a real bug: it used to unconditionally write + log a history entry on every call, so a retried/duplicate dispatch for an already-current value faked a flip that never happened | `FLAG_KEY`, `ENVIRONMENT`, `ENABLED`, `CHANGED_BY`, `FLAG_STATES_PATH`/`FLAG_STATE_HISTORY_PATH`/`FLAGS_META_PATH` (all optional, same defaults as every sibling script — previously hardcoded with no override) |
| `ingest-flags.js` | `.github/actions/ingest-flags` (composite action, called as a step from an app repo) | Generic flag-value ingest: reads a JSON payload (`schemaVersion: 1`, `source`, `observations[{key, env, enabled}]`) produced by an app repo and applies it through `scripts/lib/flag-ingest.js`. Validates everything (shape, ≤5000 observations, key pattern, env, boolean, no conflicting duplicates). `COMPONENT` comes from the caller's identity (workflow), never from the payload — a payload naming a different component is rejected. Does not correct an existing `flags-meta` `source`. See `design-docs/FLAG-INGEST.pl.md` | `COMPONENT` (required; the action sets it to the calling repo's name and requires it to be in `components.json`, default-branch runs only), `PAYLOAD_PATH` (required), `CHANGED_BY` (optional), `FLAG_STATES_PATH`/`FLAG_STATE_HISTORY_PATH`/`FLAGS_META_PATH` (optional) |
| `sync-github-deployments.js` | orchestrate-full-sync.yml | Pull GitHub Deployments API for one app repo, derive per-env status + related Jira keys from commit ranges; trims `deployments.json` to `RETENTION_DAYS` (keeping the latest-overall and latest-successful record per component/env regardless of age — see "Deployments" above) and tracks the highest deployment ID ever synced per component in the never-trimmed `docs/data/deployments-cursor.json`; also records every (issue, env, component) it's ever seen successfully deployed into the never-trimmed `docs/data/issue-deployments.json`; also writes `docs/data/summary.json`, a precomputed `{current, latestOverall}` per component/env fast path for `docs/app.js`'s `currentVersion()` (see "Deployments" above); warns (`::warning::`) if `deployments.json` still crosses `SIZE_WARNING_THRESHOLD_MB` despite trimming; permanently skips (loud `::warning::`) a deployment stuck with no terminal status past `STUCK_DEPLOYMENT_MAX_AGE_HOURS`, stops paginating `/deployments` once it reaches the cursor, and caps new-deployment processing per run at `MAX_NEW_DEPLOYMENTS_PER_RUN` (see "Deployments" above) | `GITHUB_TOKEN`, `APP_REPO`, `COMPONENT`, `RETENTION_DAYS` (optional, default 90), `CURSOR_PATH` (optional), `ISSUE_DEPLOYMENTS_PATH` (optional), `SUMMARY_PATH` (optional), `SIZE_WARNING_THRESHOLD_MB` (optional, default 20), `STUCK_DEPLOYMENT_MAX_AGE_HOURS` (optional, default 48), `MAX_NEW_DEPLOYMENTS_PER_RUN` (optional, default 200), `DRIFT_IGNORE_PATHS` (optional JSON array, from the component's `driftIgnorePaths`; paths not counted as a code difference between envs), `GITHUB_API_ETAG_CACHE_DIR` (optional — see the ETag-caching note above `githubApiAllPages()`) |
| `sync-jira.js` | orchestrate-full-sync.yml | Default run: fetch only the board-derived current PI (`docs/jira-spaces.json` space(s) with `boards` configured) and fully replace that PI's shard + `index.json`'s `currentPi` with the result — bounded cost, and self-correcting by construction (a full replace, not a merge, so a moved-out issue is just absent from the new shard). Falls back to the old full-project/deploy-referenced-issue-key scan (whole-project when `JIRA_PROJECT_KEY` is set, else exact issue keys referenced in `deployments.json`) when no board resolves a current PI at all, recomputing every PI file from scratch in that case. Also (re)writes `status-index.json`, a cross-PI `key -> {pi, statusCategory}` map the Technical view's Flags panel reads instead of a single PI shard. Also invoked by `backfill-jira-issues.yml` with `BACKFILL_PIS` set, to seed/re-fetch specific past PI(s) on demand without touching any other file — those are point-in-time snapshots, not auto-refreshed | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` (optional), `SPACES_PATH` (optional), `JIRA_ISSUES_DIR` (optional), `BACKFILL_PIS` (optional), `JIRA_BOARD_LOOKUP_STRICT` (optional, default `false` — see "Jira issues" above) |
| `retrigger-app-checks.js` | retrigger-app-checks.yml | Re-run failed `check-flags` runs in app repos after `flags-meta.json` changes on `live` — triggered by a `flags-meta-changed` `repository_dispatch` (fired by `fill-flag-metadata.yml`/`check-flags.yml`/`sync-runtime-be-flags.yml` after each actually pushes a change), not `on: push: branches: [live]` as it originally was — see that fix's rationale under `fill-flag-metadata.js` above. The script itself is already component-agnostic (one `APP_REPO` per invocation); the *workflow* is a matrix over every `docs/components.json` entry with `featureFlagsIncluded: true`, not a single hardcoded repo (found and fixed as a real bug — it used to only ever target `evapl-service-frontend`, so every other flag-tracked component's stuck check-flags-trigger.yml run never got retriggered) | `APP_REPO`, `APP_REPO_RERUN_TOKEN`, `WORKFLOW_FILE` |
| `backfill-deployment-metadata.js` | backfill-deployment-metadata.yml | One-off, manually-triggered: fill `workflowRunUrl`/`durationMs`/`manual`/`rollback`/compare-range `commitUrl`/`deployedByLogin`+resolved `deployedBy` name and re-resolve `version` (release/tag/message, same priority as the sync script) on deployment records created before those fields/that priority existed; also repairs pre-existing duplicate-release records (same resolved ref/env, collapsed to an empty range before the sync script's `lastResolvedRangeByEnv` fix) by copying the correct range from whichever sibling already has it | `GITHUB_TOKEN`, `APP_REPO`, `COMPONENT`, `MAX_RECORDS_PER_RUN` |
| `backfill-flag-state-history.js` | backfill-flag-state-history.yml | One-off, manually-triggered: mine `live`'s own git history for `flag-states.json` to seed `flag-state-history.json` with flips that predate that log (author unknown — see domain model above) | `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH` |
| `sync-jira.js` (again) | backfill-jira-issues.yml | One-off, manually-triggered: (re)fetch one or more explicitly named PI(s) (`BACKFILL_PIS`, comma/space-separated, e.g. `"PI-27.1, PI-26.5"`) — for a PI predating this sync, or to force-refresh one that's since moved out of "current." Writes/overwrites only the requested PI's shard(s); never deletes or changes any other PI's file, and never touches `index.json`'s `currentPi`. If a requested PI is on the `pruned-pis.json` exclusion list (see `prune-jira-pis.js` above), naming it here removes it from that list — the one deliberate way to bring a pruned PI back | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `BACKFILL_PIS` |
| `prune-jira-pis.js` | prune-jira-pis.yml | One-off, manually-triggered: delete one or more explicitly named PI shard(s) (`PRUNE_PIS`, same comma/space-separated format as `BACKFILL_PIS`) and their `index.json` entries, and record them in `docs/data/jira-issues/pruned-pis.json` so a *future* sync run can't silently rewrite the shard back (checked by `writePiShards()` on every call, every scope). The only way old PI shards ever go away — nothing in the regular sync does this automatically (PI shards accumulate indefinitely by design, see "Jira issues" above). Refuses to prune the PI that `index.json` currently lists as `currentPi`, since that would leave the dashboard without a current PI to default to. A requested PI not currently present still gets added to the exclusion list (not a no-op) — the point is "never let this come back," not just "remove it if it exists right now" | `JIRA_ISSUES_DIR` (optional), `PRUNE_PIS` |
| `record-full-sync.js` | orchestrate-full-sync.yml | Stamp `docs/data/sync-meta.json` with the current time — only run after every tracked component's deployments plus Jira were re-synced (cron/manual/unknown-dispatch branch of the `prepare` job, never a single-component `repository_dispatch`), so `lastFullSync` means "confirmed against the real state," not "something ran" | `SYNC_META_PATH` |

Two shared libs centralize rate-limit retry handling that used to exist inconsistently (or not at all)
across scripts — found and fixed as a real gap: `backfill-deployment-metadata.js` had no rate-limit
handling whatsoever before this, unlike `sync-github-deployments.js`'s own long-standing retry logic, so a
backfill run (bursty — per-record `/commits` calls on top of statuses/compare/display-name lookups) could
simply crash on a GitHub primary/secondary rate limit instead of waiting it out. `scripts/lib/github-api.js`
(`githubApiGet`/`githubApiRequest`) extracts that retry logic — retries on a primary limit (`429`, or `403`
with `x-ratelimit-remaining: 0`) or a secondary limit (`403` with a `retry-after` header — GitHub's
secondary limit has its own separate counter, so `x-ratelimit-remaining` can still read non-zero on a
secondary-limited response; found and fixed as a real gap, since this helper originally only recognized the
primary shape despite claiming to cover both), backing off until `retry-after` if present, else
`x-ratelimit-reset`, else 30s — and is now used by `sync-github-deployments.js`,
`backfill-deployment-metadata.js`, and `retrigger-app-checks.js` alike. `scripts/lib/jira-api.js` (`fetchWithRetry`) is the Jira-side equivalent —
retries on `429`, backing off by the `Retry-After` header (30s default) — returning the raw `Response`
(not parsed JSON) so `sync-jira.js`'s existing `res.ok`/`res.status` handling at each of its Jira API call
sites keeps working unchanged; nothing on the Jira side had any rate-limit handling before this either.

`check-flags.yml` is a **reusable** workflow (`workflow_call`) meant to be called from *app* repos (e.g.
`evapl-service-frontend`) — those repos check out their own code plus this repo's `scripts/`+`docs/data`
(via a GitHub App token scoped to `evdt-service-shipscope`) and run the flag checks against their own
generated flag files. Its "Scaffold new flags + resolve build-time flag states" step — the one that
commits to `shipscope-data` (`live`) — only runs `if: github.event_name != 'pull_request'`: a
`workflow_call` job shares its calling workflow run's own event context, so this is a safe, caller-agnostic
guard against writing a PR's own unmerged branch content straight into the production dashboard's data
(found and fixed as a real bug — nothing previously stopped this). The read-only "Check flag metadata
completeness" step still runs on every trigger, including `pull_request` — that's the whole point of it as
a pre-merge CI gate, and it never writes anything. That step's `WARN_ONLY` behavior is itself gated behind
the workflow's own `WARN_ONLY` input (default `false`, i.e. still a hard gate) — a caller repo onboarding
its first flags opts in explicitly (`with: WARN_ONLY: true` at its own call site) rather than this
reusable workflow ever softening the gate on its own.

Every data-mutating script follows the same shape: read existing JSON (or `{}`/`[]` if absent) → merge in
new data, only bumping `changedAt`/`changedBy` when a value actually changes → write back pretty-printed
JSON. Preserve that idempotency (no-op when nothing changed → no commit) when editing these scripts, since
workflows commit-and-push only `git diff --staged --quiet ||`.

`orchestrate-full-sync.yml`'s `sync_jira` job runs with `if: always()` — it must not be held hostage by
`sync_deployments`' matrix reporting overall failure just because *one* component's deployment sync failed
(a newly onboarded repo missing the GitHub App, a transient rate limit); without it, the default `needs:`
behavior would skip Jira sync entirely over an unrelated, single-component failure.

## Frontend (`docs/`)

Every `innerHTML`-destined template string must `escapeHtml()` any field that didn't originate as a fixed,
developer-authored constant in this file (`CHART_STATUS_ORDER`'s labels, `ICONS`, etc. are fine as-is) —
found and fixed as a real gap: `component`/`version`/`dependencyNote`/`changedBy`/a rollback's `toRef`/a
newly-discovered flag's `key` were each escaped in some render paths but not others, including inside a
`title="..."` attribute value (an `innerHTML`-parsed attribute, unlike a plain `.title =` DOM property
assignment elsewhere in this file, which is never HTML-parsed and must stay as a raw string, not
`escapeHtml()`'d, or it would show literal `&amp;`-style entities in the tooltip). Several of these fields
originate from `workflow_dispatch` inputs, git commit messages, or Jira fields — not fully trusted input —
so the inconsistency was a real stored-HTML/attribute-injection gap, not just a style nit. Two further
instances of this same gap, found and fixed separately: `renderDeployGroupCard()`'s `deployedBy` (a GitHub
display name, attacker-influenceable) was inserted into `innerHTML` with no `escapeHtml()` at all — a
genuine, exploitable stored-XSS regression against the already-correctly-escaped `renderDeployCard()`
right next to it; and a Jira issue `key` was escaped in some of its own render paths (issue rows, epic
headers) but not others (deploy-card issue chips in `renderChipsRow()`, Release Notes rows) — lower
severity than the `deployedBy` case since the format is regex-constrained server-side, but fixed anyway as
defense-in-depth, including inside `href="${JIRA_BASE_URL}/${...}"`.

Single-page vanilla JS, no framework/build step. `docs/app.js` fetches `docs/data/deployments.json`,
`flags-meta.json`, `flag-states.json`, `docs/data/jira-issues/index.json`, and
`docs/data/jira-issues/status-index.json`, and `docs/data/summary.json` (all three best-effort — see "Jira
issues" and "Deployments" above) up front, then a single
PI's Jira shard (`loadJiraIssuesForPi()`) before rendering anything; joins it all in
memory and renders two tabs: "Product view (PI)" (Jira-issue-centric, filterable by type/priority/date,
always scoped to whichever PI is currently loaded) and "Technical view" (component × environment matrix +
deployment timeline + flat flag list). All
dates are rendered in `pl-PL` locale — except the "Rollbacks & drift over time" Insights chart's month/year
axis labels, deliberately kept in `en-US`. Every one of those up-front files (everything but the per-PI
Jira shard, whose filename isn't known until `index.json` itself comes back) also has a matching
`<link rel="preload" as="fetch" crossorigin>` hint in `docs/index.html`'s `<head>`, so the browser starts
downloading them while still parsing HTML instead of waiting for `app.js` to load and run its first
`fetch()` — `crossorigin` is required for the preload to actually be reused by that later same-origin
`fetch()` call (whose default request mode is CORS); without it the browser double-fetches and logs an
unused-preload warning.

Each `.comp-row` in the Technical view's component × environment matrix (`renderMatrix()`) carries a CSS
`min-height:70px`, not a fixed `height` — a row whose own content needs more room (e.g. two stacked
`driftBehind` notes) grows past it rather than clipping. Since each env card renders its own independent
column of rows, that growth would otherwise desync row N across env cards whenever row N's content differs
per env (e.g. QA's version is behind both TEST and PROD) — row N no longer lining up at the same vertical
position across TEST/QA/PROD breaks the whole point of a matrix layout. `renderMatrix()` collects every
component's row elements across all three env cards (`compRowsByComponent`) and, once they're all in the
DOM, measures each one's actual rendered height and snaps every row for that component to the tallest one
found — so a 90px QA row pulls its TEST/PROD counterparts up to 90px too, not just its own column. This
runs once per full render; it does not re-measure on window resize (no other alignment in this file does
either — see the flags-scroll sync just below, which only syncs scroll position, not height). `.comp-row`
itself carries real top/bottom padding (`10px 12px`, not `0 12px`) specifically so that growth never
collapses to bare content with no breathing room — found and fixed as a real bug: with zero vertical
padding, a row whose stacked content (version + drift notes) landed at e.g. 78.4375px looked visually
cramped against its own edges, while a taller sibling (e.g. 90px) only looked fine by coincidence, from
slack borrowed off a *different* row's taller content during equalization — not from any padding of its
own.

Technical view's "Deployment history" panel defaults to a "Last 90 days" display filter
(`filterDeployRange`, next to the existing Service/Environment filters) — a client-side render-time cutoff
in `renderTimeline()`, same spirit as the Insights "Rollbacks & drift" chart's 12-month window: it filters
whatever's already in `state.deployments`, independent of (and coincidentally matching) `RETENTION_DAYS`'
server-side trim of `deployments.json` itself (see "Deployments" above) — the two aren't wired together,
they just default to the same number today. "All time" stays one click away and still only ever shows
whatever `RETENTION_DAYS` left in the file; clicking a specific deployment in the Technical view matrix
temporarily clears the filter so that deployment is never hidden by it (as long as it's still in the file
at all — current-version/drift/rollback detection are what `RETENTION_DAYS` always keeps regardless of
age, not an arbitrary other old deployment).

One global PI `<select>` (`initGlobalPiSelect()`), shown in the tabs row — except on Technical view, which
hides it (`switchToTab()`): nothing on that view is PI-scoped, so a visible-but-inert control would just be
confusing — is the single place that changes which PI's data is loaded — shared by Product view, Release
Notes, and Insights. Its options come from `index.json`'s `pis` list
(already newest-first), with the server-resolved `currentPi()` marked; changing it re-fetches that PI's
shard into `state.jiraIssues`/`state.selectedPi` behind a "latest request wins" guard (switching the select
twice in quick succession fires two overlapping fetches with no guarantee they resolve in request order —
found and fixed as a real race: a slower first fetch resolving *after* a faster second one used to silently
overwrite state with stale data while the `<select>` itself already showed the newer selection; the
`change` handler re-checks the select's current value after each `await` and discards a response that's no
longer current), resets and repopulates both Product view's and Release
Notes' own filter option lists (type/priority, service/type — see `refreshProductViewFilterOptions()`/
`refreshReleaseNotesFilterOptions()`, since those options are themselves derived from whichever PI's issues
are currently loaded), and re-renders everything downstream. `currentPi()` (the org's real active PI) and
`state.selectedPi` (whichever PI the user is currently browsing) are deliberately different concepts — a
user can browse a past PI while the org has already moved on, and `showCurrentTag`-style checks in
`docs/app.js` compare the two rather than assuming they match. Two Insights charts are the deliberate
exception to "one PI at a time": "Rollbacks & drift over time" and "Stale flags" both stay cross-time,
covering everything in `deployments.json`/`flag-states.json` regardless of the selected PI, precisely so a
deploy that never got tagged with any Jira issue — a hotfix, most commonly — doesn't silently vanish from
view just because it isn't part of whichever PI happens to be selected.

Product view is grouped by Epic (`groupIssuesByEpic()`), not a flat issue list — this exists specifically so
a PO/business reader can answer "where did Epic/Story/Task/Bug X land" without an Epic's own row (which
never has a deployment of its own) sitting there showing a misleading "Not deployed" next to its already-
shipped children. An Epic-type issue becomes a pure section header (title, key, its sprint tag if it was
itself synced — no `pi` tag any more; the global PI `<select>` already shows that, so repeating it on
every row/epic was redundant — and a `epicRollup()` "N/M released to PROD" badge over its children — counting the same
strict `prodStatusBucket() === 'released'` bucket the Product view summary tiles/Insights' per-PI chart
use, not the broader `issueIsReleasedToProd()` (which also counts `deployed_code_only` — code shipped with
no flag to confirm against — as released; that's the right call for Release Notes' "did this reach users"
question, but would make this badge silently disagree with the tiles rendered right above it for the same
PI) and is never rendered as its own data row. A separate, explicit "Fully released" badge
(`ICONS.check`, green) appears next to the Epic's own status tag specifically when `rollup.released ===
rollup.total` — a binary signal alongside the progress bar, for "every one of this epic's in-scope
children is released," per `design-docs/PRODUCT-VIEW-NOTES.md`'s "parent is released once every child is"
discussion. Deliberately *not* extended one level deeper to a Story's own sub-tasks the same way: a
Story's own flag/deploy status and its sub-tasks' Jira completion are different signals (see that same
design doc) — gating one on the other would make a feature that's genuinely already live for users read
as "not released" over unrelated Jira housekeeping, which runs against this dashboard's whole point of
showing the real, current production state. Story/Task/Bug group under their resolved `epicKey` (present even when the Epic itself
was never directly synced — see "Jira issues" above); anything with neither an epicKey nor `type: 'Epic'`
falls into a trailing "Ungrouped" section rather than silently disappearing. Group (Epic) order follows
first-encounter order in the (already type/date-filtered, and implicitly PI-scoped by whichever shard is
loaded) issue list, not a separate sort — but *within* each group's `children` (and within "Ungrouped"),
`groupIssuesByEpic()` does sort, by `WORK_ITEM_TYPE_ORDER` (`Bug` before `Story` before `Task`): per the
ideation session, a Bug is the thing most likely to need attention, so it should surface at the top of an
expanded Epic rather than wherever it happened to fall in date/pagination order. The sort is stable, so
same-type items keep their relative order. The Type filter's own option order
(`refreshProductViewFilterOptions()`) uses the same `typeSortRank()`/`WORK_ITEM_TYPE_ORDER` (prefixed with
`Epic`, since that's a valid filter value even though it's never a `children`/`ungrouped` member) instead
of a plain alphabetical sort, so "Epic, Bug, Story, Task" reads the same way everywhere in Product view.

A second, independent scope control — `#filterSprint`, grouped with the global PI `<select>` in the tabs
row itself (`#sprintSelectWrap`, right next to `#globalPiSelectWrap`, both inside `.tabs-row-right`) rather
than down in Product view's ordinary Type/Priority/date filter row — narrows the loaded PI's issues down
to one sprint
at a time, or back out to every sprint in it ("All sprints", the long-standing default scope before this
control existed). Placed next to the PI select deliberately — both narrow "what data is loaded" top-down
(PI, then Sprint within it), and the Sprint control's effect is visible immediately below in the summary
tiles, so it reads better above them than buried in the filter row. Unlike the PI select (hidden only on
Technical view, since Release Notes and Insights also read `state.selectedPi`), `switchToTab()` hides
`#sprintSelectWrap` on every view except `'product'` — `issuesInSprintScope()` is read only by Product
view's own `piWorkItemCounts()`/`renderIssues()`, nothing else. `state.selectedSprint` is either `''` (All sprints) or a literal sprint name — no
separate "current sprint" sentinel, same reason the global PI `<select>` doesn't have one either: the
current sprint is just a normal option labeled "Current sprint (name)" and preselected by default — placed
right after "All sprints" (and before Gap B's hybrid option, see below), one way to pick it, not two. `issuesInSprintScope()` applies the scope everywhere `state.jiraIssues` already gets PI-scoped —
the issue list, the Epic rollup badge (sprint-scoped same as date, deliberately *not*
Type/Priority/status-tile-scoped, matching the existing rule for that badge), and the summary tiles/PI card
(`piWorkItemCounts()`). `currentSprintNames()` resolves "right now" from `index.json`'s per-PI
`sprints[].startDate`/`endDate` (only meaningful for the org's actual `currentPi()` — a past PI has no
"current sprint" of its own); when more than one sprint is active at once (more than one board), the first
(newest-started) becomes the actual default selection — a deliberate simplification, "All sprints" stays
one click away for seeing every current sprint together. This default is (re)applied on load and on every
PI switch (`refreshSprintSelect()`, called from `initGlobalPiSelect()` alongside the Type/Priority option
refresh) — never from the "Clear" button, since sprint is a *scope* control like the PI select, not an
ordinary filter clearing back to "no restriction." An Epic typically has
no `sprint` of its own in Jira, so a specific-sprint scope quietly excludes an Epic's own row from the
list — `groupIssuesByEpic()` already tolerates a header built from a child's `epicKey`/`epicTitle` with no
`epicIssue` of its own (see above), so an in-scope child still groups correctly even when its Epic doesn't
pass this filter.

A third `#filterSprint` option — Gap B from `design-docs/PRODUCT-VIEW-NOTES.md`, implemented per
`design-docs/PRODUCT-VIEW-IMPLEMENTATION-PLAN.md`'s Phase 5 — sits between "All sprints" and the literal
sprint names: "Current sprint + unresolved" (`SPRINT_CURRENT_PLUS_UNRESOLVED`, a sentinel value chosen to
never collide with a real Jira sprint name). It keeps every item in the current sprint regardless of
status, *plus* older-sprint items in the same PI that aren't yet `released` on prod — so an Epic spanning
several sprints still shows its real completion state instead of either hiding stale unfinished work (a
plain current-sprint filter) or burying it in everything-ever-done (All sprints). This is a third,
explicit option, not a replacement for the existing default — `refreshSprintSelect()`'s default selection
is still the literal current sprint's name (or "All sprints"), never this one; a user opts into it
deliberately. Only offered at all when `currentSprintNames()` actually resolves something (a past PI has
none, by that function's own definition — the hybrid would otherwise degenerate into "every unreleased
issue in the PI," not what this option is for). Being just another value `issuesInSprintScope()` branches
on, it automatically flows through to every caller that already shares that one scope — the issue list,
the Epic rollup badge, and the summary tiles/PI card (`piWorkItemCounts()`) — with no separate wiring.

Every row (an Epic header or a regular issue) also carries a raw Jira status tag (`jiraStatusTagHtml()`) —
colored green for a "done"-ish status (`Done`, `Ready for Prod`), blue for an in-flight one (`In
Development`/`In Progress`/`In Test`), red for `Blocked` (`jiraStatusTagClass()`, matched by status text
since Jira workflow status names are project-specific, not a fixed enum). When Jira's own "Flagged"
impediment marker is set (`impediment` — independent of `status`; an issue can be "In Progress" and
flagged at the same time), that's folded into this *same* tag as `ICONS.flag` (the same SVG the "flags not
tracked" warning next to a component's name in Technical view already uses) rather than a separate badge.
A second, independent tag shows "done/total sub-tasks" (green once fully done, blue otherwise) when
the issue has sub-tasks. Both exist specifically to catch the case a bare deploy-status pill can't: code
already reached every environment (`level: 'deployed_code_only'`, since no flag is linked to confirm it),
while the issue itself is still open with unresolved sub-tasks — deployed doesn't mean done.

Each env's deploy-status pill (`statusLabel()`/`statusClass()`) also carries a `title="..."` tooltip
(`statusLabelTooltip()`) spelling out, in plain English with no "flag" jargon, what the pill's short label
actually means for a non-technical reader — e.g. "Deployed (hidden)" → "Code is deployed, but the feature
is not yet visible to users" — found and fixed as a real gap: Product view is explicitly meant to be
readable by a PO/business reader (see the Epic-grouping rationale above), but the pill labels themselves
assume the reader already knows what "hidden"/"partial" mean in this dashboard's own vocabulary. Returned
strings are fixed, developer-authored constants per status level (same set `statusLabel()` already
switches on), so — like `ICONS`/`CHART_STATUS_ORDER`'s labels elsewhere in this file — they're used as-is,
not run through `escapeHtml()`. `docs/index.html` carries a matching static `.table-legend` row above the
Product view issue list, spelling out the same five pill meanings up front in one line, with the same
per-item `title="..."` tooltips repeated on each legend entry — so a reader gets the explanation either
from a quick skim of the legend or by hovering a specific pill later, without needing both.

A row's `key` can also disagree with `status-index.json`'s cross-PI record for that same key — specifically
whenever the issue genuinely moved to a different PI since the currently-loaded shard was last written (a
backlog item carried over past its original PI's boundary). Found and fixed as a real gap: nothing
previously surfaced this, so an issue could silently look like it belongs to whichever PI's shard happened
to still list it, even after Jira itself had moved it on. `piContinuationBadge()` compares
`state.issueStatusIndex[key].pi` (built from the always-current, cross-PI `status-index.json`) against
`state.selectedPi` and, when they differ, renders an escaped "Continued in PI-X" badge next to the row's
existing sprint tag — `pi` here is real Jira-derived data (not a fixed constant), so it is `escapeHtml()`'d
like any other user/Jira-sourced string reaching `innerHTML`.

Two more row/epic-level signals, both from `design-docs/PRODUCT-VIEW-NOTES.md`'s gap analysis
(Gaps A and D), implemented per `design-docs/PRODUCT-VIEW-IMPLEMENTATION-PLAN.md`'s Phase 1/2:
`ghostFlagAge(issue, env)` flags an issue whose prod status is `deployed`/`partial` (code shipped, flag
off or only partially on) once `now - max(deployment's deployedAt, the stuck flag's last changedAt)`
crosses `GHOST_FLAG_DAYS` (30) — SAFe calls this "unconsumed value," and the threshold is in days rather
than sprints since sprint length isn't guaranteed uniform across boards. It's a per-row/per-epic
annotation only, scoped to whichever PI is currently loaded — deliberately not a cross-PI scan, matching
the rest of this architecture's "ShipScope shows current state, doesn't scan everything" rule.
`epicHasOpenBug(children)` flags an Epic header when any in-scope child is a `type: 'Bug'` not yet
`statusCategory: 'done'`, regardless of that Bug's own env/status — a Story can look fully shipped while
a sibling Bug under the same Epic is still open, which neither the per-row pills nor the epic rollup bar
surface on their own. Both use `ICONS.hourglass`/`ICONS.bug` (small inline SVGs, same convention as every
other icon in this app — see the `ICONS` object) rather than emoji, for the same reason every other badge
here does: consistent rendering across platforms/fonts instead of depending on the OS's emoji glyphs.
Both read the exact same `children` list `epicRollup()` already receives — scoped
by date/sprint, not by the Type/Priority filters or `activeStatusTile` (those only narrow the issue list
and `allIssues`, not this rollup) — so they stay consistent with whatever `epicRollup()` itself already
shows for the same epic, by construction. The `FALLBACK` dataset's `EBO-99001`/`legacyMigrationEnabled`/deployment `d21` under
`EVP-4288` exist specifically to exercise both badges together in the `file://` preview without a server.

Gap E's `#filterHideTasks` checkbox, next to the Type segmented control, is a one-click exclusion layered
on top of it rather than a 5th segmented option — `renderIssues()` applies `issue.type !== 'Task'`
alongside the existing Type/Priority/status-tile predicate, so an issue list already filtered to "Task"
via the segmented control simply ends up empty if this is also checked (the same "impossible filter
combination" behavior every other filter pairing in this view already has, no special-casing added for
it). It's an ordinary filter, not a scope control like Sprint/PI, so "Clear" resets it and a PI switch
resets it too (via the same `btnClearFilters.click()` a PI switch already triggers for every other filter).

A third tab, "Release Notes", lives in the same file and is fully enabled — `RELEASE_NOTES_ENABLED` is
hardcoded `true` (the earlier `?releaseNotes=1` query-param soft-launch gate is gone), but the on/off
*mechanism* itself (fully removing a tab from the DOM when its constant is `false`, in `initTabs()`/`init()`
— a harder cut than `PRODUCT_VIEW_ENABLED`'s shown-but-disabled pattern) is kept in place deliberately, as a
template for the next preview tab to copy. It re-derives everything from the same `state` the other two
tabs already read (no new data file, no new sync script): real, `isRealPi`-filtered
Jira issues that have actually shipped (`issueIsReleasedToProd` — `released` or `deployed_code_only` on
`prod` per `issueStatusForEnv`, i.e. genuinely visible to users, not merely deployed behind an off flag) are
grouped flatly by `pi` → `sprint` (newest first, via `compareVersionDesc` — no per-application/service
split any more; a "Service" filter over `docs/components.json`'s `application` list sits above the list
instead, narrowing which issues are considered within whichever PI the global PI selector has loaded — see
above), then split into
"Features & Improvements" vs. "Bug Fixes" sub-sections per sprint (Jira has no separate "Improvement" type,
so this only reliably splits on `Bug` vs. everything else). A PI/sprint only appears at all once it has at
least one released issue, and only its released issues are listed — unreleased siblings in the same
PI/sprint are simply invisible here, not shown as "in progress", since this tab's whole point is "what's
actually live," not a progress tracker. Because it depends entirely on real Jira data (`title`, `pi`,
`sprint`), it renders nothing useful whenever `sync-jira.js` has fallen back to deployment-derived stubs
(see "Jira issues" above) — the same underlying gap that already keeps `PRODUCT_VIEW_ENABLED` off.

Each listed item renders as two lines (`.release-note-main`), not one: the first line is the title plus a
PROD status pill (`.release-note-title-wrap`, an inline-flex span so the two wrap together rather than the
pill being pushed to a disconnected right-aligned grid column) — reusing the Technical view's own
`statusLabel()`/`statusClass()`/`statusLabelTooltip()`, not a new vocabulary. `issueIsReleasedToProd()`
folds two different real PROD states into one "is this released at all" check (`released`, a flag confirms
it's visible, vs. `deployed_code_only`, code shipped with no flag to confirm against), and without this
pill a reader here had no way to tell which of the two a given item actually was. TEST/QA pills are still
deliberately not shown — "released" already implies "live on PROD," so they'd be redundant. The second
line (`.release-note-meta`, same `joinMeta()`-joined dot-separated layout every other meta row in this file
already uses) carries the issue's Jira key, styled as the same non-clickable `<span class="tag mono">`
Product view already uses for a row's own key — one visual vocabulary for "this is a Jira key, shown as a
plain label" across both views, deliberately *not* the clickable `.issue-badge` chip Deployment History
uses for related-issue links: a Release Notes row's title is already the row's own link to Jira, so a
second, separately-clickable key right next to it would just be a redundant, confusing second link to the
same destination — followed by the date it first reached prod, via `earliestProdDeployedAt()` (the same
helper the Insights lead-time chart already uses for "when did this ship"), rendered with `fmtDateShort()`
rather than `fmtTime()`-only since, unlike Deployment History's day-grouped timeline, a Release Notes row
has no day
header to borrow a date from. Omitted entirely (not shown as a dash or placeholder) on the rare item that
has no resolvable prod deployment timestamp at all.

A fourth tab, "Insights" (`INSIGHTS_ENABLED`, gated behind `?insights=1` — the first actual reuse of the
hide-a-tab mechanism described above), holds five hand-rolled charts (no chart library, per this repo's
no-dependencies rule) that are pure rollups of data every other view already reads — zero new sync scripts,
zero new data files. Two are documented in more depth in `design-docs/FEATURES.md` → "Insights tab": stale
flags by days ON in prod (`staleFlagDaysBreakdown()` — reuses `STALE_FLAG_DAYS` purely as a color
threshold, not `flagStaleWarning()`'s full "every linked issue is Done" gate), and rollbacks/drift by month
(`rollbackDriftByMonth()` — counts `deployments.json` records carrying `rollback` or a `driftBehind` with
`commitCount`/`untestedCommitCount`, windowed to the last 12 calendar months only — a display cap, doesn't
touch `deployments.json` itself; note this is a *display* cap, not a claim that 12 months of real data
exists yet — rollback/drift detection itself only shipped 2026-09-14, so this chart's actual data depth
will keep growing for a while before it reflects a genuinely full year). A fourth chart from the same design doc (PRs per label) needs a new sync
path and isn't implemented. Three more were added later, outside that design doc, in this render order:
release status per **sprint** on PROD only and lead time both render side by side first
(`.insights-cols`, a plain 1fr/1fr grid — unlike `.cols`' 1.4fr/1fr split used for the Technical view's
deploy-history/flags pairing), then release status per **priority** stacked full-width above the two
charts already described, in the tab's normal single-column flow. Release status per sprint
(`sprintReleaseStatusBreakdown()` — stacked bar, one segment per `issueStatusForEnv(issue,'prod').level`,
with `deployed`/`deployed_code_only` sharing one "Deployed (hidden)" bucket; bucketed by
`sprintLabelFor()`'s "PI-27.3.3"-style label — PI prefix plus the trailing sprint-within-PI number, both
pulled from the raw `sprint` field — rather than by `pi`, for a finer-grained view than a plain per-PI
breakdown would give). Lead time from Jira resolution to the first successful prod deployment
(`leadTimeToProdBySprint()` — median days per sprint, same `sprintLabelFor()` bucketing as the sprint
chart next to it, only counting issues that are both resolved, have a detectable sprint, and have shipped
to prod at least once; a negative gap — code already on prod before the ticket was marked Done — is
clamped to 0 rather than shown as negative). Release status per priority (`priorityReleaseStatusBreakdown()`
— identical stacked-bar shape and `CHART_STATUS_ORDER` legend as the sprint chart, just bucketed by
`issue.priority`, sorted by this org's actual priority rank (`PRIORITY_ORDER`/`comparePriorityDesc()` —
`Blocker`/`Critical`/`Major`/`Medium`/`Minor`, not Jira's "standard" Highest/High/Medium/Low/Lowest naming,
which this instance doesn't use); issues with no priority set are excluded, not lumped into an "unknown"
bucket). The Product view Priority filter's own option order follows the same `PRIORITY_ORDER`.
