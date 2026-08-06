// scripts/sync-unleash.js  (FUTURE — not needed until/unless you adopt Unleash)
//
// Proves the point: this writes flag-states.json in EXACTLY the same shape
// as the current manual/BE-webhook mechanism. Nothing downstream (dashboard,
// check-flags-metadata.js) needs to change if you swap to this.
//
// Requires an Unleash backend/admin API token with read access to the project.

const fs = require('fs');

const { UNLEASH_URL, UNLEASH_API_TOKEN, UNLEASH_PROJECT } = process.env;
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'docs/data/flag-states.json';

async function main() {
    const res = await fetch(`${UNLEASH_URL}/api/admin/projects/${UNLEASH_PROJECT}`, {
        headers: { Authorization: UNLEASH_API_TOKEN },
    });
    if (!res.ok) throw new Error(`Unleash API error: ${res.status} ${await res.text()}`);
    const data = await res.json();

    // Preserve existing changedBy where Unleash doesn't give us attribution;
    // Unleash's project overview gives environments per feature with an `enabled` flag.
    const existing = fs.existsSync(OUTPUT_PATH) ? JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')) : {};
    const states = {};

    for (const feature of data.features || []) {
        states[feature.name] = {};
        for (const env of feature.environments || []) {
            const prev = existing[feature.name]?.[env.name];
            const changed = !prev || prev.enabled !== env.enabled;
            states[feature.name][env.name] = {
                enabled: env.enabled,
                // Unleash's project overview doesn't include a last-changed timestamp;
                // only bump changedAt when the value actually flipped since our last sync.
                changedAt: changed ? new Date().toISOString() : (prev?.changedAt || new Date().toISOString()),
                changedBy: changed ? 'unleash-sync' : (prev?.changedBy || 'unleash-sync'),
            };
        }
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(states, null, 2) + '\n');
    console.log(`Synced ${Object.keys(states).length} flags from Unleash project "${UNLEASH_PROJECT}"`);
}

main().catch(e => { console.error(e); process.exit(1); });