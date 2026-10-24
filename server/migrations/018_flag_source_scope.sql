-- Flag state per service (ADR-003, ROADMAP increment 1). A source now covers a set of services (tracked repos)
-- instead of carrying one optional repo_id label: one LaunchDarkly project can gate three services, one endpoint
-- one service. As with flag_sources.repo_id (008), repo_id is deliberately not a foreign key to tracked_repos:
-- untracking a repo keeps the source's scope, which applies again if the repo is tracked again.
CREATE TABLE flag_source_repos (
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    repo_id   bigint NOT NULL,
    PRIMARY KEY (tenant_id, source_id, repo_id),
    FOREIGN KEY (tenant_id, source_id) REFERENCES flag_sources (tenant_id, id) ON DELETE CASCADE
);

-- Carry over every existing label. The migration runs as the tables' owner, which FORCE ROW LEVEL SECURITY
-- otherwise holds to the (here unset) tenant scope, so the copy happens with the policy lifted for this one read.
ALTER TABLE flag_sources NO FORCE ROW LEVEL SECURITY;
INSERT INTO flag_source_repos (tenant_id, source_id, repo_id)
    SELECT tenant_id, id, repo_id FROM flag_sources WHERE repo_id IS NOT NULL;
ALTER TABLE flag_sources FORCE ROW LEVEL SECURITY;

ALTER TABLE flag_source_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_source_repos FORCE ROW LEVEL SECURITY;
CREATE POLICY flag_source_repos_tenant_all ON flag_source_repos
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- What a repo declares about flags when no source covers it: 'unknown' (nobody said; the dashboard shows "?") or
-- 'none' (the team says the service uses no flags, so deployed code is live code). A repo covered by a source is
-- "tracked" whatever this says.
ALTER TABLE tracked_repos ADD COLUMN flag_stance text NOT NULL DEFAULT 'unknown' CHECK (flag_stance IN ('unknown', 'none'));
