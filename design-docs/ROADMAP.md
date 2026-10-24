# Plan rozwoju

Zdecydowane prace na przyszłość, w kolejności. Nierozstrzygnięte pomysły są w [FEATURES.pl.md](FEATURES.pl.md),
dług techniczny w [TODO.md](TODO.md). Plan flag wynika z [ADR-003](ADR-003-flag-sources.md) (2026-10-24).
Każdy punkt to osobny PR, wdrażalny sam; `[ ]` = do zrobienia, `[x]` = zrobione (z numerem PR).

## Flagi (ADR-003)

### 0. Ochrona obecnego API ingest

- [x] Ingest nie trzyma połączenia z puli bez końca: limit czasu oczekiwania na blokadę tenanta
  (`server/lib/flags.js`, `pg_advisory_xact_lock`), po nim 503 z `Retry-After`.
- [x] Limit żądań per token na `POST /api/flags/ingest` (429 z `Retry-After`); adapter sam ponawia po 429/503.
- [x] Opisy i klucze Jiry flag zapisywane jednym zapytaniem zamiast jednego `UPDATE` na flagę.
- [x] Tokeny ingest z datą ważności i opcjonalnym zakresem (środowiska); w Settings data wygaśnięcia i ostrzeżenie
  przed nią.

### 1. Poprawny model statusu (na samym pushu)

- [x] Źródło obejmuje zbiór serwisów (`flag_source_repos` zamiast etykiety `flag_sources.repo_id`); migracja
  przenosi obecne `repo_id`, źródło bez serwisów zachowuje dzisiejsze zachowanie z podpowiedzią w Settings.
- [x] Stan repozytorium wobec flag: śledzone / bez flag / nieśledzone (`tracked_repos.flag_stance`), wybór w
  Settings.
- [x] Stan efektywny per (serwis, klucz, środowisko) liczony na serwerze; dashboard-data rozszerzone addytywnie
  (`flagStatesByComponent`, `componentsOrder[].flagCoverage`), sloty `build`/`runtime-be` zostają na czas przejścia.
- [x] Nowy `issueStatusForEnv()`: bramki per serwis, serwis neutralny, `partial` to Partial (dopiero 100% =
  on), niepewność „?" dla serwisów nieśledzonych. `FALLBACK` z tymi samymi polami.

### 2. Świeżość i monitoring

- [ ] Znacznik potwierdzenia per (źródło, środowisko) (`flag_source_envs`: `last_observed_at`, `last_error`),
  próg świeżości per źródło, stany `fresh`/`stale`/`error`/`unknown`.
- [ ] Wspólna ścieżka zapisu `applyObservations()` (wydzielona z `applyIngest()`, najpierw test
  charakteryzujący).
- [ ] UI: „niepotwierdzone od X", „Released?" z powodem; stan każdego źródła per środowisko w Settings.
- [ ] Metryki i strukturalne logi (wiek kolejki `sync_requests`, czas passów, błędy źródeł), alerty dla
  operatora.

### 3. Flagi w kodzie i kreator setupu

- [ ] Odczyt pliku flag przy `resolved_ref` ostatniego udanego wdrożenia per środowisko (po `refreshDrift`),
  `changedAt` = czas wdrożenia; brak pliku = błąd, nie usunięcie.
- [ ] Parsery z `adapters/flags/lib.js` w izolowanym wątku (`worker_threads`, limity pamięci, timeout), limity
  rozmiaru, aliasów i głębokości; komunikaty błędów bez wartości; wymagany prefiks albo lista kluczy.
- [ ] Automatyczne wykrywanie plików flag w repozytorium i propozycja do potwierdzenia.
- [ ] Jawna mapa nazw środowisk per repozytorium (zamiast samego `mapEnvironment()`).
- [ ] Kreator setupu: karta per repozytorium (środowiska, flagi, mapowanie) z podglądem przed zapisem.
- [ ] Reguła w `scripts/lib/module-boundaries.js`: serwer może wymagać tylko parserów adaptera.

### 4. Endpoint z flagami

- [ ] Wspólny moduł połączeń wychodzących (ochrona przed SSRF: https:443, wszystkie adresy z DNS, przypięte IP,
  bez przekierowań, limity czasu i rozmiaru po dekompresji) z testami listy adresów zakazanych.
- [ ] Źródło typu endpoint: adres per środowisko, token w `secret-box` z zakresem (tenant, źródło, cel),
  mapowanie jak w adapterze, „Testuj" zwracający tylko sparsowane flagi, podpis żądań per tenant.
- [ ] Tick flag w workerze (osobna blokada), `next_poll_at`, backoff z jitterem, minimalny interwał, limity
  źródeł na tenanta; odświeżenie przy wejściu na dashboard przez `sync_requests`.

### 5. Ostrzeżenie FE/BE i podpowiedzi powiązań

- [ ] Rola serwisu (frontend/backend) i czerwone ostrzeżenie „FE on, BE off".
- [ ] Podpowiadanie powiązań flaga → issue: klucz zmieniony w pliku flag przez commity issue.

### Na żądanie klientów

- [ ] Agent dla sieci prywatnych: kontener u klienta, połączenie tylko wychodzące, na bazie parserów adaptera.
- [ ] Konektor platformy flag (pierwsza platforma wg potrzeb klientów): token tylko do odczytu sprawdzany przy
  podłączeniu, webhook z podpisem, oknem czasowym i deduplikacją, stan zawsze z API, okresowe uzgodnienie.
- [ ] Jawne zależności między flagami różnych serwisów (łańcuchy FE ← BE ← X), jeśli rola serwisu nie wystarczy.
- [ ] Cykl życia flagi (np. „gotowa do usunięcia z kodu") jako rozszerzenie ghost/stale flag.
- [ ] Wysyłanie flag do panelu Jiry przez jej Feature Flags API (wymaga aplikacji Forge).

## Niezawodność usługi (przed płatnymi klientami)

- [ ] Skalowanie workera: podział pracy między instancje (dziś cały pass jest pod jedną blokadą) i równoległe
  odczyty z limitem per host.
- [ ] Kopie zapasowe bazy z okresowym testem odtwarzania.
- [ ] Cel dostępności (SLO), strona statusu.
- [ ] Retencja `flag_value_history` (dziś bez limitu i czytana cała przy każdym ładowaniu dashboardu).

## Bezpieczeństwo (z przeglądu 2026-10-24)

- [ ] Osobny klucz szyfrowania sekretów tylko w workerze (dziś `TOKEN_ENCRYPTION_KEY` jest w obu usługach), rotacja
  kluczy z identyfikatorem (`kid`), log audytowy zmian ustawień.
- [ ] Webhook Jiry: sprawdzić, czy Atlassian zawsze wysyła `exp`, i jeśli tak — wymagać go (dziś token bez `exp`
  jest przyjmowany, `server/lib/webhooks.js`).
- [ ] Tożsamość nadawcy push z GitHub OIDC zamiast trwałego tokenu (dla klientów, którzy zostają przy adapterze).

## Dla klientów korporacyjnych (gdy się pojawią)

- [ ] Wybór regionu danych (np. tylko UE).
- [ ] Logowanie przez firmowe SSO.
- [ ] Ewentualnie instancja dedykowana dla jednego klienta, utrzymywana przez nas.
- [ ] Wdrożenia spoza GitHub Deployments (np. ArgoCD, Jenkins).
