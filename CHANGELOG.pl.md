# Changelog

*English version: [CHANGELOG.md](CHANGELOG.md)*

Najważniejsze zmiany w ShipScope, od najnowszych. Projekt nie posiada numeracji wersji (jest to wewnętrzny
dashboard, nie publikowany pakiet), dlatego wpisy są pogrupowane według dat. Informacje o tym, czym jest
ShipScope, znajdują się w `README.pl.md`, pełne techniczne odniesienie w `CLAUDE.md` (po angielsku), a
wyjaśnienie sposobu liczenia poszczególnych wartości/badge'y w `FAQ.pl.md`.

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
