-- FR-001 (GitHub sign-in): server-side sessions, plus the RLS tightening 001 deferred "until FR-001's
-- auth middleware exists". It exists now (lib/scope.js), so every memberships read/write runs inside
-- a transaction that has set app.current_tenant_id and/or app.current_user_id with set_config(..., true).

-- Only a SHA-256 of the session token is stored: the raw token lives solely in the user's httpOnly
-- cookie, so a leaked database dump (or a log line printing a row) can't be replayed as a session.
-- The GitHub user access token from the OAuth exchange is deliberately not stored at all -- sign-in
-- only needs the identity, and an unstored credential can't leak (prd.md: credential hygiene).
CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- A signed-in user must be able to list their own tenants before choosing one, which the
-- tenant-scoped read policy can't express (it needs a tenant first). Permissive policies are OR'd,
-- so this adds "my own rows" alongside "this tenant's rows". Same NULLIF fail-closed shape as 001.
CREATE POLICY memberships_self_read ON memberships
    FOR SELECT
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- Writes: previously WITH CHECK (true). Now a write must target the tenant the transaction is scoped
-- to -- an unscoped write fails closed with an RLS violation instead of landing anywhere.
DROP POLICY memberships_tenant_write ON memberships;
DROP POLICY memberships_tenant_update ON memberships;
DROP POLICY memberships_tenant_delete ON memberships;

CREATE POLICY memberships_tenant_write ON memberships
    FOR INSERT
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY memberships_tenant_update ON memberships
    FOR UPDATE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY memberships_tenant_delete ON memberships
    FOR DELETE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
