// The workspace's audit log (migrations 028 and 031): who changed which setting, and when. Secrets (the signing secret
// shown or replaced, an endpoint token set or removed, Jira connected or disconnected), members and invitations, the
// GitHub connection and tracked repositories, flag sources and their tokens, flags' hand-set details, Jira's site,
// boards and flag convention, the workspace's retention. Never a secret or a token. Each event is written in the same
// transaction as what it records, so a rolled-back change leaves no event.
const { withScope } = require('./scope');

const SECRET_EVENT_KINDS = [
    'signing_secret_viewed', 'signing_secret_rotated', 'endpoint_token_set', 'endpoint_token_removed', 'jira_connected', 'jira_disconnected',
];
const AUDIT_EVENT_KINDS = [
    ...SECRET_EVENT_KINDS,
    'workspace_created', 'retention_changed', 'insights_changed',
    'invitation_created', 'invitation_revoked', 'member_joined', 'member_removed', 'member_left',
    'github_linked', 'github_unlinked', 'repo_tracked', 'repo_untracked', 'repo_settings_changed', 'repo_environments_changed', 'repo_resynced',
    'repo_flag_stance_changed', 'repo_role_changed',
    'flag_source_created', 'flag_source_updated', 'flag_source_deleted', 'ingest_token_created', 'ingest_token_revoked', 'service_token_created', 'service_token_revoked',
    'flag_details_changed', 'flag_link_accepted', 'flag_link_dismissed',
    'jira_site_selected', 'jira_flag_link_changed', 'jira_release_link_changed', 'event_subscription_added', 'event_subscription_removed', 'jira_boards_changed', 'jira_board_changed',
    'pdi_connected', 'pdi_disconnected',
];
const LIST_LIMIT = 100;

/**
 * Inside withScope: records one event.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ tenantId: string, actorUserId: string|null, kind: string, subject?: string|null }} input
 *   `subject`: what it was about (a repository, a flag source's name, a new value), never a secret
 * @returns {Promise<void>}
 */
async function recordAuditEvent(client, { tenantId, actorUserId, kind, subject = null }) {
    if (!AUDIT_EVENT_KINDS.includes(kind)) throw new Error(`Unknown audit event ${kind}`);
    await client.query(
        'INSERT INTO audit_events (tenant_id, actor_user_id, kind, subject) VALUES ($1, $2, $3, $4)',
        [tenantId, actorUserId, kind, subject === null ? null : String(subject).slice(0, 200)]
    );
}

/**
 * The workspace's latest events, newest first, with who did each. Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string, kinds?: string[]|null }} input `kinds`: only these (null = all)
 * @returns {Promise<Array<{ at: Date, kind: string, subject: string|null, actor: string|null }>>} `actor`: a GitHub login
 */
async function listAuditEvents(pool, { tenantId, actorUserId, kinds = null }) {
    // Required here: lib/tenants.js records its own events through this module.
    const { assertAdmin } = require('./tenants');
    return withScope(pool, { tenantId }, async (client) => {
        await assertAdmin(client, { tenantId, userId: actorUserId });
        const { rows } = await client.query(
            `SELECT e.at, e.kind, e.subject, u.github_login FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id
             WHERE e.tenant_id = $1 AND ($2::text[] IS NULL OR e.kind = ANY($2)) ORDER BY e.at DESC, e.id DESC LIMIT $3`,
            [tenantId, kinds, LIST_LIMIT]
        );
        return rows.map((r) => ({ at: r.at, kind: r.kind, subject: r.subject, actor: r.github_login || null }));
    });
}

/**
 * The secret events only (Settings → Sources, "Secret activity"). Admins only.
 *
 * @param {import('pg').Pool} pool
 * @param {{ tenantId: string, actorUserId: string }} input
 * @returns {Promise<Array<{ at: Date, kind: string, subject: string|null, actor: string|null }>>}
 */
function listSecretEvents(pool, { tenantId, actorUserId }) {
    return listAuditEvents(pool, { tenantId, actorUserId, kinds: SECRET_EVENT_KINDS });
}

module.exports = { SECRET_EVENT_KINDS, AUDIT_EVENT_KINDS, recordAuditEvent, listAuditEvents, listSecretEvents };
