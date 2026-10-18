#!/usr/bin/env node
/**
 * ShipScope flags adapter, command line (Node 20+; file patterns need 22+). Reads feature flags from files or a
 * URL and sends their full state for one environment to ShipScope. Reference: adapters/flags/README.md.
 *
 *   SHIPSCOPE_URL=... SHIPSCOPE_FLAGS_TOKEN=... node shipscope-flags.js --env prod --file config/flags.prod.json
 *   node shipscope-flags.js --env prod --url https://app.example.com/internal/flags --dry-run
 */
const { parseArgs } = require('util');
const { AdapterError, parseEnvMap, parseHeaders, run } = require('./lib');

const USAGE = `Usage: shipscope-flags (--env <test|qa|prod> | {env} in --file) (--file <path or pattern>... | --url <url>) [options]

  --env <e>          the ShipScope environment of these flags
  --file <p>         a flags file or pattern (repeatable): .json, .properties, .env, .ts, .js;
                     {env} in it stands for the environment's name, e.g. domains/*/config/flags/{env}.ts
  --env-map <m>      with {env}: which names are which environment, e.g. dev=test,qa=qa,prod=prod
                     (default test, qa, prod as themselves; other names are skipped)
  --url <url>        fetch the flags from this URL instead (JSON unless --format)
  --header <h>       request header for --url, "Name: value" (repeatable)
  --format <f>       json, yaml, properties, env or ts (default: by file name; json for --url)
  --path <a.b>       the object of flags inside the document (in a .ts file: starting with its const name)
  --value-path <a>   the value inside each flag's object (e.g. enabled)
  --key-field <f>    in a list of flag objects, the field with each flag's key (default: key, name, id or flag)
  --rollout-path <a> a percentage beside each flag's value (e.g. rollout)
  --prefix <p>       only keys starting with this, without it in the flag key
  --changed-by <s>   shown as who changed the flags (default: the source's name)
  --changes-only     send only these flags, remove none (default: full state)
  --dry-run          print the message, send nothing
  --shipscope-url    default $SHIPSCOPE_URL
  --token            default $SHIPSCOPE_FLAGS_TOKEN (prefer the variable)`;

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('./lib').AdapterOptions | null} null for --help
 * @throws {AdapterError}
 */
function optionsFromArgs(argv, env) {
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                env: { type: 'string' }, file: { type: 'string', multiple: true }, url: { type: 'string' },
                'env-map': { type: 'string', multiple: true },
                header: { type: 'string', multiple: true }, format: { type: 'string' }, path: { type: 'string' },
                'value-path': { type: 'string' }, 'key-field': { type: 'string' }, 'rollout-path': { type: 'string' },
                prefix: { type: 'string' }, 'changed-by': { type: 'string' },
                'changes-only': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
                'shipscope-url': { type: 'string' }, token: { type: 'string' }, help: { type: 'boolean', short: 'h' },
            },
        }));
    } catch (err) {
        throw new AdapterError(err.message);
    }
    if (values.help) return null;
    return {
        env: values.env, files: values.file || [], envMap: parseEnvMap(values['env-map'] || []), url: values.url, headers: parseHeaders(values.header || []),
        format: values.format, path: values.path, valuePath: values['value-path'], keyField: values['key-field'],
        rolloutPath: values['rollout-path'], prefix: values.prefix,
        changedBy: values['changed-by'], complete: !values['changes-only'], dryRun: Boolean(values['dry-run']),
        shipscopeUrl: values['shipscope-url'] || env.SHIPSCOPE_URL, token: values.token || env.SHIPSCOPE_FLAGS_TOKEN,
    };
}

if (require.main === module) {
    (async () => {
        try {
            const options = optionsFromArgs(process.argv.slice(2), process.env);
            if (!options) return console.log(USAGE);
            await run(options);
        } catch (err) {
            if (!(err instanceof AdapterError)) throw err;
            console.error(`✗ ${err.message}`);
            process.exitCode = 1;
        }
    })();
}

module.exports = { optionsFromArgs };
