-- When the daily retention removed the pdi layer's data of a disconnected workspace, 30 days after the disconnect
-- (design-docs/PDI-DATA-RETENTION-PLAN.pl.md, decision D5). Connecting again clears it.
ALTER TABLE pdi_connections ADD COLUMN data_removed_at timestamptz;
