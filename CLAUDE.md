# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

ShipScope is a cross-repo deployment/feature-flag/Jira status dashboard for the EVDT org. It has no
application server or build step: plain Node scripts (no `package.json`, no dependencies — only Node
built-ins and global `fetch`) are invoked by GitHub Actions workflows to sync data into JSON files under
`docs/data/`, and a static vanilla-JS page (`docs/index.html` + `docs/app.js`) renders that JSON. There is
no test suite, linter, or bundler in this repo.

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

## Branch model: `main` vs `live`

This is the most important structural thing to understand:

- **`main`** holds source: `scripts/`, `.github/workflows/`, docs about the tooling.
- **`live`** is the "deployed" branch: it holds `docs/data/*.json`, which bots mutate continuously
  (deployment syncs, Jira syncs, flag-state updates). GitHub Pages likely serves off `live`.
- `.github/workflows/sync-main-to-live.yml` merges `main` → `live` automatically whenever
  `scripts/**`, `.github/workflows/**`, or `.github/actions/**` change on `main`.
- Nearly every data-mutating workflow checks out `ref: live`, not `main`.
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
  merge-with-fresh-`live` step actually redoes on each retry; `sync-github-deployments.js` and
  `sync-jira.js` (keyed by a hash of its resolved JQL, so a genuinely different query still fetches fresh)
  both use it. `backfill-deployment-metadata.js` doesn't — mutates existing records in place across capped
  phases, doesn't fit the same cache shape, and is `workflow_dispatch`-only so the same race is rarer — its
  `sync-with-retry` call site is instead just capped at `max-attempts: 2` to bound wasted work.

When changing a script that writes to `docs/data/`, remember the change ships to `main` first and only
reaches the running data on `live` after the sync workflow merges it — the data files on `main` itself are
stale/example data, not the live state.

## Domain model

- **Flags** (`docs/data/flags-meta.json`): key → `{ description, source: 'build'|'runtime-be', jiraKeys[], components[], createdAt }`.
  - `build` flags are baked into FE bundles at build time via generated TS files (see below).
  - `runtime-be` flags are toggled live by a backend service and fetched from HTTP endpoints.
  - `createdAt` is stamped once, the first time a flag is scaffolded/filled in (`scaffold-flags-meta.js`,
    `sync-runtime-be-flags.js`, `fill-flag-metadata.js` all preserve it if it already exists) — flags that
    predate this field simply don't have it. It answers "when did this flag first show up," which is a
    different moment than any `flag-states.json` `changedAt` (those track state flips, not the flag's origin).
- **Flag states** (`docs/data/flag-states.json`): key → env (`test`/`qa`/`prod`) → source (`build`/`runtime-be`)
  → `{ enabled, changedAt, changedBy }`. Both a `build` and a `runtime-be` entry can coexist per
  flag/env; `effectiveFlagState()` in `docs/app.js` prefers `runtime-be` over `build` when both exist. This
  file only ever holds the *latest* value per flag/env/source — it's a snapshot, not a log.
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

  GitHub can fire more than one deployment/status entry for what is, in git terms, the same commit on the
  same env/component (e.g. a squash-merged release re-notified by a second workflow job a few minutes
  later) — `docs/app.js`'s `currentVersion()` always shows the *latest by `deployedAt`* record for a given
  component/env, so a "duplicate" record's own compare range matters just as much as the original's.
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
  signal. The tag/release fallback also matters for environments whose deploy pipeline doesn't promote from a
  "release" commit at all — e.g. `test` deploying straight off a feature-branch commit — which would otherwise
  only ever show a bare SHA even when that commit is actually tagged. Unlike rollback detection,
  `backfill-deployment-metadata.js` *does* re-resolve `version` for existing records — it only targets records
  whose current `version` looks like a raw SHA (`looksLikeRawSha`), tries the free release/tag lookups first,
  and only falls back to a per-record `/commits` call (capped by `MAX_RECORDS_PER_RUN`) if neither matches.
  The latest successful record per component/env may also carry `driftBehind`, recomputed on every sync from
  a single GitHub compare call between it and the earlier-stage environment (`test` → `qa` → `prod`):
  `{ behindEnv, commitCount }` when it lags behind (missing commits the earlier env already has), and/or
  `{ untestedIn, untestedCommitCount }` when it has commits the earlier env never saw — i.e. a hotfix or
  direct deploy that skipped the normal promotion path.
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

  `sync-jira.js`'s default run (no `JIRA_PROJECT_KEY`, no `BACKFILL_PIS`) only ever fetches the resolved
  current PI — bounded cost regardless of how much deployment history has piled up, instead of rescanning
  every issue key ever referenced across the whole of `deployments.json` on every run. This is
  `writePiShards()`'s `'partial'` scope: only the current PI's own shard (and `index.json`'s `currentPi`)
  are touched; every other PI's already-written file is left exactly as it was. Two other modes still use
  the older, `'full'` scope — a complete recompute where any existing shard file for a PI *not* found this
  run gets deleted, same as the original single-file sync always did: the explicit `JIRA_PROJECT_KEY`
  opt-in (still a whole-project(s) sync every run, current-PI-only or not), and the automatic fallback for
  whenever no board can resolve a current PI at all (no space in `docs/jira-spaces.json` has a `boards`
  entry, or every configured board's active-sprint lookup failed) — in that case it reverts to the original
  deploy-referenced-issue-key scan so a sync still produces *something* useful without any `boards` config.
  A separate, manually-triggered `BACKFILL_PIS` env var (`backfill-jira-issues.yml`, workflow_dispatch,
  comma/space-separated PI list e.g. `"PI-27.1, PI-26.5"`) is the escape hatch for anything the current-PI
  default doesn't cover — re-fetching a past PI, or seeding one that predates this sync ever running — via
  the same board-derived `sprint ~ "<num>" OR labels = "PI-<num>"` JQL shape, just parameterized by the
  requested PI(s) instead of an active sprint's derived one; also `'partial'` scope, and never touches
  `currentPi`.

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
a reliable way to set it, not something to guess at now. `application` (array of strings, or `null`/absent
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
Jira Agile board ID (`GET /rest/agile/1.0/board?name=...`), reads that board's *active* sprint(s)
(`GET /rest/agile/1.0/board/{id}/sprint?state=active`), and derives the PI(s) currently in flight from
their names (same `PI-\d+\.\d+` sprint-naming convention used everywhere else). It then runs an additional
JQL query scoped to `project = <that space> AND (sprint ~ "<PI>" OR labels = "PI-<PI>")` and merges the
result into the normal (deploy-referenced-only) issue set. This exists specifically so Product View can
show *every* work item currently planned for the PI the team is in — not just the ones that already have
code deployed somewhere — without paying for a full whole-project sync (see `JIRA_PROJECT_KEY` below):
the query is bounded to one PI's issues, not the whole project's history. `sprint ~ "<PI>"` depends on
Jira Cloud's fuzzy text match against the Sprint field's name; a self-hosted/Server Jira instance may need
a different match strategy. Any failure along this chain — board not found (or ambiguously matching more
than one), no active sprint, an active sprint whose name doesn't match the PI convention — logs a warning
and skips just that board's contribution; it never fails the sync, and a space with no `boards` configured
behaves exactly as before.

## Scripts (`scripts/*.js`) — one job each, invoked by one workflow each

| Script | Workflow | Purpose | Key env vars |
|---|---|---|---|
| `scaffold-flags-meta.js` | check-flags.yml | Create stub `flags-meta.json` entries for newly discovered build flags | `FLAGS_META_PATH`, `FLAGS_SEARCH_ROOT`, `COMPONENT` |
| `resolve-all-flag-states.js` | check-flags.yml | Resolve build-time flag states per env from `flag-parts/` dirs, scaffolding a `flags-meta.json` stub for any resolved key that doesn't have one yet | `FLAGS_SEARCH_ROOT`, `FLAGS_META_PATH`, `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH`, `CHANGED_BY`, `COMPONENT` |
| `check-flags-metadata.js` | check-flags.yml | Fail CI if any discovered flag lacks complete metadata | `FLAGS_META_PATH`, `FLAGS_SEARCH_ROOT`, `STATUS_REPO_EDIT_URL` |
| `fill-flag-metadata.js` | fill-flag-metadata.yml | Manually fill/update one flag's metadata (workflow_dispatch) | `FLAG_KEY`, `DESCRIPTION`, `SOURCE`, `JIRA_KEYS`, `COMPONENTS` |
| `sync-runtime-be-flags.js` | sync-runtime-be-flags.yml | Poll BE flag endpoints per env, update `flag-states.json` + auto-scaffold `flags-meta.json` for BE flags | `URL_TEST`/`URL_QA`/`URL_PROD`, `COMPONENT`, `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH`, `FLAGS_META_PATH` |
| `update-flag-state.js` | update-flag-state.yml | Set a single flag/env/source state (manual or `repository_dispatch: flag-changed`) | `FLAG_KEY`, `ENVIRONMENT`, `ENABLED`, `CHANGED_BY` |
| `sync-github-deployments.js` | orchestrate-full-sync.yml | Pull GitHub Deployments API for one app repo, derive per-env status + related Jira keys from commit ranges | `GITHUB_TOKEN`, `APP_REPO`, `COMPONENT` |
| `sync-jira.js` | orchestrate-full-sync.yml | Default run: fetch only the board-derived current PI (`docs/jira-spaces.json` space(s) with `boards` configured) and write/update just that PI's shard + `index.json`'s `currentPi`, leaving every other PI's file untouched — bounded cost regardless of deployment history size. Falls back to the old full-project/deploy-referenced-issue-key scan (whole-project when `JIRA_PROJECT_KEY` is set, else exact issue keys referenced in `deployments.json`) when no board resolves a current PI at all, recomputing every PI file from scratch in that case. Also invoked by `backfill-jira-issues.yml` with `BACKFILL_PIS` set, to (re)fetch specific PI(s) on demand without touching any other file | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` (optional), `SPACES_PATH` (optional), `JIRA_ISSUES_DIR` (optional), `BACKFILL_PIS` (optional) |
| `retrigger-app-checks.js` | retrigger-app-checks.yml | Re-run failed `check-flags` runs in app repos after `flags-meta.json` changes on `live` | `APP_REPO`, `APP_REPO_RERUN_TOKEN`, `WORKFLOW_FILE` |
| `backfill-deployment-metadata.js` | backfill-deployment-metadata.yml | One-off, manually-triggered: fill `workflowRunUrl`/`durationMs`/`manual`/`rollback`/compare-range `commitUrl`/`deployedByLogin`+resolved `deployedBy` name and re-resolve `version` (release/tag/message, same priority as the sync script) on deployment records created before those fields/that priority existed; also repairs pre-existing duplicate-release records (same resolved ref/env, collapsed to an empty range before the sync script's `lastResolvedRangeByEnv` fix) by copying the correct range from whichever sibling already has it | `GITHUB_TOKEN`, `APP_REPO`, `COMPONENT`, `MAX_RECORDS_PER_RUN` |
| `backfill-flag-state-history.js` | backfill-flag-state-history.yml | One-off, manually-triggered: mine `live`'s own git history for `flag-states.json` to seed `flag-state-history.json` with flips that predate that log (author unknown — see domain model above) | `FLAG_STATES_PATH`, `FLAG_STATE_HISTORY_PATH` |
| `sync-jira.js` (again) | backfill-jira-issues.yml | One-off, manually-triggered: (re)fetch one or more explicitly named PI(s) (`BACKFILL_PIS`, comma/space-separated, e.g. `"PI-27.1, PI-26.5"`) — for a PI predating this sync, or to force-refresh one that's since moved out of "current." Writes/overwrites only the requested PI's shard(s); never deletes or changes any other PI's file, and never touches `index.json`'s `currentPi` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `BACKFILL_PIS` |
| `record-full-sync.js` | orchestrate-full-sync.yml | Stamp `docs/data/sync-meta.json` with the current time — only run after every tracked component's deployments plus Jira were re-synced (cron/manual/unknown-dispatch branch of the `prepare` job, never a single-component `repository_dispatch`), so `lastFullSync` means "confirmed against the real state," not "something ran" | `SYNC_META_PATH` |

`check-flags.yml` is a **reusable** workflow (`workflow_call`) meant to be called from *app* repos (e.g.
`evapl-service-frontend`) — those repos check out their own code plus this repo's `scripts/`+`docs/data`
(via a GitHub App token scoped to `evdt-service-shipscope`) and run the flag checks against their own
generated flag files.

Every data-mutating script follows the same shape: read existing JSON (or `{}`/`[]` if absent) → merge in
new data, only bumping `changedAt`/`changedBy` when a value actually changes → write back pretty-printed
JSON. Preserve that idempotency (no-op when nothing changed → no commit) when editing these scripts, since
workflows commit-and-push only `git diff --staged --quiet ||`.

## Frontend (`docs/`)

Single-page vanilla JS, no framework/build step. `docs/app.js` fetches `docs/data/deployments.json`,
`flags-meta.json`, `flag-states.json`, and `docs/data/jira-issues/index.json` up front, then a single PI's
Jira shard (`loadJiraIssuesForPi()` — see "Jira issues" above) before rendering anything; joins it all in
memory and renders two tabs: "Product view (PI)" (Jira-issue-centric, filterable by type/priority/date,
always scoped to whichever PI is currently loaded) and "Technical view" (component × environment matrix +
deployment timeline + flat flag list). All
dates are rendered in `pl-PL` locale — except the "Rollbacks & drift over time" Insights chart's month/year
axis labels, deliberately kept in `en-US`.

One global PI `<select>` (`initGlobalPiSelect()`), shown in the tabs row regardless of which tab is active,
is the single place that changes which PI's data is loaded — shared by Product view, Release Notes, and
Insights (Technical view ignores it; it isn't PI-scoped). Its options come from `index.json`'s `pis` list
(already newest-first), with the server-resolved `currentPi()` marked; changing it re-fetches that PI's
shard into `state.jiraIssues`/`state.selectedPi`, resets and repopulates both Product view's and Release
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
shipped children. An Epic-type issue becomes a pure section header (title, key, its own `pi` tag if it was
itself synced, and a `epicRollup()` "N/M released to PROD" badge over its children — counting the same
strict `prodStatusBucket() === 'released'` bucket the Product view summary tiles/Insights' per-PI chart
use, not the broader `issueIsReleasedToProd()` (which also counts `deployed_code_only` — code shipped with
no flag to confirm against — as released; that's the right call for Release Notes' "did this reach users"
question, but would make this badge silently disagree with the tiles rendered right above it for the same
PI) and is never rendered as its own data row. Story/Task/Bug group under their resolved `epicKey` (present even when the Epic itself
was never directly synced — see "Jira issues" above); anything with neither an epicKey nor `type: 'Epic'`
falls into a trailing "Ungrouped" section rather than silently disappearing. Group order follows
first-encounter order in the (already type/date-filtered, and implicitly PI-scoped by whichever shard is
loaded) issue list, not a separate sort.

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

A fourth tab, "Insights" (`INSIGHTS_ENABLED`, gated behind `?insights=1` — the first actual reuse of the
hide-a-tab mechanism described above), holds five hand-rolled charts (no chart library, per this repo's
no-dependencies rule) that are pure rollups of data every other view already reads — zero new sync scripts,
zero new data files. Two are documented in more depth in `design-docs/FEATURES.md` → "Insights tab": stale
flags by days ON in prod (`staleFlagDaysBreakdown()` — reuses `STALE_FLAG_DAYS` purely as a color
threshold, not `flagStaleWarning()`'s full "every linked issue is Done" gate), and rollbacks/drift by month
(`rollbackDriftByMonth()` — counts `deployments.json` records carrying `rollback` or a `driftBehind` with
`commitCount`/`untestedCommitCount`, windowed to the last 12 calendar months only — a display cap, doesn't
touch `deployments.json` itself). A fourth chart from the same design doc (PRs per label) needs a new sync
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
`issue.priority`, sorted by Jira's standard priority rank via `comparePriorityDesc()`; issues with no
priority set are excluded, not lumped into an "unknown" bucket).
