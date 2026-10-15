---
project: "evdt-service-shipscope"
assessed_at: "2026-10-15T17:05:03Z"
agent_readiness: ready-with-compensation
context_type: brownfield
stack_components:
  language: JavaScript (no TypeScript)
  framework: none (plain Node.js scripts; vanilla JS frontend)
  build_tool: none
  test_runner: "node:test (built-in)"
  package_manager: npm (implicit — zero dependencies, no lockfile)
  ci_provider: "GitHub Actions"
  deployment_target: "GitHub Pages (static docs/)"
gates_passed: 4
gates_failed: 2
---

## Stack Components

**Language**: JavaScript, no TypeScript. No `tsconfig.json`, no `.ts` files, no `checkJs` configuration anywhere in the repo. Confirmed by `package.json` (`"description": "ShipScope — no dependencies; this file only exposes \`npm test\`."`).

**Framework**: none, by design. `scripts/*.js` are plain Node.js programs using only built-ins and global `fetch` — no web framework, no CLI framework. The frontend (`docs/app-*.js`) is vanilla JS/HTML/CSS with no framework, no build step, loaded as classic `<script>` tags specifically so it works over `file://` without a bundler.

**Build tool**: none. No bundler, no transpiler. This is a deliberate zero-build-step architecture, not a gap — the project's own CLAUDE.md states "There is no linter or bundler in this repo" as a fact about the system, not an oversight.

**Test runner**: `node:test`, Node's built-in test runner, invoked via `npm test` → `node --test "test/*.test.js"`. ~360 cases documented in CLAUDE.md at ~99.8% line / ~97% branch coverage. No external test framework (Jest/Mocha/Vitest) is used.

**Package manager**: npm, implicitly — there is no lockfile because there are zero third-party dependencies to lock.

**CI/CD**: GitHub Actions, extensively used — 11 workflow files orchestrating data syncs, backfills, and flag management (`orchestrate-full-sync.yml`, `check-flags.yml`, `sync-jira.yml`, etc.). Notably, **no workflow in `.github/workflows/` currently runs the test suite on PR or push** — CLAUDE.md documents a `test.yml` for this purpose, but it is not present on disk. This is either stale documentation or a workflow that was removed; worth confirming with the user/team, since it means `npm test`'s ~360 cases are not enforced as a CI gate today despite the extensive investment in test coverage.

**Deployment target**: GitHub Pages, serving the `docs/` directory statically off the `live` branch. No deployment config file exists because there is nothing to configure — Pages serves whatever is committed.

**Instruction files**: `CLAUDE.md` (checked in, extensive — the most detailed artifact in the repo) and `CLAUDE.local.md` (not checked in, team-factory/agent-orchestration conventions). No `AGENTS.md`.

## Quality Gate Assessment

| Component            | Typed | Convention | Training Data | Documented | Verdict         |
|-----------------------|-------|------------|----------------|------------|-----------------|
| Language (JS)         | ✗     | —          | —              | —          | fail            |
| Framework (none/vanilla) | —  | ~          | ✓              | ✓          | pass (w/ note)  |
| Build tool (none)     | —     | —          | —              | —          | n/a — by design |
| Test runner (node:test) | —   | —          | ✗              | ✓          | partial/fail    |

Legend: ✓ = pass, ✗ = fail, ~ = partial, — = not applicable

### Gate Details

**Typed — fail.** No static types anywhere in `scripts/`, `docs/app-*.js`, or `test/`. An agent reading a function signature (e.g. `safeRelativePath(path)`, `loadOrCompute(...)`) has to read the function body or its call sites to infer argument/return shapes — it cannot reason from a type annotation alone. Evidence: no `tsconfig.json`, no `// @ts-check` pragma, no JSDoc `@param`/`@returns` blocks observed in the sampled files, no `checkJs` anywhere.

**Convention-based — partial pass.** There is no *framework* enforcing structure (no Express/Hono/etc. routing conventions apply, since these are standalone scripts, not a server). However, the project has unusually strong **documented** conventions in `CLAUDE.md`: one-script-one-job pattern (`scripts/*.js` ↔ one GitHub Actions workflow each), shared logic factored into `scripts/lib/*.js`, a strict "read-existing-JSON → merge → write-back" idempotency shape every data-mutating script follows, the `docs/app-{core,data,...}.js` load-order convention with documented hoisting pitfalls, and the `html` tagged-template escaping convention. This is exactly the "minimal framework BUT documented conventions in instruction files" case the scoring rubric calls out as pass-with-note.

**Training data (framework) — pass.** Plain Node.js (built-ins + `fetch`, no framework) is about as well-represented in LLM training data as a JS stack gets — it's the baseline the language itself is taught against, not a niche library.

**Documented (framework) — pass.** Node.js's own official docs (versioned, current, exhaustively covering every built-in module used here — `fs`, `http`, `child_process`, `vm`, `node:test`) are excellent.

**Training data (test runner) — fail.** `node:test` stabilized relatively recently (Node 18/20) and has far less representation in general JS training-data corpora than Jest, Mocha, or Vitest — an agent is more likely to default to Jest-style assertions/mocking patterns (`jest.mock`, `expect(...).toHaveBeenCalledWith`) unless steered toward `node:test`'s own API (`describe`/`it`/`t.mock`, `assert` module).

**Documented (test runner) — pass.** `node:test` has thorough, versioned official Node.js documentation.

## Gaps & Compensation

### Gap 1 — Untyped JavaScript

**Why it matters for agent workflows**: without types, an agent extending or refactoring a function has no compile-time signal that it broke a caller — it has to trust tests (strong here, ~97% branch coverage) or re-read every call site. This gap matters *more* going forward than it has so far: the PRD (`context/foundation/prd.md`) scopes a brand-new backend, database layer, multi-tenant auth, and two external OAuth integrations (GitHub App, Jira 3LO) — real API/data boundaries where an untyped payload shape is a much costlier mistake than in today's small, single-purpose sync scripts.

**Compensation** — add to `CLAUDE.md`:

```markdown
## Type discipline (no TypeScript in this repo)

This codebase is intentionally plain JavaScript with no build step. Compensate
for the lack of static types with explicit discipline, especially in any new
backend/API code:

- Every exported function gets a one-line JSDoc `@param`/`@returns` block
  stating the shape of its arguments and return value — not prose, the shape
  (e.g. `@param {{ tenantId: string, repoFullName: string }} input`).
- Any boundary that receives external input (HTTP request bodies, OAuth
  callback payloads, GitHub/Jira webhook or API responses) validates that
  input against an explicit schema before using it — do not trust shape from
  a third-party API response without checking the fields you read exist and
  are the expected type.
- Prefer `node:assert`'s type-checking helpers or a small runtime schema
  check over trusting an untyped object straight through to a database write.
```

### Gap 2 — `node:test` is less represented in training data than Jest/Mocha/Vitest

**Why it matters for agent workflows**: an agent asked to "add a test" may default to Jest-style syntax (`jest.fn()`, `expect().toHaveBeenCalled()`) which doesn't exist in `node:test`, producing code that looks plausible but fails immediately.

**Compensation** — already substantially present in `CLAUDE.md` (the "What this repo is" section documents the exact test-process-isolation pattern, the `test/sync-harness.js` / `test/flag-scripts-helpers.js` helper convention, and the `vm`-context stub-DOM approach for frontend tests). The one addition worth making:

```markdown
## Test runner — node:test, not Jest

Tests use Node's built-in `node:test` + `node:assert`, not Jest/Mocha/Vitest.
Do not use `jest.fn()`, `jest.mock()`, or `expect(...).toHaveBeenCalledWith(...)`
— none of that API exists here. Use `t.mock.fn()` / `t.mock.method()` from the
`node:test` context, and plain `assert.strictEqual` / `assert.deepStrictEqual`
/ `assert.rejects` from `node:assert`. See any existing `test/*.test.js` file
for the pattern before writing a new one.
```

### Gap 3 (process, not a quality gate — noted because it's cheap to fix) — no CI workflow runs the test suite

CLAUDE.md documents a `.github/workflows/test.yml` running `npm test` on every PR and push to `main`; no such file exists in `.github/workflows/` today. Whether this was removed, renamed, or never committed, it means the ~360 `node:test` cases and ~99.8%/~97% coverage this repo has invested in are not currently enforced as a merge gate. Worth confirming with the user before the SaaS-pivot work begins — a growing codebase without a CI test gate accumulates risk fast, especially once a real backend/database/auth layer lands.

### Recommended Instruction File Additions

Both Gap 1 and Gap 2's markdown blocks above are ready to paste into `CLAUDE.md` as-is, under a new `## Type discipline` and reinforced `## Testing` heading respectively.

## Summary

**Overall verdict: ready-with-compensation.** The stack is deliberately minimal (plain Node.js, no framework, no build step, no TypeScript) — a reasonable choice for the small, single-purpose sync scripts this repo has run so far, and one that already has unusually strong documented-convention compensation in `CLAUDE.md` for the framework/convention gap. The two real gate failures (untyped JavaScript, less-common test runner) are both squarely in the "clear compensation path" category, not "switch stacks" territory — and the test-runner gap is already mostly compensated by this repo's existing documentation.

**Key strength**: the existing `CLAUDE.md` is exceptionally thorough — most of what a "convention-based" framework would give an agent for free, this repo gives explicitly in prose instead, and it already covers the exact failure modes (test-runner API confusion, load-order pitfalls, idempotency conventions) a fresh agent would otherwise hit.

**Key gap to flag explicitly**: this assessment evaluates the stack as it exists *today* — a set of standalone sync scripts. The brownfield PRD (`context/foundation/prd.md`) scopes something structurally different: a real multi-tenant backend, a database, OAuth-based auth, and two new external integrations. None of those components exist yet, so they can't be scored here — the untyped-JS gap (Gap 1) will matter considerably more once that code exists than it has for the current sync scripts, which is exactly why the compensation entry above is scoped toward "new backend/API code," not the existing scripts.

**Recommended next step**: `/10x-health-check` — to audit dependency health, confirm the CI-test-gate discrepancy (Gap 3), and produce an agent-readiness verdict for the existing code before implementation planning begins on the SaaS-pivot PRD.
