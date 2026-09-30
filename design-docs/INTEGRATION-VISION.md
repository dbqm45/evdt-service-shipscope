# Target vision: connecting services to ShipScope

*Polska wersja: [INTEGRATION-VISION.pl.md](INTEGRATION-VISION.pl.md)*

> **Status: vision, not decided or implemented.** This document describes a possible target model for
> integrating a new service with ShipScope, the friction inherent in today's process, and what is missing
> to reach that target state. It is intended as material for a discussion with business stakeholders about
> priority and cost, not as an implementation plan.

## Objective, stated in one sentence

**Connecting a new service to ShipScope should consist of installing a single GitHub application on that
service's repository and adding a single configuration entry inside ShipScope — with no pull request to
the service's repository, no secrets, and no changes to its CI/CD pipeline — while deployment, status, and
feature-flag data continue to synchronize automatically and promptly, rather than with delay.**

## Current state

Connecting a new service today requires three changes within the service's own repository, not only
within ShipScope:

1. Adding a step that invokes ShipScope's reusable workflow (`notify-deployment.yml`) after each
   deployment, together with the corresponding secrets (`SHIPSCOPE_APP_ID` / `SHIPSCOPE_APP_PRIVATE_KEY`)
   passed into that workflow.
2. If the service compiles feature flags into its build rather than reading them at runtime, adding a
   second step invoking a different reusable workflow (`check-flags.yml`), which scans the service's
   generated source files.
3. Ensuring the new service repository has been granted access to the relevant GitHub App
   (`retrigger-app-checks.yml` additionally requires manual extension, as it is currently hardcoded to a
   single repository).

Each of these is a change to the service's own CI/CD configuration, and therefore subject to the
organization's internal approval process. This is the real source of friction in every onboarding,
independent of how clearly the process itself is documented (see `ONBOARDING.md`).

## What does not work well today

- **The deployment signal is unreliable.** The step that notifies ShipScope lives inside the service's own
  workflow file, and GitHub Actions resolves that file's content from the branch that triggered the run,
  not from `main`. If a service deploys from a long-lived branch (for example, `deployment/qa`) and the
  notification step was added only on `main`, that branch may never notify ShipScope at all. This has
  occurred in practice (an `evnm` deployment to QA) and can recur for any other service using the same
  pattern.
- **The existing safety net addresses the symptom, not the cause.** ShipScope's daily cron job will
  eventually read deployment data from the GitHub API regardless, but this implies a delay of up to 24
  hours rather than continuous synchronization, and only functions to the extent that the deployment
  record was created in GitHub at all.
- **Feature flags follow two distinct mechanisms** (compiled into the build versus read at runtime), with
  differing levels of friction for the owning team, differing data completeness, and a separate CI step
  that can block a service's build if flag metadata is incomplete.
- **Every onboarding is a change to another team's repository**, not only to ShipScope's own. This is the
  primary source of delay and the most costly element of the overall process — more so than any of the
  individual technical issues described above.

## Target vision

### Deployments — a platform-level signal rather than a step embedded in the service's repository

Rather than a step in the service's own workflow, ShipScope listens for deployment events at the GitHub
App level. The App must already be installed on the service's repository for API access to function
today. The signal arrives independently of the workflow file's content on any branch of that repository.
This requires one small, new component responsible for receiving that signal — described in detail in
`DEPLOYMENT-WEBHOOK-PROPOSAL.md`.

### Jira — real-time events instead of PI-scoped polling

Today `sync-jira.js` only ever *pulls*: on a schedule or when triggered, scoped by default to just the
active PI (see `CLAUDE.md`'s Jira issues section), with a broader fallback when no PI can be resolved. It
never learns about a Jira change — a status flip, a sprint starting, an issue relabeled onto a different
PI — until the next run.

Jira Cloud can *push* instead. A webhook, registered once through Jira's admin UI or its
`/rest/webhooks/1.0/webhook` REST API, scoped by a JQL filter and a chosen set of events
(`jira:issue_updated`, a sprint starting, etc.), delivers a JSON payload to a URL on every matching change.
Using this for real needs the exact same new component the deployment webhook proposal above already
requires — a publicly reachable, always-on HTTPS endpoint — with one extra wrinkle: Jira Cloud's classic
webhook deliveries carry no signature to verify (unlike GitHub's HMAC-signed ones), so protecting the
endpoint falls to a shared secret in the URL/header or an IP allowlist instead.

There is a lower-cost middle path that needs none of that new infrastructure: a Jira Automation rule
(built into Jira, no separate app to install) whose action is "Send web request" can call GitHub's own
`POST /repos/{owner}/{repo}/dispatches` endpoint directly on a Jira-side trigger — the same
`repository_dispatch` mechanism every onboarded service's own CI already uses today to notify ShipScope of
a deployment. This keeps all of ShipScope's compute inside GitHub Actions — no listener, no new secret
held by ShipScope — at the cost of configuring an Automation rule per Jira project/space (living inside
Jira, not this repository) and whatever execution quota the org's Jira Cloud plan allots to Automation
rules.

### Feature flags — a single provider, a single integration, for every service

Rather than each service exposing or compiling its own flags independently, every service reads flags at
runtime from one shared feature-flag provider (such as LaunchDarkly or Unleash). ShipScope implements a
single integration against that provider's API — following the same pattern already used for Jira — which
serves every service and environment at once, without a separate mechanism per service.

### Onboarding — two steps, neither touching the service's repository

1. Grant the ShipScope GitHub App access to the service's repository — an administrative action performed
   in the organization's GitHub settings, not a code change.
2. Add an entry to ShipScope's own configuration (the repository name, and optionally a mapping to a
   project in the feature-flag provider).

No pull request to the service's repository. No secrets held by the service. No change to its CI/CD
pipeline.

## Cost and tradeoffs of this vision

This is not a change without cost, and that should be stated plainly to business stakeholders:

- **ShipScope would need to build and maintain its first genuinely continuous piece of infrastructure**
  (an event listener for GitHub webhooks). Today, ShipScope consists exclusively of static files and
  GitHub Actions, with nothing that requires hosting, monitoring, or on-call coverage. This is a first
  step toward operating a service rather than merely a tool, with real maintenance cost and accountability
  for availability.
- **Migrating every service to a shared feature-flag provider (LaunchDarkly, Unleash, or similar) is a
  separate, substantial undertaking**, independent of ShipScope — it involves the cost of licensing such a
  tool and the effort of every team to move its flags from a compiled model to a runtime model. ShipScope
  cannot perform this migration on any team's behalf; it is a precondition, not a ShipScope engineering
  task.
- **The existing CI gate is lost** — today, a service's build fails if a flag lacks a description or
  linked Jira issues. In a model where ShipScope only polls an external API, this check is no longer
  synchronous with the service's build; reproducing it requires an additional mechanism reporting results
  back to GitHub (another piece of infrastructure, and another cost).
- **A single, centralized credential** (an API key for the feature-flag provider, covering every service)
  would be held by ShipScope — fewer secrets distributed across service repositories, but a greater
  concentration of risk in one place.
- **A real, inbound webhook — for either GitHub or Jira — needs the same missing piece: a publicly
  reachable, always-on HTTPS endpoint**, plus a credential sitting on it that's capable of writing to
  `live` (today, a credential like that only ever lives inside GitHub Actions' own encrypted secrets,
  never behind a custom-hosted endpoint). GitHub's webhook deliveries are HMAC-signed; Jira Cloud's classic
  webhooks are not, so a Jira listener would additionally need its own, weaker protection scheme (a shared
  secret or an IP allowlist) in place of that signature check. The Jira Automation → `repository_dispatch`
  route described above avoids this specific cost for Jira, since Jira itself makes the outbound call
  instead of ShipScope receiving an inbound one.

## What is missing to begin — decisions required

1. A business decision on whether and when to migrate to a shared feature-flag provider (LaunchDarkly,
   Unleash, or another), including budget for licensing and the time required from each team to migrate.
2. A decision on who is responsible for maintaining the new ShipScope infrastructure component (the
   GitHub event listener) — team, budget, and accountability for availability and security.
3. Approval for a one-time expansion of the ShipScope GitHub App's scope (additional subscribed events) —
   a configuration change to a single application, not a change to service repositories.
4. A decision on whether and how to reproduce today's CI gate for incomplete flag metadata under the new
   model, or to accept its loss.
5. A decision on whether Jira integration should move to event-driven at all, and if so, which route: a
   real Jira webhook into the same new listener component the deployment proposal requires, or a Jira
   Automation rule per project/space calling GitHub's `repository_dispatch` directly (no new ShipScope
   infrastructure, but configuration living inside Jira instead of this repository).

## Related, more detailed documents

- Technical plan for the deployment event listener (phases, steps, risks): `DEPLOYMENT-WEBHOOK-PROPOSAL.md`.
- Broader discussion of the multi-team model and open questions on data isolation: `ARCHITECTURE-NOTES.md`.