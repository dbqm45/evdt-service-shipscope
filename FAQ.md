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