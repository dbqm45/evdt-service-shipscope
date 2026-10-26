-- Lead time from the report (F5 of the pdi one-flow plan, pdi docs/plan-f5-lead-time-prb.md): the day the problem a
-- change came from was reported, `source_reported_at` in its intent.md header (pdi contract 0.5.0, written by tf when
-- pdi accepts the problem). Insights' "report → PROD" starts there. Null for tasks and for older changes.
ALTER TABLE work_items ADD COLUMN source_reported_at date;
