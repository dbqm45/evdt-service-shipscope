-- An explicit environment map per tracked repo (ADR-003 point 5, ROADMAP increment 3): which GitHub environment is
-- test, qa or prod, or skipped. A name the map doesn't list still goes through the default rule (mapEnvironment()),
-- so an empty map changes nothing. `seen_environments` keeps the GitHub environment names the sync came across
-- (skipped ones included), so Settings can show what there is to map.
ALTER TABLE tracked_repos
    ADD COLUMN env_map jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN seen_environments text[] NOT NULL DEFAULT '{}';
