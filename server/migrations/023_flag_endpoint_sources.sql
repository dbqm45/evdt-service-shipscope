-- Flags from an endpoint (ADR-003, ROADMAP increment 4): a runtime flag source ShipScope polls itself, at an https
-- address per environment the customer gives (lib/endpoint-flags.js, through lib/safe-fetch.js), e.g.
-- { "urls": { "prod": "https://flags.acme.io/api/flags?env=prod" }, "path": "features" }.
-- `endpoint_token_enc` is the customer's read-only token, sealed by lib/secret-box.js and bound to the tenant, the
-- source and its purpose; it is never returned by any route.
ALTER TABLE flag_sources DROP CONSTRAINT flag_sources_origin_check;
ALTER TABLE flag_sources
    ADD CONSTRAINT flag_sources_origin_check CHECK (origin IN ('push', 'code', 'endpoint')),
    ADD COLUMN endpoint_config jsonb,
    ADD COLUMN endpoint_token_enc text,
    ADD CONSTRAINT flag_sources_endpoint_config CHECK ((origin = 'endpoint') = (endpoint_config IS NOT NULL)),
    ADD CONSTRAINT flag_sources_endpoint_token CHECK (origin = 'endpoint' OR endpoint_token_enc IS NULL);
