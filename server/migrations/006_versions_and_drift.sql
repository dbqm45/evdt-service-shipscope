-- Version resolution and environment drift for synced deployments: the parts of the file-based sync
-- (scripts/sync-github-deployments.js) that 005 left out.

-- Per tracked repo, the same two settings docs/components.json carries per component:
--   version_file       - repo-relative path of a `version=<ref>` properties file (e.g. trigger.properties) for repos
--                        whose QA/PROD deploy trigger commits; the named tag/commit is what really shipped.
--   drift_ignore_paths - patterns of deployment plumbing (.github/, README.md, ...) not counted as a code
--                        difference between environments (lib/tree-diff.js has the pattern rules).
-- drift: per environment, how its latest successful deploy differs from the previous stage's
-- ({ qa: {...}, prod: {...} } in the shape the dashboard reads as `driftBehind`), plus `inputs` (the refs it was
-- computed from) and `failed` (environments whose comparison errored), so a pass only recomputes when a latest
-- deploy changed or the last attempt failed.
ALTER TABLE tracked_repos
    ADD COLUMN version_file text,
    ADD COLUMN drift_ignore_paths text[] NOT NULL DEFAULT '{}',
    ADD COLUMN drift jsonb NOT NULL DEFAULT '{}';

-- version: the label shown (release/tag name, versionFile value, or a version-like string from the commit
-- message); NULL when nothing better than the sha resolved. resolved_ref: the ref compares use -- a verified
-- release/tag name or a commit sha, never the free-text label. NULL on records synced before this migration.
ALTER TABLE deployments
    ADD COLUMN version text,
    ADD COLUMN resolved_ref text;
