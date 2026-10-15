# Product view — notatki projektowe z sesji ideation (SAFe)

*English version: [PRODUCT-VIEW-NOTES.md](PRODUCT-VIEW-NOTES.md)*

> **Status: eksploracyjny, nic nie zdecydowane.** Ten dokument zestawia sesję ideation (sześć pytań, z
> asystentem AI grającym rolę konsultanta produktowego SAFe) z aktualnym stanem implementacji Product
> view, w formie analizy rozbieżności (gap analysis) i listy otwartych pytań. Z tego dokumentu nic nie
> zostało wdrożone. Każda sekcja jest kandydatem do przyszłej decyzji, nie samą decyzją — ten sam duch co
> `FEATURES.md`.

## Źródło

Rozmowa (2026-10-01) przechodząca przez: czego Product Owner/Product Manager pracujący w SAFe potrzebuje
na takim dashboardzie; jak zakresować czasowo widok Epik → work-item (bieżący PI/sprint vs. historia);
realną hierarchię Jiry w tej organizacji (`Epic → Portfolio Epic → Capability`); własność feature flagów
(na razie zostaje po stronie deweloperów); strukturę wielozespołową (wiele Agile Teams, zwykle jeden board
na zespół, z opcjonalnym polem `Team`, które nie zawsze jest wypełnione). Pełny zapis rozmowy jest
zachowany w historii konwersacji, z której powstał ten dokument; ten plik zawiera tylko wnioski istotne
dla projektu Product view, zmapowane na kod w jego aktualnym stanie.

## Aktualny stan Product view (punkt wyjścia, w momencie pisania)

Pełny szczegół w sekcjach „Jira issues” i „Frontend” w `CLAUDE.md` — tu tylko tyle, ile potrzeba do
zrozumienia analizy rozbieżności poniżej:

- Domyślnie pokazuje realny **bieżący PI** organizacji, utrzymywany **pełnym nadpisaniem** przy każdym
  przebiegu syncu (nie scalaniem) — issue, które wypada z PI, po prostu nie trafia do kolejnego fetchu, bez
  osobnej logiki czyszczącej. Każdy **inny** PI jest tylko zdjęciem stanu z momentu ręcznego przebiegu
  `BACKFILL_PIS`, nigdy automatycznie nieodświeżanym. To była świadoma decyzja, potwierdzona wcześniej w
  tej samej sesji roboczej: ShipScope pokazuje aktualny, realny stan — nie ma być narzędziem do
  przeglądania historii (to już robią Jira i GitHub).
- Kontrolka **zakresu Sprintu** (`#filterSprint`, dodana w tej samej sesji roboczej, *przed* tą sesją
  ideation) zawęża wczytany PI do jednego konkretnego sprintu, albo z powrotem do całego PI ("All
  sprints"). Domyślnie wybiera sprint aktywny *teraz* (wyliczany z realnych `startDate`/`endDate` każdego
  sprintu, zero dodatkowego zapytania do Jiry). To jest **prosty filtr dokładnego dopasowania** — "pokaż
  sprint X i nic więcej" — nie hybrydowa reguła, którą sesja ideation faktycznie rekomenduje (patrz Gap B
  poniżej).
- Issue grupują się po **Epiku** (`groupIssuesByEpic()`) — Story/Task/Bug pod rozwiązanym `epicKey`,
  wszystko inne do sekcji "Ungrouped" na końcu. Epik staje się czystym nagłówkiem sekcji z badge'em
  `epicRollup()` "N/M released to PROD" nad swoimi dzieci.
- Status per środowisko to enum 5 poziomów (`issueStatusForEnv()`): `none` / `deployed` (kod wdrożony,
  flaga wyłączona) / `deployed_code_only` (kod wdrożony, brak flagi do sprawdzenia) / `partial` /
  `released` (kod wdrożony **i** flaga włączona). To już **jest** model "4 koszyków" z sesji ideation
  (patrz "Już zgodne" poniżej) — tylko pod innymi nazwami.
- Feature flagi są w ShipScope **tylko do odczytu** i **nie** pochodzą z Jiry — `docs/data/flags-meta.json`/
  `flag-states.json` (bieżący snapshot) oraz `flag-state-history.json` (**append-only, realna historia,
  nigdy nieprzycinana** — w przeciwieństwie do danych Jiry per-PI) to osobny potok danych, łączony z
  issue tylko przez `flagsMeta[key].jiraKeys`. Flagami zarządzają deweloperzy; ShipScope nie ma UI do ich
  przełączania.
- Nie istnieje dziś żadne pojęcie **Team** w modelu danych. `docs/jira-spaces.json` ma per-space listę
  `boards` (używaną wyłącznie do wyznaczenia bieżącego PI z aktywnego sprintu tablicy — patrz `CLAUDE.md`),
  ale nie niesie tożsamości zespołu, i żadne pole Jiry nie jest odczytywane pod kątem przynależności do
  zespołu.
- Filtr Type (`#filterTypeGroup`) to **single-select** (All/Epic/Story/Task/Bug) — bliskie, ale nie to
  samo, co dedykowany przełącznik "ukryj Taski".
- Nic dziś nie mierzy ani nie alarmuje o tym, "jak długo to już jest wdrożone z wyłączoną flagą".

## Już zgodne — nie jest to gap, warto tylko to jasno nazwać

- **Domyślnie bieżący PI + bieżący sprint.** Dokładnie to, co sesja rekomenduje jako priorytet numer jeden
  (wnioski z Q1/Q5). Już zaimplementowane, niezależnie od tej sesji.
- **Historia jako wtórna, nie domyślna.** Własna hierarchia sesji ("historia jest potrzebna, ale nie jako
  główny widok") dokładnie odpowiada projektowi ręcznego backfillu — do przeszłego PI/sprintu da się
  dotrzeć, ale nigdy nie jest to punkt startowy i nigdy nie jest cicho odświeżane.
- **Flagi zostają po stronie deweloperów, tylko do odczytu, na razie.** Jawnie potwierdzone przez
  użytkownika w trakcie sesji ("na razie nie dotykajmy tego tematu, to jest na później") — odpowiada
  dzisiejszemu projektowi ShipScope; nic do zrobienia, dopóki to się nie zmieni.
- **Flagi pochodzą spoza Jiry.** Również jawnie potwierdzone przez użytkownika — odpowiada istniejącemu
  potokowi `flags-meta.json`/`flag-states.json`; to nie jest gap.
- **"Epic" już JEST poziomem Feature w SAFe, w tej organizacji.** Wniosek z Q3 sesji — hierarchia Jiry w
  tej organizacji to `Epic → Portfolio Epic → Capability`, co znaczy, że typ issue "Epic" jest, w
  terminologii SAFe, faktycznie *Feature'em*. Istniejące grupowanie na poziomie Epika w Product view jest
  więc już na właściwej wysokości dla dashboardu PM/PO — **nie ma brakującej "warstwy Feature"** do
  dodania, jest to tylko kwestia nazewnictwa/modelu mentalnego, warta zapamiętania, żeby przyszły czytelnik
  nie pomylił tego z gapem.
- **Istniejący model 4 stanów już istnieje.** Poziomy `none`/`deployed`/`deployed_code_only`/`partial`/
  `released` z `issueStatusForEnv()` to dokładnie te same rozróżnienia co ramowanie sesji "W locie (Test) /
  Do akceptacji (QA) / Wdrożone technicznie (Prod, flaga OFF) / Wydane (Released)" — patrz Gap F po kwestię
  (czysto kosmetyczną) przemianowania, która wciąż zostaje otwarta.

## Zdecydowane i zaimplementowane

- **Jak wiele PI wstecz Product View powinien trzymać dane?** Pytanie podniesione i odpowiedziane
  dwukrotnie: najpierw przez reorientację "bieżący stan, nie archiwum historii" wcześniej w tym projekcie
  (patrz sekcja modelu domeny "Jira issues" w `CLAUDE.md`) — liczba shardów PI na dysku **nie** jest
  automatycznie ograniczana; rośnie o jeden przy każdym nowym bieżącym PI, w tym samym duchu co
  "wystarczająco tanie, żeby po prostu wszystko trzymać" przy `flag-state-history.json`. Usunięcie starego
  PI jest świadomą, jednorazową, ręcznie wywoływaną akcją (`scripts/prune-jira-pis.js`), nie czymś, co
  robi zwykły sync. Późniejszy przegląd produktowy `claude --agent maja` konkretnej propozycji "cap do 3
  PI (bieżący + 2 poprzednie)?" doszedł do tego samego wniosku niezależnie: nie ograniczaj danych — Release
  Notes i alert "ghost flag" z Gapu A z natury muszą sięgać dalej niż 3 PI, więc twardy cap na poziomie
  plików/syncu złamałby te dwie funkcje, nie tylko sam Product View. Jeśli coś powinno być ograniczone, to
  **domyślny widok** (który PI otwiera globalny select), nie to, co jest trzymane na dysku — a to już jest
  domyślnie bieżący PI. "3" w jakiejkolwiek takiej propozycji jest dobre tylko tak, jak dobrze odpowiada
  temu, ile PI faktycznie obejmuje rozsądne okno patrzenia wstecz (np. "ostatnie 6 miesięcy") w realnym
  rytmie PI tej organizacji — warto to sprawdzić względem realnych dat sprintów w
  `docs/data/jira-issues/index.json`, zanim wybierze się liczbę, jeśli domyślna wartość **na poziomie
  widoku** będzie kiedyś potrzebna.
- **Rodzic jest "w pełni released" dopiero, gdy wszystkie jego dzieci są released.** Pytanie, które padło
  jako follow-up: czy Epic (i, tą samą logiką, Story z sub-taskami) powinien liczyć się jako "Released"
  tylko wtedy, gdy *wszystkie* jego dzieci są released? Dla poziomu **Epika** — tak:
  `renderEpicHeader()` pokazuje teraz jawny, binarny badge "Fully released" (zielony, ikonka checkmarka)
  przy statusie Epika, zawsze gdy `epicRollup()`'s `released === total` — obok już istniejącego progress
  bara N/M (który już pokazywał to wizualnie przy 100% wypełnienia, tylko bez jawnej etykiety).

  Dla **sub-tasków Story** świadomie **nie** rozciągnęliśmy tej samej logiki. Status `released` Story
  (`issueStatusForEnv()`) jest sygnałem flagi/deploymentu — "czy ta funkcja jest teraz naprawdę
  dostępna dla użytkowników" — liczonym wyłącznie z flagi (flag) podlinkowanej do samego Story.
  Kompletność sub-tasków w Jirze to inny sygnał — "czy papierkowa robota wokół tego jest zrobiona". Te
  dwa mogą się słusznie rozjeżdżać: flaga może być poprawnie włączona dla użytkowników, podczas gdy
  jakiś końcowy sub-task (dokumentacja, follow-up QA) wciąż wisi otwarty w Jirze — i to nie jest błąd.
  Zablokowanie statusu `released` Story na kompletności jego sub-tasków sprawiłoby, że funkcja, która
  faktycznie już jest live, czytałaby się jako "nie released" z powodu czegoś, co nie ma żadnego związku
  z tym, czy użytkownicy to widzą — co idzie prosto wbrew całemu celowi tego dashboardu (pokazywać
  realny, bieżący stan produkcji, nie status porządków w Jirze). Istniejący, osobny badge
  "{done}/{total} sub-tasks" już wyłapuje przypadek "zdeployowane, ale nie zrobione" bez psucia samego
  sygnału release — zostaje bez zmian.

## Gapy — kandydaci na funkcje do zrobienia później

### A. Alarm starzenia "ghost flag" — wdrożone na prod, flaga wciąż OFF, za długo

**Motywacja.** Potwierdzony w sesji jako realny, powtarzający się problem ("tak, zdarza się że nie jest to
odkrywane od razu") i wielokrotnie nazwany (Q2, Q4, Q5) jako jedyny, najistotniejszy dla PM sygnał, którego
nie ma w prostym widoku statusów — SAFe nazywa to "kumulowaniem nieskonsumowanej wartości" jako ryzyko
(koszt utrzymania, ryzyko regresji) bez żadnej korzyści dla użytkowników.

**Kluczowy wgląd umożliwiający realizację.** To **nie** wymaga sięgania do starych, już nieodświeżanych
shardów PI (które ShipScope świadomie przestaje utrzymywać na bieżąco, gdy dany PI przestaje być
"bieżącym" — patrz "Aktualny stan" wyżej). Sygnał starzenia jest w pełni wyliczalny z danych, które **są**
utrzymywane jako realna, ciągła historia niezależnie od tego, który PI jest wczytany:
`flag-state-history.json` (append-only, nigdy nieprzycinany) zapisuje dokładnie, kiedy stan prod danej
flagi ostatnio się zmienił, a zachowane okno `deployments.json` (patrz sekcja "Deployments" w `CLAUDE.md`)
zapisuje, kiedy kod faktycznie został wdrożony. "Jak długo to jest skryte" to `now - max(ostatnia zmiana
flagi na prod na OFF, deployedAt deploymentu)` — wyliczalne bez nowego skryptu syncu czy wywołania do Jiry,
czysto z potoków, które ShipScope już uruchamia.

**Pożądana semantyka.** Widoczny alert (np. "Wdrożone na prod 3 sprinty temu · flaga wciąż OFF") na
każdym work itemie, którego bieżący status prod to `deployed`/`deployed_code_only`, po przekroczeniu progu.

**Otwarte pytania.**
- Próg w dniach czy w sprintach? Długość sprintu nie jest gwarantowana jednolita między tablicami/zespołami,
  więc próg dniowy jest pewnie bardziej odporny, ale sprintowy lepiej odpowiada językowi samej sesji ("od 3
  sprintów").
- Czy to ma się pojawiać jako lista obejmująca cały dashboard, niezależna od tego, który PI jest aktualnie
  wczytany (wymagałoby skanu po wszystkich PI — w prostej sprzeczności z zasadami kosztu/poprawności, które
  ta sama sesja robocza już ustaliła co do *nie* skanowania automatycznie każdego PI), czy tylko jako
  anotacja na wierszach już widocznych przy przeglądaniu akurat wczytanego PI (tanie, zgodne z dzisiejszą
  architekturą, ale widoczne tylko jeśli ktoś akurat wczyta ten PI)?
- Dokładna forma wizualna i treść komunikatu.

**Status.** Niezaimplementowane.

### B. Hybrydowy zakres czasowy w ramach Epika — bieżący sprint (wszystko) + wcześniejsze sprinty (tylko nierozstrzygnięte)

**Motywacja.** Własna rekomendacja domyślnego zachowania z sesji (Q2, Q4) jest bardziej subtelna niż płaski
filtr jednego sprintu: pokazuj elementy aktywnego sprintu niezależnie od statusu, **plus** elementy ze
starszych sprintów tego samego PI, które *jeszcze nie* są released, chowając starsze elementy, które już
dotarły do Released — "to pokazuje osobie produktowej stopień ukończenia całego Epika" bez zasypywania
widoku w pełni skończoną historią.

**Aktualny stan.** Kontrolka `#filterSprint`, dodana wcześniej w tej samej sesji roboczej (przed tą sesją
ideation), to prosty filtr dokładnego dopasowania — "All sprints" albo dokładnie jeden nazwany sprint — nie
ta hybrydowa reguła.

**Pożądana semantyka.** Domyślny zakres ≈ `issue.sprint === bieżącySprint OR (issue.pi === wybranyPi &&
prodStatusBucket(issue) !== 'released')`.

**Otwarte pytania.**
- Czy to ma *zastąpić* "bieżący sprint" jako domyślny, czy stać się trzecią, jawną opcją (np. "Bieżący
  sprint + nierozstrzygnięte") obok dzisiejszego "All sprints" / jednego konkretnego sprintu?
- Czy to zmienia też kafle podsumowania/`piWorkItemCounts()`, czy tylko listę issue pod nimi?

**Status.** Niezaimplementowane — prostszy, jednosprintowy selektor wyszedł jako v1 pierwszy.

### C. Grupowanie i filtrowanie po zespole / tablicy

**Motywacja.** Organizacja ma wiele Agile Teams, zwykle jeden board na zespół, śledzonych przez listę
`boards` per-space w `docs/jira-spaces.json` — ale praca/Epiki mogą obejmować więcej niż jeden zespół, a
pole `Team` "nie zawsze" jest wypełnione (Q5/Q6 sesji).

**Aktualny stan.** W modelu danych ShipScope nie istnieje jeszcze pojęcie zespołu jako takie (grupowanie,
filtrowanie, pole `team` na obiekcie issue). Istnieje już jednak węższe, wyłącznie-wykluczające
wykorzystanie pola `Team` w `sync-jira.js` (rozwiązywane po nazwie pola przez `findSpecialFieldIds()`,
odczytywane przez `extractTeamName()`) — powstało konkretnie dlatego, że na dashboardzie pojawił się epik
innego zespołu ("Unified reimbursement front-end application"): jego PI wyliczone z etykiety (`PI-27.3`)
było poprawne, bo cały ART dzieli jedną numerację PI, ale sam epik nie był pracą tej tablicy. Kiedy pole
`Team` issue jest wypełnione i nie zgadza się z nazwą boarda/zespołu skonfigurowaną dla przestrzeni tego
issue, jest ono całkowicie usuwane z synchronizacji. To odpowiada na wąskie pytanie "nie wpuszczaj issue
z innego zespołu" powyżej, ale **nie jest** tą samą funkcją "Team jako filtrowalny wymiar", o którą
chodzi w tym gapie — żadna wartość `team` nie jest zapisywana na issue, nie ma filtra UI, a krok fallbacku
do boarda, gdy Team jest puste (punkt 2 poniżej), wciąż nie istnieje. Reszta tego gapu, w pierwotnym
zakresie, zostaje.

**Pożądana reguła rozwiązywania (z sesji, Q6).**
1. Pole niestandardowe Jiry `Team`, kiedy jest wypełnione.
2. Fallback: tablica (z istniejącej konfiguracji `boards`), z której faktycznie pochodzi sprint tego issue.
3. Fallback: jawny koszyk `Unassigned / Do wyjaśnienia` — w ramowaniu sesji, sam w sobie sygnał o zdrowiu
   backlogu ("coś wisi w próżni"), nie tylko przypadek null do schowania.

**Uwaga kosztowo-architektoniczna.** Krok 2 wymaga, żeby `sync-jira.js` zapisywał, per issue, *która
skonfigurowana tablica* faktycznie je złapała — czego dziś nie robi (JQL wyprowadzony z tablicy po prostu
zwraca issue per space; nic na obiekcie issue nie mówi, z aktywnego sprintu której tablicy pochodzi). To
jest realny, nowy element księgowości do zaprojektowania, nie tylko filtr po stronie klienta — do tego
wpisy `boards` w `docs/jira-spaces.json` potrzebowałyby jawnej etykiety zespołu (dziś to tylko lista nazw
tablic bez przypisanej tożsamości zespołu).

**Otwarte pytania.**
- ~~Dokładny id/nazwa pola niestandardowego Jiry `Team`.~~ Rozwiązane inaczej, niż oczekiwano: zamiast
  wpisywać na stałe ID (czego faktycznie nie dało się zgadnąć z góry, potwierdzone przy budowaniu
  mechanizmu wykluczającego powyżej), `findSpecialFieldIds()` rozwiązuje je po nazwie wyświetlanej pola
  ("Team", bez rozróżniania wielkości liter) w czasie działania — ta sama technika już użyta dla
  `Flagged`, bo żadne z tych dwóch pól nie ma stabilnego typu `schema.custom`, po którym dałoby się
  dopasować inaczej.
- Czy schemat `docs/jira-spaces.json` musi się zmienić (`boards: [{ name, team }]` zamiast płaskiej listy
  stringów) i co to znaczy dla istniejącej logiki rozwiązywania tablic w `resolveCurrentPiForSpaces()`.
- UI: globalny filtr "Team" (widok PM = wszystkie zespoły z tagiem zespołu per wiersz; widok PO =
  przefiltrowany do jednego zespołu) — ten sam kształt co istniejące kontrolki PI/Sprint, czy coś innego?

**Status.** Niezaimplementowane — największy, zupełnie nowy element modelu danych na tej liście.

### D. Sygnał wizualny "bug blokuje epika"

**Motywacja.** Bug wisiący na Test/QA pod Epikiem sygnalizuje, że Epik nie jest gotowy do biznesowego
sign-offu, nawet jeśli jego Story wyglądają dobrze — sesja (Q2, Q3) chce bugów widocznych wizualnie, "na
samej górze" po rozwinięciu Epika.

**Aktualny stan.** `jiraStatusTagHtml()` już koloruje na czerwono surowy status Jiry `Blocked`, a
`dependencyBlocked`/`dependencyNote` już ujawniają własne linki Jiry "is blocked by" — ale nic dziś nie
flaguje specyficznie "ten Epik ma otwartego Buga wśród swoich dzieci w zakresie".

**Pożądana semantyka.** Drugi, dodatkowy wskaźnik w nagłówku Epika (obok istniejącego badge'a
`epicRollup()`), kiedy jakiekolwiek dziecko w zakresie ma `type: 'Bug'` i nie ma jeszcze
`statusCategory: 'done'`.

**Status.** Niezaimplementowane — mała, dodatkowa zmiana w `renderEpicHeader()`/`epicRollup()`, gdy zostanie
rozpisana.

### E. Szybki przełącznik "ukryj Taski"

**Motywacja.** Taski są najmniej interesującym typem dla PM/PO (Q2 sesji); dedykowane, jednoklikowe
schowanie jest bardziej bezpośrednie niż przebieranie się przez single-select filtra Type.

**Aktualny stan.** `#filterTypeGroup` już pozwala wybrać dokładnie jeden typ naraz — funkcjonalnie bliskie,
ale nie to samo, co przełącznik "schowaj tylko Taski, zostaw resztę".

**Otwarte pytanie.** Czy istniejący single-select wystarczy, czy to potrzebuje prawdziwej kontrolki
multi-exclude?

**Status.** Niezaimplementowane — najniższy koszt na tej liście, jeśli zostanie podjęty.

### F. Przemianowanie wizualne na język "4 koszyków" z sesji

**Motywacja.** Własne, rekomendowane ramowanie sesji — "W locie (Test)" / "Do akceptacji (QA)" / "Wdrożone
technicznie (Prod, flaga OFF)" / "Wydane (Released)" — mapuje się bezpośrednio na istniejące poziomy
`issueStatusForEnv()` (patrz "Już zgodne" wyżej). To decyzja prezentacyjna, nie nowa funkcjonalność.

**Otwarte pytanie.** Przyjąć ten dosłowny język (i w jakim języku — sesja była po polsku, ale tekst UI
`docs/app.js` jest dziś po angielsku jako pierwszy), czy zostać przy dzisiejszym, bardziej ogólnym
nazewnictwie pill'i ("Code deployed", "Released", itd.)?

**Status.** Kosmetyczne, niezaimplementowane, najniższy priorytet z tej listy.

## Otwarte pytania przeniesione z sesji, wciąż bez odpowiedzi

- Na jakim poziomie hierarchii SAFe ten dashboard jest głównie używany — na poziomie ART/PM, czy
  per-zespół/PO? Wpływa na to, czy filtr Team z Gapu C staje się kontrolką najwyższego poziomu, czy tylko
  metadaną na poziomie wiersza.
- Potwierdzone: Epic = poziom Feature tutaj. Czy jest kiedykolwiek potrzeba pokazania Portfolio
  Epic/Capability *nad* nim, czy Epic jest trwałym sufitem dla tego dashboardu?
- Dokładna reguła rozwiązywania i źródło danych dla `Team`, gdy pole niestandardowe jest puste (Gap C).
- Próg dla alarmu "ghost flag" (Gap A) — dni czy sprinty, i jaka liczba.
- Czy Gap B (hybrydowy zakres czasowy) ma zastąpić, czy stanąć obok dzisiejszego, prostego selektora
  sprintu.

## Wprost poza zakresem tutaj (odłożone przez użytkownika w trakcie sesji)

- Umożliwienie PM/PO przełączania feature flagów prosto z ShipScope — na razie zostaje po stronie
  deweloperów.
- Wciąganie stanu flag do samej Jiry, albo odwrotnie — oba potoki zostają rozłączne, połączone tylko przez
  `jiraKeys`, z zamierzenia.
