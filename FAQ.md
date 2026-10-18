# ShipScope FAQ — how is this calculated?

*Polska wersja: [FAQ.pl.md](FAQ.pl.md)*

For each number or badge on the dashboard: where the value comes from, in plain language, with the file or function
that computes it so it can be checked. `README.md` says what ShipScope is; `CLAUDE.md` is the technical reference;
`docs/GLOSSARY.md` explains terms that have more than one name. Settings below means the workspace's Settings page
(`/t/<workspace>/settings`).

## Deployments (Technical view)

### How is "rollback" decided?

Each new deployment is compared on GitHub with what was previously live on the same environment (the same
comparison that finds its Jira tickets and builds the commit-range link). If GitHub says the new commit is
**`behind`** — an ancestor of what was already running — the environment moved backward in history, and the
deployment gets a rollback badge naming the commit it went back to. It does not matter whether that was a
deliberate revert or a mistake. No extra API call is needed. (`server/lib/deployment-sync.js`.)

### How is "manual" versus "automatic" decided?

A deployment's status history usually links to the GitHub Actions run that performed it. ShipScope asks GitHub what
triggered that run: `workflow_dispatch` (the "Run workflow" button) means manual; a push, a schedule and similar
mean automatic. Without such a link the deployment counts as not manual. At most 30 runs are looked up per
repository per sync, so a large backlog cannot use up the rate limit on a badge. Needs the GitHub App's Actions read
permission. (`server/lib/deployment-people.js`.)

### How is deploy duration calculated?

The time between the earliest and the latest status GitHub recorded for the deployment (queued, in progress,
succeeded…). GitHub's `inactive` marker, added later when a newer deployment replaces this one, is ignored. With
only one status there is nothing to measure, so no duration is shown — that does not mean an instant deploy.
(`computeDeployDurationMs`, `server/lib/deployment-logic.js`.)

### Where does the version shown for a deploy come from?

The same rule for every environment; what differs is only which commit is deployed there. First match wins:

1. a GitHub **Release** pointing at that exact commit;
2. a plain git **tag** on that commit;
3. a **version file** in the deployed commit, when the repository has one set (Settings → GitHub → Tracked
   repositories → Version file) — for repos whose QA/PROD deploy commits only contain a line like `version=v1.6.0`;
4. a version-like string (`v1.2.3`, `1.2.3`) in the **commit message**;
5. the shortened **commit SHA**.

Releases and tags come before the message because free text can mention an unrelated version; a Release or tag is
a deliberate signal. A deploy straight from a feature-branch commit usually ends at the SHA because no signal
exists. Only a verified Release/tag (or the SHA) is used for GitHub comparisons; a version taken from a message is
shown, not trusted. (`server/lib/version-resolution.js`.)

### What does "Diff to TEST" mean, and when does it show up?

An environment card shows **"Diff to TEST"** (or "Diff to QA" — the previous stage in `test` → `qa` → `prod`) only
when the **code** of its current deployment differs from that environment's. Click it for details.

How it is decided for each pair of environments:

1. The two deployed commits' **git trees** are compared. The same tree means the same files: no marker, however many
   commits separate them (merges, squashes and deployment branches create new commits for identical code).
2. Otherwise the file lists are compared by path and content. Paths the repository's settings exclude (deployment
   plumbing such as `.github/`, `README.md`, `trigger.properties`; Settings → GitHub → Paths not counted as drift)
   do not count. No differing file left: no marker.
3. If the comparison cannot be trusted — a GitHub error, or a repository too large for one listing (100,000 entries
   / 7 MB) — the result is **Unknown**, never "no difference".

The window shows the number of differing files (a rename counts as two), the first 20 paths and how many were
ignored; then the **Git history** counts: commits the other environment has that this one lacks, and the opposite
(e.g. a hotfix that skipped the earlier environment). History counts commits, not code, so "786 behind TEST" can
mean zero changed files; they are context only. It does not cover configuration, environment variables, images or
feature flags.

To see whether two environments really run different changes, compare the Jira issues (or the commit range link)
of their current deployments in Deployment history: no overlap means unrelated changes, not the same release at a
different pace. (`server/lib/env-drift.js`, `server/lib/tree-diff.js`.)

### How long are deployments kept, and when does a new one appear?

ShipScope shows the current state; GitHub keeps the full history. Deployments older than the workspace's retention
(Settings → Workspace, 7–730 days, default 90) are removed daily, except — per repository and environment — the
latest deployment and the latest successful one, which are what "current version", drift and rollback need. Whether
an issue ever shipped is remembered separately and survives this cleanup (the `issue_deployments` table). New
deployments arrive with the periodic sync (every 15 minutes by default) or about 30 seconds after GitHub reports
them, when webhooks are on. (`server/lib/retention.js`, `server/worker.js`.)

## Feature flags

### Where do flags come from, and how is on/off determined?

ShipScope never reads flags itself (`design-docs/ADR-001-flags-pushed-from-outside.md`). An admin adds flag sources
in Settings; each source sends the full state of its flags (`off` / `on` / `partial` with a rollout percentage) with
its own token to `POST /api/flags/ingest`. A flag the source stops sending disappears; an older message never
overwrites a newer one.

Each flag has two slots per environment: **build** (from sources of kind build) and **runtime** (kind runtime).
When several sources of one kind report the same flag, the higher priority wins. When both slots have a value,
runtime wins on the dashboard and a disagreement is marked (see below). (`server/lib/flags.js`, rules in
`server/lib/flags-logic.js`.)

### Which Jira issues does a flag belong to?

From three places, merged: the keys the sending source attaches, keys an admin sets by hand in Settings (never
overwritten by a source), and Jira itself — a custom field or a label prefix chosen in Settings (Jira → Feature flags
in Jira).

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

### Who changed a flag, and when?

Every value change a source reports is kept in the flag's history (`flag_value_history`), with the sender's own
change time and the name it gives (else the source's name).

### How do I try the flags adapter in another repository?

Start with a dry run: it needs no ShipScope, no token, and shows the exact message the adapter would send.

1. **Let the other repository use the Action.** When this repository is private, open its Settings → Actions →
   General → Access and allow repositories of the same owner. A public one needs nothing.
2. **Dry run.** In the other repository add a flags file, e.g. `config/flags.prod.json` with
   `{ "newCheckout": true, "darkMode": "off", "search": 25 }`, and a workflow you start by hand:

   ```yaml
   # .github/workflows/shipscope-flags.yml
   name: ShipScope flags
   on: workflow_dispatch
   jobs:
     flags:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v7
         - uses: dbqm45/evdt-service-shipscope/adapters/flags@v0.2.7   # or a newer release tag
           with:
             environment: prod
             files: config/flags.prod.json
             dry-run: true
   ```

   Run it from the Actions tab. The log shows the message (`newCheckout` on, `darkMode` off, `search` partial 25) and
   "Dry run: 3 flags for prod, nothing sent."; a value it cannot read fails the step and names the flag and the file.
3. **Send for real.** In ShipScope, Settings → Feature flags: add a source (kind build) and copy its token. In the
   other repository add the secret `SHIPSCOPE_FLAGS_TOKEN` (the token) and the variable `SHIPSCOPE_URL` (the
   ShipScope address, e.g. the Render one; GitHub's runners cannot reach `localhost`). Replace `dry-run: true` with:

   ```yaml
             shipscope-url: ${{ vars.SHIPSCOPE_URL }}
             token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
   ```

   The log ends with "ShipScope (<source>): 3 flags for prod, 3 changed, 0 removed, new: …".
4. **Check in ShipScope.** The source shows "received" with the counts, the flags are in Settings → Feature flags
   and on the dashboard (Technical view → flags). Running the workflow again changes nothing (0 changed); removing a
   flag from the file and running it marks that flag removed.
5. **See a refusal.** Set the token to a wrong value: the step fails with 401. Give a flag a value like `"maybe"`:
   the adapter stops before sending. A message ShipScope itself refuses shows under the source as "last message
   refused" with the reason.

Your flags in another layout (one `.ts` file per environment and domain, as in an Nx monorepo): in step 2 use
`files: domains/*/config/flags/{env}.ts` and `env-map: dev=test, qa=qa, prod=prod` instead of `environment` and the
JSON file; the log lists the files it skipped (e.g. `local.ts`). More layouts: `ONBOARDING.md`, "The flags adapter".

Against a local server (`npm run dev`), use the command line instead of the Action, from a checkout of this
repository: `SHIPSCOPE_URL=http://localhost:3000 SHIPSCOPE_FLAGS_TOKEN=shpi_... node adapters/flags/shipscope-flags.js
--env prod --file <path to the other repository>/config/flags.prod.json`. Options: `adapters/flags/README.md`;
more examples: `ONBOARDING.md`, "Sending feature flags".

## Jira

### Which issues does ShipScope show?

An admin picks boards in Settings. Each sync re-reads every board's current increment (PI, sprint, release or month,
depending on the board's rhythm) in full, plus the Epics of its issues; a board's first sync also takes the
previous increment. An issue's sprint is the one on the board being synced. Older increments stay as they were last
seen. Changes appear with the next sync (every 15 minutes by default) or about 30 seconds after a Jira webhook.
(`server/lib/jira-sync.js`, rules in `server/lib/jira-model.js`.)

### How is "sprint" different from "PI"?

A PI (Program Increment) usually spans several sprints. Both come from the Jira Sprint field: `pi` is derived from
the sprint name (`27.3.1` → `PI-27.3`, or the board's own PI-name template), `sprint` is the name itself. For boards
that don't work in PIs the "increment" is the sprint, the release or the month, and the selector shows that instead.
(`server/lib/jira-model.js`.)

## Release Notes tab

### What does it show?

Issues that are live for users on PROD — `released` (deployed and its flag on) or deployed with no flag to wait for
— grouped by increment and sprint (newest first) and split into "Features & Improvements" and "Bug Fixes".
Unreleased issues are not listed. Each item shows a PROD status pill, its Jira key and the date it first reached
PROD. The Service filter narrows the list to one application. (`docs/app-release-notes.js`,
`issueIsReleasedToProd`, `earliestProdDeployedAt`.)

### Why is it empty although Jira is connected?

Nothing has reached PROD yet in the selected increment, or no deployment's commit messages mention the issues' keys
(that is how an issue is linked to a deployment). Check the Jira connection and board sync time in Settings.

## Data freshness

### What does "synced HH:MM" in the header mean?

The most recent successful deployment sync of any of the workspace's repositories. A repository whose sync fails
shows its error in Settings → GitHub.

## Credentials

No secrets live in app repositories. The workspace connects the ShipScope GitHub App (installed by the organization,
chosen repositories only, read access) and Jira (Atlassian sign-in; ShipScope stores only an encrypted refresh
token). Flag sources use their own tokens, created and revoked in Settings.
