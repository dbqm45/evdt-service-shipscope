-- A push source may take GitHub Actions OIDC tokens instead of (or beside) its ingest tokens (lib/github-oidc.js,
-- lib/flags.js ingestWithOidc()): null = off; else { refs, environments }, checked by checkOidcConfig()
-- (lib/flags-logic.js). The trusted repositories are the source's own services (flag_source_repos), so only a
-- repository the workspace's GitHub installation covers can ever send.
ALTER TABLE flag_sources ADD COLUMN oidc_config jsonb;
