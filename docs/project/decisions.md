---
artifact: decisions
phase: meta
status: accepted
version: 1
author: system
created: 2026-10-15
updated: 2026-10-15
inputs: []
---
# Rejestr decyzji

| ID | Data | Decyzja | Uzasadnienie (1 zdanie) | Status | Autor | Szczegóły |
|---|---|---|---|---|---|---|
| D-FLAGS-PUSH | 2026-10-16 | Flagi trafiają do ShipScope z zewnątrz (push przez API z tokenem per repo), ShipScope ich nie odczytuje | Każdy trzyma flagi inaczej (build-time, runtime API, usługa 3rd party albo wcale), więc tylko system tenanta wie, skąd je wziąć | accepted | użytkownik | context/foundation/prd.md (Open Question 1), server/SETUP.pl.md §4 |
| D-JIRA-OAUTH | 2026-10-16 | Jira łączona przez pełne OAuth 2.0 (3LO) Atlassiana, nie token API | Dla użytkownika ma być skutecznie, szybko i prosto: jedno kliknięcie zamiast tworzenia i wklejania tokenu | accepted | użytkownik | context/foundation/prd.md (FR-007) |
