const crypto = require('crypto');

/**
 * Webhook deliveries (migration 013). The web service verifies a delivery came from GitHub / Atlassian, reads only
 * what it is about (a repo id; a Jira webhook id or site) and records that in `sync_requests`; the worker drains
 * the queue with a sync of just that (worker.js webhookTick()). Nothing from the delivery body is stored or trusted
 * beyond that key: the sync reads the real state from the API itself, so a replayed or reordered delivery can at
 * worst cause one extra sync.
 */

class WebhookAuthError extends Error {}

const safeEqual = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * GitHub's `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>` with the App's webhook secret.
 *
 * @param {{ secret: string, rawBody: Buffer, signature: string|undefined }} input
 * @throws {WebhookAuthError}
 */
function verifyGitHubSignature({ secret, rawBody, signature }) {
    if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) throw new WebhookAuthError('missing or malformed signature');
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    if (!safeEqual(signature, expected)) throw new WebhookAuthError('signature does not match');
}

const CLOCK_SKEW_SECONDS = 300;

/**
 * Atlassian's `Authorization: Bearer <JWT>` on a webhook for an OAuth 2.0 app: HS256, signed with the app's client
 * secret. Only HS256 is accepted (never the token's own choice of algorithm, never `none`), and an `exp` in the past
 * or an `iat` in the future (beyond clock skew) is refused.
 *
 * @param {{ secret: string, authorization: string|undefined, now?: number }} input now in ms
 * @returns {object} the token's claims
 * @throws {WebhookAuthError}
 */
function verifyAtlassianJwt({ secret, authorization, now = Date.now() }) {
    const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match) throw new WebhookAuthError('missing or malformed bearer token');
    const [, head, body, sig] = match;
    let header;
    let claims;
    try {
        header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
        claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        throw new WebhookAuthError('token is not valid JSON');
    }
    if (header?.alg !== 'HS256') throw new WebhookAuthError('token must be signed with HS256');
    const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
    if (!safeEqual(sig, expected)) throw new WebhookAuthError('token signature does not match');
    if (!claims || typeof claims !== 'object') throw new WebhookAuthError('token has no claims');
    const seconds = Math.floor(now / 1000);
    if (claims.exp !== undefined && (typeof claims.exp !== 'number' || claims.exp < seconds - CLOCK_SKEW_SECONDS)) throw new WebhookAuthError('token has expired');
    if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > seconds + CLOCK_SKEW_SECONDS)) throw new WebhookAuthError('token is from the future');
    return claims;
}

/**
 * What a GitHub delivery asks to sync: the repo of a deployment status. Other events ask for nothing.
 *
 * @param {string|undefined} event X-GitHub-Event
 * @param {object} payload
 * @returns {string[]} repo ids
 */
function githubSyncKeys(event, payload) {
    if (event !== 'deployment_status' && event !== 'deployment') return [];
    const id = payload?.repository?.id;
    return Number.isSafeInteger(id) && id > 0 ? [String(id)] : [];
}

/**
 * What a Jira delivery asks to sync: the webhook ids it matched (`matchedWebhookIds`, what ShipScope registered per
 * tenant), else the site its issue link names (`cloud:<id>` through api.atlassian.com, `site:<origin>` otherwise).
 *
 * @param {object} payload
 * @returns {string[]}
 */
function jiraSyncKeys(payload) {
    const ids = Array.isArray(payload?.matchedWebhookIds)
        ? payload.matchedWebhookIds.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 20).map((id) => `webhook:${id}`)
        : [];
    if (ids.length) return ids;
    const self = typeof payload?.issue?.self === 'string' ? payload.issue.self : '';
    const cloud = /^https:\/\/api\.atlassian\.com\/ex\/jira\/([A-Za-z0-9-]{1,64})\//.exec(self);
    if (cloud) return [`cloud:${cloud[1]}`];
    const site = /^(https:\/\/[A-Za-z0-9.-]{1,200})\//.exec(self);
    return site ? [`site:${site[1]}`] : [];
}

/**
 * Records sync requests; a key already waiting just gets the newer time.
 *
 * @param {import('pg').Pool} pool
 * @param {{ source: 'github'|'jira', keys: string[] }} input
 * @returns {Promise<void>}
 */
async function requestSync(pool, { source, keys }) {
    if (!keys.length) return;
    await pool.query(
        `INSERT INTO sync_requests (source, external_key) SELECT $1, k FROM unnest($2::text[]) AS t(k)
         ON CONFLICT (source, external_key) DO UPDATE SET requested_at = now()`,
        [source, keys]
    );
}

/**
 * The waiting requests of one source, as a snapshot to finish with finishSyncRequests().
 *
 * @param {import('pg').Pool} pool
 * @param {'github'|'jira'} source
 * @returns {Promise<Array<{ key: string, requestedAt: Date }>>}
 */
async function pendingSyncRequests(pool, source) {
    const { rows } = await pool.query('SELECT external_key, requested_at FROM sync_requests WHERE source = $1 ORDER BY requested_at LIMIT 500', [source]);
    return rows.map((r) => ({ key: r.external_key, requestedAt: r.requested_at }));
}

/**
 * Removes the requests a sync handled; one asked for again since the snapshot (a newer time) stays for the next round.
 *
 * @param {import('pg').Pool} pool
 * @param {'github'|'jira'} source
 * @param {Array<{ key: string, requestedAt: Date }>} handled
 * @returns {Promise<void>}
 */
async function finishSyncRequests(pool, source, handled) {
    for (const { key, requestedAt } of handled) {
        // At millisecond precision: requestedAt came back as a JS Date, the column keeps microseconds.
        await pool.query(
            "DELETE FROM sync_requests WHERE source = $1 AND external_key = $2 AND date_trunc('milliseconds', requested_at) <= $3",
            [source, key, requestedAt]
        );
    }
}

module.exports = {
    WebhookAuthError, verifyGitHubSignature, verifyAtlassianJwt, githubSyncKeys, jiraSyncKeys, requestSync, pendingSyncRequests, finishSyncRequests,
};
