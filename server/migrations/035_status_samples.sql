-- The public status page (GET /status, lib/status-page.js): once a minute the web service judges the worker
-- (judgeWorker()) and counts the outcome per component and day. Not tenant data, so not under RLS, like
-- worker_status (020). Days older than STATUS_DAYS_KEPT are deleted by the sampler.
CREATE TABLE status_samples (
    day       date NOT NULL,
    component text NOT NULL CHECK (component ~ '^[a-zA-Z]{1,40}$'),
    ok        integer NOT NULL DEFAULT 0 CHECK (ok >= 0),
    degraded  integer NOT NULL DEFAULT 0 CHECK (degraded >= 0),
    down      integer NOT NULL DEFAULT 0 CHECK (down >= 0),
    PRIMARY KEY (day, component)
);
