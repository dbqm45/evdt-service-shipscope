# Product view — plan wdrożenia

*English version: [PRODUCT-VIEW-IMPLEMENTATION-PLAN.md](PRODUCT-VIEW-IMPLEMENTATION-PLAN.md)*

> **Status: zaproponowany plan, jeszcze nie zaakceptowany do wdrożenia.** Ten dokument przekłada analizę
> rozbieżności z `PRODUCT-VIEW-NOTES.md` na konkretne, wdrożeniowe fazy. Nic z tego planu nie zostało
> zakodowane. Fazy, których pierwszym krokiem jest „decyzja: …”, są wyraźnie zablokowane do czasu
> uzyskania odpowiedzi z sekcji „Open questions carried over” w `PRODUCT-VIEW-NOTES.md` — nie zaczynaj ich
> kodować na podstawie przyjętej z góry odpowiedzi.

## Jak czytać ten plan

Każda faza zawiera: cel, decyzję, od której zależy (jeśli jest), konkretne zmiany w kodzie/danych oraz
sposób weryfikacji w realiach tego repozytorium bez zestawu testów — albo jednorazowy, niezapisywany do
repo skrypt Node odpalony na przykładowych/mockowych danych JSON (w tym samym duchu, w jakim ta sesja
robocza sama weryfikowała zmiany w `sync-jira.js`), albo ręczny test w przeglądarce na `docs/index.html`,
z wbudowanym zbiorem danych `FALLBACK` (otwarcie przez `file://`) albo ręcznie zmodyfikowaną kopią
prawdziwych `docs/data/*.json`.

Fazy są uporządkowane tak, by najpierw wdrażać to, co najszybsze; elementy zablokowane nierozstrzygniętą
decyzją są przesunięte na koniec, żeby nigdy nie blokowały gotowej do zrobienia pracy.

## Kolejność priorytetów i uzasadnienie

| Kolejność | Gap | Dlaczego tutaj |
|---|---|---|
| 1 | **A** — alert starzenia „ghost flag" | Nazywany wielokrotnie (R2/R4/R5) jako jedyny najbardziej wartościowy brakujący sygnał, a — to własne ustalenie tego planu — tańszy niż zakładał `PRODUCT-VIEW-NOTES.md`: `docs/app.js` już wczytuje `flag-state-history.json` do `state.flagStateHistory` i już liczy „dni od ostatniej zmiany stanu flagi" w dwóch miejscach (`flagStaleWarning()`, `staleFlagDaysBreakdown()`). Gap A jest *odwrotnością* tej istniejącej logiki (dni, odkąd flaga jest OFF po wdrożeniu, nie dni ON po tym, jak wszystko już jest Done) — nowy warunek, ale wielokrotnie użyta infrastruktura. Brak nowego skryptu synchronizacji, brak zmiany schematu. |
| 2 | **D** — sygnał „bug blokuje epika" | Mały, addytywny, bez blokującej decyzji, służy bezpośrednio temu samemu przypadkowi użycia (akceptacja PM) co Gap A. Naturalna para z Gap A: wdrożyć razem w jednym wydaniu. |
| 3 | **E** — toggle „ukryj Taski" | Najtańszy element na liście (własne stwierdzenie `PRODUCT-VIEW-NOTES.md`), bez blokującej decyzji, ale mniejsza wartość niż A/D, więc po nich, nie przed. |
| 4 | **F** — przemianowanie na 4-poziomowy język sesji | Czysto kosmetyczne (według notatek), a otwarte pytanie to „jaki język", nie „czy robić" — niskie ryzyko, niska wartość, do wykonania po uzgodnieniu treści, w każdej chwili po powyższej pracy funkcjonalnej. Umieszczone przed B/C, żeby nie było przez nie blokowane. |
| 5 | **B** — hybrydowy zakres czasowy | Realnie użyteczne, ale ma wyraźne otwarte pytanie („zastąpić czy dodać trzecią opcję?"), którego ten plan nie powinien rozstrzygać jednostronnie — zaczyna się od kroku decyzyjnego. Umiarkowany koszt (dotyka filtra zakresu sprintu, kafelków podsumowania i `piWorkItemCounts()`). |
| 6 | **C** — grupowanie po zespole/boardzie | Potwierdzone w notatkach jako „największy, zupełnie nowy element modelu danych w całej tej liście" — własna analiza kodu w tym planie potwierdza tę ocenę kosztu (patrz Faza 6). Ma też najwięcej otwartych pytań (id pola custom, zmiana schematu, kształt UI, pytanie o poziom SAFe). Na końcu: największe, najbardziej zależne od decyzji, i nic innego w tym planie od niego nie zależy. |

Uzasadnienie niewielkiego odejścia od czystego sortowania „wartość, potem koszt": D jest tanie *i*
tematycznie powiązane z A (obie odpowiadają na „czy ten epik jest faktycznie gotowy", pokazywane w tym
samym miejscu UI), więc wdrożenie ich razem jest tańsze niż powrót do obszaru Gap A tylko dla D później.

## Wyraźnie wyłączone z tego planu

Zgodnie z sekcją „Explicitly out of scope" w `PRODUCT-VIEW-NOTES.md` — nie zaplanowane tutaj, nie dotknięte
przez żadną z poniższych faz:
- Umożliwienie PM/PO przełączania flag funkcyjnych z ShipScope.
- Przeniesienie stanu flag do Jiry lub odwrotnie.

---

## Faza 0 — przygotowanie (bez widocznej zmiany) — ✅ zrobione

**Cel.** Potwierdzić dwie decyzje, których Gap A faktycznie potrzebuje, zanim napisze się dla niego
jakikolwiek kod (Gap A jest pierwszy w priorytecie, więc jego decyzje nie mogą czekać na osobną fazę
„decyzyjną").

**Rozstrzygnięte.** Próg: **30 dni**. Zakres: **per-wiersz/per-epik, tylko w aktualnie wczytanym PI** —
bez skanu cross-PI. Patrz Faza 1.

**Potrzebne decyzje (zapytać użytkownika, nie zakładać):**
- *decyzja:* jednostka i wartość progu starzenia „ghost flag" — dni (rekomendowane, patrz uzasadnienie
  Gap A w `PRODUCT-VIEW-NOTES.md`: długość sprintu nie jest jednolita między boardami) czy sprinty. Jeśli
  dni, to dokładna liczba. Język samej sesji („od 3 sprintów") sugeruje orientacyjnie 30–45 dni jako punkt
  odniesienia, ale konkretna liczba to decyzja biznesowa, nie coś do przyjęcia w ciszy.
- *decyzja:* zakres — adnotacja tylko na poziomie wiersza, widoczna wyłącznie dla PI/issue aktualnie
  wczytanego (tanie, zgodne z zasadą „ShipScope pokazuje bieżący stan, nie jest narzędziem skanującym",
  już ustanowioną gdzie indziej w tym repo), czy lista cross-PI, niezależna od tego, co jest wczytane
  (wymaga skanowania każdego shardu PI, czego architektura celowo unika gdzie indziej). Poniższa Faza 1
  zakłada odpowiedź „na poziomie wiersza", bo nic innego w kodzie nie skanuje crossem shardów PI, a
  zrobienie tego tutaj byłoby nowym, kosztownym precedensem — ale potwierdź przed kodowaniem.

**Zmiany.** Brak — ta faza jest punktem kontrolnym go/no-go, nie kodem.

**Weryfikacja.** Nie dotyczy.

---

## Faza 1 — Gap A: alert starzenia „ghost flag" (na poziomie wiersza) — ✅ zrobione

**Cel.** Pokazać „wdrożone na prod N dni temu, flaga wciąż OFF" bezpośrednio na wierszu work itemu/rollupie
Epika, wykorzystując wzorzec „dni od `changedAt`" już sprawdzony w `flagStaleWarning()`/
`staleFlagDaysBreakdown()`.

**Zależy od.** Dwóch decyzji z Fazy 0 (wartość progu, zakres = na poziomie wiersza).

**Dane już dostępne (brak nowego skryptu synchronizacji, brak zmiany schematu):**
- `state.flagStateHistory` (z `docs/data/flag-state-history.json`, już wczytywane w `loadData()`,
  `docs/app.js` ~linia 468) — append-only, nigdy nieprzycinane, ma każdy flip flagi, jaki kiedykolwiek
  zapisano.
- `state.deployments` — daje `deployedAt` dla odpowiedniego komponentu/env.
- `effectiveFlagState()` (istniejące) rozwiązuje *bieżący* stan flagi per key/env, ten sam helper, z
  którego już korzysta `flagStaleWarning`.

**Nowa logika (`docs/app.js`):**
1. `ghostFlagAge(issue, env)` (nowa, nazwa roboczo) — zwierciadło pojęcia „wdrożone, ale nie wydane" z
   `issueStatusForEnv`: dla issue, którego `issueStatusForEnv(issue, env).level` to `deployed` (kod
   wdrożony, flaga off) lub `partial`, policzyć `now - max(deployedAt wdrożenia dla tego env, ostatnie
   OFF `changedAt` flagi dla tego env)`. Wykorzystać istniejącą infrastrukturę
   `linkStatus()`/`issueLinks()`, już używaną w `issueStatusForEnv`, zamiast ponownie wyprowadzać
   rozwiązywanie linków. `deployed_code_only` (brak flagi w ogóle) jest wyraźnie poza zakresem tego alertu
   — nie ma flagi, która mogłaby zostać „ghost".
2. Stała `GHOST_FLAG_DAYS` (wartość z decyzji z Fazy 0) obok istniejącej stałej `STALE_FLAG_DAYS`, z
   komentarzem odróżniającym obie ("stale ON" vs. "ghost OFF" — przeciwne kierunki tego samego mechanizmu).
3. Podłączenie wyniku w:
   - `renderIssueRow()` — nowy tag/badge obok istniejących `jiraStatusTagHtml()`/`subtasksTagHtml()`
     (np. „⏳ Wdrożone na prod 42 dni temu · flaga OFF"), stylizowany jako ostrzeżenie (ponowne użycie
     wizualnej wagi `.tag-flagged` albo nowa klasa `.tag-ghost-flag` w `docs/style.css`).
   - `epicRollup()`/`renderEpicHeader()` — mały licznik („2 ghost flags") obok istniejącego paska „N/M
     wydane na prod", ograniczony do dzieci epika *w zakresie* (ta sama lista `children`, którą
     `epicRollup` już otrzymuje), więc respektuje aktywne filtry sprintu/typu/priorytetu, zgodnie z
     istniejącą regułą zakresu tego badge'a.

**Otwarta decyzja wizualna/treściowa (do rozstrzygnięcia przez recenzenta PR, nie blokuje):** dokładna
ikona/treść, czy potrzebny jest nowy token kolorystyczny w `docs/style.css`, czy wystarczy
`var(--nd-warn)`.

**Pliki dotknięte.** `docs/app.js` (nowa funkcja + 2 miejsca renderowania), `docs/style.css` (jeden nowy
styl badge'a, jeśli nie zostanie użyta istniejąca klasa), `CLAUDE.md` (sekcja „Frontend" — udokumentować
nowy sygnał na poziomie wiersza/epika tak, jak udokumentowany jest każdy inny sygnał na poziomie wiersza).

**Weryfikacja (brak zestawu testów).**
- Niezapisywany skrypt Node (nie commitowany), który kopiuje ciało nowej czystej funkcji z kilkoma
  ręcznie zbudowanymi obiektami testowymi (jeden issue `deployed` 90 dni temu z flagą OFF od tego czasu,
  jeden `released`, jeden `deployed_code_only`) i sprawdza oczekiwany wynik ghost/no-ghost oraz liczbę dni
  — ten sam, jednorazowy wzorzec już użyty w tej sesji do weryfikacji czystej logiki.
- Ręczny test: otworzyć `docs/index.html` przez `file://` (używa wbudowanego zbioru `FALLBACK`) albo
  tymczasowo zmodyfikować lokalną kopię `docs/data/flag-states.json`/`deployments.json`, przesuwając
  `changedAt`/`deployedAt` w przeszłość, potwierdzić, że badge pojawia się na odpowiednim wierszu i w
  rollupie epika, i znika po przełączeniu flagi na `released` lub gdy deploy jest zbyt świeży.

---

## Faza 2 — Gap D: sygnał „bug blokuje epika" — ✅ zrobione

**Cel.** Widoczny znacznik w nagłówku Epika, gdy wśród dzieci w zakresie jest otwarty Bug — „ten Epik nie
jest naprawdę gotowy do akceptacji, nawet jeśli jego Stories wyglądają dobrze."

**Zależy od.** Niczego (brak otwartej decyzji w notatkach dla tego gapu).

**Zmiany (`docs/app.js`):**
1. Nowy helper `epicHasOpenBug(children)` — `children.some(c => c.type === 'Bug' && c.statusCategory !==
   'done')`, ta sama lista `children`, którą już otrzymuje `epicRollup()` (więc zakres jest identyczny:
   respektuje aktywny filtr Typ/Priorytet/sprint, zgodnie z udokumentowaną regułą zakresu `epicRollup`).
2. `renderEpicHeader()` — wyrenderować mały, kontrastowy badge (np. czerwony/pomarańczowy „🐞 otwarty bug")
   obok istniejącego paska progresu `epicRollup`, gdy `epicHasOpenBug` jest prawdą. Sesja chce, by był
   wyeksponowany ("na samej górze") — umieścić w `.wi-epic-badges` (obok istniejącego tagu statusu Epika),
   nie w wierszu progresu, żeby był widoczny nawet gdy epik jest zwinięty.

**Pliki dotknięte.** `docs/app.js`, `docs/style.css` (jedna nowa klasa badge'a, prawdopodobnie można użyć
istniejącego czerwonego stylu `tag-status-blocked` zamiast wymyślać nowy kolor).

**Weryfikacja.** Takie samo podejście skryptu z fikstur jak w Fazie 1 (fikstura Epika z jednym otwartym
dzieckiem typu Bug i jednym bez); ręczny test w przeglądarce z ręcznie zmodyfikowanym shardem
`jira-issues/{pi}.json`, zawierającym dziecko `type: "Bug"`, `statusCategory: "indeterminate"` pod znanym
`epicKey`.

---

## Faza 3 — Gap E: toggle „ukryj Taski" — ✅ zrobione

**Cel.** Jednoklikowy sposób ukrycia Tasków bez utraty możliwości zobaczenia wszystkich innych typów
naraz (dzisiejszy `#filterTypeGroup` jest single-select, więc wybranie „Story" ukrywa też Bugi — nie to,
czego chce ten gap).

**Zależy od.** Niczego (brak otwartej decyzji w notatkach poza „czy single-select wystarczy" — ten plan
odpowiada: nie, zbudować toggle, bo notatki już stwierdzają, że single-select jest „funkcjonalnie bliski,
ale nie" tym samym).

**Zmiany:**
- `docs/index.html` — dodać mały checkbox/toggle obok `#filterTypeGroup` (np. `#filterHideTasks`), nie
  jako nowy wpis wewnątrz istniejącej kontrolki segmentowanej (zachowuje semantykę istniejącego
  single-select filtra Type bez zmian; to niezależna, dodatkowa warstwa wykluczenia nałożona na niego).
- `docs/app.js` — gdziekolwiek dzisiejszy filtr typu jest aplikowany do `state.jiraIssues` przed
  `groupIssuesByEpic()`/`issuesInSprintScope()`, dodać `&& (!hideTasks || issue.type !== 'Task')` do tego
  samego łańcucha filtrów. Musi się poprawnie komponować z istniejącym single-select Type (jeśli „Task"
  jest wybrany explicite w kontrolce segmentowanej, a toggle ukrywania Tasków też jest włączony, toggle
  wygrywa i lista jest pusta — akceptowalne, odzwierciedla to, jak niemożliwa kombinacja filtrów już się
  zachowuje gdzie indziej w Product view, bez specjalnego traktowania).
- Zachowanie przycisku „Clear": zdecydować, czy przycisk „Clear" (używany dla Type/Priority) resetuje też
  ten toggle. Rekomendacja: tak — to zwykły filtr, nie kontrolka zakresu jak Sprint/PI, więc powinien się
  zachowywać jak resztawierszfiltrów, nie jak `#filterSprint`.

**Pliki dotknięte.** `docs/index.html`, `docs/app.js`.

**Weryfikacja.** Ręczny test w przeglądarce: włączenie toggle'a, potwierdzenie, że Taski znikają z listy
nieprzypisanej i z dzieci epików, podczas gdy Stories/Bugi zostają; wyłączenie, potwierdzenie, że
wracają; potwierdzenie, że „Clear" resetuje toggle.

---

## Faza 4 — Gap F: przemianowanie wizualne na 4-poziomowy język sesji

**Cel.** Czysto kosmetyczne — dopasować tekst pigułek w `statusLabel()` (angielski i/lub dodać treść po
polsku) do framingu sesji: „W locie (Test)" / „Do akceptacji (QA)" / „Wdrożone technicznie (Prod, flaga
OFF)" / „Wydane (Released)".

**Zależy od.** *decyzja:* jaki język — sesja odbyła się po polsku, ale tekst UI `docs/app.js` jest dziś
angielski jako pierwszy. Ten plan **nie** wybiera za użytkownika; otwarte pytanie w
`PRODUCT-VIEW-NOTES.md` jest tu wyraźne. Dwie podopcje do przedstawienia użytkownikowi:
1. Zostać przy angielskim tekście pigułek, tylko przeformułować treść zgodnie z *framingiem* (np. „In
   flight (Test)" / „Pending acceptance (QA)" / „Shipped, flag off (Prod)" / „Released").
2. Wprowadzić dosłowną treść po polsku — co byłoby pierwszym przypadkiem tekstu UI nie po angielsku w tym
   angielskim-jako-pierwszy dashboardzie — większy precedens niż się wydaje, warty wyraźnego zgłoszenia,
   nie decydowania domyślnie.

**Zmiany (po decyzji).** `statusLabel()` jest dziś jedynym źródłem prawdy dla tego tekstu — zmienić 4
(5, licząc dzisiejsze „Code deployed" dla `deployed_code_only`) literały tekstowe tam. Żadna inna funkcja
nie musi się zmienić; wszystko inne już czyta przez `statusLabel()`/`statusClass()`.

**Pliki dotknięte.** `docs/app.js` (jedna funkcja), ewentualnie `docs/style.css`, jeśli nowa treść
wymaga innych szerokości badge'y.

**Weryfikacja.** Tylko ręczny test wizualny — to treść, nie logika. Potwierdzić brak przepełnienia layoutu
z nowymi, prawdopodobnie dłuższymi, ciągami na wąskich viewportach.

---

## Faza 5 — Gap B: hybrydowy zakres czasowy w ramach Epika — ✅ zrobione

**Cel.** Domyślny zakres Product view staje się „elementy bieżącego sprintu (każdy status) + elementy ze
starszych sprintów tego samego PI, które nie są jeszcze wydane" zamiast dzisiejszego surowego filtra
dokładnego dopasowania sprintu.

**Rozstrzygnięte.** Trzecia, wyraźna opcja (nie zamiennik domyślnego wyboru); hybrydowy zakres
współdzielony przez listę issue i kafelki podsumowania, tak jak dzisiejszy zakres sprintu.

**Zależy od.** *decyzja:* czy to **zastępuje** „bieżący sprint" jako domyślny (dzisiejszy
`refreshSprintSelect()` wstępnie wybiera bieżący sprint po nazwie), czy staje się **trzecią, wyraźną
opcją** obok dzisiejszego „All sprints" / jednego nazwanego sprintu? Ten plan rekomenduje wariant
„trzecia opcja" — jest odwracalny, nie zmienia nawyków osób już korzystających z selektora sprintu i jest
mniejszym diffem — ale to jest wyraźnie nierozstrzygnięte w `PRODUCT-VIEW-NOTES.md` i musi zostać
potwierdzone najpierw.

Także *decyzja:* czy hybrydowy zakres dotyczy tylko listy issues, czy też kafelków podsumowania/
`piWorkItemCounts()` (dziś obie części dzielą jeden zakres przez `issuesInSprintScope()` — rozdzielenie
ich byłoby widoczną dla użytkownika niekonsekwencją, warte wyraźnego zgłoszenia, nie szczegółem
implementacyjnym). Ten plan rekomenduje: obie części dzielą ten sam zakres, jak dziś, dla konsekwencji —
ale potwierdzić.

**Zmiany (zakładając potwierdzenie „trzecia opcja" + „zarówno kafelki, jak i lista"):**
1. `docs/app.js` — `SPRINT_ALL` jest dziś jedynym sentinelem; dodać drugi, np.
   `SPRINT_CURRENT_PLUS_UNRESOLVED`, obok istniejących literalnych nazw sprintów w `state.selectedSprint`.
2. `issuesInSprintScope(issues)` — gdy aktywny jest ten sentinel, zastąpić dzisiejszy filtr
   `names.includes(i.sprint)` przez: `currentSprintNames().includes(issue.sprint) || (isRealPi(issue.pi)
   && prodStatusBucket(issue) !== 'released')`. Wymaga `prodStatusBucket` (już zdefiniowanego wyżej w
   pliku, przed `issuesInSprintScope`) w zasięgu — już tam jest.
3. `refreshSprintSelect()` — dodać to jako nową `<option>` (etykieta np. „Bieżący sprint + nierozwiązane"),
   zdecydować o jej pozycji na liście (rekomendacja: zaraz po „All sprints", przed literalnymi nazwami
   sprintów) i czy staje się nowym domyślnym wyborem, czy domyślna zostaje literalna nazwa bieżącego
   sprintu/„All sprints" (kolejna poddecyzja wliczona w decyzję główną powyżej).
4. Obsługa Epików: `groupIssuesByEpic()`/`epicRollup()` nie wymagają zmian — już operują na liście, którą
   wyprodukował `issuesInSprintScope()`, z definicji.

**Pliki dotknięte.** `docs/app.js`, `docs/index.html` tylko jeśli nowa opcja potrzebuje wyjaśniającego UI
(np. tooltip na `#filterSprint`).

**Weryfikacja.** Skrypt z fikstur: 3 issues — jeden w bieżącym sprincie (każdy status), jeden ze starszego
sprintu już `released`, jeden ze starszego sprintu wciąż `deployed` — sprawdzić, że hybrydowy filtr
zachowuje dokładnie pierwszy i trzeci. Ręczny test w przeglądarce z realnym shardem PI z wieloma
sprintami.

---

## Faza 6 — Gap C: grupowanie i filtrowanie po zespole/boardzie

**Cel.** Rozwiązywanie `Team` per issue (pole Jira → fallback board → `Unassigned`) i wystawienie tego
jako wymiaru filtra/grupowania na najwyższym poziomie, zgodnie z regułą rozwiązywania z Q6 sesji.

**Zależy od — kilku decyzji, wszystkie dziś otwarte w `PRODUCT-VIEW-NOTES.md`:**
- *decyzja:* dokładny id/nazwa pola custom Jiry `Team` (wymaga realnego sprawdzenia w instancji Jiry
  organizacji, tego samego rodzaju wyszukiwania, jakie `sync-jira.js` już robi dla Sprint/Epic Link/
  Flagged przez dopasowanie `schema.custom`/nazwy pola — nie można zgadnąć, musi być potwierdzone wobec
  żywych metadanych Jiry, np. przez `GET /rest/api/3/field` jednorazowo, ręcznie, przed kodowaniem).
- *decyzja:* zmiana schematu `docs/jira-spaces.json` — dziś `boards` to `string[]`
  (`{ name, boards: ["Sparks"] }`, potwierdzone odczytem aktualnego pliku). Gap C wymaga, żeby każdy board
  niósł etykietę zespołu, np. `boards: [{ name: "Sparks", team: "Team Rocket" }]`. To zmiana łamiąca
  schemat istniejącego pliku konfiguracyjnego z realną treścią — wymaga akceptacji, nie tylko
  wywnioskowanego kształtu, a istniejąca obsługa dualnego kształtu (string albo obiekt) dla wpisu
  przestrzeni w `resolveSpacesConfig()` (patrz `scripts/sync-jira.js` ~linia 302–323) wymagałaby
  równoległej obsługi dualnego kształtu dla wpisów boardów (sam string „bez etykiety zespołu" vs. obiekt
  „ma etykietę"), żeby zachować kompatybilność wstecz z każdą przestrzenią wciąż używającą starej listy
  boardów jako plain string.
- *decyzja:* poziom (altitude) dashboardu — własne otwarte pytanie notatek: czy dashboard jest używany na
  poziomie ART/PM (filtr Team powinien być widocznym kontrolerem na najwyższym poziomie, widok PM = „All
  teams" z tagiem per wiersz) czy per-team/PO (zawężony do jednego zespołu jako głównego trybu)? To
  materialnie zmienia kształt UI (dropdown filtra vs. zasadniczo inny widok domyślny) i musi zostać
  odpowiedziane przed pracą nad UI, nie wywnioskowane z kodu.

**Zmiany, po podjęciu wszystkich trzech decyzji:**

*Backend (`scripts/sync-jira.js`):*
1. Odczytać pole custom `Team` (ten sam wzorzec wyszukiwania przez `schema.custom`, już używany dla
   Sprint/Epic Link — patrz jak `sprintFieldId`/`epicLinkFieldId`/`flaggedFieldId` są rozwiązywane raz na
   przebieg i przekazywane do `fetchAndMapIssuesForJql()`) i zmapować je na rekord każdego issue jako
   `team` (nullable).
2. **Nowa księgowość, wyraźnie wskazana w notatkach jako nieistniejąca dziś:** gdy issue jest wciągnięte
   przez JQL aktywnego sprintu boarda (`resolveCurrentPiForSpaces`/`buildCurrentPiJql`), zapisać, *który*
   board faktycznie je dopasował. Konkretnie: `fetchAndMapIssuesForJql` (lub jego wywołujący) musi
   przenieść board (a teraz, jego etykietę zespołu) do każdego zwracanego issue, prawdopodobnie przez
   zapytanie per board, zamiast scalania wszystkich boardów przestrzeni w jeden blob JQL przed etapem
   mapowania issue — realna zmiana kontroli przepływu w sposobie, w jaki `buildCurrentPiJql`/
   `runCurrentPiMode` grupuje boardy dziś, nie dopisek jednej linii.
3. Kolejność rozwiązywania zapisana na każdym issue: `team = pole Jiry Team || etykieta zespołu boarda ||
   null` (przypadek `null` renderowany po stronie klienta jako "Unassigned / To clarify", nie wypalony w
   zapisanych danych — zachowuje rozróżnienie surowego sygnału od zamierzonej etykiety, zgodnie z tym, jak
   `application` na komponentach już traktuje brakującą wartość jako „fallback", nie jako przechowywany
   string).
4. `writePiShards()` — bez zmian w regule zakresu, `team` to po prostu nowe pole jadące na istniejącym
   obiekcie issue.

*Frontend (`docs/app.js` / `docs/index.html`):*
5. Nowa kontrolka filtra, kształt zależny od decyzji o poziomie powyżej — najprawdopodobniej `<select>`
   obok globalnego selektora PI (jeśli poziom ART/PM) albo domyślne „mój zespół" (jeśli poziom
   per-team/PO), wypełniana z odrębnych wartości `team` obecnych w `state.jiraIssues` (ten sam wzorzec
   listy opcji wyprowadzanej per PI, co już `refreshProductViewFilterOptions()` robi dla Type/Priority).
6. Grupowanie: zdecydować, czy Team staje się *drugą* osią grupowania nad Epikiem (Team → Epik →
   issues), czy zostaje płaskim filtrem obok Type/Priority/Sprint, tylko z tagiem per wiersz. Notatki tego
   wyraźnie nie rozstrzygają — zgłosić jako decyzję projektową UI dla kogo podejmie tę fazę, uwarunkowaną
   decyzją o poziomie.

**Pliki dotknięte.** `scripts/sync-jira.js` (rozwiązywanie pola + śledzenie pochodzenia boarda — największa
pojedyncza zmiana kodu w całym tym planie), `docs/jira-spaces.json` (schemat), `docs/app.js`,
`docs/index.html`, `CLAUDE.md` (nowe pole w sekcji modelu domeny, notatka o zmianie schematu w sekcji
`jira-spaces.json`).

**Weryfikacja.**
- `sync-jira.js` też nie ma zestawu testów; zweryfikować jednorazowym przebiegiem na realnym (lub
  piaskownicowym) projekcie Jiry z wypełnionym `Team` na co najmniej jednym issue i pustym na drugim,
  sprawdzając ręcznie zapisany JSON shardu pod kątem oczekiwanej wartości `team` i zachowania fallback.
- Frontend: niezapisywany skrypt z fikstur dla nowej logiki filtra/grupowania; ręczny test w
  przeglądarce na ręcznie zmodyfikowanym shardzie z 2+ odrębnymi wartościami `team` plus jedną `null`.

**Flaga ryzyka.** Ta faza jest wystarczająco duża i wystarczająco zależna od faktów specyficznych dla
żywej Jiry (rzeczywisty id pola custom, ile boardów faktycznie w praktyce nie ma wartości `Team`), że
powinna być prawdopodobnie ponownie rozbita na mniejsze fazy po udzieleniu odpowiedzi na trzy decyzje
powyżej — ten plan szkicuje kształt, nie finalny podział zadań, celowo, bo zobowiązanie się do niego teraz
oznaczałoby zgadywanie poza tym, co jest faktycznie wiadome.

---

## Tabela podsumowująca

| Faza | Gap | Zablokowana decyzją? | Względny koszt | Nowa praca na skrypcie synchronizacji/schemacie? |
|---|---|---|---|---|
| 0 | — (przygotowanie) | Tak — próg i zakres Gap A | — | Nie |
| 1 | A | Rozstrzygnięte w Fazie 0 | Niski (wykorzystuje istniejące wzorce) | Nie |
| 2 | D | Nie | Niski | Nie |
| 3 | E | Nie | Niski | Nie |
| 4 | F | Tak — wybór języka | Bardzo niski | Nie |
| 5 | B | Tak — zastąpić vs. dodać opcję; zakres kafelków | Średni | Nie |
| 6 | C | Tak — id pola, kształt schematu, poziom | Wysoki | Tak — rozwiązywanie pola, śledzenie pochodzenia boarda, schemat `jira-spaces.json` |
