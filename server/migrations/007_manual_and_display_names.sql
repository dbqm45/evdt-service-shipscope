-- The last two deployment fields the file-based sync has (scripts/sync-github-deployments.js):
--   manual          - whether the GitHub Actions run behind the deploy was started by hand (workflow_dispatch);
--                     NULL when unknown (no run link, the App lacks Actions read access, or the lookup failed).
--   deployed_by_name - the creator's public GitHub display name, resolved once at sync time; NULL when they
--                     have none (the dashboard then shows the login).
ALTER TABLE deployments
    ADD COLUMN manual boolean,
    ADD COLUMN deployed_by_name text;
