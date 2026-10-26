-- Service tokens (F5 of the pdi one-flow plan, design-docs/F5-API-PLAN.pl.md): another service (pdi, tf, a CI
-- script) reads an item's status and the PROD metrics of one workspace without a person's session. Read only; only
-- a SHA-256 of the token is stored, as for ingest tokens.
CREATE TABLE service_tokens (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    token_hash text NOT NULL UNIQUE,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    last_used_at timestamptz,
    PRIMARY KEY (tenant_id, id)
);

ALTER TABLE service_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY service_tokens_tenant_all ON service_tokens
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The caller's side: a request carrying a token can read exactly the one row it holds (lib/service-api.js sets
-- app.service_token_hash), which tells it its tenant; everything after that runs under that tenant.
CREATE POLICY service_tokens_token_read ON service_tokens
    FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.service_token_hash', true), ''));
