-- flag_value_history is trimmed daily to the tenant's retention (tenants.deployment_retention_days, lib/retention.js
-- cleanupFlagHistory()), keeping each source/flag/environment's latest change. This index serves that "latest" lookup.
CREATE INDEX flag_value_history_latest_idx ON flag_value_history (tenant_id, source_id, key, environment, changed_at DESC, id DESC);
