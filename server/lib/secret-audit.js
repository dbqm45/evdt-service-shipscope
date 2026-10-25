// The audit log of a workspace's secrets (ADR-003 point 5, migration 028): who showed or replaced the signing secret,
// set or removed an endpoint token, connected or disconnected Jira, and when. Never the secret itself. Each event is
// written in the same transaction as what it records, so a rolled-back change leaves no event.
const { withScope } = require('./scope');
const { assertAdmin } = require('./tenants');

const SECRET_EVENT_KINDS = [
    'signing_secret_viewed', 'signing_secret_rotated', 'endpoint_token_set', 'endpoint_token_removed', 'jira_connected', 'jira_disconnected',
];
const LIST_LIMIT = 100;

/**
 * Inside withScope: records one event.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, actorUserId: string|null, kind: string, subject?: string|null }} input
 *   `subject`: what it was about (a flag source's name), never a secret
 * @returns {Promise<void>}
 */
async function recordSecretEvent(client, { tenantId, actorUserId, kind, subject = null }) {
    if (!SECRET_EVENT_KINDS.includes(kind)) throw new Error(`Unknown secret event ${kind}`);
    await client.query(
        'INSERT INTO secret_events (tenant_id, actor_user_id, kind, subject) VALUES ($1, $2, $3, $4)',
        [tenantId, actorUserId, kind, subject === null ? null : String(subject).slice(0, 200)]
    );
}

/**
 * The workspace's latest secret events, newest first, with who did each. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<{ at: Date, kind: string, subject: string|null, actor: string|null }>>} `actor`: a GitHub login
 */
async function listSecretEvents(pool, { tenantId, actorUserId }) {
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            `SELECT e.at, e.kind, e.subject, u.github_login FROM secret_events e LEFT JOIN users u ON u.id = e.actor_user_id
             WHERE e.tenant_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT $2`,
            [tenantId, LIST_LIMIT]
        );
        return rows.map((r) => ({ at: r.at, kind: r.kind, subject: r.subject, actor: r.github_login || null }));
    });
}

module.exports = { SECRET_EVENT_KINDS, recordSecretEvent, listSecretEvents };
