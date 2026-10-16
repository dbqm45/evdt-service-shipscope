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
| D-LAUNCH-LAST | 2026-10-16 | Hosting (Render) wraca na koniec, razem z płatnościami, planami, kwestiami prawnymi i marketingiem | Najpierw dokończyć produkt; wdrożenie jest gotowe (render.yaml, instrukcja), a decyzje komercyjne (region, cennik, dostawca płatności) lepiej podjąć razem | accepted | użytkownik | context/foundation/prd.md (Deferred to the End), server/TESTY-RECZNE.pl.md (część B) |
| D-FLAG-LINKS | 2026-10-16 | Flaga łączy się z zadaniami Jiry z trzech miejsc naraz: ze źródła flag, z samej Jiry (pole „Feature flag” albo etykiety z przedrostkiem, do wyboru per workspace) i ręcznie w ShipScope | Pole w Jirze (pomysł użytkownika) jest najwygodniejsze dla zespołu, ale wymaga admina Jiry; etykiety działają bez niego, a ręczne i ze źródła pokrywają resztę przypadków | accepted | użytkownik + claude | server/SETUP.pl.md §4, context/foundation/prd.md (Open Question 1) |
| D-SYNC-FAIRNESS | 2026-10-16 | Synchronizacje sprawiedliwe między workspace'ami: najdłużej czekający pierwszy, budżet czasu na workspace w przebiegu (domyślnie 120 s), limit zapytań wstrzymuje tylko tę instalację GitHub / połączenie z Jirą | Przy wielu klientach jeden duży workspace albo wyczerpany limit nie może wstrzymywać pozostałych; limity GitHuba są per instalacja, Atlassiana per aplikacja i witryna | accepted | claude (punkt 1 zaakceptowany przez użytkownika) | context/foundation/prd.md (Open Questions 2–3), server/README.md |
