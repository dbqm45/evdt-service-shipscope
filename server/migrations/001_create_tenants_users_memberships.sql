-- Core multi-tenant data model (FR-002/FR-003). A GitHub account (identified by its stable
-- github_user_id, not email -- GitHub OAuth is the only auth path and a user may have no public
-- email) can belong to many tenants via memberships, each with an admin/member role (see prd.md's
-- Access Control Changes section). Two tenants for the same real-world company is a known, accepted
-- MVP limitation (FR-002's Socratic note) -- this schema makes no attempt to dedupe by name/domain.
--
-- RLS below is a guardrail investment: no application code sets app.current_tenant_id yet (FR-001's
-- auth middleware doesn't exist). It is declared now and consumed later. See server/README.md.

CREATE TABLE tenants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    github_user_id bigint NOT NULL,
    github_login   text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_github_user_id_key UNIQUE (github_user_id)
);

-- Composite PK, not a surrogate id: it directly expresses "at most one membership per
-- (tenant, user)" as a DB constraint, which addMember() relies on instead of a check-then-insert.
CREATE TABLE memberships (
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('admin', 'member')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

-- Reverse lookup ("which tenants does this user belong to") isn't covered by the PK's leading
-- column, so it needs its own index.
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
-- FORCE matters specifically because Render's DATABASE_URL role both creates and queries these
-- tables (it is the owner). Without FORCE, RLS is a no-op for that role -- exactly the role this
-- guardrail exists to protect against its own bugs.
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

-- Fail-closed by design: an unset app.current_tenant_id yields current_setting(..., true) = NULL.
-- A custom GUC that was set and then RESET on the same connection doesn't go back to NULL though --
-- Postgres has no compiled-in default for an unregistered custom parameter, so RESET reverts it to
-- '' (empty string), and ''::uuid is a hard cast error (22P02), not a smooth non-match. NULLIF folds
-- that case back to NULL before the cast, so both "never set" and "set then reset" fail closed the
-- same way: `tenant_id = NULL` is never true, so zero rows -- never "all rows" -- come back either way.
CREATE POLICY memberships_tenant_read ON memberships
    FOR SELECT
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Writes stay permissive until FR-001's auth middleware exists and sets app.current_tenant_id per
-- request. createTenantWithOwner/addMember are today's only writers -- trusted application code, not
-- untrusted per-request handlers yet. Tighten these to mirror the read policy once that lands.
CREATE POLICY memberships_tenant_write ON memberships
    FOR INSERT WITH CHECK (true);
CREATE POLICY memberships_tenant_update ON memberships
    FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY memberships_tenant_delete ON memberships
    FOR DELETE USING (true);
