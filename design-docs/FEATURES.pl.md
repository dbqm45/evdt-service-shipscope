# Kandydaci na funkcje

*English version: [FEATURES.md](FEATURES.md)*

> **Status: niezrobione, niezdecydowane.** Pomysły z dyskusji wraz z tym, co ustalono przy ich ocenie. Każdy
> to punkt wyjścia do decyzji, nie plan. Dług techniczny jest w [TODO.md](TODO.md). Sprawdzone z kodem
> 2026-10-16.

## Widok produktowy

Z sesji ideacyjnej SAFe (2026-10-01). Z sześciu luk cztery są zrobione: ostrzeżenie o „fladze-duchu”, hybrydowy
zakres sprintu („Current sprint + unresolved”), sygnał otwartego błędu w Epiku i przełącznik „Hide tasks”
(patrz `CLAUDE.md` → Frontend). Zostały dwie.

### Zespół jako filtr i wymiar grupowania

Wiele zespołów Agile, zwykle jedna tablica na zespół; Epiki potrafią obejmować kilka zespołów; pole `Team` w
Jirze nie zawsze jest wypełnione.

- **Reguła** (z sesji): pole `Team`, gdy jest; w przeciwnym razie tablica, z której pochodzi sprint zadania; w
  ostateczności jawny koszyk „Nieprzypisane / do wyjaśnienia” — sam w sobie sygnał o stanie backlogu.
- **W serwerze to już tanie:** każde zapisane zadanie ma `board_id` tablicy, przez którą zostało
  zsynchronizowane (`jira_issues.board_id`), a tablica to zespół. Brakuje nazwy tablicy przy zadaniu w danych
  dashboardu (`listPiIssues()` zwraca tylko `data`) i filtra w `docs/app-product.js`.
- **W synchronizacji plikowej to drogie:** `sync-jira.js` łączy tablice przestrzeni w jedno JQL i nie zapisuje,
  która tablica dopasowała zadanie; tablice w `docs/jira-spaces.json` nie mają etykiety zespołu. Warto tylko,
  jeśli ścieżka plikowa zostaje.
- Otwarte: czy dashboard służy całemu ART/PM (zespół jako filtr z etykietą przy wierszu), czy zespołowi/PO
  (domyślnie przefiltrowany do jednego zespołu)? Zespół → Epik → zadania jako drugi poziom grupowania czy
  płaski filtr?

### Napisy statusów w języku „4 koszyków” z sesji

„W locie (Test)” / „Do akceptacji (QA)” / „Wdrożone technicznie (Prod, flaga OFF)” / „Wydane” odpowiadają
jeden do jednego poziomom `issueStatusForEnv()`; zmieniłyby się tylko napisy w `statusLabel()`. Otwarte:
zostać przy angielskim i przeformułować, czy wprowadzić polskie napisy (pierwszy nieangielski tekst w UI —
precedens, o którym warto zdecydować świadomie).

### Pytania z sesji wciąż otwarte

- Czy kiedykolwiek trzeba pokazywać Portfolio Epic / Capability nad Epikiem? („Epic” w tej organizacji to
  Feature w SAFe, więc grupowanie po Epiku jest już na właściwym poziomie.)
- Poza zakresem z decyzji użytkownika: przełączanie flag z ShipScope i przenoszenie stanu flag do Jiry.

## Aktualizacje na żywo w otwartym dashboardzie

Webhooki docierają już do serwera, a worker synchronizuje w ok. 30 s, ale otwarty dashboard pokaże zmianę
dopiero po odświeżeniu. Jeden kanał Server-Sent Events (`GET /api/tenants/:id/events`) z komunikatem „to się
zmieniło” i ponownym pobraniem tego wycinka zrobiłby to na żywo. Jedno długie połączenie na otwartą kartę;
przed budową sprawdzić limity Rendera.

## Ślad audytowy zmian

W modelu plikowym każda zmiana danych to commit, więc `git log` na `live` jest darmowym dziennikiem (to z niego
korzysta `backfill-flag-state-history.js`). Serwer ma historię tylko dla wartości flag (`flag_value_history`);
zmiany ustawień (śledzone repo, tablice, role, powiązania flag, usunięcie) nie zostawiają śladu, kto co zrobił.
Domknęłaby to mała tabela `audit_events` zapisywana przy każdej akcji admina.

## Stan CI per komponent (Sonar / Checkmarx / ESLint / Orca)

Wskaźnik trójstanowy per komponent — zielony (wszystkie sprawdzenia czyste), żółty (coś pominięte, wyłączone
albo dawno nieuruchomione: „do przejrzenia”), czerwony (sprawdzenie nie przeszło) — bez liczby znalezisk.

Ustalone na `evapl-service-frontend` (2026-10): cała logika build/lint/test/skanów jest we współdzielonym
workflow organizacji `circlek-global/arp-global-workflow-build-npm` (`build-npm.yml`), nie w repo aplikacji.

- **Sonar**: `sonarqube-scan-action` + `sonarqube-quality-gate-action`; krok pada tylko przy bramce `ERROR`.
  Prawdziwy stan bramki wymaga Web API Sonara (`api/qualitygates/project_status`) i tokenu.
- **Checkmarx**: job `checkmarx-scan` przez `circlek-global/sdlc-global-action-checkmarx` (Checkmarx One CLI:
  SAST, SCA, IaC, API, kontenery, SCS). Bez `security-events: write`, więc bez SARIF w Code Scanning; stan per
  ważność wymaga API Checkmarx One.
- **ESLint**: zwykły krok w tym samym jobie co build/testy; dostępny tylko wynik tego kroku (Workflow Jobs API,
  `conclusion` kroku).
- **Orca**: nie znaleziona w żadnym przejrzanym workflow. **Blokuje zakres**: czy jest podpięta gdzie indziej,
  działa na poziomie chmury, czy zastąpił ją Checkmarx One?

Dwie drogi: **A** — API każdego narzędzia (dokładnie, potrzebne nowe poświadczenia tylko do odczytu od
właścicieli Sonara/Checkmarx); **B** — tylko wyniki checków/jobów z GitHuba, tokenem, który ShipScope już ma
(czerwony = `failure`/`timed_out`/`action_required`, żółty = `skipped`/`neutral`/`cancelled`/brak świeżego
przebiegu, zielony = wszystko `success`). Dotychczasowa preferencja: zacząć od B. Otwarte: gdzie działa Orca;
które nazwy jobów/kroków liczą się jako „to” sprawdzenie.

## Zależności między komponentami

Od których śledzonych komponentów zależy dany komponent — do grafu zależności, rozjazdu między komponentami
(„wypromowany na prod, a jego zależność nie”) albo kolejności promocji. Niedodane, bo nic by tego jeszcze nie
czytało. Najpierw ustalić kierunek (zależy od / jest zależnością dla) i kto utrzymuje aktualność (dezaktualizuje
się po cichu).

## Insights: PR-y według etykiet

PR-y w repozytoriach aplikacji mają etykiety rodzaju zmiany; nic nie zbiera, co się z nimi dzieje po merge'u.
Surowe przeszło/nie przeszło CI na PR to domena Grafany/GitHuba; wartość jest w połączeniu etykiety z danymi
ShipScope:

- merge → `released` na prod według etykiety (czas dostarczenia per rodzaj zmiany);
- etykiety, które częściej kończą się wycofaniem albo omijają ścieżkę test → qa → prod (np. „hotfix”);
- per PI/komponent: PR-y z etykietą zmergowane vs. te, które w tym PI dotarły do `released`.

Potrzebne nowe źródło danych: ShipScope nie synchronizuje PR-ów. W serwerze webhook `pull_request` GitHub App
dostarczałby merge'e bez odpytywania. Otwarte: kształt danych i co znaczy „sukces” dla już zmergowanego PR.
