// Technical view: the Feature flags panel (blast radius, stale warning). Split out of app-technical.js
// (design-docs/REPORT_ARCH.md, Problem 5 / priority H) -- uses flagDivergesInEnv, which stays in
// app-technical.js itself.

/**
 * A flag whose jiraKeys span issues at different readiness levels is a "blast radius" hazard:
 * flipping it on releases every linked issue at once, including ones that aren't done yet.
 * Returns the not-done keys to call out, or null if there's nothing mixed to warn about.
 *
 * Reads `state.issueStatusIndex` (every PI's `statusCategory`, built server-side by
 * buildJiraIndex()) rather than `state.jiraIssues` (only the one PI currently loaded) — a flag's
 * jiraKeys can easily span more than one PI, and the Technical view's Flags panel this feeds has no PI
 * selector of its own for a user to pick the "right" one.
 */
function flagBlastRadius(f){
    const keys = f.jiraKeys || [];

    if (keys.length < 2) {
        return null;
    }

    const statusOf = k => state.issueStatusIndex[k] && state.issueStatusIndex[k].statusCategory;
    const doneCount = keys.filter(k => statusOf(k) === 'done').length;
    const notDoneKeys = keys.filter(k => statusOf(k) && statusOf(k) !== 'done');

    if (!doneCount || !notDoneKeys.length) {
        return null;
    }

    return notDoneKeys;
}

const STALE_FLAG_DAYS = 60;

/**
 * A flag that's been ON somewhere for a long time with every linked issue already Done is a
 * cleanup candidate — the flag-gated code path can probably be removed outright.
 *
 * Reads `state.issueStatusIndex` (every PI), same reasoning as `flagBlastRadius` above.
 */
function flagStaleWarning(f, key){
    const keys = f.jiraKeys || [];

    if (!keys.length) {
        return null;
    }

    const linked = keys.map(k => state.issueStatusIndex[k]).filter(Boolean);

    if (linked.length !== keys.length || !linked.every(i => i.statusCategory === 'done')) {
        return null;
    }

    let maxDays = 0;
    let staleEnv = null;

    ENVIRONMENTS.forEach(env=> {
        const envEntry = state.flagStates[key] ? state.flagStates[key][env] : null;
        const fs = effectiveFlagState(envEntry);

        if (!fs || !fs.enabled) {
            return;
        }

        const days = Math.floor((Date.now() - new Date(fs.changedAt).getTime()) / 86400000);

        if (days > maxDays) {
            maxDays = days;
            staleEnv = env;
        }
    });

    if (!staleEnv || maxDays < STALE_FLAG_DAYS) {
        return null;
    }

    return { env: staleEnv, days: maxDays };
}

/** Flags whose Details drawer is expanded in the Feature flags panel — survives re-renders (e.g. changing
 *  the type filter) so a filter change doesn't collapse what the user just opened. */
const openFlagDetails = new Set();

function renderFlags(){
    const box = document.getElementById('flags');
    const sourceFilter = document.getElementById('filterFlagSource').value;
    const entries = Object.entries(state.flagsMeta)
        .filter(([, f]) => !sourceFilter || f.source === sourceFilter)
        .sort((a,b) => a[0].localeCompare(b[0]));

    const divergeCount = entries.filter(([key]) => ENVIRONMENTS.some(env => flagDivergesInEnv(key, env))).length;

    document.getElementById('flagsDivergeNote').textContent = divergeCount ? `${divergeCount} diverge${divergeCount===1?'s':''}` : '';

    if (!entries.length) {
        box.innerHTML = EmptyState({ message: sourceFilter ? 'No flags match this filter' : 'No flags defined' });
        return;
    }

    box.innerHTML = html`
    ${FlagsColumnHeader({ labels: ENVIRONMENTS.map(env => env.toUpperCase()) })}
    ${entries.map(([key, f])=> {
        const blastRadius = flagBlastRadius(f);
        const staleInfo = flagStaleWarning(f, key);
        const open = openFlagDetails.has(key);

        const notes = html`
        ${staleInfo ? DriftNote({ text: '◷ Possibly stale' }) : ''}
        ${ENVIRONMENTS.map(env=> {
            if (!flagDivergesInEnv(key, env)) {
                return '';
            }

            const envEntry = state.flagStates[key][env];

            return DriftNote({
                text: `≠ ${env.toUpperCase()} diverges from build default`,
                title: `build=${envEntry.build.enabled ? 'ON' : 'OFF'} — would resurface if the runtime-be override is ever cleared`,
            });
        })}
        ${blastRadius ? BlastRadiusWarning({ keys: blastRadius }) : ''}`;

        const states = ENVIRONMENTS.map(env=> {
            const envEntry = state.flagStates[key] ? state.flagStates[key][env] : null;
            const fs = effectiveFlagState(envEntry);

            if (!fs) {
                return FlagStateText({ kind: 'missing', cls: 'ff-state' });
            }

            return FlagStateText({
                kind: fs.enabled ? 'on' : 'off',
                cls: 'ff-state',
                title: `[${fs.source}] changed ${relTime(fs.changedAt)} by ${fs.changedBy}`,
            });
        });

        return FlagRow({
            name: key,
            typeLabel: f.source === 'build' ? 'Build-time (FE)' : 'Runtime (BE)',
            open,
            notes,
            states,
            details: FlagDetails({
                description: f.description,
                issues: (f.jiraKeys || []).map(k => ({ key: k, href: jiraIssueUrl(k) })),
                components: f.components || [],
                added: f.createdAt ? fmtDateShort(f.createdAt) : '',
            }),
        });
    })}`;

    box.onclick = e => {
        const btn = e.target.closest('.deploy-group-toggle');
        const row = btn && btn.closest('.ff-row');

        if (!row) {
            return;
        }

        const key = row.dataset.flag;
        const nowOpen = !openFlagDetails.has(key);

        nowOpen ? openFlagDetails.add(key) : openFlagDetails.delete(key);
        btn.classList.toggle('open', nowOpen);
        btn.setAttribute('aria-expanded', String(nowOpen));
        btn.setAttribute('aria-label', `${nowOpen ? 'Hide' : 'Show'} details for ${key}`);
        row.querySelector('.ff-details').hidden = !nowOpen;
    };
}

