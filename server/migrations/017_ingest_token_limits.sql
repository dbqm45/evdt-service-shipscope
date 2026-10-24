-- Ingest tokens that expire and that may be limited to some environments (ADR-003, ROADMAP increment 0).
-- Both NULL for the tokens issued before: no expiry, every environment, so no sender stops working.
ALTER TABLE ingest_tokens
    ADD COLUMN expires_at   timestamptz,
    ADD COLUMN environments text[]
        CHECK (environments IS NULL OR (cardinality(environments) > 0 AND environments <@ ARRAY['test', 'qa', 'prod']));
