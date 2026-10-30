// Local mode (design-docs/LOCAL-PDI-PLAN.pl.md): the whole workflow on one machine (`npm run dev` next to pdi's
// receiver), where the connection with pdi may reach a receiver on loopback. Decided once at start from the
// environment and passed on explicitly; nothing else reads it from the environment.

/**
 * Whether this server runs in local mode: PUBLIC_BASE_URL is http on localhost or 127.0.0.1 (any port) and NODE_ENV
 * is not production, the same condition SHIPSCOPE_MOCK_DATA asks for (lib/mock-dashboard.js).
 *
 * @param {{ PUBLIC_BASE_URL?: string, NODE_ENV?: string }} env
 * @returns {boolean}
 */
function localModeEnabled(env) {
    if (env.NODE_ENV === 'production') return false;
    let url;
    try {
        url = new URL(env.PUBLIC_BASE_URL || '');
    } catch {
        return false;
    }
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
}

/** What web.js and worker.js log at start in local mode, as they do for SHIPSCOPE_MOCK_DATA. */
const LOCAL_MODE_WARNING = 'Local mode (PUBLIC_BASE_URL is http://localhost): the connection with pdi may reach a receiver on localhost, 127.0.0.1 or ::1 over http or https, any port';

module.exports = { localModeEnabled, LOCAL_MODE_WARNING };
