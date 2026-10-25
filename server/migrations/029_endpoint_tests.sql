-- "Test" of a saved endpoint source whose token only the worker can open (lib/sealed-box.js): the web service queues
-- the test here and in sync_requests (`endpoint-test`, keyed `<tenant>/<id>`), the worker runs it within seconds and
-- writes the parsed flags per environment into `result` (never the answer itself), and Settings reads it back. Old
-- rows are removed when new ones are queued.
CREATE TABLE endpoint_tests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    source_id       uuid NOT NULL,
    endpoint_config jsonb NOT NULL,
    requested_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    requested_at    timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    result          jsonb,
    FOREIGN KEY (tenant_id, source_id) REFERENCES flag_sources (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE endpoint_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE endpoint_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY endpoint_tests_tenant_all ON endpoint_tests
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE sync_requests DROP CONSTRAINT sync_requests_source_check;
ALTER TABLE sync_requests ADD CONSTRAINT sync_requests_source_check CHECK (source IN ('github', 'jira', 'flags', 'endpoint-test'));
