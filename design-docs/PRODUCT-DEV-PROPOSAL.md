# Hypothetical: how to build ShipScope from scratch, with no hosting/notification constraints

*Polska wersja: [PRODUCT-DEV-PROPOSAL.pl.md](PRODUCT-DEV-PROPOSAL.pl.md)*

> **Status: hypothetical scenario, not a plan to implement.** This document answers one specific
> "what if" question: if both of ShipScope's two foundational constraints — static hosting on GitHub
> Pages, and the `notify_shipscope` CI-step mechanism for learning about a deployment — were removed,
> what would the best, fastest, cheapest, and most reliable way to build ShipScope look like, starting
> from nothing today? It is not an implemented plan, not a roadmap, and not a recommendation to start
> this work now — same spirit as `INTEGRATION-VISION.md`'s "undecided vision, not an implemented plan."
> It exists so that a future real decision to invest in infrastructure has a concrete target to react to,
> rather than starting that conversation from zero.

It builds directly on two documents that already exist in this repo and should not be re-derived here:

- `INTEGRATION-VISION.md` already states the target onboarding experience (GitHub App install + one
  config entry, no PR, no secrets, no CI change) and already identifies the GitHub-App-webhook mechanism
  for deployments, plus the push/hybrid-vs-pull tradeoff for feature flags.
- `DEPLOYMENT-WEBHOOK-PROPOSAL.md` already has a complete, phased technical plan for the deployment
  webhook listener specifically — signature verification, event filtering, dispatch contract, rollout.
- `ARCHITECTURE-NOTES.md` already maps the multi-team/isolation question and concludes that push/hybrid
  is structurally closer to team independence than ShipScope holding every team's flag-provider credential.

This document does not repeat those analyses. It asks the one question none of the three answers: **if
you were building this today, with a real server allowed and no requirement to funnel every write through
a GitHub Actions commit, would you still want docs/data/*.json on GitHub Pages, or something else — and
what does "something else" concretely look like, end to end?**

## The recommendation, stated first

Build a small, boring, three-tier internal web service: a thin TypeScript API backend, a managed Postgres
database, and a frontend that keeps the vast majority of today's `docs/app.js` rendering and join logic —
just pointed at a real API instead of static JSON files, plus one live-update channel (Server-Sent Events)
so the dashboard reflects a deployment or flag flip within seconds, not within a sync cycle. Ingestion
moves from "a CI step fires a GitHub dispatch, which triggers a workflow, which commits a JSON file" to
"a GitHub App webhook and a Jira webhook land directly on the backend's own endpoints, which write
straight to the database." Onboarding becomes installing the GitHub App on a repository plus adding one
row through a small internal admin screen — no pull request, no secret, no CI change, for either
deployments or (if a team pushes flag changes the same way) feature flags.

This is not the only workable design — see "Alternatives considered and rejected" below — but it is the
one this document recommends, and the rest of it explains why, in detail, including what it costs and
what it gives up.

## Why not just "keep the current model, but with a real webhook"?

Because once a server is allowed to exist at all, routing every write back through a GitHub Actions
commit-to-`live` cycle stops making sense as the *primary* path — it only ever existed because there was no
server to write to directly. Concretely, today's write path for a single deployment event is:

GitHub deployment_status → (proposed) webhook listener → `repository_dispatch` → GitHub Actions checkout
of two branches → `sync-github-deployments.js` → JSON read-merge-write → `git commit` → push, retried via
`sync-with-retry` against a losing race.

With a real backend and database, the same event becomes: GitHub deployment_status → webhook endpoint →
one SQL transaction. The read-merge-write-and-retry dance, the cursor file, the retention trimming, the
two-checkout split between `main` and `live`, and the whole git-push-race-retry mechanism all exist
*specifically* to make "the data lives in git, mutated by a bot, read by static files" work safely. None
of that is a goal in itself — it is scaffolding this constraint requires. Removing the constraint should
remove the scaffolding with it, not keep it bolted onto a server that no longer needs it.

## Architecture

### Backend and hosting

A single small TypeScript service (Fastify or NestJS; either is fine — this is not where the hard
decisions live), containerized, deployed on whatever container platform the organization already operates
(its existing Kubernetes cluster, or a managed container service such as Cloud Run/Fargate/App Runner —
the right choice is "don't stand up a new platform just for this," not a specific vendor). It exposes:

- `POST /webhooks/github` — receives `deployment`/`deployment_status` events, verifies the
  `X-Hub-Signature-256` HMAC exactly as `DEPLOYMENT-WEBHOOK-PROPOSAL.md` already specified for its
  standalone listener, and writes directly to the `deployments` table in one transaction — no
  `repository_dispatch` round trip, because there is no longer a reason to leave GitHub Actions and come
  back.
- `POST /webhooks/jira` — receives Jira Cloud webhook deliveries (`jira:issue_updated`, sprint-started,
  etc.), protected by a shared secret (Jira classic webhooks are unsigned, same caveat
  `INTEGRATION-VISION.md` already notes) or an IP allowlist, and upserts into the `jira_issues` table.
- `POST /webhooks/flags` — receives a push from either a shared flag provider's own webhook (LaunchDarkly,
  Unleash) or a team's own small relay (the "hybrid" option `ARCHITECTURE-NOTES.md` already recommends),
  and writes to `flag_states` plus an append-only `flag_state_history`.
- A read API (`GET /api/deployments`, `/api/flags`, `/api/jira-issues`, etc.) backing the frontend —
  server-side filtering and pagination, instead of shipping a multi-megabyte JSON file to every visitor's
  browser regardless of what they're looking at.
- `GET /api/events` (Server-Sent Events) — one long-lived connection per open dashboard tab; on any write
  to `deployments`/`flag_states`/`jira_issues`, the backend pushes a small "this changed" message, and the
  frontend re-fetches just the affected slice. This is the actual "real-time" in this proposal — not a
  websocket chat app, just enough push to replace "reload the page tomorrow" with "the row updates while
  you're looking at it."

A daily reconciliation job (same spirit as today's cron in `orchestrate-full-sync.yml`, same justification
`DEPLOYMENT-WEBHOOK-PROPOSAL.md` already gives for keeping its cron as a fallback) still polls the GitHub
and Jira APIs directly and corrects any drift — webhooks can be missed, this is the backstop, now a
secondary path rather than the only path.

Most of the actual data logic does not need to be invented: `scripts/lib/github-api.js`,
`scripts/lib/jira-api.js`, `scripts/lib/extract-flags.js`, and the per-env/per-source status resolution
logic already in `sync-github-deployments.js`/`sync-jira.js`/`resolve-all-flag-states.js` port over close
to unchanged — the only real surgery is swapping their "read existing JSON, merge, write JSON back" ends
for "read from Postgres, merge, write back in a transaction." This is the single biggest reason this
design is faster to build than it looks: the hard domain logic (rollback detection, drift detection,
PI/sprint resolution, flag-source collision handling) already exists and is already correct.

### Database

Managed Postgres (RDS, Cloud SQL, or equivalent — again, whatever the organization already operates).
Replacing `docs/data/*.json` with real tables removes several problems that only exist because JSON files
on git were the storage model in the first place:

- No more manual retention trimming (`RETENTION_DAYS`, the never-trimmed cursor/issue-deployments
  companion files) — keep everything, apply retention via an ordinary scheduled `DELETE`/partition-drop if
  storage cost ever actually matters, which it won't at ShipScope's data volumes for a long time.
- No more PI-shard files, `index.json`, `status-index.json`, `pruned-pis.json` as a hand-rolled set of
  consistency rules between files — a PI is just a column to filter on; "what PI is this issue in right
  now" is one query, not a cross-shard lookup with its own exclusion-list file.
- No more same-key collision detection between components writing to the same JSON object
  (`resolve-all-flag-states.js`'s `::error::`-not-thrown refusal) — a proper schema with
  `(key, env, source, component)` as part of a unique constraint, or an explicit ownership column with a
  real constraint, makes the invariant enforced by the database instead of hand-written per script.
- Real queries instead of full-dataset joins performed in the browser on every page load — "every issue
  released to prod this sprint," "every component currently drifted," become `WHERE` clauses, not
  client-side `Array.filter` over everything that was ever fetched.

### Frontend

Deliberately conservative here: keep the vanilla JS, no-build-step frontend, because
`docs/app.js`'s actual value — the status-resolution logic (`effectiveFlagState`, release-status buckets,
rollback/drift detection, Epic grouping, the Insights charts) — is independent of where the data comes
from, and rewriting it in a framework buys nothing a real backend didn't already buy by itself. The only
change is what `fetch()` points at: a paginated, filterable REST API instead of a handful of
ever-growing static JSON files, plus one `EventSource` connection for live updates. Authentication
(below) is the other new piece; everything else — rendering, the five Insights charts, Product
view's Epic grouping, Release Notes — carries over close to unchanged.

### Authentication and the isolation question

A real server finally gives a real answer to the open question `ARCHITECTURE-NOTES.md` leaves
unresolved ("is shared visibility across teams a feature or a problem?") — because now there is somewhere
to enforce an answer. Put the organization's existing SSO (OIDC) in front of the API and frontend. If the
business decides isolation is required, a `tenant_id`/`team_id` column plus row-level security (or simply
a `WHERE` clause enforced server-side, not client-side) does the actual separating. If shared visibility
remains the preferred model (joining signals across teams was ShipScope's original stated purpose), SSO
still buys authenticated access instead of "public GitHub Pages or fully private behind GitHub auth,"
which was the only choice `ARCHITECTURE-NOTES.md` could offer under the old constraint.

### Onboarding, end to end

1. Install the ShipScope GitHub App on the new repository (admin action, no PR, no secret, no CI change —
   same as `INTEGRATION-VISION.md`'s target vision).
2. Add one row through a small internal admin page (or a single API call): component name, optional
   feature-flag source, optional Jira project mapping. No git commit, no review process, because this is
   now application data in a database, not a config file in a repository that happens to double as
   ShipScope's deploy artifact.
3. If the team's deploy pipeline doesn't already produce GitHub Deployment objects the App can see,
   nothing further is needed on their side at all — the webhook already fires from the GitHub platform
   level, not from their workflow file, exactly as `DEPLOYMENT-WEBHOOK-PROPOSAL.md` already designed.

This fully satisfies `INTEGRATION-VISION.md`'s one-sentence objective — not as an incremental improvement
on top of the current model, but because removing both constraints is what that document's own "cost and
tradeoffs" section already said would be required to get there for real.

## What this costs, honestly

This is the part that matters most to a business stakeholder, and it should not be softened:

- **A real, continuously-running service now exists**, with everything that implies: a deploy pipeline for
  the service itself, secret custody (webhook secrets, GitHub App private key, DB credentials, OIDC client
  secret) in a runtime environment rather than GitHub Actions' encrypted secrets, monitoring, alerting, and
  an on-call rotation — the exact step `DEPLOYMENT-WEBHOOK-PROPOSAL.md` already flagged as "not an implicit
  consequence of shipping one feature," now taken deliberately and fully, not partially.
- **A real attack surface.** Public webhook endpoints, an authenticated API, a database holding
  organization deployment/Jira/flag data — each needs the ordinary diligence of any backend service
  (input validation, rate limiting, dependency patching, backup/restore drills), none of which a static
  site plus GitHub Actions ever had to think about.
- **Git stops being the audit log.** Today, every data mutation is a commit — `git log` on `live` is a
  complete, free, tamper-evident history of every flag flip and deployment record ever written, which is
  exactly what `backfill-flag-state-history.js` mines when the dedicated history file didn't yet exist.
  A database has no equivalent for free; a real audit trail (who/what/when for every write) has to be
  deliberately built as its own table, not inherited from the storage mechanism.
- **"Deploy" stops meaning "push to main."** Today, shipping a ShipScope change is a `git push` that a
  sync workflow eventually picks up; there is no separate release process to design, version, or roll
  back. A real backend needs its own CI/CD, versioning, and rollback story — ordinary for a backend
  service, but new relative to what ShipScope has needed until now.
- **Loss of the offline/degraded-mode fallback.** `docs/app.js`'s embedded `FALLBACK` sample dataset for
  `file://` viewing, and "GitHub Pages happens to still work if everything else is down," both go away —
  the dashboard's availability now depends entirely on the new service's own uptime.
- **Real, ongoing cost**, where today's is effectively zero: compute (likely small, since this is an
  internal tool with low traffic — a platform that scales to near-zero between events keeps this modest),
  a managed database (smallest viable tier), and the engineering time to build and then operate all of the
  above. Rough shape, not a quote: on the order of a few weeks of focused engineering time to reach parity
  with what exists today plus real-time push, and a fraction of an FTE ongoing for patching, monitoring,
  and incident response once stable — small in absolute terms, but strictly greater than the "one engineer,
  spare time, zero dollars" model ShipScope has run on so far.
- **It is not faster to build than the current system was.** It is faster to *extend* once built (every
  new feature becomes an ordinary CRUD/API change instead of a careful idempotent-JSON-merge script with
  its own race conditions to reason about), and it is faster to *reach real-time* than any amount of
  polling ever could be — but reaching this state from nothing takes real weeks, not the hours a new
  sync script takes today.

## What this buys, concretely

- **Real-time, not eventual.** A deployment or flag flip reaches the dashboard in roughly the time it
  takes a webhook to arrive and a browser to receive a push message — no cron, no "Last sync: <date>"
  staleness indicator, no up-to-24-hour worst case.
- **No per-service CI change, ever, for onboarding** — the actual objective `INTEGRATION-VISION.md` states,
  fully realized rather than approximated.
- **A real answer to the multi-team isolation question**, instead of GitHub Pages' binary
  all-public-or-all-private limitation.
- **Server-side filtering and pagination** instead of downloading an ever-growing JSON file per view,
  independent of how large `docs/data/` would otherwise have grown.
- **The database enforces invariants a script used to have to defend by hand** — the same-key
  cross-component collision case, the PI-shard consistency rules, the cursor/retention bookkeeping — all
  collapse into ordinary schema constraints and queries.

## Alternatives considered and rejected

- **Keep static JSON on git, add only a real-time push layer on top** (e.g., the webhook listener from
  `DEPLOYMENT-WEBHOOK-PROPOSAL.md`, still committing to `live`, plus a tiny SSE relay watching the git
  branch for new commits). Rejected as the target state for this hypothetical specifically because it keeps
  every piece of git-as-database scaffolding (retry-on-losing-push, cursor files, retention trimming,
  PI-shard consistency rules) *in addition to* a new server — paying the server's operational cost without
  shedding the complexity that only existed to work around not having one. This remains the right choice
  under today's actual constraints (see Part 1's within-constraints analysis); it stops being the right
  choice once a server is on the table at all.
- **A document database (e.g., DynamoDB/Mongo) instead of Postgres.** Rejected: ShipScope's data is
  genuinely relational (components, deployments, issues, flags, environments all reference each other, and
  the existing joins in `docs/app.js` are exactly relational joins already) — a document store would mean
  reimplementing joins in application code that a relational database already does well, for no offsetting
  benefit at ShipScope's scale.
- **A full framework rewrite of the frontend (React/Angular/etc.).** Rejected: none of the actual
  complexity in `docs/app.js` is a state-management or component-reuse problem that a framework solves;
  it is domain logic (release-status resolution, drift/rollback detection, PI grouping) that reads the same
  either way. Rewriting it would cost real time and risk real regressions in already-correct, already
  carefully-reviewed logic, for a benefit this document can't identify.
- **Serverless functions for everything, no persistent container.** Considered seriously, since it would
  reduce idle cost further — rejected only as the default recommendation, not ruled out: a long-lived SSE
  connection for live push doesn't fit a classic request-scoped serverless function well on every platform,
  and a small always-on container is simple enough, at ShipScope's scale, that optimizing idle cost further
  isn't worth the added platform complexity. Worth revisiting if whoever eventually owns this component
  already standardizes on a serverless platform that handles long-lived connections well.

## Open questions this document does not resolve

- Who would own, operate, and be on call for this service — same open question
  `DEPLOYMENT-WEBHOOK-PROPOSAL.md` already raised for just the listener, now scaled up to a full backend.
- Whether the business is willing to migrate every service to a shared feature-flag provider, or whether
  this design should instead support push ingestion from however many different flag mechanisms teams
  already use — `ARCHITECTURE-NOTES.md`'s flag-source table already lays out that tradeoff and this
  document does not need to re-decide it.
- Whether shared cross-team visibility remains desired once real isolation becomes technically possible —
  the open question `ARCHITECTURE-NOTES.md` already poses, now actually answerable rather than foreclosed
  by GitHub Pages' all-or-nothing model.
- Exact platform choice (which container platform, which managed Postgres, which OIDC provider) —
  deliberately left to whoever actually owns this decision, since "use what the organization already
  operates" matters more here than any specific vendor name this document could pick.
