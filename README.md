# ShipScope

*Polska wersja: [README.pl.md](README.pl.md)*

ShipScope is a cross-repository dashboard that answers a recurring question: whether a given feature is
actually live for users, or merely deployed with its flag still switched off.

Code being deployed and a feature being released are two different things once feature flags are involved.
ShipScope joins three signals — Jira issues, deployments, and feature flag states — across the `test`, `qa`,
and `prod` environments, allowing engineers and product owners to see the real release status of a piece of
work without manually cross-referencing a deployment log, a flag dashboard, and a Jira board.

It is a static dashboard, with no backend server, fed by scheduled GitHub Actions workflows that pull data
from GitHub, Jira, and backend flag endpoints into JSON files rendered by a plain HTML/JS page.

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

### Release Notes (preview, hidden by default)

A third, experimental tab — grouping the same Jira issues by **application** → PI → sprint (rather than by
PI alone), with a "Fully released to PROD" vs. "In progress" rollup per group. Application grouping comes
from a `docs/components.json` field, not from Jira, since one deployable component can genuinely serve more
than one application (e.g. a shared BFF). It's off by default and only appears when the page is loaded with
`?releaseNotes=1` in the URL — a deliberate soft launch, not a permissions boundary, while it's still being
validated against real data. See [FAQ.md](FAQ.md) for exactly how the rollup is computed.

## How it works

- **Deployments** are retrieved from the GitHub Deployments API for each tracked application repository,
  enriched with related Jira keys, duration, trigger type, rollback detection, and a resolved version
  (Release → tag → commit message → SHA). Older records can be brought up to date retroactively; see
  `scripts/backfill-deployment-metadata.js`.
- **Feature flags** come from two sources tracked side by side: `build` flags, baked in at build time, and
  `runtime-be` flags, toggled live by a backend service. Every change is recorded in a full, append-only
  history (`flag-state-history.json`), and each flag requires a manually completed entry in
  `flags-meta.json`.
- **Jira issues** are fetched via JQL for the projects referenced in recent deployments, with a lightweight
  commit-derived fallback when Jira is temporarily unreachable.

See [FAQ.md](FAQ.md) for the mechanics behind each of these, and `CLAUDE.md` for the full technical
reference.

All of this is orchestrated by scheduled and event-triggered GitHub Actions workflows in
`.github/workflows/`, which write their results as JSON under `docs/data/` and commit them to the `live`
branch, the branch from which GitHub Pages serves the static dashboard.

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
- [ONBOARDING.md](ONBOARDING.md) — checklist for making a new component show up in ShipScope.
- [CLAUDE.md](CLAUDE.md) — full technical reference (scripts, workflows, data model, `main`/`live` split).
- [CHANGELOG.md](CHANGELOG.md) — notable changes over time.
