-- Release notes from the intent (F5 of the pdi one-flow plan, design-docs/F5-RELEASE-NOTES-PLAN.pl.md): a change's
-- `## Problem` from its intent.md (lib/work-items-model.js intentProblem()), which the Delivery summary shows instead
-- of its tickets' titles. Null for tasks and for a change without the section.
ALTER TABLE work_items ADD COLUMN problem text CHECK (problem IS NULL OR length(problem) <= 600);
