-- Flags in code (ADR-003, ROADMAP increment 3): a flag source ShipScope reads itself, from a file in one tracked
-- repository at the commit each environment last deployed successfully. `origin` tells it from a pushed source;
-- `code_config` says where the file is and how to read it (lib/code-flags.js), e.g.
-- { "file": "config/flags.{env}.json", "path": "features", "envNames": { "prod": "production" } }.
ALTER TABLE flag_sources
    ADD COLUMN origin text NOT NULL DEFAULT 'push' CHECK (origin IN ('push', 'code')),
    ADD COLUMN code_config jsonb,
    ADD CONSTRAINT flag_sources_code_config CHECK ((origin = 'code') = (code_config IS NOT NULL));

-- The ref a code source last read for an environment: a pass reads the file again only when that environment's
-- latest successful deployment changed (or the last read failed, which leaves it as it was).
ALTER TABLE flag_source_envs ADD COLUMN last_ref text;
