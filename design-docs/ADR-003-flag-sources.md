# ADR-003: Źródła flag — ShipScope czyta flagi sam, stan per serwis, jawna świeżość

- **Status**: przyjęta (2026-10-24); częściowo zastępuje [ADR-001](ADR-001-flags-pushed-from-outside.md)
- **Wdrożenie**: w przyrostach, opisanych w [ROADMAP.md](ROADMAP.md); do czasu ich zrobienia kod działa wg ADR-001
- **Podstawa**: przegląd architektury, bezpieczeństwa i niezawodności z 2026-10-24 (metody z zespołu agentów:
  arch-quality-attributes, arch-system-design, arch-threat-modeling, arch-multi-tenancy, ops-sre-incidents,
  ops-observability, be-messaging-outbox) oraz przegląd rynku (Jira Feature Flags API, LaunchDarkly, Unleash,
  Sleuth, OpenFeature)

## Kontekst

ShipScope ma być płatnym SaaS-em. Cele właściciela produktu:

- **setup banalny** — bez pisania kodu i bez nowych workflowów, które zużywają minuty GitHub Actions klienta;
- **flagi aktualne** — dashboard pokazuje, co jest wdrożone, ukryte flagą albo wydane, i nie myli się;
- **niezawodność i profesjonalizm** — za usługę ktoś płaci.

ADR-001 („ShipScope nigdy nie czyta flag, nadawcy je wysyłają") spełnia to tylko częściowo:

- każdy zespół musi dodać nadawcę (w praktyce workflow z adapterem `adapters/flags/` i sekretem), który kosztuje
  minuty GitHuba w repozytoriach prywatnych, a flagi zmieniane w runtime wymagają do tego harmonogramu;
- ADR-001 sam przyznaje, że nikt nie wykrywa nadawcy, który przestał wysyłać.

Przegląd kodu znalazł też błędy modelu, przez które dashboard pokazuje fałszywe „Released":

- stan flagi jest jeden na klucz i środowisko (`server/lib/flags-logic.js`, `pickWinningValues()`), a frontend
  stosuje go do każdego serwisu (`docs/app-core.js`, `effectiveFlagState()`); ten sam klucz w FE i BE zlewa się
  w jeden stan, z pierwszeństwem runtime („BE wygrywa");
- `partial` liczy się jako włączona (`enabledFrom()`), więc rollout 5% daje „Released";
- serwis, do którego trafił kod issue, ale który nie ma źródła flag, jest pomijany, gdy issue ma choć jedną
  flagę (`docs/app-model.js`, `issueStatusForEnv()`).

Zespoły trzymają flagi różnie: w plikach w kodzie (build-time, jeden plik albo plik per środowisko), za
endpointem backendu (runtime), w platformie flag (LaunchDarkly i podobne) albo wcale. Jedna funkcja często
obejmuje kilka serwisów, każdy z własną flagą (FE w kodzie, BE z endpointu), i FE włączony przy wyłączonym BE
psuje UI.

## Decyzja

### 1. Model produktu

ShipScope jest SaaS-em z kontem firmowym (workspace), jak Jira Cloud czy github.com. Nie powstaje wersja
self-hosted. Dla sieci prywatnych przewidziany jest mały agent u klienta, łączący się tylko na zewnątrz
(wzorzec Grafana PDC, Unleash Edge) — jako osobny przyrost, na żądanie.

### 2. Trzy sposoby dostarczenia flag (świadomie ograniczone)

Każdy śledzony serwis (repozytorium) wybiera jeden albo kilka:

| Sposób | Co robi klient | Jak ShipScope zostaje aktualny | Rodzaj |
|---|---|---|---|
| **Flagi w kodzie** (domyślny) | potwierdza plik wykryty przez ShipScope (albo podaje ścieżkę/wzorzec `{env}`) | czyta plik z wdrożonego commitu (`resolved_ref`) przez GitHub App przy każdym nowym wdrożeniu; `contents: read` już jest | build |
| **Endpoint z flagami** | podaje adres https i token tylko do odczytu, mapowanie w kreatorze, „Testuj" | odpytuje co kilka minut, dodatkowo po wdrożeniu serwisu i przy wejściu na dashboard | runtime |
| **Brak flag** | jedno kliknięcie | nic do czytania: wdrożony znaczy działający | — |

Poza pierwszą wersją (zob. [ROADMAP.md](ROADMAP.md)): konektory platform flag, agent dla sieci prywatnych.
Istniejące API `POST /api/flags/ingest` (`schemaVersion: 2`) zostaje bez zmian jako opcja zaawansowana (np.
wywołanie z własnego backendu klienta); adapter w GitHub Actions pozostaje dla zgodności wstecznej, ale nie jest
rekomendowaną ścieżką. Wszystkie sposoby piszą przez jedną ścieżkę zapisu (`planIngestWrites()`), więc
reguły kolejności i pełnego stanu są wspólne.

### 3. Stan per serwis, feature = issue

- Źródło obejmuje zbiór serwisów (repozytoriów); stan efektywny flagi liczony jest per (serwis, klucz,
  środowisko). W obrębie serwisu runtime nadpisuje build, potem priorytet źródła, potem nowsza zmiana.
- Repozytorium ma stan wobec flag: **śledzone** (ma źródło), **bez flag** (zadeklarowane) albo **nieśledzone**
  (domyślnie, dopóki admin nie wybierze).
- Feature to issue w Jirze. Flagi z różnych serwisów łączą się z nim jak dziś (klucze od nadawcy, pole lub
  etykieta w Jirze, ręcznie w Settings); nazwy flag w serwisach nie muszą być takie same.
- Status issue na środowisku liczony jest tylko z serwisów, do których trafił jego kod:
  - bramka serwisu = flagi issue w tym serwisie: wszystkie on → on, wszystkie off → off, inaczej partial;
  - serwis śledzony albo „bez flag", bez flagi powiązanej z issue, jest neutralny (nie liczy się jako „on");
  - wszystkie bramki on → **Released**; wszystkie off → **Deployed (hidden)**; inaczej **Partial**;
    brak bramek → **Deployed (no flag)**;
  - rollout poniżej 100% to **Partial**, nie Released;
  - serwis nieśledzony albo źródło nieświeże nie zmienia poziomu, ale dodaje niepewność: „Released?" z powodem;
  - FE włączony przy wyłączonym backendzie (rola serwisu frontend/backend) daje czerwone ostrzeżenie.

### 4. Świeżość jest jawna

- Każde źródło ma znacznik ostatniego potwierdzenia per środowisko (udany pełny odczyt potwierdza wszystkie
  flagi środowiska) i próg świeżości. Stany: `fresh`, `stale`, `error`, `unknown`.
- Nieświeży stan nigdy nie wygląda na bieżący: dashboard pokazuje „niepotwierdzone od X" i „?" przy statusie.
- Błąd źródła nigdy nie usuwa flag. Flaga znika tylko wtedy, gdy udany, pełny odczyt jej nie zawiera.
  Brak pliku flag w nowym wdrożeniu to błąd, nie usunięcie.
- Wyzwalacze idą przez istniejącą kolejkę `sync_requests` (nowy rodzaj `flags`), osobny tick workera i
  okresowe uzgodnienie pełnego stanu, które nadrabia zgubione zdarzenia.
- Docelowe opóźnienia (do skalibrowania pomiarami): flagi w kodzie ≤ 2 min po wdrożeniu; endpoint ok. 1,5 ×
  interwał odpytywania, ok. 1 min przy otwartym dashboardzie.

### 5. Wymogi bezpieczeństwa (obowiązkowe, nie opcjonalne)

- **Pliki klientów**: parsowanie w izolowanym wątku (`worker_threads` z limitami pamięci i twardym timeoutem),
  limity rozmiaru, aliasów YAML i głębokości. Przegląd pokazał, że parsery adaptera uruchomione wprost na
  serwerze dają się zatrzymać kilkuset bajtami YAML z aliasami albo dużym plikiem TS.
- **Komunikaty błędów bez wartości** z plików i odpowiedzi (dziś wartość trafia do `last_error` i logów);
  wymagany prefiks albo lista kluczy, żeby `.env` z hasłami nie stał się „flagami".
- **Jawna mapa nazw środowisk per repozytorium** (`mapEnvironment()` dopasowuje po fragmencie nazwy).
- **Endpointy**: wspólny moduł połączeń wychodzących — tylko https:443, sprawdzenie wszystkich adresów z DNS
  i połączenie z przypiętym IP, bez przekierowań, limity czasu i rozmiaru (także po dekompresji); żądania
  podpisane per tenant; „Testuj" zwraca tylko sparsowane flagi.
- **Sekrety klientów** (tokeny tylko do odczytu) w `secret-box` z zakresem (tenant, źródło, cel), z rotacją
  kluczy i logiem audytowym.
- Każda nowa tabela z danymi tenanta w `RLS_TABLES` i w `tenant-delete.test.js`.

## Rozważane opcje

- **Zostać przy ADR-001 (tylko push)** — odrzucona: koszt minut i konfiguracji po stronie klienta, brak
  wykrywania milczącego nadawcy, a błędy modelu zostają.
- **Adapter w GitHub Actions jako główna ścieżka** (workflow notify po wdrożeniu + harmonogram) — odrzucona:
  kosztuje minuty w repozytoriach prywatnych, wymaga sekretów i przypinania wersji, harmonogram Actions jest
  best-effort.
- **Wersja self-hosted** — odrzucona: niezawodność zależałaby od klienta, setup przestaje być banalny, koszt
  utrzymania wielu wersji (Atlassian wygasza Data Center z tych powodów).
- **Konektory wielu platform flag od razu** — odłożona: każdy konektor to osobny kontrakt API do utrzymania
  (powód, dla którego ADR-001 odrzucił „adapter per mechanizm"); jeden, gdy klient o niego poprosi.
- **OpenFeature OFREP jako jedyny format endpointu** — odrzucona na teraz: protokół jest w fazie roboczej;
  może być jednym z gotowych mapowań, gdy dojrzeje.

## Konsekwencje

- Pozytywne: zero pracy zespołu dla flag w kodzie; brak kosztów Actions; jeden model statusu, który nie pokazuje
  fałszywego „Released" i jawnie mówi, czego nie wie.
- Negatywne: ShipScope zaczyna czytać dane klientów (pliki, endpointy) i przechowywać ich tokeny — rośnie
  powierzchnia ataku i odpowiedzialność (wymogi z punktu 5, umowa powierzenia danych). Worker robi więcej pracy
  i musi dać się skalować.
- Endpoint w sieci prywatnej nie jest obsłużony bez agenta; do czasu jego powstania wymóg brzmi: endpoint
  osiągalny po https z tokenem albo API ingest wywołane przez klienta.
- Wartość z pliku to wartość zbudowana, nie zawsze działająca (wdrożenie może ją nadpisać zmienną
  środowiskową); dashboard oznacza ją „z kodu, wersja X", a źródło runtime tego serwisu ją nadpisuje.
- ADR-001 pozostaje ważny dla kontraktu `schemaVersion: 2` (wersjonowanie, pełny stan, „starsza wiadomość nie
  cofa nowszej", token per nadawca). Zastąpiona jest tylko jego zasada „ShipScope nigdy nie czyta flag".
