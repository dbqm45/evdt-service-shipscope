-- When each item's first commit was authored, from the commits the deployment sync already reads (G3 step 1,
-- design-docs/G3-FLOW-TIME-PLAN.pl.md): with first_deployed_at on PROD it gives the item's flow time. Rows written
-- before this migration have none.
ALTER TABLE issue_deployments ADD COLUMN first_commit_at timestamptz;
