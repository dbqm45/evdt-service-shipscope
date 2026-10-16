-- Two more rhythms (decision 2026-10-16: the app has to handle every way of working): teams that ship by release and
-- Kanban teams without sprints.
--   'release' -- the increment is a version of the board's project (fixVersion), named "<project key> <version>";
--   'flow'    -- the increment is a calendar month ("Flow 2026-10"): issues resolved in it, and while it is the
--                current month, everything in progress. Kanban boards can now be selected; 'auto' picks 'release' or
--                'flow' for a board without sprints (lib/jira-model.js rhythmOf()).
ALTER TABLE jira_boards DROP CONSTRAINT jira_boards_rhythm_check;
ALTER TABLE jira_boards ADD CONSTRAINT jira_boards_rhythm_check CHECK (rhythm IN ('auto', 'pi', 'sprint', 'release', 'flow'));

ALTER TABLE jira_pis DROP CONSTRAINT jira_pis_kind_check;
ALTER TABLE jira_pis ADD CONSTRAINT jira_pis_kind_check CHECK (kind IN ('pi', 'sprint', 'release', 'flow'));
