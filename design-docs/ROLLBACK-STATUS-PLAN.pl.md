# Status zadań po rollbacku

Stan: 2026-10-29. Z analizy US14 (EBO-17365): PROD wrócił 29.10 z v1.4.45 do v1.4.40 (ShipScope wykrył rollback),
a US14 dalej było „Code deployed” na PROD. Powód: `issueDeployedOnComponent()` (`docs/app-model.js`) szuka
*jakiegokolwiek* udanego wdrożenia z kluczem zadania, a potem wpisu w `issue_deployments`, który pamięta pierwsze
wdrożenie na zawsze. Nie patrzy, co jest na środowisku teraz.

## Co

1. **Zadania cofnięte przez rollback.** Gdy synchronizacja wykrywa rollback (porównanie z poprzednim udanym
   wdrożeniem na tym środowisku mówi `behind`), pyta GitHuba o odwrotny zakres (`compare/<nowy ref>...<poprzedni
   ref>`): commity, które były na środowisku, a których już nie ma. Ich klucze trafiają do
   `deployments.rolled_back_issues` (migracja `049`, `text[]`, domyślnie pusta). Błąd tego zapytania nie psuje
   synchronizacji (pusta lista, jak dziś).
2. **Pamięć „kiedyś wdrożono” wie o cofnięciu.** `issue_deployments.rolled_back_at` (ta sama migracja): udany
   rollback ustawia go dla cofniętych kluczy na tym środowisku i repo; późniejsze wdrożenie, które znowu zawiera
   klucz, czyści go. `first_deployed_at` i `first_commit_at` się nie zmieniają: lead time i czas przepływu dalej
   liczą od pierwszego wejścia na PROD.
3. **Dashboard-data** (addytywnie): rekord wdrożenia będącego rollbackiem ma `rolledBackIssues` (inne go nie mają), a
   `issueDeployments[klucz][env][komponent]` dostaje `rolledBackAt`, gdy jest ustawiony.
4. **Model** (`docs/app-model.js`): klucz jest na komponencie i środowisku, gdy jego najnowsze zdarzenie tam jest
   wdrożeniem (`relatedIssues`), a nie cofnięciem (`rolledBackIssues`); bez żadnego żywego rekordu decyduje
   `issueDeployments` bez `rolledBackAt`. Zadanie jest wdrożone, gdy którykolwiek z jego kluczy (własny lub
   sub-taska) jest. `issueDeployedOnComponent()`, `componentsReached()` i `anyDeploymentForIssue()` używają tej
   samej reguły, więc status, „?” i blokujące zadania liczą się tak samo. `earliestProdDeployedAt()` zostaje przy
   historii (pierwsze wejście na PROD).

Rollback, którego GitHub nie widzi jako `behind` (np. commity-wyzwalacze na gałęzi wdrożeniowej bez pliku wersji
ani payloadu), nie jest wykrywany — tak jak dziś; dlatego punkt 1 i 5 z
[WDROZENIA-W-REPO-APLIKACJI.pl.md](WDROZENIA-W-REPO-APLIKACJI.pl.md).

## Testy (najpierw czerwone)

- `test/frontmodel-model.test.js`: zadanie wdrożone na PROD, potem rollback z jego kluczem → `none`; ponowne
  wdrożenie → znowu wdrożone; sub-task cofnięty, a własny klucz nie → wdrożone; sam `issueDeployments` z
  `rolledBackAt` → `none`; `componentsReached()` bez cofniętego komponentu.
- `server/test/deployments.test.js`: rollback zapisuje `rolled_back_issues` z odwrotnego zakresu, ustawia
  `issue_deployments.rolled_back_at`; ponowne wdrożenie go czyści; dashboard-data niesie oba pola.
