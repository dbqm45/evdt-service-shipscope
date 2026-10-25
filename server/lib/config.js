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
    // The App's webhook secret (GitHub App settings -> Webhook). Optional: without it /webhooks/github is off and
    // deployments only arrive with the periodic sync.
    if (env.GITHUB_APP_WEBHOOK_SECRET && env.GITHUB_APP_WEBHOOK_SECRET.length < 20) problems.push('GITHUB_APP_WEBHOOK_SECRET must be at least 20 characters');
    if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join('; ')}`);

    return { appId: env.GITHUB_APP_ID, slug: env.GITHUB_APP_SLUG, privateKey, webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET || null };
}

const BAD_KEY = 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)';

function parseEncryptionKey(value) {
    const key = /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, 'base64') : null;
    return key && key.length === 32 ? key : null;
}

/**
 * The key that seals stored customer secrets (Jira refresh tokens, endpoint tokens, signing secrets):
 * TOKEN_ENCRYPTION_KEY, optional (without it Jira and endpoint sources are off). While a key is being rotated
 * (server/README.md, "Rotating TOKEN_ENCRYPTION_KEY"), TOKEN_ENCRYPTION_KEY_PREVIOUS lists the old ones, comma
 * separated, newest first: values sealed with them stay readable until the worker re-seals them (lib/secret-rotation.js).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Buffer|{ current: Buffer, previous: Buffer[] }|null} the key alone when there are no previous ones
 * @throws {Error} a key set but not 32 base64-encoded bytes, or previous keys without a current one
 */
function loadEncryptionKey(env) {
    const previous = (env.TOKEN_ENCRYPTION_KEY_PREVIOUS || '').split(',').map((k) => k.trim()).filter(Boolean);
    if (!env.TOKEN_ENCRYPTION_KEY) {
        if (previous.length) throw new Error('Invalid configuration: TOKEN_ENCRYPTION_KEY_PREVIOUS is set but TOKEN_ENCRYPTION_KEY is not');
        return null;
    }
    const key = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
    if (!key) throw new Error(`Invalid configuration: ${BAD_KEY}`);
    const old = previous.map(parseEncryptionKey);
    if (old.some((k) => !k)) throw new Error('Invalid configuration: every TOKEN_ENCRYPTION_KEY_PREVIOUS key must be 32 bytes, base64-encoded');
    return old.length ? { current: key, previous: old } : key;
}

/**
 * The key pair that seals customers' endpoint tokens so only the worker can read them (lib/sealed-box.js):
 * SECRETS_PUBLIC_KEY on both services, SECRETS_PRIVATE_KEY (and, during a rotation, SECRETS_PRIVATE_KEY_PREVIOUS, comma
 * separated, newest first) on the worker only. Optional: without a public key tokens are sealed with
 * TOKEN_ENCRYPTION_KEY as before. Keys are base64 DER (SPKI / PKCS#8), as `npm run sealing-keys` prints them.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ withPrivate: boolean }} options the worker reads the private keys; the web service never does
 * @returns {{ publicKey: import('crypto').KeyObject, privateKeys: import('crypto').KeyObject[] }|null}
 * @throws {Error} a malformed key, a private key without its public key, or a current private key that does not match
 */
function loadSealingKeys(env, { withPrivate }) {
    const crypto = require('crypto');
    if (!env.SECRETS_PUBLIC_KEY) {
        if (withPrivate && env.SECRETS_PRIVATE_KEY) throw new Error('Invalid configuration: SECRETS_PRIVATE_KEY is set but SECRETS_PUBLIC_KEY is not');
        return null;
    }
    const parse = (name, value, type) => {
        try {
            const key = type === 'spki'
                ? crypto.createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type })
                : crypto.createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type });
            if (key.asymmetricKeyType !== 'x25519') throw new Error('not x25519');
            return key;
        } catch {
            throw new Error(`Invalid configuration: ${name} must be an X25519 key, base64 DER (npm run sealing-keys)`);
        }
    };
    const publicKey = parse('SECRETS_PUBLIC_KEY', env.SECRETS_PUBLIC_KEY.trim(), 'spki');
    if (!withPrivate) return { publicKey, privateKeys: [] };
    if (!env.SECRETS_PRIVATE_KEY) throw new Error('Invalid configuration: the worker needs SECRETS_PRIVATE_KEY with SECRETS_PUBLIC_KEY');
    const current = parse('SECRETS_PRIVATE_KEY', env.SECRETS_PRIVATE_KEY.trim(), 'pkcs8');
    const spki = (k) => crypto.createPublicKey(k).export({ format: 'der', type: 'spki' });
    if (!spki(current).equals(publicKey.export({ format: 'der', type: 'spki' }))) {
        throw new Error('Invalid configuration: SECRETS_PRIVATE_KEY does not belong to SECRETS_PUBLIC_KEY');
    }
    const previous = (env.SECRETS_PRIVATE_KEY_PREVIOUS || '').split(',').map((k) => k.trim()).filter(Boolean)
        .map((k) => parse('SECRETS_PRIVATE_KEY_PREVIOUS', k, 'pkcs8'));
    return { publicKey, privateKeys: [current, ...previous] };
}

/**
 * Reads the Atlassian OAuth 2.0 (3LO) app's credentials and the key that encrypts stored Jira tokens (FR-007).
 * Optional as a whole -- without them the Jira routes are off -- but a partial set fails fast.
 * TOKEN_ENCRYPTION_KEY is 32 random bytes, base64-encoded (`openssl rand -base64 32`).
 *
 * @param {NodeJS.ProcessEnv} env
 * PUBLIC_BASE_URL (optional here) is where Atlassian sends Jira webhooks (`<url>/webhooks/jira`): the worker
 * registers them, so it needs the web service's public https address too; without one Jira only syncs periodically.
 *
 * @returns {{ clientId: string, clientSecret: string, encryptionKey: Buffer|{ current: Buffer, previous: Buffer[] }, webhookUrl: string|null }|null}
 * @throws {Error} naming every missing/invalid variable
 */
function loadAtlassianConfig(env) {
    const keys = ['ATLASSIAN_CLIENT_ID', 'ATLASSIAN_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'];
    if (!keys.some((key) => env[key])) return null;

    const problems = keys.filter((key) => !env[key]).map((key) => `${key} is not set (the other Atlassian variables are)`);
    let encryptionKey = null;
    if (env.TOKEN_ENCRYPTION_KEY) {
        try {
            encryptionKey = loadEncryptionKey(env);
        } catch (err) {
            problems.push(err.message.replace(/^Invalid configuration: /, ''));
        }
    }
    if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join('; ')}`);

    // Atlassian only calls public https URLs: an http one (local development) means no Jira webhooks, not an error.
    const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const webhookUrl = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(base) ? `${base}/webhooks/jira` : null;
    return { clientId: env.ATLASSIAN_CLIENT_ID, clientSecret: env.ATLASSIAN_CLIENT_SECRET, encryptionKey, webhookUrl };
}

module.exports = { loadAuthConfig, loadGitHubAppConfig, loadAtlassianConfig, loadEncryptionKey, loadSealingKeys };
