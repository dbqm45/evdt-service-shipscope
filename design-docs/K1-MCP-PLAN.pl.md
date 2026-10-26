# K-1 — serwer MCP dla ShipScope

Stan: 2026-10-26. Krok K-1 z planu automatyzacji i konsoli (dbqm45/pdi `docs/plan-automatyzacja-i-konsola.md` §5.3,
fala 1 w kolumnie ShipScope): „Claude jako interfejs już teraz” — w Claude (Claude Code, Claude Desktop) człowiek
pyta o stan wydań obok serwera MCP pdi, bez nowego UI.

## Decyzje właściciela (2026-10-26)
- **Lokalny serwer stdio**, jak serwer pdi: `adapters/mcp/` w Node 20+, bez zależności (jak adapter flag), uruchamiany
  przez Claude; czyta API usług (F5) z tokenem usługi `shps_…`. Bez endpointu MCP w usłudze (nowa powierzchnia ataku).
- **API usług + nowe odczyty**: oprócz statusu elementu i metryk nowe trasy tylko do odczytu, żeby rozmowa widziała
  to, co dashboard: zmiany z repo, plan wydania, flagi, wersje i drift środowisk.

## Co
1. **Serwer (API usług v1, ten sam token, ten sam limit na token).** Każda trasa liczy przez prawdziwe `docs/app-*.js`
   w piaskownicy `lib/release-status.js`, więc mówi dokładnie to, co dashboard.
   - `GET /api/service/v1/changes` — zmiany z repo (`workItemIssues()`): klucz, tytuł, problem, źródło (PRB) i jego
     dzień, dzień intencji, status cięć, status per środowisko i pierwszy PROD; cięcia z ich statusem na PROD.
     Najnowsze (po numerze) pierwsze.
   - `GET /api/service/v1/release-plan` — `releasePlanModel()`: grupy (zmiana z `release.yaml` albo Epic w Jirze),
     linie R1…Rn z elementami i ich poziomem na PROD, `mvpReleased`, flagi z `flagPlanStatus()` (etap, dni w etapie,
     `overdue`) i `problems`.
   - `GET /api/service/v1/flags` — flagi (`flagsMeta`): opis, rodzaj, powiązane elementy, ekspozycja na PROD
     (`flagProdExposure()`), stan per środowisko i usługa (`flagStatesByComponent`), świeżość per usługa, ostrzeżenia
     z widoku flag (`flagStaleWarning()`, `flagBlastRadius()`). Nigdy wartości spoza tego, co pokazuje dashboard.
   - `GET /api/service/v1/environments` — per usługa (`componentsOrder`) i środowisko ostatnie udane wdrożenie
     (`currentVersion()`): wersja, czas, commit, rollback, drift wobec poprzedniego środowiska (liczba plików albo
     „nieznany”).
2. **Serwer MCP (`adapters/mcp/`).** `shipscope-mcp.js` (stdio, JSON-RPC 2.0 rozdzielane nowymi wierszami) nad
   czystym `lib.js`: `initialize` (wersje protokołu 2024-11-05, 2025-03-26, 2025-06-18), `tools/list`, `tools/call`,
   `ping`. Narzędzia: `get_item_status`, `list_changes`, `get_release_plan` (opcjonalnie jedna grupa),
   `list_flags` (opcjonalnie jedna flaga), `get_environments`, `get_metrics` (`from`/`to`). Wynik jako tekst JSON
   i `structuredContent`; błąd API jako `isError` z komunikatem bez tokenu.
   - `SHIPSCOPE_URL`: https (http tylko dla localhost), bez loginu w adresie; `SHIPSCOPE_TOKEN`: `shps_…`. Brak albo zły
     format → błąd narzędzia z podpowiedzią, gdzie je wziąć (Settings → General → Service tokens).
   - Argumenty sprawdzane przed żądaniem (klucz jak `PAY-12`, daty `RRRR-MM-DD`); ścieżki budowane z
     `encodeURIComponent`. Odpowiedź API to dane, nie polecenia — opis narzędzi mówi to modelowi.
   - Limit czasu 30 s, odpowiedź najwyżej 2 MB; 429 → komunikat z `Retry-After`.
3. **Dokumentacja.** `adapters/mcp/README.md` (konfiguracja w Claude Code: `claude mcp add`, i Claude Desktop),
   `server/README.md` (trasy), CLAUDE.md (układ, API usług).

## Testy (najpierw czerwone)
- `server/test/service-api.test.js`: każda nowa trasa na prawdziwym Postgresie (zmiana CHG-12 z cięciami na PROD,
  plan, flaga, drift), bez tokenu 401, token innego workspace'u nie widzi danych.
- `test/mcp-adapter.test.js` (root): protokół na `lib.js` (initialize, lista narzędzi, nieznana metoda, nieznane
  narzędzie, złe argumenty), klient przeciw lokalnemu serwerowi HTTP (nagłówek z tokenem, ścieżki, 401/429 jako
  `isError`, adres http spoza localhost odrzucony) i proces `shipscope-mcp.js` przez stdio.
- `test/module-boundaries.test.js` obejmuje `adapters/mcp/` bez zmian.
