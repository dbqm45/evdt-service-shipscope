# Onboarding a new component

*Polska wersja: [ONBOARDING.pl.md](ONBOARDING.pl.md)*

This is a practical checklist for making a new app repo/component show up in ShipScope. For the underlying
mechanics (why the steps are split this way, the `main`/`live` branch model), see `CLAUDE.md` — this
document only lists what to do, in order.

## 0. ShipScope-level prerequisites (one-time, not per component)

Everything below (sections 1–5) assumes ShipScope itself is already set up and running. These are the
accounts, credentials, and permissions that make the sync machinery work *at all* — configured once,
centrally, not for each new component. If any of these is missing, no amount of per-component onboarding
will produce data; this is the checklist for setting up a brand-new ShipScope instance, or for diagnosing
"nothing syncs for *any* component."

**GitHub — two separate GitHub Apps, each doing a different job:**

- **The sync app** — `CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID`/`CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY`,
  stored as secrets on `evdt-service-shipscope` itself. Registered at the organization level and
  **installed on every monitored app repo** (Organization settings → GitHub Apps → the app → Configure →
  repository access). It needs read access to each repo's **Deployments** (`sync-github-deployments.js`'s
  `/deployments`/`/deployments/{id}/statuses` calls), **Contents** (`/compare`, `/commits`, `/tags`,
  `/releases` — version/rollback/drift resolution), and **Actions** (`resolveManualFlag`'s workflow-run
  lookup, and `retrigger-app-checks.js`'s failed-run listing *and* re-run, which additionally needs
  Actions write, not just read). Used by `orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml`,
  `retrigger-app-checks.yml`. Without this app installed on a given repo, every sync/backfill step for it
  fails with an access error — this is the single most common "why isn't anything showing up for repo X"
  cause.
- **The ShipScope-write app** — `SHIPSCOPE_APP_ID`/`SHIPSCOPE_APP_PRIVATE_KEY`. Installed on
  `evdt-service-shipscope` itself, with read-and-write access to its **Contents** — needed both to push
  commits to `live` from a *caller* repo's own workflow run (`check-flags.yml`), and to receive a
  `repository_dispatch` fired against this repo (`notify-deployment.yml`, and whatever credential a
  backend flag service uses to fire `flags-updated`/`flag-changed`). Unlike the sync app above, this one's
  credentials also have to exist as a secret *on every monitored repo* (passed through when that repo
  calls the reusable `notify-deployment.yml`/`check-flags.yml`) — each monitored repo's own workflow is
  what mints the token scoped back to `evdt-service-shipscope`, so this is the one piece of friction that
  can't be centralized away in the file-based model (the server's GitHub App connection removes it).
- `evdt-service-shipscope`'s own workflows (`sync-with-retry`, `sync-main-to-live.yml`,
  `update-flag-state.yml`, `sync-runtime-be-flags.yml`) all declare `permissions: contents: write` and use
  the default, automatic `GITHUB_TOKEN` — no GitHub App is needed for anything that stays entirely inside
  this one repo (committing to `live`, merging `main` into `live`).
- Each monitored component's own deploy pipeline must create a real **GitHub Deployment + deployment
  status** per environment it deploys to (`test`/`qa`/`prod`). ShipScope reads deployment history
  *exclusively* through the GitHub Deployments API — there is no fallback for a pipeline that doesn't
  create them; this has to be fixed in that repo's own pipeline before ShipScope can show anything for it
  at all, no matter how correctly everything else here is configured.

**Jira — one account, read-only:**

- A **Jira Cloud account** with an **API token** (an Atlassian API token, generated from that account's
  own Atlassian ID settings) — stored as `JIRA_EMAIL`/`JIRA_API_TOKEN` repo secrets, sent as HTTP Basic
  Auth, plus `JIRA_BASE_URL` for the Atlassian site itself. All three are read by `sync-jira.js` via
  `orchestrate-full-sync.yml`/`backfill-jira-issues.yml`.
- That account needs only **read ("Browse projects")** access to every Jira project ShipScope should be
  able to see issues in — every call `sync-jira.js` makes (`/rest/api/3/search/jql`,
  `/rest/api/3/project/search`, `/rest/api/3/field`) is a read. ShipScope never writes to Jira, so no write
  permission is ever required there.
- If `docs/jira-spaces.json` configures `boards` for a space (to resolve the current PI from a board's
  active sprint, instead of falling back to a plain deploy-referenced-issue-key search), the same account
  additionally needs read access to those specific Jira Software/Agile boards
  (`/rest/agile/1.0/board`, `/rest/agile/1.0/board/{id}/sprint`).
  - **Troubleshooting a 401 here specifically**: if board/sprint calls 401 while plain project/issue
    search calls (`project/search`, `search/jql`) succeed with the exact same `JIRA_EMAIL`/`JIRA_API_TOKEN`,
    that's a known pattern — see the Atlassian KB article
    ["401 Unauthorized error when service account accesses Jira or Confluence API"](https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/).
    Check, in order: (a) whether the account is an Atlassian **service account** specifically (not a
    regular human or bot user account) and, if so, whether its API token is a **scoped** token that was
    never granted the separate Jira Software/Agile API scopes (e.g. `read:board-scope:jira-software`,
    `read:sprint:jira-software`) — a scoped token only works for API families explicitly selected when it
    was created, unlike a classic token; (b) whether the account actually has a **Jira Software product
    role/license** assigned (Jira admin → Products), since generic project read access doesn't grant that
    on its own and `/rest/agile/1.0/*` requires it. Both are fixed by a Jira admin on the Atlassian side —
    there's nothing to change in this repo's code for either case.

**What this buys you, on its own:** with just the above in place and an empty `docs/components.json`,
`orchestrate-full-sync.yml`'s daily cron already runs successfully (an empty sync matrix), and Jira sync
falls back to its no-config path. Nothing becomes genuinely useful, though, until at least one component is
onboarded — sections 1–5 below.

## Before you start

You need to know:

- The component's exact **GitHub repo name** (e.g. `evapl-service-frontend`). It's used as both the
  `component` label and the repo to pull from — there's no separate display name.
- Whether it **deploys via GitHub Deployments** (creates a GitHub Deployment + deployment status per
  environment when it deploys to `test`/`qa`/`prod`). ShipScope reads deployment history exclusively from
  the GitHub Deployments API (`sync-github-deployments.js`) — if the repo's deploy pipeline doesn't create
  deployments today, that has to be fixed in the app repo's own pipeline first; nothing here can compensate
  for it.
- Whether it has **build-time feature flags** (generated `*.generated.ts` files, `flag-parts/` directories)
  — this determines whether you need the `check-flags.yml` step below.

## 1. Add it to `docs/components.json` (this repo)

Add an entry to the `components` array in `docs/components.json`:

```json
{ "name": "your-repo-name", "description": "What this component does.", "serviceType": null, "featureFlagsIncluded": null, "application": null }
```

`name` is the only field anything server-side keys off of — `description` (tooltip on the component name)
and `featureFlagsIncluded` (an explicit `false` renders a "flags not tracked here yet" icon next to the
name — leave it `null` until you actually know one way or the other) are optional but worth filling in.
`serviceType` is reserved for future use; leave it `null`. `application` (an array of strings, e.g.
`["EBO"]`) groups this component with any others that make up the same business-facing application for
the Release Notes tab — leave it `null` until you know the right grouping; a component without one just
shows up under its own name instead of being dropped. `versionFile` (optional, e.g. `"trigger.properties"`)
is needed if QA/PROD deploy from `deployment/*` branches holding only trigger commits (`version=v1.6.0`):
without it, drift compares those trigger commits instead of real code and shows inflated "N behind" counts.
Leave it out for components that deploy the code commit itself. This is the single source of truth:
`orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml`, and `notify-deployment.yml` all read it
server-side keyed by `name`, and `docs/app.js` fetches it client-side for the same purpose plus the tooltip
and flag-tracking icon (see `CLAUDE.md` → "Tracked components"). This is the *only* file in
`evdt-service-shipscope` you need to edit.

Open a PR to `main`. Once merged, `sync-main-to-live.yml` automatically merges `main` into `live` (it
triggers on any push to `main` touching `scripts/**`, `docs/**`, or `.github/workflows/**` — `main` doesn't
serve the live dashboard, `live` does). Everything below reads `docs/components.json` from `live`, so this
merge has to land before the new component name is recognized anywhere.

## 2. Grant repo access to the GitHub App(s)

Two separate credentials are involved, and both need to be able to see the new repo:

- **`CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID` / `CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY`** — used by
  `orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml`, and `retrigger-app-checks.yml` (via
  `actions/create-github-app-token@v3`, `repositories: ${{ matrix.repo }}`) to mint a token scoped to the new
  repo. If the GitHub App behind this isn't installed on the new repo, every sync/backfill step for it fails
  with an access error. Fix in GitHub: Organization settings → GitHub Apps → the relevant app → Configure →
  add the new repo to its repository access list.
- **`SHIPSCOPE_APP_ID` / `SHIPSCOPE_APP_PRIVATE_KEY`** — used inside the reusable `notify-deployment.yml`
  (called *from* the new component's own repo) to mint a token scoped to `evdt-service-shipscope`, so it can
  fire the `repository_dispatch` back here. These are passed as `secrets:` into that reusable workflow call
  — if they're org-level secrets already visible to "All repositories," nothing to do; if they're scoped to
  a selected-repository list, add the new repo to it.

## 3. Wire up the new component's own repo

In the new component's repo, add workflow steps for:

- **Faster sync** — add **one** workflow file to the repo's **default branch**,
  `.github/workflows/notify-shipscope.yml`. It watches the deployment workflows with `workflow_run` and
  calls the reusable `notify-deployment.yml` after each successful one. Without it, the new component is
  still synced, just only by the daily 3 AM cron safety net in `orchestrate-full-sync.yml`, not
  immediately after each deploy.

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

  Why a separate file instead of a `notify_shipscope` job inside each deployment workflow: GitHub reads a
  workflow from the branch that triggered it, so a deploy started from a long-lived branch such as
  `deployment/qa` (a `trigger.properties` bump) runs that branch's copy, which lacks any step added only
  on `main`, and ShipScope never hears about it. `workflow_run` workflows are only ever read from the
  default branch, so one file there covers every branch and every environment, with nothing to keep in
  sync per branch. Do **not** also keep a `notify_shipscope` job in the deployment workflows (a leftover
  one only causes a duplicate, harmless dispatch).

  Notes: the file must be merged to the default branch before it does anything (it cannot be tested from a
  feature branch); `component` is the repo's own name, which `notify-deployment.yml` also checks against
  `docs/components.json` and the calling repo; the secrets must be repository- or organization-level, not
  environment secrets (the job declares no `environment:`). Verify with one real deploy: "Notify
  ShipScope" should run in the Actions tab and `orchestrate-full-sync.yml` should receive a dispatch. A
  renamed deployment workflow silently stops matching — update `workflows:` when that happens.
- **Build-time flags, if applicable** — add a workflow calling the reusable `check-flags.yml`
  (`workflow_call`) from this repo, the same way `evapl-service-frontend` does. Skip this if the component
  has no build-time flags (e.g. it's a backend service or infra repo).

## 4. If it has build-time flags: make sure `featureFlagsIncluded` is `true` in `docs/components.json`

`retrigger-app-checks.yml` (re-runs failed `check-flags` runs in app repos after `flags-meta.json` changes
on `live`) is a matrix over every component in `docs/components.json` with `featureFlagsIncluded: true` —
no per-component workflow edit needed. It also mints a GitHub App token scoped to that one component's
repo per matrix entry, so the shared app (`CIRCLEK_GLOBAL_GITHUB_EVDT_APP`) needs to actually be installed
on the new repo too, same as any other cross-repo call in this doc — just setting `featureFlagsIncluded`
isn't enough on its own if the app itself was never installed there.

## 5. Optional: backfill historical deployments

Once real deployments start flowing in for the new component, run `backfill-deployment-metadata.yml`
manually (`workflow_dispatch`) if there's pre-existing deployment history worth enriching — it fills in
`workflowRunUrl`/`durationMs`/`manual`/`rollback`/compare-range `commitUrl`/resolved `deployedBy` display
name/re-resolved `version` for records that predate those fields. It's capped per run
(`MAX_RECORDS_PER_RUN`) and safe to re-run.

## What you don't need to touch

- **`scripts/*.js`** — every sync/backfill script is already component-agnostic, driven entirely by
  `COMPONENT`/`APP_REPO` env vars set by the workflow.
- **`docs/app.js` / `docs/index.html`** — the component list, filter dropdowns, and Jira project-key
  detection are all derived dynamically from `docs/data/deployments.json` at render time. The Technical
  view's row order already follows `docs/components.json` (fetched client-side) automatically — nothing
  extra to edit for that either.
- **Jira integration** — `sync-jira.js` derives which Jira project keys to pull automatically from
  `relatedIssues` already present in `deployments.json`, so no per-component Jira configuration is needed as
  long as the new component's commit messages reference Jira keys in the usual `XXX-123` format.