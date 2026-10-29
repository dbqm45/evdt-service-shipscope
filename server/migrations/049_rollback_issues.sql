-- Which issues a rollback took off its environment (design-docs/ROLLBACK-STATUS-PLAN.pl.md): the keys of the commits
-- between the new, older ref and the one deployed before. The never-trimmed index remembers it until a later deploy
-- brings the key back; first_deployed_at and first_commit_at stay as they are (lead and flow times).
ALTER TABLE deployments ADD COLUMN rolled_back_issues text[] NOT NULL DEFAULT '{}';
ALTER TABLE issue_deployments ADD COLUMN rolled_back_at timestamptz;
