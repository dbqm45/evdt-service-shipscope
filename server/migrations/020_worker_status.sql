-- What the worker last did, for GET /health/worker and whoever runs ShipScope (ROADMAP increment 2, monitoring).
-- One row per job (heartbeat, deployments, jira, webhooks, cleanup): when it last ran, when it last succeeded, the
-- last error and a small summary (counts only). Not tenant data and so not under RLS, like sync_requests (013):
-- the web service reads it without a tenant scope.
CREATE TABLE worker_status (
    job           text PRIMARY KEY CHECK (job IN ('heartbeat', 'deployments', 'jira', 'webhooks', 'cleanup')),
    last_run_at   timestamptz NOT NULL,
    last_ok_at    timestamptz,
    last_error    text,
    last_error_at timestamptz,
    details       jsonb NOT NULL DEFAULT '{}'
);
