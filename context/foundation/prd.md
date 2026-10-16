---
project: "ShipScope SaaS"
version: 1
status: draft
created: 2026-10-15
context_type: brownfield
product_type: web-app
target_scale:
  users: medium
  qps: low
  data_volume: small
timeline_budget:
  delivery_weeks: 6
  hard_deadline: null
  after_hours_only: true
---

## Current System Overview

- **System purpose**: ShipScope is a cross-repo deployment / feature-flag / Jira status dashboard, currently built for a single organization (EVDT).
- **Key architecture**: No application server, no database. Plain Node.js scripts (built-ins + global `fetch` only, zero dependencies) are invoked by GitHub Actions workflows. They sync data into JSON files committed to a `live` git branch. A static vanilla-JS page (`docs/index.html` + `docs/app-*.js`) fetches that JSON and renders it, served by GitHub Pages.
- **Tech stack**: Node.js (no framework, no deps), GitHub Actions as the de-facto backend/scheduler, GitHub Pages as hosting, git branches as the datastore.
- **Current user base**: internal product/technical/PO teams at EVDT, tracking deployments, feature flags, and Jira issue status for their own components.
- **Core functionality**:
  - Deployment tracking per component/environment (GitHub Deployments API), with drift detection (git-tree diff between environments), rollback detection, version resolution (release/tag/commit-message).
  - Feature flag state tracking (`build` and `runtime-be` sources) with history, cross-component collision guarding, ghost-flag (unconsumed value) detection.
  - Jira issue sync, sharded per Program Increment (PI), joined against deployments/flags to compute a per-environment release status (none/deployed/released/partial) per issue.
  - Product view (Jira-centric, grouped by Epic), Technical view (component × env matrix + flag list), Release Notes, Insights (stale flags, rollback/drift trends, lead time, release status breakdowns).
- **Integrations today**:
  - **GitHub**: a shared GitHub App installed per app-repo; each app repo's own workflow calls a reusable `notify-deployment.yml` / `check-flags.yml` workflow to push a `repository_dispatch` into this repo. Deployment history itself is pulled via polling (GitHub Deployments API) on cron/dispatch.
  - **Jira**: a single shared service-account API token (Basic auth, email+token) configured via env vars in this repo's own GitHub Actions secrets. Sync is cron-based (current PI) plus manual backfill for past PIs.
- **Configuration today**: `docs/components.json` (tracked component list) and `docs/jira-spaces.json` (Jira project/board allowlist) are plain JSON files in this repo, edited by hand via git commit. There is exactly one tenant (EVDT) and one shared dataset; nothing is parameterized per-organization.

## Problem Statement & Motivation

The specific gap: ShipScope's integration and configuration model is single-tenant and config-via-commit. Onboarding any new organization today means forking this repository or hand-editing its JSON config files, and wiring a shared credential into that organization's own workflows. That doesn't scale past one organization, and it has no self-serve path at all.

Why now: the underlying domain logic — joining deployments, feature flags, and Jira issues to compute drift between environments, per-flag release status, and unconsumed "ghost flag" value — already works for one organization (EVDT) as a proven PoC. The insight that makes this worth productizing is that this domain-logic join, not the raw GitHub/Jira integration itself, is the differentiator against generic "connect GitHub + Jira" dashboards — many tools do the raw integration, few do this specific join (drift detection, per-flag release status, ghost-flag detection, lead-time-to-prod).

Current workaround: none. Onboarding any additional organization today requires forking this repository or being manually set up by the ShipScope maintainer — there is no self-serve path, and the cost is a full manual onboarding per customer.

## User & Persona

**Primary persona**: a technical or release-owner person at a customer company — e.g. a tech lead, release manager, or DevOps engineer — who connects their own organization's GitHub and Jira to ShipScope and views the resulting deployment/flag/Jira dashboard for their own team's components. They are not a ShipScope operator; they are a customer, self-serving their own onboarding.

This is a change in who the system serves: today's only users are internal EVDT teams working against a hand-configured dataset. Going forward, any customer company's technical/release-owner persona can reach the same dashboard and domain logic against their own data, without EVDT or the ShipScope maintainer being involved in their onboarding.

## Success Criteria

### Primary
- A new company can, without any manual JSON editing or contact with the ShipScope team: sign in with GitHub, create their own tenant org, install the GitHub App on their chosen repos, connect Jira via OAuth and pick a project/board, and see their own deployment/flag/Jira dashboard populated with real data from their own GitHub + Jira.

### Secondary
- After the first connection, an Admin can self-serve add/remove tracked repos or Jira projects/boards without needing manual help from the ShipScope team for the *second* onboarding step onward.

### Guardrails
- **Tenant data isolation**: Company A can never, under any circumstance, see Company B's deployments, flags, or Jira data.
- **Credential hygiene**: OAuth tokens and GitHub App installation tokens are stored encrypted and never appear in logs or reach the frontend.
- **Dashboard responsiveness**: a tenant's dashboard renders its own data within 2 seconds of navigation, perceived by the user.
- No formal uptime or data-retention SLA is committed to at this PoC stage — see Non-Goals.

## User Stories

### US-01: New customer onboards their company to ShipScope end-to-end

- **Given** a user with a GitHub account and admin access to their company's Jira
- **When** they sign in with GitHub, create a new tenant org, install the ShipScope GitHub App on their chosen repos, and connect Jira via OAuth selecting a project/board
- **Then** they see a dashboard populated with their own company's deployment, flag, and Jira data — with no manual JSON editing and no contact with the ShipScope team

#### Acceptance Criteria
- The full flow completes without any step requiring a ShipScope-team action
- Data shown belongs exclusively to the signed-in user's own tenant
- After the initial connection, newly-arriving GitHub/Jira activity reflects on the dashboard within seconds, not minutes — a near-live feel, not a batch-sync delay
  > **2026-10-16:** the flow is guided in the product itself: a Getting started checklist on the settings page shows each step (GitHub App, repos, first deployments; Jira, boards, flags, team optional) as done / waiting / to do with a button to the place it's done, an empty dashboard links to it, and invitees join from a page instead of an API call.

## Scope of Change

Tenant data isolation is captured once, as a guardrail under Success Criteria — it is not duplicated here as its own item (an earlier draft FR for it was dropped as redundant with the guardrail during review).

### Authentication & Tenancy
- [new] FR-001: User can sign in via GitHub OAuth. Priority: must-have
  > Socratic: Counter-argument considered: "some corporate customers require SSO/SAML, not a personal GitHub account." Resolution: known MVP limitation, noted; FR stands as-is. OAuth-with-GitHub-only is the MVP auth path; SSO/SAML is a later addition.
- [new] FR-002: User can create a new tenant organization. Priority: must-have
  > Socratic: Counter-argument considered: "two admins from the same company could independently create two separate tenants, causing duplication." Resolution: known MVP limitation, noted; FR stands as-is. Domain-based org deduplication/invite-to-existing-org is deferred past MVP.
- [new] FR-003: Admin can invite Members to their tenant. Priority: must-have
  > Socratic: Counter-argument considered: "a real customer demo is likely to need more than one user per company from day one." Resolution: bumped from nice-to-have to must-have.

### GitHub integration
- [new] FR-004: Admin can install a GitHub App on chosen repos to connect them to their tenant. Priority: must-have
  > Socratic: Counter-argument considered: "a company's repos may live across more than one GitHub org, not just the org the admin signs in from." Resolution: known MVP limitation, noted; FR stands as-is. One GitHub org per tenant is the MVP assumption; multi-org-per-tenant is deferred.
- [modified] FR-005: System ingests deployment data from connected repos into tenant-scoped storage (was: a single global dataset shared across one organization). Priority: must-have
  > Socratic: Counter-argument considered: "polling across many tenants at once could hit GitHub rate limits faster than today's single-org model." Resolution: FR stands as-is; captured as an Open Question for downstream implementation planning, not a scope change here.
- [new] FR-006: Admin can add/remove tracked repos after initial connection. Priority: must-have
  > Socratic: Counter-argument considered: "without this, the 'self-serve, no contact needed' claim in the Problem Statement is only half true — changing the repo set after onboarding still needs manual help." Resolution: bumped from nice-to-have to must-have.

### Jira integration
- [new] FR-007: Admin can connect their Jira instance via OAuth. Priority: must-have
  > Socratic: Counter-argument considered: "Jira OAuth (3LO) requires a registered Atlassian app with a redirect URI — an external setup dependency, not just code." Resolution: FR stands as-is; the Atlassian app registration is noted as an implementation prerequisite, not a scope change.
- [new] FR-008: Admin can select which Jira project(s)/board(s) to sync. Priority: must-have
  > Socratic: Counter-argument considered: "a customer's Jira work may be spread across more than one Atlassian site/cloud ID." Resolution: known MVP limitation, noted; FR stands as-is. One Jira site per tenant is the MVP assumption.
- [modified] FR-009: System ingests Jira issues into tenant-scoped storage, joined by PI/sprint (was: a single global dataset shared across one organization). Priority: must-have
  > Socratic: Counter-argument considered: "per-tenant OAuth tokens have different Jira API rate-limit buckets than today's single shared service-account token." Resolution: FR stands as-is; captured as an Open Question for downstream implementation planning.

### Dashboard
- [modified] FR-010: User can view the Technical view (component × env matrix, deploy history, flags) scoped to their own tenant (was: a single shared view over one organization's data). Priority: must-have
  > Socratic: Counter-argument considered: "drift/ghost-flag/lead-time logic runs today over in-memory JSON; moving to per-tenant queryable storage is a rewrite, not a lift — calling it unchanged undersells the work." Resolution: categorized as [modified], not [preserved] — the user-facing behavior/logic is preserved, the implementation underneath is not.
- [modified] FR-011: User can view the Product view (Jira-centric, grouped by Epic) scoped to their own tenant (was: a single shared view over one organization's data). Priority: must-have
  > Socratic: same counter-argument and resolution as FR-010 (shared architectural change).
- [modified] FR-012: User can view Release Notes and Insights scoped to their own tenant (was: a single shared view over one organization's data). Priority: nice-to-have
  > Socratic: same counter-argument and resolution as FR-010 (shared architectural change).

## Constraints & Compatibility

- **Backward compatibility**: none required. This is a PoC; there are no existing external API consumers or data-format contracts that must be preserved.
- **Data migration**: no live migration of EVDT's existing data into the new multi-tenant model. EVDT onboards as an ordinary new tenant ("tenant #1") through the same self-serve flow as any other customer. The existing data snapshots are not thrown away, though — they're repurposed as seed/fixture data for local development and automated tests, not as production tenant data.
- **Existing integrations**: none must continue working unchanged. The current reusable workflows and the shared GitHub App / Jira service-account-token model may be fully replaced by the new per-tenant integration model. EVDT's own app repos get re-wired as part of this change, same as any other tenant's onboarding.
- **Preserved behavior**: the dashboard's domain logic and views (Technical view, Product view, Release Notes, Insights) are preserved as user-facing behavior (see FR-010/FR-011/FR-012 above) — the implementation underneath is not preserved.

## Business Logic Changes

No domain logic change. This is an infrastructure/technical change.

The existing domain rule is preserved as-is: ShipScope decides, per component/environment/feature-flag, whether a change is actually live for users — not merely deployed — by joining deployment state, flag state, and linked Jira issues, and surfacing drift, rollbacks, and stale "ghost" flags (unconsumed value) along the way. This change does not modify that rule; it changes how data reaches it (per-tenant self-serve ingestion instead of one hand-configured dataset).

## Access Control Changes

**Current model**: none. The dashboard is a fully public, unauthenticated static site — anyone with the URL sees everything, no role separation.

**Planned model**: full rebuild, not an incremental change.
- **Auth**: OAuth login ("Sign in with GitHub"). No separate password management. A GitHub account can belong to, or create, one or more tenant organizations.
- **Tenancy**: each customer company is its own isolated tenant/workspace — its own GitHub/Jira connections, its own data, invisible to other tenants.
- **Roles within a tenant**:
  - **Admin** — connects/disconnects GitHub and Jira integrations, invites/removes members, configures tracked components and PI/board mappings.
  - **Member** — dashboard-only access (Product view, Technical view, Release Notes, Insights); no access to integration settings.

## Non-Goals

- **No SSO/SAML for enterprise customers.** GitHub OAuth is the only sign-in path in MVP. Rationale: keeps auth simple for the first SaaS pivot; enterprise IdP integration is a real need but not a blocker for proving the model.
- **No multi-org-per-tenant GitHub, no multi-site-per-tenant Jira.** One GitHub org and one Jira Cloud site/cloud ID per tenant in MVP. Rationale: most companies fit this shape; supporting fragmented setups adds real complexity before the core model is validated.
- **No GitLab/Bitbucket, no Jira Server/Data Center (on-prem).** MVP integrates exclusively with GitHub.com and Jira Cloud. Rationale: the self-serve connection flows this MVP depends on don't exist in the same form for on-prem trackers or other VCS providers.
- **No formal uptime or data-retention SLA.** No contractual availability or retention guarantees at this PoC stage. Rationale: this is a PoC proving the multi-tenant self-serve model works, not a production commitment to paying customers yet.

## Open Questions

1. **How should feature flags be managed and linked to a Jira work item in the multi-tenant SaaS?** — The current single-tenant model discovers flags from each repo's own generated code and links them to Jira via a manually-set metadata array. In a self-serve, per-tenant world, it's not yet decided whether flags are still discovered from repo code per tenant, managed directly in the ShipScope UI, or linked to Jira via a dedicated custom Jira field instead of manual metadata entry. Owner: user. By: before flag-related FRs are implemented.
   > **Linking, 2026-10-16 (user idea, built):** a flag links to Jira work items from three places, shown together:
   > the sender's `jiraKeys`, a convention in Jira itself (a "Feature flag" field on the issue, or labels like
   > `flag:newCheckout` -- chosen per tenant in settings, read with each sync), and links set by hand in ShipScope.
   >
   > **Resolved 2026-10-16 (user):** flags come from outside. Every tenant keeps them its own way (build-time files, a runtime API, a third-party flag service, or none at all), so ShipScope never discovers them itself: the tenant's own tooling pushes flag values -- and, optionally, each flag's description and linked Jira keys -- to an ingest API. Senders are named per-tenant flag sources with their own tokens; each message is the full state of that source per environment (removed flags are detected), values are off/on/partial with a rollout percentage, and the sender's change time is kept (contract schemaVersion 2, `server/lib/flags.js`). Managing flags in the ShipScope UI or a custom Jira field remain possible later additions, not the MVP path.
2. **How is GitHub sync throttled/queued across many tenants at once?** — Today's single-org polling model has no cross-tenant contention. Multi-tenant polling needs a strategy to avoid one tenant's sync starving another's. Owner: user (or downstream implementation planning). By: before implementation planning for FR-005.
   > **Resolved 2026-10-16:** each pass starts with the tenant (and, within it, the repo or Jira board) that waited longest, and gives every tenant a time budget (`SYNC_TENANT_BUDGET_SECONDS`, default 120 s); what doesn't fit continues next pass, with the deployment cursor never passing work left undone. GitHub rate limits are per App installation, so one tenant's spent budget pauses only that installation until GitHub says (`Retry-After`/`x-ratelimit-reset`); everyone else syncs on (`server/lib/deployment-sync.js`).
3. **How does per-tenant Jira OAuth rate-limiting differ from today's shared service-account token model?** — Needs confirming whether per-tenant OAuth tokens get independent rate-limit buckets from Atlassian, which would simplify this considerably. Owner: user (or downstream implementation planning). By: before implementation planning for FR-009.
   > **Resolved 2026-10-16:** each tenant has its own OAuth grant. Atlassian enforces points-based hourly quotas and burst limits on OAuth 2.0 (3LO) apps since March 2026; exactly how they are split between sites was not confirmed (Atlassian's page was unreachable from the session; community answers predate the change), so ShipScope relies on none of it: a 429 pauses only that tenant's connection until its `Retry-After` (5 minutes when Jira sends none, as Jira Cloud sometimes does), shown in settings as a pause rather than an error. Jira syncs get the same longest-waiting-first order and per-tenant time budget as deployments, checked between boards (`server/lib/jira-sync.js`).

## Deferred to the End: Launch & Commercialization

Decided 2026-10-16 (user): hosting is revisited last, together with payments, plans and marketing -- once the product
itself is done. Nothing below is built yet; each item is a decision to make (and then implement) at that stage. The
deployment itself is ready to go when wanted: `render.yaml` and the step-by-step guide in `server/TESTY-RECZNE.pl.md`
(part B).

### 1. Hosting & production

- **Deploy on Render** following `server/TESTY-RECZNE.pl.md` part B (production GitHub App, production Atlassian app,
  secrets, Blueprint).
- **Region.** `render.yaml` currently says `oregon` (US). EU customers' Jira/GitHub data may need an EU region
  (Frankfurt) for GDPR expectations -- decide before the first real tenant; moving a database later means a migration.
- **Custom domain** (e.g. `app.<brand>.com`): changes `PUBLIC_BASE_URL` and every callback/webhook URL in both apps.
- **Staging environment**: a second Blueprint (or Render preview environments) so changes are tried before production.
- **Backups and restore**: Render Postgres backups on the chosen plan; test one restore before customers depend on it.
- **Monitoring and alerts**: health check alerts, worker failures (`sync failed` in logs), error rate; a status page.
- **Still unverified with real services**: the Jira webhook delivery format (`server/TESTY-RECZNE.pl.md` steps 41-43).

### 2. Payments & billing

- **Provider.** Stripe (Billing + Checkout + Customer Portal) vs. a merchant of record such as Paddle or Lemon Squeezy,
  which handles EU VAT and invoicing for you -- the main trade-off is fees vs. tax/compliance work.
- **What is billed**: per workspace (tenant), monthly/yearly, trial length, what happens when a payment fails
  (grace period, read-only mode, then suspension) and when a subscription ends (data kept how long, then deleted).
- **In the product**: a billing section in Settings (plan, invoices, change/cancel via the provider's portal), the
  provider's webhooks verified and queued like GitHub/Jira ones (`lib/webhooks.js` pattern), plan state stored on
  `tenants`.
- **Invoices and tax**: company details on invoices, EU VAT (reverse charge for B2B), Polish accounting requirements.

### 3. Plans & limits

- **What to price on** (pick one or two, keep it simple): tracked repositories, Jira boards, members, deployment
  history retention (already per tenant, 7-730 days), instant updates (webhooks) vs. 15-minute sync.
- **Free tier or trial only**; an internal/unlimited plan for EVDT itself.
- **Where limits are enforced in code**: tracking a repo (`trackRepo`), selecting boards (`setBoards`), invitations
  (`createInvitation`), retention (`updateSettings`), webhook processing -- each returns a clear "upgrade your plan"
  error the settings page shows.
- **Upgrade/downgrade rules**: what happens to repos/boards above a lower plan's limit.

### 4. Legal & compliance

- **Terms of service and privacy policy** -- also required by Atlassian to share the OAuth app with other companies
  (Distribution settings) and expected by GitHub for a public App.
- **GDPR**: ShipScope processes customers' Jira/GitHub data as a processor -- a DPA (data processing agreement), a
  list of subprocessors (Render, the payment provider), data retention and deletion rules.
- **Deleting a workspace and its data** -- built (2026-10-16): `DELETE /tenants/:tenantId` and Settings → Workspace →
  Delete workspace. Still to decide at this stage: deleting automatically when a subscription ends (after a grace
  period), and how long Render's database backups keep deleted data.

### 5. Marketing & distribution

- **Name, brand and domain** (ShipScope is a working name -- check availability and trademarks).
- **Landing page** with the value proposition ("what's really on production, per Jira issue, across repos"), a
  pricing page, screenshots/short video, sign-up = "Sign in with GitHub".
- **Demo**: a public read-only demo workspace (the built-in `FALLBACK` sample data is a starting point).
- **Documentation for customers**: getting started (install the GitHub App, connect Jira, choose boards), flag
  ingest examples per popular flag tool, FAQ (`FAQ.md` exists for the file-based version).
- **Marketplaces**: GitHub Marketplace listing for the App; Atlassian Marketplace listing (requires a public,
  reviewed app).
- **Launch channels**: Product Hunt, Hacker News "Show HN", LinkedIn/communities around SAFe/agile delivery, posts
  on the deployment-visibility problem; first customers from the existing network.
- **Product analytics** (privacy-friendly, e.g. Plausible) and an **onboarding funnel** (signed in -> workspace ->
  GitHub connected -> first deployment -> Jira connected).
- **Support and feedback**: a support email or in-app contact, a public roadmap/changelog (the GitHub Releases from
  `release.yml` already exist).
