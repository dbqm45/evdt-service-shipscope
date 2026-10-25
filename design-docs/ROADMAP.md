# Plan rozwoju

Zdecydowane prace na przyszłość, w kolejności. Nierozstrzygnięte pomysły są w [FEATURES.pl.md](FEATURES.pl.md),
dług techniczny w [TODO.md](TODO.md). Plan flag wynika z [ADR-003](ADR-003-flag-sources.md) (2026-10-24).
Każdy punkt to osobny PR, wdrażalny sam; `[ ]` = do zrobienia, `[x]` = zrobione (z numerem PR).

**Stan na 2026-10-25:** przyrosty 0–5 planu flag są zrobione (#73–#91), a z sekcji Bezpieczeństwo rotacja klucza
szyfrowania, tokeny klientów czytelne tylko dla workera i log audytowy sekretów oraz ustawień (#92–#98). Otwarte
zostają: metryki, prace „na żądanie klientów", niezawodność usługi, reszta bezpieczeństwa i potrzeby klientów
korporacyjnych.

## Flagi (ADR-003)

### 0. Ochrona obecnego API ingest

- [x] Ingest nie trzyma połączenia z puli bez końca: limit czasu oczekiwania na blokadę tenanta
  (`server/lib/flags.js`, `pg_advisory_xact_lock`), po nim 503 z `Retry-After`. (#73)
- [x] Limit żądań per token na `POST /api/flags/ingest` (429 z `Retry-After`); adapter sam ponawia po 429/503. (#73)
- [x] Opisy i klucze Jiry flag zapisywane jednym zapytaniem zamiast jednego `UPDATE` na flagę. (#73)
- [x] Tokeny ingest z datą ważności i opcjonalnym zakresem (środowiska); w Settings data wygaśnięcia i ostrzeżenie
  przed nią. (#75)

### 1. Poprawny model statusu (na samym pushu)

- [x] Źródło obejmuje zbiór serwisów (`flag_source_repos` zamiast etykiety `flag_sources.repo_id`); migracja
  przenosi obecne `repo_id`, źródło bez serwisów zachowuje dzisiejsze zachowanie z podpowiedzią w Settings. (#76)
- [x] Stan repozytorium wobec flag: śledzone / bez flag / nieśledzone (`tracked_repos.flag_stance`), wybór w
  Settings. (#76)
- [x] Stan efektywny per (serwis, klucz, środowisko) liczony na serwerze; dashboard-data rozszerzone addytywnie
  (`flagStatesByComponent`, `componentsOrder[].flagCoverage`), sloty `build`/`runtime-be` zostają na czas przejścia. (#76)
- [x] Nowy `issueStatusForEnv()`: bramki per serwis, serwis neutralny, `partial` to Partial (dopiero 100% =
  on), niepewność „?" dla serwisów nieśledzonych. `FALLBACK` z tymi samymi polami. (#77)

### 2. Świeżość i monitoring

- [x] Znacznik potwierdzenia per (źródło, środowisko) (`flag_source_envs`: `last_observed_at`, `last_error`),
  próg świeżości per źródło, stany `fresh`/`stale`/`error`/`unknown`. (#78)
- [x] Wspólna ścieżka zapisu `applyObservations()` (wydzielona z `applyIngest()`, najpierw test
  charakteryzujący). (#78)
- [x] UI: „niepotwierdzone od X", „Released?" z powodem; stan każdego źródła per środowisko w Settings. (#79)
- [x] Strukturalne logi (JSON, `tenantId`/`requestId`/`job`, bez sekretów) i `GET /health/worker` dla monitora
  dostępności (heartbeat, ostatnia udana synchronizacja, wiek kolejki `sync_requests`). (#80)
- [ ] Metryki (Prometheus `/metrics`: czasy passów, błędy źródeł, odrzucenia ingestu), gdy będzie dla kogo je
  oglądać.

### 3. Flagi w kodzie i kreator setupu

- [x] Odczyt pliku flag przy `resolved_ref` ostatniego udanego wdrożenia per środowisko (po `refreshDrift`),
  `changedAt` = czas wdrożenia; brak pliku = błąd, nie usunięcie. (#82)
- [x] Parsery z `adapters/flags/lib.js` w izolowanym wątku (`worker_threads`, limity pamięci, timeout), limity
  rozmiaru, aliasów i głębokości; komunikaty błędów bez wartości; wymagany prefiks albo lista kluczy. (#81)
- [x] Automatyczne wykrywanie plików flag w repozytorium i propozycja do potwierdzenia. (#84)
- [x] Jawna mapa nazw środowisk per repozytorium (zamiast samego `mapEnvironment()`). (#83)
- [x] Kreator setupu: karta per repozytorium (środowiska, flagi, mapowanie) z podglądem przed zapisem (Settings →
  GitHub, ołówek przy repozytorium). (#84, #85)
- [x] Reguła w `scripts/lib/module-boundaries.js`: serwer może wymagać tylko parserów adaptera. (#81)

### 4. Endpoint z flagami

- [x] Wspólny moduł połączeń wychodzących (ochrona przed SSRF: https:443, wszystkie adresy z DNS, przypięte IP,
  bez przekierowań, limity czasu i rozmiaru po dekompresji) z testami listy adresów zakazanych. (#86)
- [x] Źródło typu endpoint: adres per środowisko, token w `secret-box` z zakresem (tenant, źródło, cel),
  mapowanie jak w adapterze, „Testuj" zwracający tylko sparsowane flagi, podpis żądań per tenant. (#87; formularz
  w Settings: #89)
- [x] Tick flag w workerze (osobna blokada), `next_poll_at`, backoff z jitterem, minimalny interwał, limity
  źródeł na tenanta; odświeżenie przy wejściu na dashboard przez `sync_requests`. (#88)

### 5. Ostrzeżenie FE/BE i podpowiedzi powiązań

- [x] Rola serwisu (frontend/backend) i czerwone ostrzeżenie „FE on, BE off". (#90)
- [x] Podpowiadanie powiązań flaga → issue: klucz zmieniony w pliku flag przez commity issue. (#91)

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

- [x] Rotacja `TOKEN_ENCRYPTION_KEY` z identyfikatorem klucza w zaszyfrowanej wartości (`v2.<key id>…`), stare klucze
  w `TOKEN_ENCRYPTION_KEY_PREVIOUS`, przeszyfrowanie przez workera; sekret podpisu zapisany per workspace. (#92)
- [x] Zmiana sekretu podpisu przez admina jednego workspace'u i log audytowy dostępu do sekretów (`secret_events`). (#93)
- [x] Tokeny endpointów czytelne tylko dla workera: web szyfruje kluczem publicznym (`SECRETS_PUBLIC_KEY`), klucz
  prywatny tylko w workerze, „Testuj" z zapisanym tokenem przez kolejkę do workera. (#95)
- [x] Tokeny odświeżania Jiry tylko w workerze: web dostaje od workera krótkotrwały token dostępu (do godziny) przez
  kolejkę i trzyma go do wygaśnięcia; `TOKEN_ENCRYPTION_KEY` w web służy już tylko sekretowi podpisu i tym tokenom. (#96)
- [x] Log audytowy zmian pozostałych ustawień (członkowie, zaproszenia, repozytoria, źródła flag i tokeny, Jira,
  retencja), nie tylko sekretów: `audit_events`, Settings → General „Settings activity”. (#98)
- [ ] Webhook Jiry: sprawdzić, czy Atlassian zawsze wysyła `exp`, i jeśli tak — wymagać go (dziś token bez `exp`
  jest przyjmowany, `server/lib/webhooks.js`).
- [ ] Tożsamość nadawcy push z GitHub OIDC zamiast trwałego tokenu (dla klientów, którzy zostają przy adapterze).

## Dla klientów korporacyjnych (gdy się pojawią)

- [ ] Wybór regionu danych (np. tylko UE).
- [ ] Logowanie przez firmowe SSO.
- [ ] Ewentualnie instancja dedykowana dla jednego klienta, utrzymywana przez nas.
- [ ] Wdrożenia spoza GitHub Deployments (np. ArgoCD, Jenkins).
