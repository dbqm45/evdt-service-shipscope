-- Fair syncs across tenants (prd.md Open Questions 2 and 3). The worker's passes used to walk tenants oldest-first
-- with no limit per tenant, so one tenant with a large backlog -- or one whose GitHub/Jira budget ran out -- made
-- everyone after it wait. Now each pass starts with whoever waited longest, gives each tenant a time budget, and
-- pauses only the credential a rate limit was billed to.

-- When a repo/connection was last tried (success or not): the pass goes to the longest-waiting first. A repo that
-- keeps failing no longer stays at the front, as it would if ordered by the last success.
ALTER TABLE tracked_repos ADD COLUMN last_attempt_at timestamptz;
ALTER TABLE jira_connections ADD COLUMN last_attempt_at timestamptz;

-- Until when GitHub (per App installation, its rate-limit bucket) or Atlassian (per tenant grant) asked us to wait.
-- Syncs of that installation/connection are skipped until then; nothing else is.
ALTER TABLE github_installations ADD COLUMN rate_limited_until timestamptz;
ALTER TABLE jira_connections ADD COLUMN rate_limited_until timestamptz;

-- A board's last complete sync: when a tenant's time budget runs out between boards, the next pass starts with the
-- boards that waited longest, so a large board can't keep the others from ever syncing.
ALTER TABLE jira_boards ADD COLUMN last_synced_at timestamptz;
