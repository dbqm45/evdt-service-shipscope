# ShipScope server

`web.js`/`worker.js` started as a **walking skeleton** proving the Render deployment pipeline works
end-to-end — a Web Service and a Background Worker both deploy, both reach a real Postgres instance, and
both can be observed via `render logs` and recovered via `render rollback`. That pipeline work is still all
that's wired up over HTTP (`GET /health`, `GET /health/db`) — no auth, no routes.

`lib/tenants.js` adds the tenant/membership **data layer** (FR-002/FR-003): creating a tenant with its first
admin, and adding members with a role. It is not yet reachable over HTTP — FR-001 (real GitHub OAuth) is
blocked on registering real OAuth credentials, and there's no auth middleware to gate a route with yet. See
`@context/foundation/prd.md` for the full feature scope, and `@context/foundation/infrastructure.md` for why
Render was chosen.

This directory is a separate dependency boundary from the repo root: it has its own `package.json` and is
the **first place in this repo with a third-party dependency** (`pg`, the Postgres client — see
`@CLAUDE.md`'s "Backend (server/)" section). Nothing at the repo root changes because of this directory;
`npm test` at the root still only runs the existing `test/*.test.js` scripts, untouched.

## Running locally

- `npm install` — installs `pg`.
- `npm test` — runs this directory's own `node:test` suite. Tests against a mocked pool (`db.js`,
  `web.js`, `worker.js` coverage) always run; the real-Postgres tests (`migrate.test.js`, `tenants.test.js`,
  `rls.test.js`) are skipped unless `TEST_DATABASE_URL` is set — see "Testing against a real Postgres" below.
- `DATABASE_URL=postgres://... npm start` — runs the Web Service (`GET /health`, `GET /health/db`).
- `DATABASE_URL=postgres://... npm run worker` — runs the Background Worker (heartbeat loop).
- `DATABASE_URL=postgres://... npm run migrate` — applies any pending `migrations/*.sql` files.

## Testing against a real Postgres

The mocked-pool pattern (`db.test.js`) can't verify real schema, transaction, or Row-Level Security
behavior — `migrate.test.js`, `tenants.test.js`, and `rls.test.js` need an actual Postgres instance:

```bash
docker run -d --name shipscope-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node scripts/setup-test-db.js
TEST_DATABASE_URL=postgres://shipscope_app:shipscope_app@localhost:5432/postgres npm test
```

`setup-test-db.js` idempotently creates a non-superuser `shipscope_app` role — tests run as this role
(not the container's superuser) specifically so `FORCE ROW LEVEL SECURITY` is genuinely exercised, the same
way Render's single app role experiences it in production. Each test file gets its own ephemeral schema
(migrated fresh, dropped on teardown), so test files can run in parallel without colliding. CI
(`.github/workflows/server-test.yml`) does the same thing against a `postgres:16-alpine` service container.

## Deployment

Declared as Render Blueprint services in `@render.yaml` at the repo root (`rootDir: server` for both the Web
Service and the Background Worker). See `@context/foundation/infrastructure.md`'s "Getting Started" and
"Operational Story" sections for the full deploy/rollback/secrets workflow.
