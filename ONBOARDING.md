# Onboarding

*Polska wersja: [ONBOARDING.pl.md](ONBOARDING.pl.md)*

What to do, in order, to get data into a ShipScope workspace. How things work underneath is in `CLAUDE.md`; how each
value is computed is in `FAQ.md`.

**Required first:** each app's deploy pipeline must create a real **GitHub Deployment** with statuses for every
environment it deploys to (`test`/`qa`/`prod`). ShipScope reads deployment history only through the GitHub
Deployments API. In GitHub Actions a job with `environment: test` (or `qa`, `prod`) creates one each time it runs.
Environment names are matched loosely (`production` → `prod`, `dev` → `test`, `preprod` is not `prod`); anything
else (`staging`, `uat`) is skipped.

## Setting up a workspace

Sign in with GitHub and create a workspace at `/start`. Its Settings page (`/t/<workspace>/settings`) opens with a
**Getting started** checklist that shows where you are; admins can hide it. The steps:

1. **Install the GitHub App** on the GitHub organization or account you deploy from (Settings → GitHub → Install).
   GitHub brings you back; the installation is linked only if your own GitHub account can see it.
2. **Choose repositories to track** — Track next to each repository whose deployments you want to see. Optional
   per repository: a version file (for QA/PROD deploys whose commits only hold a line like `version=v1.6.0`) and
   paths not counted as drift (e.g. `.github/`, `README.md`).
3. **First deployments arrive** — within 15 minutes (the default sync interval), or within about 30 seconds when
   the server has GitHub webhooks configured. A sync error shows under GitHub.
4. **Connect Jira** (optional, read-only) — sign in with Atlassian and pick the Jira site.
5. **Choose Jira boards** — tick each team's board and save. The board's rhythm (PI, sprints, releases or monthly
   flow) is detected; it can be changed per board, together with a PI-name template. Sync now, or wait for the next
   sync.
6. **Send feature flags** (optional) — ShipScope does not read flags itself. Add a source per place your flags live
   (a build step, a flag service; kind build or runtime, priority, optional component), create a token for it, and
   have it send the full state of its flags to `POST /api/flags/ingest`. Under Jira → Feature flags in Jira you can
   also name the field or label prefix that links Jira issues to flags.
7. **Invite your team** — one invitation link per person. Members see everything; admins can change settings.

Under Workspace an admin also sets how many days of deployment history to keep (7–730) and can delete the
workspace.
