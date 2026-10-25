# F1 — elementy pracy z repo w ShipScope

Plan części ShipScope fazy F1 z planu jednego flow w repo `dbqm45/pdi` (`docs/plan-jeden-flow-sdlc.md` §7, §8 F1;
kontrakt 0.4.0: `change.schema.json`, `task.schema.json`). Gdy faza się skończy, ShipScope pokazuje „CHG-12: Deployed
(hidden) na PROD” bez Jiry i bez pdi.

**Poza zakresem:** tryb repo planu wydania (`release.yaml`, G1.3, osobny PR po tym), zdarzenia `feature.released`
(F5), API dla usług (F5), release notes z `intent.md` (F5) i zmiany kontraktu pdi.

## Format, który czytamy

- Katalog `docs/project/changes/<CHG>/` w domyślnej gałęzi śledzonego repo, czytany przez GitHub Contents API (Git
  Trees i Contents, uprawnienie `contents: read` już jest).
- Pliki `intent.md` i `plan.md` mają nagłówek „prosty YAML” (`---` … `---`) według `change.schema.json`: `artifact`,
  `status`, `change`, `source`, w `plan.md` `tasks`. `change` musi być równe nazwie katalogu.
- Tytuł zmiany to pierwszy nagłówek `# ` w `intent.md` (bez niego: klucz).
- Tytuł i status cięcia: kontrakt nie ustala formatu treści `plan.md` (szablon jest w tf). Czytamy więc pierwszą
  linię treści z kluczem cięcia:
  - w wierszu tabeli tytułem jest pierwsza niepusta komórka po kluczu, która nie jest statusem ani linią wydania;
  - w liście albo nagłówku tytułem jest tekst po kluczu;
  - status to komórka albo słowo z `task.schema.json` (`planned`, `in_progress`, `in_review`, `done`, `dropped`).
  - Cięcie `dropped` nie jest pokazywane.
- Zły plik (brak nagłówka, `change` niezgodne z katalogiem, zły klucz) daje widoczny błąd syncu repo
  (`tracked_repos.work_items_error`, Settings → GitHub), a pozostałe zmiany czytamy dalej.

## Pliki i kolejność

1. **Migracja `037_work_items.sql`:**
   - `tracked_repos.work_items_ref` (sha, przy którym ostatnio czytano) i `work_items_error`;
   - tabela `work_items (tenant_id, item_key, kind change|task, parent_key, repo_id, title, status, source_key, path, ref,
     synced_at)` z RLS, w `RLS_TABLES`, kaskadą z `tracked_repos` (odśledzenie repo usuwa jego elementy) i z `tenants`.
2. **`lib/work-items-model.js` (czyste):** `parseFrontMatter()`, `planTasks()`, `buildWorkItems()` (pliki → elementy +
   błędy), `workItemIssues()` (elementy → kształt issue dashboardu: CHG jako Epic z `subtaskKeys` = jego TSK, TSK
   jako Story z `epicKey` = CHG), `CHANGES_KEY = '@changes'`.
3. **`lib/work-items.js` (I/O):** `refreshWorkItems()` po syncu repo, wywoływane z `syncRepo()` po flagach z kodu:
   - najnowszy commit dotykający `docs/project/changes` (`commits?path=…&per_page=1`);
   - gdy różni się od `work_items_ref`: drzewo tego commita, pliki, pełna podmiana elementów repo w jednej transakcji;
   - limit rate jest rzucany dalej, każdy inny błąd jest zapisywany i nie psuje syncu.

   Do tego `readWorkItems()` dla dashboardu.
4. **Hierarchia CHG → TSK:** commit z `Change: TSK-57` liczy się dla CHG-12 przez `subtaskKeys` (istniejące
   `issueKeys()`, bez zmian we frontendzie).
5. **Grupowanie po zmianach:**
   - nowy rytm: wpis `{ pi: '@changes', kind: 'change', label: 'Changes (repo)' }` w `jiraIndex`, także bez Jiry;
   - `GET /api/tenants/:id/jira-issues?pi=@changes` zwraca elementy w kształcie issue, a widok produktowy grupuje TSK
     pod CHG jak pod epikiem;
   - `issueStatusIndex` obejmuje elementy, a `workItemUrls` (klucz → link do pliku na GitHubie) prowadzi z klucza
     do pliku zamiast do Jiry (`jiraIssueUrl()`).
6. **Flagi z kluczami zmian:**
   - `schemaVersion: 2` dostaje opcjonalne `flags[].itemKeys` (ogólna nazwa, ten sam kształt klucza), scalane z
     `jiraKeys`;
   - schemat i `ONBOARDING.md` zaktualizowane.
   - Dopisek `Flag:` z commitów jest już od G1.3.
7. **Dokumentacja:** CLAUDE.md, `server/README.md`, FAQ, ROADMAP.

## Testy (najpierw czerwone)

| Test | Plik |
|---|---|
| nagłówek, tytuł z `intent.md`, cięcia z tabeli i z listy, status, `dropped` pominięte; zły nagłówek albo `change` ≠ katalog = błąd | `server/test/work-items.test.js` |
| sync z fałszywego GitHuba: elementy zapisane, drugi przebieg bez zmian nie czyta plików, zmiana pliku podmienia, zły plik = `work_items_error`, odśledzenie repo usuwa elementy | `server/test/work-items.test.js` |
| izolacja RLS `work_items`; usunięcie workspace'u ją czyści | `server/test/work-items.test.js`, `tenant-delete.test.js` |
| dashboard: wpis `@changes` w indeksie bez Jiry, `jira-issues?pi=@changes`, commit `Change: TSK-57` daje CHG-12 status na PROD przez prawdziwy `docs/app-model.js` | `server/test/dashboard-contract.test.js` albo `work-items.test.js` |
| ingest: `itemKeys` łączy się z `jiraKeys`; nieznane pole nadal 400 | `server/test/flags.test.js` |
| frontend: `jiraIssueUrl()` woli `workItemUrls` | `test/frontmodel-core-data.test.js` |
