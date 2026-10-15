---
project: "ShipScope SaaS"
researched_at: "2026-10-15"
recommended_platform: "Render"
runner_up: "Railway"
context_type: mvp
tech_stack:
  language: "JavaScript (Node.js) — no framework chosen yet; current repo is a dependency-free Node.js script collection with zero backend/database"
  framework: "TBD — SaaS pivot introduces the first real backend for this project"
  runtime: "Node.js"
---

## Recommendation

**Deploy on Render.**

Render is the only one of the six researched platforms where this PRD's explicit "persistent server-side connections — WebSockets, long-polling, or background worker processes" requirement is satisfied by the simplest possible shape: a normal always-on Node.js process, with no architectural workaround needed. Combined with native, same-vendor, private-network-reachable Postgres and Redis-compatible Key Value storage (directly matching the "co-location preferred" interview answer) and a genuinely mature, official MCP server, it best matches the "prioritize DX" answer for a 6-week, from-scratch MVP build — more so than the alternatives whose persistent-connection stories require extra orchestration (Cloudflare's Durable Objects + Queues) or are newer/less proven (Railway's 2026-vintage MCP, Fly.io's community-maintained MCP).

## Platform Comparison

| Platform | CLI-first | Managed/Serverless | Agent-readable docs | Stable deploy API | MCP / Integration | Verdict |
|---|---|---|---|---|---|---|
| Render | Pass | Pass | Pass | Pass | Pass | **Recommended** |
| Railway | Pass | Pass | Pass | Pass | Pass (new, 2026) | Runner-up |
| Fly.io | Pass | Partial | Pass | Pass | Partial | Third |
| Cloudflare Workers | Pass | Pass | Pass | Pass | Pass | Considered, not shortlisted |
| Vercel | Pass | Partial | Pass | Pass | Partial (beta) | Dropped — hard filter |
| Netlify | Pass | Partial | Pass | Pass | Pass | Dropped — hard filter |

**Render** — all five criteria pass with no beta/preview caveats on anything load-bearing for this project: `render` CLI is GA (not a dashboard-first thin wrapper), Web Services + Background Workers run as true 24/7 processes with no execution-time ceiling, Postgres + Key Value are first-class same-region services, docs ship as markdown twins + `llms.txt`/`llms-full.txt`, and the official `render-mcp-server` can create/redeploy services and query databases directly from an agent session.

**Railway** — scores nearly identically to Render on raw criteria. The one asterisk: its remote MCP server (`mcp.railway.com`) and Claude Code plugin only launched in 2026 — real and official, but newer and less battle-tested than Render's. WebSocket connections also get recycled during weekday platform updates, requiring client reconnect logic that a near-real-time GitHub/Jira sync worker would need to handle explicitly.

**Fly.io** — the most "traditional" persistent-connection model of the four (real Firecracker VMs, not request-scoped compute at all), and the only one with genuine multi-region GA support. Scores lower on managed/serverless (Postgres is GA but expensive at $38/mo+ for HA; Redis/object storage are third-party Upstash/Tigris integrations billed through Fly, not truly native) and on MCP integration (`flymcp` is community-maintained, not confirmed first-party). Docker is effectively mandatory, adding setup friction for a from-scratch app with no framework chosen yet.

**Cloudflare Workers** — scores a clean pass on all five raw criteria and has the strongest agent/MCP story of any platform researched (Cloudflare's own Agents SDK natively supports hosting MCP servers). It also decisively wins the "global reach" interview answer — true edge compute in 300+ cities, versus Render's 5 regions or Fly's primary-region-only warm instances. It is not in the top 3 because its execution model doesn't offer a plain always-on process at all: WebSockets require Durable Objects, and background/scheduled work requires Queues + cron orchestration. That is a real, well-documented, GA capability set — but it is a different and more involved way to get what this project's stated requirement describes as "a background worker process that stays alive," which works against the "prioritize DX" answer for a 6-week build with no existing backend code to adapt.

**Vercel and Netlify** — dropped by the hard filter on interview Q1 (persistent connections required). Netlify's functions are fully stateless with no true WebSocket support at all. Vercel's WebSocket support is public beta, and its only path to genuine long-running background work is the separately-priced, beta-adjacent Workflows product — neither satisfies "must stay alive between requests" as a GA capability.

### Shortlisted Platforms

#### 1. Render (Recommended)

Wins on the combination the interview actually asked for: real persistent connections with zero architectural workaround, native co-located Postgres + Redis-compatible storage, and the most mature official MCP server of the four remaining candidates. Its GA CLI (`render` — deploy, logs, rollback via a real API endpoint that reuses prior build artifacts) and markdown-native docs satisfy the agent-friendly criteria cleanly. The honest gap, covered in the cross-check below, is region coverage: 5 regions total, only one in the EU (Frankfurt), none in APAC outside Singapore, no multi-region failover.

#### 2. Railway

Nearly tied with Render on raw capability — one-click Postgres/Redis/MySQL/MongoDB templates, GA persistent processes (background workers, WebSocket support), scriptable CLI. Loses to Render specifically on integration maturity: its MCP server and Claude Code plugin are 2026-vintage and officially described by Railway itself as new, versus Render's more established offering. Also carries a documented gotcha — WebSocket connections get recycled during weekday platform updates, requiring reconnect-aware client code for a continuous sync worker.

#### 3. Fly.io

The most architecturally "normal" fit for a persistent-connection requirement (real VMs, not request-scoped compute), and the only shortlisted platform with genuine multi-region GA support — the right pick if global latency ever becomes the dominant constraint. Loses to Render/Railway on managed-service co-location (expensive native Postgres, third-party-billed Redis/storage) and on agent integration maturity (community-maintained MCP server, not first-party).

## Anti-Bias Cross-Check: Render

### Devil's Advocate — Weaknesses

1. Region coverage is thin — only 5 regions total, and Frankfurt is the *only* EU region. A multi-tenant SaaS onboarding companies from anywhere will see meaningfully worse latency for European customers outside Germany and essentially all APAC customers besides Singapore, with no multi-region failover to fall back on — a Render region incident takes down every tenant pinned to it.
2. Render's free tier spins down after 15 minutes of idle, with a 30–60s cold start on the next request — fundamentally incompatible with reliable GitHub App webhook delivery and Jira OAuth callback round-trips. A paid Starter plan (~$7/mo+) is required from day one just to keep the webhook receiver warm, undercutting the "minimize upfront commitment" spirit of a PoC.
3. Free Postgres on Render hard-expires after 30 days — there is no way to prototype the multi-tenant data model without immediately committing to a paid database tier.
4. Render is a traditional region-pinned PaaS with no edge/CDN layer. The PRD's own NFR ("near-live within seconds," "renders within 2 seconds") is a per-tenant, per-request latency commitment that a single-region deployment cannot guarantee equally for a geographically distributed customer base.
5. Cost scales with compute/instance size, not request volume — the PRD's target scale (dozens of companies, ~100 users) could force Postgres from the $6–19/mo tier up to $40+/mo purely from multi-tenant row/connection growth, well before request volume alone would justify it.

### Pre-Mortem — How This Could Fail

Six months in, the Render decision looks like a mistake. The team shipped the MVP fast — a Web Service, a Background Worker, and Postgres, exactly as planned — but every new customer outside North America complained about a sluggish dashboard, because Render has only one EU region (Frankfurt) and nothing in APAC except Singapore; a customer in Australia or South America saw multi-second load times on every navigation, directly violating the PRD's "renders within 2 seconds" guardrail. Worse, the Frankfurt region went down for ninety minutes during a routine Render incident, and because there was no multi-region failover, every tenant's dashboard — not just EU ones — was unreachable, since the shared Postgres instance lived there too. The team had assumed "global reach" meant "users anywhere can reach it," not "users anywhere get the same latency as the single region it's pinned to," and by the time they realized the gap, fixing it meant re-architecting the data layer, not just redeploying.

### Unknown Unknowns

1. Render's Background Workers have no platform execution-time ceiling — which sounds good, but also means a buggy infinite-loop sync job won't be killed by the platform; it will keep billing compute until someone manually notices and intervenes, unlike a serverless platform that caps the damage with a timeout.
2. Render's deploy-failure safety net (failed health checks cancel the new instance, keep the old one running) protects against a crashing new version — it says nothing about a version that deploys healthy and then silently corrupts multi-tenant data (e.g., a tenant-isolation bug). A "rollback" doesn't undo a data leak that already happened.
3. The official `render-mcp-server` can create/redeploy services and query databases directly from an agent session — powerful, but it gives an agent a much more direct path to production infra/data than a CLI-only workflow would. This cuts against the production-access posture ("minimal permissions, human-on-irreversibles") this project's own infra conventions call for, unless the MCP server's scope is deliberately restricted.
4. The pricing figures above came from third-party aggregator sites, not render.com/pricing directly — confirm current numbers before treating them as a budget commitment, especially since Render already changed its pricing model once in 2026 (dropping per-seat billing).
5. Render bills per workspace, not per project — if this PoC workspace ever hosts unrelated work, cost attribution for ShipScope specifically won't be clean unless it gets its own dedicated workspace.

## Operational Story

- **Preview deploys**: Render creates a Preview Environment per pull request when enabled on a service (full copy of the service + its own ephemeral database branch where applicable); the preview URL is posted back to the PR. No additional access protection is enabled by default — add branch/PR-author restrictions in GitHub if preview URLs should not be publicly guessable.
- **Secrets**: Environment variables and secret files are stored in Render's own encrypted environment-variable store, scoped per service/environment group; never committed to the repo. OAuth client secrets (GitHub App, Jira 3LO) and database credentials live there, not in `.env` files deployed with the code.
- **Rollback**: `render rollback` (CLI) or the dashboard's "Rollback" action on a prior deploy; reuses the previous build artifact, so it's fast (no rebuild). Database schema changes do not auto-roll-back — a rollback that crosses a migration boundary needs a corresponding down-migration run by hand.
- **Approval**: Routine deploys (`render deploy`/CLI-triggered redeploys) can run unattended as part of a CI flow. Human-only actions, per this project's own infra conventions: dropping the production database, rotating the primary Jira/GitHub OAuth client secret, deleting a service/workspace.
- **Logs**: `render logs` (CLI, supports `--tail`, filtering by service) for live/historical runtime logs; the `render-mcp-server` additionally exposes structured log/metric queries to a connected agent session, scoped to whichever services the MCP token has access to.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Single EU region (Frankfurt) / no APAC region outside Singapore degrades latency for non-NA/DE tenants | Devil's advocate | M | M | Acceptable at MVP/PoC scale (target: dozens of companies, ~100 users); revisit if a specific customer's latency complaints materialize — Fly.io (true multi-region) is the documented fallback. |
| Region-wide Render incident takes down every tenant with no failover | Pre-mortem | L | H | Out of scope for a PoC's uptime commitment (see PRD Non-Goals: no formal uptime SLA); document this explicitly to the first real customers if/when the PoC becomes a paid product. |
| Free-tier cold-start/spin-down breaks webhook delivery reliability | Devil's advocate | H (if free tier used) | M | Budget for the paid Starter plan (~$7/mo) from day one for the webhook-receiving service; never rely on the free tier for anything GitHub/Jira calls into. |
| Free Postgres expires at 30 days, forcing an early paid-DB commitment | Devil's advocate | H | L | Known and accepted — budget a paid Postgres tier from the start of implementation, not as a surprise later. |
| Background Worker with no execution-time ceiling can runaway-bill on a bug | Unknown unknowns | L | M | Add application-level timeout/circuit-breaker logic to the GitHub/Jira sync worker; do not rely on the platform to cap a stuck loop. |
| `render-mcp-server` gives an agent direct create/redeploy/query-DB access to production | Unknown unknowns | M | H | Scope the MCP server's token to least privilege before connecting it to any agent session; keep destructive actions (DB drops, secret rotation) as human-only per this project's infra conventions. |
| Deploy rollback doesn't undo a data-corruption bug (only reverts the process) | Unknown unknowns | L | H | Treat DB migrations as forward-only where possible; write and test down-migrations for anything touching multi-tenant isolation before shipping it. |
| Cost scales with Postgres instance size, not request volume — can jump tiers faster than traffic grows | Devil's advocate | M | L | Monitor Postgres connection/row growth per tenant explicitly, not just request-count dashboards, to catch the cost-tier threshold before it's a surprise invoice. |

## Getting Started

1. Create a Render account and a new Web Service pointed at this repo (or a new backend repo/directory once the SaaS-pivot backend code exists) — Render auto-detects Node.js via `package.json`.
2. Add a Render Postgres instance and a Key Value (Redis-compatible) instance in the same region as the Web Service, so they're reachable over Render's private network.
3. Add a Background Worker service (same repo, different start command) for the GitHub/Jira sync process — this is what satisfies the "persistent connections / background worker" requirement; design it as a normal always-on Node process with application-level retry/timeout logic (see risk register above).
4. Install `render` CLI (`npm i -g render-cli` or follow `render.com/docs/cli`) and confirm `render deploys list`/`render logs`/`render rollback` work against the new services before wiring CI.
5. Store the GitHub App and Jira OAuth (3LO) client credentials in Render's environment-variable store, scoped to the Web Service and Background Worker — never commit them, and never put them in a `.env` file that gets deployed with the code.

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration
- CI/CD pipeline setup
- Production-scale architecture (multi-region, HA, DR)
