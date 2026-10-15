# Product view — design notes from a SAFe ideation session

*Polska wersja: [PRODUCT-VIEW-NOTES.pl.md](PRODUCT-VIEW-NOTES.pl.md)*

> **Status: exploratory, not decided.** This document synthesizes a six-question ideation session (with an
> AI product-strategy consultant, playing a SAFe PM/PO advisor) against Product view's actual current
> implementation, into a scoped gap analysis and a list of open questions. Nothing here has been
> implemented from this document. Each section is a candidate starting point for a later decision, not a
> decision in itself — same spirit as `FEATURES.md`.

## Source

A conversation (2026-10-01) walking through: what a Product Owner/Product Manager working in SAFe needs
to see on a dashboard like this one; how to scope an Epic → work-item view in time (current PI/sprint vs.
history); the org's actual Jira hierarchy (`Epic → Portfolio Epic → Capability`); feature-flag ownership
(stays with developers for now); and multi-team structure (many Agile Teams, each generally with its own
board, with an optional `Team` field that isn't always populated). The full transcript is preserved in the
conversation history this document was generated from; this file keeps only the conclusions relevant to
Product view's design, mapped against the code as it exists today.

## Current state of Product view (baseline, as of this writing)

For full detail see `CLAUDE.md`'s "Jira issues" and "Frontend" sections — summarized here only as much as
needed to make sense of the gap analysis below:

- Defaults to the org's actual **current PI**, kept in sync with a **full replace** on every sync run (not
  a merge) — an issue that leaves the PI simply isn't in the next fetch, no separate cleanup needed. Any
  **other** PI is only ever a point-in-time snapshot from a manual `BACKFILL_PIS` run, never auto-refreshed.
  This was a deliberate choice, confirmed earlier in this same working session: ShipScope shows the
  current, real state — it is not meant to be a historical-browsing tool (Jira and GitHub already are).
- A **Sprint scope** control (`#filterSprint`, added in this same working session, *before* this ideation
  happened) narrows the loaded PI down to exactly one sprint, or back out to the whole PI ("All sprints").
  Defaults to whichever sprint is active *right now* (resolved from real `startDate`/`endDate` on each
  sprint, no extra Jira fetch). This is a **blunt, exact-match filter** — "show sprint X and nothing else"
  — not the hybrid rule the ideation session actually recommends (see Gap B below).
- Issues group by **Epic** (`groupIssuesByEpic()`) — Story/Task/Bug under their resolved `epicKey`,
  anything else into a trailing "Ungrouped" section. An Epic becomes a pure section header with an
  `epicRollup()` "N/M released to PROD" badge over its children.
- Per-environment status is a 5-level enum (`issueStatusForEnv()`): `none` / `deployed` (code shipped,
  flag off) / `deployed_code_only` (code shipped, no flag to check at all) / `partial` / `released` (code
  shipped **and** flag on). This already *is* the ideation session's "4-bucket" model (see "Already
  aligned" below) — just under different names.
- Feature flags are **read-only** in ShipScope and **not** sourced from Jira — `docs/data/flags-meta.json`/
  `flag-states.json` (current snapshot) and `flag-states-history.json` (**append-only, real history,
  never trimmed** — unlike per-PI Jira data) are a separate pipeline, joined to issues only via
  `flagsMeta[key].jiraKeys`. Flags are managed by developers; ShipScope has no toggle UI.
- No **Team** concept exists anywhere in the data model today. `docs/jira-spaces.json` has a per-space
  `boards` list (used only to resolve the current PI from a board's active sprint — see CLAUDE.md), but it
  doesn't carry team identity, and no Jira issue field is read for team membership.
- The Type filter (`#filterTypeGroup`) is a **single-select** (All/Epic/Story/Task/Bug) — close to, but not
  the same as, a dedicated "hide Tasks" toggle.
- Nothing today measures or alerts on "how long has this been deployed with its flag off."

## Already aligned — no gap, just worth stating explicitly

- **Default to current PI + current sprint.** Exactly what the session recommends as the highest-priority
  default (its Q1/Q5 conclusions). Implemented already, independent of this session.
- **History as secondary, not default.** The session's own ranking ("historia jest potrzebna, ale nie jako
  główny widok") matches the manual-backfill design exactly — a past PI/sprint is reachable, just never the
  starting point and never silently kept current.
- **Flags stay developer-managed, read-only, for now.** Explicitly confirmed by the user mid-session ("na
  razie nie dotykajmy tego tematu, to jest na później") — matches ShipScope's current design; no action
  needed until that changes.
- **Flags are sourced outside Jira.** Also explicitly confirmed by the user — matches the existing
  `flags-meta.json`/`flag-states.json` pipeline; not a gap.
- **"Epic" already *is* the SAFe Feature level here.** The session's Q3 finding — this org's Jira hierarchy
  is `Epic → Portfolio Epic → Capability`, meaning the "Epic" issue type is, in SAFe terms, actually a
  *Feature*. Product view's existing Epic-level grouping is therefore already at the right altitude for a
  PM/PO dashboard — there is **no missing "Feature layer"** to add, just a naming/mental-model note worth
  keeping in mind so a future reader doesn't mistake this for a gap.
- **The underlying 4-state model already exists.** `issueStatusForEnv()`'s `none`/`deployed`/
  `deployed_code_only`/`partial`/`released` levels are the exact same distinctions as the session's "W
  locie (Test) / Do akceptacji (QA) / Wdrożone technicznie (Prod, flag off) / Wydane (Released)" framing —
  see Gap F for the (purely cosmetic) relabeling question this still leaves open.

## Decided and implemented

- **How many PI(s) back should Product view keep data for?** Raised, then answered twice over: first by
  the "current state, not historical archive" reversal earlier in this project (see CLAUDE.md's "Jira
  issues" domain-model section) — the number of PI shards on disk is **not** automatically capped; it
  grows by one every time a new PI becomes current, same spirit as `flag-state-history.json`'s "cheap
  enough to just keep everything." Removing an old PI is a deliberate, one-off, manually-triggered action
  (`scripts/prune-jira-pis.js`), not something the regular sync ever does. A later `claude --agent maja`
  product review of a specific "cap to 3 PI (current + 2 previous)?" proposal reached the same conclusion
  independently: don't cap the data — Release Notes and the Gap A "ghost flag" alert both need to reach
  further back than 3 PI by nature, so a hard cap at the file/sync level would break those, not just
  Product view. If anything should be bounded, it's the *default view* (which PI the global `<select>`
  opens on), not what's kept on disk — and that's already current-PI-by-default. The "3" in any such
  proposal is only as good as how many PI it actually takes to span a reasonable look-back window (e.g.
  "the last 6 months") in this org's actual PI cadence — worth checking against real sprint dates in
  `docs/data/jira-issues/index.json` before picking a number, if a *view-level* default ever needs one.
- **A parent is "fully released" once every one of its children is.** Raised as a follow-up question:
  should an Epic (and, by the same logic, a Story with sub-tasks) only count as "Released" once *all* of
  its children are? For the **Epic** level, yes — `renderEpicHeader()` now shows an explicit, binary
  "Fully released" badge (green, checkmark icon) next to the Epic's own status tag whenever
  `epicRollup()`'s `released === total`, alongside the existing N/M progress bar (which already showed
  this visually at 100% fill, just without an explicit label).

  For a **Story's own sub-tasks**, deliberately **not** extended the same way. A Story's `released`
  status (`issueStatusForEnv()`) is a flag/deployment signal — "is this feature live for real users
  right now" — computed purely from the Story's own linked flag(s). Sub-task completion in Jira is a
  different signal — "is the paperwork around this done." These can legitimately diverge: a flag can be
  correctly ON for users while a trailing sub-task (documentation, a follow-up QA check) is still open in
  Jira, and that is not a bug. Gating a Story's `released` status on its sub-tasks being done would make a
  feature that is genuinely already live read as "not released" over something that has nothing to do
  with whether users can see it — directly working against this dashboard's whole purpose (show the real,
  current production state, not Jira housekeeping status). The existing, separate "{done}/{total}
  sub-tasks" badge already surfaces the "deployed but not done" case without corrupting the release
  signal itself — kept as-is.

## Gaps — candidate features for later

### A. "Ghost flag" aging alert — deployed to prod, flag still off, for too long

**Motivation.** Confirmed as a real, recurring problem in this session ("tak, zdarza się że nie jest to
odkrywane od razu") and called out repeatedly (Q2, Q4, Q5) as the single most PM-relevant signal missing
from a plain status view — SAFe calls this "unconsumed value" accumulating as risk (maintenance cost,
regression risk) with zero benefit to users.

**Key enabling insight.** This does *not* require reaching into old, no-longer-synced PI shards (which
ShipScope deliberately stops keeping current once a PI is no longer "the" current one — see "Current
state" above). The aging signal is fully computable from data that **is** kept as real, continuous
history regardless of which PI is loaded: `flag-state-history.json` (append-only, never trimmed) records
exactly when a flag's prod state last changed, and `deployments.json`'s own retained window (see
`CLAUDE.md`'s "Deployments" section) records when the code itself shipped. "How long has this been hidden"
is `now - max(flag's last prod OFF changedAt, deployment's deployedAt)` — computable without any new sync
script or Jira call, purely from pipelines ShipScope already runs.

**Desired semantics.** A visible alert (e.g. "Deployed to prod 3 sprints ago · flag still OFF") on any
work item whose current prod status is `deployed`/`deployed_code_only`, once it crosses a threshold.

**Open questions.**
- Threshold in days or in sprints? Sprint length isn't guaranteed uniform across boards/teams, so a
  day-based threshold is probably more robust, but a sprint-based one matches how the session's own
  language ("od 3 sprintów") thinks about it.
- Should this surface as a dashboard-wide list independent of which PI is currently loaded (would need a
  cross-PI scan — in direct tension with the cost/correctness principles this session already established
  for *not* auto-scanning every PI), or purely as an annotation on rows already visible while browsing
  whichever PI happens to be loaded (cheap, consistent with today's architecture, but only visible if a
  human happens to load that PI)?
- Exact visual treatment and copy.

**Status.** Not implemented.

### B. Hybrid temporal scope within an Epic — current sprint (everything) + prior sprints (only unresolved)

**Motivation.** The session's own recommended default (Q2, Q4) is more nuanced than a flat single-sprint
filter: show the active sprint's items regardless of status, **plus** older-sprint items in the same PI
that are *not yet* released, while hiding older items that already reached Released — "to pokazuje osobie
produktowej stopień ukończenia całego Epika" without burying it in fully-done history.

**Current state.** The `#filterSprint` control added earlier in this same working session (before this
ideation session happened) is a blunt exact-match filter — "All sprints" or exactly one named sprint — not
this hybrid rule.

**Desired semantics.** Default scope ≈ `issue.sprint === currentSprint OR (issue.pi === selectedPi &&
prodStatusBucket(issue) !== 'released')`.

**Open questions.**
- Should this *replace* "current sprint" as the default, or become a third, explicit option (e.g.
  "Current sprint + unresolved") alongside today's "All sprints" / one specific sprint?
- Does it change the summary tiles/`piWorkItemCounts()` too, or only the issue list below them?

**Status.** Not implemented — the simpler single-sprint selector shipped first, as a v1.

### C. Team / board-based grouping and filtering

**Motivation.** The org has many Agile Teams, mostly one board each, tracked via `docs/jira-spaces.json`'s
per-space `boards` config — but Epics/work can span more than one team, and the `Team` custom field "nie
zawsze" is populated (session Q5/Q6).

**Current state.** No team *concept* (grouping, filtering, a `team` field on the issue object) anywhere in
ShipScope's data model yet. A narrower, exclusion-only use of the `Team` field now exists in `sync-jira.js`
(resolved by field name via `findSpecialFieldIds()`, read via `extractTeamName()`): found concretely
because a cross-team Epic ("Unified reimbursement front-end application," belonging to a different team)
was showing up on the dashboard — its label-derived PI (`PI-27.3`) was correct, since the whole ART shares
one PI numbering scheme, but the Epic itself wasn't this board's work. When an issue's `Team` field is
populated and doesn't match the issue's own space's configured board/team name(s), it's dropped from the
sync entirely. This answers the narrow "keep wrong-team issues out" question above, but is *not* the
Team-as-a-filterable-dimension feature this gap is actually about — no `team` value is stored on a
written issue, there's no UI filter, and the fallback-to-board-when-Team-is-empty step (point 2 below)
still isn't built. The rest of this gap, as originally scoped, stands.

**Desired resolution rule (from the session, Q6).**
1. Jira's `Team` custom field, when populated.
2. Fallback: whichever board (from the existing `boards` config) the issue's sprint actually came from.
3. Fallback: an explicit `Unassigned / To clarify` bucket — in the session's framing, a backlog-health
   signal in its own right ("coś wisi w próżni"), not just a null case to hide.

**Cost/architecture note.** Step 2 needs `sync-jira.js` to record, per issue, *which configured board*
actually matched it — something it doesn't track today (the board-derived JQL just returns issues per
space; nothing on the issue object says which board's active sprint pulled it in). This is a real, new
piece of bookkeeping to design, not just a client-side filter — plus `docs/jira-spaces.json`'s `boards`
entries would need an explicit team label (today they're just board names with no team identity attached).

**Open questions.**
- ~~Exact Jira custom-field id/name for `Team`.~~ Resolved differently than expected: rather than
  hard-coding an id (which really can't be guessed in advance, confirmed while building the exclusion
  check above), `findSpecialFieldIds()` resolves it by matching the field's display *name* ("Team",
  case-insensitive) at runtime — the same technique already used for `Flagged`, since neither field has a
  stable `schema.custom` type to match on instead.
- Whether `docs/jira-spaces.json`'s schema needs to change (`boards: [{ name, team }]` instead of a plain
  string list) and what that means for `resolveCurrentPiForSpaces()`'s existing board-resolution logic.
- UI: a top-level "Team" filter (PM view = All teams with a per-row team tag; PO view = filtered to one
  team) — same shape as the existing PI/Sprint controls, or something else?

**Status.** Not implemented — the single biggest net-new data-model piece in this whole list.

### D. Bug-blocks-epic visual signal

**Motivation.** A Bug sitting in Test/QA under an Epic signals the Epic isn't ready for business sign-off
even if its Stories look fine — the session (Q2, Q3) wants bugs visually prominent, "na samej górze" when
an Epic is expanded.

**Current state.** `jiraStatusTagHtml()` already colors a raw `Blocked` Jira status red, and
`dependencyBlocked`/`dependencyNote` already surface Jira's own "is blocked by" links — but nothing today
specifically flags "this Epic has an open Bug among its in-scope children."

**Desired semantics.** A secondary indicator in the Epic header (next to the existing `epicRollup()`
badge) when any in-scope child is `type: 'Bug'` and not yet `statusCategory: 'done'`.

**Status.** Not implemented — small, additive change to `renderEpicHeader()`/`epicRollup()` once scoped.

### E. Quick "hide Tasks" toggle

**Motivation.** Tasks are the least interesting type for PM/PO (session Q2); a dedicated one-click hide
is more direct than picking through a single-select Type filter.

**Current state.** `#filterTypeGroup` already lets you select exactly one type at a time — functionally
close, but not a "hide just Tasks, keep everything else" toggle.

**Open question.** Is the existing single-select good enough, or does this need a genuine multi-exclude
control?

**Status.** Not implemented — lowest-effort item on this list if pursued.

### F. Visual relabeling into the session's 4-bucket language

**Motivation.** The session's own recommended framing — "W locie (Test)" / "Do akceptacji (QA)" /
"Wdrożone technicznie (Prod, flaga OFF)" / "Wydane (Released)" — maps directly onto `issueStatusForEnv()`'s
existing levels (see "Already aligned" above). This is a presentation decision, not a new capability.

**Open question.** Adopt this literal language (and in which language — the session was in Polish, but
`docs/app.js`'s UI text is English-first today), or keep today's more generic pill wording ("Code
deployed", "Released", etc.)?

**Status.** Cosmetic, not implemented, lowest priority of this set.

## Open questions carried over from the session, still unanswered

- At what SAFe hierarchy level is this dashboard mainly used — ART/PM-wide, or per-team/PO? Affects whether
  Gap C's Team filter becomes a top-level control or just row-level metadata.
- Confirmed: Epic = Feature level here. Is there ever a need to surface Portfolio Epic/Capability *above*
  it, or is Epic the permanent ceiling for this dashboard?
- Exact resolution rule and data source for `Team` when the custom field is empty (Gap C).
- Threshold for the "ghost flag" alert (Gap A) — days or sprints, and what number.
- Whether Gap B (hybrid temporal scope) should replace or sit alongside today's simple sprint selector.

## Explicitly out of scope here (deferred by the user mid-session)

- Letting PM/PO toggle feature flags directly from ShipScope — stays developer-managed for now.
- Pulling flag state into Jira itself, or vice versa — the two stay separate pipelines, joined only via
  `jiraKeys`, by design.
