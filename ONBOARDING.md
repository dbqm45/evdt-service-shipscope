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
   have it send the full state of its flags to `POST /api/flags/ingest` — see [Sending feature flags](#sending-feature-flags).
   Under Jira → Feature flags in Jira you can also name the field or label prefix that links Jira issues to flags.
7. **Invite your team** — one invitation link per person. Members see everything; admins can change settings.

Under Workspace an admin also sets how many days of deployment history to keep (7–730) and can delete the
workspace.

## Sending feature flags

ShipScope never reads your flags: whatever holds them sends their state to ShipScope (`design-docs/ADR-001-flags-pushed-from-outside.md`). That
keeps it independent of where flags live — a file in the repository, an endpoint of the application, AWS AppConfig,
a flag service. Each such place is one **flag source**:

1. In Settings → Feature flags, add a source: a name, the kind — **build** (the value is baked into the build, e.g. a
   file in the repository) or **runtime** (switched live, e.g. AppConfig or a flag service) — a priority (when several
   sources of one kind report the same flag, the higher wins) and, optionally, the component (tracked repository)
   its flags belong to. The dashboard shows a flag's runtime value when there is one, otherwise its build value.
2. Create a token for the source. It is shown once: store it as a secret where the sender runs (e.g. a GitHub
   Actions secret `SHIPSCOPE_FLAGS_TOKEN`). A second token lets you rotate without a gap.
3. Have the sender post the **full state** of the source's flags after every change, or on a schedule. Sending the
   same state again changes nothing, so a schedule is safe.

### The message

`POST /api/flags/ingest`, `Authorization: Bearer <token>`, `Content-Type: application/json`:

```json
{
  "schemaVersion": 2,
  "environments": ["test", "prod"],
  "changedBy": "ci",
  "observations": [
    { "key": "newCheckout", "env": "test", "state": "on" },
    { "key": "newCheckout", "env": "prod", "state": "partial", "rollout": 25 },
    { "key": "darkMode", "env": "prod", "state": "off" }
  ],
  "flags": [
    { "key": "newCheckout", "description": "New checkout flow", "jiraKeys": ["ABC-123"] }
  ]
}
```

- `observations` — one entry per flag and environment: `key` (case-sensitive, letters, digits and `_ . : -`), `env`
  (`test`, `qa` or `prod`: map your own names, e.g. `staging` → `qa`, `production` → `prod`), `state` (`on`, `off` or
  `partial` — on for some users, with an optional `rollout` percentage) and an optional `changedAt` (ISO 8601) when
  you send late; it must be within the last 7 days, and an older value never replaces a newer one.
- **Full state:** a flag the source no longer lists in an environment the message covers is marked removed and
  disappears from the dashboard (it comes back when sent again). `environments` names the covered environments
  (default: those in `observations`); `"environments": ["prod"]` with no observations means "no flags left in prod".
  Other environments are left alone. To send only changes, add `"complete": false`; nothing is removed then.
- `flags` (optional) — a description and the Jira issues behind a flag, only for flags in the same message. They can
  also come from Jira itself or be set by hand in Settings; see FAQ, "Feature flags".
- `changedBy` (optional) — shown as who changed the flag; the source's name by default.
- At most 5000 observations per message.

The answer is `{ source, flags, changed, removed, stale, created }`; a wrong message gets 400 with the reason, an
unknown or revoked token 401. The exact format is a JSON Schema (draft-07), published by every ShipScope server at
`GET /api/flags/ingest/schema` (and kept in `server/schemas/flags-ingest.v2.schema.json`); validate against it
before sending if you build your own sender.

### Where your flags live

Every sender does the same three things: read the flags, turn them into one `{ key: value }` map per environment,
post it. The table lists the usual places; the [flags adapter](#the-flags-adapter) does the conversion and the post,
and the [`jq` recipes](#without-the-adapter-jq-recipes) do the same without it.

| Flags live in | Kind | How to send |
| --- | --- | --- |
| A file in the repository (`flags.json`, YAML, `.properties`, `.env`) | build | A step in the deploy pipeline, after each environment's deploy job: read the file for that environment, convert, post. |
| An endpoint of the application (e.g. `/internal/flags`) | runtime | A scheduled job (e.g. every 15 minutes) and/or a step after each deploy: fetch the URL per environment, convert, post. |
| AWS AppConfig (feature flags profile) | runtime | A scheduled job reading each AppConfig environment with `aws appconfigdata` (credentials through OIDC, not keys), or an AppConfig extension on `ON_DEPLOYMENT_COMPLETE` calling a small Lambda that posts. |
| Azure App Configuration | runtime | A scheduled job reading the feature flags per label (`az appconfig feature list`); a `conditional` flag is `partial`. |
| A flag service (LaunchDarkly, Unleash, Flagsmith, ConfigCat, GrowthBook, Flipt, …) | runtime | A scheduled job reading the service's API per environment, or the service's webhook calling a small function that reads and posts. |
| Kubernetes ConfigMap or environment variables | build or runtime | A step after each deploy: `kubectl get configmap <name> -o json`, take `.data`, convert, post. |

Use one source per place. When the same flag is both baked into the build and switched live, make two sources
(build and runtime): the dashboard shows the runtime value and keeps both histories.

### The flags adapter

`adapters/flags/` in this repository reads flags from **files** or a **URL**, builds the message for one environment
and posts it; `dry-run` only prints it. It is a GitHub Action and a command line (Node 20+, no dependencies) with the
same options, listed in [`adapters/flags/README.md`](adapters/flags/README.md). A flag value may be `true`/`false`,
`on`/`off`, `enabled`/`disabled`, or a number 0–100 for a percentage rollout.

**Files**, at the end of each environment's deploy job (one source of kind build):

```yaml
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@vX.Y.Z   # a ShipScope release tag
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          environment: prod
          files: config/flags.prod.json      # one per line; patterns like config/flags/*.json work
```

`.properties` and `.env` files work too; `prefix: feature.` keeps only `feature.*` keys. Several files are merged
into one message, and a flag with different values in two of them is an error.

**A URL**, on a schedule (one source of kind runtime):

```yaml
on:
  schedule: [{ cron: '*/15 * * * *' }]
jobs:
  flags:
    runs-on: ubuntu-latest
    steps:
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@vX.Y.Z
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          environment: prod
          url: https://app.example.com/internal/flags
          url-headers: |
            Authorization: Bearer ${{ secrets.APP_FLAGS_TOKEN }}
          path: data.flags        # where the flags are in the answer, when not at the top
```

**AWS AppConfig:** read the profile with the AWS CLI first (credentials through OIDC), then hand the file over;
`value-path: enabled` reads AppConfig's `{ "<flag>": { "enabled": true } }`:

```yaml
    permissions: { id-token: write, contents: read }
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: '${{ vars.SHIPSCOPE_FLAGS_ROLE }}', aws-region: eu-west-1 }
      - run: |
          TOKEN=$(aws appconfigdata start-configuration-session --application-identifier shop \
            --environment-identifier production --configuration-profile-identifier flags \
            --query InitialConfigurationToken --output text)
          aws appconfigdata get-latest-configuration --configuration-token "$TOKEN" flags.json > /dev/null
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@vX.Y.Z
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          environment: prod
          files: flags.json
          value-path: enabled
```

The same pattern covers a Kubernetes ConfigMap (`kubectl get configmap <name> -o json > cm.json`, then
`files: cm.json` and `path: data`) and a flag service's API (download with its CLI or `curl`, then `files:`).

**Command line**, anywhere else (GitLab, Jenkins, a cron job) — copy `adapters/flags/` or check out this repository:

```bash
export SHIPSCOPE_URL=https://shipscope.example.com SHIPSCOPE_FLAGS_TOKEN=shpi_...
node adapters/flags/shipscope-flags.js --env prod --file config/flags.prod.json
node adapters/flags/shipscope-flags.js --env prod --url https://app.example.com/internal/flags --dry-run
```

The Action is used straight from this repository, so other repositories need to be allowed to use it when this one is
private (Settings → Actions → General → Access).

### Without the adapter: `jq` recipes

The converter below takes a map for one environment and prints the message. A value may be `true`/`false`, `"on"`/
`"off"`, `"true"`/`"false"`, or a number 0–100 (or its string) for a percentage rollout; `jq` is preinstalled on
GitHub's runners.

```bash
# to-shipscope.jq — input: { "newCheckout": true, "darkMode": "off", "search": 25 }
def value: if type == "string" then ascii_downcase
    | if . == "true" or . == "on" then true elif . == "false" or . == "off" then false else tonumber end
  else . end;
def state: if . == true or (type == "number" and . >= 100) then { state: "on" }
  elif . == false or (type == "number" and . <= 0) then { state: "off" }
  else { state: "partial", rollout: . } end;
{ schemaVersion: 2, environments: [$env],
  observations: [ to_entries[] | { key, env: $env } + (.value | value | state) ] }
```

Post it with:

```bash
send_flags() {  # usage: <flag map on stdin> send_flags <env>
  jq --arg env "$1" -f to-shipscope.jq | curl -sS --fail-with-body -X POST "$SHIPSCOPE_URL/api/flags/ingest" \
    -H "Authorization: Bearer $SHIPSCOPE_FLAGS_TOKEN" -H "Content-Type: application/json" --data-binary @-
}
```

- **A JSON file per environment:** `send_flags prod < config/flags.prod.json`. In GitHub Actions, run it as the last
  step of the `prod` deploy job, with `SHIPSCOPE_URL` as a variable and `SHIPSCOPE_FLAGS_TOKEN` as a secret.
- **YAML:** `yq -o=json config/flags.yaml | jq .prod | send_flags prod`.
- **`.properties` or `.env`:** pick the flag lines with a prefix, e.g. `feature.newCheckout=true`:
  `jq -Rn '[inputs | capture("^feature\\.(?<k>[^=]+)=(?<v>.*)$") | { (.k): .v }] | add // {}' application-prod.properties | send_flags prod`.
- **An endpoint:** `curl -sSf https://app.example.com/internal/flags | send_flags prod`.
- **AWS AppConfig:** a feature flags profile returns `{ "<flag>": { "enabled": true, ... } }`:

  ```bash
  TOKEN=$(aws appconfigdata start-configuration-session --application-identifier shop \
    --environment-identifier production --configuration-profile-identifier flags \
    --query InitialConfigurationToken --output text)
  aws appconfigdata get-latest-configuration --configuration-token "$TOKEN" flags.json > /dev/null
  jq 'map_values(.enabled)' flags.json | send_flags prod
  ```

When something does not show up, the answer of the post says why (`400` with the field, `401` for the token).
Settings → Feature flags shows the same per source: when its last message was received and what it changed, or that
it was refused and why, and when each token was last used. A message with an unknown token belongs to no source and
only gets its 401.
