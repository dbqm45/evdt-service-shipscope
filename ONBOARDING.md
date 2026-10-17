# Onboarding

*Polska wersja: [ONBOARDING.pl.md](ONBOARDING.pl.md)*

What to do, in order, to get data into ShipScope. Part A is for a workspace on the ShipScope server; part B is for
the file-based sync run by GitHub Actions. How things work underneath is in `CLAUDE.md`; how each value is computed
is in `FAQ.md`.

**Required in both:** each app's deploy pipeline must create a real **GitHub Deployment** with statuses for every
environment it deploys to (`test`/`qa`/`prod`). ShipScope reads deployment history only through the GitHub
Deployments API. In GitHub Actions a job with `environment: test` (or `qa`, `prod`) creates one each time it runs.
Environment names are matched loosely (`production` → `prod`, `dev` → `test`, `preprod` is not `prod`); anything
else (`staging`, `uat`) is skipped.

## A. ShipScope server (a workspace)

Sign in with GitHub and create a workspace at `/start`. Its Settings page (`/t/<workspace>/settings`) opens with a
**Getting started** checklist that shows where you are; admins can hide it. The steps:

1. **Install the GitHub App** on the GitHub organization or account you deploy from (Settings → GitHub → Install).
   GitHub brings you back; the installation is linked only if your own GitHub account can see it.
2. **Choose repositories to track** — Track next to each repository whose deployments you want to see. Optional
   per repository: a version file (for QA/PROD deploys whose commits only hold a line like `version=v1.6.0`) and
   paths not counted as drift (e.g. `.github/`, `README.md`).
3. **First deployments arrive** — within 15 minutes (the default sync interval), or within about 30 seconds when
   the server has GitHub webhooks configured. A sync error shows under GitHub.
4. **Connect Jira** (optional, read-only) — sign in with Atlassian and pick the Jira site.
5. **Choose Jira boards** — tick each team's board and save. The board's rhythm (PI, sprints, releases or monthly
   flow) is detected; it can be changed per board, together with a PI-name template. Sync now, or wait for the next
   sync.
6. **Send feature flags** (optional) — ShipScope does not read flags itself. Add a source per place your flags live
   (a build step, a flag service; kind build or runtime, priority, optional component), create a token for it, and
   have it send the full state of its flags to `POST /api/flags/ingest`. Under Jira → Feature flags in Jira you can
   also name the field or label prefix that links Jira issues to flags.
7. **Invite your team** — one invitation link per person. Members see everything; admins can change settings.

Under Workspace an admin also sets how many days of deployment history to keep (7–730) and can delete the
workspace.

## B. File-based sync

The file-based sync and its workflows run from the original repository, `circlek-global/evdt-service-shipscope`
(the one app repos reference in `uses:`); this repository has no copy of those workflows.

### 0. One-time setup of ShipScope itself

Only needed for a new ShipScope instance, or when nothing syncs for any component.

**Two GitHub Apps:**

- **The sync app** (`CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID` / `..._PRIVATE_KEY`, secrets on `evdt-service-shipscope`).
  Installed on **every monitored app repo** (Organization settings → GitHub Apps → the app → Configure → repository
  access) with read access to **Deployments**, **Contents** (compare, commits, tags, releases) and **Actions**
  (manual-vs-automatic lookup; `retrigger-app-checks.yml` also needs Actions write). Missing installation on a repo
  is the most common reason nothing shows up for it.
- **The ShipScope-write app** (`SHIPSCOPE_APP_ID` / `SHIPSCOPE_APP_PRIVATE_KEY`). Installed on
  `evdt-service-shipscope` with Contents read and write. Its credentials must also be available to every monitored
  repo, because the app repo's own workflow mints the token used to signal ShipScope (`notify-deployment.yml`) or
  write flag data (`check-flags.yml`).

ShipScope's own workflows that stay inside this repository (committing to `live`, merging `main` into `live`) use
the default `GITHUB_TOKEN` with `contents: write`.

**One Jira account, read-only:** an Atlassian API token stored as `JIRA_EMAIL` / `JIRA_API_TOKEN`, plus
`JIRA_BASE_URL`. It needs "Browse projects" in every project ShipScope should see; ShipScope never writes to Jira. If
`docs/jira-spaces.json` lists `boards`, it also needs read access to those Jira Software boards
(`/rest/agile/1.0/board`, `/rest/agile/1.0/board/{id}/sprint`).

If only the board/sprint calls return 401 while project and issue searches work with the same credentials, see
Atlassian's ["401 Unauthorized error when service account accesses Jira or Confluence API"](https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/).
Usually either the token is a **scoped** token of a service account without the Jira Software scopes
(`read:board-scope:jira-software`, `read:sprint:jira-software`), or the account has no **Jira Software product
access**. A Jira admin fixes both; nothing changes in this repository.

With only this in place the daily sync already runs (with nothing to sync) and Jira falls back to its no-config
path. Data appears once a component is added.

### Before adding a component

You need: the component's exact **GitHub repo name** (e.g. `evapl-service-frontend`, used as its name everywhere);
confirmation that it creates GitHub Deployments (see the top of this document); and whether it has **build-time
feature flags** (`*.generated.ts` files, `flag-parts/` directories).

### 1. Add it to `docs/components.json`

```json
{ "name": "your-repo-name", "description": "What this component does.", "serviceType": null, "featureFlagsIncluded": null, "application": null }
```

- `name` — the repo name; the only required field.
- `description` — tooltip on the component name.
- `featureFlagsIncluded` — `true` if ShipScope tracks its flags, `false` to show a "flags not tracked here" icon,
  `null` while unknown.
- `serviceType` — reserved; leave `null`.
- `application` — array of business-facing names (e.g. `["EBO"]`) for the Release Notes Service filter; without it
  the component stands for itself.
- `versionFile` (optional, e.g. `"trigger.properties"`) — when QA/PROD deploy from `deployment/*` branches holding
  only trigger commits (`version=v1.6.0`); without it drift compares trigger commits instead of code.
- `driftIgnorePaths` (optional, e.g. `[".github/", "README.md", "trigger.properties"]`) — files not counted as a code
  difference between environments.

This is the only ShipScope file you edit. Open a PR to `main`; after merge, `sync-main-to-live.yml` carries it to
`live`, where everything reads it from.

### 2. Give the GitHub Apps access to the repo

- Install the sync app on the new repo (see step 0).
- Make `SHIPSCOPE_APP_ID` / `SHIPSCOPE_APP_PRIVATE_KEY` available to it (nothing to do if they are organization
  secrets visible to all repositories; otherwise add the repo to their list).

### 3. Wire up the app repo

**Notify ShipScope after each deploy.** Add one workflow to the app repo's **default branch**,
`.github/workflows/notify-shipscope.yml`. Without it the component is synced only by the daily 3 AM run.

```yaml
name: Notify ShipScope

on:
  workflow_run:
    # each value must equal the `name:` of a deployment workflow exactly (case-sensitive)
    workflows: ["Test auto-deployment", "QA on-demand deployment", "Prod on-demand deployment"]
    types: [completed]

permissions: {}

jobs:
  notify_shipscope:
    name: Trigger ShipScope full sync
    # successful runs only; to also record failed attempts use
    # conclusion != 'skipped' && conclusion != 'cancelled'
    if: github.event.workflow_run.conclusion == 'success'
    uses: circlek-global/evdt-service-shipscope/.github/workflows/notify-deployment.yml@v1.0.0
    with:
      component: ${{ github.event.repository.name }}
    secrets:
      SHIPSCOPE_APP_ID: ${{ secrets.CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID }}
      SHIPSCOPE_APP_PRIVATE_KEY: ${{ secrets.CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY }}
```

Why a separate file: GitHub runs a workflow from the branch that triggered it, so a deploy started from a branch
like `deployment/qa` would use that branch's copy of the deployment workflow, which lacks steps added only on
`main`. A `workflow_run` workflow is always read from the default branch, so this one file covers every branch and
environment. Do not also keep a notify step inside the deployment workflows (it only duplicates the signal).

Notes: it does nothing until merged to the default branch; `component` must match `docs/components.json`; the
secrets must be repository or organization secrets, not environment secrets. Check with one real deploy: "Notify
ShipScope" runs in the app repo's Actions tab and `orchestrate-full-sync.yml` starts in ShipScope. If a deployment
workflow is renamed, update `workflows:`.

**Build-time flags (if any).** Add a workflow calling the reusable `check-flags.yml`, as `evapl-service-frontend`
does. Its metadata check fails until every flag's entry is filled in (`fill-flag-metadata.yml`);
`check-flags-metadata.js` can warn instead (`WARN_ONLY=true`) when the workflow passes that through.

### 4. Build-time flags: set `featureFlagsIncluded: true`

`retrigger-app-checks.yml` re-runs an app repo's failed `check-flags` runs after `flags-meta.json` changes, for
components with `featureFlagsIncluded: true`. The sync app must be installed on the repo for this too.

### 5. Optional: enrich older deployments

`backfill-deployment-metadata.yml` (manual) fills newer fields — workflow run link, duration, manual, rollback,
commit range, display name, version — on deployment records created before those existed. It is capped per run
(`MAX_RECORDS_PER_RUN`) and safe to re-run.

### What you don't need to touch

- **`scripts/*.js`** — every script takes the component from `COMPONENT`/`APP_REPO`.
- **`docs/app-*.js` / `docs/index.html`** — component lists and filters come from the data; row order follows
  `docs/components.json`.
- **Jira** — without configured boards, the Jira sync uses the issue keys found in the component's commit messages
  (`XXX-123`). To show the whole current PI, add the team's space and board to `docs/jira-spaces.json`
  (`CLAUDE.md` → "Configuration files in `docs/`").
