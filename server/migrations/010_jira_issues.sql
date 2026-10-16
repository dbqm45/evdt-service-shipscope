-- FR-008/FR-009: which Jira boards a tenant syncs, and the issues synced from them, grouped by PI.
-- Everything here belongs to the tenant's Jira connection (009): disconnecting removes it, and so does choosing
-- another site (lib/jira-connections.js clears it, since board ids belong to one site).

ALTER TABLE jira_connections
    ADD COLUMN current_pi text,
    ADD COLUMN last_synced_at timestamptz;

-- FR-008: the Scrum boards an admin chose. A board defines the sprints, and its sprints the PIs, so it is also what
-- scopes the sync to a team: only issues in this board's sprints are synced.
CREATE TABLE jira_boards (
    tenant_id    uuid NOT NULL REFERENCES jira_connections (tenant_id) ON DELETE CASCADE,
    board_id     bigint NOT NULL,
    name         text NOT NULL,
    project_key  text,
    project_name text,
    PRIMARY KEY (tenant_id, board_id)
);

-- One row per PI the tenant has issues for: the sprints in it (the dashboard's per-PI sprint list).
CREATE TABLE jira_pis (
    tenant_id uuid NOT NULL REFERENCES jira_connections (tenant_id) ON DELETE CASCADE,
    pi        text NOT NULL,
    sprints   jsonb NOT NULL DEFAULT '[]',
    synced_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, pi)
);

-- An issue as seen in one PI (the dashboard's issue shape in `data`). Per PI, not per issue: the current PI is
-- re-synced (fully replaced per board) on every pass, earlier PIs stay as the snapshot taken while they were
-- current -- the same model as the file-based per-PI shards.
CREATE TABLE jira_issues (
    tenant_id uuid NOT NULL,
    pi        text NOT NULL,
    key       text NOT NULL,
    board_id  bigint NOT NULL,
    data      jsonb NOT NULL,
    synced_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, pi, key),
    FOREIGN KEY (tenant_id, pi) REFERENCES jira_pis (tenant_id, pi) ON DELETE CASCADE
);

CREATE INDEX jira_issues_tenant_board_idx ON jira_issues (tenant_id, board_id);

ALTER TABLE jira_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE jira_boards FORCE ROW LEVEL SECURITY;
ALTER TABLE jira_pis ENABLE ROW LEVEL SECURITY;
ALTER TABLE jira_pis FORCE ROW LEVEL SECURITY;
ALTER TABLE jira_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE jira_issues FORCE ROW LEVEL SECURITY;

CREATE POLICY jira_boards_tenant_all ON jira_boards
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY jira_pis_tenant_all ON jira_pis
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY jira_issues_tenant_all ON jira_issues
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
