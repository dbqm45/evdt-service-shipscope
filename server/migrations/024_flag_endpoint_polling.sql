-- Polling endpoint sources (ADR-003 point 4, ROADMAP increment 4): the worker's flags tick (worker.js flagsTick(),
-- lib/flag-poll.js) reads each endpoint source when `next_poll_at` is due, every `poll_interval_minutes` (null = the
-- default, lib/flags-logic.js POLL) with jitter, backing off after consecutive failures (`poll_failures`).
ALTER TABLE flag_sources
    ADD COLUMN poll_interval_minutes integer CHECK (poll_interval_minutes BETWEEN 2 AND 1440),
    ADD COLUMN next_poll_at timestamptz,
    ADD COLUMN last_polled_at timestamptz,
    ADD COLUMN poll_failures integer NOT NULL DEFAULT 0 CHECK (poll_failures >= 0);

-- Opening a dashboard asks for a fresh read of the tenant's endpoint sources: a `flags` request keyed by tenant id.
ALTER TABLE sync_requests DROP CONSTRAINT sync_requests_source_check;
ALTER TABLE sync_requests ADD CONSTRAINT sync_requests_source_check CHECK (source IN ('github', 'jira', 'flags'));
