-- The audit log covers every settings change, not only secrets (lib/audit-log.js): members and invitations, the
-- GitHub connection and tracked repositories, flag sources and their tokens, flags' hand-set details, Jira's site,
-- boards and flag convention, the workspace's retention. secret_events becomes audit_events with its rows kept; the
-- list of kinds moves to the code (AUDIT_EVENT_KINDS), so a new kind needs no migration.
ALTER TABLE secret_events RENAME TO audit_events;
ALTER INDEX secret_events_tenant_at RENAME TO audit_events_tenant_at;
ALTER POLICY secret_events_tenant_all ON audit_events RENAME TO audit_events_tenant_all;
ALTER TABLE audit_events DROP CONSTRAINT secret_events_kind_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_kind_check CHECK (kind ~ '^[a-z_]{1,40}$');
