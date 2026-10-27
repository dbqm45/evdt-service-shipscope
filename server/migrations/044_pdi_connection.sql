-- The connection with pdi (design-docs/PDI-CONNECTION-PLAN.pl.md): one per workspace, created from Settings → pdi
-- (lib/pdi-connection.js). It owns a service token and an event subscription; its state comes from what each side has
-- proven (pdi read ShipScope with the token; ShipScope reached pdi with a signed ping or a delivered event).
CREATE TABLE pdi_connections (
    tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
    receiver_url text NOT NULL,
    service_token_id uuid,
    subscription_id uuid,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_ping_ok_at timestamptz,
    last_ping_error text,
    last_ping_error_at timestamptz,
    disconnected_at timestamptz
);

ALTER TABLE pdi_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE pdi_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY pdi_connections_tenant_all ON pdi_connections
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- A subscription may sign with its own secret (sealed with TOKEN_ENCRYPTION_KEY); without one the workspace's
-- signing secret signs, as before.
ALTER TABLE event_subscriptions ADD COLUMN signing_secret_enc text;
