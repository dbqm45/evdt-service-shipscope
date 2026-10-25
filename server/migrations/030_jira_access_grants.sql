-- Jira refresh tokens only the worker can read (lib/sealed-box.js, ROADMAP "Bezpieczeństwo", stage 2): when the web
-- service needs Jira (Settings, "Sync now", disconnecting), it asks the worker for a short-lived access token through
-- sync_requests (`jira-token`, keyed by tenant); the worker refreshes the grant and leaves the access token here,
-- sealed with TOKEN_ENCRYPTION_KEY, until it expires (or why it could not). One row per tenant.
CREATE TABLE jira_access_grants (
    tenant_id        uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
    access_token_enc text,
    cloud_id         text,
    expires_at       timestamptz,
    error            text CHECK (length(error) <= 300),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jira_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE jira_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY jira_access_grants_tenant_all ON jira_access_grants
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE sync_requests DROP CONSTRAINT sync_requests_source_check;
ALTER TABLE sync_requests ADD CONSTRAINT sync_requests_source_check CHECK (source IN ('github', 'jira', 'flags', 'endpoint-test', 'jira-token'));
