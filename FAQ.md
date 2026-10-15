# ShipScope FAQ — how is this calculated?

*Polska wersja: [FAQ.pl.md](FAQ.pl.md)*

This document is a plain-language companion to `README.md`, which describes what ShipScope is, and
`CLAUDE.md`, which is the full technical reference. Its purpose is to answer a recurring category of
question: for a given number or badge shown on the dashboard, where does that value actually come from. Each
answer names the responsible script or function so the logic can be verified directly. No prior familiarity
with the codebase is assumed.

## Deployments (Technical view → timeline)

### How is "rollback" decided?

Whenever a new deployment is synced, ShipScope compares the newly deployed commit against whatever was
previously live on the same environment. That comparison already has to happen for other reasons: it is how
related Jira tickets are identified and how the "commit range" link is built. GitHub's response to a compare
request includes a `status` field, with possible values `ahead`, `behind`, `diverged`, or `identical`.

A status of **`behind`** means the newly deployed commit is an ancestor of the commit that was already
running. In other words, the deploy moved the environment backward in history rather than forward. This is
what "rollback" means in this context: not that someone clicked an undo button, but that the code currently
live is older than the code live a moment earlier on the same environment, regardless of whether that was a
deliberate revert or a mistake.

Because this reuses a comparison that is already performed, detecting a rollback requires no additional call
to GitHub. (Script: `sync-github-deployments.js`, function `issuesInRange`, which returns the comparison
`status`; `main()` converts `status === 'behind'` into `rollback: { toRef: <previous commit> }`.)

For deployments recorded before this check existed, the one-off `backfill-deployment-metadata.js` script
performs the same comparison retroactively, one GitHub API call per deployment not yet checked.

### How is "manual" versus "automatic" decided?

Every deployment on GitHub carries a history of deployment statuses, one of which normally includes a
`log_url` pointing at the GitHub Actions run that performed the deploy. ShipScope extracts the numeric run ID
from that URL, queries GitHub for what triggered that specific run, and checks whether the answer is
`workflow_dispatch` — GitHub's designation for a run started manually via the "Run workflow" button, as
opposed to a run started automatically by a push, a schedule, or a similar event.

If no `log_url` is present, the trigger type cannot be determined, and the deployment is treated as not
manual by default.

To keep this inexpensive when a sync run has to process a large backlog at once, for example after an
outage, ShipScope limits itself to 30 of these trigger-type lookups per sync run. Any deployment beyond that
limit in the same run is left unresolved rather than allowing the run to become open-endedly expensive.
(Script: `sync-github-deployments.js`, function `resolveManualFlag`, constant `MAX_MANUAL_LOOKUPS_PER_RUN`.)

### How is deploy duration calculated?

GitHub records a timestamped status each time a deployment changes state — queued, in progress, succeeded,
failed, and so on. ShipScope takes the earliest and latest of those timestamps for a given deployment and
subtracts one from the other. If GitHub only ever reported a single status for that deployment, there is
nothing to subtract, and no duration is shown. This does not indicate an instant deploy; it indicates that
there is insufficient data to measure one.

(Script: `sync-github-deployments.js`, function `computeDeployDurationMs`.)

### Where does the version shown for each deploy come from? A Release, a tag, or something else? Does this differ per environment?

The resolution mechanism is identical for every environment (test, qa, prod); there is no environment-specific
logic. What differs per environment is simply which commit happens to be deployed there, and whether that
particular commit is associated with a Release, a tag, or a version string in its commit message.

For a given deployed commit, ShipScope checks the following, in order, stopping at the first one that
produces a result:

1. **A GitHub Release pointing at that exact commit.** GitHub Releases are built on top of tags, so ShipScope
   cross-references each Release's tag name against the repository's tag list to find the exact commit it
   points to.
2. **A plain git tag on that exact commit**, with no associated Release required.
3. **A version-looking string inside the commit's own message** — a loose pattern match for something shaped
   like `v1.2.3` or `1.2.3` anywhere in the text.
4. **The raw commit SHA**, shortened, used only when none of the above produce a result.

Releases and tags are checked before the commit message deliberately: free text in a commit message can
incidentally contain something that resembles a version without denoting one, for example a commit stating
that it fixes a bug introduced in a prior version, whereas a Release or a tag is a deliberate, unambiguous
signal. This is why an environment deployed directly from a feature-branch commit, with no tag and no
release-worthy message, will often fall through to a bare SHA: no version signal exists on that commit for
ShipScope to find.

Checking for Releases and tags costs two list calls to GitHub per sync run, not per deployment, so the cost
does not scale with the number of deployments processed in a given run. (Script:
`sync-github-deployments.js`; see `shaToRelease`, `shaToTag`, and `extractPromotedVersion`.)

Deployments recorded before this priority order existed can be re-resolved after the fact by the one-off
`backfill-deployment-metadata.js` script. It only processes records whose version still resembles a bare SHA,
and attempts the cost-free Release/tag lookups before falling back to an API call that reads the commit
message.

### What does "Diff to TEST" mean, and when does it show up?

An environment card shows **"Diff to TEST"** (the environment it is compared with — the previous stage in the
promotion chain `test` → `qa` → `prod`) only when the *code* of its current deployment differs from that
environment's. Nothing else is printed on the card; the details are in the modal opened by clicking it.
(Script: `sync-github-deployments.js`, functions `computeEnvDrift()`/`compareTrees()`; stored as `driftBehind`.)

How it is decided, per pair of environments:

1. The two deployed commits' **git trees** are compared. Identical tree = identical files = no marker, however
   many commits separate the two (merges, squashes and separate deployment branches create new commits for
   identical code).
2. Otherwise the recursive tree listings (`GET /git/trees/{sha}?recursive=1`) are diffed by path + blob SHA.
   Paths matched by the component's `driftIgnorePaths` (`docs/components.json` — deployment plumbing such as
   `.github/`, `README.md`, `CODEOWNERS`; `dir/` = prefix from the repo root, a pattern with `/` = exact
   path, a bare name = that file name at any depth, `*` = any characters except `/`) are not counted. No
   differing file left = no marker.
3. If the comparison can't be trusted — a GitHub API error, or a repository too large for one listing
   (GitHub truncates at 100,000 entries / 7 MB) — the record gets `diff: { unknown: true }` and the modal says
   **Unknown**; it is never silently treated as "no difference".

The modal shows, in order: the **file diff** (number of differing files — a rename counts as two — the first 20
paths, and how many more were ignored by `driftIgnorePaths`); the raw **Git history** counts from the GitHub
compare call (`commitCount`: commits the other environment has that this one doesn't; `untestedCommitCount`:
the opposite direction — e.g. a hotfix that bypassed the earlier environment). The history numbers measure
commits, not code, so a large number such as "786 behind TEST" does not mean a large difference; they are kept
for context only. Both come from the same compare call that already produces `commitUrl`/`relatedIssues`,
so they cost nothing extra; the tree comparison adds up to four API calls per pair when the commits' trees differ.

**What this does not show:** a tree comparison covers the repository's files only. It does not confirm that the
deployments are otherwise identical (configuration, environment variables, images, feature flags).

**Older records:** records synced before this comparison existed have no `diff`; their modal has no
file-diff section and shows only the Git history until the service's next sync replaces the record.

**Components that deploy from `deployment/*` trigger branches:** if QA/PROD deploy a commit that only edits
`trigger.properties` (`version=v1.6.0`), set `versionFile` in `docs/components.json` so the compared refs come from
the tag the file names (see `design-docs/DRIFT-SAME-VERSION-DIFFERENT-SHA.md`), and list `trigger.properties` in
`driftIgnorePaths`.

**Worked example** (real data, `evapl-service-frontend`, 2026-10-06): TEST deployed `v1.0.0` at 14:44 (commit
`42e7ce8`, carrying issues EBO-16806/ECST-9871/…). Two minutes later, QA deployed a commit also *displayed*
as `v1.0.0` — but it was actually a different commit (`cfd213e`), carrying a completely different,
non-overlapping set of issues (ARP-4953/EBO-8399/EBO-13020). TEST's subsequent deploys (`v1.1.0`, `v1.2.0`)
never included `cfd213e` or its issues either, confirming that commit genuinely never passed through TEST at
any point. The "233 commit(s) skipped TEST" shown against that QA record (the pre-"Diff to" wording) was accurate, not a false alarm:

| Env | Deploy time | Displayed version | Actual commit | Jira issues |
|---|---|---|---|---|
| TEST | 14:44 | `v1.0.0` (verified tag) | `42e7ce8` | EBO-16806, ECST-9871, … |
| QA | 14:46 | `v1.0.0` (unverified — commit-message match) | `cfd213e` | ARP-4953, EBO-8399, EBO-13020 |

To check whether a specific "skipped" warning fits this same shape, compare the related Jira issues (or the
commit range behind that deployment's own `commitUrl` link) between the two environments' current records in
Deployment history — no overlap at all means the two environments are genuinely running different, unrelated
changes, not just the same release at a different pace.

### Is `deployments.json` split per component or per PI, and when does a new deployment actually become visible?

No splitting by component or PI — it is one shared file, `docs/data/deployments.json`, holding records for
every tracked component at once (each record carries its own `component` field). A second, tiny,
never-trimmed file, `docs/data/deployments-cursor.json`, tracks the highest GitHub deployment ID ever
synced per component, so an already-processed deployment can still be recognized as such even after its
actual record has aged out of the main file.

Records older than 90 days are physically removed from `deployments.json` on every sync (`RETENTION_DAYS`),
except the single latest record and the single latest **successful** record per component/environment,
which are kept regardless of age — these are what the dashboard's "current version"/drift/rollback logic
depends on, so they can never be trimmed away.

The sync script runs once per component: it reads the whole existing file, leaves every other component's
records untouched, merges in fresh records for just the one component it was invoked for, trims, and writes
the whole file back.

This runs as the `sync_deployments` job in `orchestrate-full-sync.yml`. A `repository_dispatch` fired right
after a deployment — by that app repository's own `notify_shipscope` step — syncs only that one component;
the daily 3 AM cron and a manual run sync every tracked component.

In practice: a new deployment of a given component becomes visible within minutes of that deployment
finishing, because the deployment itself is what triggers the sync for that component. The only way this is
delayed is if the deploying repository's own workflow never calls `notify_shipscope` at all — in which case
that deployment simply waits for the next 3 AM safety-net run (as long as it is still within the retention
window by then).

The typical cause: a deployment started from a long-lived branch such as `deployment/qa` (a commit bumping
`version` in `trigger.properties`). GitHub reads the workflow file from the branch that was pushed, so that
branch's copy of the workflow lacks a `notify_shipscope` step added only on `main`. The fix that needs no
server and no per-branch maintenance is a small workflow on the service repo's **default branch**, triggered
by `workflow_run` (which only fires from the default branch's YAML, whatever branch the deploy ran on) and
calling `notify-deployment.yml` — see "Alternative without a server" in
`design-docs/DEPLOYMENT-WEBHOOK-PROPOSAL.md`.

(Script: `sync-github-deployments.js`, functions `trimOldRecords`, `main`. Workflow:
`orchestrate-full-sync.yml`, job `sync_deployments`. Trigger: `notify-deployment.yml`'s `notify_shipscope`
step.)

### What is `docs/data/summary.json`, and why does it exist alongside `deployments.json`?

It is a small, **precomputed** file: for every component and environment, just the single current (latest
successful) deployment record and the single latest record overall, success or not. It exists purely for
render speed, not because the dashboard needs any data that isn't already in `deployments.json`.

Without it, showing "what's currently running in prod for service X" means scanning the *entire*
`deployments.json` array — every record, for every component, across the whole retention window — and
sorting the matches, every single time that question is asked. The dashboard asks it a lot on first load:
once for every component (the top summary cards) and once again for every component×environment
combination (the matrix). For a large tracked fleet with months of retained history, redoing that full
scan dozens of times before the page has even finished painting is wasted work, because the answer barely
ever changes between syncs.

`summary.json` precomputes that answer once, server-side, at the exact moment the sync script already has
the data in hand — building it costs nothing extra: `trimOldRecords()` already has to figure out "what's
the latest record, and the latest *successful* record, for each component/environment" in order to decide
what's safe to keep when trimming old history, so writing those same two values out to their own small
file is just reusing work already done, not doing new work. The dashboard then reads a direct lookup out
of this file instead of recomputing it in the browser, and only falls back to the old full-scan behavior
when a component or environment is missing from it (for example, a component that was onboarded after this
file already existed needs one more sync before it shows up here).

Because it is precomputed rather than independently maintained, it can never disagree with
`deployments.json` in a way that matters: both are written from the same data in the same sync run. The one
accepted gap is that the one-off, manually-triggered `backfill-deployment-metadata.js` script edits older
deployment records directly and does not update this file — so a backfilled correction to what happens to
be a component's *current* record won't be reflected here until that component's next regular sync. That
is a stale cache for a few minutes at most, not an incorrect dashboard, since the full-scan fallback always
remains available if this file is ever absent or out of date.

(Script: `sync-github-deployments.js`, functions `trimOldRecords`, `buildSummary`. File: `docs/app.js`,
function `currentVersion`.)

### Why do some GitHub API calls use conditional (ETag) requests, and not others?

GitHub's REST API supports a standard HTTP mechanism called conditional requests: a response carries an
`ETag` header (a fingerprint of that exact response), and a later request for the same URL can include
that fingerprint as `If-None-Match`. If nothing has changed, GitHub replies `304 Not Modified` with no body
at all, instead of sending the same data again as a real `200`. The useful part for ShipScope specifically
is that a `304` response does **not** count against GitHub's API rate limit, while an ordinary `200` does.

ShipScope uses this for exactly three endpoints: fetching the first page of a component's deployments, its
tags, and its releases — the three list calls that get fetched on *every single sync run*, regardless of
whether anything on GitHub's side actually changed since the last run. In the common case — a steady-state
cron run across many components, most of which have nothing new — these calls now mostly come back as free
`304`s instead of spending real rate-limit budget on data that turned out to be identical to what was
already known.

This is deliberately **not** applied to the many other GitHub calls a sync run makes per deployment
(fetching a commit, comparing two commits, reading a deployment's statuses, resolving a workflow run) — not
for lack of trying, but because none of them would actually benefit: each of those URLs is already fetched,
at most, once in this script's entire lifetime (the sync cursor guarantees a given deployment is only ever
processed once), so there is nothing to revalidate on a second call that never happens. Caching an ETag
only pays off for a URL that gets re-requested later with the chance that the answer hasn't changed — true
for the three list endpoints above, not true for a one-shot per-deployment lookup.

For the cache to actually help, it has to survive *between* separate workflow runs, not just within one —
a cache that only lived for the duration of a single job would reset to empty (and thus never produce a
`304`) on every scheduled run. `orchestrate-full-sync.yml`'s `sync_deployments` job wires an
`actions/cache` step around a directory the sync script writes its per-component ETag cache file into,
keyed so that a fresh run can restore the previous run's cache before deciding what to re-fetch.

(Script: `scripts/lib/github-api.js`, functions `githubApiRequest`/`githubApiGet`, parameter `etagCache`;
`sync-github-deployments.js`, constant `ETAG_CACHE_PATH`. Workflow: `orchestrate-full-sync.yml`, job
`sync_deployments`, step "Cache GitHub API ETags".)

## Feature flags

### How is the "flag has been idle too long" note (🧹 stale flag) calculated?

This check only considers a flag if it has at least one linked Jira ticket, and every linked ticket is
already marked Done in Jira. When that condition holds, ShipScope examines every environment where the flag
is currently switched on, calculates how many days it has held that value, and shows the cleanup note if the
longest of those periods is 60 days or more. If even one linked ticket is not yet Done, or the flag is not on
anywhere, nothing is shown; the logic is deliberately conservative rather than speculative.

This is computed in the browser from data already loaded, with no additional step and no additional API
call. (File: `docs/app.js`, function `flagStaleWarning`, constant `STALE_FLAG_DAYS`.)

### Where do flags currently come from, and how does ShipScope determine their on/off state?

Flags come from two independent sources, tracked separately rather than merged into one:

- **`build` flags** live inside an application's own code, baked in at build time. ShipScope discovers them
  by scanning each app repository for two kinds of files:
  - `*.generated.ts` files, used only to establish that a flag exists, in order to scaffold a metadata entry.
  - `flag-parts/` directories, each containing a `default.ts` plus optional `test.ts`/`qa.ts`/`prod.ts`
    overrides, used to resolve the flag's actual on/off value per environment (a per-environment override
    takes precedence over `default.ts` when one exists).
  Both mechanisms rely on regular-expression matching against the TypeScript source rather than a full
  TypeScript parser. If a caller repository restructures how these files are generated, this is the first
  place to check.
- **`runtime-be` flags** are toggled live by a backend service, with no code change or deploy involved.
  ShipScope polls that service's HTTP endpoint for each environment on a schedule and records the response.

When a flag has both a build-time default and a live backend override, the backend override takes precedence
for display purposes. ShipScope also flags the cases where the two currently disagree — see "build versus
runtime-be divergence" — since the hidden build default would resurface if the override were ever removed.

Every flag additionally requires a manually completed entry in `flags-meta.json` (description, Jira keys,
owning components) before it counts as fully documented. New flags are scaffolded automatically as
incomplete stubs, and a PR check (`check-flags-metadata.js`) fails continuous integration until the entry is
filled in.

(Scripts: `resolve-all-flag-states.js` for build flags, `sync-runtime-be-flags.js` for runtime-be flags;
`docs/app.js`, function `effectiveFlagState`, decides which source takes precedence when both exist.)

### How is the "blast radius" warning calculated?

This check only applies to flags linked to more than one Jira ticket. ShipScope examines the status category
of every ticket linked to that flag; if at least one is Done and at least one is not (still `new` or
`indeterminate`), it warns that enabling the flag would release the unfinished ticket alongside the finished
one. If every linked ticket is Done, or none of them are, nothing is shown, since there is no mixed-readiness
condition to flag.

(File: `docs/app.js`, function `flagBlastRadius`.)

### How is "build versus runtime-be divergence" calculated?

This applies only where a flag/environment combination has both a build-time default and a live runtime-be
override. ShipScope compares their `enabled` values directly. If they disagree, the environment's badge in
the flags list receives a dashed outline, and its tooltip displays the current hidden build default, since
that is the value that would resurface if the live override were ever removed or expired.

(File: `docs/app.js`, inside `renderFlags`; see `envEntry.build` and `envEntry['runtime-be']`.)

### How does ShipScope determine when a flag first appeared?

Every flag's metadata (`flags-meta.json`) carries a `createdAt` value, stamped once, at the moment the flag
is first scaffolded — discovered from `*.generated.ts`/`flag-parts/` files, or from a `runtime-be` poll — or
manually filled in, and left unchanged on every subsequent edit. This value powers the "new flag" entry on
the merged timeline. Flags that existed before this field was introduced simply do not have one, and there is
no way to reconstruct it retroactively without mining Git history for older versions of `flags-meta.json`,
which is not currently done.

(Scripts: `scaffold-flags-meta.js`, `sync-runtime-be-flags.js`, `fill-flag-metadata.js`.)

### Can flag history from before the audit log existed be recovered?

Partially. Every change ever made to `flag-states.json` was already recorded as a separate git commit on the
`live` branch, so `scripts/backfill-flag-state-history.js` (workflow `backfill-flag-state-history.yml`,
triggered manually) walks that commit history, compares each revision against the one before it, and seeds
`flag-state-history.json` with what changed and when. What cannot be recovered is who made the change:
commits to that file are always authored by an automated process, never by the person who actually triggered
it. Backfilled entries are therefore explicitly marked `changedBy: "unknown (backfilled from git history)"`
rather than attributing an author that cannot be verified.

## Jira

### Where do the Epic/Story/Task numbers come from?

Indirectly, from commit messages. The chain works as follows:

1. When a deployment is synced, ShipScope scans the commit messages within that deployment's range for
   anything shaped like a Jira key, for example `EBO-1234`, and records those against the deployment as
   `relatedIssues`.
2. Separately, ShipScope searches Jira for exactly those keys (`key in (EBO-1234, ...)`), not for their
   whole owning projects — a ticket mentioned once in a commit message shouldn't pull in every other,
   unrelated ticket that happens to share its project. (Passing `JIRA_PROJECT_KEY` opts a sync run into the
   old, broader behavior — searching a whole project end to end — for a project that should be tracked
   completely from the outset rather than just where commits happen to reference it.)

The Jira keys themselves ultimately originate from developers including them in commit messages. ShipScope
does not invent or infer a Jira key on its own.

Because step 1 treats *any* `XXX-123`-shaped string in a commit message as a candidate Jira key, it can pick
up things that aren't actually Jira issues in this instance — a ticket ID from an unrelated system, or a
typo. Before querying, ShipScope checks each candidate's project prefix against Jira's own, visible project
list and drops anything that doesn't resolve, since a single invalid project inside the search would
otherwise fail the whole query and silently zero out every other project's results too, not just the bad
one's. (Function: `filterExistingProjectKeys`.)

If Jira cannot be reached at all, due to an outage or a permissions issue, ShipScope falls back to
constructing lightweight substitute issue records directly from the same commit-derived keys, inferring a
rough type (`feat`/`fix`/`chore`) from the commit message's own prefix. This is a deliberately degraded
substitute for real Jira data, lacking a title or a real status, sufficient only to keep the dashboard
showing something rather than nothing.

(Scripts: `sync-github-deployments.js` extracts keys from commit messages; `sync-jira.js` performs the actual
Jira fetch and the no-Jira fallback.)

### How is Jira data split into files, and when does something new in a sprint actually become visible?

Jira data is not a single file. There is one JSON file per PI (e.g. `docs/data/jira-issues/PI-27.3.json`),
plus an `index.json` listing every PI ShipScope has data for — including each PI's own sprint names and
dates — and a separate `status-index.json`, a flat `key → {pi, statusCategory}` map spanning every PI at
once, used only by the Technical view's Flags panel, since that panel has no PI selector of its own to pick
a shard with. The dashboard loads `index.json` up front, then only the single PI's file currently selected;
it never holds more than one PI's issues in memory at a time.

Only the current PI — the one `sync-jira.js` derives from a configured board's active sprint — is refreshed
automatically, and it is replaced wholesale on every sync, not merged: whatever the latest fetch returns
becomes the *entire* new content of that PI's file. An issue that moved out of the PI is simply absent from
the next version, with no separate cleanup step needed.

Any other PI's file is a snapshot from whenever someone last ran the manual `backfill-jira-issues.yml`
workflow for it, and is never touched again automatically. If a sprint belongs to a PI other than the
current one, nothing new in it will appear until that backfill is run again by hand.

Jira sync runs as the `sync_jira` job in `orchestrate-full-sync.yml`, which fires after every deployment of
any tracked component (via `repository_dispatch`), on a daily 3 AM safety-net schedule, or when triggered
manually — and it runs on every single one of those occasions, not just the "sync everything" ones, because
the job is marked `if: always()` so one component's deployment-sync failure can't skip it.

In practice: a new item added to the current PI's current sprint becomes visible after the very next Jira
sync — which, in a reasonably active org, means within minutes of *anyone's* next deploy, since that alone
retriggers the whole workflow. If nothing deploys that day, it still appears by the next 3 AM cron run at
the latest. Running the workflow manually makes it appear immediately. An item added to a PI that is not
the current one will not appear at all until someone runs the backfill workflow for it.

(Script: `sync-jira.js`, functions `resolveCurrentPiForSpaces`, `runCurrentPiMode`, `writePiShards`.
Workflow: `orchestrate-full-sync.yml`, job `sync_jira`. Manual snapshot path: `backfill-jira-issues.yml`.)

## Release Notes tab (preview)

### How do I even see this tab?

Load the page with `?releaseNotes=1` appended to the URL. There is no other switch — no setting, no
cookie, nothing saved between visits. This is a deliberate soft-launch gate while the tab is still being
validated against real data, not an access-control measure: the underlying JSON is exactly as public with
or without the parameter.

(File: `docs/app.js`, constant `RELEASE_NOTES_ENABLED`.)

### How is an issue grouped into an "application"?

Not from Jira at all — from `docs/components.json`. Every Jira issue is first resolved to the set of
components it touches (from linked feature flags, or from raw deployment history when it has no linked
flag), and each of those components carries its own `application` list in `docs/components.json`. An issue
appears once under every application any of its components belongs to; a component with no `application`
set falls back to using its own name as a one-component "application" instead of being dropped.

This is an array on the component, not a single value, specifically so a component shared between two
applications (e.g. a backend also used by two different frontends) has its issues show up under both,
rather than forcing an arbitrary single owner.

(File: `docs/app.js`, functions `componentsForIssue`, `applicationsForComponent`, `applicationsForIssue`.)

### How is "sprint" different from "PI", and where does it come from?

A PI (Program Increment) usually spans several sprints. Both values are read from the exact same Jira
Sprint field on an issue — `pi` is a regex-derived summary of it (e.g. `24.4.3` → `PI-24.4`), while `sprint`
is that same field's raw resolved name, kept alongside `pi` rather than instead of it. Release Notes nests
sprints inside their PI rather than replacing the PI grouping with it, since a PI-level view still answers a
different, useful question ("is this whole increment out yet") than a sprint-level one.

(Script: `scripts/sync-jira.js`, functions `pickRelevantSprintName`, `extractPiFromSprintName`.)

### How is "Fully released to PROD" decided for a group (application, PI, or sprint)?

Every issue in that group must be either `released` (deployed **and** its flag is on) or
`deployed_code_only` (no flag links to it at all, so a successful deployment referencing it is as final as
that issue's status can get) on `prod`, per the same `issueStatusForEnv` logic the Product view already
uses for its per-issue pills. A single issue anywhere in the group that's merely `deployed` (flag off),
`partial`, or `none` keeps the whole group's badge at "In progress" — this is intentionally an
all-or-nothing rollup, not an average or a percentage.

(File: `docs/app.js`, function `issuesFullyReleasedToProd`.)

### Where does the date next to "Fully released to PROD" come from?

For each issue, the moment it actually became released is the *later* of the deployment that shipped it
and (if it's flag-gated) the moment its flag was turned on — both had to be true at once, so whichever
happened second is when the issue was actually released. A group's date is the latest of its issues' own
release moments, since the group only finished releasing once the last one crossed that line. This is why
it only appears next to "Fully released to PROD" and never next to "In progress" — a still-open group
doesn't have a single meaningful "since" moment to show.

(File: `docs/app.js`, functions `issueReleasedAtProd`, `groupReleasedAtProd`.)

### Why does the tab show "No PI-tagged issues to show yet" even though the loaded PI's shard isn't empty?

Because every issue in it is a deployment-derived fallback stub (see "Where do the Epic/Story/Task numbers
come from?" above) — `pi: "—"`, not a real PI. The Release Notes tab filters on `isRealPi`, and a stub's
placeholder `"—"` never matches it. This means
the tab is only ever useful once `sync-jira.js` is actually reaching Jira successfully; check that
workflow's run logs and the `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` secrets first if every issue looks
like a stub.

## Data freshness (header)

### What does the "synced HH:MM" text in the header's status badge mean?

The `source · data/*.json` tag next to the tabs only confirms the data files were successfully fetched
from `live` — it says nothing about how recently, or how completely, those files were last updated on the
server side.

"synced HH:MM" is stricter. It is stamped only after a run of `orchestrate-full-sync.yml` has successfully
re-synced *every* tracked component's deployments (not just one) plus Jira — the branch of that workflow
triggered by the daily cron safety net, a manual run, or an unknown/malformed dispatch, never the
single-component `repository_dispatch` fired right after one specific deploy. That distinction matters
because the single-component path can silently fail to fire at all, if the deploying app repository's own
workflow file — on whichever branch triggered that particular deploy — never received the step that calls
it (see the `main`/`live` branch model in `CLAUDE.md`); without a separate indicator, the dashboard would
have no way of showing that a sync was ever missed.

(Script: `record-full-sync.js`, which writes `docs/data/sync-meta.json`. Workflow: `orchestrate-full-sync.yml`,
job `record_full_sync`, gated on `needs.prepare.outputs.full == 'true'`. File: `docs/app.js`, rendered into
the `#statusBadgeTime` element inside the header's status badge.)

## Workflows — when does each one actually run?

- **`orchestrate-full-sync.yml`** (deployments and Jira) — runs automatically immediately after a deployment
  completes, via a webhook from the app repository; on a daily 3 AM safety-net schedule in case a webhook is
  ever missed; and can also be triggered manually from the Actions tab.
- **`check-flags.yml`** — has no schedule of its own. It is called by each app repository's own CI, and
  therefore runs whenever that repository decides to call it, typically on a push or pull request that
  touches flag-related files.
- **`sync-runtime-be-flags.yml`** — runs whenever the backend flag service sends a webhook indicating a flag
  changed, and also whenever any app repository's deployment completes, since a backend release can itself
  change a flag's default. A daily 3:15 AM safety-net schedule covers the case where either signal is missed,
  and the workflow can also be triggered manually. It previously polled unconditionally every 15 minutes;
  this was relaxed once the webhook and deploy triggers made frequent polling unnecessary, given how
  infrequently these flags actually change in practice.
- **`update-flag-state.yml`** — never runs on a timer. It runs only when triggered manually, or when a
  backend service sends a webhook indicating that a specific flag has changed.
- **`fill-flag-metadata.yml`** — manual only, used when a person fills in a flag's Jira keys, components, or
  description.
- **`retrigger-app-checks.yml`** — runs automatically whenever `flags-meta.json` itself changes on `live`, to
  re-run any `check-flags` runs in app repositories that previously failed due to missing metadata.
- **`sync-main-to-live.yml`** — runs automatically on every push to `main` that touches `scripts/`, `docs/`,
  or `.github/workflows/`. This is the mechanism that carries code changes from `main` onto the `live` branch
  that GitHub Pages actually serves.
- **`backfill-deployment-metadata.yml`** and **`backfill-flag-state-history.yml`** — one-off maintenance
  tools, never run automatically. They exist to be triggered manually when older, already-recorded data needs
  to be brought up to date with a newer version of the sync logic.

## Secrets and tokens — which credential does what?

### Is `create-github-app-token` still needed, given that `JIRA_API_TOKEN` already lives in Repository Secrets?

Yes — the two serve completely different systems and neither replaces the other.

- **`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`** (Repository Secrets) give access to **Jira only** —
  `scripts/sync-jira.js` sends them as HTTP Basic auth on every Jira API call. GitHub knows nothing about them.
- **`actions/create-github-app-token`** exchanges a GitHub App's private key (`SHIPSCOPE_APP_PRIVATE_KEY` or
  `CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY`) for a short-lived (about one hour) token scoped to the listed
  repositories. It is used for **GitHub operations only**.

The App token is used in seven places, always for the same underlying reason — the default `GITHUB_TOKEN` can't
do the job:

| Workflow | What the App token is for |
|---|---|
| `orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml` | Reading an app repository's Deployments, commits and compare data (`repositories: ${{ matrix.repo }}`). |
| `retrigger-app-checks.yml` | Re-running failed `check-flags` runs in app repositories (`actions: write` there). |
| `check-flags.yml`, `notify-deployment.yml` | Run inside an app repository's workflow, but write to / send events to `evdt-service-shipscope`. |
| `fill-flag-metadata.yml`, `sync-runtime-be-flags.yml` | Fire the `flags-meta-changed` `repository_dispatch` event. |

`GITHUB_TOKEN` is not a substitute for two reasons: it only covers the repository the workflow runs in (so it
can't reach an app repository, or reach ShipScope from one), and events or pushes it creates deliberately do not
trigger further workflow runs (so it can't fire `repository_dispatch` that is supposed to start another
workflow).

### Does the `sync_jira` job use a GitHub App token?

No. `sync_jira` in `orchestrate-full-sync.yml` needs only the Jira secrets plus the ordinary `GITHUB_TOKEN`.
Its run log shows exactly this: two `actions/checkout` steps (`main` at the workspace root for the scripts, `live`
into `data/` for the JSON files), then the `sync-with-retry` composite action — there is no
`create-github-app-token` step in that job. The Jira secrets are passed as `env:` to that single step only, and
the commit to `live` is made with the checkout's default `GITHUB_TOKEN` credentials, which is enough because the
job only writes to the same repository it runs in. The App token you see earlier in the same workflow belongs to
the `sync_deployments` job (it reads the *app* repository), not to `sync_jira`.

A side effect worth knowing: because that push is made with `GITHUB_TOKEN`, it does not itself trigger other
workflows. Nothing downstream is meant to react to a Jira data commit, so this is fine — but it's the reason
anything that *should* fan out (like `flags-meta-changed`) uses the App token instead.

### Which of these credentials is the long-lived one worth protecting most?

The App **private key**. The tokens it mints expire in about an hour, but the key itself doesn't, and it can mint
tokens with write access to `live` and to the app repositories. That is why pinning third-party actions that
handle it (`create-github-app-token`) to a commit SHA, keeping each token's `permission-*` to the minimum a step
needs, and tracking the key's owner and rotation date are all worth doing — see `design-docs/TODO.md`.
