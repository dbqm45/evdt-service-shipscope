# Onboarding a new component

*Polska wersja: [ONBOARDING.pl.md](ONBOARDING.pl.md)*

This is a practical checklist for making a new app repo/component show up in ShipScope. For the underlying
mechanics (why the steps are split this way, the `main`/`live` branch model), see `CLAUDE.md` — this
document only lists what to do, in order.

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
shows up under its own name instead of being dropped. This is the single source of truth:
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

- **Faster sync** — call the reusable `notify-deployment.yml` (`component: <repo-name>`) right after a
  successful deploy, passing the `SHIPSCOPE_APP_ID`/`SHIPSCOPE_APP_PRIVATE_KEY` secrets through. Without
  this, the new component is still synced, just only by the daily 3 AM cron safety net in
  `orchestrate-full-sync.yml`, not immediately after each deploy.
- **Build-time flags, if applicable** — add a workflow calling the reusable `check-flags.yml`
  (`workflow_call`) from this repo, the same way `evapl-service-frontend` does. Skip this if the component
  has no build-time flags (e.g. it's a backend service or infra repo).

## 4. If it has build-time flags: check `retrigger-app-checks.yml`

`retrigger-app-checks.yml` (re-runs failed `check-flags` runs in app repos after `flags-meta.json` changes
on `live`) is currently hardcoded to only target `evapl-service-frontend` — it is **not** a matrix over
`docs/components.json`. If the new component has build-time flags, this workflow needs to be extended
(matrix, or an additional job) to also cover it; otherwise metadata-completion retriggers will silently
never reach the new component.

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