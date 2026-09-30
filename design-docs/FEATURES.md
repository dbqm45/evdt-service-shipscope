# Feature notes — candidate features for ShipScope

*Polska wersja: [FEATURES.pl.md](FEATURES.pl.md)*

> **Status: exploratory, not decided.** This document records candidate features that came up in
> discussion, along with the findings gathered while assessing feasibility. Nothing here has been
> implemented. Each section is source material for an eventual decision, not a decision in itself.

## CI health check per component (Sonar / Checkmarx / ESLint / Orca)

### Motivation

Grafana (or whatever else the org uses for monitoring) has no visibility into code-quality/security scan
results — that lives in each tool's own UI, or scattered across GitHub Checks on each app repo. ShipScope
already aggregates "what's deployed" and "what's toggled" per component; a third signal — "is this
component's code currently clean, or does something need a look" — fits the same model and the same
audience.

### Desired semantics

A three-state indicator (e.g. a colored dot/heart) per component, **not** meant to show exact finding
counts — just enough to tell whether something needs attention:

- 🟢 **Green** — everything checked came back clean.
- 🟡 **Yellow** — nothing is actually broken, but something is inconclusive (skipped, disabled, no recent
  run, etc.) — "needs a look," not "is broken."
- 🔴 **Red** — at least one check reported an actual failure/error.

### What was found investigating `evapl-service-frontend`

Local clone of `evapl-service-frontend` is stale (last commit 2026-06-11) and could not be refreshed —
`git fetch` fails with a 403 because `circlek-global` enforces SAML SSO and Git Credential Manager needs
re-authorizing. `gh` CLI is not installed in this environment either. Findings below are from what was
locally available plus workflow files the user pasted directly.

- **The app repo itself has almost no CI config.** The only workflow present is
  `prod-on-demand-deployment.yml`. All actual build/lint/test/scan logic lives in a **shared, reusable
  workflow**: `circlek-global/arp-global-workflow-build-npm@v7` (`build-npm.yml`). This is org-centralized,
  not per-repo — to know how a given tool reports results, you have to read the reusable workflow, not the
  app repo.
- **Sonar** — runs as two steps inside the shared `build_code` job: `sonarsource/sonarqube-scan-action@v7`
  then `sonarsource/sonarqube-quality-gate-action@v1.2.0`. The quality-gate action only fails the *step* on
  an `ERROR` gate status — a `WARN` gate (where it still exists; modern SonarQube/SonarCloud quality gates
  have mostly deprecated the `WARN` status in favor of just `OK`/`ERROR`) would not be visible via the
  GitHub Actions conclusion at all. Getting a real `OK`/`WARN`/`ERROR` requires calling Sonar's own Web API
  (`api/qualitygates/project_status`) directly with `SONAR_HOST_URL` + a token.
- **Checkmarx** — runs as its own job (`checkmarx-scan`) via a custom internal action,
  `circlek-global/sdlc-global-action-checkmarx@v4`, which wraps the Checkmarx One CLI (`ast-cli`) and covers
  SAST, SCA, IaC Security, API Security, Container Security, and SCS in one go. That job's permissions are
  `contents: read`, `issues: write`, `pull-requests: write` — **no `security-events: write`**, which is a
  strong signal it does **not** upload SARIF to GitHub Code Scanning; it must report via PR comments/issues
  instead. A real per-severity status would require calling the Checkmarx One API directly with
  `CHECKMARX_ONE_CLIENT_ID`/`CHECKMARX_ONE_CLIENT_SECRET` (already used elsewhere in the org for triggering
  scans, but those are scan-triggering credentials, not necessarily appropriate to reuse for read-only
  polling — see credentials note below).
- **ESLint** (`NPM_LINT_CMD`) — a plain "Run lint" step inside the *same* job as install/build/test, with no
  reporter or annotations. No severity granularity is possible here at all; the best you can get is
  pass/fail for that specific step (via the Workflow Jobs API's per-step `conclusion`, not the job-level
  status, since the job also contains build/test steps that can fail independently).
- **Orca** — not present anywhere in the workflows inspected so far (`prod-on-demand-deployment.yml`,
  `build-npm.yml`, the Checkmarx-CLI-auto-update workflow, the `Publish`/semantic-version workflow). Open
  question: is it wired in somewhere else (a different reusable workflow, a different trigger), run at a
  cloud/infra level rather than per-repo CI, or has it effectively been superseded by Checkmarx One's
  SAST/SCA/IaC/API/Container/SCS suite, which covers overlapping ground? **This blocks finalizing scope** —
  needs to be resolved before committing to an implementation.

### Two implementation paths considered

**A — per-tool native APIs (accurate, but needs new credentials).**
Call Sonar's Web API and the Checkmarx One API directly for real `OK`/`WARN`/`ERROR` (or per-severity)
status. Requires:
- New secrets on the `evdt-service-shipscope` repo itself (Settings → Secrets and variables → Actions) —
  credentials from one repo/org are not visible to another repo's workflows. Worth first checking whether
  `SONAR_TOKEN`/`CX_CLIENT_ID`/`CX_CLIENT_SECRET` are already **organization-level** secrets with
  visibility set to "All repositories" (in which case nothing needs adding).
- Ideally a **separate, least-privilege read-only** credential rather than reusing the scan-triggering
  credentials already used by app repos — an organizational ask to whoever administers Sonar/Checkmarx One,
  not something self-serviceable from this repo.
- A non-secret, per-component mapping to each tool's project key/identifier (e.g. `SONAR_PROJECT_KEY`),
  similar in spirit to the existing `COMPONENT` env var pattern.

**B — GitHub Checks/Workflow Jobs API only (no new credentials) — preferred starting point.**
Reuse the same kind of token ShipScope already has for reading app-repo data (the same category used by
`sync-github-deployments.js`) to read the latest run's conclusion for the relevant job/step per component on
the default branch, and map GitHub's own conclusion values onto the three states instead of true
tool-reported severity:

- 🔴 **Red** — any relevant check's latest conclusion is `failure` (or `timed_out` / `action_required`).
- 🟡 **Yellow** — none are `failure`, but at least one is `skipped` / `neutral` / `cancelled`, or has no
  recent run at all (e.g. the observed `CHECKMARX_ENABLED: false` case in `evapl-service-frontend` — that's
  a `skipped` conclusion today, i.e. "not confirmed clean," not "broken").
- 🟢 **Green** — all relevant checks' latest conclusion is `success`.

This loses true warning-level detail (exact finding counts, Sonar's real gate status, Checkmarx severity
breakdown) but matches the semantics actually wanted here — "confirmed clean / needs a look / broken" — with
zero new credentials and no organizational dependency. **Decision so far: start with B; layer in A per tool
later only if the extra precision earns its provisioning cost.**

### Open items / next steps

1. Find out where (or whether) Orca is actually wired in before finalizing scope.
2. Design `docs/data/health.json` shape (per component × check? per component × environment, mirroring
   `flag-states.json`?) and a new `sync-health.js` / `sync-health.yml`, following the existing script
   conventions (idempotent write, no-op commit when nothing changed).
3. Decide which job/step names count as "the relevant check" per component — these are shared reusable
   workflows, so naming should be consistent across app repos, but this needs confirming across more than
   just `evapl-service-frontend`.

## `dependencies` field on `docs/components.json` entries

### Motivation

`docs/components.json` entries already carry `name`/`description`/`serviceType`/`featureFlagsIncluded` (see
`CLAUDE.md` → "Tracked components"). A `dependencies` field — which other tracked components a given
component depends on — was part of the original schema idea but deliberately left out when
`featureFlagsIncluded`/`description`/`serviceType` were added, since (unlike those three) nothing in
ShipScope actually reads it yet. Recorded here as a real candidate for later, not dropped outright.

### Possible uses, if a consumer is ever designed

- A dependency-graph view (which components a given one relies on, and transitively what could be affected
  if it's down or rolled back) — the most direct use of the field as named.
- Cross-component drift/blast-radius context next to the existing single-component `driftBehind` signal —
  e.g. flagging that a component was promoted to `prod` while a declared dependency wasn't, which today's
  per-component `driftBehind` (test → qa → prod only, within one component) can't see across components.
- Ordering hints for a future "promote in dependency order" check, if that ever becomes a real pain point.

### Open questions before this is worth adding

- **Direction/semantics** — does an entry's `dependencies` list what it *depends on*, or what *depends on
  it*? Getting this backwards silently produces a graph pointing the wrong way; needs to be decided and
  written down before the first real entry, not inferred later from usage.
- **Who keeps it accurate** — unlike `featureFlagsIncluded`/`description`, a dependency list drifts
  silently as real architecture changes (nothing fails loudly when it's stale), so it needs an owner/review
  habit, not just a schema slot.
- **No consumer designed yet** — adding the field now, before any of the above is settled, would just be
  dead schema nobody reads (the same reasoning that kept it out when the object schema was introduced).
  Revisit once one of the "possible uses" above turns into an actual, scoped feature.

## "Insights" tab — three rollup charts

### Motivation

A third tab alongside "Product view (PI)" and "Technical view", surfacing a handful of aggregate signals
that today only exist implicitly, spread across many rows (per-issue release status, per-flag staleness,
per-deployment rollback/drift flags). None of the three charts below compute anything the existing code
doesn't already compute — `issueStatusForEnv`, `effectiveFlagState`, `flagStaleWarning`, and the
`rollback`/`driftBehind` fields already on `deployments.json` records. This is purely a rollup view over
data ShipScope already has; **zero new sync scripts, zero new workflows, zero new data files.**
(Chart 4 below is the one deliberate exception to that last point.)

Deliberately scoped away from generic deployment-frequency/lead-time metrics (see `README.md` → "How this
compares to existing tools") — every chart here is either a release-visibility signal (does the user see
it) or a process-health signal (was the normal promotion path skipped), never a speed metric; that's what
already distinguishes ShipScope from DORA-style tooling and Backstage-style dashboards.

### Chart 1 — Release status per PI (PROD)

A stacked bar per PI, one segment per status, counting `issueStatusForEnv(issue, 'prod')` per issue in that
PI — the exact same per-issue function the Product view already renders one row at a time, just rolled up.
Deliberately **PROD only**, not "best status across environments": ShipScope's whole thesis is "is this
visible to the user," and that's a PROD-only question — a Story that's `released` in `test` but `none` in
`prod` should show up here as not-yet-visible, not get credit for its test-env state. `deployed_code_only`
(the deployment-derived fallback level used when an issue has no flag linked at all) is folded into the
same bucket as `deployed` ("Deployed (hidden)") for this chart specifically — for a PI-level rollup the
distinction ("code shipped, we can't see a flag" vs. "code shipped, flag confirmed off") is the same
practical message: shipped, visibility unconfirmed/hidden.

### Chart 2 — Stale flags: days ON in PROD

One bar per flag, using `effectiveFlagState(flagStates[key].prod)` to get the currently-effective PROD
state, then days elapsed since that state's `changedAt`, sorted descending (longest-standing first). Bars
past `STALE_FLAG_DAYS` (60 — the same threshold `flagStaleWarning` already uses for its per-flag warning)
render amber instead of the default color, so the "this has probably outlived its usefulness" read is
immediate without opening each flag's detail. Sanity-checked against the FALLBACK sample dataset:
`changeCpmsAllowed` has been ON in prod for ~93 days (renders amber), `templateChargersListEnabled` for
~51 days (still under the threshold, renders in the default color) — the threshold behavior is visibly
correct on data already in the repo, not just in theory.

### Chart 3 — Rollbacks & drift over time

Deployments bucketed by month, counting how many that month have `rollback` set, and how many have
`driftBehind.commitCount` or `driftBehind.untestedCommitCount` set (the two `driftBehind` shapes already
computed by `sync-github-deployments.js`: an env lagging behind an earlier one, or an env with commits an
earlier one never saw — a hotfix or direct deploy that skipped normal promotion). This is a "how often is
the normal promotion path being bypassed" signal, deliberately not a speed metric — no deploy count, no
lead time, nothing DORA-shaped. On the FALLBACK sample dataset this renders as an empty state ("No
rollbacks or drift detected in this data") since none of the sample records happen to carry those fields —
expected given they're example data, not a bug in the chart; the aggregation logic is already exercised by
`flagStaleWarning`/`driftBehind` elsewhere and just needs real `deployments.json` records with those fields
set (which `sync-github-deployments.js` already populates today) to show non-empty.

### Chart 4 (candidate, needs a new sync) — PRs per label

#### Motivation

App-repo PRs already carry labels describing the element/type of change, but nothing in ShipScope
aggregates how label X performs after merge. Unlike charts 1-3, **this is not a pure rollup over existing
data** — ShipScope doesn't sync PRs at all today, so this needs a new data file and a new sync path.

#### Sync model — event-driven, not polling

A plain cron/polling sync against the GitHub API would be the most expensive option: its own schedule, its
own rate-limit budget, redundant with what `sync-github-deployments.js` already does. A more efficient
shape: a reusable workflow modeled on `notify-deployment.yml`, invoked from the app repo on **PR merged**
(`repository_dispatch`), append-only write to a new file (mirroring `flag-state-history.json`) — no
polling, cost only on an actual merge, no extra rate-limit spend beyond the event itself.

#### What data is actually worth showing — don't duplicate Grafana/Prometheus

Raw "PR success/failure" counts (CI outcome) are already Grafana/GitHub Insights territory and add nothing
new here. ShipScope's value is in **joining** a PR's label with the domain data it already has, which a
generic CI/CD dashboard has no visibility into:

- time from merging a PR (with a given label) to actually being `released` in prod — joins
  `deployments.json` + `flag-states.json`, a real lead time per change type, not just a CI result.
- correlating a label with `rollback` / `driftBehind.untestedIn` — do PRs under a given label (e.g.
  "hotfix") land as a rollback, or skip the `test`→`qa`→`prod` promotion path, more often than others.
- per PI/component: how many PRs with a given label were merged vs. how many actually reached `released`
  within that same PI — the same shipped-vs-visible bridge app.js already models for issues.

#### Status

Not implemented, scope not settled. Before designing this: decide the new data file's shape (per label ×
month? a flat append-only log like `flag-state-history.json`?), confirm the `notify-deployment.yml` pattern
can actually be reproduced for a PR-merged event without new credentials, and pin down exactly what
"success/failure" means for an already-merged PR (CI status at merge time, not the merge outcome itself,
which by definition succeeded).

### Rendering notes

No charting library — this repo has no build step or dependencies (see `CLAUDE.md`), so all three would be
hand-rolled with plain HTML/CSS (flex-based horizontal bars for charts 1–2, a scrollable column chart for
chart 3 by month), the same constraint already discussed for any dashboard visualization here.

### Status

Charts 1–3 are implemented: a fourth tab, "Insights" (`INSIGHTS_ENABLED` in `docs/app.js`, gated behind
`?insights=1` the same way Release Notes used to be before it graduated to always-on), with three panels
(`#chartPi`, `#chartStaleFlags`, `#chartRollbackDrift`) rendered by `renderPiStatusChart()`/
`renderStaleFlagsChart()`/`renderRollbackDriftChart()`. Hand-rolled CSS (`.bar-row`, `.bar-track`,
`.bar-segment`, `.col-chart`, `.col-bar`, etc.) — no chart library, per this repo's no-dependencies rule.
Chart 4 (PR-per-label) remains not implemented, per its own "Status" above.