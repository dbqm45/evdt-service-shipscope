-- Status of each flag source, for Settings -> Feature flags: when its last message was accepted and what it did, and
-- the last message it had refused, with the reason. A team setting up a sender (adapters/flags/, ONBOARDING.md)
-- sees there whether its messages arrive and why one was turned down, without access to the sender's logs.
-- A message with an unknown token belongs to no source and is not recorded.
ALTER TABLE flag_sources ADD COLUMN last_ingest_at timestamptz;
-- { flags, changed, removed, stale } of that message, as the ingest answered it.
ALTER TABLE flag_sources ADD COLUMN last_ingest jsonb;
ALTER TABLE flag_sources ADD COLUMN last_error text;
ALTER TABLE flag_sources ADD COLUMN last_error_at timestamptz;
