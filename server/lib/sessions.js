const crypto = require('crypto');

const SESSION_TTL_DAYS = 14;

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Creates a session for userId. Returns the raw token for the cookie; only its SHA-256 is stored.
 *
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
async function createSession(pool, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const { rows } = await pool.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))
         RETURNING expires_at`,
        [hashToken(token), userId, SESSION_TTL_DAYS]
    );
    return { token, expiresAt: rows[0].expires_at };
}

/**
 * Resolves a session token to its user, or null for an unknown, expired or malformed token.
 *
 * @param {import('pg').Pool} pool
 * @param {string|undefined} token
 * @returns {Promise<{ id: string, githubUserId: number|null, githubLogin: string, fromSuite: boolean }|null>}
 */
async function getSessionUser(pool, token) {
    if (typeof token !== 'string' || !token) return null;
    const { rows } = await pool.query(
        `SELECT u.id, u.github_user_id, COALESCE(u.github_login, u.display_name) AS github_login, u.suite_sub
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hashToken(token)]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    // `githubLogin` is the name shown for the user: the GitHub login, or the suite's name for a person from the suite.
    return { id: row.id, githubUserId: row.github_user_id === null ? null : Number(row.github_user_id), githubLogin: row.github_login, fromSuite: row.suite_sub !== null };
}

/**
 * Deletes a session (logout). Unknown tokens are a no-op.
 *
 * @param {import('pg').Pool} pool
 * @param {string|undefined} token
 * @returns {Promise<void>}
 */
async function deleteSession(pool, token) {
    if (typeof token !== 'string' || !token) return;
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

module.exports = { createSession, getSessionUser, deleteSession };
