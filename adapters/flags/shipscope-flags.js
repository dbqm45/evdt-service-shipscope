#!/usr/bin/env node
/**
 * ShipScope flags adapter, command line (Node 20+; file patterns need 22+). Reads feature flags from files or a
 * URL and sends their full state for one environment to ShipScope. Reference: adapters/flags/README.md.
 *
 *   SHIPSCOPE_URL=... SHIPSCOPE_FLAGS_TOKEN=... node shipscope-flags.js --env prod --file config/flags.prod.json
 *   node shipscope-flags.js --env prod --url https://app.example.com/internal/flags --dry-run
 */
const { parseArgs } = require('util');
const { AdapterError, parseHeaders, run } = require('./lib');

const USAGE = `Usage: shipscope-flags --env <test|qa|prod> (--file <path or pattern>... | --url <url>) [options]

  --file <p>         a flags file or pattern (repeatable): .json, .properties, .env
  --url <url>        fetch the flags from this URL instead (JSON unless --format)
  --header <h>       request header for --url, "Name: value" (repeatable)
  --format <f>       json, properties or env (default: by file name; json for --url)
  --path <a.b>       the object of flags inside the document
  --value-path <a>   the value inside each flag's object (e.g. enabled)
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
                header: { type: 'string', multiple: true }, format: { type: 'string' }, path: { type: 'string' },
                'value-path': { type: 'string' }, prefix: { type: 'string' }, 'changed-by': { type: 'string' },
                'changes-only': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
                'shipscope-url': { type: 'string' }, token: { type: 'string' }, help: { type: 'boolean', short: 'h' },
            },
        }));
    } catch (err) {
        throw new AdapterError(err.message);
    }
    if (values.help) return null;
    if (!values.env) throw new AdapterError('--env is required');
    return {
        env: values.env, files: values.file || [], url: values.url, headers: parseHeaders(values.header || []),
        format: values.format, path: values.path, valuePath: values['value-path'], prefix: values.prefix,
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
