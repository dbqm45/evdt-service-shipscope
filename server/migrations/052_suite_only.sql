-- Step 3 of the suite sign-in (design-docs/SUITE-LOGIN-PLAN.pl.md): a workspace linked to a suite organization can turn
-- off GitHub sign-in. Accounts signed in through GitHub keep their memberships but are refused while it is on.
ALTER TABLE tenants ADD COLUMN suite_only boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD CONSTRAINT tenants_suite_only_needs_organization CHECK (NOT suite_only OR suite_organization IS NOT NULL);
