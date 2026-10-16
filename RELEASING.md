# Versioning and releases

*Polska wersja: [RELEASING.pl.md](RELEASING.pl.md)*

ShipScope has one version number following [Semantic Versioning 2.0.0](https://semver.org/) (`MAJOR.MINOR.PATCH`),
carried by `package.json`, `server/package.json` and `server/package-lock.json` (server/ is its own dependency
boundary with its own `package.json`, so it holds the number itself). A released version is marked by the git tag `vX.Y.Z` and has a
[GitHub Release](https://github.com/dbqm45/evdt-service-shipscope/releases) with its `CHANGELOG.md` entry. The
running server reports it in `GET /health` (`version`).

The mechanism is the same as in `dbqm45/ci_for_sdlc`; the differences are listed at the end.

## Commits: Conventional Commits

Commits and **PR titles** follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). PRs
are squash-merged, so the PR title becomes the commit on `main` and decides the next version.

```
<type>(<scope>)!: <description>

[body: why, not what]

[footers, e.g. Refs: #21  or  BREAKING CHANGE: <what and how to migrate>]
```

- **Description**: imperative, no trailing period, at most 72 characters.
- **Scope** (optional), one word: the project key `SHP` as in the existing history, or e.g. `server`, `deps`, `release`.

| Type | When | Version effect |
|---|---|---|
| `feat` | a new feature for users | MINOR |
| `fix` | a bug fix | PATCH |
| `perf` | faster, same behavior | PATCH |
| `refactor`, `test`, `docs`, `style`, `build`, `ci`, `chore`, `revert` | no user-visible change | none |
| `!` after type/scope, or a `BREAKING CHANGE:` footer | backward-incompatible change (any type) | MAJOR |

Checks:

- **CI**: the `PR title` workflow (`.github/workflows/pr-title.yml`) rejects a non-conforming PR title, also after
  the title is edited.
- **Locally** (optional, once per clone): `npm run hooks:install` enables the `commit-msg` hook from `.githooks/`.
  Check a single message with `npm run lint:commit -- "feat(SHP): …"`.

## Which bump (SemVer)

The **most serious** change since the last tag decides.

| Change to the public API | From 1.0.0 | In 0.y.z (now) |
|---|---|---|
| backward-incompatible (removed/renamed field or route, changed meaning, new required field) | MAJOR | MINOR |
| backward-compatible feature, new response field, deprecation | MINOR | PATCH |
| backward-compatible fix, security patch, dependency update | PATCH | PATCH |
| docs, tests, CI, refactoring only | no release | no release |

**0.y.z** means the public API is not stable yet (SemVer rule 4). **1.0.0** is released deliberately (a manual PR,
`npm run release -- 1.0.0`) once someone depends on the service. That is a human decision; CI never makes it.

Public API here means what users and integrations depend on: the `server/` HTTP routes (paths, methods, request
and response fields, status codes, cookies), its environment variables, the database schema as seen by migrations,
the `docs/data/*.json` formats the dashboard reads, and the reusable workflows app repos call (`check-flags.yml`,
`notify-deployment.yml`, the `ingest-flags` action). Internal details (code layout, log text) don't count.

## How the version is bumped (automatically)

After every merge to `main` the `Release` workflow (`.github/workflows/release.yml`):

1. **Computes the version** (`node scripts/release.js --ci`) from the commits since the last tag `vX.Y.Z`, using
   the tables above.
   - No `feat`, `fix`, `perf` or breaking change (e.g. only `docs`, `test`, `ci`, `chore`, `build`, `refactor`):
     no new version, nothing else happens.
   - Otherwise it sets the new version in the three files above and adds an entry at the top of `CHANGELOG.md`
     (sections *Breaking*, *Added*, *Fixed*) and `CHANGELOG.pl.md` (*Niezgodne*, *Nowe*, *Poprawione*) from the
     commit titles.
2. **Commits** that to `main` as `github-actions[bot]` with the message `chore(release): X.Y.Z`. A push with
   `GITHUB_TOKEN` starts no other workflow, so the release commit doesn't trigger another release.
3. **Verifies** that commit: root `npm test` and the `server/` suite against a real Postgres.
4. **Tags** `vX.Y.Z` (annotated) on the release commit, only if verification passed.
5. **Creates the GitHub Release** `vX.Y.Z` with the changelog entry (`node scripts/release-notes.js X.Y.Z`). An
   existing release is left alone; a missing one (e.g. a run failed after tagging) is created by the next run on
   `main` or a manual *Run workflow*.

Several PRs merged in quick succession: runs queue (`concurrency: release`), so they never compute the same
version twice. If a new commit lands on `main` during a release, the release commit's push is rejected and the run
for the newer commit releases everything.

### Releasing by hand

Only when the computed result must be overridden: a mis-typed commit, a reworded changelog, or **1.0.0**.

1. On a fresh branch from `main`: `npm run release -- --dry-run`, then `npm run release -- minor` (or `major` /
   `patch` / `X.Y.Z`).
2. Review and reword both changelog entries.
3. Commit `chore(release): X.Y.Z` and open a PR with the same title.
4. After the merge the workflow sees a `package.json` version without a tag and releases it as is: it checks for the
   `## [X.Y.Z]` entry in `CHANGELOG.md` (nothing is tagged without it), then continues with steps 3–5.

The first version, **0.1.0**, was set this way: on its merge the workflow tags `v0.1.0` and creates its release.

Rules:

- **A released version is never changed.** Tags are not moved or deleted; a broken release is fixed by the next one.
- **Removing a feature**: first a MINOR that marks it deprecated with its replacement, removal only in a later MAJOR.

## Requirements on GitHub

- *Settings → Actions → General → Workflow permissions*: the workflow declares `contents: write` for the jobs that
  push; an organization policy that caps `GITHUB_TOKEN` at read-only blocks the release.
- A branch protection rule on `main` that forbids direct pushes also blocks the `chore(release)` commit; allow
  `github-actions[bot]` to bypass it, or the release stops at step 2 with a warning.

## Differences from ci_for_sdlc

- No Docker image: `server/` deploys from `main` on Render, the dashboard from `live` on GitHub Pages. The image
  smoke test is replaced by step 3 (tests on the release commit), and nothing is published to a registry.
- Scripts are CommonJS `.js` like the rest of `scripts/`, tested in `test/conventional.test.js` and
  `test/release.test.js`.
- Scopes may be uppercase (`SHP`), matching this repo's history.
- Two changelogs (English and Polish); a version entry goes above the older, date-only sections, and release notes
  end at the next level-2 heading of any kind.
- No API contract file to refresh.
