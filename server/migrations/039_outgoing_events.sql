-- Outgoing events (G1.5 of the pdi G1/G2 plan, contract 0.4.0): release.stage_changed and feature.released sent to the
-- addresses a workspace's admin subscribes (lib/outgoing-events.js). The first outgoing webhooks of F5, kept to these
-- two events: what was seen last (event_state), what waits to be delivered (event_outbox).
CREATE TABLE event_subscriptions (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    url text NOT NULL,
    types text[] NOT NULL CHECK (cardinality(types) > 0 AND types <@ ARRAY['release.stage_changed', 'feature.released']),
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_delivered_at timestamptz,
    last_error text,
    last_error_at timestamptz,
    PRIMARY KEY (tenant_id, id)
);

-- The release state last seen: `seen` (a change was looked at once: its baseline), `released` (a line was released),
-- `stage` (a planned flag's rollout stage, '' when off).
CREATE TABLE event_state (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('seen', 'released', 'stage')),
    subject text NOT NULL,
    value text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, kind, subject)
);

CREATE TABLE event_outbox (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    subscription_id uuid NOT NULL,
    event jsonb NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    failed_at timestamptz,
    last_error text,
    -- clock_timestamp(): events queued in one transaction keep the order they were planned in.
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, subscription_id) REFERENCES event_subscriptions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX event_outbox_due ON event_outbox (next_attempt_at) WHERE delivered_at IS NULL AND failed_at IS NULL;

ALTER TABLE event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY event_subscriptions_tenant_all ON event_subscriptions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE event_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_state FORCE ROW LEVEL SECURITY;
CREATE POLICY event_state_tenant_all ON event_state
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_outbox_tenant_all ON event_outbox
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
