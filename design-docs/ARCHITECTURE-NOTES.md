# Architecture notes — multi-team and multi-tenant support for ShipScope

*Polska wersja: [ARCHITECTURE-NOTES.pl.md](ARCHITECTURE-NOTES.pl.md)*

> **Status: exploratory, not decided.** This document records the considerations, findings, and options
> examined while assessing how ShipScope could become easy to adopt for many independent teams and services.
> None of this has been implemented. It is intended as source material for an eventual Architecture Decision
> Record, not a decision in itself — the terrain has been mapped, but nothing here has been settled.

## Starting point

ShipScope currently tracks three components known in advance (`evapl-service-frontend`,
`evnm-service-charger-infrastructure`, `evboweb-service-bff`), with repository names and flag configuration
hardcoded in several places: `.github/workflows/orchestrate-full-sync.yml`, `sync-runtime-be-flags.yml`, and
`retrigger-app-checks.yml`.

Goal: any team with deployments and/or flags — or with no flags at all — should be able to connect to
ShipScope with minimal effort, remaining as independent as possible from how other teams manage their own
deployments and flags, without requiring a change to ShipScope's central repository for every new case.

## What already works well

This section matters because it narrows the scope to what is actually missing, rather than implying that
everything requires rebuilding.

- **Build-time flags are already fully decentralized.** `check-flags.yml` is a reusable workflow
  (`workflow_call`); a team adds a small workflow of its own that calls it with its own parameters
  (`FLAGS_SEARCH_ROOT`, `COMPONENT`). ShipScope does not need to know that team exists in advance.
- **Deployments already have a push mechanism.** `orchestrate-full-sync.yml` reacts to
  `repository_dispatch: deployment-completed` with a `client_payload.component` payload sent by a team's own
  CI. This is not polling; the reporting team decides when to report a deploy.
- **A single flag update already has a push mechanism.** `update-flag-state.yml` reacts to
  `repository_dispatch: flag-changed` with a `{FLAG_KEY, ENVIRONMENT, ENABLED, CHANGED_BY}` payload. This
  already works today, with no new code required, provided a team can fire that dispatch from its own side.
- **Missing flag data does not cause failures.** `effectiveFlagState()` in `app.js` returns `null` when no
  entry exists for a given source and environment, and the UI renders that as a dash rather than an error.
  Similarly, an empty `flags-meta.json` displays "No flags defined" rather than an exception. A component
  with no flags at all is never blocked in Product view; an issue with no linked flag proceeds directly to
  "Released" once deployed.
- **Jira issue discovery is already dynamic.** `sync-jira.js` derives exactly which issues to query from
  keys found in the commit messages of deployments already synced (`deriveIssueKeysFromDeployments`), rather
  than from a static list — and scopes the search to those specific issues, not to whichever whole
  project(s) they happen to belong to. This is an existing example of deriving configuration from data
  rather than hardcoding it.

## What is actually missing

1. **The safety-net schedule in `orchestrate-full-sync.yml` and `sync-runtime-be-flags.yml`** checks only a
   pre-listed set of components; a new team is not covered until the YAML file is edited.
2. **`sync-runtime-be-flags.js` supports only a pull model** — a URL known in advance, stored as a `vars`
   entry in ShipScope's own repository. Onboarding a new team requires an administrator to add that team's
   URL. No adapter exists today for other tools such as LaunchDarkly, Unleash, AWS AppConfig, or Bedrock.
3. **`retrigger-app-checks.yml`** has its token scope limited to one specific repository
   (`evapl-service-frontend`) and will not work for others without modification.
4. **The dashboard is a single static page at a single address**, with no per-team path or isolation; see the
   GitHub Pages section below.

## Options considered — deployments and the safety-net schedule

| Option | Mechanism | Advantages | Drawbacks |
|---|---|---|---|
| **A. Retain the hardcoded list** | Status quo. | No work required. | Every new team requires a pull request to ShipScope. |
| **B. Central configuration file** (e.g. `shipscope.config.json`) | The `prepare` job reads a file listing components and repositories and builds the matrix dynamically, replacing today's hardcoded bash `case` statement with the same logic sourced from a file. | A small, low-risk step. A pull request is still required, but confined to a single file rather than several YAML files. | Still requires a pull request to ShipScope's repository for every new team; does not achieve true independence. |
| **C. Discovery via GitHub topics** | The schedule queries the GitHub API for repositories in the organization carrying a `shipscope-tracked` topic, rather than reading a list from a file. | A team onboards itself by adding a topic in its own repository settings, with no pull request to ShipScope required. The safety net automatically covers new teams. | Requires permission to search repositories across the organization (a token with the appropriate scope). Does not by itself determine how flags should be configured for a newly discovered repository; that remains a separate decision. |

**Tentative conclusion**: option C appears closest to the goal of team independence and is a relatively
small change, since the primary push signal already exists. Option B is a more conservative first step if C
represents too large a jump initially.

## Options considered — flag sources (LaunchDarkly, Unleash, Bedrock, or others)

| Option | Mechanism | Advantages | Drawbacks |
|---|---|---|---|
| **Push, initiated by the owning team** | The owning team runs a small relay of its own: a webhook from its tool triggers a function or scheduled job, which calls `repository_dispatch: flag-changed` on ShipScope. | The tool's secret or API key never reaches ShipScope's repository. Already works today, with no new ShipScope code required. Maximizes team independence. | The owning team must host and maintain something, even if small. Requires a one-time grant of a dispatch-capable token to ShipScope's repository, an administrative action rather than a code change. |
| **Pull, one adapter per tool type** | ShipScope maintains a script such as `sync-launchdarkly-flags.js` or `sync-unleash-flags.js` that normalizes that tool's API response into the shared `flagStates[key][env][source]` shape. Written once per tool type and reused by every team using that tool. | No work required from the owning team beyond providing a URL or API key. | ShipScope must hold secrets for multiple teams' accounts across multiple tools, increasing its responsibility and risk while reducing team independence. An adapter must be written if the tool is not yet supported. |
| **Hybrid** | The owning team writes its own script following the same output contract as `sync-runtime-be-flags.js`, hosts it independently, and sends only the already-normalized payload to ShipScope. | Combines the advantages of both approaches: secrets remain with the owning team, and no one has to wait for ShipScope to build an adapter for a specific tool. | Requires the owning team to understand the data shape ShipScope expects, somewhat more than simply configuring a webhook. |

**Tentative conclusion**: the push model, or the hybrid variant, is structurally closer to the goal of team
independence, since ShipScope never holds the relevant secrets. Pull adapters make sense mainly as a
convenience for teams unable or unwilling to maintain even a small relay, and should be evaluated case by
case rather than treated as the default path.

**Where to declare the source is not the hard part.** It would be easy enough to record, per component —
e.g. in `docs/components.json`, alongside the entries added when onboarding a new component (see
`ONBOARDING.md`) — which flag mechanism that component uses (`build`, `runtime-be`, or eventually a named
third-party provider) and non-secret pointers like a base URL or a project key. That's no different from
what's already stored there today, and no more sensitive: nothing secret has ever belonged in that file,
today's `COMPONENT`/`APP_REPO` values aren't secrets either. The actual decision this table is about is a
different question entirely: **who ends up holding the credential a given source requires.** A source
field only forces that question once it implies pull — i.e. once ShipScope itself would need an API
key/token to reach into that source on a schedule. That's what concentrates several teams' tools' secrets
into ShipScope's own GitHub Secrets, and turns ShipScope into the party responsible for scoping and
rotating credentials it doesn't own — the actual drawback listed for the pull-adapter row above, not a
storage-format problem. Push and hybrid avoid this entirely because no source-access credential ever needs
to exist inside ShipScope in the first place; a `components.json` entry for those simply documents where a
push comes from, not how to reach in and get it.

**A concrete case that came up: flags backed by Spring environment variables (`evsim-service-sim-adapter`).**
Some components define flags as Spring `${ENV_VAR:default}` placeholders in `application.yml` — the
committed file only shows the *default*, since the real value can be overridden per environment by an
actual environment variable. The live value is only observable through that app's own Spring Boot Actuator
endpoints, `/actuator/env/{name}` (one property at a time, wrapped in metadata, value typically a string
rather than a JSON boolean) or `/actuator/configprops` (the full config tree, nested per
`@ConfigurationProperties` bean, not a flat map). Neither shape matches what `sync-runtime-be-flags.js`
already knows how to consume — it expects one flat top-level JSON object of `{ flagKey: true|false, ... }`
(`filterBooleanFlags`) — so pointing it at either Actuator endpoint directly would need new parsing logic
plus a maintained mapping from each flag key to its Spring property path, on top of whatever credential
that Actuator endpoint's own `SecurityConfiguration` requires (a new, if narrowly-scoped, secret; today's
`fetchEnvFlags` sends no auth at all). It would also expose far more than flag state: `/actuator/env` and
`/actuator/configprops` dump a service's entire resolved configuration tree, not just the handful of
properties that happen to be feature flags. The lower-cost, lower-exposure alternative — consistent with
the push/hybrid preference above — is to ask the owning team to expose one small purpose-built endpoint
returning exactly the flat shape `sync-runtime-be-flags.js` already expects, reusing that script unchanged
rather than teaching ShipScope to reach into a generic config-introspection surface.

## GitHub Pages — a single address, no per-team isolation

This is an architectural constraint, not something configurable without a substantially larger rebuild.

- GitHub Pages serves a single static site from a single branch (`live`), at a single address. There is no
  per-team path such as `/team-1` or `/team-2`; nothing of that kind exists in this model.
- The files under `docs/data/*.json` combine every component's, flag's, and Jira data into single files,
  downloaded in full by any visitor to the page.
- The UI filters for environment and component are purely client-side conveniences: they show or hide rows
  within the same dataset. They do not create separate addresses and do not restrict access. The underlying
  JSON files remain publicly reachable regardless of the filters applied.

### Options considered

| Option | What it provides | What it does not provide |
|---|---|---|
| **Filter state reflected in the URL** (`?component=X&env=Y`) | A bookmarkable or shareable link that opens directly to a particular view. A small, low-risk addition to what already exists. | Real isolation. The data remains publicly reachable at the same address and files regardless of the URL parameters used. |
| **True isolation (separate instances per team)** | Genuine data separation, such that one team has no physical access to another team's data. | GitHub Pages does not support partial, per-path access control; a site is either entirely public or entirely private behind GitHub authentication. This option requires separate repositories and Pages deployments per team — a substantially larger undertaking involving real multi-tenancy, with data, secrets, and permissions all separated. |

**Open question, currently unresolved**: is shared visibility across teams a feature of this design, given
that joining signals across repositories is the stated purpose of ShipScope per the README, or a problem for
the specific case of many independent teams? This depends on whether the components or applications intended
to connect are sufficiently independent, from a business perspective, that combining their data into a
single view ceases to be useful. This has been identified as a question to resolve, not a settled matter.

## Summary — changes that appear low-regret

The following changes appear worth making regardless of how the isolation question is eventually resolved:

- GitHub-topic-based discovery for the safety-net schedule, removing the last hardcoded element on the
  deployments side.
- Documenting and favoring the push model (`repository_dispatch: flag-changed`) as the default path for new
  flag integrations, with pull adapters treated as an exception rather than the norm.
- Reflecting filter state in the URL, as a convenience rather than a security measure, independent of the
  isolation decision.

## Open questions to resolve before an ADR can be written

1. Is shared visibility across teams acceptable, or is real isolation required? See the GitHub Pages
   section.
2. Which specific flag tools must be supported from the outset — LaunchDarkly, Unleash, Bedrock, an internal
   system, or others? This determines whether writing pull adapters is worthwhile, or whether to commit
   fully to the push model.
3. Who administers the granting of dispatch tokens and permissions for new teams, and what should that
   process look like — a self-service form, or a manual request to an administrator?
4. Is fully reusable, multi-tenant workflow support (Option B in the deployments discussion) on the roadmap
   at all, or does ShipScope remain a one-instance-per-organization model?