# Proposal: deployment synchronization via a GitHub App webhook

*Polska wersja: [DEPLOYMENT-WEBHOOK-PROPOSAL.pl.md](DEPLOYMENT-WEBHOOK-PROPOSAL.pl.md)*

> **Status: proposal, not implemented.** This document describes a target solution and the steps required
> to implement it. It does not constitute an architectural decision; it is source material for one.

## Problem statement

The current mechanism for notifying ShipScope of a deployment relies on the deploying service's own
repository invoking a step named `notify_shipscope` (the reusable workflow `notify-deployment.yml`,
defined in `prod-on-demand-deployment.yml`, `qa-on-demand-deployment.yml`, and
`test-auto-deployment.yml`), which fires a `repository_dispatch: deployment-completed` event against
`evdt-service-shipscope`.

This is unreliable by construction: GitHub Actions resolves the content of a workflow file from the ref
that triggered the run, not from `main`. If a deployment is triggered from a long-lived branch (for
example, `deployment/qa`) and the `notify_shipscope` step was added to that workflow only on `main`, any
deployment branch that has not been merged or rebased since will simply not contain that step, and
ShipScope will never receive a signal for that deployment. This applies to every service that shares the
same three-workflow pattern, not to a single repository, and will recur with every future change to those
workflows for as long as the model remains "a step defined inside a per-branch workflow file."

The existing safety net — the daily `schedule: cron '0 3 * * *'` in `orchestrate-full-sync.yml` —
mitigates the symptom rather than the cause. `sync-github-deployments.js` reads deployment data directly
from the GitHub Deployments API, independent of the dispatch, but this only closes the gap if the GitHub
Deployment object itself is still created independently of the missing step, and only with a delay of up
to 24 hours. It does not provide "current, accurate data on every push."

**Objective of this document**: a solution in which ShipScope always receives a deployment signal,
regardless of the workflow YAML content in any given service repository or branch, and without requiring
any change to service repositories — since such changes are subject to an internal approval process.

## Proposed solution

Rather than relying on the deploying service's workflow to actively notify ShipScope, the trigger point is
moved to the GitHub App level. The App is already installed on every tracked repository for API access.
GitHub Apps can subscribe to `deployment_status` (and `deployment`) events across every repository on
which they are installed — an event at the GitHub platform level, independent of any workflow file
content. GitHub delivers these events to a single configured webhook URL.

Because ShipScope has no application server of its own (static files plus GitHub Actions), a small
external listener (a serverless function) is required. Its sole responsibilities are:

1. Receive the webhook.
2. Verify the signature.
3. Map `repository.name` from the payload to a `COMPONENT` listed in `docs/components.json`.
4. Fire the same `repository_dispatch: deployment-completed` event, with the same `client_payload.component`
   shape, that `notify-deployment.yml` fires today.

Critically, `orchestrate-full-sync.yml` requires no change whatsoever — the dispatch contract
(`event_type`, `client_payload.component`) remains identical. The listener only replaces who fires the
dispatch: a per-service workflow step is replaced by GitHub itself, via webhook.

## Implementation steps

### Phase 1 — preliminary decisions

- [ ] TODO: Select a platform for the listener (candidates: AWS Lambda + API Gateway, Cloudflare Worker,
      Azure Function). Selection criteria: existing organizational accounts/permissions, ownership of
      ongoing maintenance, cost.
- [ ] TODO: Determine administrative ownership of this piece of infrastructure (team, repository, access
      to secrets) — the only component in the overall solution that lives outside
      `evdt-service-shipscope`.
- [ ] TODO: Confirm with the platform/security team that adding a webhook at the GitHub App level
      (covering every repository on which the App is installed) does not require the same approval
      process as a workflow change in a service repository — this is a configuration change to a single
      application, not a code change across N repositories.

### Phase 2 — GitHub App configuration

- [ ] TODO: In the settings of the existing GitHub App (the one used by `notify-deployment.yml` and
      `orchestrate-full-sync.yml` — credentials `SHIPSCOPE_APP_ID`/`CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID`),
      add a webhook: `Settings → Developer settings → GitHub Apps → [app name] → Webhook`.
- [ ] TODO: Set the **Webhook URL** to the listener's address (see Phase 3).
- [ ] TODO: Generate and store a **webhook secret**, used to verify the signature
      (`X-Hub-Signature-256`) inside the listener. Store it in the secret manager of the platform chosen
      in Phase 1; never in source code.
- [ ] TODO: Under **Permissions & events**, subscribe to the `Deployment` and `Deployment status` events.
- [ ] TODO: Confirm the App already holds `deployments: read` permission on service repositories (it
      should, since `sync-github-deployments.js` already relies on it); add it if missing.

### Phase 3 — listener implementation

- [ ] TODO: One HTTP endpoint accepting `POST` requests with the `X-GitHub-Event` and
      `X-Hub-Signature-256` headers and a JSON body.
- [ ] TODO: Signature verification — compute an HMAC-SHA256 over the raw request body using the webhook
      secret from Phase 2; reject the request (`401`) on mismatch. This must run before any further
      processing.
- [ ] TODO: Event filtering — handle only `X-GitHub-Event: deployment_status` events, and only when
      `payload.deployment_status.state` corresponds to a terminal state already understood by
      `sync-github-deployments.js` (`STATE_MAP`: `success` / `failure` / `error`); ignore other states
      (`pending`, `in_progress`, `queued`) to avoid firing multiple dispatches for a single deployment.
- [ ] TODO: Map `payload.repository.name` to a `COMPONENT` — fetch `docs/components.json` from `live` via
      the Contents API (the same pattern already used in `notify-deployment.yml`, lines 32–47) and confirm
      the repository is a tracked component. If it is not, discard the event silently; it is not an error
      condition.
- [ ] TODO: Obtain a GitHub App installation token (App ID and private key from Phase 2; standard
      JWT-to-installation-token flow, equivalent to `actions/create-github-app-token`, performed manually
      inside the listener) and issue `POST /repos/circlek-global/evdt-service-shipscope/dispatches` with
      `{"event_type":"deployment-completed","client_payload":{"component":"<COMPONENT>"}}` — identical to
      the contract in `notify-deployment.yml:49-57`.
- [ ] TODO: Logging — record, for every accepted webhook (excluding secrets), the repository, deployment
      ID, state, and dispatch outcome, to support diagnosis without access to the GitHub Actions run
      itself.
- [ ] TODO: Error handling — if the dispatch to ShipScope fails (rate limiting, transient API error),
      return a non-2xx status to GitHub so that GitHub retries delivery automatically; do not build a
      custom retry queue at this stage.

### Phase 4 — testing

- [ ] TODO: End-to-end test on one service: trigger an actual deployment (or manually create a deployment
      status via the API in a test environment); confirm the webhook was delivered, the listener verified
      the signature, the dispatch reached `evdt-service-shipscope`, `orchestrate-full-sync.yml` ran, and
      `docs/data/deployments.json` on `live` was updated.
- [ ] TODO: Test on a deployment branch lacking the `notify_shipscope` step — confirm the new mechanism
      still functions. This is the definitive test that the problem described above has been resolved.
- [ ] TODO: Test resilience against an invalid or forged webhook signature (must return `401` and proceed
      no further).
- [ ] TODO: Test with an unknown repository (not present in `docs/components.json`) — must be silently
      ignored, without generating an error or an alert.

### Phase 5 — rollout and transition

- [ ] TODO: Enable the webhook on the production GitHub App and observe listener logs alongside the
      existing `notify_shipscope` mechanism for a period of time (both mechanisms may operate
      concurrently; a duplicated dispatch is safe, since `sync-github-deployments.js` performs a
      read-merge-write cycle and idempotently filters out already-known deployment IDs).
- [ ] TODO: Once stability is confirmed, decide whether the `notify_shipscope` step in service workflows
      becomes redundant. It may safely remain in place — its removal requires no action and no request to
      any service team.
- [ ] TODO: Decide whether to retain the daily cron in `orchestrate-full-sync.yml` as an additional
      fallback (recommendation: retain it — it is the final line of defense should the listener experience
      downtime; the cost of one additional run per day is negligible).
- [ ] TODO: Configure monitoring and alerting for the listener itself (5xx errors, missing deliveries) —
      without this, a silent listener outage reverts to the same up-to-24-hour delay already present
      today.

## Elements that remain unchanged

- **No changes to service repositories.** `prod-on-demand-deployment.yml`, `qa-on-demand-deployment.yml`,
  `test-auto-deployment.yml`, and deployment branches require no modification — this was the primary
  requirement driving this approach.
- **No changes to `orchestrate-full-sync.yml`.** The `repository_dispatch: deployment-completed` contract,
  with `client_payload.component`, remains identical to today's.
- **`notify-deployment.yml` does not need to be removed.** It may remain as a redundant path without risk
  — the new mechanism does not compete with it; it adds a second signal source, independent of workflow
  content.

## Risks and open questions

1. **This is the first step toward ShipScope owning service infrastructure.** ShipScope currently has
   nothing that runs continuously, holds a secret at runtime, or requires monitoring or on-call coverage —
   everything is static JSON plus GitHub Actions. The listener breaks that property: it introduces a
   persistent endpoint, custody of the webhook secret and the GitHub App private key, and a need to
   observe its behavior. This is not equivalent to becoming a SaaS product (see `ARCHITECTURE-NOTES.md`
   for the separate, larger question of multi-team isolation and self-service onboarding), but
   operationally it is a step in that direction: the first component requiring maintenance, budget, and
   accountability for availability, none of which ShipScope currently has. **This should be an explicit
   decision to accept that ongoing responsibility, not an implicit consequence of shipping this one
   feature.**
2. This is the only component of ShipScope requiring infrastructure outside GitHub Actions/Pages —
   ownership, secret rotation, and budget must be determined.
3. The webhook secret and the GitHub App private key must be stored securely within the listener's
   runtime environment — a different secret-management model from the GitHub Secrets used elsewhere in
   this repository.
4. GitHub automatically retries failed webhook deliveries, but the retry limits and policy for the GitHub
   App type in use should be confirmed rather than assumed.
5. The exact scope of data exposed by an App-level webhook should be confirmed with the security team —
   the App already has access to these repositories; this introduces a new delivery channel for already
   accessible information, not a new data scope.