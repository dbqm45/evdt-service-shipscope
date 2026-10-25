-- Release plans kept in a repo (G1.3 repo mode, pdi contract 0.4.0): docs/project/changes/<CHG>/release.yaml, read with
-- the work items (migration 037, lib/work-items.js) and validated by the pinned copy of the contract's schema
-- (schemas/release-plan.v0.4.0.schema.json). `plan` is the file as validated, in the contract's shape.
CREATE TABLE release_plans (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    change_key text NOT NULL CHECK (change_key ~ '^[A-Z][A-Z0-9]+-[0-9]+$'),
    repo_id bigint NOT NULL,
    plan jsonb NOT NULL,
    ref text NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, change_key),
    FOREIGN KEY (tenant_id, repo_id) REFERENCES tracked_repos (tenant_id, repo_id) ON DELETE CASCADE
);

ALTER TABLE release_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY release_plans_tenant_all ON release_plans
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- What the last read of a repo's changes folder understood: 0 = work items only (037), 1 = with release.yaml. A folder
-- read by an older version is read again even when no commit touched it (an UPDATE here would see no rows under RLS;
-- a column default reaches every row).
ALTER TABLE tracked_repos ADD COLUMN work_items_version integer NOT NULL DEFAULT 0;
