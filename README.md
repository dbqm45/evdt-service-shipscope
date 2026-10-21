# ShipScope

*Polska wersja: [README.pl.md](README.pl.md)*

ShipScope is a cross-repository dashboard that answers a recurring question: whether a given feature is
actually live for users, or merely deployed with its flag still switched off.

Code being deployed and a feature being released are two different things once feature flags are involved.
ShipScope joins three signals — Jira issues, deployments, and feature flag states — across the `test`, `qa`,
and `prod` environments, allowing engineers and product owners to see the real release status of a piece of
work without manually cross-referencing a deployment log, a flag dashboard, and a Jira board.

It runs as a hosted, multi-tenant service: each organization gets a workspace, connects its GitHub App
installation and Jira site, and sees the dashboard at its own address. The backend (`server/`, Node.js + Postgres)
syncs the data; the dashboard is a plain HTML/JS page (`docs/`).

## Run it locally

```bash
npm run dev
```

Needs Node.js 20+ and Docker. It starts the database, applies migrations, starts the server and the worker, and
prints the link to open; on the first run it asks you to click once to create the GitHub App used for signing in.
`npm run dev:mock` does the same with sample data on the dashboard, for checking UI changes. Details:
[server/README.md](server/README.md#running-locally).

## What it shows

Two views, both reading the same underlying data:

- **Product view (PI)** — Jira Epics, Stories, and Tasks grouped by Program Increment, each with a
  per-environment release status: **Not deployed** / **Deployed (hidden)** / **Released** / **Partial**, plus
  Jira dependency blockers that would prevent a safe release to production.
- **Technical view** — a component-by-environment matrix showing what is deployed where, each flag's state,
  and environment drift; a combined deployment and flag-change timeline (trigger type, duration, links,
  rollback detection, full flag history); and a flags list running three additional checks not found in a
  plain flag dashboard — **blast radius**, **build versus runtime-be divergence**, and **stale flags** —
  made possible by also incorporating Jira ticket status.

See [FAQ.md](FAQ.md) for a detailed explanation of how each of these figures, badges, and checks is
calculated.

### Delivery summary

A third tab lists the Jira issues already released to PROD, by PI → sprint, split into features and bug fixes,
with a Service filter by **application**. See [FAQ.md](FAQ.md) for how "released" is
decided.

## How it works

- **Deployments** are read from the GitHub Deployments API of each tracked repository, through the workspace's
  GitHub App installation, and enriched with related Jira keys, duration, trigger type, rollback detection,
  environment drift and a resolved version (Release → tag → version file → commit message → SHA).
- **Feature flags** are pushed to ShipScope by the workspace's own flag sources (a build step, a flag service),
  each with its own token; ShipScope never reads them itself. Every change is kept in the flag's history.
- **Jira issues** are synced from the boards an admin picks, through Atlassian sign-in, increment by increment
  (PI, sprint, release or month, depending on the board).

Syncs run every 15 minutes by default and within about 30 seconds of a GitHub or Jira webhook. See
[FAQ.md](FAQ.md) for the mechanics behind each of these, and `CLAUDE.md` for the full technical reference.

ShipScope started as a file-based dashboard (GitHub Actions writing JSON to a branch served by GitHub Pages) in the
original `circlek-global/evdt-service-shipscope` repository, where that setup still runs; this repository holds the
service.

## How this compares to existing tools

There's no single off-the-shelf product that does exactly what ShipScope does, but there are adjacent
categories:

- **Feature flag platforms with "release insights"** — LaunchDarkly, Split.io (now part of Harness), Unleash.
  These show flag state per environment well (like ShipScope's Technical view), and LaunchDarkly's "Code
  References" even links flags to Jira tickets and code. But they generally don't join that with deployment
  history across multiple repos into a single "released vs. deployed-but-hidden" status, and since they don't
  see Jira issue status, they can't warn that a flag gates a mix of finished and unfinished work, or that a
  flag's "done" side has been sitting behind a stale toggle for months.
- **Internal developer portals** — Backstage (open-source, from Spotify), Cortex, OpsLevel, Faros AI. These are
  conceptually the closest match: they aggregate CI/CD, Jira, and GitHub data into a per-service view. But
  they're generally oriented around engineering speed metrics (how often and how fast a team ships — "DORA
  metrics" like lead time and deployment frequency) rather than the
  specific question "is this Epic actually visible to users yet." Getting what ShipScope does out of one of
  these would mean writing a custom Backstage plugin or custom Cortex/Faros logic — i.e. still bespoke work.
- **Deployment/release tracking** — Octopus Deploy, Harness CD. Show what's deployed where, but without a flag
  layer or this kind of Jira linkage.

The specific combination ShipScope covers — deployed code + flag ON/OFF + Jira ticket, joined into one status
per environment, across repos — is a fairly narrow intersection of three axes that most teams either patch
together by hand or build in-house, same as this project. It's closest to a lightweight, self-built "release
readiness dashboard" — the kind of thing that otherwise ends up as a custom Backstage view or a spreadsheet,
not an off-the-shelf SaaS product.

## See also

- [FAQ.md](FAQ.md) — plain-language answers to "how is this specific number/badge calculated?"
- [ONBOARDING.md](ONBOARDING.md) — setting up a workspace.
- [CLAUDE.md](CLAUDE.md) — full technical reference (backend, data model, frontend).
- [server/README.md](server/README.md) — routes, security model, running the server locally.
- [CHANGELOG.md](CHANGELOG.md) — notable changes over time.
