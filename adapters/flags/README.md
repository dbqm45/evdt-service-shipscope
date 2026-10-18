# ShipScope flags adapter

Reads feature flags from **files** or a **URL**, turns them into one ingest message for one environment and posts
it to ShipScope (`POST /api/flags/ingest`, format in `server/schemas/flags-ingest.v2.schema.json`). How to set up a
flag source and token, and examples per place flags live (repository files, an app endpoint, AWS AppConfig, …):
[ONBOARDING.md, "Sending feature flags"](../../ONBOARDING.md#sending-feature-flags).

Two entry points over one implementation (`lib.js`), no dependencies:

- GitHub Action: `uses: dbqm45/evdt-service-shipscope/adapters/flags@<release tag>` (`action.yml`, runs on Node 24).
- Command line: `node shipscope-flags.js` (Node 20+; file patterns need Node 22+).

## Options

| Action input | Command line | Meaning |
| --- | --- | --- |
| `environment` | `--env` | Required. The ShipScope environment: `test`, `qa` or `prod`. |
| `files` | `--file` (repeatable) | File mode: flags files or patterns, one per line (`config/flags/*.json`). Merged into one message; a flag with two different values is an error. |
| `url` | `--url` | URL mode: fetch the flags from here. Give `files` or `url`, not both. |
| `url-headers` | `--header` (repeatable) | Request headers for `url`, `Name: value`. |
| `format` | `--format` | `json`, `properties` or `env`. Default: by file name (`.json`, `.properties`, `.env`, `.env.*`), `json` for a URL. |
| `path` | `--path` | Dot path to the object of flags inside the document, e.g. `data.flags`. |
| `value-path` | `--value-path` | Dot path to the value inside each flag's object, e.g. `enabled`. |
| `prefix` | `--prefix` | Only keys starting with this, without it in the flag key, e.g. `feature.`. |
| `changed-by` | `--changed-by` | Shown on the dashboard as who changed the flags. Default: the source's name. |
| `complete: false` | `--changes-only` | Send only these flags and remove none. Default: the message is the full state for the environment, so flags it no longer lists are removed. |
| `dry-run: true` | `--dry-run` | Print the message, send nothing (no URL or token needed). |
| `shipscope-url` | `--shipscope-url` or `$SHIPSCOPE_URL` | The ShipScope server. |
| `token` | `--token` or `$SHIPSCOPE_FLAGS_TOKEN` | The flag source's ingest token; pass it from a secret. |

Action outputs: `flags` (flags in the message), `changed`, `removed` (0 on a dry run).

## Values

| In the file or answer | Sent as |
| --- | --- |
| `true`, `"true"`, `"on"`, `"enabled"`, `"yes"`, `100` | `on` |
| `false`, `"false"`, `"off"`, `"disabled"`, `"no"`, `0` | `off` |
| a number between 0 and 100, or its string | `partial` with that `rollout` |
| `"partial"` | `partial` without a percentage |

Anything else — another word, a number outside 0–100 such as a port caught by a loose `prefix` — stops with the
flag's name and the file. Flag keys must match ShipScope's rule (letters, digits and
`_ . : -`, starting with a letter or `_`, case-sensitive).

## Errors

Every problem stops the run with one line naming the reason (exit code 1; in the Action an error annotation): a file
or pattern that matches nothing, a value that cannot be read, an answer that is not 2xx, and ShipScope's own 400 with
the failing field or 401 for the token. Nothing is sent unless the whole message could be built.

Tests: `test/flags-adapter.test.js` (root `npm test`), and `server/test/flags.test.js` posts the adapter's message
through the real route.
