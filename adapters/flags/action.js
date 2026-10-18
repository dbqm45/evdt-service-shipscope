/**
 * ShipScope flags adapter, GitHub Action entry (action.yml). Inputs arrive as INPUT_<NAME> variables; the work is
 * lib.js's run(), the same as the command line.
 */
const fs = require('fs');
const { AdapterError, parseHeaders, run } = require('./lib');

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('./lib').AdapterOptions}
 */
function optionsFromInputs(env) {
    const input = (name) => (env[`INPUT_${name.toUpperCase()}`] || '').trim();
    const lines = (name) => input(name).split('\n').map((l) => l.trim()).filter(Boolean);
    const flag = (name, fallback) => {
        const v = input(name).toLowerCase();
        if (!v) return fallback;
        if (v !== 'true' && v !== 'false') throw new AdapterError(`input ${name} must be true or false`);
        return v === 'true';
    };
    return {
        env: input('environment'), files: lines('files'), url: input('url') || undefined, headers: parseHeaders(lines('url-headers')),
        format: input('format') || undefined, path: input('path') || undefined, valuePath: input('value-path') || undefined,
        prefix: input('prefix') || undefined, changedBy: input('changed-by') || undefined, complete: flag('complete', true),
        dryRun: flag('dry-run', false), shipscopeUrl: input('shipscope-url'), token: input('token'),
    };
}

/** Appends `name=value` lines to the step's outputs file. */
function setOutputs(env, outputs) {
    if (!env.GITHUB_OUTPUT) return;
    fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

if (require.main === module) {
    (async () => {
        try {
            const { payload, result } = await run(optionsFromInputs(process.env), { cwd: process.env.GITHUB_WORKSPACE || process.cwd() });
            setOutputs(process.env, {
                flags: payload.observations.length, changed: result ? result.changed : 0, removed: result ? result.removed : 0,
            });
        } catch (err) {
            console.log(`::error title=ShipScope flags::${String(err.message).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
            process.exitCode = 1;
        }
    })();
}

module.exports = { optionsFromInputs, setOutputs };
