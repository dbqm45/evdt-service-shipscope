# Changelog

*English version: [CHANGELOG.md](CHANGELOG.md)*

Najważniejsze zmiany w ShipScope, od najnowszych. Projekt nie posiada numeracji wersji (jest to wewnętrzny
dashboard, nie publikowany pakiet), dlatego wpisy są pogrupowane według dat. Informacje o tym, czym jest
ShipScope, znajdują się w `README.pl.md`, pełne techniczne odniesienie w `CLAUDE.md` (po angielsku), a
wyjaśnienie sposobu liczenia poszczególnych wartości/badge'y w `FAQ.pl.md`.

## [0.2.19] - 2026-10-24

### Nowe

- **SHP:** scope flag sources to services and add per-service state (#76)

## [0.2.18] - 2026-10-24

### Nowe

- **SHP:** let ingest tokens expire and limit them to environments (#75)

## [0.2.17] - 2026-10-24

### Nowe

- **SHP:** guard the flags ingest with a rate limit and a lock wait limit (#73)

## [0.2.16] - 2026-10-23

### Nowe

- **SHP:** show Settings as pages with a sidebar (#71)

## [0.2.15] - 2026-10-23

### Nowe

- **SHP:** show Delivery summary as sprint list and sprint panel (#70)

## [0.2.14] - 2026-10-23

### Poprawione

- **SHP:** retry GitHub GETs on a 5xx or a network error (#66)

## [0.2.13] - 2026-10-23

### Poprawione

- **SHP:** resolve version=latest and suffixed versions to a tag (#65)

## [0.2.12] - 2026-10-23

### Poprawione

- **SHP:** refuse flag keys every object already has, like toString (#64)

## [0.2.11] - 2026-10-23

### Poprawione

- **SHP:** count an issue as deployed where all its blockers are (#62)

## [0.2.10] - 2026-10-23

### Nowe

- **SHP:** rename Release Notes to Delivery summary, PROD tile labels (#57)

### Poprawione

- **SHP:** count deployments naming only a sub-task for its Story (#58)

## [0.2.9] - 2026-10-19

### Poprawione

- **SHP:** link only safe URLs, add a CSP and read-only GitHub tokens (#53)

## [0.2.8] - 2026-10-18

### Nowe

- **SHP:** read TS and YAML flag files, flag lists and one file per env (#49)

## [0.2.7] - 2026-10-18

### Nowe

- **SHP:** show each flag source's last message and error in Settings (#47)

## [0.2.6] - 2026-10-18

### Nowe

- **SHP:** add the flags adapter (GitHub Action and CLI) (#46)

## [0.2.5] - 2026-10-18

### Nowe

- **SHP:** publish the flag ingest JSON Schema and sender guide (#45)

## [0.2.4] - 2026-10-17

### Nowe

- **SHP:** add npm run dev:mock and a settings gear in the header (#44)

## [0.2.3] - 2026-10-17

### Poprawione

- **SHP:** switch npm run dev to its own database when the old one is gone (#43)

## [0.2.2] - 2026-10-17

### Poprawione

- **SHP:** start the old shipscope-pg container in npm run dev (#42)

## [0.2.1] - 2026-10-17

### Nowe

- **SHP:** add npm run dev and drop the frontend's file mode (#41)

## [0.2.0] - 2026-10-17

### Niezgodne

- **SHP:** remove the file-based sync from this repository (#40)

## [0.1.22] - 2026-10-16

### Poprawione

- **SHP:** link Jira keys to each tenant's own site and remove dead code (#34)

## [0.1.21] - 2026-10-16

### Nowe

- **SHP:** guide new workspaces with a setup checklist and invite page (#32)

## [0.1.20] - 2026-10-16

### Nowe

- **SHP:** sync tenants fairly and pause only what hit a rate limit (#31)

## [0.1.19] - 2026-10-16

### Nowe

- **SHP:** manage flags in settings and link them to Jira issues three ways (#30)

## [0.1.18] - 2026-10-16

### Nowe

- **SHP:** let admins delete a workspace and all its data (#29)

## [0.1.17] - 2026-10-16

### Poprawione

- **SHP:** deploy the Render services from the repo root with migrations (#26)

## [0.1.16] - 2026-10-16

### Nowe

- **SHP:** sync on GitHub and Jira webhooks instead of waiting for the next pass (#25)

## [0.1.15] - 2026-10-16

### Nowe

- **SHP:** add a settings page for workspaces, GitHub, Jira and flags (#24)

## [0.1.14] - 2026-10-16

### Nowe

- **SHP:** sync Jira boards by release or by monthly Kanban flow (#23)

## [0.1.13] - 2026-10-16

### Nowe

- **SHP:** sync Jira boards in their own rhythm and open on every team's current increment (#22)

## [0.1.12] - 2026-10-16

### Poprawione

- **SHP:** list team-managed Jira boards for selection, not only Scrum ones (#21)

## [0.1.11] - 2026-10-16

### Poprawione

- **SHP:** request read:project:jira when connecting Jira (#20)

## [0.1.10] - 2026-10-16

### Nowe

- **SHP:** sync Jira issues from the boards a tenant chooses (FR-008, FR-009) (#19)

## [0.1.9] - 2026-10-16

### Nowe

- **SHP:** connect a tenant's Jira Cloud through Atlassian OAuth (FR-007) (#18)

## [0.1.8] - 2026-10-16

### Nowe

- **SHP:** accept feature flags pushed from named flag sources (contract v2) (#17)

## [0.1.7] - 2026-10-16

### Nowe

- **SHP:** record manual deploys and creators' display names in the server (#15)

## [0.1.6] - 2026-10-16

### Poprawione

- **SHP:** record the ref a rollback went back to as rollback.toRef (#14)

## [0.1.5] - 2026-10-16

### Nowe

- **SHP:** resolve deploy versions and environment drift in the server (#13)

## [0.1.4] - 2026-10-16

### Nowe

- **SHP:** serve the dashboard per tenant from the database (#11)

## [0.1.3] - 2026-10-16

### Nowe

- **SHP:** ingest deployments of tracked repos with per-tenant retention (FR-005) (#10)

## [0.1.2] - 2026-10-16

### Nowe

- **SHP:** connect GitHub App installations and choose tracked repos (FR-004) (#9)

## [0.1.1] - 2026-10-16

### Nowe

- **SHP:** invite members by link and remove members (FR-003) (#8)

## [0.1.0] - 2026-10-16

Pierwsze wydanie z numerem wersji. Od teraz każdy merge do `main` z commitem `feat`, `fix`, `perf` albo zmianą
niezgodną wstecz automatycznie dostaje kolejną wersję (zob. `RELEASING.md`); sekcje z datami poniżej są sprzed
wersjonowania.

### Nowe

- **SHP:** logowanie przez GitHuba, sesje i trasy HTTP w zakresie tenanta w `server/` (FR-001)
- **SHP:** automatyczne wersjonowanie: Conventional Commits, commit `chore(release)`, tag `vX.Y.Z` i GitHub Release na `main`

## 2026-10-16

- **Dodano: logowanie przez GitHuba w backendzie `server/` (FR-001).** Użytkownik loguje się przez GitHub App
  ShipScope, dostaje sesję po stronie serwera ważną 14 dni (w bazie tylko hash tokenu; token GitHuba nie jest
  zapisywany) i może przez HTTP założyć tenanta oraz zobaczyć jego członków (`/auth/github/login`, `/me`,
  `POST /tenants`, `GET /tenants/:id/members`). Backend używa teraz Fastify (ścisła walidacja wejścia) i
  `@fastify/cookie`. Row-Level Security na członkostwach jest zaostrzone: zapis tylko do tenanta, do którego
  zawężone jest żądanie, a użytkownik może wylistować własne tenanty. `DATABASE_SSL=false` pozwala użyć
  lokalnego Postgresa bez TLS. Wymaga `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` i `PUBLIC_BASE_URL`;
  konfiguracja w `server/README.md`.

## 2026-10-15

- **Wewnętrznie: enumy `ENVIRONMENT` / `SERVICE_TYPE` zastępują literały `'test'`/`'qa'`/`'prod'` oraz `'FE'`/`'BE'` w `docs/app-*.js`, bez zmiany zachowania.** Zamrożone obiekty w `app-core.js` o wartościach identycznych z danymi JSON (`ENVIRONMENT.PROD === 'prod'`); `ENVIRONMENTS` jest z nich zbudowane.
- **Wewnętrznie: markup prezentacyjny wydzielony do `docs/app-components.js`, bez zmiany zachowania.** Inline HTML,
  który siedział w każdym widoku (karty podsumowania, tagi, pille statusu, wiersze Epiców i issue, karty deployów,
  wiersze flag, wykresy słupkowe i kolumnowe, puste stany itd.), to teraz zestaw małych, czystych funkcji
  (`SummaryCard`, `Tag`, `StatusPill`, `EpicHeader`, `DeployCard`, `FlagRow`, `BarRow` ...), które przyjmują każdą
  wartość jako parametr i zwracają wynik `html`. Widoki tylko liczą dane i je wywołują, więc późniejsza migracja na
  framework to przepisanie jednego pliku. Ładowany zaraz po `app-core.js`; pokryty przez
  `test/app-components.test.js`.

## 2026-10-13

- **Wewnętrznie: wspólny rdzeń ingestu flag, bez zmiany zachowania.** Guard kolizji, scaffold `flags-meta.json`,
  idempotentny zapis stanów i wpisy historii, które `resolve-all-flag-states.js` i `sync-runtime-be-flags.js`
  miały każdy w swojej kopii, są teraz w `scripts/lib/flag-ingest.js` (z własnymi testami). To przygotowanie do
  przyjmowania wartości flag z innych źródeł niż pliki i URL-e; propozycja w `design-docs/FLAG-INGEST.pl.md`.
  Dodano `scripts/ingest-flags.js`, adapter z walidacją payloadu JSON na tym rdzeniu oraz composite action `.github/actions/ingest-flags`, którą repo serwisów mogą wywołać w kroku (opt-in; żaden istniejący workflow nie został zmieniony). Jedna kosmetyczna różnica: `resolve-all-flag-states.js` wypisuje teraz podsumowanie kolizji przed linią
  „Resolved…".

## 2026-10-12

- **Naprawiono: ogromne liczby „N behind TEST" dla komponentów wdrażanych na QA/PROD z branchy `deployment/*`.**
  Te branche zawierają tylko commity-wyzwalacze (`trigger.properties` → `version=v1.6.0`), więc drift liczył
  odległość w historii gita między commitami-wyzwalaczami na równoległych historiach (np. `evapl-service-frontend`:
  „1135 behind test", choć QA/PROD działały na tym samym kodzie `v1.6.0`). `"versionFile": "trigger.properties"`
  jest teraz ustawione w `docs/components.json` dla wszystkich sześciu komponentów, więc wersja, `resolvedRef`,
  `relatedIssues` i drift wynikają z taga wskazanego w pliku. Zadziała po scaleniu zmiany do `live` przez
  `sync-main-to-live.yml`; poprawione `version`/`relatedIssues` dostają tylko nowo zsynchronizowane deploymenty
  (starsze rekordy znikają przez `RETENTION_DAYS`). `test` wdraża sam commit z kodem (bez tego pliku), więc loguje
  oczekiwane ostrzeżenie i zostaje przy swoim tagu. Szczegóły: `design-docs/DRIFT-SAME-VERSION-DIFFERENT-SHA.pl.md`.
- **Dodano: notka dryfu „same version, different build".** Gdy dwa środowiska mają tę samą etykietę wersji, ale
  różne ref-y, karta środowiska pokazuje jedną notkę („A / B commits vs QA") zamiast „A behind" i „B skipped".
  Same liczby się nie zmieniają i nadal zasilają karty podsumowania i Insights. Zostaje jako zabezpieczenie dla
  komponentów bez `versionFile`.

## 2026-10-09

- **Wewnętrznie: kolejne refaktory, bez zmian w zachowaniu.** Czysta logika `sync-github-deployments.js`
  (retencja, plan, kursor, drift) trafiła do `scripts/lib/deployment-records.js` wraz z własnymi testami;
  szablon `html` (`docs/app-html.js`) escapuje teraz każdą wstawianą wartość we wszystkich widokach, więc
  zapomniane `escapeHtml()` nie może się zdarzyć; `renderMatrix()` i `renderIssues()` podzielono na małe funkcje
  o jednym zadaniu; a skrypty modyfikujące dane współdzielą `scripts/lib/json-file.js` (`readJson`/`writeJson`)
  zamiast powtarzać `JSON.parse(fs.readFileSync(...))`. `npm test` uruchamia teraz 61 przypadków.
- **Wewnętrznie: pokrycie testami podniesione do ok. 99,8% linii / ok. 97% gałęzi (ok. 360 przypadków).** Każdy
  skrypt, biblioteka i plik `docs/app-*.js` ma teraz testy: skrypty główne uruchamiane jako procesy potomne na
  atrapach `fetch`/serwera HTTP, pliki frontendu w `vm` z atrapą DOM. Rzeczywisty układ nadal nie jest
  weryfikowany (atrapa DOM nie parsuje HTML).
- **CI: `test.yml` uruchamia `npm test` na każdym pull requeście i przy pushu do `main`.**
- **Naprawiono: przełączenia flag nigdy nie wpływały na datę „ostatniej zmiany" zadania.** `issueEnvDate()` czytał
  `changedAt` z surowego wpisu środowiska zamiast z rozwiązanego stanu `build`/`runtime-be`, więc zawsze było to
  `undefined`, a datę zmieniały tylko wdrożenia. Teraz używa `effectiveFlagState()`, co wpływa na filtr zakresu dat
  w widoku Product i wszystko oparte na `issueLastChange()`.
- **Wewnętrznie: `scripts/sync-jira.js` podzielony na moduły; wspólne helpery CLI.** Ponad 2200-liniowy skrypt jest
  teraz cienkim orkiestratorem nad `scripts/lib/jira-{config,pi,jql,spaces,boards,issues,shards}.js`, a zduplikowane
  `fail`/`safeRelativePath` ze wszystkich skryptów trafiły do `scripts/lib/cli.js`. Bez zmian w zachowaniu.
- **Wewnętrznie: pierwsze testy automatyczne i podział `docs/app.js` na `docs/app-*.js`.** `npm test` uruchamia
  40 przypadków `node:test` (bez zależności) dla `scripts/lib/jira-*.js`, `cli.js`, `extract-flags.js`
  i `flag-history.js`. Plik `app.js` (~3200 linii) to teraz osiem klasycznych plików `<script>` (`app-core` …
  `app-main`) ładowanych po kolei przez `index.html`; po sklejeniu są bajt w bajt identyczne ze starym plikiem,
  więc zachowanie się nie zmienia, a fallback przez `file://` nadal działa.
- **Poprawki z przeglądu skryptów.** `sync-github-deployments.js`: nieudane zapytanie `/actions/runs` jest teraz
  cache'owane (omijało limit zapytań na przebieg i było ponawiane dla każdego deploymentu), deduplikacja stron nie
  buduje już zbioru kluczy od nowa przy każdej stronie, a uszkodzony plik cache jest ignorowany zamiast psuć każdy
  retry. `backfill-flag-state-history.js`: commit, w którym `flag-states.json` nie istnieje lub jest nieczytelny,
  jest pomijany (wcześniej traktowany jak „pusty”, przez co następny commit logował wszystkie flagi jako zmienione).
  `prune-jira-pis.js` używa wspólnego `writePrunedPis` (ta sama kolejność i format co sync), więc oba przestają
  nadpisywać nawzajem swój plik.

## 2026-10-07

- **Wiersze w macierzy widoku technicznego dopasowują teraz wysokość między TEST/QA/PROD, nawet gdy jeden
  wiersz urośnie wyżej niż inne.** `.comp-row` miał dotąd sztywną `height:70px`; teraz jest to
  `min-height:70px`, więc wiersz, którego treść faktycznie potrzebuje więcej miejsca (np. dwie zawinięte
  notatki o driftcie), może urosnąć ponad ten minimum, a nie zostać przycięty. Ponieważ każda karta
  środowiska renderuje swoją kolumnę wierszy niezależnie, taki wzrost dotąd rozjeżdżał wyrównanie wierszy w
  momencie, gdy jedna wersja danego wiersza potrzebowała więcej miejsca niż inne — `renderMatrix()` mierzy
  teraz wysokość każdego wiersza danego komponentu we wszystkich trzech kartach środowisk po wyrenderowaniu
  i ustawia wszystkie na wysokość najwyższego z nich, więc wiersz QA o wysokości 90px podciąga odpowiadające
  mu wiersze w TEST/PROD również do 90px, zachowując wyrównanie macierzy wiersz do wiersza.

- **Naprawione: wiersze macierzy, które urosły ponad 70px, nie miały paddingu z góry i z dołu.**
  `.comp-row` miał `padding:0 12px` — zero paddingu w pionie — więc wiersz, którego treść urosła np. do
  78,4375px, przylegał do własnych krawędzi bez żadnego odstępu; wyższy wiersz (np. 90px) wyglądał dobrze
  tylko przypadkiem, dzięki luzowi pożyczonemu z opisanego wyżej mechanizmu wyrównania wierszy, a nie
  dzięki własnemu paddingowi. Zmienione na `padding:10px 12px`; jednoliniowe wiersze są bez zmian, bo
  istniejący `min-height:70px` już i tak przewyższa treść+padding w ich przypadku.

- **Notatki o drifcie „N behind ENV” / „N commit(s) skipped ENV” w macierzy widoku technicznego tłumaczą się
  teraz same.** Każdy `.drift-note` ma teraz prosty, zrozumiały `title="..."` (`driftNoteTooltip()`, ten sam
  wzorzec co tooltipy pigułek statusu), a nowy wiersz `.drift-legend` nad macierzą od razu wyjaśnia obydwa
  znaczenia. Realny przypadek produkcyjny potwierdził, że „skipped” jest prawdziwym sygnałem, nie fałszywym
  alarmem wynikającym z różnego tempa wydań: dwa środowiska pokazały ten sam ciąg wersji dwie minuty od
  siebie, ale każde rozwiązało go do innego commita z zupełnie nieprzecinającym się zestawem zadań Jira, a
  późniejszy commit nigdy nie przeszedł przez wcześniejsze środowisko. Ten przykład jest opisany w
  `FAQ.pl.md`, nie pokazany w samym UI — tabelka przypisana do jednego, konkretnego, przeszłego deploymentu
  stałaby się nieaktualna, gdy ten rekord zostanie wytrymowany przez `RETENTION_DAYS`.

## 2026-10-06

- **`check-flags-metadata.js`/`check-flags.yml` dostały opcjonalny tryb `WARN_ONLY`.** Domyślnie krok
  "Check flag metadata completeness" wciąż przerywa build (exit 1), gdy odkryty flag nie ma kompletnego
  wpisu w `flags-meta.json` — bez zmian. Przekazanie `WARN_ONLY: true` do reużywalnego workflow
  `check-flags.yml` zamiast tego loguje każdy problem jako annotację `::warning::` i kończy się kodem 0,
  więc ten krok nigdy nie blokuje merge'a. Myślane dla onboardingu nowego komponentu: jego pierwsze flagi
  są z definicji niekompletne, a sztywna blokada CI zablokowałaby merge czegokolwiek, aż metadane zostaną
  uzupełnione.

- **Pozycje Release Notes pokazują teraz plakietkę statusu PROD, numer Jiry i datę pierwszego wdrożenia na
  prod.** Każda pozycja ma teraz dwa wiersze: tytuł + plakietka statusu PROD, a pod nim numer Jiry
  (nieklikalny `<span class="tag mono">`, ten sam styl, który Product View już używa dla numeru w wierszu —
  nie klikalny chip `.issue-badge`, bo tytuł jest już linkiem do Jiry) + data pierwszego wdrożenia na prod
  (z `earliestProdDeployedAt()`, tej samej funkcji, z której korzysta
  wykres lead time w Insights). Plakietka korzysta z tych samych funkcji `statusLabel()`/`statusClass()`/
  `statusLabelTooltip()`, które widok techniczny już używa, i łączy dwa różne, realne stany PROD w jedno
  sprawdzenie "czy to w ogóle wydane" — `released` (flaga potwierdza, że element jest faktycznie widoczny)
  vs. `deployed_code_only` (kod został wgrany, ale nie ma żadnej flagi, która by to potwierdzała) — i do
  teraz czytelnik nie miał sposobu, by rozpoznać, który z tych dwóch stanów dotyczy danej pozycji. Plakietki
  TEST/QA wciąż celowo się nie pojawiają — "released" już oznacza "żyje na PROD", więc byłyby redundantne.

- **`docs/index.html` wczytuje teraz z wyprzedzeniem (preload) każdy plik `data/*.json`, który `loadData()`
  w `app.js` pobiera przy starcie.** `<link rel="preload" href="..." as="fetch" crossorigin>` mówi
  przeglądarce, by zaczęła ściągać te pliki już w trakcie parsowania `<head>`, zamiast czekać, aż `app.js`
  się pobierze, sparsuje i wykona pierwsze wywołanie `fetch()` — dzięki temu w momencie, gdy `loadData()`
  faktycznie o nie poprosi, część z nich jest już w trakcie pobierania albo gotowa. Atrybut `crossorigin`
  jest wymagany mimo że to zapytania same-origin — preload zostanie ponownie użyty przez późniejsze
  `fetch()` tylko wtedy, gdy obu zapytaniom zgadza się tryb (mode), a `fetch()` domyślnie używa trybu CORS.
  Jedyny wyjątek to shard danej PI z Jiry (`data/jira-issues/{pi}.json`) — nazwa tego pliku nie jest znana,
  dopóki nie wróci `index.json`, więc nie można jej wpisać do statycznego podpowiedzenia preload.

- **`sync-github-deployments.js` zapisuje teraz również mały, wstępnie wyliczony `docs/data/summary.json`
  — szybką ścieżkę dla pierwszego renderu widoku technicznego.** `currentVersion()` w `docs/app.js`
  (wywoływana raz dla każdego komponentu i raz dla każdej pary komponent×środowisko podczas pierwszego
  renderu — karty podsumowania i matryca komponent×środowisko) zawsze na nowo przeszukiwała cały
  (potencjalnie duży) listę `state.deployments` i sortowała wyniki, przy każdym wywołaniu.
  `summary.json` zawiera `{ components: { [komponent]: { [env]: { current, latestOverall } } } }`,
  budowane z tych samych map `latestOverall`/`latestSuccess`, które `trimOldRecords()` i tak już liczy przy
  każdej synchronizacji (bez nowych zapytań do API, bez nowych obliczeń) — `currentVersion()` czyta to
  teraz jako odczyt O(1) i wraca do starego pełnego przeszukania tylko wtedy, gdy danego komponentu/środowiska
  nie ma w tym pliku (nowo dołączony komponent, albo plik niedostępny/nieobecny). To wstępnie wyliczony
  cache, nie nowe źródło prawdy — dashboard w razie jego braku zachowuje się tak jak dotychczas, a plik jest
  w całości zapisywany na nowo przy każdej synchronizacji, w ten sam idempotentny sposób, w jaki już dziś
  zapisywany jest `deployments.json` (uruchomienie, w którym nic się nie zmieniło, daje bajt-identyczny
  wynik, więc nic nie trafia do commitu). Dlaczego to jest wstępnie wyliczane po stronie serwera, a nie na
  bieżąco w przeglądarce — patrz `FAQ.pl.md`.

- **`sync-github-deployments.js` korzysta teraz z zapytań warunkowych (ETag) dla trzech endpointów
  listujących GitHuba, odpytywanych na każdym uruchomieniu niezależnie od tego, czy coś się zmieniło
  (pierwsza strona `/deployments`, `/tags`, `/releases`).** Odpowiedź `304 Not Modified` nie liczy się do
  limitu zapytań GitHuba tak jak prawdziwe `200` — więc uruchomienie crona w stanie "nic się nie zmieniło"
  dla wszystkich śledzonych komponentów (częsty przypadek — większość komponentów nie ma nic nowego między
  uruchomieniami) zużywa teraz znacznie mniej ze wspólnego limitu. `scripts/lib/github-api.js`
  (`githubApiRequest`/`githubApiGet`) przyjmuje opcjonalny, należący do wywołującego obiekt `etagCache`;
  job `sync_deployments` w `orchestrate-full-sync.yml` dołącza krok `actions/cache` (kluczowany po
  komponencie, poza oboma checkoutami gita) wokół nowej zmiennej środowiskowej `GITHUB_API_ETAG_CACHE_DIR`,
  żeby cache faktycznie przetrwał między uruchomieniami, a nie tylko w ramach ponawiania jednego joba.
  Zakres celowo ograniczony do tych trzech endpointów listujących — wywołania per-deployment
  (`/commits/{sha}`, `/compare/...`, `/deployments/{id}/statuses`, `/actions/runs/{id}`) trafiają w URL-e
  praktycznie niezmienne po ich powstaniu i, dzięki kursorowi synchronizacji, są normalnie pobierane tylko
  raz w całym cyklu życia tego skryptu — nie ma więc tam nic, względem czego cache'owany ETag mógłby
  weryfikować aktualność.

- **Zbadano otwarte pytanie o błąd 401 z Jira Agile API, pozostawione od 2026-10-05 — wykluczono problem
  z trasowaniem URL, wskazano na dziurę w koncie/poświadczeniach po stronie Atlassiana.** Zgodnie z
  artykułem z bazy wiedzy Atlassiana o błędach 401 dla kont serwisowych, jego główna teoria (klasyczna
  domena instancji vs. proxy `api.atlassian.com/ex/jira/<cloudId>`, którego wymagają niektóre tokeny kont
  serwisowych) została ręcznie przetestowana i wykluczona: `JIRA_BASE_URL` tego repo już *jest* w formie
  proxy, a odpytanie przez ten sam URL zarówno `project/search`, jak i `/rest/agile/1.0/board` dało
  identyczny podział wyników (200 vs. 401) — więc błąd dotyczy konkretnie autoryzacji Agile API, nie
  trasowania zapytań. Prawdopodobna przyczyna zwężona teraz do jednej z dwóch spraw po stronie
  Atlassiana, żadna nie jest błędem w `sync-jira.js`: token API konta serwisowego typu **scoped**, który
  nigdy nie otrzymał osobnych zakresów Jira Software/Agile, albo brak przypisanej kontu faktycznej roli
  produktowej/licencji Jira Software. `JIRA_BOARD_LOOKUP_STRICT` pozostaje przy domyślnym trybie
  soft-degrade, dopóki administrator Jiry nie potwierdzi/naprawi tokenu lub konta — włączenie flagi to
  wtedy zmiana jednej linijki zmiennej środowiskowej, nie zmiana kodu. `ONBOARDING.md`/`ONBOARDING.pl.md`
  zyskały notatkę o diagnozowaniu w sekcji konfiguracji konta Jira, wskazującą ten sam artykuł z bazy
  wiedzy oraz konkretną listę kontrolną, żeby przyszły onboarding natrafiający na ten sam symptom nie
  musiał wyprowadzać diagnozy od zera.

## 2026-10-05

- **Przegląd drobnych usprawnień: walidacja wejścia, timeouty i poprawka poprawności wykrywania drift.**
  `update-flag-state.js` odrzuca teraz wartości `FLAG_KEY` równe `__proto__`/`constructor`/`prototype`
  (wektor zanieczyszczenia prototypu) i wymaga, by `ENABLED` było dokładnie ciągiem `"true"` lub `"false"`,
  zamiast rzutować cokolwiek "prawdziwego" (truthy). Zapytanie do endpointów flag w
  `sync-runtime-be-flags.js` ma teraz konfigurowalny timeout (`FETCH_TIMEOUT_MS`, domyślnie 30s, przez
  `AbortSignal.timeout()`) zamiast możliwości wiecznego zawieszenia na nieodpowiadającym endpointcie BE.
  Każdy job w każdym pliku `.github/workflows/*.yml` deklaruje teraz `timeout-minutes` (15 dla prostych
  jednorazowych jobów, 30 dla jobów z paginacją/retry-loopem/matrycą, 10 dla mergowania `main`→`live`) —
  wcześniej żaden job go nie miał, więc zawieszony step mógł działać do domyślnego limitu GitHub (360
  minut). Job `sync_jira` w `orchestrate-full-sync.yml` używa teraz `if: ${{ !cancelled() }}` zamiast
  `if: always()` — wciąż uruchamia się po niezwiązanej awarii synchronizacji wdrożeń jednego komponentu
  (pierwotna intencja), ale poprawnie pomija się, gdy człowiek wyraźnie przerwie cały przebieg.
  `computeEnvDrift()` w `sync-github-deployments.js` rozróżnia teraz "porównanie się powiodło, brak driftu"
  od "wywołanie porównania się nie powiodło" — przejściowy błąd API GitHub był wcześniej nie do odróżnienia
  od prawdziwego "wszystko czyste", co bezszelestnie zerowało istniejącą, wciąż realną wartość
  `driftBehind`. Dwa zapisy JSON (`update-flag-state.js`, oba zapisy w `prune-jira-pis.js`) nie miały
  końcowego znaku nowej linii, który mają wszystkie inne zapisy w pozostałych skryptach; teraz jest to
  konsekwentne.
- **`docs/style.css` nie ma już żadnego zahardkodowanego koloru poza definicjami tokenów.** Pozostałe
  wartości hex/rgba rozsiane po selektorach (obramowania status-badge, tło hover powtórzone w ~10
  regułach, `.comp-avatar`, `.pv-pi-card`, `.pv-tile`/`.pv-filters`/`.wi-table`, `.wi-type`, tytuły
  epików/dzieci, tło linii drzewa, `.breakdown`, zestaw `.badge-bug`/`.badge-task`/`.badge-story`/
  `.badge-epic` oraz kilka dodatkowych znalezionych w trakcie przeglądu — kolor hover `.tab`/`.run-badge`,
  obramowania `.summary-card`/`.flag-row`/`.wi-head`/`.wi-epic-row`, `.st-none`, `.status-date`,
  `.legend-dot.st-none`) są teraz zmiennymi CSS (custom properties), zgodnie z istniejącą w pliku
  konwencją nazewniczą `--nd-*`/zwykłe `--*`, z wartościami dla trybu ciemnego w `:root` i dla trybu
  jasnego w `html[data-theme="light"]`. Czysty refaktor — żaden renderowany kolor się nie zmienił. Przegląd
  uzupełniający zamknął pozostałą dziurę: ~20 odcieni `rgba()` w selektorach z sekcji "legacy", które ten
  pierwszy przegląd celowo pominął (pigułki panelu Feature flags, tagi statusu work-item, badge rollback/
  issue) — np. `.flag-on`/`.flag-off`, `.st-released`/`.st-deployed`/`.st-partial`/`.st-dependency`,
  `.tag-status-*`, `.rollback-badge`. Większość z nich odpowiadała dokładnie wartości hex istniejącego
  tokenu w trybie ciemnym przy danej przezroczystości (`--fail`/`--rollback`/`--nd-ok`/`--nd-code`/
  `--nd-dependency`/`--nd-warn`/`--nd-link`), więc ich nowe zmienne mają wyliczoną na nowo wartość dla
  trybu jasnego — drobne, zamierzone usprawnienie wyglądu w trybie jasnym, nie bajt-po-bajcie identyczne
  z poprzednim stanem. Dwie zmienne bez czystego odpowiednika w istniejącym tokenie (`--rollback-badge-bg`/
  `-border`, `--flag-off-bg`) zachowują identyczną wartość w obu trybach, dokładnie tak jak zachowywał się
  ich oryginalny literał. Literalny biały kolor `#ECEEF1` używany w wypełnionych słupkach 3-słupkowej
  ikony etapu środowiska pozostaje jedynym, udokumentowanym zamierzonym wyjątkiem.
- **Przegląd pod kątem bezpieczeństwa.** `renderDeployGroupCard()` w `docs/app.js` wstawiał nazwę
  wyświetlaną `deployedBy` wprost do `innerHTML` bez żadnego escapowania — realna dziura stored-XSS, bo ta
  nazwa pochodzi spod kontroli atakującego (nazwa wyświetlana profilu GitHub), w przeciwieństwie do
  sąsiedniego, już poprawnie escapowanego `renderDeployCard()`. Klucze issue Jiry były escapowane w
  niektórych miejscach renderowania (wierszach issue, nagłówkach epików), ale nie we wszystkich (chipy
  issue na karcie deployu, wiersze Release Notes); teraz jest to konsekwentne wszędzie, również wewnątrz
  atrybutów `href`. `check-flags.yml` i `retrigger-app-checks.yml` deklarują teraz wyraźny blok
  `permissions: contents: read` (każdy zapis w obu idzie przez osobny token GitHub App). Dispatch
  `deployment-completed` w `notify-deployment.yml` buduje teraz payload JSON przez `jq -n --arg` zamiast
  ręcznej interpolacji w bashu.
- **Synchronizacja deploymentów faktycznie teraz zbiega do końca przy dużym backlogu**, a nie wiecznie
  odpytuje i przetwarza to samo. `sync-github-deployments.js` trwale pomija (z głośnym ostrzeżeniem)
  deployment zablokowany bez statusu końcowego dłużej niż `STUCK_DEPLOYMENT_MAX_AGE_HOURS` (domyślnie 48h)
  — wcześniej jeden opuszczony pipeline mógł trwale zablokować kursor synchronizacji poniżej siebie, co
  zmuszało każdy nowszy deployment do ponownego pobierania i przetwarzania przy pełnym koszcie API w każdym
  przyszłym przebiegu, mimo że był już zapisany i tylko deduplikowany przy zapisie. Paginacja
  `/deployments` zatrzymuje się teraz, gdy dojdzie do już zsynchronizowanych ID, zamiast zawsze przechodzić
  całą historię, a nowy `MAX_NEW_DEPLOYMENTS_PER_RUN` (domyślnie 200) ogranicza liczbę nowych deploymentów
  rozwiązywanych w jednym przebiegu — od najstarszych, więc ograniczony przebieg wciąż robi postęp, a
  kursor przesuwa się tylko tak daleko, jak faktycznie udało się przetworzyć w tym przebiegu.
- **Współdzielone helpery do obsługi rate-limitów.** `scripts/lib/github-api.js` i
  `scripts/lib/jira-api.js` wydzielają logikę backoffu na 429/wtórny rate-limit, która wcześniej istniała
  niekonsekwentnie, tylko w `sync-github-deployments.js`. Teraz używają jej też `backfill-deployment-
  metadata.js` (który wcześniej nie miał żadnej obsługi rate-limitów, mimo wykonywania seryjnych wywołań
  API na rekord) oraz `retrigger-app-checks.js`/`sync-jira.js`.
- **Mniejsze poprawki poprawności.** Backfill `version` w `backfill-deployment-metadata.js` ustawia teraz
  też `resolvedRef`, żeby kolejny sync nigdy nie użył do `/compare` niezweryfikowanego ref'a; rozwiązywanie
  statusu w tym samym skrypcie znajduje teraz pierwszy status *końcowy* zamiast brać na ślepo najnowszy
  (który może być nie-końcowym markerem `inactive`). `update-flag-state.js` zachowuje teraz istniejące pole
  `component` rekordu, zamiast je gubić, co po cichu obchodziło zabezpieczenie przed kolizją między
  komponentami, na którym opierają się inne skrypty. `status-index.json` w `sync-jira.js` zachowuje teraz
  *pierwsze* (najnowsze PI) wystąpienie klucza w shardach, zamiast dawać wygrać temu PI, który jest
  przetwarzany jako ostatni. `STATUS_REPO_EDIT_URL` w `check-flags.yml` wskazuje teraz na `live` (gdzie
  `flags-meta.json` ma realną treść) zamiast na nieaktualne dane z `main`.
- **Naprawiono realny błąd utraty danych: cicha przerwa między sprintami mogła wyczyścić większość
  issue'ów PI.** Gdy żaden skonfigurowany board nie miał aktywnego sprintu — zwykła przerwa między
  sprintami albo literówka w nazwie boarda — domyślny sync spadał do wąskiego skanu po issue'ach
  odwołanych w commitach, a ten wynik *w pełni zastępował* istniejący shard PI, zamiast się do niego
  scalić, gubiąc każdy issue nieodwołany w żadnym niedawnym commicie. Naprawione dwoma sposobami: bieżące
  PI jest teraz rozwiązywane także z najbliższego nadchodzącego sprintu, a w razie jego braku z ostatnio
  zamkniętego (dane sprintów są już pobrane do tego celu, bez nowych wywołań API), co zamyka większość tej
  przerwy samo w sobie; a jedyna pozostała ścieżka fallbackowa teraz scala się z istniejącym shardem po
  kluczu issue, zamiast go bezwarunkowo zastępować.
- **Błędy konfiguracji `docs/jira-spaces.json`, które po cichu wyłączały scoping zespołowy, są teraz
  wykrywane.** Źle sformowany wpis (pole złego typu) rzuca teraz czytelny błąd nazywający space i problem,
  zamiast po cichu stosować zerowe filtrowanie. Wpis z pustą tablicą `boards` i brakiem `teams` loguje
  teraz ostrzeżenie z tego samego powodu.
- **Naprawiono dwie dziury w scopingu zespołowym działające w przeciwnych kierunkach: poprawny element
  mógł zostać wykluczony, a niepoprawny mógł się przedostać.** Dopasowany sprint z własnego skonfigurowanego
  boarda zespołu nie jest już przesłaniany przez niezgodną, niedopasowaną wartość pola `Team` w Jirze
  (sprawdzane teraz po wszystkich wartościach, gdy pole ma ich więcej niż jedną) — wcześniej issue siedzący
  we własnym aktywnym sprincie zespołu mógł zostać odrzucony przez przypadkowe pole Team. I odwrotnie: issue
  trafiający do wyników boardowanego space'a wyłącznie przez wspólną etykietę `PI-X.Y` — bez dopasowanego
  sprintu i bez żadnego dowodu Team/etykieta — jest teraz wykluczany, zamiast przechodzić bez filtrowania
  (Epik z choć jednym dzieckiem w zakresie wciąż zostaje, żeby jego nagłówek nie zniknął). Dopasowanie
  sprintu po nazwie boarda wymaga teraz też granicy słowa, więc board o nazwie np. "Spark" nie dopasuje się
  już do sprintu "Sparkle 27.3.1".
- **Space skonfigurowany tylko przez `teams` (bez `boards`) jest teraz faktycznie objęty zwykłym syncem**,
  nie tylko ręcznymi backfillami — po rozwiązaniu bieżącego PI z boardów innych space'ów, każdy space
  skonfigurowany wyłącznie przez `teams` jest teraz również odpytywany o to PI.
- **Pigułki statusu w Product view zyskały zrozumiałe dla biznesu tooltipy oraz legendę**, żeby czytelnik
  nietechniczny nie musiał już znać słownictwa tego dashboardu dla "ukryte"/"częściowe"/"tylko kod
  wdrożony", żeby zrozumieć, co znaczy pigułka. Wiersz, którego issue przeniósł się od tego czasu do innego
  PI (według zawsze aktualnego `status-index.json`), pokazuje teraz badge "Continued in PI-X", żeby status
  zamrożony ze starszego syncu nie został pomylony z bieżącym.

## 2026-09-30 do 2026-10-02

- **Synchronizacja Jiry przeprojektowana wokół zasady "pokazuj bieżący, realny stan — nie bądź archiwum
  historii."** Dotychczas domyślny sync scalał "co się ostatnio zmieniło" w całym projekcie, co oznaczało,
  że issue, który wypadł ze swojego PI, mógł stać się trwałym "duchem", jeśli logika scalania go kiedyś
  przeoczyła. Domyślny przebieg robi teraz **pełne nadpisanie** tylko shardu rozwiązanego bieżącego PI
  (`docs/data/jira-issues/{PI}.json`) przy każdym uruchomieniu — issue, który wypadł, jest po prostu
  nieobecny w nowym wyniku fetchu, bez osobnego kroku czyszczącego. Każdy inny PI jest teraz wyraźnie
  snapshotem z danego momentu, zasilanym tylko przez ręczny workflow `backfill-jira-issues.yml`, nigdy
  automatycznie nieodświeżanym. `resolveSpacesConfig()` teraz **rzuca wyjątek** przy nieudanym fetchu listy
  projektów Jiry, zamiast po cichu degradować się — ta cicha degradacja kierowała wcześniej przejściowy
  błąd Jiry do destrukcyjnego trybu pełnego nadpisania, wymazując każdy shard PI; `writePiShards()` teraz
  też odmawia usunięcia istniejących shardów, jeśli przebieg w trybie `'full'` rozwiąże zero PI, podczas
  gdy na dysku istnieją już dwa lub więcej — zamiast tego loguje ostrzeżenie. Nowy
  `docs/data/jira-issues/status-index.json` (płaska, cross-PI mapa `key -> {pi, statusCategory}`,
  przebudowywana w całości przy każdym przebiegu) pozwala panelowi Flags w Technical View rozwiązać status
  issue niezależnie od tego, który konkretnie PI jest akurat wczytany w Product View. `extractPiFromLabel()`
  akceptuje teraz też etykietę w formie z sufiksem sprintu `PI-27.3.1`, nie tylko `PI-27.3`.
- **Historia deploymentów ma teraz okno retencji, zamiast rosnąć w nieskończoność.**
  `sync-github-deployments.js` fizycznie przycina `deployments.json` do ostatnich `RETENTION_DAYS`
  (domyślnie 90), z wyjątkiem jednego najnowszego i jednego najnowszego-udanego rekordu per
  komponent/środowisko, które zostają niezależnie od wieku, żeby logika "aktualnej wersji"/drift/rollback
  nigdy się nie złamała. Nowy, nigdy nieprzycinany `docs/data/deployments-cursor.json` śledzi najwyższe ID
  deploymentu kiedykolwiek zsynchronizowane per komponent, żeby przycięty deployment nie wyglądał znowu
  jako "nowy" przy przyszłym przebiegu i nie płacił ponownie pełnego kosztu API. Naprawiono też: status
  `inactive` deploymentu z GitHuba (dopisywany, gdy kolejny deployment na tym samym środowisku się
  powiedzie) mógł maskować jego realny wynik i powodować, że całkowicie znikał z `deployments.json`;
  `mapEnvironment()` mógł błędnie klasyfikować `preprod`/`pre-prod` jako `prod` przez zbyt swobodne
  dopasowanie substringu; limit 250 commitów w porównaniu GitHuba teraz loguje ostrzeżenie, zamiast po
  cichu gubić powiązane issue poza tym limitem.
- **Panel Deployment History w Technical View domyślnie pokazuje "Last 90 days"**, z opcjami "Last 30/60
  days" oraz "All time" też do wyboru — filtr czysto wizualny, niezależny od (ale domyślnie zgodny z) okna
  retencji po stronie serwera opisanego wyżej.
- **Product View: nowa kontrolka zakresu Sprintu**, umieszczona przy globalnym selectorze PI w nagłówku
  (widoczna tylko na Product View, bo Release Notes/Insights z niej nie korzystają), a nie wymieszana w
  zwykłym rzędzie filtrów Type/Priority/data. Zawęża wczytany PI do jednego sprintu, albo z powrotem do
  "All sprints"; domyślnie wybiera sprint obejmujący *dzisiaj*, oznaczony "Current sprint (nazwa)" — nie
  osobny duplikat z sufiksem `(current)`, po zgłoszonym błędzie, w którym obie wersje pokazywały się jako
  odrębne opcje. Trzecia opcja, "Current sprint + unresolved", pokazuje elementy bieżącego sprintu
  niezależnie od statusu plus elementy ze starszych sprintów tego samego PI, które jeszcze nie są
  wydane — hybrydowy zakres zarekomendowany podczas przeglądu projektowego Product View, dodatkowy do
  (nie zamiast) domyślnego zachowania.
- **Cztery nowe sygnały Product View z tego samego przeglądu projektowego:** alert starzenia "ghost flag"
  (⏳, `GHOST_FLAG_DAYS = 30`) na każdym work itemie wdrożonym na prod z flagą wciąż off/partial powyżej
  progu, w zakresie aktualnie widocznego PI/epika, bez skanu cross-PI; badge "🐞 open bug" w nagłówku epika,
  gdy wśród dzieci w zakresie jest nierozwiązany Bug; toggle "Hide Tasks", niezależny od istniejącego
  filtra Type; oraz work itemy w rozwiniętym Epiku (i "Ungrouped") sortują się teraz Bug → Story → Task,
  zgodnie z kolejnością opcji w filtrze Type. Obie nowe badge'e używają inline SVG (`ICONS.hourglass`/
  `ICONS.bug`), zgodnie z resztą ikon w aplikacji, nie emoji.
- **Badge PI usunięty z każdego wiersza/nagłówka epika w Product View** — pokazywany teraz tylko raz, w
  selekcie PI w nagłówku, zamiast powtarzany na każdym wierszu.
- **Nowy, jednorazowy skrypt `prune-jira-pis.js`** (`prune-jira-pis.yml`, ręczny): trwale usuwa wskazane
  shardy PI i ich wpisy w `index.json`. Shardy PI inaczej akumulują się w nieskończoność z zamierzenia (ten
  sam duch "wystarczająco tanie, żeby po prostu wszystko trzymać" co `flag-state-history.json`) — to jedyny
  sposób, w jaki stary shard kiedykolwiek zostaje usunięty, i odmawia usunięcia PI, który jest aktualnie
  `currentPi`.
- **Wzmocnienie bezpieczeństwa workflowów.** Każdy workflow mutujący dane teraz checkoutuje `main` (kod) i
  `live` (dane) do osobnych ścieżek, dzięki czemu `live` — ciągle mutowany przez boty i osiągalny przez
  współdzielone poświadczenie `SHIPSCOPE_APP` każdego repozytorium aplikacji — nigdy nie może być źródłem
  *wykonywalnego* kodu; kilka workflowów wcześniej odpalało skrypty prosto z `live`. Pola wejściowe
  `.github/actions/sync-with-retry` inne niż samo `run` teraz przechodzą przez `env:` + `"$VAR"` zamiast
  bezpośredniej interpolacji `${{ }}` do skryptu shell, zamykając ścieżkę shell-injection przez wolny tekst
  wejścia `workflow_dispatch`. `notify-deployment.yml` teraz też weryfikuje, że repozytorium wywołujące
  dispatch faktycznie zgadza się z nazwą `component`, którą deklaruje.
- **Dokumentacja:** `ONBOARDING.md`/`.pl.md` zyskały nową sekcję "wymagania wstępne na poziomie ShipScope"
  (aplikacje GitHub Apps, konto/token Jiry i uprawnienia potrzebne, zanim jakikolwiek komponent będzie
  można w ogóle dodać) przed istniejącą checklistą per komponent. `FAQ.md`/`.pl.md` zyskały dwa nowe wpisy
  o tym, jak dokładnie dane Jiry/deploymentów są podzielone na pliki, synchronizowane, i jak długo trwa,
  zanim zmiana stanie się widoczna. Dodano `design-docs/PRODUCT-VIEW-NOTES.md`/`.pl.md` oraz
  `design-docs/PRODUCT-VIEW-IMPLEMENTATION-PLAN.md`/`.pl.md` — analizę rozbieżności i rozpisany na fazy
  plan wdrożenia, syntetyzujące sesję ideation SAFe PM/PO względem aktualnego projektu Product View.
- **Naprawiony realny incydent produkcyjny: poprawnie wyliczony sync Jiry mógł mimo to nie zacommitować
  się.** `.github/actions/sync-with-retry`'s `git add $SWR_PATHS` dodawał wszystkie skonfigurowane
  ścieżki w jednym wywołaniu — jeśli choć jedna z nich nie istniała na dysku *i* nigdy nie była śledzona
  przez git (potwierdzone: ścieżka czyszcząca legacy `docs/data/jira-issues.json`, która na `live` po
  prostu nigdy nie istniała), `git add` pada z "did not match any files" i nie stage'uje **nic**, w tym
  każdej innej, poprawnej ścieżki z tego samego wywołania — po cichu gubiąc commit skądinąd udanego syncu.
  Teraz dodaje ścieżki jedna po drugiej, pomijając tylko te, które nie istnieją i nie są śledzone, wciąż
  poprawnie stage'ując realne usunięcie czegoś, co *było* śledzone.
- **Naprawiony przeciek danych między zespołami: epik innego zespołu mógł pojawić się na dashboardzie.**
  Znalezione na produkcji — "Unified reimbursement front-end application" (epik innego zespołu)
  synchronizował się pod właściwym numerem PI, bo Epiki zwykle nie mają wypełnionego pola Sprint wcale
  (ich PI bierze się z etykiety), więc dodany wcześniej w tym oknie czasowym check po nazwie boarda w
  sprincie nigdy się dla nich nie odpalał, a cały ART dzieli jedną numerację PI niezależnie od zespołu.
  Dodano drugi, niezależny check względem pola `Team` samej Jiry (rozwiązywanego po nazwie pola, ta sama
  technika co `Flagged`, bo żadne z nich nie ma stabilnego typu `schema.custom`): kiedy pole `Team` issue
  jest wypełnione i nie zgadza się z nazwą boarda/zespołu skonfigurowaną dla jego przestrzeni, issue jest
  całkowicie usuwane, niezależnie od tego, co wywnioskował check po nazwie sprintu. Puste pole Team, albo
  instancja bez niego, nic nie zmienia — to czysto dodatkowy mechanizm.
- **Naprawione sortowanie filtra Priority w złej kolejności.** `PRIORITY_ORDER` używał "standardowego"
  nazewnictwa Jiry Highest/High/Medium/Low/Lowest, którego ta instancja Jiry w ogóle nie używa — każda
  realna wartość priority wypadała do fallbacku alfabetycznego zamiast realnej rangi. Poprawione na
  faktyczny schemat tej organizacji (Blocker, Critical, Major, Medium, Minor), naprawiając jednocześnie
  kolejność opcji filtra Priority i kolejność słupków na wykresie Insights "release status per priority"
  (ta sama stała, współdzielona przez obie).
- **Trzy drobne poprawki Product View/Release Notes.** Filtr typu work-itemu na zakładce Release Notes ma
  teraz tę samą kolejność Epic/Bug/Story/Task co filtr Type w Product View, zamiast czysto alfabetycznego
  sortowania. Zarezerwowane `min-height` tabeli Product View nie stosuje się już, gdy są realne wyniki —
  zostaje tylko dla stanu pustego, żeby krótka lista wyników nie zostawiała pustej, dopełnionej przestrzeni
  pod sobą. Komunikaty stanu pustego w Release Notes mają teraz też klasę `.panel` (każde inne użycie
  `.empty` już siedzi wewnątrz kontenera stylowanego jako panel; Release Notes nie miało takiego, więc
  renderowało się jako niestylowany, goły tekst).
- **Naprawiona ikonka ostrzeżenia "flags not tracked", która mogła zostać schowana za długą nazwą
  komponentu.** Nazwa komponentu w Technical View i jej końcowa ikonka ostrzeżenia dzieliły wcześniej
  jeden blok `text-overflow: ellipsis`, więc wystarczająco długa nazwa mogła wyciąć ikonkę razem z
  nadmiarem tekstu — teraz tylko sam tekst nazwy się skraca (`flex:none` na ikonce), więc ostrzeżenie —
  ważny, łatwy do przeoczenia sygnał — zawsze zostaje widoczne.
- **Epiki mogą teraz pokazywać jawny badge "Fully released".** Wcześniej stan "wszystkie dzieci released"
  Epika był widoczny tylko jako wypełnienie progress bara do 100%; dodano binarny, zielony badge przy
  statusie Epika dla tego samego warunku. Świadomie **nie** rozciągnięte na sub-taski Story tą samą
  logiką — patrz sekcja "Zdecydowane i zaimplementowane" w `design-docs/PRODUCT-VIEW-NOTES.pl.md` po
  wyjaśnienie, czemu zlepienie statusu flagi/deploymentu Story z kompletnością jego sub-tasków w Jirze
  błędnie przedstawiałoby funkcje, które są już faktycznie live.
- **Naprawiono powracający błąd: wyczyszczony PI wracał.** Powyższa naprawa "cross-team Epic" działała
  tylko na fetchu z danego przebiegu — nic nie pamiętało, że dany PI został celowo usunięty przez
  `prune-jira-pis.js`, więc kolejny przebieg, który trafił na szeroki, nieskopowany skan (patrz poniżej),
  mógł go odkryć na nowo i zapisać ponownie. Dodano trwałą, nigdy nie przycinaną
  `docs/data/jira-issues/pruned-pis.json`, którą `writePiShards()` sprawdza przy każdym wywołaniu, w każdym
  scope'ie — wyczyszczony PI zostaje wyłączony niezależnie od tego, jak wraca, a jedyną drogą powrotu jest
  jawne wskazanie go w przebiegu `BACKFILL_PIS` (co celowo usuwa go z listy wyczyszczonych). Kolejny
  przegląd tej konkretnej naprawy złapał dwa dalsze błędy, oba naprawione w tym
  samym przebiegu: krok "usuń wszystko, czego nie ma w wyniku tego przebiegu" w scope'ie `'full'` nie
  chronił `pruned-pis.json`/`status-index.json` jako infrastruktury, więc usuwał listę wyłączeń na własnym
  kolejnym przebiegu fallbackowym, obezwładniając się po jednym użyciu; a `runCurrentPiMode()` (domyślny
  sync) nie miał tego samego filtra PI po fetchu, który `runBackfillMode()` już miał, więc przypadkowe
  dopasowanie podciągu w zapytaniu current-PI mogło po cichu nadpisać shard niezwiązanego, już
  backfillowanego PI.
- **Zidentyfikowano źródłową przyczynę, czemu ten fallbackowy skan się w ogóle uruchamiał: błąd
  autoryzacji/niedostępności był traktowany jak "nic nie znaleziono".** `resolveBoardId()`/
  `fetchActiveSprintNames()` degradowały `401`/`403`/`5xx` z Agile API Jiry tak samo jak board, którego
  faktycznie nie znaleziono — oba po prostu logowały ostrzeżenie i szły dalej. Ponieważ to kieruje
  `main()` do destrukcyjnego, nieskopowanego fallbacku `'full'` (tego samego, który naprawa czyszczenia PI
  wyżej ma za zadanie powstrzymać), przejściowy problem autoryzacji/niedostępności mógł wywołać wyciek
  między zespołami przy każdym takim przebiegu, nie tylko raz. Nowy `JiraBoardLookupError` jest teraz
  rzucany i celowo **nie** jest przechwytywany przez żadną z dwóch warstw `try/catch` nad nim, więc cały
  sync zawodzi głośno, pozwalając mechanizmowi retry w `sync-with-retry` (albo dziennemu cronowi) na
  rzeczywiste odzyskanie — to samo rozumowanie, które `resolveSpacesConfig()` już wcześniej ustanowił dla
  własnego, nieprzechwytywanego fetchu listy projektów. Kolejny przegląd wykazał, że ta pierwsza wersja
  wciąż obejmowała tylko `401`/`403`/`5xx`, po cichu degradując `429` (rate limit) albo jakikolwiek surowy
  wyjątek sieciowy (sam `fetch()` rzucający błąd — timeout, błąd DNS) do tej samej destrukcyjnej ścieżki;
  rozszerzono, żeby każda odpowiedź inna niż 2xx *albo* rzucony błąd sieciowy rzucały `JiraBoardLookupError`,
  zamykając też tę furtkę. Gdy ten mechanizm pierwszy raz zadziałał na produkcji, okazało się, że przyczyną
  był `401` konkretnie na Agile API, przy czym te same dane uwierzytelniające chwilę wcześniej w tym samym
  przebiegu poprawnie rozwiązały listę projektów — to nie wygląda na oczywiście wygasły token, bardziej na
  brak licencji Jira Software/dostępu do boarda, zbyt wąski zakres tokena API albo przejściowy problem
  Atlassiana, czyli coś, czego sam retry nie zawsze naprawi. Rzucanie wyjątku jest teraz opcjonalne, pod
  flagą `JIRA_BOARD_LOOKUP_STRICT` (domyślnie wyłączone — zachowanie łagodnej degradacji); domyślną ścieżkę
  dopracowano też tak, żeby nie każdą zdegradowaną próbę traktować tak samo — `main()` wraca do
  destrukcyjnego, nieograniczonego scope'u `'full'` tylko wtedy, gdy dany space nie ma skonfigurowanego
  żadnego `boards` (nie ma więc czego stracić), a w pozostałych przypadkach (board skonfigurowany, ale
  lookup w tym przebiegu po prostu się nie powiódł lub nic nie znalazł) używa scope'u fallbackowego typu
  upsert — tak, by przejściowy problem nie mógł już wyczyścić istniejącego shardu PI.
- **Kolejna, pełna weryfikacja "Product view pokazuje tylko work-itemy jednego zespołu" od A do Z
  znalazła i naprawiła pięć kolejnych dziur w scopingu zespołowym.** Gdy sprint issue nie dopasował się do skonfigurowanego boarda jego space'a *i* jego pole
  Team było puste (częste — nie każdy typ issue ma je wypełnione), issue przechodził dalej do dopasowania
  PI po etykiecie z zerowym dowodem przynależności zespołowej; etykieta Jiry dopasowująca tę samą
  skonfigurowaną nazwę boarda/zespołu liczy się teraz jako równie ważny sygnał (w praktyce często jedyny
  faktycznie ustawiony), a — konkretnie dla space'a bez własnego boarda (projektu faktycznie
  współdzielonego między więcej niż jeden zespół, dla którego nie ma czego wpisać w `boards`) — issue bez
  dopasowującego pola Team *i* bez dopasowującej etykiety jest teraz odrzucany, a nie przepuszczany
  bez filtrowania. `docs/jira-spaces.json` zyskał pole `teams`, niezależne od `boards`, jako konfigurację
  właśnie dla tego przypadku (ustawione na `["Sparks"]` dla "eMobility - EV Product"). Osobno: stuby
  fallbackowe tworzone z deploymentów, używane gdy Jira jest całkowicie nieosiągalna, nie były w ogóle
  scoped przez allowlistę dozwolonych kluczy projektów i niosły prawdziwy (truthy) placeholder PI (`'—'`),
  który po cichu obezwładniał zabezpieczenie "zero rozwiązanych PI → nie usuwaj realnych danych" z dwóch
  punktów wyżej — oba naprawione, więc awaria Jiry nie może już ani ujawnić nieskopowanych kluczy
  cross-team, ani wymazać realnych shardów PI w tym samym ruchu.
- **Szerszy przegląd skryptów sync/flagi/deploymenty ujawnił i naprawił dziewięć kolejnych problemów,
  żaden niezwiązany ze scopingiem zespołowym.** Kursor synchronizacji w `sync-github-deployments.js` mógł
  przesunąć się ponad deploymentem, który nie miał jeszcze statusu terminalnego, trwale wykluczając go z
  każdej przyszłej synchronizacji nawet po tym, jak później rozwiązał się do realnego sukcesu/niepowodzenia;
  ref do GitHubowego `/compare` używa teraz tylko zweryfikowanego release'u/taga albo SHA, nigdy
  niezweryfikowanego dopasowania regexem z treści commita, co ryzykowało 404 albo błędne dopasowanie; a
  wznowiony, paginowany fetch (po retry z powodu rate limitu) jest teraz deduplikowany po id/name, zamykając
  wąskie okno podwójnego liczenia; nowy, nigdy nie przycinany `docs/data/issue-deployments.json` zachowuje
  `deployedAt`/`commitUrl` per issue/env/komponent na zawsze, więc release-status/Release Notes/lead-time
  nie wracają już po cichu do "niewdrożone" dla issue, gdy jego jedyny wspierający rekord w
  `deployments.json` wypadnie poza `RETENTION_DAYS` (samo-backfilluje się z aktualnych rekordów każdego
  komponentu przy każdej synchronizacji, bez osobnej migracji). `resolve-all-flag-states.js`/
  `sync-runtime-be-flags.js` wykrywają teraz kolizję nazwy flagi między komponentami w ramach tego samego
  source'a (dwa niezwiązane komponenty odkrywające flagę o tej samej literalnej nazwie) i odrzucają zapis
  z głośnym `::error::`, zamiast po cichu pozwolić drugiemu nadpisać stan pierwszego; `check-flags.yml` nie
  pisze już do `live`, gdy wywołany przez `pull_request` (wcześniej pisał, dla każdego wywołującego, który
  tak go podłączył); `fill-flag-metadata.yml` pushuje teraz realnym tokenem GitHub App zamiast domyślnego
  `GITHUB_TOKEN`, którego pushe po cichu nigdy nie odpalają triggera innego workflowa — więc
  `retrigger-app-checks.yml` nigdy faktycznie nie uruchamiał się po ręcznym wypełnieniu metadanych; a ten
  workflow jest teraz matrycą po wszystkich komponentach z `featureFlagsIncluded: true`, nie jednym
  zahardkodowanym repozytorium, więc zawieszony check drugiego onboardowanego komponentu nie był w ogóle
  retriggerowany. `update-flag-state.js` jest teraz idempotentny (powtórzony/zduplikowany dispatch
  `flag-changed` dla już aktualnej wartości to no-op, nie fałszywie zalogowany flip) i czyta ścieżki danych
  ze zmiennych środowiskowych jak każdy siostrzany skrypt, a nie z zahardkodowanej ścieżki.
  `backfill-deployment-metadata.js` liczy teraz czas trwania wykluczając status `inactive` z GitHuba, tak
  samo jak już robi to żywy skrypt synchronizujący. `backfill-flag-state-history.js` deduplikuje teraz po
  dniu kalendarzowym, nie po dokładnym znaczniku czasu, bo ten sam realny flip dostaje inny dokładny
  timestamp zależnie od tego, czy zapisało go żywe logowanie czy ten skrypt, co pozwalało ponownemu
  przebiegowi backfillu nad już pokrytym okresem po cichu tworzyć duplikaty. Na końcu, `docs/app.js` miał
  niekonsekwentne escapowanie HTML w kilku ścieżkach renderowania (component/version/dependencyNote/
  changedBy/pole `toRef` rollbacku) — część już escapowana, część nie, w tym wewnątrz atrybutu
  `title="..."` — teraz konsekwentne wszędzie, gdzie pole nie jest ustalonym stringiem zdefiniowanym przez
  developera; a handler zmiany globalnego selecta PI miał realny wyścig, w którym szybkie przełączenie PI
  dwa razy pod rząd mogło pozwolić wolniejszemu, nieaktualnemu fetchowi po cichu nadpisać stan ustawiony
  przez szybszy, nowszy fetch — naprawione strażnikiem "wygrywa najnowsze żądanie".

## 2026-09-29

- **Product View pokazuje teraz wszystkie work itemy zaplanowane w bieżącym PI, nie tylko te już
  zdeployowane.** Dotychczas `sync-jira.js` synchronizował tylko issue już zreferencjonowane w commit
  message jakiegoś deploymentu — issue bez wdrożonego kodu (albo z flagą, która nie jest jeszcze
  śledzona) nigdy się nie pojawiał, więc Product View mógł odpowiedzieć jedynie na pytanie "co jest
  zdeployowane", nigdy "co jest zaplanowane". Wpisy w `docs/jira-spaces.json` mogą teraz mieć tablicę
  `boards`; dla każdej skonfigurowanej tablicy `sync-jira.js` rozwiązuje jej ID w Jira Agile, odczytuje jej
  aktywny sprint i wyciąga z nazwy sprintu PI (ta sama konwencja `PI-\d+\.\d+` używana wszędzie indziej), a
  następnie wykonuje jedno dodatkowe, niskokosztowe zapytanie JQL ograniczone do tego PI
  (`project = X AND (sprint ~ "27.3" OR labels = "PI-27.3")`) zamiast synchronizować cały projekt. Wyniki są
  scalane z istniejącym zestawem issue referencjonowanych przez deploymenty, z deduplikacją po kluczu.
  Każdy krok tego mechanizmu — rozwiązanie tablicy, odczyt aktywnego sprintu, samo dodatkowe zapytanie —
  degraduje się do ostrzeżenia i powrotu do wcześniejszego zachowania, a nie do przerwania synchronizacji,
  bo jest to funkcja dodatkowa/best-effort nałożona na już działającą domyślną ścieżkę.
- **Badge "N/M released to PROD" na Epiku nie zgadzał się z kafelkami podsumowania Product View dla tego
  samego PI.** Badge liczył dziecko jako "released" przez `issueIsReleasedToProd()`, która zalicza też
  `deployed_code_only` (kod wdrożony, ale bez flagi do potwierdzenia) — szersza definicja niż ta używana
  przez kafelki (`prodStatusBucket()`, który taki przypadek klasyfikuje jako "Code deployed", nie
  "Released"). Naprawiono `epicRollup()`, żeby używał tej samej, ściślejszej definicji co kafelki — te
  dwie liczby na tym samym ekranie nie mogą już sobie zaprzeczać.
- **Status Jiry widoczny na każdym wierszu Product View (issue i Epik).** Story mogła pokazywać "Code
  deployed" na każdym środowisku, mając jednocześnie własny ticket w Jirze wciąż w statusie "In Test" z
  otwartymi sub-taskami — nic na ekranie nie sygnalizowało tego rozjazdu. Każdy wiersz ma teraz swój surowy
  status z Jiry jako kolorowy tag (zielony dla `Done`/`Ready for Prod`, niebieski dla `In
  Development`/`In Progress`/`In Test`, czerwony dla `Blocked`), plus dwa kolejne sygnały, gdy dane je
  zawierają: własny marker Jiry "Flagged" (impediment), scalony w ten sam tag — jako ta sama ikona SVG
  flagi, którą już wykorzystuje ostrzeżenie "flags not tracked" w Technical View — a nie jako osobny
  badge, i solidniejszy niż samo dopasowanie tekstu statusu, bo nie każdy projekt ma status literalnie
  nazwany "Blocked", oraz proporcja "done/total sub-tasks" (zielona przy pełnym ukończeniu, niebieska w
  pozostałych przypadkach). `sync-jira.js` dociąga teraz też `priority`, `created` i `resolutiondate` dla
  każdego issue.
- **Nowy filtr w Product View: Priority** (`<select>`, umieszczony bezpośrednio za filtrem typu work
  itemu), oraz trzy nowe wykresy w Insights: release status per **sprint** (zamiast dotychczasowego per
  PI, z drobniejszą etykietą w stylu "PI-27.3.3"), release status per **priority**, oraz **lead time: Done
  → PROD** (mediana dni od rozwiązania w Jirze do pierwszego udanego deploymentu na prod, per sprint) —
  wykres sprintowy i lead time renderują się obok siebie.
- **Wykres Rollbacks & drift ograniczony do ostatnich 12 miesięcy** (wcześniej nieograniczony, więc tylko
  rósł); etykiety osi miesiąc/rok przełączone na `en-US` (celowy wyjątek od reszty dat w aplikacji, które
  są w `pl-PL`).
- Panel Release Notes nie zajmuje już całej wyliczonej wysokości, gdy wyników jest niewiele — używał
  sztywnej `height` zamiast `max-height`, co zostawiało puste miejsce pod krótką listą wyników. Rozmiar
  czcionki `.panel-head h2` ujednolicony do `var(--text-lg)`.

## 2026-09-23 – 2026-09-28

- **Odsłonięcie zakładki Product View** (`PRODUCT_VIEW_ENABLED` włączone) — Technical View na razie
  zostaje domyślną zakładką po wejściu (`DEFAULT_VIEW`), ale Product View jest już klikalny, nie
  wyłączony.
- **Naprawiono kilka realnych błędów synchronizacji z Jirą**, znalezionych przy uruchamianiu Product View
  na prawdziwej instancji Jiry tej organizacji: parametr `keys` przy szukaniu projektu był łączony
  przecinkami, podczas gdy Jira wymaga powtórzonego `keys=` (przez co zawsze wracało "not found");
  custom field Sprint był dopasowywany po nazwie wyświetlanej, nie po `schema.custom` (psuje się, gdy
  admin go zmieni lub zlokalizuje); zapytania z `nextPageToken` nie wysyłały parametru `jql`, z którym
  Jira wiąże ten token, co psuło paginację po pierwszej stronie; a odpowiedzi API wracały zlokalizowane do
  języka profilu Jiry konta uwierzytelniającego, więc przetłumaczone nazwy typów issue bezgłośnie nie
  dopasowywały się do `TYPE_MAP` i każdy issue trafiał na ścieżkę fallback-stub — naprawione przez
  wymuszenie `Accept-Language: en-US`.
- **Release Notes przeszło z soft-launchu (`?releaseNotes=1`) na pełne włączenie**, i zostało uproszczone
  do jednego płaskiego panelu (usunięto dawny podział per-service).
- **Wprowadzono zakładkę Insights**, ukrytą za `?insights=1`: trzy ręcznie zrobione wykresy (bez
  biblioteki do wykresów) — release status per PI na PROD, stale flags (dni ON na prod), oraz
  rollbacks/drift per miesiąc.
- **Product View przeprojektowany na grupowanie po Epiku** (`groupIssuesByEpic()`) zamiast płaskiej listy
  issue, z możliwością zwijania/rozwijania grupy Epicu — żeby PO mógł odpowiedzieć "gdzie wylądował
  Epic/Story/Task/Bug X" bez tego, żeby własny wiersz Epicu mylnie pokazywał "Not deployed" tuż przy już
  wdrożonych dzieciach.
- Kilka rund poprawek wizualnych/designu w Product View i Technical View (matryca komponent × środowisko,
  timeline deploymentów), w tym skondensowanie tagu "Last sync" w headerze do krótkiego tekstu
  "synced HH:MM" wewnątrz status badge'a.

## 2026-09-22

- **Bezpieczny, odporny na wyścig commit/push we wszystkich workflowach modyfikujących dane.**

  **Jak działało to dotychczas:** każdy workflow zapisujący dane do `docs/data/*.json` na branchu `live`
  (`orchestrate-full-sync.yml`, `sync-runtime-be-flags.yml`, `update-flag-state.yml`, `fill-flag-metadata.yml`,
  `check-flags.yml`, `backfill-deployment-metadata.yml`, `backfill-flag-state-history.yml`,
  `sync-main-to-live.yml`) współdzielił jeden blok
  `concurrency: { group: shipscope-live-write, cancel-in-progress: false }`, a ich kroki „commit and push”
  wykonywały jedynie `git add ... && git commit ... && git push`, bez jakiegokolwiek fetch/rebase/retry.
  Zadaniem współdzielonej grupy było zagwarantowanie, że w danym momencie tylko jeden z tych workflowów
  wykonuje push do `live`, ponieważ drugi, równoległy push zakończyłby się niepowodzeniem (non-fast-forward).

  **Skąd wynika ta zmiana:** ten mechanizm miał realną, odtworzoną wadę. GitHub Actions przechowuje tylko
  **jeden oczekujący (pending) run** na daną grupę concurrency — ustawienie `cancel-in-progress: false`
  poprawnie zapobiega przerwaniu runu, który **już się wykonuje**, jednak jeśli w trakcie ręcznie
  uruchomionego `orchestrate-full-sync.yml` nadszedł prawdziwy deployment i wywołał
  `repository_dispatch: deployment-completed` na tym samym workflowie, ten drugi run stawał się jedynym
  oczekującym runem. Jeżeli przed jego wykonaniem nadeszło jakiekolwiek **trzecie** zdarzenie z tej samej
  grupy, GitHub bezgłośnie anulował oczekujący run na rzecz najnowszego — bez błędu, bez wpisu w logu, bez
  żadnej ponownej próby. Prawidłowy, wywołany deploymentem sync mógł po prostu zniknąć. Ten dokładny
  scenariusz (ręcznie uruchomiony pełny sync w trakcie działania, sync rzeczywistego deploymentu nigdy się
  nie wykonujący) został zdiagnozowany i potwierdzony.

  **Co ta zmiana naprawia:** usunięto współdzieloną grupę `concurrency:` w całości (to ona powodowała
  anulowanie runów między workflowami) i zastąpiono niebezpieczny wzorzec „po prostu wypchnij” realną
  pętlą ponawiania — nową composite action, `.github/actions/sync-with-retry`, używaną przez każdy krok
  „commit and push”. W przypadku odrzuconego pusha ponownie uruchamia ona **sam skrypt synchronizujący**
  (nie tylko push) względem świeżo pobranej wersji `live` i podejmuje kolejną próbę, maksymalnie pięć razy.
  Jest to bezpieczne nie dlatego, że „ponawianie w końcu zadziała”, a dlatego, że każdy skrypt w tym
  repozytorium już wykonuje pełny cykl odczytu istniejącego pliku JSON, scalenia zmiany i zapisania całego
  pliku na nowo, nie zaś dopisania linii — naiwne ponowne zastosowanie już obliczonego rebase'a tego diffu
  na nowszej wersji tego samego pliku mogłoby skończyć się realnym konfliktem albo bezgłośnym odrzuceniem
  cudzej zmiany, więc naprawa polega na ponownym przeliczeniu wyniku względem aktualnych danych, co
  naturalnie uwzględnia to, co zdążył już wypchnąć inny run. `check-flags.yml` (dwa repozytoria wyewidencjonowane
  w jednym jobie, przez co katalog roboczy skryptu i katalog roboczy repozytorium git różnią się) oraz
  `sync-main-to-live.yml` (operacja `git merge`, nie uruchomienie skryptu) otrzymały odrębną wersję tej samej
  pętli retry, ponieważ ich struktura nie odpowiada współdzielonej composite action. Zmiana została
  zweryfikowana lokalną symulacją tego dokładnego wyścigu (dwa klony repozytorium wypychające konfliktowe
  zmiany do tego samego pliku) przed scaleniem — obie zmiany przetrwały, bez konfliktu i bez utraty danych.
  Aktualny opis tego mechanizmu znajduje się w `CLAUDE.md`, w sekcji dotyczącej podziału `main`/`live`.

- **Poprawka uzupełniająca, znaleziona tego samego dnia na produkcji: ponowne próby odpytywały API
  GitHub przy każdym podejściu i wyczerpały limit zapytań.** Powyższa pętla retry jest tania do ponowienia
  tylko w części scalającej z `live`. `sync-github-deployments.js` wykonuje też jedno zapytanie do API
  GitHub na **każdy nowy** deployment (plus kolejne zapytania per deployment) — dla nowo dodanego komponentu
  z dużym, wcześniej istniejącym backlogiem (3322 deploymenty, 3022 nowych) jeden pełny bieg to już tysiące
  zapytań, a każda ponowna próba po przegranym wyścigu odtwarzała **cały** fetch od zera, ponieważ nieudany
  push zawsze resetuje lokalny stan do tego, co `live` faktycznie ma dla tego komponentu. Trzy próby w
  jednym biegu oznaczały z grubsza trzykrotność liczby zapytań, co realnie wyczerpało limit — potwierdzone
  bezpośrednio z logu tego przebiegu. Dodano `scripts/lib/retry-cache.js` (`loadOrCompute`): buforuje wynik
  kosztownego fetchu i rozwiązywania danych w pliku tymczasowym per job (`RUNNER_TEMP`, czyszczonym
  automatycznie przez GitHub Actions), dzięki czemu ponowna próba w tym samym jobie reużywa go zamiast
  odpytywać API na nowo, natomiast krok scalania ze świeżym `live` wciąż zawsze na nowo odczytuje i
  odduplikowuje względem aktualnych danych przed zapisem. Zastosowano w `sync-github-deployments.js`
  (potwierdzony błąd) oraz `sync-jira.js` (ten sam kształt, mniejsze ryzyko, bo już ograniczony do
  konkretnych referencjonowanych issue, buforowany po hashu rozwiązanego JQL, więc realnie inne zapytanie
  wciąż pobiera dane na nowo). `backfill-deployment-metadata.js` nie został przebudowany w ten sam sposób —
  modyfikuje istniejące rekordy w miejscu w kilku ograniczonych fazach, nie odpowiada temu samemu kształtowi
  cache'u, a uruchamia się tylko ręcznie (`workflow_dispatch`), więc ten sam wyścig jest znacznie mniej
  prawdopodobny — jego limit prób po prostu zmniejszono do 2, aby ograniczyć koszt, jeśli to kiedykolwiek
  się zdarzy.

- **Wykładniczy backoff na limit zapytań oraz wznawialna paginacja listy deploymentów — na przypadek, którego
  bufor powyżej nie obejmuje: przekroczenie limitu już przy pierwszej próbie danego joba, nie przy retry.**
  Może się to zdarzyć, gdy joby kilku komponentów w tej samej matrycy współdzielą limit jednego tokena
  instalacyjnego, a wcześniejszy job już zużył jego część, zanim ten konkretny się zaczął. `githubApi` w
  `sync-github-deployments.js` teraz ponawia próbę przy odpowiedzi `429` albo `403` z
  `x-ratelimit-remaining: 0`, czekając do `x-ratelimit-reset` (maksymalnie 10 minut) zamiast natychmiast
  zawodzić. `githubApiAllPages` może też teraz zapisywać już pobrane strony do `RUNNER_TEMP` w miarę
  pobierania (podłączone do listy `/deployments`, z kluczem per komponent), więc jeśli kolejna strona wciąż
  zawiedzie po wyczerpaniu tych ponownych prób, następna próba tego samego joba wznawia się od ostatniej
  zbuforowanej strony, zamiast pobierać od nowa od strony 1. Automatyczny przegląd bezpieczeństwa wykrył, że
  ten nowy klucz bufora, tak jak istniejący już w `retry-cache.js`, był wstawiany do ścieżki w systemie
  plików bez żadnej sanityzacji — oba teraz usuwają z klucza wszystko poza znakami alfanumerycznymi,
  `.`, `_` i `-`. Naprawiono też przestarzały input `app-id` w `actions/create-github-app-token@v3` na
  `client-id` we wszystkich pięciu workflowach, które go używają.

- **Wskaźnik „Last sync” pod tagiem `source: data/*.json (live)`.** Sam tag potwierdzał wyłącznie, że pliki
  danych się wczytały, nie że zostały niedawno albo w całości zaktualizowane — a jednokomponentowy
  `repository_dispatch`, który normalnie wywołuje szybki sync, może po cichu w ogóle się nie wywołać, jeśli
  plik workflow deployującego repozytorium aplikacji, na branchu, który wywołał ten konkretny deployment,
  nigdy nie otrzymał kroku wywołującego ten sygnał (patrz model branchy `main`/`live` w `CLAUDE.md`). Dzienny
  harmonogram bezpieczeństwa (cron) wciąż zakrywa tę dziurę, tylko z opóźnieniem do 24 godzin, a wcześniej
  nic na dashboardzie nie odzwierciedlało tego, że takie opóźnienie w ogóle wystąpiło. Job `prepare` w
  `orchestrate-full-sync.yml` teraz oznacza, czy dany przebieg synchronizuje wszystkie śledzone komponenty
  (cron/manual/nieznany dispatch), a nie tylko jeden komponent wskazany w dispatchu; nowy skrypt
  `record-full-sync.js`, uruchamiany wyłącznie na tej ścieżce przez nowy job `record_full_sync`, ostempluje
  `docs/data/sync-meta.json` aktualnym czasem, gdy deploymenty wszystkich komponentów oraz Jira zostały
  zsynchronizowane z sukcesem. `docs/app.js` renderuje to jako „Last sync: &lt;data&gt;” pod tagiem źródła
  danych.

## 2026-09-21

- **Release notes: data „fully released” + wyraźniejszy stan pusty.** Każdy badge „Fully released to PROD”
  pokazuje teraz, **od kiedy** — późniejsze z dwóch zdarzeń: deploymentu, który wdrożył ostatni issue w
  grupie, i momentu włączenia jego flagi. Stan pusty rozróżnia teraz „brak jakichkolwiek zsynchronizowanych
  issue” od „issue zsynchronizowane, ale każdy z nich jest zastępczym stubem wywiedzionym z commitów” (z
  odniesieniem do odpowiedniego wpisu w FAQ wyjaśniającego przyczynę), zamiast jednego, ogólnego komunikatu
  dla obu przypadków.
- **Sync z Jirą: naprawiono dwa realne błędy znalezione podczas diagnozowania, czemu Release Notes
  pozostawało puste na `live`.**
  1. `sync-jira.js` traktował **każdy** ciąg w kształcie `XXX-123` znaleziony w komunikacie commita jako
     kandydata na klucz projektu Jiry; jedno błędne dopasowanie (identyfikator z innego systemu, literówka)
     wewnątrz `project in (...)` powodowało niepowodzenie całego zapytania JQL i po cichu zerowało wyniki
     dla wszystkich projektów, nie tylko tego błędnego. Dodano `filterExistingProjectKeys()`, które
     najpierw sprawdza każdego kandydata względem realnej, widocznej listy projektów w Jirze.
  2. Domyślne wyszukiwanie było też ograniczone do **całych projektów** — jeden ticket wspomniany raz w
     commicie wciągał każdy inny, niezwiązany ticket z tego projektu. Domyślne zachowanie zmieniono na
     `key in (...)`, ograniczone dokładnie do kluczy issue referencjonowanych w zsynchronizowanych commitach
     (`JIRA_PROJECT_KEY` pozostaje jako jawny opt-in do starego, całoprojektowego zachowania). Poprawiono
     też dopasowanie regexu/etykiety PI, aby przyjmowało realny w tej organizacji format `PI-27.1` (z
     łącznikiem) — wcześniej dopasowywało wyłącznie format `PI27.4`, przez co każdy prawdziwy PI był po
     cichu odrzucany niezależnie od powyższych poprawek.
- **Poziom sprintu w Release Notes.** `sync-jira.js` zapisuje teraz również surową wartość pola Sprint z
  Jiry (`sprint`) obok wyliczonego z niej PI — jeden PI zwykle obejmuje kilka sprintów. Zakładka Release
  Notes zagnieżdża grupy sprintów wewnątrz ich PI, każda z własnym, niezależnym zestawieniem
  „Fully released to PROD”/„In progress”.
- **Dodano `evboweb-service-frontend` do `docs/components.json`.**
- **Zakładka Release Notes**, ukryta domyślnie i pojawiająca się tylko przy `?releaseNotes=1` w adresie URL
  (celowe, miękkie wdrożenie funkcji — niewidoczne dla nikogo, kto nie wie, że ma o nie poprosić, na czas
  weryfikacji na realnych danych). Grupuje issue z Jiry po **aplikacji** → PI → sprincie, nie tylko po PI —
  `application` to nowe, opcjonalne pole typu **tablica** we wpisach `docs/components.json` (tablica, nie
  pojedynczy string, dzięki czemu komponent współdzielony przez więcej niż jedną aplikację, np. wspólny
  BFF, ma swoje issue widoczne pod wszystkimi z nich). Wszystko liczone jest w całości po stronie klienta, z
  danych, które `docs/app.js` już wczytuje — bez nowego pliku danych, bez nowego skryptu synchronizującego,
  bez integracji ze Slackiem.

## 2026-09-15 – 2026-09-18

- Rozszerzono definicje komponentów (kolejność onboardingu, opisy), przeprowadzono unifikację designu w
  poszczególnych sekcjach, uporządkowano ostrzeżenia i pluralizację, naprawiono błąd w rozwiązywaniu flag
  oraz grubość czcionki w badge'u typu flagi, dodano `host` i `sim-adapter` do śledzonych komponentów,
  uproszczono konfigurację komponentów.

## 2026-09-14

- Dodano historię stanów feature flag (kto i kiedy zmienił flagę), z autorem przy każdym wpisie.
- Dodano wykrywanie rollbacku i odpowiadający mu badge; zaktualizowano skrypt backfill, aby liczył
  historyczny rollback i rozwiązywał wersje w kolejności release-tag-commit.
- Dodano workflow `backfill-flag-state-history` (przeszukuje historię gita samego `live`, aby zasilić log
  historii wpisami z okresu przed jego powstaniem).
- Rozluźniono `sync-runtime-be-flags`, aby odpowiadało sposobowi wyzwalania `orchestrate-full-sync`; dodano
  filtr serwisu oraz nowy układ czasu trwania i statusu w osobnej linii; listę flag posortowano A–Z; dodano
  opis projektu i notatki architektoniczne.

## 2026-09-08 – 2026-09-11

- Dodano fallback w Product view na wypadek, gdy Jira jest nieosiągalna; zaktualizowano strukturę skryptów
  i README.
- Zoptymalizowano uruchomienia workflowów; naprawiono widok fallback i harmonogram orkiestratora.
- Dodano linki do logów przebiegu workflowa, czas trwania deploymentu, oznaczenie manualnego deploymentu,
  informację o rozjeździe commitów oraz linki do porównania commitów.
- Dodano skrypt backfill uzupełniający historyczne rekordy deploymentów o nowsze pola.
- Naprawiono wyrównanie sekcji; wprowadzono usprawnienia dotyczące statusu z Jiry, blast radius i
  widoczności hotfixów; dodano informację o zmianie stanu flagi.

## 2026-08-11 – 2026-08-14

- Dodano początkowe skrypty, workflowy i dashboard (`docs/`). Wprowadzono skrypt synchronizacji z Jirą oraz
  workflow synchronizujący `main` → `live`. Dodano wsparcie dla flag typu `runtime-be` (backendowych).
  Naprawiono workflow `check-flags`. Dodano concurrency, aby zapobiec równoległym uruchomieniom workflowów
  na `live` (później zastąpione — patrz wpis z 2026-09-22 powyżej). Naprawiono regex odczytujący pliki flag.

## 2026-08-06

- Commit początkowy.
