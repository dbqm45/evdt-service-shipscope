-- Webhooks: GitHub (a deployment's status changed) and Jira (an issue changed) ask for a sync instead of waiting
-- up to SYNC_INTERVAL_MINUTES. The web service only verifies a delivery and records what it is about; the worker
-- drains these every 30 seconds with a sync of just that repo or Jira connection (worker.js webhookTick()).
--
-- Not tenant data and so not under RLS: a row names a GitHub repo id or a Jira webhook id / site, never a tenant
-- (the web service can't know which tenants track a repo without reading across them). The worker, which already
-- walks every tenant under its own scope, matches them. One row per thing to sync: repeated deliveries coalesce.
CREATE TABLE sync_requests (
    source       text NOT NULL CHECK (source IN ('github', 'jira')),
    external_key text NOT NULL CHECK (length(external_key) BETWEEN 1 AND 300),
    requested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, external_key)
);

-- The Jira webhook ShipScope registered for the tenant's connection (dynamic webhooks expire after 30 days and are
-- refreshed by the sync), the JQL it filters on (the selected boards' projects), and why registering failed.
ALTER TABLE jira_connections
    ADD COLUMN webhook_ids bigint[] NOT NULL DEFAULT '{}',
    ADD COLUMN webhook_jql text,
    ADD COLUMN webhook_expires_at timestamptz,
    ADD COLUMN webhook_error text;
