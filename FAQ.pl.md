# ShipScope FAQ — jak to jest liczone?

*English version: [FAQ.md](FAQ.md)*

Ten dokument jest przystępnym uzupełnieniem do `README.md`, który opisuje, czym jest ShipScope, oraz
`CLAUDE.md`, który stanowi pełne techniczne odniesienie. Jego celem jest odpowiedź na powtarzającą się
kategorię pytań: dla danej liczby albo badge'a pokazywanego na dashboardzie, skąd faktycznie pochodzi ta
wartość. Każda odpowiedź wskazuje odpowiedzialny za to skrypt lub funkcję, dzięki czemu logikę można
zweryfikować bezpośrednio. Nie zakłada się żadnej wcześniejszej znajomości kodu.

## Deploymenty (Technical view → timeline)

### Jak wyliczany jest „rollback”?

Przy każdej synchronizacji nowego deploymentu ShipScope porównuje właśnie zdeployowany commit względem tego,
co wcześniej było live na tym samym środowisku. To porównanie i tak jest wykonywane z innych powodów: służy
do ustalenia powiązanych ticketów z Jiry i do zbudowania linku do zakresu commitów. Odpowiedź GitHuba na
zapytanie o porównanie zawiera pole `status`, które może przyjąć wartość `ahead`, `behind`, `diverged` albo
`identical`.

Status **`behind`** oznacza, że nowo zdeployowany commit jest przodkiem commita, który był już uruchomiony —
czyli deployment przesunął środowisko w historii do tyłu, nie do przodu. To właśnie oznacza tutaj „rollback”:
nie że ktoś kliknął przycisk cofania, ale że kod aktualnie live jest starszy niż kod live chwilę wcześniej na
tym samym środowisku, niezależnie od tego, czy był to świadomy revert, czy błąd.

Ponieważ wykorzystuje to porównanie, które i tak jest wykonywane, wykrycie rollbacku nie wymaga żadnego
dodatkowego zapytania do GitHuba. (Skrypt: `sync-github-deployments.js`, funkcja `issuesInRange`, która
zwraca `status` porównania; `main()` zamienia `status === 'behind'` na `rollback: { toRef: <poprzedni commit> }`.)

Dla deploymentów zapisanych przed wprowadzeniem tego sprawdzenia, jednorazowy skrypt
`backfill-deployment-metadata.js` wykonuje to samo porównanie retroaktywnie, jedno zapytanie do GitHub API na
każdy jeszcze niesprawdzony deployment.

### Jak określane jest, czy deployment był „manual” czy „automatic”?

Każdy deployment na GitHubie ma historię statusów deploymentu, a jeden z nich zwykle zawiera `log_url`
wskazujący na konkretny przebieg GitHub Actions, który go wykonał. ShipScope wyciąga z tego adresu numeryczny
identyfikator przebiegu, odpytuje GitHuba o to, co wywołało dany przebieg, i sprawdza, czy odpowiedzią jest
`workflow_dispatch` — oznaczenie GitHuba dla przebiegu uruchomionego ręcznie przyciskiem „Run workflow”, w
odróżnieniu od przebiegu uruchomionego automatycznie przez push, harmonogram albo podobne zdarzenie.

Jeśli `log_url` nie istnieje, typu triggera nie da się ustalić, i deployment jest domyślnie traktowany jako
niemanualny.

Aby ograniczyć koszt w sytuacji, gdy synchronizacja musi jednorazowo przetworzyć duży zaległy backlog,
na przykład po przerwie, ShipScope ogranicza się do 30 takich sprawdzeń typu triggera na jedno uruchomienie
synchronizacji. Każdy deployment powyżej tego limitu w tym samym uruchomieniu zostaje nierozwiązany, aby
uruchomienie nie stało się kosztowne bez ograniczeń. (Skrypt: `sync-github-deployments.js`, funkcja
`resolveManualFlag`, konstanta `MAX_MANUAL_LOOKUPS_PER_RUN`.)

### Jak liczony jest czas trwania deploymentu (duration)?

GitHub zapisuje ostemplowany czasem status przy każdej zmianie stanu deploymentu — queued, in progress,
succeeded, failed i tak dalej. ShipScope bierze najwcześniejszy i najpóźniejszy z tych znaczników czasu dla
danego deploymentu i odejmuje jeden od drugiego. Jeśli GitHub zaraportował tylko jeden status dla danego
deploymentu, nie ma czego odejmować, i duration nie jest wtedy pokazywany. Nie oznacza to, że deployment był
natychmiastowy — oznacza to, że nie ma wystarczających danych, aby go zmierzyć.

(Skrypt: `sync-github-deployments.js`, funkcja `computeDeployDurationMs`.)

### Skąd bierze się wersja pokazywana przy deploymencie? Release, tag, czy coś innego? Czy różni się per środowisko?

Mechanizm rozwiązywania wersji jest identyczny dla każdego środowiska (test, qa, prod) — nie istnieje żadna
logika swoista dla konkretnego środowiska. To, co faktycznie się różni per środowisko, to po prostu który
commit akurat tam trafił i czy ten konkretny commit ma jakikolwiek Release, tag albo wersję w treści
komunikatu.

Dla danego zdeployowanego commita ShipScope sprawdza po kolei następujące źródła i zatrzymuje się na
pierwszym, które daje wynik:

1. **GitHub Release wskazujący na dokładnie ten commit.** Release'y na GitHubie są budowane na tagach, więc
   ShipScope zestawia nazwę tagu każdego Release'a z listą tagów repozytorium, aby znaleźć dokładny commit,
   na który wskazuje.
2. **Zwykły git tag na tym dokładnie commicie**, bez wymogu istnienia powiązanego Release'a.
3. **Ciąg wyglądający jak wersja w treści komunikatu samego commita** — dopasowanie wzorca w stylu `v1.2.3`
   albo `1.2.3` gdziekolwiek w tekście.
4. **Surowe SHA commita**, skrócone — używane tylko wtedy, gdy żadne z powyższych nie dało wyniku.

Release i tag są sprawdzane przed treścią komunikatu celowo: wolny tekst w komunikacie commita może
przypadkowo zawierać coś, co przypomina wersję, bez jej faktycznego oznaczania — na przykład commit
stwierdzający, że naprawia błąd wprowadzony w poprzedniej wersji — podczas gdy realny Release albo tag jest
celowym, jednoznacznym sygnałem. Z tego powodu środowisko deployowane bezpośrednio z commita na feature
branchu, bez tagu i bez komunikatu godnego release'u, często kończy się na surowym SHA — na takim commicie
faktycznie nie ma żadnego sygnału wersji, który ShipScope mógłby znaleźć.

Sprawdzenie Release'ów i tagów kosztuje dwa zapytania listy do GitHuba na cały przebieg synchronizacji, nie
na każdy deployment, więc koszt nie rośnie z liczbą przetwarzanych deploymentów. (Skrypt:
`sync-github-deployments.js`; zobacz `shaToRelease`, `shaToTag` i `extractPromotedVersion`.)

Deploymenty zapisane przed wprowadzeniem tej kolejności priorytetów można doresolvować retroaktywnie
jednorazowym skryptem `backfill-deployment-metadata.js`. Przetwarza on tylko rekordy, których wersja wciąż
przypomina surowe SHA, i próbuje bezkosztowych sprawdzeń Release/tag, zanim wykona zapytanie API odczytujące
treść commita.

## Feature flagi

### Jak liczona jest notka „flaga jest nieaktywna zbyt długo” (🧹 stale flag)?

To sprawdzenie bierze pod uwagę flagę tylko wtedy, gdy ma przynajmniej jeden powiązany ticket z Jiry i każdy
powiązany ticket jest już oznaczony jako Done w Jirze. Gdy ten warunek jest spełniony, ShipScope sprawdza
każde środowisko, w którym flaga jest aktualnie włączona, liczy, ile dni temu została na tę wartość
przełączona, i pokazuje notkę o czyszczeniu, jeśli najdłuższy z tych okresów wynosi 60 dni lub więcej. Jeśli
choć jeden powiązany ticket nie jest jeszcze Done, albo flaga nie jest włączona nigdzie, nic się nie pokazuje
— logika jest celowo konserwatywna, a nie spekulatywna.

Jest to liczone w przeglądarce na podstawie danych już wczytanych, bez dodatkowego kroku i bez dodatkowego
zapytania do API. (Plik: `docs/app.js`, funkcja `flagStaleWarning`, konstanta `STALE_FLAG_DAYS`.)

### Skąd aktualnie pochodzą flagi i jak ShipScope ustala ich stan włączenia?

Flagi pochodzą z dwóch niezależnych źródeł, śledzonych osobno, niescalanych w jedno:

- **Flagi `build`** żyją w kodzie samej aplikacji, zaszyte na etapie budowania. ShipScope odkrywa je,
  skanując każde repozytorium aplikacji pod kątem dwóch typów plików:
  - plików `*.generated.ts`, używanych tylko do stwierdzenia, że dana flaga w ogóle istnieje, w celu
    stworzenia wpisu-stub w metadanych.
  - katalogów `flag-parts/`, każdy zawierający `default.ts` plus opcjonalne nadpisania
    `test.ts`/`qa.ts`/`prod.ts`, używanych do ustalenia faktycznej wartości flagi per środowisko (nadpisanie
    dla danego środowiska ma pierwszeństwo przed tym, co mówi `default.ts`, jeśli istnieje).
  Obie te operacje opierają się na dopasowaniu wzorca regex do kodu TypeScript, nie na realnym parserze TS —
  jeśli repozytorium wywołujące zmieni strukturę generowania tych plików, jest to pierwsze miejsce do
  sprawdzenia.
- **Flagi `runtime-be`** są przełączane na żywo przez backend, bez żadnej zmiany kodu czy deploymentu.
  ShipScope po prostu odpytuje endpoint HTTP tego serwisu dla każdego środowiska, na harmonogramie, i
  zapisuje odpowiedź.

Gdy flaga ma zarówno domyślną wartość build-time, jak i żywe nadpisanie z backendu, nadpisanie z backendu ma
pierwszeństwo do wyświetlenia. ShipScope oflagowuje też przypadki, gdy te dwa źródła aktualnie się nie
zgadzają — patrz „rozjazd build vs. runtime-be” — ponieważ ukryta wartość domyślna build-time wypłynęłaby,
gdyby nadpisanie zostało kiedykolwiek usunięte.

Każda flaga wymaga też ręcznie wypełnionego wpisu w `flags-meta.json` (opis, klucze Jiry, komponenty
właścicielskie), zanim zostanie uznana za w pełni zdokumentowaną. Nowe flagi są automatycznie tworzone jako
niekompletne stuby, a sprawdzenie w PR (`check-flags-metadata.js`) blokuje proces integracji ciągłej, dopóki
wpis nie zostanie wypełniony.

(Skrypty: `resolve-all-flag-states.js` dla flag build, `sync-runtime-be-flags.js` dla flag runtime-be;
`docs/app.js`, funkcja `effectiveFlagState`, decyduje, które źródło ma pierwszeństwo, gdy istnieją oba.)

### Jak liczone jest ostrzeżenie „blast radius”?

Sprawdzane tylko dla flag powiązanych z więcej niż jednym ticketem z Jiry. ShipScope sprawdza kategorię
statusu każdego powiązanego ticketu; jeśli przynajmniej jeden jest Done, a przynajmniej jeden nie jest (wciąż
`new` albo `indeterminate`), ostrzega, że włączenie flagi wydałoby również niedokończony ticket razem z
gotowym. Jeśli każdy powiązany ticket jest Done, albo żaden z nich nie jest, nic się nie pokazuje, ponieważ
nie występuje mieszana gotowość do oflagowania.

(Plik: `docs/app.js`, funkcja `flagBlastRadius`.)

### Jak liczony jest „rozjazd build vs. runtime-be”?

Dotyczy tylko kombinacji flagi/środowiska, w której istnieją zarówno domyślna wartość build-time, jak i żywe
nadpisanie runtime-be. ShipScope po prostu porównuje ich wartości `enabled`. Jeśli się różnią, badge tego
środowiska na liście flag dostaje przerywaną obwódkę, a jego tooltip pokazuje aktualną, ukrytą domyślną
wartość build-time, ponieważ to jest wartość, która wypłynęłaby, gdyby żywe nadpisanie zostało kiedyś
usunięte albo wygasło.

(Plik: `docs/app.js`, wewnątrz `renderFlags`; zobacz `envEntry.build` i `envEntry['runtime-be']`.)

### Skąd ShipScope wie, kiedy flaga pierwszy raz się pojawiła?

Metadane każdej flagi (`flags-meta.json`) zawierają wartość `createdAt`, ostemplowaną jednorazowo, w
momencie, gdy flaga jest pierwszy raz scaffoldowana — odkryta z plików `*.generated.ts`/`flag-parts/` albo z
odpytania `runtime-be` — albo ręcznie wypełniona i pozostawianą bez zmian przy każdej późniejszej edycji. Ta
wartość zasila wpis „nowa flaga” na połączonej osi czasu. Flagi, które istniały już przed dodaniem tego pola,
po prostu go nie mają, i nie da się tego odtworzyć retroaktywnie bez przekopania historii Gita dla starszych
wersji `flags-meta.json`, co obecnie nie jest robione.

(Skrypty: `scaffold-flags-meta.js`, `sync-runtime-be-flags.js`, `fill-flag-metadata.js`.)

### Czy da się odzyskać historię flag z okresu przed powstaniem audit logu?

Częściowo. Każda zmiana kiedykolwiek zrobiona w `flag-states.json` była już odrębnym commitem gita na
branchu `live`, więc `scripts/backfill-flag-state-history.js` (workflow `backfill-flag-state-history.yml`,
wywoływany ręcznie) przechodzi po tej historii commitów, porównuje każdą wersję z poprzedzającą, i zasila
`flag-state-history.json` tym, co się zmieniło i kiedy. Czego nie da się odzyskać, to kto zrobił daną zmianę
— commity do tego pliku są zawsze autorstwa procesu automatycznego, nigdy osoby, która faktycznie ją
wywołała. Doresolvowane wpisy są więc jawnie oznaczone jako `changedBy: "unknown (backfilled from git
history)"`, zamiast przypisywać autora, którego nie da się zweryfikować.

## Jira

### Skąd biorą się numery Epików/Story/Tasków?

Pośrednio, z komunikatów commitów. Łańcuch działa następująco:

1. Kiedy synchronizowany jest deployment, ShipScope skanuje komunikaty commitów w zakresie tego deploymentu
   pod kątem czegokolwiek przypominającego klucz Jiry, na przykład `EBO-1234`, i zapisuje takie klucze przy
   deploymencie jako `relatedIssues`.
2. Osobno, ShipScope wyszukuje w Jirze dokładnie te klucze (`key in (EBO-1234, ...)`), nie całe projekty,
   do których należą — jeden ticket wspomniany raz w komunikacie commita nie powinien wciągać każdego
   innego, niezwiązanego ticketu, który akurat współdzieli z nim projekt. (Ustawienie `JIRA_PROJECT_KEY`
   włącza starsze, szersze zachowanie — przeszukanie całego projektu od początku do końca — dla projektu,
   który powinien być śledzony w całości, a nie tylko tam, gdzie commity akurat go referencjonują.)

Same klucze Jiry pochodzą więc ostatecznie od deweloperów wpisujących je w komunikaty commitów. ShipScope nie
wymyśla ani nie zgaduje klucza Jiry samodzielnie.

Ponieważ krok 1 traktuje **każdy** ciąg w kształcie `XXX-123` w komunikacie commita jako potencjalny klucz
Jiry, może przypadkowo złapać coś, co w tej instancji Jiry wcale nie jest issue — identyfikator z innego
systemu ticketowego albo literówkę. Przed wykonaniem zapytania ShipScope sprawdza prefiks projektu każdego
kandydata względem realnej, widocznej listy projektów w Jirze i odrzuca to, co się nie rozwiązuje, bo jeden
nieprawidłowy projekt wewnątrz zapytania inaczej wywaliłby całe zapytanie i po cichu zerowałby wyniki dla
wszystkich innych projektów, nie tylko tego złego. (Funkcja: `filterExistingProjectKeys`.)

Jeśli Jira jest całkowicie nieosiągalna, na przykład z powodu awarii albo problemu z uprawnieniami, ShipScope
przełącza się na budowanie lekkich zastępczych rekordów issue bezpośrednio z tych samych kluczy wyciągniętych
z commitów, wywodząc przybliżony typ (`feat`/`fix`/`chore`) z prefiksu samego komunikatu commita. Jest to
celowo uproszczony zamiennik realnych danych z Jiry, bez tytułu i bez realnego statusu, wystarczający jedynie
do tego, aby dashboard pokazywał coś, a nie nic.

(Skrypty: `sync-github-deployments.js` wyciąga klucze z komunikatów commitów; `sync-jira.js` wykonuje
faktyczny fetch z Jiry oraz fallback na wypadek jej braku.)

## Zakładka Release Notes (podgląd)

### Jak w ogóle zobaczyć tę zakładkę?

Trzeba wczytać stronę z `?releaseNotes=1` dodanym do URL. Nie istnieje żaden inny przełącznik — żadne
ustawienie, żaden cookie, nic nie jest zapamiętywane między wizytami. To celowe, miękkie wdrożenie funkcji na
czas jej weryfikacji na realnych danych, nie środek kontroli dostępu: leżące pod spodem dane JSON są równie
publiczne z parametrem, jak i bez niego.

(Plik: `docs/app.js`, konstanta `RELEASE_NOTES_ENABLED`.)

### Jak issue jest przypisywany do „aplikacji”?

Wcale nie na podstawie Jiry — na podstawie `docs/components.json`. Każdy issue z Jiry jest najpierw
rozwiązywany do zbioru komponentów, które dotyka (na podstawie powiązanych feature flag, albo — gdy nie ma
powiązanej flagi — na podstawie surowej historii deploymentów), a każdy z tych komponentów ma własną listę
`application` w `docs/components.json`. Issue pojawia się raz pod każdą aplikacją, do której należy
którykolwiek z jego komponentów; komponent bez ustawionego `application` używa własnej nazwy jako
jednoelementowej „aplikacji”, zamiast być pomijany.

To pole jest tablicą na komponencie, nie pojedynczą wartością, właśnie po to, aby komponent współdzielony
przez dwie aplikacje (np. backend używany przez dwa różne frontendy) miał swoje issue widoczne pod obiema, a
nie wymuszał arbitralnego jednego właściciela.

(Plik: `docs/app.js`, funkcje `componentsForIssue`, `applicationsForComponent`, `applicationsForIssue`.)

### Czym różni się „sprint” od „PI” i skąd się bierze?

Jeden PI (Program Increment) zwykle obejmuje kilka sprintów. Obie wartości są odczytywane z tego samego pola
Sprint w Jirze — `pi` jest jego skróconym, wyliczonym przez regex podsumowaniem (np. `24.4.3` → `PI-24.4`),
natomiast `sprint` to surowa, rozwiązana nazwa tego samego pola, zapisywana obok `pi`, nie zamiast niego.
Release Notes zagnieżdża sprinty wewnątrz ich PI, a nie zamienia grupowanie po PI na grupowanie po sprincie,
bo widok na poziomie PI wciąż odpowiada na inne, użyteczne pytanie („czy cały ten increment już wyszedł”) niż
widok na poziomie sprintu.

(Skrypt: `scripts/sync-jira.js`, funkcje `pickRelevantSprintName`, `extractPiFromSprintName`.)

### Jak decydowane jest „Fully released to PROD” dla grupy (aplikacji, PI albo sprintu)?

Każdy issue w tej grupie musi być albo `released` (zdeployowany **i** jego flaga jest włączona), albo
`deployed_code_only` (żadna flaga go nie linkuje, więc udany deployment odwołujący się do niego jest
najbardziej ostatecznym statusem, jaki ten issue może mieć) na `prod` — według tej samej logiki
`issueStatusForEnv`, którą Product view już wykorzystuje dla swoich pigułek per issue. Choćby jeden issue
gdziekolwiek w grupie, który jest tylko `deployed` (flaga wyłączona), `partial` albo `none`, trzyma badge
całej grupy na „In progress” — to celowo zestawienie na zasadzie wszystko-albo-nic, nie średnia czy procent.

(Plik: `docs/app.js`, funkcja `issuesFullyReleasedToProd`.)

### Skąd bierze się data przy „Fully released to PROD”?

Dla każdego issue moment, w którym faktycznie stał się wydany, to *późniejsze* z dwóch zdarzeń: deploymentu,
który go wdrożył, i (jeśli jest za flagą) momentu włączenia tej flagi — obie rzeczy muszą być prawdziwe
równocześnie, więc liczy się to, co wydarzyło się jako drugie. Data całej grupy to najpóźniejsza z dat jej
issue'ów, bo grupa kończy wydawanie w momencie, gdy ostatni z nich przekroczy tę linię. Dlatego data pojawia
się tylko przy „Fully released to PROD”, a nigdy przy „In progress” — dla wciąż otwartej grupy nie ma jednego
sensownego momentu „od kiedy”.

(Plik: `docs/app.js`, funkcje `issueReleasedAtProd`, `groupReleasedAtProd`.)

### Czemu zakładka pokazuje „No PI-tagged issues to show yet”, choć załadowany plik PI nie jest pusty?

Ponieważ każdy issue w nim jest zastępczym stubem wywiedzionym z deploymentów (patrz „Skąd biorą się numery
Epików/Story/Tasków?” wyżej) — ma `pi: "—"`, nie realny PI. Zakładka Release Notes filtruje po `isRealPi`,
a placeholder `"—"` w stubie nigdy go nie przechodzi. Oznacza to, że ta zakładka jest użyteczna tylko wtedy, gdy `sync-jira.js` faktycznie z sukcesem
łączy się z Jirą — jeśli każdy issue wygląda jak stub, najpierw sprawdź logi tego workflowa oraz sekrety
`JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN`.

## Aktualność danych (nagłówek)

### Co oznacza tekst „synced HH:MM” w plakietce statusu w nagłówku?

Tag `source · data/*.json` obok zakładek potwierdza jedynie, że pliki danych zostały poprawnie pobrane
z brancha `live` — nic nie mówi o tym, jak niedawno, ani jak kompletnie, te pliki zostały ostatnio
zaktualizowane po stronie serwerowej.

„synced HH:MM” jest bardziej rygorystyczne. Jest ustemplowane tylko wtedy, gdy przebieg
`orchestrate-full-sync.yml` z sukcesem zsynchronizował deploymenty **wszystkich** śledzonych komponentów
(nie tylko jednego) oraz Jirę — czyli ta ścieżka tego workflowa, którą wywołuje dzienny harmonogram
bezpieczeństwa (cron), ręczne uruchomienie albo nieznany/nieprawidłowy dispatch, nigdy zaś jednokomponentowy
`repository_dispatch` wywoływany zaraz po konkretnym deploymencie. To rozróżnienie ma znaczenie, ponieważ
ścieżka jednokomponentowa może się po cichu w ogóle nie wywołać, jeśli plik workflow repozytorium
deployującej aplikacji — na branchu, który wywołał ten konkretny deployment — nigdy nie otrzymał kroku
wywołującego ten sygnał (patrz model branchy `main`/`live` w `CLAUDE.md`); bez osobnego wskaźnika dashboard
nie miałby żadnego sposobu, aby pokazać, że jakaś synchronizacja została pominięta.

(Skrypt: `record-full-sync.js`, zapisujący `docs/data/sync-meta.json`. Workflow: `orchestrate-full-sync.yml`,
job `record_full_sync`, uzależniony od `needs.prepare.outputs.full == 'true'`. Plik: `docs/app.js`,
renderowany do elementu `#statusBadgeTime` wewnątrz plakietki statusu w nagłówku.)

## Workflowy — kiedy każdy z nich się uruchamia?

- **`orchestrate-full-sync.yml`** (deploymenty i Jira) — uruchamia się automatycznie natychmiast po
  zakończeniu deploymentu, przez webhook z repozytorium aplikacji; na dziennym harmonogramie bezpieczeństwa o
  3:00, na wypadek gdyby webhook kiedykolwiek nie doszedł; może też zostać uruchomiony ręcznie z zakładki
  Actions.
- **`check-flags.yml`** — nie ma własnego harmonogramu. Jest wywoływany przez CI każdego repozytorium
  aplikacji, więc uruchamia się wtedy, gdy to repozytorium zdecyduje go wywołać, typowo przy push albo pull
  request dotykającym plików związanych z flagami.
- **`sync-runtime-be-flags.yml`** — uruchamia się, gdy backendowy serwis flag wysyła webhook informujący o
  zmianie flagi, a także po zakończeniu deploymentu w którymkolwiek repozytorium aplikacji, ponieważ release
  backendu może sam zmienić domyślną wartość flagi. Dzienny harmonogram bezpieczeństwa o 3:15 obejmuje
  przypadek, gdy któryś z tych sygnałów zostanie pominięty, a workflow można też uruchomić ręcznie. Wcześniej
  odpytywał bezwarunkowo co 15 minut; zostało to rozluźnione, gdy webhooki i trigger deployowy uczyniły
  częste odpytywanie niepotrzebnym, biorąc pod uwagę, jak rzadko te flagi faktycznie się zmieniają w praktyce.
- **`update-flag-state.yml`** — nigdy nie uruchamia się na harmonogramie. Uruchamia się tylko wtedy, gdy
  zostanie wywołany ręcznie, albo gdy backend wysyła webhook informujący, że konkretna flaga się zmieniła.
- **`fill-flag-metadata.yml`** — tylko ręcznie, używany, gdy osoba wypełnia klucze Jiry, komponenty albo opis
  flagi.
- **`retrigger-app-checks.yml`** — uruchamia się automatycznie, gdy sam `flags-meta.json` zmienia się na
  `live`, aby ponownie uruchomić przebiegi `check-flags` w repozytoriach aplikacji, które wcześniej zakończyły się
  niepowodzeniem z powodu brakujących metadanych.
- **`sync-main-to-live.yml`** — uruchamia się automatycznie przy każdym push do `main`, który dotyka
  `scripts/`, `docs/` albo `.github/workflows/`. To jest mechanizm przenoszący zmiany kodu z `main` na branch
  `live`, z którego faktycznie serwowany jest GitHub Pages.
- **`backfill-deployment-metadata.yml`** i **`backfill-flag-state-history.yml`** — jednorazowe narzędzia
  serwisowe, nigdy nie uruchamiane automatycznie. Istnieją, aby zostać wywołane ręcznie, gdy starsze, już
  zapisane dane wymagają doprowadzenia do zgodności z nowszą wersją logiki synchronizacji.