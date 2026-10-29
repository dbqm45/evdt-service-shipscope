-- A QA or PROD deploy of a version the stage before (test, QA) never had a successful deploy of: the stage it skipped,
-- judged when the deploy is synced (later the earlier stage's records may be gone with retention). Null otherwise.
ALTER TABLE deployments ADD COLUMN skipped_env text CHECK (skipped_env IN ('test', 'qa'));
