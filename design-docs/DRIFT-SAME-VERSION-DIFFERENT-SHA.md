# Drift notes on environments showing the same version label

Status: **root cause found, addressed by configuration** (see the last update, "root cause: trigger commits").
Originally recorded 2026-10-12 as open; the sections below are kept as written at the time.

## Observation

In the Technical view, a service shows the same version on QA and PROD, yet PROD carries
"417 behind QA" and "N commit(s) skipped QA".

Concrete case, read from `docs/data/deployments.json` on `live` (service
`evnm-service-charger-infrastructure`):

| Env | Version label | `resolvedRef` (SHA) | Deployed (UTC) |
|---|---|---|---|
| QA | `v1.4.19` | `9999cc58b9c463b5e6ddd2fec025e35dd49fd3d0` | 2026-10-08 04:44 |
| PROD | `v1.4.19` | `ba8fe699174ab92f9f7c128cf02784d1e8174032` | 2026-10-08 11:44 |

The latest PROD record carries `driftBehind: { behindEnv: "qa", commitCount: 417, untestedIn: "qa",
untestedCommitCount: 325 }`. (The reporter quoted 235 for the second number; `live` said 325 — either a
typo or the data moved after the last sync. Unverified.)

## Why the numbers are what they are (from the code)

- `computeEnvDrift()` in `scripts/sync-github-deployments.js` does **not** compare version labels. It calls
  GitHub `compare/{laterRef}...{earlierRef}` using `resolvedRef || version`, and skips the call only when
  the two refs are string-equal.
- `commitCount` = `ahead_by` (commits on QA that PROD lacks); `untestedCommitCount` = `behind_by` (commits on
  PROD that QA never had). Both non-zero means the two commits are on **diverged histories**, not on one
  line of ancestry.
- `resolvedRef` is a raw SHA, i.e. no GitHub Release or tag points exactly at either commit. The displayed
  `v1.4.19` therefore most likely came from the version-like regex over the commit message
  (`extractPromotedVersion`), which is display-only (see CLAUDE.md → Deployments). Equal labels are not
  evidence of equal code.

## Hypothesis (unverified)

QA and PROD were built from different branches/histories that carry the same version number — e.g. a
release branch vs. mainline after squash-merges — so `compare` reports hundreds of commits each way even
though the release is "the same version" in the team's mind. This would be correct output from ShipScope
with a misleading label, not a counting bug.

## How to confirm

1. Open
   `https://github.com/circlek-global/evnm-service-charger-infrastructure/compare/ba8fe699174ab92f9f7c128cf02784d1e8174032...9999cc58b9c463b5e6ddd2fec025e35dd49fd3d0`
   — if GitHub also shows hundreds of commits each way, ShipScope is counting correctly.
2. Check whether a `v1.4.19` tag/Release exists and which commit it points at; check which branches the two
   commits belong to and what each pipeline builds from.
3. Look at the two commit messages to see where each `v1.4.19` label came from.

## Options if the pattern is real

1. Show an explicit warning on the drift note when the version labels are equal but the SHAs differ
   ("same version label, different commits").
2. Suppress drift when labels are equal and neither commit is backed by a tag/Release (risk: hides a real
   hotfix that reuses a label).
3. Leave as is, and rely on the existing drift legend/tooltip (`driftNoteTooltip()`, `FAQ.md`) which already
   documents "bypassed that environment".

Preference noted so far: none decided — pick after step 1 above.

## Related

- CLAUDE.md → Deployments (`driftBehind`, `resolvedRef` vs displayed `version`).
- `scripts/sync-github-deployments.js` `computeEnvDrift()`; `scripts/lib/deployment-records.js` (drift merge).
- Insights → "Rollbacks & drift over time" counts these same records.

## Update 2026-10-12 — confirmed and partially implemented

- Step 1 done by the reporter: GitHub's compare for the two SHAs shows **417 commits**, matching `commitCount`.
  So ShipScope's counting is correct; the misleading part was the "N behind" framing for two builds that
  carry the same version label.
- Implemented (option 1, narrowed): `computeEnvDrift()` now adds `sameVersion: true` to a `driftBehind` entry
  when the later and earlier env show the same `version` label but different refs. The Technical view env
  card then renders **one** note, "same version, different build: A / B commits vs QA" (A = commits only the
  earlier env has, B = commits only this env has; tooltip via `driftNoteTooltip('sameVersion', …)`), instead
  of "A behind QA" + "B commit(s) skipped QA". The counts themselves are unchanged and still feed the
  summary cards, env-card header and Insights.
- Not done: suppressing drift, tag-to-tag comparison, or using `merge_base_commit` to tell plain lag from
  diverged histories. Existing records pick up the flag on their next sync.

## Update 2026-10-12 (later) — root cause: trigger commits; fixed with `versionFile`

### What was found

Investigated with the GitHub API on `evapl-service-frontend`, which showed "1135 behind test" (same pattern as
the case above):

| Env | Deployed commit | What the commit is | `trigger.properties` there |
|---|---|---|---|
| QA | `4f516edc…` | "Deploy v1.6.0 to QA" — head of `deployment/qa`, changes only `trigger.properties` | `version=v1.6.0` |
| PROD | `0c8141d7…` | "Deploy v1.6.0 to PROD" — head of `deployment/prod`, changes only `trigger.properties` | `version=v1.6.0` |
| test | tag `v1.7.0` | the shipped code itself (no `trigger.properties` at that commit — 404) | — |

- The real code is tag `v1.6.0` (`45fdc8c8…`, "feat(CHG-4640): Enabled export on PROD"). No GitHub Release exists.
  Neither deployed SHA is that tag, so the `v1.6.0` label ShipScope showed came from the commit-message regex.
- `compare` QA…`v1.7.0`: ahead 1135 / behind 239, `diverged`; PROD…QA: 239 / 71, `diverged`. All three share one
  merge base (`4cdd725d`), i.e. they are parallel lines, not one promotion path. Tree SHAs all differ, so
  `sameTree()` correctly did not suppress anything. QA vs PROD differ in 5 files, all deployment-branch
  plumbing (`CODEOWNERS`, a workflow, `.gitignore`, `README.md`, `trigger.properties`), not application code.
- Conclusion: `computeEnvDrift()` was counting git-history distance between **trigger commits on separate
  `deployment/*` branches**, not between shipped code. The numbers were correct as git facts and meaningless as
  a "how far behind" signal. The hypothesis above ("different branches carrying the same version number") was right.
- `evnm-service-charger-infrastructure` and the other services work the same way (confirmed by the team, not
  re-verified through the API).

### Fix (configuration only, no code change)

`"versionFile": "trigger.properties"` is now set in `docs/components.json` for all six components
(`evboweb-service-frontend` already had it). The mechanism already existed (see CLAUDE.md → Tracked components).

### Current behaviour, per environment

For each deployment, `sync-github-deployments.js` calls
`GET /repos/circlek-global/<component>/contents/trigger.properties?ref=<deployment SHA>` — the file **at the
deployed commit**, not the branch head — and parses `version=…`.

1. If the value is an existing tag (`v1.6.0`), it becomes `version`, `resolvedRef` and the compare ref.
2. Otherwise it is resolved as a commit (`/commits/<value>`) and that SHA is used; `version` keeps the label.
3. On a missing file, API error or unresolvable value it falls back to the previous behaviour (SHA /
   release / tag / regex); never fails the sync, logs `could not resolve trigger.properties version`.

Effect on the Technical view:

- **QA and PROD** both resolve to `v1.6.0`. Equal refs skip the compare, so the QA→PROD drift note disappears.
- If they differ, `compare` runs tag-to-tag, so counts are commits of real code, and rollback detection
  (`status: "behind"`) works on tags too.
- **test** deploys from the code commit itself, which has no `trigger.properties` (404 → logged warning →
  fallback), so it keeps its tag (`v1.7.0`). That warning on every test deployment is expected.
- `sameVersion` stays as a safety net for components without `versionFile`, or where the file can't be resolved.

### Rollout and limits

- `orchestrate-full-sync.yml` reads `components.json` from **`live`**, so the change takes effect only after
  `sync-main-to-live.yml` has merged it; running the sync earlier changes nothing.
- Drift of the latest records is recomputed on every sync, and records not yet marked `versionFromFile` get the
  ref from the file on the fly, so the dashboard should correct itself at the first sync. Not yet observed on `live`.
- Only **newly synced** deployments get the correct `version`/`relatedIssues`; `backfill-deployment-metadata.js`
  does not redo them, so older records keep theirs until `RETENTION_DAYS` trims them.
- The file value must be an existing tag or ref. Not checked per component: `evboweb-service-bff` showed QA
  `4.2.15` (no `v` prefix) before this change, which may not be a tag name.
- The sync's GitHub App token needs `contents: read` on every app repo (it already reads commits/compare there).

### Still not done

Suppressing drift by label, using `merge_base_commit` to separate lag from divergence, and counting changed
files instead of commits. Revisit only if a component without a trigger-commit pipeline shows the same pattern.

### Update: file-level "Diff to ENV" (supersedes "counting changed files instead of commits" above)

The card no longer shows commit counts. `sync-github-deployments.js` compares the two deployed commits' git trees
(`compareTrees()`, `scripts/lib/tree-diff.js`): identical tree, or a difference only in the component's
`driftIgnorePaths` (`docs/components.json`, e.g. `.github/`, `README.md`, `trigger.properties`), means no drift. The
card shows only "Diff to ENV"; the modal shows the number of differing files, the first 20 paths and the raw Git
history counts (context only — they measure commits, not code). A truncated or failed tree listing is stored as
`diff: { unknown: true }` and shown as Unknown. A tree comparison covers repository files only; it does not
prove the deployments are otherwise identical. Records synced before this change have no `diff` until their next sync.
