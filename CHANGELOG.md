# Changelog

*Polska wersja: [CHANGELOG.pl.md](CHANGELOG.pl.md)*

Notable changes to ShipScope, newest first. This project has no version numbers (it's an internal
dashboard, not a published package), so entries are grouped by date instead. See `README.md` for what
ShipScope is, `CLAUDE.md` for the technical reference, and `FAQ.md` for how specific numbers/badges are
calculated.

## 2026-10-15

- **Added: `server/`, a walking-skeleton backend deployed to Render.** Introduces this repo's first-ever
  third-party dependency (`pg`, the Postgres client), scoped only to `server/package.json` — the rest of the
  repo stays dependency-free. Proves the deploy pipeline only (`GET /health`, `GET /health/db`, a Postgres
  heartbeat worker); no SaaS-pivot PRD features (OAuth, GitHub App, Jira integration) are implemented yet.
  Declared in `render.yaml` at the repo root. See `context/foundation/infrastructure.md` for the platform
  decision and `context/foundation/prd.md` for what this backend will eventually implement.
- **Internal: `ENVIRONMENT` / `SERVICE_TYPE` enums replace the `'test'`/`'qa'`/`'prod'` and `'FE'`/`'BE'` string literals in `docs/app-*.js`, no behavior change.** Frozen objects in `app-core.js` with values identical to the JSON data (`ENVIRONMENT.PROD === 'prod'`); `ENVIRONMENTS` is built from them.
- **Internal: presentational markup extracted into `docs/app-components.js`, no behavior change.** The inline HTML
  that used to sit in every view (summary cards, tags, status pills, Epic/issue rows, deploy cards, flag rows, bar
  and column charts, empty states, ...) is now a set of small pure functions (`SummaryCard`, `Tag`, `StatusPill`,
  `EpicHeader`, `DeployCard`, `FlagRow`, `BarRow`, ...) that take every value as a parameter and return an `html`
  result. Views only compute data and call them, so a later move to a framework means rewriting this one file.
  Loaded right after `app-core.js`; covered by `test/app-components.test.js`.

## 2026-10-13

- **Internal: shared flag-ingest core, no behavior change.** The collision guard, `flags-meta.json` scaffolding,
  idempotent state writes and history entries that `resolve-all-flag-states.js` and `sync-runtime-be-flags.js`
  each carried a copy of now live in `scripts/lib/flag-ingest.js`, with its own tests. Groundwork for accepting
  flag values from sources other than files and URLs; proposal in `design-docs/FLAG-INGEST.pl.md`. Added `scripts/ingest-flags.js`, a validated JSON-payload adapter on top of it and a composite action `.github/actions/ingest-flags` that app repos can call from a step (opt-in; no existing workflow changed). One cosmetic
  difference: `resolve-all-flag-states.js` now prints its collision summary before the "Resolved…" line.

## 2026-10-12

- **Fixed: huge "N behind TEST" counts for components that deploy QA/PROD from `deployment/*` branches.**
  Those branches hold only trigger commits (`trigger.properties` → `version=v1.6.0`), so drift was counting git
  distance between trigger commits on parallel histories (e.g. `evapl-service-frontend`: "1135 behind test",
  though QA/PROD ran the same `v1.6.0` code). `"versionFile": "trigger.properties"` is now set in
  `docs/components.json` for all six components, so version, `resolvedRef`, `relatedIssues` and drift come from
  the tag the file names. Takes effect once `sync-main-to-live.yml` merges it to `live`; only newly synced
  deployments get corrected `version`/`relatedIssues` (older records age out via `RETENTION_DAYS`). `test`
  deploys the code commit itself (no such file), so it logs an expected warning and keeps its tag. Details:
  `design-docs/DRIFT-SAME-VERSION-DIFFERENT-SHA.md`.
- **Added: "same version, different build" drift note.** When two environments show the same version label but
  different refs, the env card renders one note ("A / B commits vs QA") instead of "A behind" plus "B skipped".
  The counts are unchanged and still feed the summary cards and Insights. Remains a safety net for components
  without `versionFile`.

## 2026-10-09

- **Internal: more refactors, no behavior change.** `sync-github-deployments.js`'s pure logic (retention, plan,
  cursor, drift) moved to `scripts/lib/deployment-records.js` with its own tests; the `html` tagged template
  (`docs/app-html.js`) now escapes every interpolated value in all views, so a forgotten `escapeHtml()` can't
  happen; `renderMatrix()` and `renderIssues()` were split into small single-purpose functions; and the
  data-mutating scripts share `scripts/lib/json-file.js` (`readJson`/`writeJson`) instead of repeating
  `JSON.parse(fs.readFileSync(...))`. `npm test` now runs 61 cases.
- **Internal: test coverage raised to ~99.8% lines / ~97% branches (~360 cases).** Every script, lib and
  `docs/app-*.js` file now has tests: top-level scripts run as child processes against fixture `fetch`/HTTP servers,
  frontend files run in a `vm` with a stub DOM. Real layout is still unverified (the stub DOM doesn't parse HTML).
- **CI: `test.yml` runs `npm test` on every pull request and on pushes to `main`.**
- **Fixed: flag flips never counted towards an issue's "last change" date.** `issueEnvDate()` read `changedAt` from
  the raw env entry instead of the resolved `build`/`runtime-be` state, so it was always `undefined` and only
  deployments moved the date. It now uses `effectiveFlagState()`, which affects the Product view date-range filter
  and anything built on `issueLastChange()`.
- **Internal: `scripts/sync-jira.js` split into modules; shared CLI helpers.** The ~2200-line script is now a thin
  orchestrator over `scripts/lib/jira-{config,pi,jql,spaces,boards,issues,shards}.js`, and the duplicated
  `fail`/`safeRelativePath` in every script moved to `scripts/lib/cli.js`. No behavior change.
- **Internal: first automated tests, and `docs/app.js` split into `docs/app-*.js`.** `npm test` runs 40 `node:test`
  cases (no dependencies) over `scripts/lib/jira-*.js`, `cli.js`, `extract-flags.js` and `flag-history.js`. The
  ~3200-line `app.js` is now eight classic `<script>` files (`app-core` … `app-main`) loaded in order by
  `index.html`; they concatenate byte-identically to the old file, so there is no behavior change, and the
  `file://` fallback still works.
- **Fixes from a script review.** `sync-github-deployments.js`: a failed `/actions/runs` lookup is now cached
  (it used to bypass the per-run lookup cap and be refetched per deployment), page dedup no longer rebuilds its
  key set per page, and a corrupt page/retry cache file is ignored instead of failing every retry.
  `backfill-flag-state-history.js`: a commit where `flag-states.json` is missing/unreadable is skipped instead of
  being diffed as "empty" (which logged every flag as flipped on the next commit). `prune-jira-pis.js` now uses
  the shared `writePrunedPis` (same order/format as the sync) so the two stop rewriting each other's file.

## 2026-10-07

- **Technical view's matrix rows now align across TEST/QA/PROD even when one row grows taller than the
  others.** `.comp-row` used a fixed `height:70px`; it's now a `min-height:70px` instead, so a row whose
  content genuinely needs more room (e.g. two stacked drift notes) can grow past it instead of clipping.
  Since each env card renders its own independent column, that growth used to desync row alignment the
  moment one env's version of a row needed more space than the others — `renderMatrix()` now measures
  every component's row across all three env cards after rendering and snaps all of them to the tallest
  one found, so a 90px QA row pulls its TEST/PROD counterparts up to 90px too, keeping the matrix lined up
  row-for-row.

- **Fixed: matrix rows that grew past 70px had no top/bottom padding.** `.comp-row` had `padding:0 12px` —
  zero vertical padding — so a row whose content grew to e.g. 78.4375px sat flush against its own edges
  with no breathing room; a taller row (e.g. 90px) only looked fine by accident, from slack borrowed via
  the row-alignment pass above rather than any padding of its own. Changed to `padding:10px 12px`; single-
  line rows are unaffected since the existing `min-height:70px` already exceeds content+padding for them.

- **The "N behind ENV" / "N commit(s) skipped ENV" drift notes in the Technical view matrix now explain
  themselves.** Each `.drift-note` carries a plain-language `title="..."` tooltip (`driftNoteTooltip()`,
  same pattern as the status-pill tooltips), and a new `.drift-legend` row above the matrix spells out both
  meanings up front. A real production case confirmed "skipped" is a genuine signal, not a false positive
  from differing release cadence: two environments displayed the same version string two minutes apart, but
  each resolved to a different commit carrying a completely non-overlapping set of Jira issues, and the
  later commit never passed through the earlier environment at any point. That worked example is documented
  in `FAQ.md` rather than shown in the UI itself — a table tied to one past deployment would go stale once
  `RETENTION_DAYS` trims that record away.

## 2026-10-06

- **`check-flags-metadata.js`/`check-flags.yml` gained a `WARN_ONLY` opt-in.** By default the "Check flag
  metadata completeness" step still fails the build (exit 1) when a discovered flag has no complete
  `flags-meta.json` entry — unchanged. Passing `WARN_ONLY: true` to the reusable `check-flags.yml` workflow
  instead logs each problem as a `::warning::` annotation and exits 0, so the step never blocks a merge.
  Meant for onboarding a new component: its first flags are incomplete by construction, and a hard CI gate
  would block merging anything until metadata catches up.

- **Release Notes rows now show a PROD status pill, the Jira key, and the first-shipped-to-prod date.**
  Each item now renders two lines: title + a PROD status pill, then the Jira key (a non-clickable
  `<span class="tag mono">`, same style Product view already uses for a row's own key — not the clickable
  `.issue-badge` chip Deployment History uses, since the title here is already the row's link to Jira) +
  the date it first reached prod (via `earliestProdDeployedAt()`, the same helper the Insights lead-time
  chart uses). The pill reuses
  the Technical view's own `statusLabel()`/`statusClass()`/`statusLabelTooltip()` helpers and folds two
  different real PROD states into one "is this released at all" check — `released` (a flag confirms the
  item is actually visible) vs. `deployed_code_only` (the code shipped, but there's no flag at all to
  confirm against) — and until now a reader here had no way to tell which of the two a given item actually
  was. TEST/QA pills are still deliberately not shown — "released" already implies "live on PROD," so
  they'd be redundant.

- **`docs/index.html` now preloads every top-level `data/*.json` file `app.js`'s `loadData()` fetches on
  startup.** `<link rel="preload" href="..." as="fetch" crossorigin>` tells the browser to start
  downloading these files while it's still parsing the `<head>`, instead of waiting for `app.js` itself
  to download, parse, and run before the first `fetch()` call fires — so by the time `loadData()` actually
  requests them, several are already in flight or complete. `crossorigin` is required even though these
  are same-origin requests: a preload only gets reused by a later `fetch()` call if the two requests'
  modes match, and `fetch()` defaults to CORS mode. The one exception is a PI's own Jira shard
  (`data/jira-issues/{pi}.json`) — which file that is isn't known until `index.json` itself comes back, so
  it can't be named in a static preload hint.

- **`sync-github-deployments.js` now also writes a small precomputed `docs/data/summary.json` — a fast
  path for the Technical view's first render.** `docs/app.js`'s `currentVersion()` (called once per
  component and once per component×environment during initial render — the summary cards and the
  component×environment matrix) used to always re-scan the entire `state.deployments` array and re-sort
  the matches, every single call. `summary.json` holds `{ components: { [component]: { [env]: { current,
  latestOverall } } } }`, built from the exact same `latestOverall`/`latestSuccess` maps `trimOldRecords()`
  already computes on every sync run (no new API calls, no new computation) — `currentVersion()` now reads
  it as an O(1) lookup and only falls back to the old full scan when a component/env is missing from it
  (a newly-onboarded component, or the file being unreachable/absent). It's a precomputed cache, not a new
  source of truth, so the dashboard degrades to exactly today's behavior whenever it's missing, and it's
  rewritten in full on every sync run the same idempotent way `deployments.json` itself already is (a run
  where nothing changed produces byte-identical output, so nothing gets committed). See `FAQ.md` for why
  this is precomputed server-side rather than computed on the fly in the browser.

- **`sync-github-deployments.js` now uses conditional (ETag) requests for the three GitHub list endpoints
  it fetches on every single run regardless of whether anything changed (`/deployments` page 1, `/tags`,
  `/releases`).** A `304 Not Modified` response doesn't count against GitHub's API rate limit the way a
  real `200` does, so a steady-state cron run across every tracked component — the common case, since most
  components have nothing new between runs — now spends far less of the shared budget.
  `scripts/lib/github-api.js`'s `githubApiRequest`/`githubApiGet` take an optional caller-owned
  `etagCache`; `orchestrate-full-sync.yml`'s `sync_deployments` job wires an `actions/cache` step (keyed by
  component, living outside both git checkouts) around a new `GITHUB_API_ETAG_CACHE_DIR` env var so the
  cache actually survives across separate workflow runs, not just within one job's own retries. Scoped
  deliberately to those three list endpoints only — the per-deployment calls (`/commits/{sha}`,
  `/compare/...`, `/deployments/{id}/statuses`, `/actions/runs/{id}`) hit URLs that are effectively
  immutable once they exist and, thanks to the sync cursor, are normally only ever fetched once in this
  script's lifetime, so there's nothing there for a cached ETag to revalidate against.

- **Investigated the open Jira Agile-API 401 question left from 2026-10-05 — ruled out URL routing,
  pointed at an Atlassian-side account/credential gap.** Per the Atlassian KB article on 401s for service
  accounts, its leading theory (classic site domain vs. the `api.atlassian.com/ex/jira/<cloudId>` proxy
  some service-account tokens require) was manually tested and ruled out: this repo's `JIRA_BASE_URL`
  already *is* the proxy form, and hitting both `project/search` and `/rest/agile/1.0/board` through that
  same URL reproduced the identical split (200 vs. 401) — so the failure is specific to the Agile API's
  own authorization, not request routing. The likely cause is now narrowed to one of two Atlassian-side
  issues, neither a bug in `sync-jira.js`: a **scoped** service-account API token that was never granted
  the separate Jira Software/Agile scopes, or the account lacking an actual Jira Software product
  role/license. `JIRA_BOARD_LOOKUP_STRICT` stays at its soft-degrade default until a Jira admin confirms/
  fixes the token or account — flipping it is a one-line env var change once that happens, not a code
  change. `ONBOARDING.md`/`ONBOARDING.pl.md` gained a troubleshooting note under the Jira account setup
  section pointing at the same KB article and a concrete check-in-order list, so a future onboarding run
  hitting this same symptom doesn't have to re-derive the diagnosis from scratch.

## 2026-10-05

- **Low-severity hardening pass: input validation, timeouts, and a drift-detection correctness fix.**
  `update-flag-state.js` now rejects `FLAG_KEY` values of `__proto__`/`constructor`/`prototype` (a
  prototype-pollution vector) and requires `ENABLED` to be exactly the string `"true"` or `"false"` instead
  of coercing anything truthy. `sync-runtime-be-flags.js`'s flag-endpoint fetch now has a configurable
  timeout (`FETCH_TIMEOUT_MS`, default 30s, via `AbortSignal.timeout()`) instead of being able to hang
  indefinitely on an unresponsive BE endpoint. Every job in every `.github/workflows/*.yml` file now
  declares `timeout-minutes` (15 for simple one-shot jobs, 30 for paginated/retry-loop/matrix jobs, 10 for
  the `main`→`live` merge) — none had one before, so a stuck step could otherwise run until GitHub's
  default 360-minute cap. `orchestrate-full-sync.yml`'s `sync_jira` job now uses `if: ${{ !cancelled() }}`
  instead of `if: always()`, so it still runs after an unrelated single-component deployment-sync failure
  (the original intent) but correctly skips when a human explicitly cancels the whole run.
  `sync-github-deployments.js`'s `computeEnvDrift()` now distinguishes "compare succeeded, no drift" from
  "compare call failed" — a transient GitHub API error used to be indistinguishable from a genuine
  all-clear, silently wiping out an existing, still-real `driftBehind` value. Two JSON writes
  (`update-flag-state.js`, both writes in `prune-jira-pis.js`) were missing the trailing newline every
  other script's writes already have; now consistent.
- **`docs/style.css` no longer has any hardcoded color literal outside its token definitions.** The
  remaining hex/rgba values scattered across selectors (status-badge borders, a hover background
  duplicated across ~10 rules, `.comp-avatar`, `.pv-pi-card`, `.pv-tile`/`.pv-filters`/`.wi-table`,
  `.wi-type`, epic/child titles, the tree-line background, `.breakdown`, the `.badge-bug`/`.badge-task`/
  `.badge-story`/`.badge-epic` set, and a handful more found during the pass — `.tab`/`.run-badge` hover
  color, `.summary-card`/`.flag-row`/`.wi-head`/`.wi-epic-row` borders, `.st-none`, `.status-date`,
  `.legend-dot.st-none`) are now CSS custom properties, following the file's existing `--nd-*`/plain `--*`
  naming convention, with dark values in `:root` and light values in `html[data-theme="light"]`. Pure
  refactor — no rendered color changed. A follow-up pass closed the remaining gap: ~20 `rgba()` tints in
  the legacy-section selectors this first pass left alone on purpose (Feature flags panel pills,
  work-item status tags, the rollback/issue badges) — e.g. `.flag-on`/`.flag-off`, `.st-released`/
  `.st-deployed`/`.st-partial`/`.st-dependency`, `.tag-status-*`, `.rollback-badge`. Most of these matched
  an existing token's dark-mode hex at a given alpha (`--fail`/`--rollback`/`--nd-ok`/`--nd-code`/
  `--nd-dependency`/`--nd-warn`/`--nd-link`), so their new variables carry a theme-recomputed light value
  — a small, deliberate rendering improvement in light mode, not byte-for-byte identical to before. The
  two with no clean match to an existing token (`--rollback-badge-bg`/`-border`, `--flag-off-bg`) keep an
  identical value in both themes, matching their original literal's behavior exactly. The literal white
  `#ECEEF1` used for the 3-bar environment-stage icon's filled bars remains the one documented, intentional
  exception.
- **Security hardening pass.** `docs/app.js`'s `renderDeployGroupCard()` rendered a deployment's
  `deployedBy` display name straight into `innerHTML` with no escaping — a genuine stored-XSS gap, since
  that name is attacker-influenceable (a GitHub profile display name), unlike the already-escaped
  `renderDeployCard()` right next to it. Jira issue keys were escaped in some render paths (issue rows,
  epic headers) but not others (deploy-card issue chips, Release Notes rows); now consistent everywhere,
  including inside `href` attributes. `check-flags.yml` and `retrigger-app-checks.yml` now declare an
  explicit `permissions: contents: read` block (every write in both already goes through a separate
  GitHub App token). `notify-deployment.yml`'s `deployment-completed` dispatch now builds its JSON payload
  with `jq -n --arg` instead of manual shell string interpolation.
- **Deployment sync now actually converges on a large backlog, instead of re-fetching and re-processing
  it forever.** `sync-github-deployments.js` permanently skips (with a loud warning) a deployment stuck
  without a terminal status for more than `STUCK_DEPLOYMENT_MAX_AGE_HOURS` (default 48h) — previously, one
  abandoned pipeline could cap the sync cursor below it forever, forcing every newer deployment to be
  re-fetched and re-processed at real API cost on every future run, even though it was already written and
  just got deduped at write time. Pagination of `/deployments` now stops as soon as it reaches
  already-synced IDs instead of always walking the whole history, and a new `MAX_NEW_DEPLOYMENTS_PER_RUN`
  (default 200) caps how many new deployments one run resolves — oldest-first, so a capped run still makes
  forward progress, and the cursor only ever advances past what this run actually finished.
- **Shared rate-limit retry helpers.** `scripts/lib/github-api.js` and `scripts/lib/jira-api.js` extract
  the 429/secondary-rate-limit backoff logic that previously only existed, inconsistently, inside
  `sync-github-deployments.js`. Now also used by `backfill-deployment-metadata.js` (which had no
  rate-limit handling at all before this, despite running bursty per-record API calls) and by
  `retrigger-app-checks.js`/`sync-jira.js`.
- **Smaller correctness fixes.** `backfill-deployment-metadata.js`'s `version` backfill now also sets
  `resolvedRef`, so a later sync's `/compare` call never uses an unverified ref; its own status resolution
  now finds the first *terminal* status instead of blindly taking the newest one (which can be a
  non-terminal `inactive` marker). `update-flag-state.js` now preserves an existing record's `component`
  field instead of dropping it, which was quietly defeating the cross-component collision guard other
  scripts rely on. `sync-jira.js`'s `status-index.json` now keeps the *first* (newest-PI) sighting of a
  key across shards instead of letting whichever PI happens to be processed last win. `check-flags.yml`'s
  `STATUS_REPO_EDIT_URL` now points at `live` (where `flags-meta.json` has real content) instead of stale
  `main` data.
- **Fixed a real data-loss bug: a quiet gap between sprints could wipe most of a PI's issues.** When no
  configured board had an active sprint — a normal gap between sprints, or a typo in a board name — the
  default sync fell back to a narrow, commit-referenced-issues-only scan, and that result *fully replaced*
  the existing PI shard instead of merging into it, discarding every issue not referenced by a recent
  commit. Fixed two ways: the current PI is now also resolved from the nearest upcoming sprint, or failing
  that the most recently closed one (sprint data already fetched for this, no new API calls), which closes
  most of the gap on its own; and the one remaining fallback path now merges into the existing shard by
  issue key instead of replacing it outright.
- **`docs/jira-spaces.json` config mistakes that silently disabled team-scoping now get caught.** A
  malformed entry (a field of the wrong type) now throws a clear error naming the space and the problem,
  instead of silently applying zero filtering. An entry with an empty `boards` array and no `teams` now
  logs a warning for the same reason.
- **Fixed two team-scoping gaps running in opposite directions: a correct item could be excluded, and a
  wrong one could leak in.** A matching sprint from a team's own configured board no longer gets
  overridden by an unrelated, non-matching Jira `Team` field value (now checked across every value when the
  field holds more than one) — previously an issue sitting in the team's own active sprint could still be
  dropped over a stray Team field. Conversely, an issue reaching a boarded space's results only through a
  shared `PI-X.Y` label — with no matching sprint and no Team/label evidence at all — is now excluded
  instead of passing through unfiltered (an Epic with at least one in-scope child is still kept, so its
  header doesn't disappear). Board-name sprint matching also now requires a word boundary, so a board
  named e.g. "Spark" no longer matches a sprint named "Sparkle 27.3.1".
- **A space configured only with `teams` (no `boards`) is now actually covered by the everyday sync**, not
  just by manual backfills — once the current PI is resolved from other spaces' boards, each `teams`-only
  space is now also queried for that PI.
- **Product view's status pills gained plain-language tooltips, and a legend**, so a non-technical reader
  doesn't need to already know this dashboard's own vocabulary for "hidden"/"partial"/"deployed code only"
  to understand what a pill means. A row whose issue has since moved to a different PI (per the
  always-current `status-index.json`) now shows a "Continued in PI-X" badge, so a status frozen from an
  older sync isn't mistaken for current.

## 2026-09-30 to 2026-10-02

- **Jira sync re-architected around "show the current, real state — not a historical archive."**
  Previously the default sync merged "what changed recently" across a whole project, which meant an issue
  that moved out of its PI could become a permanent "ghost" if the merge logic ever missed it. The default
  run now does a **full replace** of only the resolved current PI's shard
  (`docs/data/jira-issues/{PI}.json`) on every run — a moved-out issue is simply absent from the new fetch
  result, no separate cleanup step needed. Any other PI is now explicitly a point-in-time snapshot, seeded
  only by the manual `backfill-jira-issues.yml` workflow, never auto-refreshed. `resolveSpacesConfig()` now
  **throws** on a failed Jira project-list fetch instead of silently degrading — that silent degrade used
  to route a transient Jira error into the destructive whole-rewrite scope, wiping every PI shard;
  `writePiShards()` also now refuses to delete existing shards if a `'full'`-scope run resolves zero PIs
  while two or more already exist on disk, logging a warning instead. New
  `docs/data/jira-issues/status-index.json` (a flat, cross-PI `key -> {pi, statusCategory}` map, rebuilt in
  full every run) lets the Technical view's Flags panel resolve an issue's status regardless of which
  single PI happens to be loaded into Product view. `extractPiFromLabel()` now also accepts the
  sprint-suffixed `PI-27.3.1` label form, not just `PI-27.3`.
- **Deployment history now has a retention window instead of growing forever.**
  `sync-github-deployments.js` physically trims `deployments.json` to the last `RETENTION_DAYS` (default
  90), except the single latest and single latest-successful record per component/environment, which are
  kept regardless of age so "current version"/drift/rollback detection never breaks. A new, never-trimmed
  `docs/data/deployments-cursor.json` tracks the highest deployment ID ever synced per component, so a
  trimmed-away deployment doesn't look "new" again on a future run and re-pay its full API cost. Also
  fixed: a deployment's `inactive` GitHub status (appended once a later deploy on the same environment
  succeeds) could mask its own real outcome and make it vanish from `deployments.json` entirely;
  `mapEnvironment()` could miscategorize `preprod`/`pre-prod` as `prod` via a loose substring match;
  GitHub's 250-commit compare cap now logs a warning instead of silently dropping related issues past it.
- **Technical view's Deployment History panel defaults to "Last 90 days"**, with "Last 30/60 days" and
  "All time" also selectable — a display-only filter independent of (but matching, by default) the
  server-side retention window above.
- **Product view: a new Sprint scope control**, placed next to the global PI selector in the header (shown
  only on Product view, since Release Notes/Insights don't read it) rather than mixed into the ordinary
  Type/Priority/date filter row. Narrows the loaded PI down to one sprint, or back to "All sprints";
  defaults to whichever sprint covers *today*, labeled "Current sprint (name)" — not a separate
  `(current)`-suffixed duplicate, after a reported bug where both appeared as distinct options. A third
  option, "Current sprint + unresolved", shows the current sprint's items regardless of status plus
  older-sprint items in the same PI that aren't yet released — a hybrid scope recommended during a Product
  view design review, additive to (not replacing) the default.
- **Four new Product view signals from the same design review:** a "ghost flag" aging alert (⏳,
  `GHOST_FLAG_DAYS = 30`) on any work item deployed to prod with its flag still off/partial past the
  threshold, scoped to whichever PI/epic is visible, no cross-PI scan; a "🐞 open bug" epic-header badge
  when any in-scope child is an unresolved Bug; a "Hide Tasks" toggle, independent of the existing Type
  filter; and work items inside an expanded Epic (and "Ungrouped") now sort Bug → Story → Task, matching
  the Type filter's own option order. Both new badges use inline SVG icons (`ICONS.hourglass`/`ICONS.bug`),
  consistent with every other icon in the app, not emoji.
- **The PI badge was removed from every Product view row/Epic header** — shown only once now, in the
  header's PI `<select>`, instead of being repeated on every row.
- **New one-off script, `prune-jira-pis.js`** (`prune-jira-pis.yml`, manual): permanently deletes named PI
  shard(s) and their `index.json` entries. PI shards otherwise accumulate indefinitely by design (same
  "cheap enough to just keep everything" spirit as `flag-state-history.json`) — this is the only way an old
  one is ever removed, and it refuses to delete whichever PI is currently `currentPi`.
- **Workflow security hardening.** Every data-mutating workflow now checks out `main` (code) and `live`
  (data) into separate paths, so `live` — continuously bot-mutated, and reachable by every app repo's
  shared `SHIPSCOPE_APP` credential — can never be a source of *executable* code; several workflows
  previously ran scripts straight off `live`. `.github/actions/sync-with-retry`'s inputs other than `run`
  itself now go through `env:` + `"$VAR"` instead of direct `${{ }}` interpolation into the shell script,
  closing a shell-injection path via `workflow_dispatch` free-text inputs. `notify-deployment.yml` now also
  validates that the dispatching repository actually matches the `component` name it claims.
- **Documentation:** `ONBOARDING.md`/`.pl.md` gained a new "ShipScope-level prerequisites" section (the
  GitHub Apps, Jira account/token, and permissions needed before any component can be onboarded at all)
  ahead of the existing per-component checklist. `FAQ.md`/`.pl.md` gained two new entries on exactly how
  Jira/deployment data is split into files, synced, and how long it takes for a change to become visible.
  `design-docs/PRODUCT-VIEW-NOTES.md`/`.pl.md` and `design-docs/PRODUCT-VIEW-IMPLEMENTATION-PLAN.md`/`.pl.md`
  added — a gap analysis and phased implementation plan synthesizing a SAFe PM/PO ideation session against
  Product view's current design.
- **Fixed a real production incident: a correctly-computed Jira sync could still fail to commit.**
  `.github/actions/sync-with-retry`'s `git add $SWR_PATHS` added every configured path in one call — if
  any single one of them didn't exist on disk *and* had never been tracked by git (confirmed: a legacy
  `docs/data/jira-issues.json` cleanup path that, on `live`, had simply never existed), `git add` fails
  with "did not match any files" and stages **nothing at all**, including every other, valid path in the
  same call — silently losing an otherwise-successful sync's commit. Now adds paths one at a time,
  skipping only the ones that neither exist nor are tracked, while still correctly staging a real
  deletion of something that *was* tracked.
- **Fixed a cross-team data leak: another team's Epic could show up on the dashboard.** Found in
  production — "Unified reimbursement front-end application" (a different team's Epic) was syncing in
  under the right PI number, because Epics usually have no Sprint field at all (their PI comes from a
  label instead), so the board-name sprint check added earlier in this window never even ran for them,
  and the whole ART shares one PI numbering scheme regardless of team. Added a second, independent
  check against Jira's own `Team` field (resolved by field name, same technique as `Flagged`, since
  neither has a stable `schema.custom` type): when an issue's `Team` is populated and doesn't match its
  space's configured board/team name(s), it's dropped entirely, regardless of what the sprint-name check
  concluded. An empty Team field, or an instance without one, changes nothing — purely additive.
- **Fixed the Priority filter sorting into the wrong order.** `PRIORITY_ORDER` was Jira's "standard"
  Highest/High/Medium/Low/Lowest naming, which this Jira instance doesn't actually use — every real
  priority value was falling through to the alphabetical fallback instead of a real rank. Corrected to
  this org's actual scheme (Blocker, Critical, Major, Medium, Minor), fixing both the Priority filter's
  option order and the Insights "release status per priority" chart's bar order (same constant, shared by
  both).
- **Three small Product/Release Notes view fixes.** The work-item Type filter on the Release Notes tab now
  follows the same Epic/Bug/Story/Task order as Product view's own Type filter, instead of a plain
  alphabetical sort. The Product view table's reserved `min-height` no longer applies once there are real
  results — only kept for the empty state, so a short result set doesn't leave padded blank space below
  it. Release Notes' own empty-state messages now also carry the `.panel` class (every other `.empty` use
  already sits inside a panel-styled container; Release Notes' didn't, so it rendered as unstyled bare
  text).
- **Fixed the "flags not tracked" warning icon getting hidden behind a long component name.** The
  Technical view's component name and its trailing warning icon used to share one `text-overflow:
  ellipsis` block, so a sufficiently long name could clip the icon away along with the overflow — now only
  the name text itself truncates (`flex:none` on the icon), so the warning — an important, easy-to-miss
  signal — always stays visible.
- **Epics can now show an explicit "Fully released" badge.** Previously an Epic's "every child released"
  state was only visible as the rollup progress bar reaching 100% fill; added a binary, green badge next
  to the Epic's own status tag for the same condition. Deliberately *not* extended to a Story's own
  sub-tasks the same way — see `design-docs/PRODUCT-VIEW-NOTES.md`'s "Decided and implemented" section for
  why conflating a Story's flag/deploy status with its sub-tasks' Jira completion would misrepresent
  features that are genuinely already live.
- **Fixed a recurring bug: a pruned PI kept coming back.** The "cross-team Epic" fix above only ever
  acted on *that run's* fetch — nothing remembered a PI that had been deliberately removed by
  `prune-jira-pis.js`, so the very next run that fell back to the broad, unscoped scan (see below) could
  rediscover and rewrite it. Added a persistent, never-trimmed `docs/data/jira-issues/pruned-pis.json`
  that `writePiShards()` checks on every call, in every scope — a pruned PI stays excluded regardless of
  how it resurfaces, and the only way back is naming it explicitly in a `BACKFILL_PIS` run (which un-prunes
  it on purpose). A follow-up review of this exact fix caught two follow-on bugs, both fixed in the same
  pass: the `'full'`-scope "delete anything not in this run's result" step
  wasn't protecting `pruned-pis.json`/`status-index.json` as infrastructure, so it deleted the exclusion
  list on its own very next fallback run, self-defeating after exactly one use; and `runCurrentPiMode()`
  (the default sync) lacked the same post-fetch PI filter `runBackfillMode()` already had, so a
  coincidental substring match in the current-PI query could silently overwrite an unrelated,
  already-backfilled PI's shard.
- **Root-caused why that fallback scan ran at all: an auth/outage failure was being treated as "found
  nothing."** `resolveBoardId()`/`fetchActiveSprintNames()` used to degrade a `401`/`403`/`5xx` from Jira's
  Agile API exactly the same way as a board that's genuinely not found — both just logged a warning and
  moved on. Since that routes `main()` into the destructive, unscoped `'full'`-scope fallback (the same one
  the PI-pruning fix above exists to contain), a transient auth/outage problem could trigger a cross-team
  leak on every affected run, not just once. New `JiraBoardLookupError` is thrown instead and deliberately
  *not* swallowed by either `try/catch` layer above it, so the whole sync fails loud for `sync-with-retry`'s
  retry loop (or the cron safety net) to recover from transparently — same reasoning
  `resolveSpacesConfig()`'s own un-caught project-list fetch already established. A follow-up review found
  this first version still only covered `401`/`403`/`5xx`, silently degrading a `429` (rate limit) or any
  raw network exception (`fetch()` itself throwing — timeout, DNS failure) into the exact same destructive
  path; widened so any non-2xx response *or* a thrown network error throws `JiraBoardLookupError`, closing
  that gap too. The first time this actually fired in production, the failure turned out to be a `401` on
  the Agile API specifically, with the same credentials having just resolved the project list moments
  earlier in the same run — not an obviously-expired token, more likely a missing Jira Software license/
  board permission, a scoped API-token gap, or a transient Atlassian issue, none of which a retry alone
  reliably fixes. Throwing is now opt-in behind `JIRA_BOARD_LOOKUP_STRICT` (default off, soft-degrade); the
  default path was also tightened so it no longer treats every degraded lookup the same way — `main()` only
  falls back to the destructive, unscoped `'full'` scope when a space has no `boards` configured at all
  (nothing to lose), and uses the upsert-only fallback scope instead whenever boards were configured but
  this run's lookup simply failed or found nothing, so a transient hiccup can no longer wipe an existing PI
  shard.
- **A follow-up, end-to-end re-check of "Product view shows only one team's work items" found and fixed
  five more team-scoping gaps.** When an issue's sprint
  didn't match its space's configured board *and* its Team field was empty (common — not every issue type
  gets it filled in), it fell through to a label-based PI match with zero team evidence at all; a Jira
  *label* matching the same configured board/team name now counts as an equally valid signal (in practice,
  often the only one actually set), and — specifically for a space with no board of its own at all (a
  project genuinely shared across more than one team, with nothing to configure a `boards` entry for) — an
  issue with *neither* a matching Team field *nor* a matching label is now dropped instead of passing
  through unfiltered. `docs/jira-spaces.json` gained a `teams` field, independent of `boards`, as the
  config for exactly that case (set to `["Sparks"]` for "eMobility - EV Product"). Separately: the
  deployment-derived fallback stubs used when Jira is fully unreachable weren't scoped by the allowed
  project-key allowlist at all, and carried a truthy placeholder PI (`'—'`) that silently defeated the
  "resolved zero PIs → refuse to delete real data" safety net from two entries up — both fixed, so a Jira
  outage can no longer surface unscoped cross-team keys *or* wipe real PI shards in the same stroke.
- **A broader bug sweep across the sync/flag/deployment scripts turned up and fixed nine more issues,
  none of them team-scoping-related.** `sync-github-deployments.js`'s sync cursor could advance past a
  deployment that didn't have a terminal status yet, permanently excluding it from every future sync even
  after it later resolved to a real success/failure; its GitHub `/compare` ref now only ever uses a
  verified release/tag or the SHA, never an unverified commit-message regex match that risked a 404 or a
  wrong match; a resumed paginated fetch (after a rate-limit retry) is now deduped by id/name, closing a
  narrow double-counting window; and a new, never-trimmed `docs/data/issue-deployments.json` preserves
  `deployedAt`/`commitUrl` per issue/env/component forever, so release-status/Release Notes/lead-time no
  longer silently revert an issue to "not deployed" once its only supporting `deployments.json` record ages
  out past `RETENTION_DAYS` (self-backfills from each component's current records on every sync, no
  separate migration needed). `resolve-all-flag-states.js`/`sync-runtime-be-flags.js` now detect a
  same-source, cross-component flag-name collision (two unrelated components discovering a flag with the
  same literal name) and refuse the write with a loud `::error::` instead of silently letting the second
  one overwrite the first's state; `check-flags.yml` no longer writes to `live` when triggered by a
  `pull_request` (it used to, from any caller that wired it up that way); `fill-flag-metadata.yml` now
  pushes with a real GitHub App token instead of the default `GITHUB_TOKEN`, whose pushes silently never
  fire another workflow's own trigger — so `retrigger-app-checks.yml` was never actually running after a
  manual metadata fill; and that workflow is now a matrix over every component with `featureFlagsIncluded:
  true` instead of one hardcoded repo, so a second onboarded component's stuck check wasn't being
  retriggered at all. `update-flag-state.js` is now idempotent (a retried/duplicate `flag-changed` dispatch
  for an already-current value is a no-op, not a fake logged flip) and reads its data paths from env vars
  like every sibling script instead of a hardcoded path. `backfill-deployment-metadata.js`'s own duration
  calculation now excludes GitHub's `inactive` status the same way the live sync script already does.
  `backfill-flag-state-history.js` now dedupes by calendar day instead of an exact timestamp, since the
  same real flip gets a different exact timestamp depending on whether live logging or this script recorded
  it, which let a backfill re-run over an already-covered period silently create duplicates. Finally,
  `docs/app.js` had inconsistent HTML escaping across several render paths (component/version/
  dependencyNote/changedBy/a rollback's `toRef`) — some already escaped, some not, including inside a
  `title="..."` attribute — now consistent everywhere a field doesn't originate as a fixed,
  developer-authored constant; and the global PI `<select>`'s change handler had a real race where switching PIs
  twice in quick succession could let a slower, stale fetch silently overwrite state set by a faster, newer
  one, fixed with a "latest request wins" guard.

## 2026-09-29

- **Product view now shows every work item planned for the current PI, not just what's already deployed.**
  Previously `sync-jira.js` only ever synced issues already referenced by a deployment's commit message —
  an issue with no code shipped yet (or whose flag isn't tracked) never appeared at all, so Product view
  could only ever answer "what's deployed," never "what's planned." `docs/jira-spaces.json` entries can now
  carry a `boards` array; for each configured board, `sync-jira.js` resolves it to a Jira Agile board ID,
  reads its active sprint, and derives the PI from the sprint name (the same `PI-\d+\.\d+` convention used
  everywhere else), then runs one additional, low-cost JQL query scoped to just that PI
  (`project = X AND (sprint ~ "27.3" OR labels = "PI-27.3")`) instead of syncing the whole project. Results
  merge into the existing deploy-referenced issue set, deduped by key. Every step of this — board lookup,
  active-sprint lookup, the supplemental fetch itself — degrades to a warning and falls back to the
  pre-existing behavior rather than failing the sync, since it's additive/best-effort on top of the
  already-working default path.
- **Epic "N/M released to PROD" badge was disagreeing with the Product view summary tiles for the same PI.**
  The badge counted a child issue as "released" via `issueIsReleasedToProd()`, which also counts
  `deployed_code_only` (code shipped, no flag to confirm against) — a broader definition than the tiles use
  (`prodStatusBucket()`, which buckets that case as "Code deployed", not "Released"). Fixed `epicRollup()`
  to use the same strict definition as the tiles, so the two numbers on the same screen can no longer
  contradict each other.
- **Jira status made visible on every Product view row (issue and Epic).** A Story could show "Code
  deployed" on every environment while its own Jira ticket was still "In Test" with open sub-tasks —
  nothing on screen said so. Every row now carries its raw Jira status as a colored tag (green for
  `Done`/`Ready for Prod`, blue for `In Development`/`In Progress`/`In Test`, red for `Blocked`), plus two
  more signals when the data has them: Jira's own "Flagged" impediment marker (folded into the same tag —
  as the same flag SVG the Technical view's "flags not tracked" warning already used — rather than a
  separate badge, and more robust than matching status text alone, since not every project has a status
  literally named "Blocked"), and a "done/total sub-tasks" ratio (green once fully done, blue otherwise).
  `sync-jira.js` now also pulls `priority`, `created`, and `resolutiondate` per issue.
- **New Product view filter: Priority** (a `<select>`, placed right after the work-item type filter), and
  three new Insights charts: release status per **sprint** (replacing the old per-PI chart, with a finer
  "PI-27.3.3"-style label), release status per **priority**, and **lead time: Done → PROD** (median days
  from Jira resolution to the first successful prod deployment, per sprint) — the sprint and lead-time
  charts render side by side.
- **Rollbacks & drift chart capped to the last 12 months** (previously unbounded, so it only ever grew);
  its month/year axis labels switched to `en-US` (a deliberate exception to the rest of the app's `pl-PL`
  dates).
- Release Notes panel no longer reserves its full calculated height when there's only a handful of
  results — it was using a fixed `height` instead of `max-height`, leaving empty space below short result
  sets. `.panel-head h2` font size unified to `var(--text-lg)`.

## 2026-09-23 to 2026-09-28

- **Product view tab revealed** (`PRODUCT_VIEW_ENABLED` flipped on) — Technical view stays the default
  landing tab for now (`DEFAULT_VIEW`), but Product view is clickable instead of disabled.
- **Several real Jira sync bugs fixed**, found while getting Product view working against this org's real
  Jira instance: the project-key lookup's `keys` query param was comma-joined instead of Jira's actual
  repeated-`keys=` format (so it always came back "not found"); the Sprint custom field was matched by its
  display name instead of `schema.custom` (breaks if an admin renames or localizes it); `nextPageToken`
  requests dropped the `jql` param Jira ties the token to, breaking pagination past page 1; and API
  responses came back localized to the authenticating account's Jira profile language, so translated
  issue-type names silently failed to match `TYPE_MAP` and dropped every issue to the fallback-stub path —
  fixed by forcing `Accept-Language: en-US`.
- **Release Notes graduated from its `?releaseNotes=1` soft launch to fully enabled**, and simplified to a
  single flat panel (dropped the per-service split it used to have).
- **Insights tab introduced**, gated behind `?insights=1`: three hand-rolled charts (no chart library) —
  release status per PI on PROD, stale flags by days ON in prod, and rollbacks/drift by month.
- **Product view redesigned to group by Epic** (`groupIssuesByEpic()`) instead of a flat issue list, with
  expand/collapse per Epic group — so a PO can answer "where did Epic/Story/Task/Bug X land" without an
  Epic's own row misleadingly showing "Not deployed" next to its already-shipped children.
- Several rounds of visual/design polish across Product view and Technical view (component × environment
  matrix, deployment timeline), including condensing the header's "Last sync" tag into a compact
  "synced HH:MM" text inside a status badge.

## 2026-09-22

- **Retry-safe commit/push for every data-mutating workflow.**

  **How it worked before:** every workflow that writes to `docs/data/*.json` on `live`
  (`orchestrate-full-sync.yml`, `sync-runtime-be-flags.yml`, `update-flag-state.yml`, `fill-flag-metadata.yml`,
  `check-flags.yml`, `backfill-deployment-metadata.yml`, `backfill-flag-state-history.yml`,
  `sync-main-to-live.yml`) shared one `concurrency: { group: shipscope-live-write, cancel-in-progress: false }`
  block, and their "commit and push" steps were a plain `git add ... && git commit ... && git push` with no
  fetch/rebase/retry at all. The shared group's whole job was to guarantee only one of them ever pushed to
  `live` at a time, since a second concurrent push would just fail outright (non-fast-forward).

  **Why this changed:** that guarantee had a real, reproducible failure mode. GitHub Actions only keeps
  *one pending run* per concurrency group — `cancel-in-progress: false` correctly avoids killing the run
  already *executing*, but if a manual `orchestrate-full-sync.yml` run was in progress and a real deployment
  fired `repository_dispatch: deployment-completed` on the same workflow, that second run just became the
  one pending run. If any *third* event on the same group arrived before it got its turn, GitHub silently
  cancelled it in favor of the newest one — with no error, no log entry, nothing queued to retry. A
  legitimate, deploy-triggered sync could simply vanish. This was diagnosed and confirmed in this exact
  scenario (manual full sync running, a real deployment's sync never executing).

  **What this fixes:** removed the shared `concurrency:` group entirely (it's what caused the
  cross-run cancellation) and replaced the unsafe "just push" pattern with a real retry loop — a new
  composite action, `.github/actions/sync-with-retry`, used by every "commit and push" step. On a rejected
  push, it re-runs the *sync command itself* (not just the push) against a freshly-fetched `live` and tries
  again, up to 5 times. This is safe — not just "retry until it works" — specifically because every script
  here already does a full read-existing-JSON → merge-in-the-change → write-back-the-whole-file cycle rather
  than a line-level append; naively retrying an already-computed `git rebase` of that diff onto a newer
  version of the same file would risk a hard conflict or a silently discarded change, so the fix redoes the
  computation itself against current data instead, which naturally incorporates whatever the other run
  already pushed. `check-flags.yml` (two repos checked out in one job, so the script's cwd and the git
  repo's cwd differ) and `sync-main-to-live.yml` (a `git merge`, not a script run) got a bespoke version of
  the same retry loop instead of the shared action, since their shape doesn't fit it. Verified with a local
  git simulation of the exact race (two clones pushing conflicting changes to the same file) before
  merging — both changes survived, with no conflict and no data loss. See `CLAUDE.md` → the `main`/`live`
  section for the current-state description of this mechanism.

- **Follow-up fix, found the same day in production: retries were re-fetching from GitHub's API on every
  attempt, and exhausted the rate limit.** The retry loop above is only cheap to redo for the
  merge-into-`live` part. `sync-github-deployments.js` also does one GitHub API call per *new* deployment
  (plus more per-deployment calls) — for a newly-onboarded component with a large pre-existing backlog
  (3322 deployments, 3022 new), a single run already does thousands of calls, and every losing-push retry
  redid the *entire* fetch from scratch, since a failed push always resets local state back to whatever
  `live` still has for that component. Three attempts in one run meant roughly three times the API calls,
  which is what actually hit the limit — confirmed directly from that run's own log. Added
  `scripts/lib/retry-cache.js` (`loadOrCompute`): caches the expensive fetch-and-resolve result in a
  per-job temp file (`RUNNER_TEMP`, cleaned up automatically by GitHub Actions) so a retry within the same
  job reuses it instead of re-fetching, while the merge-with-fresh-`live` step still always re-reads and
  re-deduplicates against current data before writing. Applied to `sync-github-deployments.js` (confirmed
  broken) and `sync-jira.js` (same shape, lower risk since it's already scoped to specific referenced
  issues, cached by a hash of its resolved JQL so a genuinely different query still fetches fresh).
  `backfill-deployment-metadata.js` wasn't refactored the same way — it mutates existing records in place
  across several capped phases, doesn't fit the same cache shape, and only runs on manual
  `workflow_dispatch`, so the same race is far less likely — its retry cap was just lowered to 2 attempts
  instead to bound the cost if it ever does happen.

- **Rate-limit backoff and resumable deployment-listing pagination, for the case the cache above doesn't
  cover: hitting the limit on a job's very first attempt, not a retry.** This can happen when several
  components' jobs in the same matrix share one installation token's quota, and an earlier job already
  used part of it before this one even started. `githubApi` in `sync-github-deployments.js` now retries on
  a `429`, or a `403` with `x-ratelimit-remaining: 0`, sleeping until `x-ratelimit-reset` (capped at 10
  minutes) instead of failing immediately. `githubApiAllPages` can also now persist already-fetched pages
  to `RUNNER_TEMP` as it goes (wired up for the `/deployments` listing, keyed per component), so if a later
  page still fails once those retries are exhausted, the next attempt of the same job resumes from the last
  cached page instead of re-fetching from page 1. An automated security review flagged that this new cache
  key, like the existing one in `retry-cache.js`, was built into a filesystem path with no sanitization —
  both now strip anything but alphanumerics/`.`/`_`/`-` from the key first. Also updated the deprecated
  `app-id` input on `actions/create-github-app-token@v3` to `client-id` across all five workflows that use
  it.

- **"Last sync" indicator next to the `source: data/*.json (live)` tag.** The tag only ever confirmed the
  data files loaded, not that they were recently or completely updated — and the per-component
  `repository_dispatch` that normally triggers a fast sync can silently never fire at all, if the deploying
  app repo's own workflow file, on whichever branch triggered that particular deploy, never received the
  step that calls it (see the `main`/`live` branch model in `CLAUDE.md`). The daily cron safety net still
  covers that gap, just with up to a 24-hour delay, and previously nothing on the dashboard reflected that a
  delay had even happened. `orchestrate-full-sync.yml`'s `prepare` job now marks whether a given run is
  syncing every tracked component (cron/manual/unknown-dispatch) rather than just the one component named in
  a dispatch; a new `record-full-sync.js` script, run only on that branch via a new `record_full_sync` job,
  stamps `docs/data/sync-meta.json` with the current time once every component's deployments plus Jira have
  synced successfully. `docs/app.js` renders it as "Last sync: &lt;date&gt;" beneath the data-source tag.

## 2026-09-21

- **Release notes: "fully released" date + clearer empty state.** Each "Fully released to PROD" badge now
  shows *when* — the later of the deployment that shipped the last issue in the group and the moment its
  flag was turned on. The empty state now distinguishes "no issues synced at all" from "issues synced, but
  every one is a commit-derived fallback stub" (with a pointer to the FAQ entry explaining why), instead of
  one generic message for both.
- **Jira sync: fixed two real bugs found while diagnosing why Release Notes stayed empty on `live`.**
  1. `sync-jira.js` derived a candidate Jira project key from *any* `XXX-123`-shaped string in a commit
     message; one false positive (a non-Jira ticket ID, a typo) inside `project in (...)` failed the whole
     JQL query and silently zeroed out every project's results, not just the bad one's. Added
     `filterExistingProjectKeys()` to check every candidate against Jira's own, visible project list first.
  2. The default search also scoped to *whole projects*, so one ticket mentioned once in a commit pulled in
     every other, unrelated ticket from that project. Changed the default to `key in (...)`, scoped to
     exactly the issue keys referenced in synced commits (`JIRA_PROJECT_KEY` remains as an explicit opt-in
     for the old, whole-project behavior). Also fixed the PI regex/label match to accept this org's real
     `PI-27.1` (hyphenated) format — it previously only matched `PI27.4`-style, so every real PI was being
     silently rejected regardless of the above.
- **Sprint level in Release Notes.** `sync-jira.js` now also stores the raw Jira Sprint field value
  (`sprint`) alongside the PI derived from it — a PI usually spans several sprints. The Release Notes tab
  nests sprint groups inside their PI, each with its own independent "Fully released to PROD"/"In progress"
  rollup.
- **`evboweb-service-frontend` added to `docs/components.json`.**
- **Release Notes tab**, gated behind `?releaseNotes=1` in the URL (a deliberate soft-launch, not shown to
  anyone who doesn't already know to ask for it, while it's still being validated against real data).
  Groups Jira issues by **application** → PI → sprint instead of just PI — `application` is a new,
  nullable **array** field on `docs/components.json` entries (an array, not a single string, so a component
  shared by more than one application, e.g. a common BFF, surfaces its issues under all of them). Computes
  entirely client-side from data `docs/app.js` already loads — no new data file, no new sync script, no
  Slack integration.

## 2026-09-15 to 2026-09-18

- Component definitions extended (onboarding order, descriptions), design unification pass across sections,
  warnings/pluralization cleanup, flag-resolving gap fix, font-weight fix on the flag type badge, `host` and
  `sim-adapter` added to tracked components, component config simplified.

## 2026-09-14

- Feature flag state history (who changed a flag and when) added, with an author on each entry.
- Rollback detection and badge added; backfill script updated to compute historic rollback and resolve
  versions in release-tag-commit order.
- `backfill-flag-state-history` workflow added (mines `live`'s own git history to seed the history log with
  flips that predate it).
- `sync-runtime-be-flags` loosened to match `orchestrate-full-sync`'s triggering; service filter and
  duration/status layout added; flags list sorted A–Z; project description and architecture notes added.

## 2026-09-08 to 2026-09-11

- Product view fallback for when Jira can't be reached; script structure and README updated.
- Workflow runs optimized; fallback view and orchestrator schedule fixed.
- Links to workflow run logs, deployment duration, manual-deploy marker, commit drift info, and commit
  compare links added.
- Backfill script added to bring historic deployment records up to date with newer fields.
- Section alignment fixes; Jira status/blast-radius/hotfix-visibility improvements; flag-state-change info
  added.

## 2026-08-11 to 2026-08-14

- Initial scripts, workflows, and dashboard (`docs/`) added. Jira sync script and the `main` → `live` sync
  workflow introduced. Backend-sourced (`runtime-be`) flags supported. `check-flags` workflow fixed.
  Concurrency added to avoid parallel workflow runs on `live` (later replaced — see 2026-09-22 above).
  Flag-file regex fix.

## 2026-08-06

- Initial commit.
