-- FR-004 (install the GitHub App on chosen repos to connect them to a tenant) and FR-006 (add/remove
-- tracked repos afterwards). An installation is linked to exactly one tenant: the UNIQUE constraint holds
-- across tenants regardless of RLS, so a second tenant can't claim an organization another tenant already
-- connected. No GitHub token is stored here -- installation tokens are minted per use (lib/github-app.js).
CREATE TABLE github_installations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    installation_id bigint NOT NULL,
    account_login   text NOT NULL,
    account_type    text NOT NULL,
    created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT github_installations_installation_id_key UNIQUE (installation_id),
    -- Target of tracked_repos' composite foreign key below.
    CONSTRAINT github_installations_tenant_installation_key UNIQUE (tenant_id, installation_id)
);

-- Which of an installation's repositories the tenant tracks. Removing the installation removes them. The
-- foreign key is on (tenant_id, installation_id), so a tracked repo can only point at an installation of
-- its own tenant -- enforced by the database, not just by the application code.
CREATE TABLE tracked_repos (
    tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    repo_id         bigint NOT NULL,
    installation_id bigint NOT NULL,
    full_name       text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, repo_id),
    FOREIGN KEY (tenant_id, installation_id) REFERENCES github_installations (tenant_id, installation_id) ON DELETE CASCADE
);

CREATE INDEX tracked_repos_installation_id_idx ON tracked_repos (installation_id);

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE tracked_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_repos FORCE ROW LEVEL SECURITY;

CREATE POLICY github_installations_tenant_all ON github_installations
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tracked_repos_tenant_all ON tracked_repos
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
