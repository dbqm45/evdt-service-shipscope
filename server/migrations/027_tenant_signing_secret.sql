-- Each workspace's secret for signing requests to its flag endpoints (lib/endpoint-flags.js), stored sealed
-- (lib/secret-box.js, bound to the tenant and its purpose) so it survives a rotation of TOKEN_ENCRYPTION_KEY. Until a
-- workspace first needs it, it is null; it is then filled with the value earlier versions derived from the key, so the
-- secret a customer already configured keeps working.
ALTER TABLE tenants ADD COLUMN endpoint_signing_secret_enc text;
