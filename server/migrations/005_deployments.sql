-- FR-005: deployments of tracked repos, ingested by the worker (lib/deployment-sync.js), tenant-scoped.
-- ShipScope shows the current state, not an archive (GitHub keeps the full history): records older than the
-- tenant's retention are deleted daily (lib/retention.js), except each repo/environment's latest deployment
-- and latest successful one, which current-version and rollback detection need however old they are.

ALTER TABLE tenants
    ADD COLUMN deployment_retention_days integer NOT NULL DEFAULT 90
    CONSTRAINT tenants_deployment_retention_days_check CHECK (deployment_retention_days BETWEEN 7 AND 730);

-- Per tracked repo: the highest GitHub deployment id fully processed (ids grow monotonically per repo, so
-- "already synced" is id <= cursor even after retention deleted the record), and the last run's outcome.
ALTER TABLE tracked_repos
    ADD COLUMN deployments_cursor bigint NOT NULL DEFAULT 0,
    ADD COLUMN last_synced_at timestamptz,
    ADD COLUMN last_sync_error text;

CREATE TABLE deployments (
    tenant_id          uuid NOT NULL,
    repo_id            bigint NOT NULL,
    deployment_id      bigint NOT NULL,
    environment        text NOT NULL CHECK (environment IN ('test', 'qa', 'prod')),
    status             text NOT NULL CHECK (status IN ('success', 'failed')),
    sha                text NOT NULL,
    ref                text,
    deployed_at        timestamptz NOT NULL,
    deployed_by_login  text,
    workflow_run_url   text,
    duration_ms        bigint,
    commit_url         text,
    -- Set when this deploy moved the environment backwards (its commit is an ancestor of the previous one).
    rollback_to_sha    text,
    related_issues     text[] NOT NULL DEFAULT '{}',
    issue_commit_types jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (tenant_id, deployment_id),
    -- Untracking a repo removes its deployments: no orphaned history for a repo the tenant dropped.
    FOREIGN KEY (tenant_id, repo_id) REFERENCES tracked_repos (tenant_id, repo_id) ON DELETE CASCADE
);

CREATE INDEX deployments_repo_env_time_idx ON deployments (tenant_id, repo_id, environment, deployed_at DESC);
CREATE INDEX deployments_time_idx ON deployments (tenant_id, deployed_at DESC);

-- "Issue X first reached ENV through REPO at T". Never trimmed by retention: a few bytes per issue, and
-- "did this ever ship" is a fact, not history (same role as docs/data/issue-deployments.json).
CREATE TABLE issue_deployments (
    tenant_id         uuid NOT NULL,
    issue_key         text NOT NULL,
    environment       text NOT NULL CHECK (environment IN ('test', 'qa', 'prod')),
    repo_id           bigint NOT NULL,
    first_deployed_at timestamptz NOT NULL,
    commit_url        text,
    PRIMARY KEY (tenant_id, issue_key, environment, repo_id),
    FOREIGN KEY (tenant_id, repo_id) REFERENCES tracked_repos (tenant_id, repo_id) ON DELETE CASCADE
);

ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments FORCE ROW LEVEL SECURITY;
ALTER TABLE issue_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_deployments FORCE ROW LEVEL SECURITY;

CREATE POLICY deployments_tenant_all ON deployments
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY issue_deployments_tenant_all ON issue_deployments
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
