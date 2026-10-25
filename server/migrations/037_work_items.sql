-- Work items from a repo (F1 of the pdi one-flow plan, contract 0.4.0): changes CHG-n and their tasks TSK-n, read by
-- the worker from docs/project/changes/<CHG>/intent.md and plan.md in each tracked repo's default branch
-- (lib/work-items.js). Their keys have Jira's shape, so commits name them like issues; a change counts the commits of
-- its tasks (the dashboard's subtaskKeys).
ALTER TABLE tracked_repos
    ADD COLUMN work_items_ref text,     -- the newest commit of docs/project/changes read; unchanged = nothing to read
    ADD COLUMN work_items_error text;   -- what could not be read at it, shown in Settings → GitHub

CREATE TABLE work_items (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    item_key text NOT NULL CHECK (item_key ~ '^[A-Z][A-Z0-9]+-[0-9]+$'),
    kind text NOT NULL CHECK (kind IN ('change', 'task')),
    parent_key text CHECK (parent_key ~ '^[A-Z][A-Z0-9]+-[0-9]+$'),
    repo_id bigint NOT NULL,
    title text NOT NULL,
    status text,
    source_key text,
    path text NOT NULL,
    ref text NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, item_key),
    -- Untracking a repo removes what was read from it.
    FOREIGN KEY (tenant_id, repo_id) REFERENCES tracked_repos (tenant_id, repo_id) ON DELETE CASCADE
);

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE ROW LEVEL SECURITY;
CREATE POLICY work_items_tenant_all ON work_items
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
