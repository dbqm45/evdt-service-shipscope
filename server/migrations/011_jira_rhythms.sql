-- Teams work in different rhythms, side by side in one tenant (decision 2026-10-16: the app has to handle every way of
-- working, not only SAFe). Per board:
--   rhythm:      'pi'     -- SAFe: the increment is a PI read from sprint names (default "27.3.1" -> PI-27.3, or the
--                            admin's pi_template);
--                'sprint' -- plain Scrum: every sprint is its own increment;
--                'auto'   -- 'pi' when the board's sprint names follow the PI naming, else 'sprint'.
--   pi_template: the admin's PI naming, e.g. "PI {pi} / Iteration {n}" (lib/jira-model.js compileTemplate()).
--   current_increment: the board's current increment as of its last sync; the dashboard's "Now" view joins them.
ALTER TABLE jira_boards
    ADD COLUMN rhythm text NOT NULL DEFAULT 'auto' CHECK (rhythm IN ('auto', 'pi', 'sprint')),
    ADD COLUMN pi_template text,
    ADD COLUMN current_increment text;

-- What kind of increment a jira_pis row is ('pi' or 'sprint'), for the dashboard's labels and grouping.
ALTER TABLE jira_pis
    ADD COLUMN kind text NOT NULL DEFAULT 'pi' CHECK (kind IN ('pi', 'sprint'));
