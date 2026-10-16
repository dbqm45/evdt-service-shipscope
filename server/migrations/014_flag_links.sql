-- Linking flags to Jira work items from three places, shown together on the dashboard:
--   the sender's  -- flags.jira_keys / description, as an ingest message sets them (008);
--   manual        -- what an admin sets in ShipScope's settings, kept apart so a sender's next message never
--                    overwrites it (manual_description wins over the sender's description when set);
--   Jira's own    -- read from each synced issue (jira_issues.data.featureFlags) through the tenant's chosen
--                    convention, jira_connections.flag_link:
--                      {"type":"field","id":"customfield_10050","name":"Feature flag"}  a field on the issue, or
--                      {"type":"label","prefix":"flag:"}                                  labels like flag:newCheckout.
ALTER TABLE flags
    ADD COLUMN manual_description text,
    ADD COLUMN manual_jira_keys text[] NOT NULL DEFAULT '{}';

ALTER TABLE jira_connections
    ADD COLUMN flag_link jsonb;
