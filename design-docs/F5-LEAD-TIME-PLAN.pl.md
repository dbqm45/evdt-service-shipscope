# F5 — lead time od intencji i od zgłoszenia (ShipScope)

Stan: 2026-10-26. Krok z planu jednego flow (dbqm45/pdi `docs/plan-jeden-flow-sdlc.md` §6, F5; tabela zmian:
„Lead time od zgłoszenia — Insights: PRB utworzone → wydane na prod (daty z pdi)”).

## Decyzja właściciela (2026-10-26)
Daty utworzenia PRB ShipScope nie ma skąd wziąć: pdi nie trzyma jeszcze zgłoszeń (F3) i nie ma API odczytu, a kontrakt
0.4.0 nie przenosi tej daty ani w zdarzeniu, ani w nagłówku `intent.md`. Dlatego **teraz liczymy od intencji**: od pola
`created` nagłówka `intent.md` zmiany (dzień założenia intencji, `decision_record.py change new` w tf) do jej
pierwszego udanego wdrożenia na PROD. Miara „od PRB” dojdzie z F3, gdy pdi będzie trzymało zgłoszenia i ich daty.

## Co
1. **Worker.** `buildWorkItems()` bierze `created` z nagłówka intencji (tylko `RRRR-MM-DD`), migracja
   `042_work_item_intent_created.sql`: `work_items.intent_created date`; `WORK_ITEMS_VERSION` = 3 (ponowny odczyt).
2. **Dane.** `workItemIssues()` daje zmianie `intentCreated` (`RRRR-MM-DD` albo `null`).
3. **Insights.** Panel „Lead time: intent → PROD” (`#chartIntentLeadTime`): `leadTimeFromIntent()` — zmiany przyrostu
   z `intentCreated` i wdrożeniem na PROD (`earliestProdDeployedAt()`, czyli też przez ich cięcia), dni od intencji do
   pierwszego PROD (ujemne → 0), najnowsze pierwsze, najwyżej 12, z medianą w nagłówku wykresu. Jak inne wykresy
   Insights czyta załadowany przyrost, więc pokazuje zmiany przy wybranym „Changes (repo)”; inaczej komunikat, co
   wybrać.

## Testy (najpierw czerwone)
`server/test/work-items.test.js`: `created` z nagłówka (zły format → null), `intentCreated` w `workItemIssues()`, kolumna
na prawdziwym Postgresie i wersja 3. `test/frontviews-release-insights.test.js`: `leadTimeFromIntent()` (dni, przycięcie
do 0, pominięte bez daty i bez PROD, kolejność, limit), render z medianą i pusty stan. `test/frontend-render.test.js`:
nowy panel w `docs/index.html`. Do tego `migrate`.

## Od zgłoszenia (2026-10-26, druga część)
Decyzja właściciela: data zgłoszenia jedzie w nagłówku zmiany. Kontrakt pdi 0.5.0 (dbqm45/pdi#26) dodaje opcjonalne
`source_reported_at` do `change.schema.json`; pdi przy przyjęciu PRB podaje ją fazie intent, tf (`decision_record.py
change new --source-reported-at`) zapisuje ją w nagłówku `intent.md`.

1. **Worker.** `buildWorkItems()` bierze `source_reported_at` (tylko `RRRR-MM-DD`), migracja
   `043_work_item_source_reported.sql`: `work_items.source_reported_at date`; `WORK_ITEMS_VERSION` = 4.
2. **Dane.** Zmiana w `workItemIssues()` dostaje `sourceKey` (np. `PRB-3`) i `sourceReportedAt`.
3. **Insights.** Panel „Lead time: report → PROD” (`#chartReportLeadTime`): `leadTimeFromReport()` liczy tak samo jak
   od intencji (wspólne `leadTimeFrom(field)`), tylko od dnia zgłoszenia; zmiany bez tej daty (starsze, pomysły bez
   problemu) pominięte; w podpowiedzi słupka klucz zgłoszenia.

Testy: `work-items.test.js` (pole z nagłówka, kolumna, wersja 4, `sourceReportedAt`), `frontviews-release-insights`
(`leadTimeFromReport()`, render, pusty stan), `frontend-render` (panel), `migrate`.
