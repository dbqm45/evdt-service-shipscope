# Unified flag-value ingest

*Polska wersja: [FLAG-INGEST.pl.md](FLAG-INGEST.pl.md)*

Status (2026-10-15): steps 1–3 done (`flag-ingest.js`, both scripts moved onto it, `ingest-flags.js`), plus the composite action `.github/actions/ingest-flags` and a "last message" freshness marker (`flag-ingest-meta.json`). Not done: `flagSource` in `components.json` and the staleness signal in the UI. The action has not yet run in a real workflow.

## Problem

ShipScope obtains flag values in two ways: from files in the app repo (`flag-parts/`, `*.generated.ts`) and from URLs (`sync-runtime-be-flags.js`). We want to keep the freedom to choose the source without rewriting ShipScope for every new one.

The unified *output* format already exists: `docs/data/flag-states.json` (key → env → source → `{enabled, changedAt, changedBy, component}`). What was missing is a unified *input*. Three scripts write to that file and each carried its own copy of the same logic:

- `resolve-all-flag-states.js` (files),
- `sync-runtime-be-flags.js` (URLs),
- `update-flag-state.js` (manual dispatch).

Each separately did: component collision guard, `flags-meta.json` scaffolding, idempotent `changedAt`, an entry in `flag-state-history.json`. A new source would have meant a fourth copy.

## Decision

**A shared ingest core plus thin adapters**, no separate server (consistent with the "no server" model, see `INTEGRATION-VISION.md`). It is a deterministic function, not a stateful "orchestrator".

```
adapter (per source)  →  observations  →  ingest core  →  flag-states / flags-meta / history
```

### Core: `scripts/lib/flag-ingest.js`

`applyObservations(...)` takes over everything that used to be duplicated: the collision guard (`::error::`, no throw), `flags-meta` scaffolding, idempotency (no change = no write and no history entry), history. The behavior of the existing scripts must not change; the tests in `test/` protect that.

### Contract (intermediate format)

```json
{
  "schemaVersion": 1,
  "component": "evapl-service-frontend",
  "source": "runtime-be",
  "observations": [
    { "key": "myFlag", "env": "prod", "enabled": true }
  ]
}
```

Optional observation fields: `observedAt`, `changedBy`, `value`, `kind`.

### Adapters

| Adapter | Source | Notes |
|---|---|---|
| `url` | current `sync-runtime-be-flags.js` | default, "zero work on the app side", cron as a safety net |
| `flag-parts` | current `resolve-all-flag-states.js` | `build` flags from files |
| `payload` | new `ingest-flags.js` | reads JSON in the contract and validates it; the app repo generates it however it likes (Actuator, a file, an external system) |

## Resolutions

### 1. Value type: boolean for now, extensible contract

Every consumer assumes `enabled: boolean` (`effectiveFlagState()`, released/deployed/partial statuses, stale flags, Insights, history). Variants/percentages/strings would force rewriting all of those now with no real need (YAGNI).

- `enabled: boolean` is mandatory; `value`/`kind` are optional and for now only stored or ignored.
- `schemaVersion` is in the contract from v1, so non-boolean flags can be added as v2 without breaking repos that send v1.
- If a concrete non-boolean flag needs displaying, design it together with the UI from the start.

### 2. Transport: push as the main path, URL (pull) as fallback

- **Push (`payload`)**: the app repo's workflow knows its source and has access to it; ShipScope does not need addresses or credentials. Matches the onboarding vision (install the GitHub App + ShipScope config). The pattern already exists in `check-flags.yml`. Also handles sources invisible from a GitHub runner, and immediate changes.
- **Pull (`url`)**: the option with no work on the app side, plus cron.
- **Why not push only**: it fails silently (precedent: `notify-deployment.yml`, a deploy without a `notify_shipscope` step simply vanishes). For push components we record a "last message from the component" marker and show stale data in the UI.
- **Why not pull only**: it cannot reach sources with no network access from the runner, nor deliver immediate changes.

Per-component configuration in `docs/components.json` (planned, not implemented):

```json
"flagSource": { "type": "url", "urls": { "test": "...", "qa": "...", "prod": "..." } }
// or
"flagSource": { "type": "payload" }
```

Onboarding stays a single edit in a single place, as today.

## Threats and security requirements

- **`component` must not come from the payload.** The collision guard relies on this field; if a repo declared it itself it could impersonate another component. It must derive from the caller's identity (repo name / GitHub App token → mapping onto `components.json`).
- **Transport**: `repository_dispatch` has a `client_payload` limit (10 fields, ~65 KB), so it does not suit large sets. Same pattern as `check-flags.yml`: the workflow in the app repo calls the script with a JSON file.
- **Payload validation**: schema, size limits, rejecting `__proto__`/`constructor`/`prototype` keys (as in `update-flag-state.js`), `env` only `test`/`qa`/`prod`. Input is not trusted.
- Executable code still comes only from `main` (the `main`/`live` split in `CLAUDE.md`); the payload is data.

## Implementation plan

1. ✅ Extract `flag-ingest.js` from `sync-runtime-be-flags.js` (no behavior change, covered by tests).
2. ✅ (partially) `resolve-all-flag-states.js` moved onto the same core. `update-flag-state.js` deliberately stays as is: it is a manual single-flag change with no `COMPONENT` and no collision guard, so it does not fit `applyObservations`.
3. ✅ Add `ingest-flags.js` (`payload` adapter): schema validation, `COMPONENT` supplied externally, not from the payload.
4. ✅ (partially) Composite action `.github/actions/ingest-flags` binds the component to the caller's identity. **Not done:** `flagSource` in `components.json` (deferred: in `payload` mode nothing reads it; it is only needed for pull and freshness).
5. ✅ (partially) Freshness marker: `ingest-flags.js` writes `docs/data/flag-ingest-meta.json` (`{ [component]: { lastMessageDay, source } }`, day granularity so as not to break "no change = no commit"). **Not done:** the staleness signal in the UI — waiting for the first component that actually sends a payload.

## To do

### Before merging to `main`

- [ ] Verify the refactor on real data: after the merge to `live`, run `sync-runtime-be-flags.yml` and `check-flags.yml` by hand and confirm the `docs/data` diff is empty. So far checked only with fixture-based tests.
- [x] Validate `action.yml`: no `actionlint`/PyYAML available, so checked by hand on 2026-10-15 — the three `run` blocks pass `bash -n`, no tabs, every `steps.<id>.outputs.*` reference points at an existing step id, and the action versions (`actions/checkout@v7`, `actions/create-github-app-token@v3` with `client-id`), the `.components[]` jq path and the `flags-meta-changed` dispatch match the existing workflows. Still not run on a real runner.
- [ ] Remember the one visible difference from the refactor: `resolve-all-flag-states.js` prints the collision summary before the `Resolved…` line (stderr; tests do not assert it).

### Action pilot (blocked: no changes to service-repo workflows for now)

- [ ] Check whether service repos may use actions from `circlek-global/evdt-service-shipscope` (an org-level setting for actions; reusable workflows from there already work, but this is a separate setting, unchecked).
- [ ] Pick one component and run the action with a real payload. Verify: default-branch guard, rejection of a repo not in `components.json`, push with retry, sending `flags-meta-changed`, idempotency of a second run.
- [ ] The action has no tests of its own (only the scripts are tested); decide whether YAML/bash code needs any automated test.

### Further rollout steps

- [ ] `flagSource` in `components.json` (`url` or `payload`) and have cron read it to know which components to poll.
- [ ] Staleness signal in the UI from `flag-ingest-meta.json` (proposed threshold: 48 h, shown only for components that have sent a payload at least once).
- [ ] Optionally: the `url` adapter as a regular input of the contract (today `sync-runtime-be-flags.js` builds observations itself, which is enough).

### Documentation

- [x] English version of this document.
- [x] One-sentence pointer to this document in `design-docs/ARCHITECTURE-NOTES.md` and `.pl.md`.
- [ ] A mention of the `payload` route in `ONBOARDING.md` / `ONBOARDING.pl.md`, only after a successful pilot.

### Deliberately deferred

- Non-boolean values (`value`/`kind`, `schemaVersion: 2`): only with a concrete case, together with a UI change (`effectiveFlagState()`, statuses, stale flags, Insights).

## Use from a service repo (opt-in)

The component is derived from the caller's identity (`github.event.repository.name`, the same pattern as `check-flags.yml`/`notify-deployment.yml`), must be in `components.json`, and writing only works on the default branch. The action is composite (not a reusable workflow) so it can see the workspace of the job that produced the payload.

```yaml
- name: Build flag payload
  run: ./scripts/dump-flags.sh > flags-payload.json   # any source
- uses: circlek-global/evdt-service-shipscope/.github/actions/ingest-flags@main
  with:
    payload-path: flags-payload.json
    shipscope-app-id: ${{ secrets.SHIPSCOPE_APP_ID }}
    shipscope-app-private-key: ${{ secrets.SHIPSCOPE_APP_PRIVATE_KEY }}
```

## Open questions

- ~~Where to keep the "last message" marker?~~ Resolved: a separate `flag-ingest-meta.json` (`sync-meta.json` means "full sync confirmed"). Staleness threshold: 48 h in the UI, only for components that have sent a payload at least once (no entry = the component does not use push, show nothing). To be done together with the UI.
- ~~Should `build` flags also go through the `payload` adapter?~~ Resolved: they stay on `flag-parts` (`check-flags.yml`); `payload` is an additional, optional route. Nothing changes in service-repo workflows.
