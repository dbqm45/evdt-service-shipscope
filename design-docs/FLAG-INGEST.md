# Flag-value ingest in the file-based sync

*Polska wersja: [FLAG-INGEST.pl.md](FLAG-INGEST.pl.md)*

> **Scope: the file-based (single-tenant) sync only** — `scripts/`, `docs/data/*.json` on `live`. The server
> has its own contract (`POST /api/flags/ingest`, `schemaVersion: 2`, named flag sources with their own tokens;
> see `server/README.md`) and deliberately does not reuse this one. New flag sources should go through the
> server; this path is not being developed further.

## What it is

Three scripts write flag values to `docs/data/flag-states.json` (key → env → source →
`{ enabled, changedAt, changedBy, component }`). Two of them share one core instead of carrying copies of the same
logic:

```
adapter (per source)  →  observations  →  scripts/lib/flag-ingest.js  →  flag-states / flags-meta / history
```

`applyObservations()` does the collision guard (another component already owns this key's state for this source:
`::error::`, skipped, not thrown), `flags-meta.json` scaffolding and the `components` union, idempotency (no change
= no write and no history entry) and the `flag-state-history.json` entries. The scripts own file I/O and how the
values are obtained.

| Adapter | Source | Notes |
|---|---|---|
| `resolve-all-flag-states.js` | `flag-parts/` files in the app repo (`check-flags.yml`) | `build` flags |
| `sync-runtime-be-flags.js` | per-environment URLs returning `{ flag: true\|false }` | `runtime-be`; the only one that corrects an existing `flags-meta` `source` (`correctMetaSource`) |
| `ingest-flags.js` | a JSON payload produced by the app repo (any source) | validates the payload, see below |

`update-flag-state.js` (one manual flip, no `COMPONENT`) deliberately does not use the core.

## Payload contract (`ingest-flags.js`, `schemaVersion: 1`)

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

Other fields (`observedAt`, `changedBy`, `value`, `kind` were reserved for later) are ignored: every consumer
assumes a boolean `enabled`. The script also writes `docs/data/flag-ingest-meta.json` (`{ [component]: { lastMessageDay,
source } }`, day granularity so an unchanged run still commits nothing).

Security rules, all enforced:

- **`component` never comes from the payload.** It is passed as `COMPONENT` from the caller's identity; a payload
  naming another component is rejected — otherwise a repo could impersonate another and defeat the collision
  guard.
- Input is untrusted: schema check, at most 5000 observations, a key pattern, `__proto__`/`constructor`/
  `prototype` rejected, `env` only `test`/`qa`/`prod`, `enabled` boolean, no conflicting duplicates.
- Executable code still comes only from `main` (the `main`/`live` split in `CLAUDE.md`); the payload is data.

## State

The core, both moved scripts and `ingest-flags.js` are in place and tested. **Not in this repository:** the
composite action `.github/actions/ingest-flags` that was meant to bind `COMPONENT` to the calling repo — see
[TODO.md](TODO.md). Without it nothing calls `ingest-flags.js` from a workflow today.
