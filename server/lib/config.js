/**
 * Reads and validates the Web Service's auth configuration from the environment. Fails fast at
 * startup instead of on the first sign-in attempt.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ githubClientId: string, githubClientSecret: string, publicBaseUrl: string, secureCookies: boolean }}
 * @throws {Error} naming every missing/invalid variable
 */
function loadAuthConfig(env) {
    const problems = [];
    for (const key of ['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'PUBLIC_BASE_URL']) {
        if (!env[key]) problems.push(`${key} is not set`);
    }

    let publicBaseUrl = env.PUBLIC_BASE_URL;
    if (publicBaseUrl) {
        try {
            const url = new URL(publicBaseUrl);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
            publicBaseUrl = url.origin;
        } catch {
            problems.push('PUBLIC_BASE_URL must be an absolute http(s) URL, e.g. http://localhost:3000');
        }
    }

    if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join('; ')}`);

    return {
        githubClientId: env.GITHUB_APP_CLIENT_ID,
        githubClientSecret: env.GITHUB_APP_CLIENT_SECRET,
        publicBaseUrl,
        // Secure cookies don't get sent over plain http, which would break local sign-in on localhost.
        secureCookies: publicBaseUrl.startsWith('https:'),
    };
}

module.exports = { loadAuthConfig };
