# Product view — implementation plan

*Polska wersja: [PRODUCT-VIEW-IMPLEMENTATION-PLAN.pl.md](PRODUCT-VIEW-IMPLEMENTATION-PLAN.pl.md)*

> **Status: proposed plan, not yet approved for implementation.** This turns the gap analysis in
> `PRODUCT-VIEW-NOTES.md` into concrete, buildable phases. Nothing in this plan has been coded. Phases
> whose first step is "decision:" are explicitly blocked on an answer from `PRODUCT-VIEW-NOTES.md`'s "Open
> questions carried over" section — do not start coding them on an assumed answer.

## How to read this plan

Each phase lists: goal, the open decision it depends on (if any), concrete file/data changes, and how to
verify it in this repo's no-test-suite reality — either a small, throwaway Node script run once against a
sample/mock JSON fixture (not committed, same spirit as how this working session itself validated
`sync-jira.js` changes), or a manual check in a browser against `docs/index.html` with either the
built-in `FALLBACK` dataset (open via `file://`) or a hand-edited copy of real `docs/data/*.json`.

Phases are ordered to implement first, fastest; items gated on an unmade decision are pushed to the end so
they never block ready-to-build work.

## Priority order and why

| Order | Gap | Why here |
|---|---|---|
| 1 | **A** — ghost flag aging alert | Named repeatedly (Q2/Q4/Q5) as the single most valuable missing signal, and — this plan's own finding — cheaper than `PRODUCT-VIEW-NOTES.md` assumed: `docs/app.js` already fetches `flag-state-history.json` into `state.flagStateHistory` and already computes "days since a flag's state last changed" in two places (`flagStaleWarning()`, `staleFlagDaysBreakdown()`). Gap A is the *mirror* of that existing logic (days flag has been OFF after a deploy, not days ON after everything's Done) — new condition, reusable scaffolding. No new sync script, no schema change. |
| 2 | **D** — bug-blocks-epic signal | Small, additive, no open decision blocking it, directly serves the same PM sign-off use case Gap A serves. Natural pair with Gap A: ship both in the same release. |
| 3 | **E** — hide-Tasks toggle | Cheapest item on the list (per `PRODUCT-VIEW-NOTES.md`'s own call), no open decision, but lower value than A/D so it comes after them, not before. |
| 4 | **F** — 4-bucket relabeling | Purely cosmetic (per the notes) and the open question is "which language," not "whether" — low risk, low value, do it once copy is agreed, any time after the functional work above. Placed before B/C so it isn't blocked by them. |
| 5 | **B** — hybrid temporal scope | Genuinely useful but has an explicit open question ("replace or add a third option?") this plan should not resolve unilaterally — starts with a decision step. Moderate cost (touches the sprint-scope filter, the summary tiles, and `piWorkItemCounts()`). |
| 6 | **C** — Team/board grouping | Confirmed in the notes as "the single biggest net-new data-model piece in this whole list" — this plan's own code reading confirms that cost estimate holds (see Phase 6). Also has the most open questions (custom field id, schema change, UI shape, SAFe-level question). Goes last: biggest, most decision-dependent, and nothing else in this plan depends on it. |

Rationale for diverging slightly from a pure "value then cost" sort: D is cheap *and* thematically
coupled to A (both are "is this epic actually ready," surfaced near the same UI), so shipping them together
is cheaper than context-switching back to Gap A's area later just for D.

## Explicitly excluded from this plan

Per `PRODUCT-VIEW-NOTES.md`'s "Explicitly out of scope" — not planned here, not touched by any phase below:
- Letting PM/PO toggle feature flags from ShipScope.
- Pulling flag state into Jira, or vice versa.

---

## Phase 0 — groundwork (no visible change) — ✅ done

**Goal.** Confirm the two decisions Gap A actually needs before writing any code for it (Gap A is first in
priority, so its decisions can't wait for a dedicated "decisions" phase).

**Resolved.** Threshold: **30 days**. Scope: **per-row/per-epic, within whichever PI is currently loaded**
— no cross-PI scan. See Phase 1.

**Decisions needed (ask the user, do not assume):**
- *decision:* threshold unit and value for "ghost flag" aging — days (recommended, see Gap A's reasoning
  in `PRODUCT-VIEW-NOTES.md`: sprint length isn't uniform across boards) or sprints. If days, the exact
  number. The session's own language ("od 3 sprintów") suggests ballpark 30–45 days as a reference point,
  but the actual number is a business call, not something to default silently.
- *decision:* scope — a per-row annotation only on whichever PI/issue happens to be visible right now
  (cheap, consistent with the "ShipScope shows current state, not a scanning tool" principle already
  established elsewhere in this repo), or a dashboard-wide cross-PI list independent of what's loaded
  (needs scanning every PI shard, which the architecture deliberately avoids elsewhere). This plan's Phase
  1 below assumes the per-row answer, since nothing elsewhere in the codebase cross-scans PI shards and
  doing so here would be a new, costly precedent — but confirm before coding.

**Changes.** None — this phase is a go/no-go checkpoint, not code.

**Verification.** N/A.

---

## Phase 1 — Gap A: "ghost flag" aging alert (per-row) — ✅ done

**Goal.** Surface "deployed to prod N days ago, flag still OFF" directly on a work item's row/Epic rollup,
reusing the days-since-`changedAt` pattern already proven in `flagStaleWarning()`/`staleFlagDaysBreakdown()`.

**Depends on.** Phase 0's two decisions (threshold value, scope = per-row).

**Data already available (no new sync script, no schema change):**
- `state.flagStateHistory` (from `docs/data/flag-state-history.json`, already fetched in `loadData()`,
  `docs/app.js` ~line 468) — append-only, never trimmed, has every flag flip ever recorded.
- `state.deployments` — gives `deployedAt` for the relevant component/env.
- `effectiveFlagState()` (existing) resolves the *current* flag state per key/env, same helper
  `flagStaleWarning` already uses.

**New logic (`docs/app.js`):**
1. `ghostFlagAge(issue, env)` (new, name tentative) — mirrors `issueStatusForEnv`'s notion of "deployed but
   not released": for an issue whose `issueStatusForEnv(issue, env).level` is `deployed` (code shipped,
   flag off) or `partial`, compute `now - max(deployment's deployedAt for that env, the flag's last OFF
   `changedAt` for that env)`. Reuse the existing `linkStatus()`/`issueLinks()` plumbing already in
   `issueStatusForEnv` rather than re-deriving link resolution. `deployed_code_only` (no flag at all) is
   explicitly out of scope for this alert — there is no flag to be "ghosted".
2. A `GHOST_FLAG_DAYS` constant (value from Phase 0's decision) next to the existing `STALE_FLAG_DAYS`
   constant, with a comment distinguishing the two ("stale ON" vs. "ghost OFF" — opposite directions of the
   same mechanism).
3. Wire the result into:
   - `renderIssueRow()` — a new tag/badge next to the existing `jiraStatusTagHtml()`/`subtasksTagHtml()`
     row tags (e.g. "⏳ Deployed to prod 42d ago · flag OFF"), styled as a warning (reuse `.tag-flagged`'s
     visual weight or a new `.tag-ghost-flag` class in `docs/style.css`).
   - `epicRollup()`/`renderEpicHeader()` — a small count badge ("2 ghost flags") next to the existing "N/M
     released to prod" bar, scoped to the epic's *in-scope* children (same children `epicRollup` already
     receives), so it respects whatever sprint/type/priority filters are active, consistent with that
     badge's existing scoping rule.

**Open copy/visual decision (defer to whoever reviews the PR, not blocking):** exact icon/wording,
whether it needs its own color token in `docs/style.css` or reuses `var(--nd-warn)`.

**Files touched.** `docs/app.js` (new function + 2 render call sites), `docs/style.css` (one new badge
style, if not reusing an existing class), `CLAUDE.md` ("Frontend" section — document the new per-row/epic
signal the same way every other row-level signal there is documented).

**Verification (no test suite).**
- A throwaway Node script (not committed) that `require()`s nothing (this is browser JS, not a module) but
  copy-pastes the new pure function body with a few hand-built fixture objects (one issue `deployed` 90
  days ago with flag OFF since then, one `released`, one `deployed_code_only`) and asserts the expected
  ghost/no-ghost result and day count — same throwaway-script pattern already used elsewhere in this
  session for validating pure logic.
- Manual check: open `docs/index.html` via `file://` (uses the built-in `FALLBACK` dataset) or temporarily
  edit a local copy of `docs/data/flag-states.json`/`deployments.json` to backdate a `changedAt`/
  `deployedAt`, confirm the badge appears on the right row and epic rollup, and disappears once the flag
  flips to `released` or the deploy is too recent.

---

## Phase 2 — Gap D: bug-blocks-epic signal — ✅ done

**Goal.** A visible marker on an Epic header when any in-scope child is an open Bug — "this Epic isn't
really done for sign-off even though its Stories look fine."

**Depends on.** Nothing (no open decision in the notes for this gap).

**Changes (`docs/app.js`):**
1. New helper `epicHasOpenBug(children)` — `children.some(c => c.type === 'Bug' && c.statusCategory !==
   'done')`, same `children` list already passed into `epicRollup()` (so it's scoped identically: respects
   whatever Type/Priority/sprint filter already narrowed the list, matching `epicRollup`'s own documented
   scoping rule).
2. `renderEpicHeader()` — render a small, high-contrast badge (e.g. a red/orange "🐞 open bug" tag) next to
   the existing `epicRollup` progress bar when `epicHasOpenBug` is true. Session wants it prominent ("na
   samej górze") — place it in `.wi-epic-badges` (next to the Epic's own status tag) rather than buried in
   the progress row, so it's visible even when the epic is collapsed.

**Files touched.** `docs/app.js`, `docs/style.css` (one new badge class, can likely reuse the existing
`tag-status-blocked` red styling rather than invent a new color).

**Verification.** Same throwaway-fixture-script approach as Phase 1 (fixture Epic with one open Bug child
and one without); manual check in browser with a hand-edited `jira-issues/{pi}.json` shard containing a
`type: "Bug"`, `statusCategory: "indeterminate"` child under a known `epicKey`.

---

## Phase 3 — Gap E: hide-Tasks toggle — ✅ done

**Goal.** A one-click way to hide Tasks without losing the ability to see every other type at once (today's
`#filterTypeGroup` is single-select, so picking "Story" hides Bugs too — not what this gap wants).

**Depends on.** Nothing (no open decision in the notes beyond "is single-select good enough" — this plan
answers it: no, build the toggle, since the notes already conclude the single-select is "functionally
close, but not" the same thing).

**Changes:**
- `docs/index.html` — add a small checkbox/toggle next to `#filterTypeGroup` (e.g. `#filterHideTasks`),
  not a new entry inside the existing segmented control (keeps the existing single-select Type filter's
  semantics untouched; this is an independent, additional exclusion layered on top).
- `docs/app.js` — wherever the current type filter is applied to `state.jiraIssues` before
  `groupIssuesByEpic()`/`issuesInSprintScope()` runs, add `&& (!hideTasks || issue.type !== 'Task')` to
  that same filter chain. Needs to compose correctly with the existing Type single-select (if "Task" is
  explicitly selected in the segmented control *and* the hide-Tasks toggle is also on, the toggle wins and
  the list is empty — acceptable, mirrors how an impossible filter combination already behaves elsewhere
  in Product view with no special-casing).
- Clear/reset behavior: decide whether the "Clear" button (used for Type/Priority) also resets this toggle.
  Recommended: yes — it's an ordinary filter, not a scope control like Sprint/PI, so it should behave like
  the rest of the filter row, not like `#filterSprint`.

**Files touched.** `docs/index.html`, `docs/app.js`.

**Verification.** Manual browser check: toggle on, confirm Tasks vanish from both ungrouped list and epic
children while Stories/Bugs remain; toggle off, confirm they return; confirm "Clear" resets it.

---

## Phase 4 — Gap F: visual relabeling to the session's 4-bucket language

**Goal.** Purely cosmetic — align `statusLabel()`'s English pill text (and/or add Polish copy) with the
session's framing: "W locie (Test)" / "Do akceptacji (QA)" / "Wdrożone technicznie (Prod, flag OFF)" /
"Wydane (Released)".

**Depends on.** *decision:* which language — the session was conducted in Polish, but `docs/app.js`'s UI
text today is English-first. This plan does **not** pick for the user; the open question in
`PRODUCT-VIEW-NOTES.md` is explicit about this. Two sub-options to put in front of the user:
1. Keep English pill text, just reshape the wording to match the *framing* (e.g. "In flight (Test)" /
   "Pending acceptance (QA)" / "Shipped, flag off (Prod)" / "Released").
2. Introduce literal Polish copy — which would be the first instance of non-English UI text in this
   English-first dashboard, a bigger precedent than it looks and worth flagging explicitly rather than
   deciding by default.

**Changes (once decided).** `statusLabel()` is the single source of truth for this text today — change the
4 (5, counting `deployed_code_only`'s current "Code deployed") string literals there. No other function
needs to change; everything else already reads through `statusLabel()`/`statusClass()`.

**Files touched.** `docs/app.js` (one function), possibly `docs/style.css` if new copy needs different
badge widths.

**Verification.** Manual visual check only — this is copy, not logic. Confirm no layout overflow with the
new, likely longer, strings on narrow viewports.

---

## Phase 5 — Gap B: hybrid temporal scope within an Epic — ✅ done

**Goal.** Default Product view scope becomes "current sprint's items (any status) + older-sprint items in
the same PI that aren't yet released" instead of today's blunt exact-sprint-match filter.

**Resolved.** Third, explicit option (not a replacement for the default); hybrid scope shared by both the
issue list and the summary tiles, same as today's sprint scope.

**Depends on.** *decision:* does this **replace** "current sprint" as the default (today's `refreshSprintSelect()`
pre-selects the current sprint by name), or does it become a **third, explicit option** next to today's
"All sprints" / one named sprint? This plan recommends the third-option framing — it's reversible,
doesn't change existing muscle memory for anyone already using the Sprint selector, and is a smaller diff
— but this is explicitly listed as unresolved in `PRODUCT-VIEW-NOTES.md` and must be confirmed first.

Also *decision:* does the hybrid scope apply only to the issue list, or also to the summary
tiles/`piWorkItemCounts()` (today both already share one scope via `issuesInSprintScope()` — diverging
them would be a user-visible inconsistency worth calling out explicitly, not an implementation detail).
This plan recommends: both share the same scope, same as today, for consistency — but confirm.

**Changes (assuming "third option" + "both tiles and list" are confirmed):**
1. `docs/app.js` — `SPRINT_ALL` currently the only sentinel; add a second sentinel, e.g.
   `SPRINT_CURRENT_PLUS_UNRESOLVED`, alongside the existing literal-sprint-name values in
   `state.selectedSprint`.
2. `issuesInSprintScope(issues)` — when the sentinel is active, replace the current `names.includes
   (i.sprint)` filter with: `currentSprintNames().includes(issue.sprint) || (isRealPi(issue.pi) &&
   prodStatusBucket(issue) !== 'released')`. Needs `prodStatusBucket` (already defined above
   `issuesInSprintScope` in the file) in scope — it already is.
3. `refreshSprintSelect()` — add this as a new `<option>` (label e.g. "Current sprint + unresolved"),
   decide its position in the list (recommended: directly after "All sprints", before the literal sprint
   names) and whether it becomes the new default selection or "All sprints"/current-sprint-literal stays
   default (another sub-decision folded into the main one above).
4. Epic handling: `groupIssuesByEpic()`/`epicRollup()` need no change — they already operate on whatever
   list `issuesInSprintScope()` produced, by construction.

**Files touched.** `docs/app.js`, `docs/index.html` only if the new option needs explanatory UI (e.g. a
tooltip on `#filterSprint`).

**Verification.** Throwaway fixture script: 3 issues — one in the current sprint (any status), one in an
older sprint already `released`, one in an older sprint still `deployed` — assert the hybrid filter keeps
exactly the first and third. Manual browser check with a real multi-sprint PI shard.

---

## Phase 6 — Gap C: Team / board-based grouping and filtering

**Goal.** Resolve a `Team` per issue (Jira field → board fallback → `Unassigned`) and surface it as a
top-level filter/grouping dimension, per the session's Q6 resolution rule.

**Depends on — multiple decisions, all currently open in `PRODUCT-VIEW-NOTES.md`:**
- *decision:* exact Jira custom-field id/name for `Team` (needs a real lookup against the org's Jira
  instance — same kind of lookup `sync-jira.js` already does for Sprint/Epic Link/Flagged via
  `schema.custom`/field-name matching; cannot be guessed, must be confirmed against the live Jira
  metadata, e.g. via `GET /rest/api/3/field` once, manually, before coding).
- *decision:* `docs/jira-spaces.json` schema change — today `boards` is `string[]`
  (`{ name, boards: ["Sparks"] }`, confirmed by reading the current file). Gap C needs each board to carry
  a team label, e.g. `boards: [{ name: "Sparks", team: "Team Rocket" }]`. This is a breaking schema change
  for an existing config file with real content — needs sign-off, not just an inferred shape, and
  `resolveSpacesConfig()`'s existing string/object dual-shape handling (it already supports a space entry
  being a plain string *or* an object — see `scripts/sync-jira.js` ~line 302-323) would need a parallel
  dual-shape handling for board entries (plain string "no team label" vs. object "has one"), to stay
  backward compatible with any space still using the old plain-string board list.
- *decision:* dashboard altitude — the notes' own open question: is this dashboard used ART/PM-wide (Team
  filter should be a prominent top-level control, PM view = "All teams" with a per-row tag) or per-team/PO
  (filtered down to one team as the primary mode)? This changes the UI shape materially (filter dropdown
  vs. a fundamentally different default view) and must be answered before UI work starts, not inferred
  from code.

**Changes, once all three decisions are made:**

*Backend (`scripts/sync-jira.js`):*
1. Read the `Team` custom field (same `schema.custom`-based lookup pattern already used for Sprint/Epic
   Link — see how `sprintFieldId`/`epicLinkFieldId`/`flaggedFieldId` are resolved once per run and passed
   into `fetchAndMapIssuesForJql()`) and map it onto each issue's record as `team` (nullable).
2. **New bookkeeping, called out explicitly in the notes as not existing today:** when an issue is pulled
   in via a board's active-sprint JQL (`resolveCurrentPiForSpaces`/`buildCurrentPiJql`), record *which*
   board actually matched it. Concretely: `fetchAndMapIssuesForJql` (or its caller) needs to carry the
   board (and now, its team label) through to each issue it returns, likely by querying per-board instead
   of merging all of a space's boards into one JQL blob before the issue mapping step — a real control-flow
   change to how `buildCurrentPiJql`/`runCurrentPiMode` batches boards today, not a one-line addition.
3. Resolution order written onto each issue: `team = jiraTeamField || boardTeamLabel || null` (the `null`
   case rendered as "Unassigned / To clarify" client-side, not baked into the stored data — keeps the raw
   signal distinguishable from a deliberate label downstream, consistent with how `application` on
   components already treats a missing value as "falls back," not as a stored string).
4. `writePiShards()` — no scope-rule change needed, `team` is just a new field riding along on the
   existing per-issue object.

*Frontend (`docs/app.js` / `docs/index.html`):*
5. A new filter control, shape depending on the altitude decision above — most likely a `<select>` next to
   the global PI selector (if ART/PM-wide altitude) or a dedicated "my team" default (if per-team/PO
   altitude), populated from the distinct `team` values present in `state.jiraIssues` (same
   `refreshProductViewFilterOptions()`-style per-PI-derived option list pattern Type/Priority already use).
6. Grouping: decide whether Team becomes a *second* grouping axis above Epic (Team → Epic → issues) or
   stays a flat filter alongside Type/Priority/Sprint with just a per-row tag. The notes don't resolve
   this explicitly — flag it as a UI design decision for whoever picks up this phase, informed by the
   altitude decision.

**Files touched.** `scripts/sync-jira.js` (field resolution + board-provenance tracking — the largest
single code change in this whole plan), `docs/jira-spaces.json` (schema), `docs/app.js`, `docs/index.html`,
`CLAUDE.md` (new field in the domain model section, schema-change note in the `jira-spaces.json` section).

**Verification.**
- `sync-jira.js` has no test suite either; verify with a scratch run against a real (or sandboxed) Jira
  project with `Team` populated on at least one issue and empty on another, inspecting the written shard
  JSON by hand for the expected `team` value and fallback behavior.
- Frontend: throwaway fixture script for the new filter/grouping logic; manual browser check against a
  hand-edited shard with 2+ distinct `team` values plus one `null`.

**Risk flag.** This phase is large enough, and dependent on enough live-Jira-specific facts (the actual
custom field id, how many boards really lack a `Team` value in practice), that it should probably be
re-scoped into its own smaller phases once the three decisions above are answered — this plan sketches the
shape, not a final task breakdown, deliberately, since committing to one now would be guessing past what's
actually known.

---

## Summary table

| Phase | Gap | Blocked on a decision? | Relative cost | New sync-script/schema work? |
|---|---|---|---|---|
| 0 | — (groundwork) | Yes — Gap A's threshold + scope | — | No |
| 1 | A | Resolved in Phase 0 | Low (reuses existing patterns) | No |
| 2 | D | No | Low | No |
| 3 | E | No | Low | No |
| 4 | F | Yes — language choice | Very low | No |
| 5 | B | Yes — replace vs. add option; tiles scope | Medium | No |
| 6 | C | Yes — field id, schema shape, altitude | High | Yes — field resolution, board-provenance tracking, `jira-spaces.json` schema |
