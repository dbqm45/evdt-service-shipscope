# Repository Guidelines

ShipScope is a cross-repo deployment / feature-flag / Jira dashboard. Two runtimes share one static vanilla-JS frontend (`docs/`): the multi-tenant SaaS backend in `server/` (Fastify + Postgres, its own `package.json`; see `@context/foundation/prd.md`), and the original file-based sync — dependency-free Node scripts in `scripts/` that write JSON under `docs/data/`, run by GitHub Actions in the original `circlek-global/evdt-service-shipscope` repository (this repository keeps the scripts but not those workflows). Full depth lives in `@CLAUDE.md`.

## Hard rules

- In the file-based setup `main` holds source and `live` holds the bot-mutated data JSON that GitHub Pages serves; code on `live` is never executed. This repository has no `live` branch.
- Every query on a tenant table in `server/` goes through `withScope()` (`server/lib/scope.js`, `RLS_TABLES`); `scripts/` and `server/` never require from each other.
- Every data-mutating script follows read-existing-JSON → merge → write-back and must stay idempotent — a no-op when nothing changed, since workflows only commit on `git diff --staged --quiet ||`.
- Scripts read config from environment variables only, no CLI args. Validate any path input with the existing guard (`@scripts/lib/cli.js`'s `safeRelativePath`).
- `docs/app-*.js` load as classic `<script>` tags in a fixed order (see `@docs/index.html`); `app-main.js` must stay last since it calls `init()`. Top-level statements can only use things from the same or an earlier file.
- Zero dependencies at the root by design (`@package.json`); `server/` has its own (`pg`, `fastify`, `@fastify/cookie`) — don't add an npm package without discussing it first.

## Security

- `.env.local` is gitignored — it's the only local secret file in this repo. The real risk this guards against is documented in `@CLAUDE.md`'s branch-model section: a leaked GitHub App credential reaching the `live` branch and getting executable code run with it.

## Build, test, and development

- `npm test` runs the full suite (`node --test "test/*.test.js"`, ~475 cases); `server/` has its own `npm test`.
- Run one script directly: `node scripts/<name>.js`, after setting its required env vars (see `@CLAUDE.md`'s Scripts table).
- Preview the dashboard by opening `docs/index.html` directly, or serving `docs/` with any static file server.

## Coding style & testing

- Plain JavaScript, no TypeScript, no linter/formatter configured — see `@CLAUDE.md`'s "Type discipline" section for the compensating convention (JSDoc shapes at function boundaries; validate external input before use).
- Tests use Node's built-in `node:test` + `node:assert`, not Jest/Mocha — no `jest.fn()` / `expect(...).toHaveBeenCalledWith(...)`. One test file per script/module under `test/`; top-level scripts are spawned as child processes since they run `main()` on require.

## Commits & CI

- Commit messages and PR titles follow Conventional Commits with the `SHP` scope (`feat(SHP): ...`); PRs are squash-merged, so the title decides the version.
- `.github/workflows/` runs both test suites on every PR and push to `main` (`test.yml`, `server-test.yml`), checks the PR title (`pr-title.yml`) and releases after each merge (`release.yml`, see `@RELEASING.md`).
