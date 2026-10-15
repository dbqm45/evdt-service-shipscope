---
project: "ShipScope SaaS"
context_type: brownfield
created: 2026-10-15
updated: 2026-10-15
product_type: web-app
target_scale:
  users: medium
  qps: low
  data_volume: small
timeline_budget:
  delivery_weeks: 6
  hard_deadline: null
  after_hours_only: true
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "change category"
      decision: "architectural rebuild — same domain (deploy+flag+Jira dashboard), fundament (data model, multi-tenancy, integrations) rewritten from scratch"
    - topic: "insight / differentiator"
      decision: "deeper domain-logic join (flag↔deployment↔Jira: drift detection, per-flag release status, ghost-flag detection, lead time) is the differentiator vs generic connect-GitHub-Jira dashboards"
    - topic: "primary persona scope"
      decision: "technical / release-owner person at a customer company (e.g. tech lead, release manager, DevOps) who onboards their own org's GitHub + Jira and views the dashboard for their own team"
    - topic: "auth strategy"
      decision: "OAuth login (\"Sign in with GitHub\") — no separate password management; one GitHub account can belong to / create one or more tenant organizations"
    - topic: "role model within a tenant"
      decision: "two roles — Admin (connects/manages GitHub+Jira integrations, invites members, configures) and Member (dashboard-only, no integration access)"
    - topic: "MVP flow"
      decision: "Sign in with GitHub → create/name org (tenant) → install GitHub App on chosen repos → connect Jira via OAuth, pick project/board → dashboard renders this tenant's deploy/flag/Jira data, with zero manual JSON editing"
    - topic: "blast radius / migration posture"
      decision: "PoC — no requirement to keep the current EVDT static dashboard running uninterrupted; hard cut to the new system is acceptable, EVDT becomes tenant #1 post-migration"
    - topic: "timeline commitment"
      decision: "6-week after-hours MVP, explicitly acknowledged as a sustained-effort commitment (see Timeline acknowledgment below)"
  frs_drafted: 12
  quality_check_status: accepted
---

## Current System

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
  - **GitHub**: a shared GitHub App installed per app-repo; each app repo's own workflow calls a reusable `notify-deployment.yml` / `check-flags.yml` workflow to push a `repository_dispatch` into this repo. Deployment history itself is pulled via polling (GitHub Deployments API) on cron/dispatch, not real-time webhooks.
  - **Jira**: a single shared service-account API token (Basic auth, email+token) configured via env vars in this repo's own GitHub Actions secrets. Sync is cron-based (current PI) plus manual backfill for past PIs.
- **Configuration today**: `docs/components.json` (tracked component list) and `docs/jira-spaces.json` (Jira project/board allowlist) are plain JSON files in this repo, edited by hand via git commit. There is exactly one tenant (EVDT) and one shared dataset; nothing is parameterized per-organization.

## Vision & Problem Statement

**This is a PoC** — the current EVDT dashboard does not need to keep running uninterrupted through this change, and a hard cut to a new foundation is acceptable. Nothing from the current data/integration layer is a hard constraint.

The gap: ShipScope's integration and configuration model is single-tenant and config-via-commit — onboarding any new organization today would mean forking this repo or hand-editing its JSON config files and wiring a shared GitHub App token into that org's own workflows. That doesn't scale past one org, and it has no self-serve path at all. Separately, the GitHub ingestion path pushes to this repo via each app-repo's own CI step rather than consuming events directly — though the user is explicitly open to this being solved by something other than webhooks if there's a better approach once stack/platform constraints are known.

The insight that makes this worth productizing rather than pointing a customer at a generic "connect GitHub + Jira" dashboard: ShipScope's actual value isn't the raw integration (lots of tools do that) — it's the **domain-logic join** across deployments, feature flags, and Jira issues: drift detection between environments, per-flag release status (deployed vs released vs partial), ghost-flag / unconsumed-value detection, and lead-time-to-prod. That logic already exists and works for one org; the SaaS pivot is about making it reachable by any company without needing to fork a repo.

## User & Persona

**Primary persona**: a technical or release-owner person at a customer company — e.g. a tech lead, release manager, or DevOps engineer — who connects their own organization's GitHub and Jira to ShipScope and views the resulting deployment/flag/Jira dashboard for their own team's components. They are not a ShipScope operator; they are a customer, self-serving their own onboarding.

## Access Control Changes

**Current model**: none. The dashboard is a fully public, unauthenticated static site (GitHub Pages) — anyone with the URL sees everything, no role separation.

**Planned model**: full rebuild, not an incremental change.
- **Auth**: OAuth login ("Sign in with GitHub"). No separate password management. A GitHub account can belong to, or create, one or more tenant organizations.
- **Tenancy**: each customer company is its own isolated tenant/workspace — its own GitHub/Jira connections, its own data, invisible to other tenants.
- **Roles within a tenant**:
  - **Admin** — connects/disconnects GitHub and Jira integrations, invites/removes members, configures tracked components and PI/board mappings.
  - **Member** — dashboard-only access (Product view, Technical view, Release Notes, Insights); no access to integration settings.

## Success Criteria

### Primary
- A new company can, without any manual JSON editing or contact with the ShipScope team: sign in with GitHub, create their own tenant org, install the GitHub App on their chosen repos, connect Jira via OAuth and pick a project/board, and see their own deployment/flag/Jira dashboard populated with real data from their own GitHub + Jira.

### Secondary
- After the first connection, an Admin can self-serve add/remove tracked repos or Jira projects/boards without needing manual help from the ShipScope team for the *second* onboarding step onward.

### Guardrails
- **Tenant data isolation**: Company A can never, under any circumstance, see Company B's deployments, flags, or Jira data.
- **Credential hygiene**: OAuth tokens and GitHub App installation tokens are stored encrypted and never appear in logs or reach the frontend.

## Timeline acknowledgment

Acknowledged on 2026-10-15: 6-week MVP (auth + multi-tenancy + DB, GitHub App integration, Jira OAuth integration, dashboard wiring + QA) requires sustained after-hours dedication; user accepted.

## User Stories

### US-01: New customer onboards their company to ShipScope end-to-end

- **Given** a user with a GitHub account and admin access to their company's Jira
- **When** they sign in with GitHub, create a new tenant org, install the ShipScope GitHub App on their chosen repos, and connect Jira via OAuth selecting a project/board
- **Then** they see a dashboard populated with their own company's deployment, flag, and Jira data — with no manual JSON editing and no contact with the ShipScope team

#### Acceptance Criteria
- The full flow completes without any step requiring a ShipScope-team action
- Data shown belongs exclusively to the signed-in user's own tenant
- After the initial connection, newly-arriving GitHub/Jira activity reflects on the dashboard within seconds, not minutes — a near-live feel, not a batch-sync delay

## Scope of Change

Tenant data isolation is captured once, as a guardrail under Success Criteria — it is not duplicated here as its own FR (Socratic round, FR-004 original draft: dropped as redundant with the guardrail).

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
- [modified] FR-005: System ingests deployment data from connected repos into tenant-scoped storage. Priority: must-have (existing sync logic, now per-tenant DB instead of global JSON+git)
  > Socratic: Counter-argument considered: "polling across many tenants at once could hit GitHub rate limits faster than today's single-org model." Resolution: FR stands as-is; captured as an implementation-level Open Question (see below), not a PRD scope change.
- [new] FR-006: Admin can add/remove tracked repos after initial connection. Priority: must-have
  > Socratic: Counter-argument considered: "without this, the 'self-serve, no contact needed' claim in the Vision is only half true — changing the repo set after onboarding still needs manual help." Resolution: bumped from nice-to-have to must-have.

### Jira integration
- [new] FR-007: Admin can connect their Jira instance via OAuth. Priority: must-have
  > Socratic: Counter-argument considered: "Jira OAuth (3LO) requires a registered Atlassian app with a redirect URI — an external setup dependency, not just code." Resolution: FR stands as-is; the Atlassian app registration is noted as an implementation prerequisite, not a scope change.
- [new] FR-008: Admin can select which Jira project(s)/board(s) to sync. Priority: must-have
  > Socratic: Counter-argument considered: "a customer's Jira work may be spread across more than one Atlassian site/cloud ID." Resolution: known MVP limitation, noted; FR stands as-is. One Jira site per tenant is the MVP assumption.
- [modified] FR-009: System ingests Jira issues into tenant-scoped storage, joined by PI/sprint. Priority: must-have
  > Socratic: Counter-argument considered: "per-tenant OAuth tokens have different Jira API rate-limit buckets than today's single shared service-account token." Resolution: FR stands as-is; captured as an implementation-level Open Question (see below).

### Dashboard
- [modified] FR-010: User can view the Technical view (component × env matrix, deploy history, flags) scoped to their tenant. Priority: must-have
  > Socratic: Counter-argument considered: "drift/ghost-flag/lead-time logic runs today over in-memory JSON; moving to per-tenant SQL queries is a rewrite, not a lift — calling it 'preserved' undersells the work." Resolution: recategorized from [preserved] to [modified] — the user-facing behavior/logic is preserved, the implementation is not.
- [modified] FR-011: User can view the Product view (Jira-centric, grouped by Epic) scoped to their tenant. Priority: must-have
  > Socratic: same counter-argument and resolution as FR-010 (shared architectural change).
- [modified] FR-012: User can view Release Notes and Insights scoped to their tenant. Priority: nice-to-have
  > Socratic: same counter-argument and resolution as FR-010 (shared architectural change).

## Business Logic Changes

No domain logic change. This is an infrastructure/technical change.

The existing domain rule is preserved as-is: ShipScope decides, per component/environment/feature-flag, whether a change is actually live for users — not merely deployed — by joining deployment state, flag state, and linked Jira issues, and surfacing drift, rollbacks, and stale "ghost" flags (unconsumed value) along the way. The SaaS pivot does not change this rule; it changes how data reaches it (per-tenant self-serve ingestion instead of one hand-configured dataset).

## Constraints & Compatibility

- **Backward compatibility**: none required. This is a PoC; there are no existing external API consumers or data-format contracts that must be preserved.
- **Data migration**: no live migration of EVDT's existing data into the new multi-tenant model. EVDT onboards as an ordinary new tenant ("tenant #1") through the same self-serve flow as any other customer. The existing `docs/data/*.json` snapshots are not thrown away, though — they're repurposed as seed/fixture data for local development and automated tests (the codebase already has a `FALLBACK` sample dataset and a `node:test` suite that benefits from realistic fixtures), not as production tenant data.
- **Existing integrations**: none must continue working unchanged. The current reusable workflows (`notify-deployment.yml`, `check-flags.yml`) and the shared GitHub App / Jira service-account-token model may be fully replaced by the new per-tenant GitHub App + Jira OAuth integration. EVDT's own app repos get re-wired to the new model as part of this change, same as any other tenant's onboarding.
- **Preserved behavior**: the dashboard's domain logic and views (Technical view, Product view, Release Notes, Insights) are preserved as user-facing behavior (see FR-010/011/012 above) — the implementation underneath is not preserved.

## Non-Functional Requirements

- Newly-arriving GitHub/Jira activity reflects on the dashboard within seconds of the underlying event, not minutes (same near-live property as US-01's acceptance criteria).
- The dashboard renders a typical tenant's data (component × env matrix, issue list) within 2 seconds of navigation, perceived by the user.
- No formal uptime or data-retention SLA is committed to at this PoC stage — this is an explicit non-goal, not an oversight (see Non-Goals below).

## Non-Goals

- **No SSO/SAML for enterprise customers.** GitHub OAuth is the only sign-in path in MVP. Rationale: keeps auth simple for the first SaaS pivot; enterprise IdP integration is a real need but not a blocker for proving the model.
- **No multi-org-per-tenant GitHub, no multi-site-per-tenant Jira.** One GitHub org and one Jira Cloud site/cloud ID per tenant in MVP. Rationale: most companies fit this shape; supporting fragmented setups adds real complexity before the core model is validated.
- **No GitLab/Bitbucket, no Jira Server/Data Center (on-prem).** MVP integrates exclusively with GitHub.com and Jira Cloud. Rationale: the self-serve OAuth/App-install flows this MVP depends on don't exist in the same form for on-prem trackers or other VCS providers.
- **No formal uptime or data-retention SLA.** No contractual availability or retention guarantees at this PoC stage. Rationale: this is a PoC proving the multi-tenant self-serve model works, not a production commitment to paying customers yet.

## Forward: tech-stack

- The original pivot idea included moving GitHub ingestion from polling/push-from-CI to webhook-based event listening. The user is explicitly **not** committed to webhooks specifically — open to whatever ingestion mechanism best satisfies the "near-live within seconds" NFR above, to be decided during stack selection / implementation planning, not here.
- Needs a real backend + database + multi-tenant auth (OAuth) — a genuine architectural departure from today's "Node scripts + GitHub Actions + static JSON on git" model. No specific framework/database/hosting platform has been chosen; that's downstream of this PRD.
- GitHub App (replacing the current shared GitHub App + reusable-workflow dispatch model) and Jira OAuth (3LO, replacing the current shared service-account token) are both needed; registering the Atlassian OAuth app is an external setup dependency to track early.

## Open Questions

1. **How should feature flags be managed and linked to a Jira work item in the multi-tenant SaaS?** — The current single-tenant model discovers flags from each repo's own generated code (`flag-parts`/`*.generated.ts` patterns) and links them to Jira via a `jiraKeys[]` array set manually in `flags-meta.json`. In a self-serve, per-tenant world, it's not yet decided whether flags are still discovered from repo code per tenant, managed directly in the ShipScope UI, or linked to Jira via a dedicated custom Jira field instead of manual metadata entry. Owner: user. By: before flag-related FRs are implemented.
2. **How is GitHub sync throttled/queued across many tenants at once?** — Today's single-org polling model has no cross-tenant contention. Multi-tenant polling needs a strategy (queueing, per-installation rate-limit tracking, etc.) to avoid one tenant's sync starving another's. Owner: user (or downstream implementation planning). By: before implementation planning for FR-005.
3. **How does per-tenant Jira OAuth rate-limiting differ from today's shared service-account token model?** — Needs confirming whether per-tenant OAuth tokens get independent rate-limit buckets from Atlassian, which would simplify this considerably. Owner: user (or downstream implementation planning). By: before implementation planning for FR-009.
