-- Feature flags, pushed from outside (decision 2026-10-16: every tenant keeps flags its own way -- build-time
-- files, a runtime API, a third-party flag service, or none at all -- so ShipScope never reads them itself).
-- Contract: schemaVersion 2 (server/README.md). A tenant names its *flag sources* ("LaunchDarkly", "Frontend
-- CI", ...); each sends the full state of its flags per environment with its own token.

-- A sender of flag values. `kind` says how its values reach users (build: baked in at build time; runtime:
-- switched live); when several sources report one flag, the highest `priority` of a kind wins (by default a
-- runtime source over a build one). `repo_id` optionally ties the source to a component (a tracked repo). Not a
-- foreign key on purpose: untracking the repo keeps the source, which then simply has no component (and gets it
-- back if the repo is tracked again); ON DELETE SET NULL on one column of a composite key would need Postgres 15+.
CREATE TABLE flag_sources (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    name        text NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('build', 'runtime')),
    priority    integer NOT NULL CHECK (priority BETWEEN 0 AND 1000),
    repo_id     bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name),
    UNIQUE (tenant_id, id)
);

-- A source's tokens (several, so one can be rotated without downtime). Same handling as invitations (003):
-- only the SHA-256 is stored, the token is shown once at creation.
CREATE TABLE ingest_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   text NOT NULL UNIQUE,
    tenant_id    uuid NOT NULL,
    source_id    uuid NOT NULL,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    FOREIGN KEY (tenant_id, source_id) REFERENCES flag_sources (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ingest_tokens_source_idx ON ingest_tokens (tenant_id, source_id);

-- One row per flag key: its description and the Jira issues it gates (optional, sent with the flags).
CREATE TABLE flags (
    tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    key         text NOT NULL,
    description text,
    jira_keys   text[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
);

-- The latest value of a flag per source and environment. `removed_at` is set when a full-state message from the
-- source no longer lists the flag (it was deleted there); a later message listing it again clears it.
CREATE TABLE flag_values (
    tenant_id   uuid NOT NULL,
    source_id   uuid NOT NULL,
    key         text NOT NULL,
    environment text NOT NULL CHECK (environment IN ('test', 'qa', 'prod')),
    state       text NOT NULL CHECK (state IN ('off', 'on', 'partial')),
    rollout     numeric(5, 2) CHECK (rollout BETWEEN 0 AND 100),
    changed_at  timestamptz NOT NULL,
    changed_by  text NOT NULL,
    removed_at  timestamptz,
    PRIMARY KEY (tenant_id, source_id, key, environment),
    FOREIGN KEY (tenant_id, key) REFERENCES flags (tenant_id, key) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, source_id) REFERENCES flag_sources (tenant_id, id) ON DELETE CASCADE
);

-- Every actual change, append-only: a new state or rollout, a removal (`removed`), or a flag coming back.
CREATE TABLE flag_value_history (
    id          bigserial PRIMARY KEY,
    tenant_id   uuid NOT NULL,
    source_id   uuid NOT NULL,
    key         text NOT NULL,
    environment text NOT NULL,
    state       text,
    rollout     numeric(5, 2),
    removed     boolean NOT NULL DEFAULT false,
    changed_at  timestamptz NOT NULL,
    changed_by  text NOT NULL,
    FOREIGN KEY (tenant_id, source_id) REFERENCES flag_sources (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX flag_value_history_tenant_time_idx ON flag_value_history (tenant_id, changed_at);

ALTER TABLE flag_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE ingest_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE flags FORCE ROW LEVEL SECURITY;
ALTER TABLE flag_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_values FORCE ROW LEVEL SECURITY;
ALTER TABLE flag_value_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_value_history FORCE ROW LEVEL SECURITY;

CREATE POLICY flag_sources_tenant_all ON flag_sources
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY ingest_tokens_tenant_all ON ingest_tokens
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The sender side: a request carrying a token can read exactly the one token row it holds (lib/flags.js sets
-- app.ingest_token_hash), which tells it its tenant and source; everything after that runs under that tenant.
CREATE POLICY ingest_tokens_token_read ON ingest_tokens
    FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.ingest_token_hash', true), ''));

CREATE POLICY flags_tenant_all ON flags
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY flag_values_tenant_all ON flag_values
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY flag_value_history_tenant_all ON flag_value_history
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
