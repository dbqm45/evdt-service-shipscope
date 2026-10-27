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
- [x] Metryki: `GET /metrics` w formacie Prometheusa za `METRICS_TOKEN` (czasy i liczniki zadań workera, kolejka,
  źródła flag wg świeżości, odpowiedzi ingestu i webhooków); przy okazji worker zapisuje wreszcie stan zadań `flags`
  i `secrets` (ograniczenie z migracji 020 je odrzucało). (#101)

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
  - [x] Zakładka „Release plan” (G1.3 z planu G1/G2 w pdi, tryb Jira; `design-docs/G1.3-PLAN.pl.md`). Pokazuje linie
    R1…Rn z etykiety `release:R1` (albo fixVersion lub pola), status każdego elementu na PROD i „R1 released”. Przy
    flagach widać procent udostępnienia na PROD, etap wobec planu, dni w etapie wobec `min_days` i dni po
    `remove_by`. Dopisek `Flag:` w commicie silnie wiąże flagę z TSK albo historyjką.
  - [x] F1 z planu jednego flow (`design-docs/F1-PLAN.pl.md`): elementy pracy CHG/TSK z
    `docs/project/changes/<CHG>/intent.md` i `plan.md` w śledzonych repo (migracja 037, `lib/work-items.js`), przyrost
    „Changes (repo)”, w którym commit z `Change: TSK-57` liczy się dla CHG-12, i `itemKeys` przy flagach w ingest.
  - [x] Tryb repo: `changes/CHG-n/release.yaml` przez Contents API (ten sam sync co elementy z F1), walidowany
    przypiętą kopią schematu z kontraktu pdi 0.4.0, z widocznym błędem syncu przy złym pliku; złamana spójność
    planu (MVP spoza linii, TSK w kilku liniach) jest wyświetlana, nie poprawiana.
  - [x] Zdarzenia `release.stage_changed` i `feature.released` z polem `release` (G1.5, `design-docs/G1.5-PLAN.pl.md`):
    subskrypcje adresów w Settings → General, kolejka i podpisana dostawa z ponowieniami (pierwsze wychodzące
    webhooki z F5, tylko te dwa zdarzenia). Część pdi (skrzynka bramek, ocena skutku MVP) jest w repo pdi.
  - [x] Reszta F5 z planu jednego flow: API usług dla pdi i tf (#110, `design-docs/F5-API-PLAN.pl.md`), release notes
    słowami intencji zmiany (#111), lead time od intencji i od zgłoszenia w Insights (#112, #113), serwer MCP nad API
    usług (K-1, #114).
  - [x] Połączenie z pdi (`design-docs/PDI-CONNECTION-PLAN.pl.md`, #115) i warstwa pdi tylko dla połączonych
    workspace'ów (#116, #118, `design-docs/PDI-GATE-PLAN.pl.md`), prostszy rdzeń bez pdi (#117,
    `design-docs/CORE-SIMPLIFY-PLAN.pl.md`).
  - [x] Czas przepływu od pierwszego commita do pierwszego PROD w API usług (krok 1 luki G3, #119,
    `design-docs/G3-FLOW-TIME-PLAN.pl.md`); prognozę z niego liczy pdi (dbqm45/pdi#37).
- [ ] Wysyłanie flag do panelu Jiry przez jej Feature Flags API (wymaga aplikacji Forge).

## Niezawodność usługi (przed płatnymi klientami)

- [x] Skalowanie workera: każdy workspace zajmowany osobno (blokada per zadanie i workspace, `lib/tenant-claim.js`),
  więc kilka instancji dzieli się przebiegami wdrożeń, Jiry i flag; `WORKER_CONCURRENCY` workspace'ów naraz w jednej
  instancji i najwyżej 2 zapytania naraz do jednego hosta klienta. (#105)
- [x] Kopie zapasowe bazy z okresowym testem odtwarzania: procedura w `server/KOPIE.pl.md` (PITR Rendera, eksporty,
  kopia poza Renderem, odtworzenie, test raz na kwartał) i `npm run verify-restore`, który sprawdza odtworzoną kopię. (#103)
- [ ] Ustawić kopię poza Renderem (eksport co tydzień albo cron job „PostgreSQL S3 Backups”) i wpisać pierwszy test
  odtwarzania do kalendarza.
- [x] Cel dostępności (SLO), strona statusu: cele, budżet błędów i alerty w `server/SLO.pl.md`; publiczne `/status` i
  `/status.json` z historią 90 dni. (#104)
- [ ] Podłączyć zewnętrzny monitor (`/health`, `/health/worker`, `/status.json`) i reguły alertów z SLO.pl.md.
- [x] Retencja `flag_value_history`: ta sama co wdrożeń (`deployment_retention_days`), zawsze z ostatnią zmianą każdej
  flagi na źródle i środowisku; dashboard czyta najwyżej 5000 najnowszych zmian. (#102)

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
- [x] Webhook Jiry bez `exp`: dokumentacja Atlassiana nie wymienia claimów tokenu, więc taka dostawa jest logowana
  (`jira webhook token without exp`), a `JIRA_WEBHOOK_REQUIRE_EXP=1` ją odrzuca; odmowy webhooków logują powód. (#99)
- [ ] Włączyć `JIRA_WEBHOOK_REQUIRE_EXP=1` na produkcji, gdy przez kilka tygodni w logach nie będzie tokenu bez `exp`.
- [x] Tożsamość nadawcy push z GitHub OIDC zamiast trwałego tokenu: źródło ufa repozytoriom, które obejmuje (po id),
  opcjonalnie tylko wybranym gałęziom/tagom i środowiskom; adapter z `oidc: true`, bez sekretu. (#100)

## Dla klientów korporacyjnych (gdy się pojawią)

- [ ] Wybór regionu danych (np. tylko UE).
- [ ] Logowanie przez firmowe SSO.
- [ ] Ewentualnie instancja dedykowana dla jednego klienta, utrzymywana przez nas.
- [ ] Wdrożenia spoza GitHub Deployments (np. ArgoCD, Jenkins).
