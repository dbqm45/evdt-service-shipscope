const ENVIRONMENTS = ['test', 'qa', 'prod'];

/**
 * Applies one component's flag observations for a single source to the in-memory flag-states / flags-meta
 * objects (mutated in place; the caller owns reading and writing the files).
 *
 * `valuesByKey` is `{ [key]: { [env]: boolean } }` — grouped by key first (not env-then-key, as a raw
 * per-env fetch is) so the collision guard can check "any env" for a key in one place.
 *
 * Collision guard: a value of a given source is scoped to whichever one component this run belongs to —
 * two unrelated components can just as easily expose a boolean under the same literal name by accident
 * (see CLAUDE.md's F3 writeup). Checked before touching flagsMeta[key].components: a rejected collision
 * must not get the colliding component listed as if it legitimately contributed to this flag. `::error::`
 * only annotates — doesn't throw — so the caller's commit/push loop still commits every other,
 * non-colliding flag from the same run.
 *
 * `correctMetaSource` (default false): also rewrite an existing flagsMeta entry's `source` to this one.
 *
 * Returns what changed so the caller can decide what to persist: `metaChanged`, `scaffolded` keys,
 * `historyEntries` (one per actual flip), `collisions`, `changedCount`.
 */
function applyObservations({ flagStates, flagsMeta, valuesByKey, component, source, changedBy, now, correctMetaSource = false }) {
    const result = { changedCount: 0, metaChanged: false, scaffolded: [], historyEntries: [], collisions: [] };

    for (const [key, envValues] of Object.entries(valuesByKey)) {
        if (!flagStates[key]) {
            flagStates[key] = {};
        }

        const existingOwner = ENVIRONMENTS
            .map(e => flagStates[key][e] && flagStates[key][e][source] && flagStates[key][e][source].component)
            .find(Boolean);

        if (existingOwner && existingOwner !== component) {
            result.collisions.push({ key, existingOwner, attemptedBy: component });
            console.error(
                `::error::Flag key "${key}" is already owned by component "${existingOwner}" (source: ${source}), ` +
                `but component "${component}" also resolved a value for it — these are very likely two unrelated ` +
                `flags sharing a name by accident. Skipping this component's write for "${key}"; rename one of ` +
                'them to resolve the collision.'
            );
            continue;
        }

        if (!flagsMeta[key]) {
            flagsMeta[key] = {
                description: 'TODO — describe this flag',
                source,
                jiraKeys: [],
                components: [component],
                createdAt: now,
            };
            result.scaffolded.push(key);
            result.metaChanged = true;
        } else {
            // Opt-in: sync-runtime-be-flags.js self-corrects a wrong `source`; resolve-all-flag-states.js
            // deliberately never does (a non-`build` entry it stumbles on is worth a human looking at).
            if (correctMetaSource && flagsMeta[key].source !== source) {
                flagsMeta[key].source = source;
                result.scaffolded.push(key);
                result.metaChanged = true;
            }
            if (!(flagsMeta[key].components || []).includes(component)) {
                flagsMeta[key].components = [...(flagsMeta[key].components || []), component];
                result.metaChanged = true;
            }
        }

        for (const env of ENVIRONMENTS) {
            if (!(env in envValues)) continue;

            const newValue = envValues[env];

            if (!flagStates[key][env]) {
                flagStates[key][env] = {};
            }

            const existing = flagStates[key][env][source];

            if (!existing || existing.enabled !== newValue) {
                flagStates[key][env][source] = { enabled: newValue, changedAt: now, changedBy, component };
                result.historyEntries.push({ key, env, source, enabled: newValue, changedAt: now, changedBy });
                result.changedCount++;
            } else if (existing.component !== component) {
                existing.component = component;
            }
        }
    }

    if (result.collisions.length) {
        console.error(
            `::error::${result.collisions.length} flag key collision(s) detected and skipped — see above. These need a ` +
            'human to rename one of the colliding flags; they will keep getting skipped (and keep failing loudly) ' +
            'on every future run until resolved.'
        );
    }

    return result;
}

module.exports = { applyObservations };
