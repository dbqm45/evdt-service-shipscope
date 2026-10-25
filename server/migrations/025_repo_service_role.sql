-- A tracked repo's role (ADR-003 point 3, ROADMAP increment 5): `frontend` or `backend`, set by an admin; null = not
-- said. The dashboard reads it as componentsOrder[].serviceType (FE/BE) and warns when an issue's flag is on in a
-- frontend while the backend it needs has it off or lacks the code ("FE on, BE off").
ALTER TABLE tracked_repos ADD COLUMN service_role text CHECK (service_role IN ('frontend', 'backend'));
