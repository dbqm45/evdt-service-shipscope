-- Lead time from the intent (F5 of the pdi one-flow plan, design-docs/F5-LEAD-TIME-PLAN.pl.md): the `created` date of
-- a change's intent.md header, where Insights' "intent → PROD" starts. Not yet the PRB's date: pdi keeps no problems
-- until F3. Null for tasks and for a change without an intent date.
ALTER TABLE work_items ADD COLUMN intent_created date;
