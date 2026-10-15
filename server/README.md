# ShipScope server

This is a **walking skeleton**, not an implementation of the SaaS-pivot PRD's features. Its only job is to
prove the Render deployment pipeline works end-to-end: a Web Service and a Background Worker both deploy,
both reach a real Postgres instance, and both can be observed via `render logs` and recovered via
`render rollback`. No GitHub OAuth, tenant creation, GitHub App webhook handling, or Jira OAuth logic lives
here yet — see `@context/foundation/prd.md` for that scope, and `@context/foundation/infrastructure.md` for
why Render was chosen.

This directory is a separate dependency boundary from the repo root: it has its own `package.json` and is
the **first place in this repo with a third-party dependency** (`pg`, the Postgres client — see
`@CLAUDE.md`'s "Backend (server/)" section). Nothing at the repo root changes because of this directory;
`npm test` at the root still only runs the existing `test/*.test.js` scripts, untouched.

## Running locally

- `npm install` — installs `pg`.
- `npm test` — runs this directory's own `node:test` suite (mocked pool, no real Postgres connection needed).
- `DATABASE_URL=postgres://... npm start` — runs the Web Service (`GET /health`, `GET /health/db`).
- `DATABASE_URL=postgres://... npm run worker` — runs the Background Worker (heartbeat loop).

## Deployment

Declared as Render Blueprint services in `@render.yaml` at the repo root (`rootDir: server` for both the Web
Service and the Background Worker). See `@context/foundation/infrastructure.md`'s "Getting Started" and
"Operational Story" sections for the full deploy/rollback/secrets workflow.
