# ShipScope flags adapter

Reads feature flags from **files** (JSON, YAML, TypeScript/JavaScript, `.properties`, `.env`) or a **URL**, turns them
into one ingest message and posts it to ShipScope (`POST /api/flags/ingest`, format in `server/schemas/flags-ingest.v2.schema.json`). How to set up a
flag source and token, and examples per place flags live (repository files, an app endpoint, AWS AppConfig, …):
[ONBOARDING.md, "Sending feature flags"](../../ONBOARDING.md#sending-feature-flags).

Two entry points over one implementation (`lib.js`), no dependencies:

- GitHub Action: `uses: dbqm45/evdt-service-shipscope/adapters/flags@<release tag>` (`action.yml`, runs on Node 24).
- Command line: `node shipscope-flags.js` (Node 20+; file patterns and `{env}` need Node 22+).

## Options

| Action input | Command line | Meaning |
| --- | --- | --- |
| `environment` | `--env` | The ShipScope environment of these flags: `test`, `qa` or `prod`. Not with `{env}` in `files`. |
| `files` | `--file` (repeatable) | File mode: flags files or patterns, one per line (`config/flags/*.json`). `{env}` in a pattern stands for the environment's name, taken from each file's path (`domains/*/config/flags/{env}.ts`): one run then sends every environment it finds. Files of one environment are merged; a flag with two different values is an error. |
| `env-map` | `--env-map` (repeatable) | With `{env}`: which names are which ShipScope environment, e.g. `dev=test, qa=qa, prod=prod`. Default: `test`, `qa` and `prod` as themselves. Names not in the map (`local`) are skipped and logged. |
| `url` | `--url` | URL mode: fetch the flags from here. Give `files` or `url`, not both. |
| `url-headers` | `--header` (repeatable) | Request headers for `url`, `Name: value`. |
| `format` | `--format` | `json`, `yaml`, `properties`, `env` or `ts` (TypeScript/JavaScript). Default: by file name (`.json`, `.yaml`, `.yml`, `.properties`, `.env`, `.env.*`, `.ts`, `.js`, `.mts`, `.mjs`, …), `json` for a URL. |
| `path` | `--path` | Dot path to the object of flags inside the document, e.g. `data.flags`. In a `.ts` file it starts with the const's name; without it, the file's only exported object (or only object) is used. |
| `value-path` | `--value-path` | Dot path to the value inside each flag's object, e.g. `enabled`. In a list of flag objects the default is the first of `enabled`, `value`, `state`, `on`, `status`, `active` that every item has. |
| `key-field` | `--key-field` | In a list of flag objects, the field with each flag's key. Default: the first of `key`, `name`, `id`, `flag` that every item has. |
| `rollout-path` | `--rollout-path` | Dot path to a percentage beside each flag's value, e.g. `rollout`: an enabled flag with 25 there is sent as partial 25. |
| `prefix` | `--prefix` | Only keys starting with this, without it in the flag key, e.g. `feature.`. |
| `changed-by` | `--changed-by` | Shown on the dashboard as who changed the flags. Default: the source's name. |
| `complete: false` | `--changes-only` | Send only these flags and remove none. Default: the message is the full state for the environment, so flags it no longer lists are removed. |
| `dry-run: true` | `--dry-run` | Print the message, send nothing (no URL or token needed). |
| `shipscope-url` | `--shipscope-url` or `$SHIPSCOPE_URL` | The ShipScope server. |
| `token` | `--token` or `$SHIPSCOPE_FLAGS_TOKEN` | The flag source's ingest token; pass it from a secret. |

Action outputs: `flags` (flags in the message), `changed`, `removed` (0 on a dry run).

## Where the flags are in a file

`path` points at them; what is there decides how they are read:

| At `path` | Example | Read as |
| --- | --- | --- |
| an object of values | `{ newCheckout: true, search: 25 }` | each key a flag |
| an object of objects | `{ newCheckout: { enabled: true, rollout: 25 } }` | each key a flag, `value-path: enabled` (+ `rollout-path: rollout`) |
| a list of objects | `[{ name: newCheckout, enabled: true }]` | `key-field` and `value-path`, found when the fields have usual names |
| a list of names | `enabledFeatures: [newCheckout, darkMode]` | each listed flag on (others are not known, so not sent) |

## YAML files

Read without dependencies (`yaml.js`): mappings, lists (also `- name: x` items), flow collections (`{ a: 1 }`,
`[a, b]`), quoted and block (`|`, `>`) values, comments, anchors, aliases and merge keys (`<<: *base`), several
documents (the first with content is read). Values follow YAML 1.2: `on`/`yes` stay strings, which the adapter still
reads as on. Complex keys (`? `) and plain values over several lines stop with the line number.

```yaml
# config/flags/prod.yaml
features:
  - name: newCheckout
    enabled: true
  - name: search
    enabled: true
    rollout: 25
```

`files: config/flags/{env}.yaml`, `path: features`, `rollout-path: rollout`.

## TypeScript and JavaScript files

The adapter reads them without running them, so it needs neither the project's TypeScript setup nor its
dependencies, and executes nothing from the repository. It takes each top-level `const NAME = { ... }` (exported or
not, with a type annotation, `as const` or `satisfies`) and `export default { ... }`. Values must be written out:
`true`, `false`, numbers, strings, nested objects and arrays, and `...NAME` of an object defined earlier in the same
file. Comments and trailing commas are fine.

```ts
// domains/charger/config/flags/prod.ts
import { FeatureFlags } from '@shared/flags';

export const flags: FeatureFlags = {
  newCheckout: true,
  'charger-map': false, // map view
  rolloutSearch: 25,
} as const;
```

A flag whose value is computed (`process.env.X === '1'`, a function call, an import) stops the run with the flag, the
file and the expression. So does `...base` when `base` is imported from another file. Such projects, and any layout
the options cannot describe (XML, TOML, a format of your own), print their flags as JSON in a step of their own and
hand that file to the adapter (see ONBOARDING.md).

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
the failing field or 401 for the token. Nothing is sent unless the whole message could be built. A message ShipScope refuses is also shown under the source in
Settings → Feature flags, with the reason.

Tests: `test/flags-adapter.test.js` (root `npm test`), and `server/test/flags.test.js` posts the adapter's message
through the real route.
