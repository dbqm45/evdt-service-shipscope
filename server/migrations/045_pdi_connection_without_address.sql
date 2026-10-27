-- Workspaces that used the service API before the connection with pdi existed get a pending connection
-- (lib/pdi-connection.js backfillPdiConnections()); one with a service token but no event subscription has no
-- receiver address until an admin connects it properly.
ALTER TABLE pdi_connections ALTER COLUMN receiver_url DROP NOT NULL;
