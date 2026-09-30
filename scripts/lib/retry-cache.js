const fs = require('fs');
const os = require('os');
const path = require('path');

function cachePathFor(key) {
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');

    return path.join(process.env.RUNNER_TEMP || os.tmpdir(), `shipscope-sync-cache-${safeKey}.json`);
}

/**
 * Caches the result of an expensive, rate-limited fetch across retries of the *same* job (e.g.
 * .github/actions/sync-with-retry re-running a sync script after a losing git push). Safe here
 * specifically because the retry loop's job is to redo the *cheap* merge-with-fresh-`live` step, not to
 * redo external API work whose result doesn't depend on `live`'s current git state at all.
 * `RUNNER_TEMP` is unique per job and cleaned up automatically by GitHub Actions, so there's nothing to
 * invalidate or clean up here.
 */
async function loadOrCompute(key, computeFn) {
    const cachePath = cachePathFor(key);

    if (fs.existsSync(cachePath)) {
        console.log(`Reusing cached result from an earlier attempt in this run (${cachePath}) instead of re-fetching.`);
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }

    const result = await computeFn();

    fs.writeFileSync(cachePath, JSON.stringify(result));

    return result;
}

module.exports = { loadOrCompute };
