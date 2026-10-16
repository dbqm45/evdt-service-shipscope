const crypto = require('crypto');

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

/**
 * Reads the GitHub App's server-to-server credentials (FR-004: installing the App on repos). Optional as a
 * whole -- without them sign-in still works and only the repo-connection routes are off -- but a partial set
 * is a mistake and fails fast. GITHUB_APP_PRIVATE_KEY is the PEM GitHub generates; escaped newlines ("\\n",
 * as some secret stores require) are accepted.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ appId: string, slug: string, privateKey: import('crypto').KeyObject }|null}
 * @throws {Error} naming every missing/invalid variable
 */
function loadGitHubAppConfig(env) {
    const keys = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY'];
    const present = keys.filter((key) => env[key]);
    if (present.length === 0) return null;

    const problems = keys.filter((key) => !env[key]).map((key) => `${key} is not set (the other GitHub App variables are)`);
    if (env.GITHUB_APP_ID && !/^\d+$/.test(env.GITHUB_APP_ID)) problems.push('GITHUB_APP_ID must be the numeric App ID');
    if (env.GITHUB_APP_SLUG && !/^[a-z0-9][a-z0-9-]*$/.test(env.GITHUB_APP_SLUG)) {
        problems.push('GITHUB_APP_SLUG must be the App\'s URL name, e.g. shipscope-dev');
    }
    let privateKey = null;
    if (env.GITHUB_APP_PRIVATE_KEY) {
        try {
            privateKey = crypto.createPrivateKey(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'));
            if (privateKey.asymmetricKeyType !== 'rsa') throw new Error();
        } catch {
            problems.push('GITHUB_APP_PRIVATE_KEY is not a valid RSA private key in PEM format');
        }
    }
    if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join('; ')}`);

    return { appId: env.GITHUB_APP_ID, slug: env.GITHUB_APP_SLUG, privateKey };
}

module.exports = { loadAuthConfig, loadGitHubAppConfig };
