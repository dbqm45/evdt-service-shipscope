# Repository Guidelines

ShipScope is a cross-repo deployment / feature-flag / Jira dashboard, currently serving one organization with a multi-tenant SaaS rewrite in progress (see `@context/foundation/prd.md`). No app server or build step: dependency-free Node.js scripts, run by GitHub Actions, sync data into JSON under `docs/data/`; a static vanilla-JS page renders it. Full depth lives in `@CLAUDE.md` — read it before touching sync logic or the branch model.

## Hard rules

- `main` holds source (`scripts/`, `.github/workflows/`); `live` holds the bot-mutated data JSON that GitHub Pages serves. Never confuse the two, and never expect code on `live` to be executed.
- Every data-mutating script follows read-existing-JSON → merge → write-back and must stay idempotent — a no-op when nothing changed, since workflows only commit on `git diff --staged --quiet ||`.
- Scripts read config from environment variables only, no CLI args. Validate any path input with the existing guard (`@scripts/lib/cli.js`'s `safeRelativePath`).
- `docs/app-*.js` load as classic `<script>` tags in a fixed order (see `@docs/index.html`); `app-main.js` must stay last since it calls `init()`. Top-level statements can only use things from the same or an earlier file.
- Zero dependencies by design (`@package.json`) — don't add an npm package without discussing it first.

## Security

- `.env.local` is gitignored — it's the only local secret file in this repo. The real risk this guards against is documented in `@CLAUDE.md`'s branch-model section: a leaked GitHub App credential reaching the `live` branch and getting executable code run with it.

## Build, test, and development

- `npm test` runs the full suite (`node --test "test/*.test.js"`, ~420 cases).
- Run one script directly: `node scripts/<name>.js`, after setting its required env vars (see `@CLAUDE.md`'s Scripts table).
- Preview the dashboard by opening `docs/index.html` directly, or serving `docs/` with any static file server.

## Coding style & testing

- Plain JavaScript, no TypeScript, no linter/formatter configured — see `@CLAUDE.md`'s "Type discipline" section for the compensating convention (JSDoc shapes at function boundaries; validate external input before use).
- Tests use Node's built-in `node:test` + `node:assert`, not Jest/Mocha — no `jest.fn()` / `expect(...).toHaveBeenCalledWith(...)`. One test file per script/module under `test/`; top-level scripts are spawned as child processes since they run `main()` on require.

## Commits & CI

- Commit messages follow `type(SHP): Description (#PR-number)` (e.g. `feat`, `refactor`) — Conventional Commits with a ticket prefix.
- `.github/workflows/` has 11 automation workflows (data sync, flag management) but none currently run the test suite on PR — don't assume a broken test blocks a merge yet.
