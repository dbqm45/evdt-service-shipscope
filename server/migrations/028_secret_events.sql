-- Who did what with a workspace's secrets (ADR-003 point 5): the audit log of secret access, lib/secret-audit.js.
-- One row per event, never the secret itself: the signing secret shown or replaced, an endpoint token set or removed,
-- Jira connected or disconnected. Read by admins in Settings → Sources; deleted with the workspace.
CREATE TABLE secret_events (
    id            bigserial PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    at            timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    kind          text NOT NULL CHECK (kind IN ('signing_secret_viewed', 'signing_secret_rotated', 'endpoint_token_set',
                                                'endpoint_token_removed', 'jira_connected', 'jira_disconnected')),
    subject       text CHECK (length(subject) <= 200)
);
CREATE INDEX secret_events_tenant_at ON secret_events (tenant_id, at DESC);

ALTER TABLE secret_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_events FORCE ROW LEVEL SECURITY;
CREATE POLICY secret_events_tenant_all ON secret_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
