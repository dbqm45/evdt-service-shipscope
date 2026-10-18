# Repository Guidelines

ShipScope is a multi-tenant deployment / feature-flag / Jira dashboard: a backend in `server/` (Fastify + Postgres, its own `package.json`; see `@context/foundation/prd.md`) syncs data per tenant and serves the static vanilla-JS frontend in `docs/`. The original file-based sync lives only in `circlek-global/evdt-service-shipscope`, not here. Full depth lives in `@CLAUDE.md`.

## Hard rules

- Every query on a tenant table in `server/` goes through `withScope()` (`server/lib/scope.js`, `RLS_TABLES`); every new tenant table cascades from `tenants`.
- `scripts/` (release tooling) and `server/` never require from each other, and `adapters/` (the flags adapter) requires from neither; `docs/app-*.js` never call `require()` (`node scripts/check-module-boundaries.js`).
- `docs/app-*.js` load as classic `<script>` tags in a fixed order (see `@docs/index.html`); `app-main.js` must stay last since it calls `init()`. Top-level statements can only use things from the same or an earlier file. Markup goes through the `html` tagged template (`docs/app-html.js`).
- Zero dependencies at the root by design (`@package.json`); `server/` has its own (`pg`, `fastify`, `@fastify/cookie`) — don't add an npm package without discussing it first.

## Security

- Secrets only through environment variables; the repo holds only `server/.env.example`. `.env*` and `*.pem` are gitignored.
- External input (HTTP bodies, OAuth callbacks, webhooks, GitHub/Jira responses) is validated before use; Fastify rejects unknown fields and wrong types.

## Build, test, and development

- `npm test` runs the root suite (`node --test "test/*.test.js"`: frontend, release scripts, boundary check); `cd server && npm install && npm test` runs the backend's (real-Postgres tests need `TEST_DATABASE_URL`, see `@server/README.md`).
- Run everything locally with `npm run dev` (Node 20+, Docker): database, migrations, server and worker, then it prints the link to open; `npm run dev:mock` serves sample data on the dashboard for UI work. Opening `docs/index.html` directly shows built-in sample data.

## Coding style & testing

- Plain JavaScript, no TypeScript, no linter/formatter configured — see `@CLAUDE.md`'s "Type discipline" section for the compensating convention (JSDoc shapes at function boundaries; validate external input before use).
- Tests use Node's built-in `node:test` + `node:assert`, not Jest/Mocha — no `jest.fn()` / `expect(...).toHaveBeenCalledWith(...)`.

## Commits & CI

- Commit messages and PR titles follow Conventional Commits with the `SHP` scope (`feat(SHP): ...`); PRs are squash-merged, so the title decides the version.
- `.github/workflows/` runs both test suites on every PR and push to `main` (`test.yml`, `server-test.yml`), checks the PR title (`pr-title.yml`) and releases after each merge (`release.yml`, see `@RELEASING.md`).
