# Candidate features

*Polska wersja: [FEATURES.pl.md](FEATURES.pl.md)*

> **Status: not implemented, not decided.** Ideas that came up in discussion, with what was found while
> assessing them. Each is a starting point for a decision, not a plan. Technical debt lives in
> [TODO.md](TODO.md). Checked against the code on 2026-10-17.

## Product view

From a SAFe ideation session (2026-10-01). Of its six gaps, four shipped: the "ghost flag" aging alert, the
hybrid sprint scope ("Current sprint + unresolved"), the open-bug signal on an Epic and the "Hide tasks" toggle
(see `CLAUDE.md` → Frontend). Two remain.

### Team as a filter and grouping dimension

Many Agile Teams, mostly one board each; Epics can span teams; Jira's `Team` field is not always filled in.

- **Resolution rule** (from the session): Jira's `Team` field when set, else the board the issue's sprint came
  from, else an explicit "Unassigned / to clarify" bucket — a backlog-health signal in its own right.
- **In the server this is now cheap:** every stored issue already has the `board_id` it was synced through
  (`jira_issues.board_id`), and a board is a team. Missing: put the board's name on each issue in the dashboard
  data (`listPiIssues()` returns `data` only) and add the filter in `docs/app-product.js`.
- Open: is the dashboard used ART/PM-wide (Team is a filter with a per-row tag) or per team/PO (filtered to one
  team by default)? Team → Epic → issues as a second grouping level, or a flat filter?

### Status pill wording in the session's 4-bucket language

"In flight (Test)" / "Pending acceptance (QA)" / "Shipped, flag off (Prod)" / "Released" map one-to-one onto
`issueStatusForEnv()`'s levels; only `statusLabel()`'s strings would change. Open: keep English and reshape the
wording, or introduce Polish copy (the first non-English UI text — a precedent worth deciding on purpose).

### Questions still open from the session

- Is there ever a need to show Portfolio Epic / Capability above the Epic level? (This org's "Epic" is SAFe's
  Feature, so Epic grouping is already at the right altitude.)
- Out of scope by the user's decision: toggling flags from ShipScope, and syncing flag state into Jira.

## Live updates in an open dashboard

Webhooks now reach the server and the worker syncs within about 30 seconds, but an open dashboard only shows it
after a reload. One Server-Sent Events channel (`GET /api/tenants/:id/events`) telling the page "this changed",
followed by a re-fetch of that slice, would make it live. A long-lived connection per open tab; check it against
Render's limits before building.

## Audit trail of changes

In the original file-based model every data change was a git commit, so `git log` was a free audit log. The server
has history only for flag values (`flag_value_history`);
settings changes (repos tracked, boards, roles, flag links, deletion) leave no trace of who did what. A small
`audit_events` table written next to each admin action would close that.

## CI health per component (Sonar / Checkmarx / ESLint / Orca)

A three-state indicator per component — green (all checks clean), yellow (something skipped, disabled or not run
recently: "needs a look"), red (a check failed) — not finding counts.

Found on `evapl-service-frontend` (2026-10): all build/lint/test/scan logic lives in the org's shared reusable
workflow `circlek-global/arp-global-workflow-build-npm` (`build-npm.yml`), not in the app repo.

- **Sonar**: `sonarqube-scan-action` + `sonarqube-quality-gate-action`; only an `ERROR` gate fails the step. A
  real gate status needs Sonar's Web API (`api/qualitygates/project_status`) and a token.
- **Checkmarx**: job `checkmarx-scan` via `circlek-global/sdlc-global-action-checkmarx` (Checkmarx One CLI:
  SAST, SCA, IaC, API, container, SCS). No `security-events: write`, so no SARIF in Code Scanning; per-severity
  status needs the Checkmarx One API.
- **ESLint**: a plain step in the same job as build/test; only that step's pass/fail is available (Workflow
  Jobs API, per-step `conclusion`).
- **Orca**: not found in any workflow inspected. **Blocks scope**: is it wired in elsewhere, run at the cloud
  level, or superseded by Checkmarx One?

Two paths: **A** — each tool's own API (accurate, needs new read-only credentials from whoever runs Sonar /
Checkmarx); **B** — GitHub's check/job conclusions only, with the token ShipScope already has (red =
`failure`/`timed_out`/`action_required`, yellow = `skipped`/`neutral`/`cancelled`/no recent run, green = all
`success`). Preference so far: start with B. Open: where Orca runs; which job/step names count as "the" check.

## Dependencies between components

Which tracked components a component depends on — for a dependency graph, cross-component drift ("promoted to
prod while its dependency wasn't") or promotion order. Not added because nothing would read it yet. Decide
first: the direction (depends on vs. depended on by), and who keeps it accurate (it goes stale silently).

## Insights: PRs per label

App-repo PRs carry labels for the kind of change; nothing aggregates what happens to them after merge. Raw CI
pass/fail per PR is Grafana/GitHub territory; the value is in joining a label with ShipScope's own data:

- merge → `released` in prod per label (lead time per kind of change);
- labels that land as rollbacks or skip the test → qa → prod path more often (e.g. "hotfix");
- per PI/component: PRs with a label merged vs. reached `released` in that PI.

Needs a new data source: ShipScope doesn't sync PRs. In the server, the GitHub App's `pull_request` webhook
would deliver merges without polling. Open: data shape, and what "success" means for an already-merged PR.
