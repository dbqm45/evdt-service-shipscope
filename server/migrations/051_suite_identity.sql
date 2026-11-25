-- Sign-in through the suite's identity service beside GitHub (design-docs/SUITE-LOGIN-PLAN.pl.md, ADR 17 in dbqm45/pdi).
-- A person from the suite is a user of their own: identified by the suite's `sub`, named by the token, with no GitHub
-- account (and no e-mail: the suite gives it only to applications that need it, DI3). Every user has one of the two.
ALTER TABLE users ALTER COLUMN github_user_id DROP NOT NULL;
ALTER TABLE users ALTER COLUMN github_login DROP NOT NULL;
ALTER TABLE users ADD COLUMN suite_sub text CHECK (suite_sub IS NULL OR length(suite_sub) BETWEEN 1 AND 200);
ALTER TABLE users ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200);
ALTER TABLE users ADD CONSTRAINT users_suite_sub_key UNIQUE (suite_sub);
ALTER TABLE users ADD CONSTRAINT users_identity_check CHECK (
    (github_user_id IS NOT NULL AND github_login IS NOT NULL) OR (suite_sub IS NOT NULL AND display_name IS NOT NULL)
);

-- The suite organization (its alias) whose people join this workspace with the role their token gives; set by an admin
-- of the workspace. One workspace per organization, so a token never names two.
ALTER TABLE tenants ADD COLUMN suite_organization text
    CHECK (suite_organization IS NULL OR suite_organization ~ '^[a-z0-9][a-z0-9._-]{0,62}$');
CREATE UNIQUE INDEX tenants_suite_organization_key ON tenants (suite_organization) WHERE suite_organization IS NOT NULL;
