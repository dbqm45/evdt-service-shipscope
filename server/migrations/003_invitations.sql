-- FR-003 (Admin can invite Members): invitation links. An admin creates an invitation and gets a one-time
-- URL; whoever opens it signs in with GitHub and accepts, which creates their membership. A link rather
-- than "add by GitHub login": no GitHub API call or rate limit, works for people who never signed in yet,
-- and nobody lands in a tenant without accepting.
--
-- Same token handling as sessions (002): only the SHA-256 is stored, so a database dump holds no usable
-- link. `id` is what admins list and revoke by; the token itself is shown once, at creation.
CREATE TABLE invitations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  text NOT NULL UNIQUE,
    tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('admin', 'member')),
    created_by  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
    revoked_at  timestamptz
);

CREATE INDEX invitations_tenant_id_idx ON invitations (tenant_id);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

-- Admin side: everything about a tenant's invitations happens under that tenant's scope.
CREATE POLICY invitations_tenant_all ON invitations
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Invitee side: someone who isn't a member yet can read exactly the one invitation whose token they hold
-- (lib/invitations.js sets app.invite_token_hash), never list or guess others. Accepting then switches to
-- that invitation's tenant scope, so the write goes through the policy above.
CREATE POLICY invitations_token_read ON invitations
    FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.invite_token_hash', true), ''));
