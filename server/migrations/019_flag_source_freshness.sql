-- Explicit freshness (ADR-003, ROADMAP increment 2). Per source and environment, when ShipScope last confirmed the
-- full state (a complete message: every flag of that environment listed) and the last error there. With the
-- source's threshold, a dashboard can say "not confirmed for X" instead of showing an old value as current.
CREATE TABLE flag_source_envs (
    tenant_id        uuid NOT NULL,
    source_id        uuid NOT NULL,
    environment      text NOT NULL CHECK (environment IN ('test', 'qa', 'prod')),
    last_observed_at timestamptz,
    last_error       text,
    last_error_at    timestamptz,
    PRIMARY KEY (tenant_id, source_id, environment),
    FOREIGN KEY (tenant_id, source_id) REFERENCES flag_sources (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE flag_source_envs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_source_envs FORCE ROW LEVEL SECURITY;
CREATE POLICY flag_source_envs_tenant_all ON flag_source_envs
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- How long a confirmation stays fresh, in minutes. NULL = the default for the source's kind (STALE_AFTER_MINUTES in
-- lib/flags-logic.js: a runtime source a day, a build source never, its values change only with a deployment).
ALTER TABLE flag_sources ADD COLUMN stale_after_minutes integer CHECK (stale_after_minutes BETWEEN 5 AND 43200);
