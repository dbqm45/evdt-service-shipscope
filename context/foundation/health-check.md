---
project: "evdt-service-shipscope"
checked_at: "2026-10-15T17:10:00Z"
health_status: needs-attention
context_type: brownfield
language_family: js
stack_assessment_available: true
checks_run:
  - lockfile
  - dependency_audit
  - outdated_deps
  - test_runner
  - ci_cd
  - configuration
audit_findings:
  critical: 0
  high: 0
  moderate: 0
  low: 0
test_runner_detected: true
ci_provider: "GitHub Actions"
recommended_fixes: 5
---

## Dependency Health

### Lockfile

```
Status: missing
Package manager: npm (by design — zero third-party dependencies, nothing to lock)
```

Not a reproducibility risk here: `package.json` has no `dependencies`/`devDependencies` at all (it exists only to expose the `npm test` script), so there is nothing a lockfile would pin. This is the expected state for this project, not a gap.

### Security Audit

```
Tool: npm audit --json
Status: failed to run (ENOLOCK — requires an existing lockfile)
Summary: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW
Direct vs transitive: not applicable — zero dependencies
```

`npm audit` refused to run without a lockfile, but this is a non-finding: with zero third-party dependencies, there is no dependency surface to have vulnerabilities in the first place.

### Outdated Dependencies

```
Packages with major version gaps: 0
```

`npm outdated --json` returned an empty result — consistent with zero dependencies.

## Test Suite

```
Test runner: node:test (Node.js built-in)
Tests found: 33 test files, 419 individual test cases across 24 suites
Test execution: passing (419/419, 0 failures, 0 cancelled, ~44s total runtime)
```

Configuration: no dedicated config file — invoked directly via `package.json`'s `test` script (`node --test "test/*.test.js"`).

One minor documentation drift found while verifying this: `CLAUDE.md` states "~360 cases"; the actual run reports 419. Not a functional problem — the suite runs clean — but worth a one-line correction next time `CLAUDE.md` is touched, since the exact number is cited as evidence of coverage depth.

## CI/CD

```
Provider: GitHub Actions
Configuration: .github/workflows/ (11 workflow files)
```

| Stage      | Status | Notes                                                                 |
|------------|--------|------------------------------------------------------------------------|
| Lint       | ✗      | not configured — no linter exists in this repo (deliberate, see Configuration) |
| Test       | ✗      | **not configured** — no workflow runs `npm test`; see Recommended Fixes |
| Build      | n/a    | no build step by design — static site, no bundler                     |
| Type check | n/a    | no TypeScript in this repo                                             |
| Security   | ✗      | not configured — no `npm audit`/Dependabot/CodeQL step                 |

This repo is unusual for a "no CI" case: it has *extensive* GitHub Actions usage (11 workflows) — just none of them verify code correctness. All 11 existing workflows are data-sync/flag-management automations (`orchestrate-full-sync.yml`, `check-flags.yml`, `sync-jira.yml`, etc.), not quality gates. `CLAUDE.md` documents a `.github/workflows/test.yml` running `npm test` on every PR and push to `main` — that file does not exist on disk today (confirmed by directory listing). This is the same discrepancy `/10x-stack-assess` flagged; health-check confirms it directly rather than inferring it from documentation.

## Configuration

### Medium severity

- **No linter/formatter** (`.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `biome.json` — none present) — an agent's generated code style will drift (quote style, semicolons, import ordering) with nothing to catch it automatically. Fix: this is a **deliberate, documented** project choice ("There is no linter or bundler in this repo" — `CLAUDE.md`), not an oversight, so the fix here is a judgment call rather than a default action: adopt a zero-config formatter (e.g. `npx prettier --check .` as a CI step, no project config needed) only if style drift actually becomes a problem during the SaaS-pivot work, where the codebase is about to grow substantially.

### Low severity

- **No `.env.example`** — `CLAUDE.md`'s own Scripts table documents a large number of environment variables read by individual scripts (`FLAGS_META_PATH`, `JIRA_BASE_URL`, `GITHUB_TOKEN`, `COMPONENT`, etc.), but there is no single file enumerating them for a new contributor or agent to read at a glance. Fix: add `.env.example` listing every env var name (no real values) referenced across `scripts/*.js`, grouped by script — a 15–30 minute task, more valuable once the SaaS pivot adds real secrets (OAuth client IDs/secrets, database connection strings).
- **No `.editorconfig`** — minor; GitHub Actions/Node tooling doesn't depend on it, and there is no team-wide editor mismatch evidence. Fix: optional, add only if contributors report inconsistent whitespace/line-ending diffs.

`.gitignore` is present and reasonable (excludes `.env.local`, `tmp`, `*.sh`, `test/.tmp-*`). No other high-severity configuration gaps found.

## Stack Assessment Cross-Reference

```
Stack assessment: context/foundation/stack-assessment.md
Agent readiness (from stack-assess): ready-with-compensation
```

| Quality Gate Gap               | Health-Check Finding                                                                 | Status      |
|---------------------------------|---------------------------------------------------------------------------------------|-------------|
| typed: fail                     | No type-check in CI (none exists); recommended `CLAUDE.md` "Type discipline" entry not yet added | Reinforced  |
| convention_based: partial       | `CLAUDE.md` present and exceptionally detailed, confirmed on disk                      | Mitigated   |
| test runner training-data: fail | Test suite itself is healthy (419/419 passing); recommended `CLAUDE.md` "node:test, not Jest" entry not yet added | Reinforced (mitigation drafted, not yet applied) |

Both compensation entries `/10x-stack-assess` drafted for `CLAUDE.md` ("Type discipline" and "Test runner — node:test, not Jest") were checked directly against the current file — neither is present yet. They're ready to paste in; see Recommended Fixes below.

## Recommended Fixes

### Fix before agent work (Category A)

#### 1. No CI step runs the test suite

**Impact**: 419 passing tests with ~97% branch coverage currently catch nothing automatically on a PR — a regression (human- or agent-introduced) can merge to `main` unnoticed until it surfaces in production data. This matters more, not less, once the SaaS-pivot work starts: more surface area, more contributors (agent-assisted or not), same zero enforcement.
**Severity**: high
**Effort**: quick (< 5 min to scaffold; a few minutes of CI runtime to verify)
**Fix**:

```yaml
# .github/workflows/test.yml
name: Test
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
```

#### 2. Apply stack-assessment's "Type discipline" compensation to CLAUDE.md

**Impact**: without it, an agent writing new backend/API code for the SaaS pivot (real HTTP boundaries, OAuth payloads, database writes) has no steering toward validating external input shapes — exactly where untyped JS costs the most.
**Severity**: medium
**Effort**: quick (< 5 min — copy-paste)
**Fix**: paste the `## Type discipline (no TypeScript in this repo)` block from `context/foundation/stack-assessment.md` → "Gap 1" into `CLAUDE.md`.

#### 3. Apply stack-assessment's "node:test, not Jest" compensation to CLAUDE.md

**Impact**: without it, an agent asked to add a test is likely to reach for Jest-style syntax that doesn't exist in this codebase, producing code that fails immediately.
**Severity**: medium
**Effort**: quick (< 5 min — copy-paste)
**Fix**: paste the `## Test runner — node:test, not Jest` block from `context/foundation/stack-assessment.md` → "Gap 2" into `CLAUDE.md`.

#### 4. Add `.env.example`

**Impact**: a new contributor or agent has to read the entire `CLAUDE.md` Scripts table to discover what environment variables exist; a single enumerated file is a much faster reference, and becomes more important once the SaaS pivot adds real secrets (OAuth credentials, database URL).
**Severity**: low
**Effort**: moderate (15–30 min to enumerate every script's env vars)
**Fix**: create `.env.example` at the repo root listing every variable name referenced in `scripts/*.js` and `scripts/lib/*.js` (no real values — placeholders only).

#### 5. Correct the test-count figure in CLAUDE.md

**Impact**: purely cosmetic — `CLAUDE.md` cites "~360 cases" as evidence of coverage depth; the actual current count is 419. Low stakes, but an inaccurate number undermines trust in the rest of the (otherwise excellent) documentation.
**Severity**: low
**Effort**: quick (< 5 min)
**Fix**: update the figure in `CLAUDE.md`'s "What this repo is" section to the current count (re-run `npm test` to get the live number before editing, since it will keep growing).

### Addressed in upcoming lessons (Category B)

#### Missing AGENTS.md

**Lesson**: [Agent Onboarding: Agents.md, AI Rules i feedback loops (M1L4)](https://platforma.przeprogramowani.pl/external/10xdevs-3/m1-l4)
**What you'll do there**: generate a concise, ordered onboarding document for AI coding agents — this repo currently only has `CLAUDE.md` (Claude-specific); that lesson covers the tool-agnostic `AGENTS.md` equivalent and how to decide whether both are needed.

#### No build/deploy pipeline for the SaaS pivot's new backend

**Lesson**: [Sprint Zero z Agentem: infrastruktura, walking skeleton i pierwszy deploy (M1L5)](https://platforma.przeprogramowani.pl/external/10xdevs-3/m1-l5)
**What you'll do there**: pick a deployment platform for the new multi-tenant backend/database the PRD scopes, and produce a reviewed deploy plan — none of today's 11 workflows deploy an application server, because there isn't one yet.

## Summary

Health status: needs-attention

The dependency surface is a non-issue (zero third-party dependencies, nothing to audit or go stale), and the existing test suite is genuinely healthy — 419 passing cases, ~44s runtime, no flakiness observed. The real gap is process, not code: an extensive GitHub Actions setup (11 workflows) exists but none of them run that healthy test suite on a PR, so today's strong test coverage provides no automatic protection against regressions. Two already-drafted `CLAUDE.md` compensation entries from the stack assessment are ready to paste in but haven't been applied yet.

Next step: add the missing test-on-PR workflow and paste in the two pending `CLAUDE.md` compensation entries (both quick fixes) before starting implementation work on the SaaS-pivot PRD — then proceed to agent onboarding (`/10x-agents-md`, per Module 1 Lesson 4) for the rest of the Category B items.
