-- Metrics (GET /metrics, lib/metrics.js). worker_status listed only the jobs of 020, so the flags (024) and secrets
-- (027) jobs could never be recorded and /health/worker read flags as never run; any job name is taken now. Each row
-- also keeps the last run's duration and how many runs and failures there were, for counters; the `sources` job
-- (lib/flags.js flagSourceHealth()) keeps the flag sources' totals across tenants in `details` (counts only).
ALTER TABLE worker_status DROP CONSTRAINT worker_status_job_check;
ALTER TABLE worker_status ADD CONSTRAINT worker_status_job_check CHECK (job ~ '^[a-z-]{1,40}$');
ALTER TABLE worker_status
    ADD COLUMN last_duration_ms integer CHECK (last_duration_ms >= 0),
    ADD COLUMN runs_total bigint NOT NULL DEFAULT 0,
    ADD COLUMN failures_total bigint NOT NULL DEFAULT 0;
