# F5 — release notes z intencji (ShipScope)

Stan: 2026-10-26, zrobione (PR w toku). Krok z planu jednego flow (dbqm45/pdi `docs/plan-jeden-flow-sdlc.md` §6, F5: „ShipScope:
release notes z intencji”; tabela zmian: „Delivery summary bierze tytuł i opis z `intent.md`, nie z ticketu —
notatki pisane językiem problemu”).

## Co
1. **Worker.** `buildWorkItems()` (`lib/work-items-model.js`) czyta z `intent.md` zmiany, oprócz tytułu (pierwszy
   nagłówek `# `), sekcję `## Problem` (`intentProblem()`): tekst do następnego nagłówka `## `, bez komentarzy HTML i
   bez wierszy-szablonów `<…>` z szablonu tf, białe znaki zwinięte, najwyżej 600 znaków; bez sekcji albo z samym
   szablonem → `null`. Migracja `041_work_item_problem.sql`: `work_items.problem text`. `WORK_ITEMS_VERSION` = 2, więc
   repozytoria przeczytane wcześniej są czytane ponownie przy następnym przebiegu.
2. **Dane.** `workItemIssues()` daje zmianie (Epic przyrostu „Changes (repo)”) pole `problem` (`null` bez sekcji);
   cięcia go nie mają.
3. **Delivery summary.** `releaseNotesModel()`: zmiana z `problem` (czyli z repo, z intencją) wydana na PROD zbiera
   swoje wydane cięcia (`epicKey`), które nie pokazują się już osobno: jedna pozycja z tytułem i opisem z intencji i
   listą cięć (`tasks`). Pozycje bez intencji (tickety Jiry, zmiana bez `## Problem`) — bez zmian. `DeliveryItem`
   dostaje `description` i `tasks`; „Copy as Markdown” dopisuje opis i cięcia w wierszach pod pozycją.

## Testy (najpierw czerwone)
`server/test/work-items.test.js`: `intentProblem()` (sekcja, szablon → null, brak sekcji, limit, komentarz HTML),
`buildWorkItems()` i `workItemIssues()` z `problem`; zapis i odczyt kolumny na prawdziwym Postgresie oraz ponowny odczyt
po zmianie wersji. `test/frontviews-release-insights.test.js`: zmiana z intencją i cięciami jako jedna pozycja (tytuł,
opis, cięcia, escapowane), cięcie zmiany bez intencji osobno, Markdown z opisem. Do tego `migrate`.

## Wynik (2026-10-26)
- Najpierw czerwone (2 w `work-items.test.js`, 2 w `frontviews-release-insights.test.js`), potem kod; testy główne
  282/282, `npm test` serwera 376/376 na prawdziwym Postgresie (z `migrate` dla `041`).
- `FALLBACK` bez zmian: nie ma przyrostu „Changes (repo)”, więc podgląd `file://` nie pokazuje nowej pozycji.
