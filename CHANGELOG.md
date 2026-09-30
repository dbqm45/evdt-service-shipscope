# Changelog

*Polska wersja: [CHANGELOG.pl.md](CHANGELOG.pl.md)*

Notable changes to ShipScope, newest first. This project has no version numbers (it's an internal
dashboard, not a published package), so entries are grouped by date instead. See `README.md` for what
ShipScope is, `CLAUDE.md` for the technical reference, and `FAQ.md` for how specific numbers/badges are
calculated.

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
