# Raport architektoniczny i analiza domenowa (DDD)

Analiza kodu (nie tylko dokumentacji) pod kątem konstrukcji architektury i podziału domenowego, wykonana
2026-10-17. Zakres: `scripts/` + `scripts/lib/` (synchronizacja plikowa), `server/` (backend SaaS,
Fastify + Postgres), `docs/app-*.js` (frontend). Celem jest wskazanie konkretnych miejsc, które utrudniają
dziś (albo będą utrudniać przy dalszym wzroście) czytelny podział domenowy — z odwołaniem do plików i linii,
nie ogólnikami.

Raport ma dwie części. **Część I** dotyczy konstrukcji architektury (podział plików, granice modułowe,
testowalność). **Część II** to analiza domenowa w ujęciu DDD: subdomeny, mapa kontekstów, projekt taktyczny,
sprzężenie (connascence) i język wszechobecny. Część II nie proponuje przebudowy na DDD „z podręcznika" —
opisuje model, który w tym kodzie **już jest**, i wskazuje miejsca, gdzie nie jest nazwany.

Metoda: liczby linii i liczby wystąpień policzone narzędziowo na stanie repo z 2026-10-17 (`main`,
`e88c5dd`). Twierdzenia o zachowaniu kodu oparte na przeczytanych fragmentach — przy każdym podaję plik
i linię. Wnioski, które nie wynikają wprost z kodu, są oznaczone jako **[propozycja]** albo trafiły do
„Pytań otwartych" na końcu.

## Streszczenie

Projekt ma już dobrze przemyślaną granicę między trzema środowiskami wykonania (sync plikowy / backend SaaS /
statyczny frontend) i w kilku miejscach świadomie stosuje rozdział „czysta logika domenowa" / „nieczysta
powłoka I/O" (deployment, drift, rytmy increments). To solidny fundament — rdzeń domeny jest wyizolowany
w małych, czystych plikach, a objętość kodu siedzi w subdomenach wspierających i generycznych, co jest
zdrowym rozkładem. Największe realne problemy nie leżą w granicach wysokiego poziomu, ale **wewnątrz**
warstwy serwera SaaS, która rosła przyrostowo (feature po feature z PRD) i w efekcie ma:

1. jeden plik routingu (`server/web.js`, 1090 linii, 57 endpointów) obejmujący ~9 różnych dziedzin,
2. dwa największe moduły (`server/lib/flags.js` 499 linii, `server/lib/jira-sync.js` 558) mieszające SQL,
   wywołania HTTP do zewnętrznych API, walidację i reguły biznesowe w jednym pliku — mimo że projekt ma
   już sprawdzony wzorzec pure-core/impure-shell i stosuje go gdzie indziej,
3. ręcznie utrzymywaną (konwencją, nie narzędziem) duplikację logiki domenowej między `scripts/lib/` i
   `server/lib/` — która **już się rozjechała** (`tree-diff.js`: 80 vs 69 linii, różne eksporty),
4. brak wymuszonej narzędziowo granicy modułowej między `scripts/`, `server/` i `docs/` — dziś działa to
   tylko dlatego, że nikt jeszcze nie złamał konwencji.

Po stronie domenowej najważniejsze obserwacje to: relacja duplikacji między kontekstem plikowym a SaaS jest
najdroższą krawędzią na mapie kontekstów i **nie ma daty wygaszenia**; kontrakt `data/*.json` postawił
nowszy, bogatszy model serwera w roli Conformist wobec starszego formatu plikowego; a w jednym systemie żyją
dziś równolegle dwie nazwy tej samej rzeczy (`component` / `tracked repo`) i dwa poziomy abstrakcji tego
samego pojęcia (`PI` / `increment`).

Żadna z tych rzeczy nie jest „zepsuta" — testy przechodzą, pokrycie jest wysokie, produkcja działa. To raport
o tym, co ułatwi utrzymanie wyraźnego podziału domenowego, gdy serwer SaaS urośnie o kolejne 2-3 PRD-FR-y.

## Co już jest dobrze skonstruowane (nie dotykać bez powodu)

- **Pure core / impure shell dla logiki domenowej, która już jest złożona.** `server/lib/deployment-logic.js`
  (137 linii: trimowanie, wybór „current", drift) jest czystą funkcją nad danymi, osobną od
  `server/lib/deployment-sync.js` (363 linie I/O: GitHub API, Postgres). Ten sam wzorzec dla Jiry:
  `server/lib/jira-model.js` (325 linii) trzyma **naprawdę czyste** reguły rytmu i increments —
  `rhythmOf()` (linia 55), `piOfSprint()` (144), `currentPiOf()` (173), `previousPiOf()` (191),
  `compileTemplate()` — osobno od `jira-sync.js` (I/O). `tree-diff.js` i `version-resolution.js` (92 linie)
  też są czyste. To jest właściwy wzorzec do rozszerzenia na resztę serwera (patrz Problem 2).
- **Świadoma granica `scripts/` vs `server/` jako dwa osobne konteksty**, nie jeden rozrastający się
  moduł: własny `package.json`, własny `node_modules/`, własny `test/`. Backend nie importuje z `scripts/` i
  odwrotnie — root `npm test` nie wie o `server/test/`. Dokumentacja wprost nazywa koszt tej granicy
  (`CLAUDE.md`: „napraw w obu miejscach, dopóki sync plikowy nie zostanie wygaszony") — to jest jawna decyzja, nie przypadkowy
  dryft (rozwinięcie w Problemie 3 i w części II.4).
- **Jeden punkt wejścia dla izolacji najemców.** `server/lib/scope.js`'s `withScope()` jest konsekwentnie
  używany we wszystkich modułach dotykających danych tenantów (`tenants.js`, `invitations.js`, `flags.js`,
  `jira-sync.js`, `jira-connections.js`, `github-connections.js`, `deployments.js`, `deployment-sync.js`,
  `dashboard-data.js`, `retention.js`). To właściwe miejsce na wymuszenie RLS, a nie rozproszone
  `SET app.current_tenant_id` po każdym pliku.
- **Dyscyplina idempotencji jako zasada architektoniczna, nie przypadek**: każdy skrypt mutujący dane
  (`scripts/*.js`) stosuje ten sam kształt read → merge-tylko-gdy-zmiana → write, co wprost umożliwia
  bezpieczne retry (`sync-with-retry`) bez osobnej logiki deduplikacji na poziomie workflow. To jest
  architektura odporności, nie tylko styl kodu.
- **Pliki danych jako kontrakty z jawną własnością** (`deployments-cursor.json`, `issue-deployments.json`,
  `pruned-pis.json`, `status-index.json`) — każdy ma dokładnie jedno zadanie i jeden skrypt, który go pisze.
  Dobra praktyka „jeden plik = jedna odpowiedzialność" przeniesiona na poziom danych, warta utrzymania przy
  ewentualnym przejściu reszty sync'u na Postgres.

---

# Część I — konstrukcja architektury

## Problem 1 — `server/web.js` jako god-file: jeden plik, 57 endpointów, ~9 dziedzin

`server/web.js` ma **1090 linii** i **57 definicji route'ów** (policzone: `app.get|post|put|patch|delete(`).
Obejmują: health-check, sesje i login GitHub, zarządzanie tenantami i członkostwem, zaproszenia, ustawienia
tenantu, połączenie z GitHub App i repozytoria, połączenie z Jirą (OAuth, boardy, pola flag), ingest
i zarządzanie flagami, serwowanie dashboardu i UI ustawień, oraz webhooki GitHub/Jira. Plik importuje
bezpośrednio z 15 różnych modułów `server/lib/*` (linie 5-37) — czyli każda zmiana w routingu wymaga
kontekstu wszystkich tych dziedzin naraz, i każda z nich jest „widoczna" dla reszty pliku, nawet jeśli
logicznie nie powinna być.

To nie jest problem wydajności czy poprawności. To problem **czytelności granic domenowych**: nic
w strukturze plików nie mówi „to są route'y Jiry", „to są route'y flag" — trzeba czytać ciało pliku albo
numery linii. Dodatkowo każdy PR dotykający jednej dziedziny dotyka pliku współdzielonego z ośmioma innymi,
co sztucznie zwiększa liczbę konfliktów i obszar przeglądu.

**Rekomendacja**: rozbić `server/web.js` na plugin Fastify per dziedzina, rejestrowany w jednym miejscu:

```
server/routes/
  health.js         (/health, /health/db)
  auth.js           (/auth/*, /me)
  tenants.js        (/tenants, /tenants/:id/members, /tenants/:id/settings)
  invitations.js    (/tenants/:id/invitations/*, /invitations/:token/*)
  github.js         (/tenants/:id/github/*, /github/setup)
  jira.js           (/tenants/:id/jira/*, /auth/atlassian/callback)
  flags.js          (/api/flags/ingest, /tenants/:id/flags/*, /tenants/:id/flag-sources/*)
  dashboard.js      (/, /t/:tenantId/*, /api/tenants/:id/dashboard-data, /api/tenants/:id/jira-issues)
  ui.js             (/start, /ui/<name>, /t/:id/settings)
  webhooks.js       (/webhooks/github, /webhooks/jira)
```

Każdy plik eksportuje funkcję `async function registerXRoutes(app, deps)` (Fastify plugin), `web.js` staje
się listą `app.register(...)` plus bootstrap (instancja Fastify, plugin cookie, nasłuch). To refaktor
mechaniczny (przenoszenie bloków, nie zmiana logiki) — niskie ryzyko, duży zysk w czytelności.

## Problem 2 — reguły biznesowe wymieszane z SQL w `flags.js` i `jira-sync.js`

`server/lib/flags.js` (499 linii) i `server/lib/jira-sync.js` (558) to **dwa największe moduły
w `server/lib/`** — większe od `atlassian.js` (395) i `deployment-sync.js` (363). W obu przypadkach
w jednym pliku mieszają się: SQL wykonywany wprost, wywołania HTTP do zewnętrznego API (Atlassian),
walidacja wejścia, autoryzacja na poziomie tenantu (`withScope`, `actorUserId`) i rzeczywiste reguły
biznesowe.

Najlepszy, konkretny dowód — `readDashboardFlags()` w `server/lib/flags.js:412-479`. Funkcja wykonuje
pięć zapytań SQL (linie 413, 418, 423, 427 oraz `jiraLinks()` w 422), a potem w tym samym ciele realizuje
**czystą logikę domenową, która nie potrzebuje bazy**:

- rozstrzyganie, które źródło wygrywa dla danej pary flaga/środowisko: najwyższy `priority`, a przy remisie
  późniejszy `changed_at` (linie 433-444),
- mapowanie `kind` źródła na slot dashboardu (`runtime` → `runtime-be`, inaczej `build`, linia 415),
- wyliczanie `enabled` z nowego, trójstanowego `state` (`enabled: v.state !== 'off'`, linia 449),
- scalanie `jiraKeys` z trzech niezależnych pochodzeń — nadawcy, ręcznie ustawionego i z samej Jiry
  (linia 466),
- regułę widoczności: **flaga, której żadne źródło już nie raportuje, nie jest pokazywana**
  (linie 461-462, z komentarzem w kodzie).

Ta ostatnia reguła to pełnoprawna decyzja domenowa („co znaczy, że flaga istnieje"), a mieszka w środku
funkcji czytającej pięć tabel. Żeby ją przetestować, test musi przejść przez `client`/`pool` — nie da się
napisać czystego testu jednostkowego samej reguły. To wyraźny kontrast z tym, jak projekt rozwiązał
identyczny problem dla deploymentów (`deployment-logic.js`) i dla rytmów Jiry (`jira-model.js`).

Podobnie `ingestFlags()` (linia 244): niezmiennik kontraktu v2 „starsza wiadomość nigdy nie cofa nowszej"
oraz obsługa `MAX_CHANGED_AT_AGE_MS`/`MAX_CHANGED_AT_SKEW_MS` (linie 24-25) żyją obok zapisów do bazy.
`checkPayload()` (linia 190) jest już czystą funkcją — tylko leży w nieczystym pliku.

Po stronie `jira-sync.js` sytuacja jest **lepsza, niż sugerowała pierwsza wersja tego raportu**: czysta
część logiki increments jest już wyniesiona do `jira-model.js` (`rhythmOf`, `piOfSprint`, `currentPiOf`,
`previousPiOf`). Co zostaje do wyniesienia: reguła „pierwszy sync boardu bierze też poprzedni PI"
i polityka pełnego re-syncu (`boardIncrements()`, linia 161) oraz składanie odpowiedzi dashboardu
(`currentIncrements()` 491, `readDashboardJira()` 512) — te same kształty „SQL + reguła" co w `flags.js`.

**Rekomendacja** (rozszerzenie wzorca, który projekt już ma, nie wymyślanie nowego):

- `server/lib/flags-logic.js` — czyste funkcje bez importu `db`/`pg`: `pickWinningValue()` (priorytet +
  `changed_at`), `slotOf(kind)`, `enabledFrom(state)`, `mergeJiraKeys()`, `visibleFlags()`, oraz
  `checkPayload()` przeniesione bez zmian (już jest czyste).
- `server/lib/flags.js` zostaje orchestratorem: woła `withScope`, odpytuje bazę, przekazuje surowe wiersze
  do `flags-logic.js`, zwraca wynik. Staje się odpowiedzią na „co się dzieje", a `flags-logic.js` na
  „jakie są reguły".
- To samo dla `jira-sync.js`: dołożyć brakujące czyste reguły do **istniejącego** `jira-model.js`, zamiast
  tworzyć trzeci wzorzec.

Nie musi to być jeden duży refaktor — można funkcję po funkcji, zaczynając od `readDashboardFlags()`
i `ingestFlags()`, bo tam reguł jest najwięcej i błąd jest najdroższy.

**Obserwacja poboczna (nowa)**: `readDashboardFlags()` czyta `flag_value_history` **bez żadnego limitu
i bez okna czasowego** (linie 427-431: `WHERE tenant_id = $1 AND NOT removed ORDER BY changed_at, id`).
Odpowiedź dashboardu rośnie więc liniowo z liczbą wszystkich przełączeń flag w historii najemcy, bez
górnego ograniczenia. Dla porównania: deploymenty mają retencję (`deployment_retention_days`, 7-730),
a issues są re-syncowane w całości. To trzecia, inna polityka czasu — patrz II.3 i Pytanie otwarte 4.

## Problem 3 — duplikacja logiki domenowej `scripts/lib/` ↔ `server/lib/` już się rozjechała

`CLAUDE.md` jest świadomy tego problemu i nazywa go wprost: `deployment-logic.js`, `version-resolution.js`,
`env-drift.js` + `tree-diff.js` są „portami" odpowiadających plików w `scripts/lib/`, z zasadą „napraw w obu
miejscach, dopóki sync plikowy nie zostanie wygaszony". To dobra decyzja na poziomie granicy (SaaS i sync plikowy mają
naprawdę różne zależności wdrożeniowe — mieszanie ich wspólnym pakietem npm byłoby złą ceną za DRY).

**Nowe, zweryfikowane ustalenie: te kopie nie są już kopiami.** Konkretnie dla pary opisanej w dokumentacji
jako „a copy of":

| | `scripts/lib/tree-diff.js` | `server/lib/tree-diff.js` |
|---|---|---|
| linie | 80 | 69 |
| eksporty | `MAX_DIFF_PATHS`, `compileIgnorePattern`, `parseIgnorePaths`, `diffTrees` | `diffTrees` |

Rozjazd jest **uzasadniony** (wersja skryptowa musi parsować `DRIFT_IGNORE_PATHS` z JSON-a w zmiennej
środowiskowej; serwer czyta `drift_ignore_paths` wprost z kolumny, więc parsera nie potrzebuje) — to nie
jest bug. Ale ma dwie konsekwencje:

1. Dokumentacyjne „a copy of" jest już nieścisłe i zachęca do złej weryfikacji (porównania plików).
2. Jedyna rzecz, która **musi** pozostać zgodna, to **zachowanie `diffTrees()`** — nie treść pliku.
   Podobnie `scripts/lib/deployment-records.js` (398 linii) vs `server/lib/deployment-logic.js` (137) to
   nie kopia, a port podzbioru reguł.

**Rekomendacja**: dodać test parzystości, który **nie** porównuje treści plików, ale uruchamia te same
fixture'y przez obie implementacje i asercją `deepStrictEqual` sprawdza wynik:

- wspólny plik fixture (dwa listingi drzewa + lista wzorców ignorowania, w tym przypadki: identyczne
  drzewa, rename, zmiana tylko w ignorowanej ścieżce, listing `truncated`),
- jedno `require('../scripts/lib/tree-diff')`, jedno `require('../server/lib/tree-diff')`, jedna asercja
  na `diffTrees()`,
- to samo dla reguł wyboru „current" / „latest successful" i trimowania
  (`deployment-records.js` ↔ `deployment-logic.js`).

Umieścić w root `test/` (ma dostęp do obu drzew; `server/test/` wymaga Postgresa, więc jest gorszym
miejscem na czysty test parzystości). Koszt: kilka godzin. Zysk: zmiana reguły driftu tylko po jednej
stronie jest wykrywana w CI, nie na produkcji dwa miesiące później. Projekt ma już precedens na strażnika
zgodności dwóch artefaktów (`test/release.test.js` pilnuje równości numerów wersji w trzech plikach).

## Problem 4 — brak wymuszonej granicy modułowej między `scripts/`, `server/`, `docs/`

Te trzy drzewa są dziś rozdzielone konwencją i dokumentacją, nie narzędziem. Nic nie przeszkodziłoby dodać
`require('../../server/lib/...')` w skrypcie z `scripts/` (albo odwrotnie) — żaden lint, żaden test tego nie
wychwyci, dopóki coś nie wybuchnie przy uruchomieniu (`scripts/` nie ma `pg` w zależnościach, więc błąd
pojawiłby się dopiero w runtime workflow, nie lokalnie). Projekt nie ma ESLint (świadoma decyzja: „brak
lintera w tym repozytorium"), więc klasyczna reguła `import/no-restricted-paths` nie jest dostępna za darmo.

**Rekomendacja**: prosty skrypt Node bez zależności (w duchu `scripts/lib/cli.js`), np.
`scripts/check-module-boundaries.js`, uruchamiany jako dodatkowy krok w `test.yml`: szukać
`require('...')` w `scripts/**/*.js` ze ścieżką zawierającą `server/`, i symetrycznie w `server/**/*.js`
ze ścieżką zawierającą `scripts/`, plus `docs/app-*.js` (które nie powinny niczego `require`-ować).
Zero parsowania AST — to statyczne ścieżki importu, wyrażenie regularne wystarczy i jest zgodne z resztą
repo. Koszt: ~20 linii kodu + jeden test. Zysk: granica, którą dziś opisuje tylko proza, staje się czymś,
co CI faktycznie sprawdza.

## Problem 5 — rosnące pliki w `docs/app-*.js`, szczególnie `app-technical.js` (931 linii)

Podział `app.js` na dziesięć plików jest dobrym pierwszym krokiem podziału domenowego frontendu. Rozkład
linii (łącznie 4109):

| plik | linie | |
|---|---|---|
| `app-technical.js` | 931 | **~23% całości frontendu** |
| `app-components.js` | 587 | |
| `app-data.js` | 567 | |
| `app-model.js` | 557 | |
| `app-product.js` | 414 | |
| `app-insights.js` | 317 | |
| `app-main.js` | 270 | |
| `app-release-notes.js` | 223 | |
| `app-core.js` | 177 | |
| `app-html.js` | 66 | |

Brak modułów ES jest uzasadniony wymogiem działania po `file://` — **nie rekomenduję** tego zmieniać,
bo koszt (utrata podglądu bez serwera) przewyższa zysk.

Realny, rosnący problem: `app-technical.js` obejmuje co najmniej cztery odpowiedzialności — macierz
komponent×środowisko z wyrównywaniem wysokości wierszy, panel flag (blast radius, stale warning), oś czasu
deploymentów z filtrem zakresu dat, oraz modal i legendę driftu. Kandydat do dalszego podziału **w tym samym
duchu co już zrobiony podział `app.js`**, nie do nowego wzorca:

```
docs/app-technical-matrix.js      (component × env matrix, wyrównywanie wysokości wierszy)
docs/app-technical-timeline.js    (oś czasu deploymentów + filtr zakresu)
docs/app-technical-flags.js       (panel flag, blast radius, stale warning)
docs/app-technical.js             (złożenie powyższych + inicjalizacja widoku)
```

Ponieważ pliki współdzielą jeden globalny scope, podział jest czysto organizacyjny — funkcje zachowują
nazwy, `grep` wciąż je znajduje, kolejność `<script>` w `docs/index.html` tylko się wydłuża. Jedyna
pułapka to reguła, którą `CLAUDE.md` już nazywa: instrukcja wykonywana w czasie ładowania może używać
tylko rzeczy z tego samego albo wcześniejszego pliku.

## Problem 6 — `withScope()` jest konwencją, nie wymuszeniem

`server/lib/scope.js`'s `withScope()` jest właściwym, jednym punktem wejścia dla izolacji najemców. Ale
w czystym JS bez typów nic nie gwarantuje, że nowa funkcja dotykająca jednej z 15 tabel RLS faktycznie
przez niego przejdzie. Dziś pilnuje tego przegląd kodu i fail-safe po stronie bazy (zapytanie bez scope
zwraca zero wierszy, zapis daje błąd RLS) — to dobra siatka bezpieczeństwa, ale oznacza, że błąd objawia się
jako „pusta odpowiedź" w runtime, nie jako czytelny sygnał przy przeglądzie.

**Rekomendacja** (niska pilność, bo siatka w bazie już istnieje): skrypt podobny do Problemu 4 — szukać
w `server/lib/*.js` wywołań `query(`/`client.query(` z nazwą jednej z tabel RLS **poza** blokiem
`withScope(...)`. To nie wyłapie każdego przypadku (wyrażenie regularne nie rozumie przepływu kontroli),
ale wyłapie najczęstszy błąd: zapytanie dodane przez pomyłkę na głównym poziomie funkcji, nie w callbacku.
Dodatkowo warto przenieść listę tabel RLS z prozy w `CLAUDE.md` do jednego miejsca w kodzie (np. stałej
eksportowanej ze `scope.js`), z którego korzystałby i ten strażnik, i istniejący
`server/test/tenant-delete.test.js`.

---

# Część II — analiza domenowa (DDD)

## II.1 Analiza strategiczna — subdomeny

Podział na subdomeny według tego, co faktycznie daje przewagę (core), co jest potrzebne ale nie wyróżnia
(supporting), i co dałoby się kupić z półki (generic). Przypisanie oparte na zawartości plików, nie na
nazwach katalogów.

**Rdzeń (core) — „jaki jest prawdziwy, aktualny stan tego, co działa na produkcji"**

To jedyna część, której nikt nie kupi gotowej, i w której siedzi cała wartość produktu:

- rozstrzyganie, **co naprawdę jest wdrożone**: `version-resolution.js` (release → tag → plik wersji →
  etykieta z commita, z osobną regułą „do porównania tylko zweryfikowany ref albo sha"),
- **czy środowiska się różnią i czy to ma znaczenie**: `tree-diff.js` + `env-drift.js` — a w szczególności
  decyzja, że liczba commitów to kontekst, a o istnieniu driftu decyduje porównanie drzew plików
  z uwzględnieniem `drift_ignore_paths`,
- **rollback jako fakt domenowy** (deploy wrócił do wcześniejszego refu), wykrywany z już wykonanego
  porównania,
- **status wydania** łączący trzy niezależne światy (issue Jira + flaga + deployment) w jedno pojęcie:
  `none` / `deployed` / `released` / `partial` — `docs/app-model.js`,
- reguły retencji i kursora (`deployment-logic.js`): „kursor nigdy nie wyprzedza niezakończonego
  deploymentu", „zawsze zostaw najnowszy i najnowszy udany rekord per repo/środowisko".

Ten rdzeń jest **dobrze wyizolowany i mały**: `deployment-logic.js` 137, `version-resolution.js` 92,
`env-drift.js` 88, `tree-diff.js` 69 linii — razem ~386 linii czystych funkcji po stronie serwera. To
bardzo dobry znak.

**Subdomeny wspierające (supporting) — specyficzne dla organizacji, ale nie przewaga**

- **Rytm pracy zespołu**: `jira-model.js`'s `rhythmOf()` z pięcioma wartościami (`auto`/`pi`/`sprint`/
  `release`/`flow`) i szablon nazewnictwa PI. To uogólnienie SAFe-owego PI na przypadek najemcy, który
  SAFe nie używa — patrz II.5.
- **Konfiguracja i onboarding najemcy**: boardy, śledzone repozytoria, `version_file`,
  `drift_ignore_paths`, źródła flag z priorytetami, `server/ui/` z listą kroków „Getting started".
- **Retencja i uczciwość między najemcami**: `retention.js`, `rate-limit.js`, budżet czasu na najemcę
  w jednym przebiegu.

**Subdomeny generyczne (generic) — zbudowane we własnym zakresie**

- uwierzytelnianie i sesje (`github-oauth.js` 72, `sessions.js` 58),
- członkostwo i zaproszenia (`invitations.js` 178, `tenants.js` 241),
- szyfrowanie sekretów (`secret-box.js` 48, AES-256-GCM z tenant id jako associated data),
- migracje bazy (`migrate.js` 66 — ręcznie napisane, pod advisory lockiem),
- transport webhooków (`webhooks.js` 144 — tylko kolejkowanie klucza do `sync_requests`).

**Wniosek strategiczny.** Rozkład objętości kodu jest odwrotnie proporcjonalny do „rdzeniowości": rdzeń to
kilkaset linii czystych funkcji, a największe pliki (`web.js` 1090, `jira-sync.js` 558, `flags.js` 499)
obsługują mieszankę subdomen wspierających i generycznych. To **zdrowy** układ — ale ma praktyczną
konsekwencję: wysiłek refaktorowy warto kierować na obniżenie kosztu zmian w subdomenach generycznych
(Problem 1: podział routingu), a nie na „upiększanie" rdzenia, który już jest w dobrym stanie. Rdzeń należy
natomiast chronić testami parzystości (Problem 3), bo to jedyne miejsce, gdzie regresja kosztuje zaufanie
do produktu.

**[propozycja]** Subdomeny generyczne (sesje, zaproszenia, szyfrowanie tokenów, migracje) to ~550 linii
własnego kodu, który nie daje przewagi i musi być utrzymywany w nieskończoność. Nie rekomenduję ich dziś
wymieniać — są małe, przetestowane i działają — ale przy następnej większej zmianie w tym obszarze warto
świadomie zapytać, czy nie taniej wziąć gotowe. Decyzja wymaga potwierdzenia u właściciela produktu.

## II.2 Mapa kontekstów

Cztery konteksty z jasnymi granicami wykonania plus dwa systemy zewnętrzne:

```
  +-----------------------------+          +------------------------------+
  | File-based Sync             |          | SaaS Backend                 |
  | scripts/ + docs/data/*.json |          | server/ (Fastify + Postgres) |
  | single-tenant, GitHub       |<========>| multi-tenant, RLS            |
  | Actions                     | ROWNOLEGLA|                              |
  +--------------+--------------+ IMPLEM.  +-----------+------------------+
                 |                                      |
                 |  Published Language: ksztalt data/*.json
                 +--------------+-----------------------+
                                v
                 +------------------------------+   +-----------------------+
                 | Dashboard UI                 |   | Konfiguracja          |
                 | docs/app-*.js                |   | server/ui/ +          |
                 | (jeden model, dwa zrodla)    |   | components.json       |
                 +------------------------------+   +-----------------------+

  ACL: github-app.js, atlassian.js, jira-model.js  -->  GitHub API, Atlassian API
  OHS: POST /api/flags/ingest (schemaVersion: 2)   <--  dowolne zrodla flag najemcy
```

**Krawędź 1: File-based Sync ↔ SaaS Backend — równoległa implementacja (najdroższa krawędź).**
To nie Shared Kernel (kod nie jest wspólny) ani Conformist — to dwie niezależne implementacje tego samego
modelu domenowego, utrzymywane w zgodności ręcznie, regułą „napraw w obu miejscach". W DDD to najdroższa z możliwych
relacji: koszt rośnie z każdą zmianą reguły, a zgodność nie jest nigdzie wymuszona. Dowód, że koszt jest
realny, a nie teoretyczny: pary plików już się różnią (Problem 3). **Hot spot: ta relacja nie ma daty
wygaszenia** — „dopóki sync plikowy nie zostanie wygaszony" nie określa, kiedy ani czy w ogóle (Pytanie otwarte 1).

**Krawędź 2: SaaS Backend → Dashboard UI — Published Language, ale w starym języku.**
`server/lib/dashboard-data.js` (135 linii) istnieje wyłącznie po to, aby serwer produkował **te same
kształty, co `data/*.json`**. Z punktu widzenia frontendu to bardzo dobra decyzja: `docs/app-data.js`
przełącza źródło jedną zmienną (`API_TENANT_ID`) i nie wie, kto go karmi; cała reszta frontendu nie zmieniła
się ani o linijkę. Ale kierunek zależności jest odwrócony względem tego, kto ma bogatszy model:
**nowszy, wielodzierżawczy, trójstanowy model serwera jest Conformist wobec starszego formatu plikowego.**
Widać to wprost w `flags.js:449` — `enabled: v.state !== 'off'` — boolean jest wyliczany po to, by zmieścić
trójstanowy `off`/`on`/`partial` w starym kontrakcie. Każde nowe pojęcie po stronie serwera musi najpierw
udać kształt plikowy. To długoterminowy hamulec rozwoju modelu (Pytanie otwarte 2).

**Krawędź 3: SaaS → GitHub / Atlassian — Anticorruption Layer, częściowo szczelny.**
`github-app.js` i `atlassian.js` izolują mechanikę uwierzytelniania i wywołań, a `jira-model.js` tłumaczy
obcy model na własny (sprint → increment, rytm boardu). To właściwy wzorzec. Ale ACL nie jest szczelny:
obce pojęcia Jiry przeciekły do własnego modelu i do schematu bazy (`jira_boards`, `jira_pis`,
`jira_issues`, pojęcie „sprint" obecne aż do frontendu). Praktyczna konsekwencja: zmiana po stronie
Atlassiana w modelu boardów/sprintów nie zatrzyma się na warstwie ACL. To świadomy kompromis (pełna
translacja byłaby droga i mało czytelna) — warto go tylko nazwać, nie naprawiać.

**Krawędź 4: Źródła flag → SaaS — Open Host Service (wzorowa).**
`POST /api/flags/ingest` z jawnym `schemaVersion: 2`, własnym tokenem per źródło, pełnym stanem flag per
środowisko i regułą „starsza wiadomość nie cofa nowszej" to podręcznikowy Open Host Service: jawnie
wersjonowany, publiczny kontrakt, który nie zakłada niczego o tym, jak najemca trzyma swoje flagi. Decyzja
z 2026-10-16 („flagi są wypychane z zewnątrz, ShipScope ich nie czyta") jest kluczową decyzją strategiczną
całego projektu — to ona pozwala obsłużyć najemcę z plikami build-time, z serwisem runtime i bez żadnych
flag jednym modelem. Warto, by ta decyzja miała własny ADR, bo dziś żyje tylko w prozie `CLAUDE.md`.

**Nierówność kontraktów (obserwacja):** `scripts/lib/flag-ingest.js` obsługuje `schemaVersion: 1`
(single-tenant), a serwer `schemaVersion: 2` — i `CLAUDE.md` wprost mówi, że serwer **celowo nie portuje**
tej biblioteki. To jedyne miejsce na mapie, gdzie duplikacja została świadomie **odrzucona** na rzecz
rozwidlenia kontraktu. Dobra decyzja (dwa kontrakty dla dwóch różnych klas klientów), ale oznacza, że
najemca migrujący ze sync'u plikowego na SaaS musi przepisać swój nadawca flag — to fakt produktowy, nie
tylko techniczny, i powinien być widoczny w planie wygaszenia.

## II.3 Projekt taktyczny — agregaty, niezmienniki, zdarzenia

Projekt nie używa klas agregatów ani encji — model to tabele Postgresa plus moduły funkcyjne. **To nie
jest błąd**: w czystym JS bez typów styl „dane + czyste funkcje" jest dojrzałym wyborem i spójnym
z resztą repo. Nie rekomenduję wprowadzania klas — koszt przewyższa zysk. Czego brakuje, to **jawnego
miejsca na niezmienniki**.

Agregaty widoczne w schemacie (granica = to, co musi być spójne w jednej transakcji):

| Agregat (root) | Składowe | Niezmiennik, który dziś gdzieś żyje |
|---|---|---|
| `Tenant` | `memberships`, ustawienia, `deployment_retention_days` | „nie można usunąć ostatniego admina"; „każda tabela najemcy kaskaduje z `tenants`" |
| `Invitation` | token (hash), status | „jednorazowy odbiór przez warunkowy `UPDATE`" |
| `TrackedRepo` | `drift`, `version_file`, `drift_ignore_paths` | „drift przeliczany tylko gdy zmienił się najnowszy udany deploy albo poprzednia próba zawiodła; nieudane porównanie zachowuje poprzednią wartość" |
| `Deployment` | statusy, `resolved_ref`, `rollback` | „kursor nigdy nie wyprzedza niezakończonego deploymentu"; „zawsze zostaw najnowszy i najnowszy udany" |
| `FlagSource` | `ingest_tokens`, `priority`, `kind` | „token należy do dokładnie jednego źródła" |
| `Flag` | `flag_values`, `flag_value_history`, pola ręczne | „starsza wiadomość nie cofa nowszej"; „ręczne `manual_jira_keys` nigdy nie są nadpisywane przez nadawcę"; „flaga bez raportującego źródła nie jest widoczna" |
| `JiraBoard` | `jira_pis`, `jira_issues`, `rhythm`, `pi_template` | „sprint issue'a to ten, którego id jest na synchronizowanym boardzie" |
| `JiraConnection` | refresh token (szyfrowany) | „access token mintowany per użycie pod blokadą wiersza, bo Atlassian rotuje refresh token" |

Każdy z tych niezmienników jest dziś **prawdziwy i przetestowany** — ale rozproszony: część w SQL
(warunkowy `UPDATE`, kaskady, `FOR UPDATE`), część w kodzie modułu wśród zapytań, część wyłącznie w prozie
`CLAUDE.md`. Nie ma jednej listy, którą przegląd kodu mógłby odhaczyć.

**[propozycja], tania i zgodna ze stylem repo**: nie wprowadzać klas, ale (a) wynieść niezmienniki
wyrażalne jako czyste funkcje do `*-logic.js` z nazwami branymi z języka domeny (Problem 2), i (b) oznaczyć
pozostałe komentarzem `@invariant` w jednym, przewidywalnym miejscu — nad funkcją, która ich pilnuje.
Zysk nie jest estetyczny: dzisiejsze JSDoc-i w repo już opisują **kształt** argumentów (wymóg z `CLAUDE.md`
„Type discipline"), ale nie opisują **reguły**. Dołożenie `@invariant` zamyka tę lukę tym samym narzędziem.

**Zdarzenia domenowe.** W systemie są prawdziwe zdarzenia („deployment się udał", „flaga przełączona",
„issue rozwiązany"), ale modelowane niejednolicie — trzy różne polityki czasu w jednym produkcie:

| Dziedzina | Polityka | Konsekwencja |
|---|---|---|
| Flagi | pełny log zdarzeń (`flag_value_history`), bez retencji | pamięta wszystko, odpowiedź dashboardu rośnie bez ograniczeń (Problem 2) |
| Deploymenty | snapshot + retencja (7-730 dni) + wieczny kursor i `issue_deployments` | zapomina szczegóły, pamięta fakty („czy to kiedykolwiek pojechało") |
| Issues Jiry | pełna podmiana bieżącego increment, starsze jako snapshoty | nie pamięta zmian w przeszłych increments |

Każda z tych polityk jest osobno uzasadniona i udokumentowana. Problem jest w tym, że **nie są nazwane
jako jedna decyzja**, więc pytanie „czy ShipScope pamięta X" ma trzy różne odpowiedzi zależnie od X.
To kandydat na jeden ADR („polityki pamięci ShipScope") plus jedno zdanie w glosariuszu — patrz Pytanie
otwarte 4.

## II.4 Connascence — gdzie i jak mocno rzeczy są ze sobą sprzężone

Ocena według rodzaju sprzężenia (statyczne: nazwa → typ → znaczenie → algorytm), siły i **lokalizacji**
(sprzężenie rozproszone po dwóch pakietach kosztuje znacznie więcej niż to samo sprzężenie w jednym pliku).

| # | Para | Rodzaj | Lokalizacja | Koszt | Strażnik dziś |
|---|---|---|---|---|---|
| 1 | `scripts/lib/tree-diff.js` ↔ `server/lib/tree-diff.js` | **Algorytmu** | dwa pakiety | **wysoki** | brak |
| 2 | `scripts/lib/deployment-records.js` ↔ `server/lib/deployment-logic.js` | **Algorytmu** | dwa pakiety | **wysoki** | brak |
| 3 | kształt `data/*.json`: pisany przez `scripts/*`, odtwarzany przez `dashboard-data.js`, czytany przez `app-data.js` | Nazwy + Typu | **trzy** miejsca | średni | testy frontendu na fixture'ach |
| 4 | lista 15 tabel RLS: migracja `002` ↔ każde `withScope` ↔ proza w `CLAUDE.md` | Konwencji | rozproszona | średni | `tenant-delete.test.js` (tylko kaskady), fail-safe RLS |
| 5 | kolejność `<script>` w `index.html` ↔ co wolno wykonać w czasie ładowania `app-*.js` | **Wykonania** | dwa pliki | średni | realny bug w przeszłości, dziś tylko komentarz |
| 6 | numer wersji w trzech plikach `package*.json` | Wartości | trzy pliki | niski | `test/release.test.js` ✔ |
| 7 | `schemaVersion` kontraktu ingestu ↔ nadawcy u najemców | Nazwy (jawnie wersjonowana) | poza repo | niski | wersjonowanie ✔ |

**Interpretacja.** Pozycje 1 i 2 to najgorszy możliwy układ: sprzężenie **algorytmu** (najsilniejszy
rodzaj statycznego — zgodność musi być co do zachowania, nie tylko nazw czy typów) **rozproszone między
dwa pakiety** (najdroższa lokalizacja), **bez żadnego strażnika**. Co ważne, nie da się ich usunąć bez
usunięcia przyczyny (wygaszenie sync'u plikowego). Dlatego rekomendacja z Problemu 3 nie próbuje usunąć
sprzężenia, a **obniżyć jego koszt**: test parzystości zamienia „zgodność pilnowana pamięcią
kontrybutora" na „zgodność pilnowana przez CI". To dokładnie to, co zrobiono już dla pozycji 6.

Pozycja 5 zasługuje na odnotowanie, bo jest to connascence **wykonania** (dynamiczna, zwykle droższa niż
statyczna) i już raz zamieniła się w prawdziwy błąd widoczny tylko na `file://`. Dziś pilnuje jej wyłącznie
komentarz. Przy podziale `app-technical.js` (Problem 5) liczba plików w łańcuchu rośnie, więc ryzyko rośnie
proporcjonalnie. **[propozycja]**: minimalny test ładujący wszystkie `docs/app-*.js` w kolejności
z `index.html` do jednego kontekstu `vm` i sprawdzający, że nie rzuca — projekt ma już całą infrastrukturę
(`test/frontend-render.test.js` robi dokładnie takie ładowanie), więc koszt to kilkanaście linii, a test
odtwarza warunki tamtego błędu.

Pozycja 3 jest ciekawa z punktu widzenia planu: dopóki kształt `data/*.json` jest kontraktem trzech
niezależnych miejsc, każde nowe pole domenowe wymaga zmiany w trzech. Wygaszenie sync'u plikowego usuwa
jedno z tych miejsc i obniża koszt — to konkretny, wymierny argument za decyzją z Pytania otwartego 1.

## II.5 Język wszechobecny — gdzie system mówi dwoma językami

Dobra wiadomość najpierw: **w jednym obszarze język wszechobecny jest w tym projekcie wzorowy.** Pojęcia
`none` / `deployed` (kod pojechał, flaga wyłączona) / `released` (kod pojechał, flaga włączona) /
`partial`, `deployed_code_only`, oraz rozdzielenie „deployed ≠ done" są: (a) nazwane jednolicie w kodzie
backendu i frontendu, (b) wyjaśnione użytkownikowi w tooltipach i statycznej legendzie, (c) świadomie
rozróżnione tam, gdzie łatwo byłoby je zlać (rozjazd między `prodStatusBucket()` i
`issueIsReleasedToProd()` jest udokumentowany jako **celowy**, z podaniem powodu). Etykiety są tu częścią
modelu, nie warstwą prezentacji — dokładnie tak, jak powinno być.

Zidentyfikowane rozjazdy, każdy z dowodem w kodzie:

**1. `component` vs `tracked repo` — ta sama rzecz, dwie nazwy, oba języki żywe.**
Kontekst plikowy i frontend mówią `component` (`docs/components.json`, `COMPONENT` w każdym skrypcie,
`orderedComponents()`); serwer mówi `tracked_repos`. Dowód, że to jedno pojęcie, a nie dwa: istnieje
jawny tłumacz między językami — `flags.js:416` woła `componentOf(Number(s.repo_id))`, żeby zamienić
`repo_id` serwera na `component` dashboardu. Tłumacz na krawędzi kontekstów jest w porządku (to normalny
element ACL); problemem jest to, że **żadna z nazw nie jest wskazana jako obowiązująca docelowo**, więc
każda nowa funkcja losuje. Pytanie otwarte 3.

**2. `PI` vs `increment` — dwa poziomy abstrakcji tego samego, i to jest dobra zmiana w pół drogi.**
Serwer świadomie uogólnił SAFe-owe PI do pojęcia `increment` z pięcioma rytmami (`rhythmOf()`,
`jira-model.js:55`: `pi` / `sprint` / `release` / `flow` / `auto`), bo nie każdy najemca używa SAFe —
komentarz w kodzie mówi wprost: „sprint nienazwany po PI jest własnym increment, więc zespół bez PI też
dostaje dashboard" (linie 137-138). To **podręcznikowy przykład pogłębienia modelu**: nowa, szersza nazwa
wprowadzona świadomie, gdy stara okazała się za wąska. Problem: pogłębienie nie dotarło do krawędzi —
nazwy funkcji po stronie serwera mieszają oba języki (`boardIncrements()` i `currentIncrements()` obok
`currentPiOf()`, `piOfSprint()`, `previousPiOf()`, `comparePiDesc()`), a kontrakt dashboardu i frontend
wciąż mówią wyłącznie `pi` / `currentPi` / `selectedPi`. W jednym działającym systemie żyją więc dwa
poziomy abstrakcji tej samej rzeczy. **[propozycja]**: przy najbliższej zmianie kontraktu
`dashboard-data` dodać `increment` jako nazwę główną, zachowując `pi` jako alias do wygaszenia; nie robić
tego osobnym refaktorem, bo przejście przez trzy miejsca z pozycji 3 tabeli connascence nie opłaca się
samo z siebie.

**3. `source` ma dwa różne znaczenia — słowo-sygnał.**
`flagsMeta[key].source` to **rodzaj/slot** (`'build'` albo `'runtime-be'`), a `flag_sources` to
**konkretny nadawca** (nazwa, priorytet, opcjonalne repo). Kod musi te znaczenia rozplatać w jednej linii:
`slot: s.kind === 'runtime' ? 'runtime-be' : 'build'` (`flags.js:415`) — czyli kolumna nazywa się `kind`,
pole wyjściowe `slot`, a słowo `source` jest zajęte przez trzecie znaczenie. W rozmowie z użytkownikiem
albo ekspertem „source flagi" będzie dwuznaczne. Rekomendacja: utrwalić w glosariuszu rozdział
**źródło (nadawca)** / **slot (build lub runtime-be)** i konsekwentnie nie używać `source` na slot
w nowym kodzie.

**4. `enabled` to dziś wniosek, nie fakt.**
Kontrakt v2 wprowadził trójstanowe `off`/`on`/`partial` plus `rollout`, ale dashboard nadal dostaje
boolean wyliczany jako `v.state !== 'off'` (`flags.js:449`). Zdanie „flaga jest włączona" znaczy więc dziś
coś innego niż przed v2 — flaga w `partial` z 10-procentowym rolloutem jest `enabled: true`. To nie bug
(pole `state` i `rollout` jadą obok), ale jest to **słowo-sygnał**, które przy rozmowie o danych trzeba
dopytać. Bezpośrednio powiązane z krawędzią Conformist z II.2.

**5. Wiedza domenowa mieszka w pliku reguł dla agenta, nie w glosariuszu.**
Praktycznie cała wiedza o modelu — co znaczy drift, dlaczego liczba commitów to tylko kontekst, czym różni
się `released` od `deployed_code_only`, trzy polityki pamięci — jest zapisana, i to bardzo starannie,
w prozie `CLAUDE.md`. To działa dla agenta czytającego cały plik, ale ma dwie wady: człowiek szukający
jednej definicji musi czytać tysiące linii, a plik reguł dla AI powinien pozostać krótki, żeby najważniejsze
reguły nie trafiały w najsłabszą strefę uwagi modelu.

**Rekomendacja (najlepszy stosunek zysku do kosztu w całym raporcie)**: wyciągnąć `docs/GLOSSARY.md` —
jedno miejsce, jedna tabela: pojęcie → definicja jednym zdaniem → nazwa w kontekście plikowym → nazwa
w kontekście SaaS → nazwa w UI. Pierwsze wpisy wprost z tej analizy: component/tracked repo,
PI/increment, source/slot, enabled/state, drift (drzewo plików vs liczba commitów), released/deployed/
deployed_code_only/partial, rollback, rhythm, flag source/ingest token. Koszt: ~godzina (treść już
istnieje, trzeba ją tylko przenieść i uporządkować). Zysk: każdy przyszły PR, każdy nowy kontrybutor
i każdy agent AI czyta jedno krótkie miejsce zamiast wnioskować z prozy; a `CLAUDE.md` może odsyłać
`@docs/GLOSSARY.md` zamiast powtarzać definicje.

---

## Priorytetyzacja

| # | Zadanie | Źródło | Koszt | Ryzyko | Zysk |
|---|---|---|---|---|---|
| A | `docs/GLOSSARY.md` — jedna tabela pojęć z nazwami per kontekst | II.5 | ~1 h | brak | **bardzo wysoki** — wspólny język dla ludzi i agentów |
| B | Strażnik granic modułowych (wyr. regularne w CI) | Problem 4 | ~20 linii | brak | wysoki — zapobiega przyszłemu dryftowi |
| C | Test parzystości `tree-diff` i reguł deploymentu na wspólnych fixture'ach | Problem 3, II.4/1-2 | kilka h | brak | **wysoki** — chroni rdzeń domeny |
| D | `web.js` → plugin Fastify per dziedzina | Problem 1 | średni (mechaniczny) | niskie | wysoki — czytelność, mniejsze PR-y |
| E | Wydzielenie `flags-logic.js`; reszta reguł Jiry do `jira-model.js` | Problem 2 | średni-wysoki, etapami | niskie | wysoki — testowalność reguł biznesowych |
| F | ADR-y: „flagi wypychane z zewnątrz" oraz „polityki pamięci ShipScope" | II.2, II.3 | ~2 h | brak | średni — utrwala decyzje, dziś tylko w prozie |
| G | Test ładowania `app-*.js` w kolejności z `index.html` | II.4/5 | ~15 linii | brak | średni — odtwarza warunki przebytego błędu |
| H | Dalszy podział `app-technical.js` (931 linii) | Problem 5 | niski | niskie | średni — czytelność |
| I | Strażnik `withScope()` + lista tabel RLS jako stała w kodzie | Problem 6 | niski | brak | średni — siatka nad istniejącą ochroną w bazie |
| J | Okno czasowe / limit na `flag_value_history` w dashboardzie | Problem 2 | niski | **wymaga decyzji** | średni — usuwa nieograniczony wzrost odpowiedzi |

Kolejność realizacji: **A** i **B** najpierw (razem jedno popołudnie, zero ryzyka, od razu chronią przed
powiększaniem długu podczas reszty prac), potem **C** (chroni rdzeń przed regresją, zanim zacznie się
przestawiać kod), potem **D** (najbardziej widoczny zysk, mechaniczny), potem **E** etapami. **F**, **G**,
**H**, **I** jako prace „w tle" przy okazji zmian w tych plikach. **J** dopiero po odpowiedzi na Pytanie
otwarte 4 — to decyzja produktowa, nie techniczna.

## Proponowana docelowa struktura `server/`

```
server/
  web.js                 -- bootstrap: Fastify, cookie, app.register(...) x N, listen
  worker.js              -- bez zmian
  routes/                -- NOWY: jeden plugin Fastify per dziedzina (Problem 1)
    health.js  auth.js  tenants.js  invitations.js  github.js
    jira.js    flags.js  dashboard.js  ui.js  webhooks.js
  lib/
    <rdzen, bez zmian: deployment-logic, version-resolution, env-drift, tree-diff, jira-model>
    scope.js             -- + eksportowana lista tabel RLS (Problem 6)
    flags.js             -- orchestrator: withScope, SQL, delegacja regul
    flags-logic.js       -- NOWY: czyste reguly (checkPayload, priorytety, slot, widocznosc, merge jiraKeys)
    jira-sync.js         -- orchestrator (I/O, HTTP, SQL)
    jira-model.js        -- istniejacy; + reguly wyniesione z jira-sync.js
    <reszta bez zmian>
  migrations/            -- bez zmian
  test/                  -- bez zmian
test/
  lib-parity.test.js     -- NOWY: tree-diff i reguly deploymentu, scripts/lib <-> server/lib (Problem 3)
  app-load-order.test.js -- NOWY: ladowanie docs/app-*.js w kolejnosci z index.html (II.4/5)
docs/
  GLOSSARY.md            -- NOWY: jezyk wszechobecny, nazwy per kontekst (II.5)
```

Żadna z tych zmian nie wymaga ruszania schematu bazy, kontraktów API (endpointy pod tymi samymi
ścieżkami), ani frontendu. To refaktor wewnętrznej organizacji kodu plus trzy nowe artefakty — nie zmiana
zachowania.

## Pytania otwarte (wymagają decyzji właściciela produktu, nie analizy kodu)

1. **Kiedy — i czy w ogóle — wygaszany jest sync plikowy?** Bez odpowiedzi najdroższa krawędź na mapie
   kontekstów (równoległa implementacja tego samego modelu, II.2/1) jest bezterminowa, a koszt rośnie
   z każdą zmianą reguły domenowej. Odpowiedź zmienia też opłacalność punktów C i E.
2. **Czy kształt `data/*.json` ma zostać trwałym kontraktem publicznym SaaS, czy to tylko tymczasowa
   zgodność?** Decyduje, czy `dashboard-data.js` to tymczasowy ACL (do usunięcia), czy Published Language
   (do wersjonowania). Dziś model serwera jest Conformist wobec starszego formatu (II.2/2) i to blokuje
   wprowadzanie nowych pojęć domenowych.
3. **`component` czy `tracked repo` — która nazwa obowiązuje docelowo?** (II.5/1). Pytanie o jedno słowo,
   ale bez odpowiedzi każda nowa funkcja i każdy nowy ekran losuje.
4. **Czy historia flag ma być pełnym logiem na zawsze?** Dziś `flag_value_history` jest czytana bez limitu
   do odpowiedzi dashboardu (`flags.js:427-431`), podczas gdy deploymenty mają retencję, a issues są
   podmieniane. Trzy różne polityki pamięci w jednym produkcie (II.3) — do rozstrzygnięcia jako jedna
   decyzja, nie trzy osobne.
5. **Czy „status wydania" (`released` / `deployed` / `partial` / `deployed_code_only`) to pojęcie
   właściciela produktu, czy wymyślone przez implementację?** To **rdzeń modelu** — cała wartość produktu
   zależy od tego, czy te cztery stany odpowiadają temu, jak biznes faktycznie mówi o wydaniach. Warto
   potwierdzić u eksperta domeny i dopisać potwierdzenie do glosariusza. **[założenie]** w tym raporcie:
   odpowiadają, bo są konsekwentnie używane w całym kodzie i wyjaśnione użytkownikowi w UI — ale to wniosek
   z kodu, nie potwierdzenie od eksperta.
6. **Czy subdomeny generyczne (sesje, zaproszenia, szyfrowanie tokenów, migracje — ~550 linii) mają
   pozostać własnym kodem?** (II.1). Dziś są małe i działają; pytanie wraca przy następnej większej
   zmianie w tym obszarze.
