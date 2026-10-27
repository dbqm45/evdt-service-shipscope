# Czas przepływu zmian i cięć (krok 1 luki G3)

Stan: 2026-10-27. Luka G3 z mapy ekosystemu SDLC po decyzji D-E1 (pdi, 25.10): prognozę „kiedy to będzie” liczy
automat (liczba cięć z planu tf × historyczny czas przepływu z ShipScope), a sprintdeck głosuje nad ryzykiem
i zrozumieniem. Kalibracja prognozy potrzebuje rzeczywistego czasu przepływu. Ten krok daje go w API usług (#119, zrobione).
Prognoza i jej porównanie z wynikiem to krok 2, zrobiony w pdi (dbqm45/pdi#37: przy „Approve for implementation”
liczba cięć z `/changes` × mediana dni na cięcie z `/flow`); pokazanie w pokoju sprintdecka przyjdzie po jego MVP.

## Co
1. **Pierwszy commit elementu.** Synchronizacja wdrożeń już czyta commity zakresu każdego wdrożenia (porównanie
   z poprzednim udanym na tym środowisku, a dla pierwszego — commit wdrożenia). Z ich dat autora
   (`commit.author.date`, sprawdzanych jak każde pole z GitHuba) bierze najwcześniejszą datę commita każdego klucza
   (`firstCommitDates()` w `lib/deployment-logic.js`, czyste) i zapisuje ją w `issue_deployments.first_commit_at`
   (migracja `048`). Wiersz zapisany wcześniej bez daty dostaje ją przy pierwszym wdrożeniu, które ją zna; starsza
   data nigdy nie ustępuje nowszej. Wiersze sprzed migracji nie mają daty, więc czas przepływu jest od teraz.
2. **Model** (`lib/flow-model.js`, czysty): dla każdego klucza najwcześniejszy pierwszy commit (wszystkie
   środowiska i repozytoria) i pierwsze wdrożenie na PROD; czas przepływu w dniach (z jedną cyfrą po przecinku, nigdy
   ujemny). Zmiana z repo jest **dostarczona**, gdy każde jej cięcie (bez `dropped`) ma pierwsze wdrożenie na PROD:
   jej czas to od najwcześniejszego pierwszego commita cięć do ostatniego z ich wejść na PROD. Mediany osobno dla
   elementów i dla zmian.
3. **API usług:** `GET /api/service/v1/flow?from&to` (te same zasady zakresu co `/metrics`: domyślnie 90 dni, najwyżej
   400, daty `YYYY-MM-DD` UTC) zwraca elementy, które pierwszy raz trafiły na PROD w zakresie (`key`, `kind`:
   `task`/`change`/`issue`, `parentKey`, `firstCommitAt`, `firstProdAt`, `flowDays`), dostarczone w zakresie zmiany
   (`key`, `tasks`, `startedAt`, `deliveredAt`, `flowDays`) i podsumowanie (`itemFlowDaysMedian`, `itemCount`,
   `changeFlowDaysMedian`, `changeCount`, `tasksPerChangeMedian`). Wymaga połączenia z pdi, jak reszta API usług.

## Testy (najpierw czerwone)
`deployment-logic.test.js`: `firstCommitDates()` (najwcześniejsza data klucza, zła i brakująca data pominięte).
`deployments.test.js`: synchronizacja zapisuje `first_commit_at` z porównania i z pojedynczego commita, uzupełnia
brak, nie nadpisuje starszej daty. `flow-model.test.js`: czas elementu, zmiana dostarczona i niedostarczona, mediany.
`service-api.test.js`: `/flow` z zakresem, bez połączenia 404, zły zakres 400.
