# ShipScope FAQ — how is this calculated?

*Polska wersja: [FAQ.pl.md](FAQ.pl.md)*

For each number or badge on the dashboard: where the value comes from, in plain language, with the script or
function that computes it so it can be checked. `README.md` says what ShipScope is; `CLAUDE.md` is the technical
reference; `docs/GLOSSARY.md` explains terms that have more than one name.

ShipScope runs in two ways that share the same dashboard: the **file-based sync** (GitHub Actions write JSON files,
GitHub Pages serves them) and the **ShipScope server** (a hosted workspace per organization, configured in
Settings). The rules are the same in both unless an answer says otherwise.

## Deployments (Technical view)

### How is "rollback" decided?

Each new deployment is compared on GitHub with what was previously live on the same environment (the same
comparison that finds its Jira tickets and builds the commit-range link). If GitHub says the new commit is
**`behind`** — an ancestor of what was already running — the environment moved backward in history, and the
deployment gets a rollback badge naming the commit it went back to. It does not matter whether that was a
deliberate revert or a mistake. No extra API call is needed.
(File sync: `sync-github-deployments.js`, `issuesInRange`, field `rollback: { toRef }`. Server:
`server/lib/deployment-sync.js`.)

### How is "manual" versus "automatic" decided?

A deployment's status history usually links to the GitHub Actions run that performed it. ShipScope asks GitHub what
triggered that run: `workflow_dispatch` (the "Run workflow" button) means manual; a push, a schedule and similar
mean automatic. Without such a link the deployment counts as not manual. The file sync looks up at most 30 runs per
sync so a large backlog cannot make one run expensive; the rest stay unresolved.
(`sync-github-deployments.js`, `resolveManualFlag`, `MAX_MANUAL_LOOKUPS_PER_RUN`; server:
`server/lib/deployment-people.js`, which needs the GitHub App's Actions read permission.)

### How is deploy duration calculated?

The time between the earliest and the latest status GitHub recorded for the deployment (queued, in progress,
succeeded…). GitHub's `inactive` marker, added later when a newer deployment replaces this one, is ignored. With
only one status there is nothing to measure, so no duration is shown — that does not mean an instant deploy.
(`computeDeployDurationMs`.)

### Where does the version shown for a deploy come from?

The same rule for every environment; what differs is only which commit is deployed there. First match wins:

1. a GitHub **Release** pointing at that exact commit;
2. a plain git **tag** on that commit;
3. a **version file** in the deployed commit, when the component has one configured (`versionFile` in the file
   sync; Settings → GitHub → Tracked repositories → Version file on the server) — for repos whose QA/PROD deploy commits only contain
   a line like `version=v1.6.0`;
4. a version-like string (`v1.2.3`, `1.2.3`) in the **commit message**;
5. the shortened **commit SHA**.

Releases and tags come before the message because free text can mention an unrelated version; a Release or tag is
a deliberate signal. A deploy straight from a feature-branch commit usually ends at the SHA because no signal
exists. Only a verified Release/tag (or the SHA) is used for GitHub comparisons; a version taken from a message is
shown, not trusted. Releases and tags are fetched once per sync, not per deployment.
(`sync-github-deployments.js`: `shaToRelease`, `shaToTag`, `extractPromotedVersion`; server:
`server/lib/version-resolution.js`.)

### What does "Diff to TEST" mean, and when does it show up?

An environment card shows **"Diff to TEST"** (or "Diff to QA" — the previous stage in `test` → `qa` → `prod`) only
when the **code** of its current deployment differs from that environment's. Click it for details.

How it is decided for each pair of environments:

1. The two deployed commits' **git trees** are compared. The same tree means the same files: no marker, however many
   commits separate them (merges, squashes and deployment branches create new commits for identical code).
2. Otherwise the file lists are compared by path and content. Paths in the component's ignore list (deployment
   plumbing such as `.github/`, `README.md`, `trigger.properties`; `driftIgnorePaths` in the file sync, Settings → GitHub on
   the server) do not count. No differing file left: no marker.
3. If the comparison cannot be trusted — a GitHub error, or a repository too large for one listing (100,000 entries
   / 7 MB) — the result is **Unknown**, never "no difference".

The window shows the number of differing files (a rename counts as two), the first 20 paths and how many were
ignored; then the **Git history** counts: commits the other environment has that this one lacks, and the opposite
(e.g. a hotfix that skipped the earlier environment). History counts commits, not code, so "786 behind TEST" can
mean zero changed files; they are context only. It does not cover configuration, environment variables, images or
feature flags.

To see whether two environments really run different changes, compare the Jira issues (or the commit range link)
of their current deployments in Deployment history: no overlap means unrelated changes, not the same release at a
different pace.
(`compareTrees()`, `scripts/lib/tree-diff.js`; server: `server/lib/env-drift.js`.)

### How long are deployments kept, and when does a new one appear?

ShipScope shows the current state; GitHub keeps the full history. Deployments older than 90 days are removed on
every sync (file sync: `RETENTION_DAYS`; server: Settings → Workspace, 7–730 days), except — per component and
environment — the latest deployment and the latest successful one, which are what "current version", drift and
rollback need. Whether an issue ever shipped is remembered separately and survives this cleanup
(`issue-deployments.json` / the `issue_deployments` table).

- **File sync:** one shared `docs/data/deployments.json` for all components. A deploy triggers a sync of just that
  component (the app repo's "Notify ShipScope" workflow, see `ONBOARDING.md`), so it appears within minutes; a
  daily 3 AM run syncs everything in case a signal was missed. `deployments-cursor.json` remembers the highest
  deployment already processed, so trimmed deployments are not processed again.
- **Server:** every 15 minutes by default, and within about 30 seconds of a GitHub webhook when webhooks are on.

### What is `docs/data/summary.json`?

A precomputed copy, per component and environment, of the current (latest successful) deployment and the latest
deployment of any outcome — exactly what the sync already works out when trimming old records. It only makes the
first render faster: without it the page scans all of `deployments.json` once per component and per matrix cell.
If an entry is missing, the page falls back to the scan, so it can be stale for a moment but never wrong. File sync
only. (`buildSummary`; `currentVersion()` in `docs/app-model.js`.)

### Why do some GitHub API calls use conditional (ETag) requests?

GitHub answers a repeated request whose data has not changed with `304 Not Modified`, which does not count against
the rate limit. The file sync uses this for the three lists it fetches on every run (the first page of deployments,
tags, releases); most runs find nothing new, so these come back free. Per-deployment calls are made once each, so
there is nothing to revalidate. The cache is kept between runs with `actions/cache`.
(`scripts/lib/github-api.js`, `etagCache`; `orchestrate-full-sync.yml`, step "Cache GitHub API ETags".)

## Feature flags

### Where do flags come from, and how is on/off determined?

There are two slots per flag and environment, kept apart: **build** (baked into an application at build time) and
**runtime** (switched live by a backend). When both exist, runtime wins on the dashboard, and a disagreement is
marked (see below).

- **Server:** ShipScope never reads flags itself (`design-docs/ADR-001-flags-pushed-from-outside.md`). An admin adds
  flag sources in Settings; each source sends the full state of its flags (`off` / `on` / `partial` with a rollout
  percentage) with its own token to `POST /api/flags/ingest`. A flag the source stops sending disappears; an older
  message never overwrites a newer one; when several sources of one kind report the same flag, the higher priority
  wins. (`server/lib/flags.js`, rules in `server/lib/flags-logic.js`.)
- **File sync:** build flags are found by scanning app repos (`*.generated.ts` files show a flag exists;
  `flag-parts/` directories with `default.ts` + optional `test.ts`/`qa.ts`/`prod.ts` give its value per
  environment; both by regular expressions, so a change in how those files are generated is the first thing to
  check). Runtime flags are polled from a backend's HTTP endpoint per environment. Each flag needs a filled-in
  `flags-meta.json` entry (description, Jira keys, components); new flags get a stub and a PR check fails until it
  is completed. (`resolve-all-flag-states.js`, `sync-runtime-be-flags.js`, `check-flags-metadata.js`.)

### Which Jira issues does a flag belong to?

- **Server:** from three places, merged: the keys the sending source attaches, keys an admin sets by hand in
  Settings (never overwritten by a source), and Jira itself — a custom field or a label prefix the workspace
  chose in Settings (Jira → Feature flags in Jira).
- **File sync:** `jiraKeys` in `flags-meta.json`.

### How is the stale flag note (🧹) calculated?

Only for a flag with at least one linked Jira issue, all of them Done. ShipScope then takes the longest time the
flag has been on in any environment; at 60 days or more it suggests removing the flag. If any linked issue is not
Done, or the flag is off everywhere, nothing is shown. (`flagStaleWarning`, `STALE_FLAG_DAYS`,
`docs/app-technical-flags.js`.)

### How is the "blast radius" warning calculated?

Only for a flag linked to more than one Jira issue: if at least one is Done and at least one is not, turning the
flag on would release unfinished work together with finished work, so a warning is shown. (`flagBlastRadius`.)

### How is "build versus runtime divergence" shown?

Where a flag and environment have both a build value and a runtime value that disagree, the environment's badge in
the flags list gets a dashed outline and its tooltip shows the hidden build value — the one that comes back if the
runtime override is removed. (`renderFlags`, `docs/app-technical-flags.js`.)

### When did a flag first appear, and who changed it?

The file sync stamps `createdAt` once, when the flag is first discovered or filled in; flag-state changes are kept
in `flag-state-history.json`. Changes from before that log existed can be recovered from the `live` branch's git
history (`backfill-flag-state-history.js`), but not who made them — those entries say "unknown (backfilled from
git history)". The server keeps every value change in `flag_value_history`.

## Jira

### Which issues does ShipScope show?

- **Server:** an admin picks boards in Settings. Each sync re-reads every board's current increment (PI, sprint,
  release or month, depending on the board's rhythm) in full, plus the Epics of its issues; a board's first sync
  also takes the previous increment. An issue's sprint is the one on the board being synced. Older increments stay
  as they were last seen.
- **File sync:** the current PI is found from the active sprint of the boards in `docs/jira-spaces.json`, and all
  issues of that PI (by sprint, or by a `PI-X.Y` label with evidence of the right team) are fetched. Without
  configured boards ShipScope falls back to the issue keys found in deployed commit messages (`EBO-1234`), checking
  each key's project exists in Jira first. If Jira cannot be reached, it builds placeholder issues from those keys
  (no title, no status) so the dashboard is not empty.

### How is "sprint" different from "PI"?

A PI (Program Increment) usually spans several sprints. Both come from the same Jira Sprint field: `pi` is derived
from the sprint name (`27.3.1` → `PI-27.3`), `sprint` is the name itself. When an issue has several sprints, the
active one counts, else the last one; in the file sync only sprints of the space's own boards are considered.
(`pickRelevantSprintInfo`, `extractPiFromSprintName` in `scripts/lib/jira-pi.js`; server:
`server/lib/jira-model.js`.)

### How are issues stored, and when does a change appear?

One file per PI (`docs/data/jira-issues/PI-27.3.json`) plus `index.json` (the PIs, their sprints and dates, and the
current PI) and `status-index.json` (each issue's PI and status across all PIs, for the flags panel). The page loads
one PI at a time. Only the current PI is refreshed automatically, and it is replaced in full, so an issue that left
the PI simply disappears. Other PIs are snapshots from the last manual `backfill-jira-issues.yml` run.

In the file sync, Jira is synced after every deploy of any component, daily at 3 AM and on a manual run, so a new
item in the current sprint usually appears within minutes of anyone's next deploy. On the server it appears within
15 minutes, or about 30 seconds after a Jira webhook.

## Release Notes tab

### What does it show?

Issues that are live for users on PROD — `released` (deployed and its flag on) or deployed with no flag to wait for
— grouped by PI and sprint (newest first) and split into "Features & Improvements" and "Bug Fixes". Unreleased
issues are not listed. Each item shows a PROD status pill, its Jira key and the date it first reached PROD. The
Service filter narrows the list to one application from `docs/components.json` (`application`); a component without
one stands for itself. (`docs/app-release-notes.js`, `issueIsReleasedToProd`, `earliestProdDeployedAt`.)

### Why does it say there is nothing to show although the PI has issues?

Every issue is a placeholder built from commit messages (see "Which issues does ShipScope show?"), which has no
real PI. That means the Jira sync is not reaching Jira: check its run log and the `JIRA_BASE_URL` / `JIRA_EMAIL` /
`JIRA_API_TOKEN` secrets (file sync) or the Jira connection in Settings (server).

## Data freshness

### What does "synced HH:MM" in the header mean?

- **File sync:** the time of the last run that re-synced every component's deployments plus Jira (the daily run, a
  manual run, or an unrecognized trigger) — not a single component's post-deploy sync, which can silently fail to
  fire. The separate `source: data/*.json` tag only says the files were fetched. (`record-full-sync.js`,
  `docs/data/sync-meta.json`.)
- **Server:** the most recent successful deployment sync of any of the workspace's repositories.

## Workflows (file sync) — when does each run?

- **`orchestrate-full-sync.yml`** (deployments and Jira) — after each deploy (a `repository_dispatch` from the app
  repo), daily at 3 AM, and manually.
- **`check-flags.yml`** — no schedule; app repos call it from their own CI.
- **`sync-runtime-be-flags.yml`** — when a backend flag service reports a change, after any app deploy, daily at
  3:15 AM, and manually.
- **`update-flag-state.yml`** — manually, or when a backend reports a single flag change.
- **`fill-flag-metadata.yml`** — manually, to fill in a flag's description, Jira keys or components.
- **`retrigger-app-checks.yml`** — after `flags-meta.json` changes, to re-run app repos' failed `check-flags` runs.
- **`sync-main-to-live.yml`** — on each push to `main` touching `scripts/`, `docs/` or `.github/`; it carries code to
  the `live` branch that GitHub Pages serves.
- **`backfill-deployment-metadata.yml`, `backfill-flag-state-history.yml`, `backfill-jira-issues.yml`** — manual
  maintenance only.

## Credentials

### Server

No secrets per app repo. The workspace connects the ShipScope GitHub App (installed by the organization, chosen
repositories only) and Jira (Atlassian sign-in; ShipScope stores only an encrypted refresh token). Flag sources
use their own tokens, created and revoked in Settings.

### File sync: why is a GitHub App token needed when the Jira secrets already exist?

They are for different systems. `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` give `sync-jira.js` read access to
**Jira only**. `actions/create-github-app-token` turns a GitHub App's private key into a token valid for about an
hour, used for **GitHub only**:

| Workflow | What the App token is for |
|---|---|
| `orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml` | Reading an app repo's deployments, commits and comparisons. |
| `retrigger-app-checks.yml` | Re-running failed `check-flags` runs in app repos. |
| `check-flags.yml`, `notify-deployment.yml` | Running in an app repo but writing to / signalling ShipScope. |
| `fill-flag-metadata.yml`, `sync-runtime-be-flags.yml` | Firing the `flags-meta-changed` event. |

The default `GITHUB_TOKEN` cannot replace it: it covers only the repository the workflow runs in, and events it
creates do not start other workflows. The Jira sync job needs no App token — it only writes to ShipScope's own
repository, which `GITHUB_TOKEN` can do.

### Which credential matters most?

The GitHub App **private key**. Tokens expire in an hour; the key does not, and it can mint tokens with write
access to `live` and the app repos. Keep token permissions minimal, pin the action that uses it to a commit SHA and
know who owns the key and when it was rotated (`design-docs/TODO.md`).
