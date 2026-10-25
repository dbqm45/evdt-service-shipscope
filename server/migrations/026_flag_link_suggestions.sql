-- Suggested flag -> issue links (ADR-003, ROADMAP increment 5): when a deployment changes a flag in a flags file read
-- from code, the Jira keys in the messages of the commits that touched that file are suggested for the flag
-- (lib/flag-link-suggestions.js). An admin links one (it joins manual_jira_keys) or dismisses it (never suggested
-- again for that flag).
ALTER TABLE flags
    ADD COLUMN suggested_jira_keys text[] NOT NULL DEFAULT '{}',
    ADD COLUMN dismissed_jira_keys text[] NOT NULL DEFAULT '{}';
