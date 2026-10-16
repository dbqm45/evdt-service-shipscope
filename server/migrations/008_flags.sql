-- Feature flags, pushed from outside (decision 2026-10-16: every tenant keeps flags its own way -- build-time
-- files, a runtime API, a third-party service, or none at all -- so ShipScope never reads them itself; whatever
-- the tenant uses sends observations to POST /api/flags/ingest with an ingest token). Same data the file-based
-- flags-meta.json / flag-states.json / flag-state-history.json hold, scoped per tenant.

-- Ingest tokens: one per sender, bound to one tracked repo (the "component" the flags belong to, so a token can
-- never write as another component -- the collision guard relies on that). Same handling as invitations (003):
-- only the SHA-256 is stored, the token is shown once at creation.
CREATE TABLE ingest_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   text NOT NULL UNIQUE,
    tenant_id    uuid NOT NULL,
    repo_id      bigint NOT NULL,
    label        text NOT NULL,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    FOREIGN KEY (tenant_id, repo_id) REFERENCES tracked_repos (tenant_id, repo_id) ON DELETE CASCADE
);

CREATE INDEX ingest_tokens_tenant_repo_idx ON ingest_tokens (tenant_id, repo_id);

-- One row per flag key: its description and the Jira issues it gates (both optional, sent with the flags).
CREATE TABLE flags (
    tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    key         text NOT NULL,
    description text,
    jira_keys   text[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
);

-- The latest value per flag/environment/source, and which repo wrote it (the per-source owner: another repo
-- sending the same key for the same source is a name collision and is refused).
CREATE TABLE flag_states (
    tenant_id   uuid NOT NULL,
    key         text NOT NULL,
    environment text NOT NULL CHECK (environment IN ('test', 'qa', 'prod')),
    source      text NOT NULL CHECK (source IN ('build', 'runtime-be')),
    enabled     boolean NOT NULL,
    changed_at  timestamptz NOT NULL,
    changed_by  text NOT NULL,
    repo_id     bigint NOT NULL,
    PRIMARY KEY (tenant_id, key, environment, source),
    FOREIGN KEY (tenant_id, key) REFERENCES flags (tenant_id, key) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, repo_id) REFERENCES tracked_repos (tenant_id, repo_id) ON DELETE CASCADE
);

-- Every actual flip, append-only (a resend of the same value adds nothing).
CREATE TABLE flag_state_history (
    id          bigserial PRIMARY KEY,
    tenant_id   uuid NOT NULL,
    key         text NOT NULL,
    environment text NOT NULL,
    source      text NOT NULL,
    enabled     boolean NOT NULL,
    changed_at  timestamptz NOT NULL,
    changed_by  text NOT NULL,
    repo_id     bigint NOT NULL,
    FOREIGN KEY (tenant_id, repo_id) REFERENCES tracked_repos (tenant_id, repo_id) ON DELETE CASCADE
);

CREATE INDEX flag_state_history_tenant_time_idx ON flag_state_history (tenant_id, changed_at);

ALTER TABLE ingest_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE flags FORCE ROW LEVEL SECURITY;
ALTER TABLE flag_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_states FORCE ROW LEVEL SECURITY;
ALTER TABLE flag_state_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_state_history FORCE ROW LEVEL SECURITY;

CREATE POLICY ingest_tokens_tenant_all ON ingest_tokens
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The sender side: a request carrying a token can read exactly the one token row it holds (lib/flags.js sets
-- app.ingest_token_hash), which tells it its tenant; everything after that runs under that tenant's scope.
CREATE POLICY ingest_tokens_token_read ON ingest_tokens
    FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.ingest_token_hash', true), ''));

CREATE POLICY flags_tenant_all ON flags
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY flag_states_tenant_all ON flag_states
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY flag_state_history_tenant_all ON flag_state_history
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
