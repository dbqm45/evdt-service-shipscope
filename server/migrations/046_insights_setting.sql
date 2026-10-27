-- Insights is a workspace setting (design-docs/CORE-SIMPLIFY-PLAN.pl.md, D2) instead of only ?insights=1 in the address.
ALTER TABLE tenants ADD COLUMN insights_enabled boolean NOT NULL DEFAULT false;
