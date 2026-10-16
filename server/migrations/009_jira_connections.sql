-- FR-007: a tenant's Jira Cloud connection, made through Atlassian OAuth 2.0 (3LO). One site per tenant (prd.md,
-- MVP non-goal: multi-site). Only the refresh token is stored, encrypted (lib/secret-box.js, bound to the tenant
-- id); access tokens are minted per use and never stored.
--   available_sites: the Jira sites the grant covers ([{ cloudId, url, name }]), from which an admin picks one
--                    when there is more than one; cloud_id/site_url/site_name are the chosen site.
--   last_error:      why the last use of the connection failed (e.g. the grant was revoked), for the admin.
CREATE TABLE jira_connections (
    tenant_id         uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
    refresh_token_enc text NOT NULL,
    scopes            text[] NOT NULL DEFAULT '{}',
    available_sites   jsonb NOT NULL DEFAULT '[]',
    cloud_id          text,
    site_url          text,
    site_name         text,
    connected_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    connected_at      timestamptz NOT NULL DEFAULT now(),
    last_error        text
);

ALTER TABLE jira_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE jira_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY jira_connections_tenant_all ON jira_connections
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
