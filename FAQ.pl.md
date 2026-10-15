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

### Co znaczy „Diff to TEST” i kiedy się pojawia?

Karta środowiska pokazuje **„Diff to TEST”** (środowisko, z którym jest porównywane — poprzedni etap łańcucha
promocji `test` → `qa` → `prod`) tylko wtedy, gdy *kod* jego aktualnego deploymentu różni się od kodu tamtego
środowiska. Karta nie pokazuje nic więcej; szczegóły są w modalu otwieranym kliknięciem.
(Skrypt: `sync-github-deployments.js`, funkcje `computeEnvDrift()`/`compareTrees()`; zapis w `driftBehind`.)

Jak to jest rozstrzygane dla każdej pary środowisk:

1. Porównywane są **drzewa gita** obu wdrożonych commitów. Identyczne drzewo = identyczne pliki = brak
   znacznika, niezależnie od liczby commitów między nimi (merge, squash i osobne branche wdrożeniowe tworzą
   nowe commity dla identycznego kodu).
2. W przeciwnym razie rekurencyjne listingi drzew (`GET /git/trees/{sha}?recursive=1`) są porównywane po
   ścieżce i SHA bloba. Ścieżki pasujące do `driftIgnorePaths` komponentu (`docs/components.json` — „plumbing”
   wdrożeniowy, np. `.github/`, `README.md`, `CODEOWNERS`; `dir/` = prefiks od korzenia repo, wzorzec z `/` =
   dokładna ścieżka, sama nazwa = plik o tej nazwie na dowolnej głębokości, `*` = dowolne znaki poza `/`) nie
   są liczone. Brak pozostałych różniących się plików = brak znacznika.
3. Jeśli porównania nie da się uznać za wiarygodne — błąd API GitHuba albo zbyt duże repozytorium na jeden
   listing (GitHub obcina przy 100 000 wpisów / 7 MB) — rekord dostaje `diff: { unknown: true }`, a modal
   pokazuje **Unknown**; nigdy nie jest to po cichu traktowane jako „brak różnic”.

Modal pokazuje po kolei: **różnicę plików** (liczba różniących się plików — zmiana nazwy to dwa pliki —
pierwsze 20 ścieżek oraz ile pominięto przez `driftIgnorePaths`); surową **historię Gita** z zapytania
compare (`commitCount`: commity, które ma tamto środowisko, a to nie; `untestedCommitCount`: kierunek
odwrotny — np. hotfix omijający wcześniejsze środowisko). Liczby z historii mierzą commity, nie kod, więc duża
wartość, np. „786 behind TEST”, nie oznacza dużej różnicy; zostają tylko jako kontekst. Pochodzą z tego samego
zapytania compare, które i tak liczy `commitUrl`/`relatedIssues`, więc nic nie kosztują; porównanie drzew dodaje
do czterech zapytań do API na parę, gdy drzewa commitów się różnią.

**Czego to nie pokazuje:** porównanie drzew obejmuje wyłącznie pliki repozytorium. Nie potwierdza, że
wdrożenia są poza tym identyczne (konfiguracja, zmienne środowiskowe, obrazy, feature flagi).

**Starsze rekordy:** rekordy zsynchronizowane przed wprowadzeniem tego porównania nie mają `diff`; ich modal
nie ma sekcji różnicy plików, tylko historię Gita, dopóki następna synchronizacja usługi nie
zastąpi rekordu.

**Komponenty wdrażane z branchy-wyzwalaczy `deployment/*`:** ustaw `versionFile` w `docs/components.json`, aby
porównywane ref-y pochodziły z taga wskazanego w pliku (patrz `design-docs/DRIFT-SAME-VERSION-DIFFERENT-SHA.pl.md`),
i dodaj `trigger.properties` do `driftIgnorePaths`.

**Przykład na realnych danych** (`evapl-service-frontend`, 2026-10-06): TEST wdrożył `v1.0.0` o 14:44 (commit
`42e7ce8`, z zadaniami EBO-16806/ECST-9871/…). Dwie minuty później QA wdrożyło commit również *wyświetlany*
jako `v1.0.0` — ale faktycznie inny (`cfd213e`), z zupełnie innym, nieprzecinającym się zestawem zadań
(ARP-4953/EBO-8399/EBO-13020). Kolejne wdrożenia TEST (`v1.1.0`, `v1.2.0`) też nigdy nie zawierały `cfd213e`
ani jego zadań — co potwierdza, że ten commit faktycznie nigdy nie przeszedł przez TEST. Komunikat
„233 commit(s) skipped TEST” (dawne brzmienie, sprzed „Diff to”) pokazany przy tym rekordzie QA był więc trafny, nie był fałszywym alarmem:

| Env | Czas wdrożenia | Wyświetlana wersja | Rzeczywisty commit | Zadania Jira |
|---|---|---|---|---|
| TEST | 14:44 | `v1.0.0` (zweryfikowany tag) | `42e7ce8` | EBO-16806, ECST-9871, … |
| QA | 14:46 | `v1.0.0` (niezweryfikowana — dopasowanie z treści commita) | `cfd213e` | ARP-4953, EBO-8399, EBO-13020 |

Aby sprawdzić, czy konkretne ostrzeżenie „skipped” ma taki sam charakter, porównaj powiązane zadania Jira
(albo zakres commitów pod linkiem `commitUrl` tego deploymentu) między aktualnymi rekordami obu środowisk w
Deployment history — brak jakiegokolwiek pokrycia znaczy, że te dwa środowiska faktycznie uruchamiają inny,
niezwiązany kod, a nie ten sam release w innym tempie.

### Czy `deployments.json` jest podzielony per komponent albo per PI, i kiedy nowy deployment faktycznie staje się widoczny?

Nie ma podziału per komponent czy per PI — to jeden wspólny plik, `docs/data/deployments.json`, zawierający
rekordy wszystkich śledzonych komponentów naraz (każdy rekord ma własne pole `component`). Drugi, maleńki,
nigdy nieprzycinany plik, `docs/data/deployments-cursor.json`, śledzi najwyższe ID deploymentu z GitHuba,
jakie kiedykolwiek zsynchronizowano, per komponent — dzięki temu już przetworzony deployment można rozpoznać
jako taki nawet po tym, jak jego faktyczny rekord wypadnie już ze starości z głównego pliku.

Rekordy starsze niż 90 dni są fizycznie usuwane z `deployments.json` przy każdej synchronizacji
(`RETENTION_DAYS`), oprócz jednego najnowszego rekordu i jednego najnowszego **udanego** rekordu per
komponent/środowisko, które zostają niezależnie od wieku — na nich oparta jest logika „aktualnej
wersji”/drift/rollback dashboardu, więc nie mogą zostać przycięte.

Skrypt synchronizujący odpala się raz per komponent: czyta cały istniejący plik, zostawia rekordy
wszystkich innych komponentów nietknięte, scala świeże rekordy tylko dla tego jednego komponentu, dla
którego został wywołany, przycina, i zapisuje cały plik z powrotem.

Dzieje się to w jobie `sync_deployments` w `orchestrate-full-sync.yml`. `repository_dispatch` wystrzelony
zaraz po deploymencie — przez krok `notify_shipscope` w workflow tego repozytorium aplikacji — synchronizuje
tylko ten jeden komponent; dzienny cron o 3:00 i ręczne uruchomienie synchronizują wszystkie śledzone
komponenty.

W praktyce: nowy deployment danego komponentu staje się widoczny w ciągu kilku minut od jego zakończenia,
bo sam ten deployment wywołuje synchronizację dla tego komponentu. Jedyny sposób, w jaki to się opóźnia, to
sytuacja, gdy workflow deployującego repozytorium nigdy nie wywołuje `notify_shipscope` wcale — wtedy ten
deployment czeka na najbliższy przebieg bezpieczeństwa o 3:00 (o ile wciąż mieści się w oknie retencji).

Typowa przyczyna: deployment uruchomiony z długo żyjącego brancha, np. `deployment/qa` (commit podbijający
`version` w `trigger.properties`). GitHub czyta plik workflow z brancha, na który wykonano push, więc kopia
workflow na tym branchu nie ma kroku `notify_shipscope` dodanego wyłącznie na `main`. Rozwiązanie bez
serwera i bez utrzymywania kroku per branch to mały workflow na **domyślnym branchu** repozytorium serwisu,
wyzwalany przez `workflow_run` (który odpala się tylko z YAML-a domyślnego brancha, niezależnie od brancha,
z którego poszedł deploy) i wywołujący `notify-deployment.yml` — zob. „Alternatywa bez serwera” w
`design-docs/DEPLOYMENT-WEBHOOK-PROPOSAL.pl.md`.

(Skrypt: `sync-github-deployments.js`, funkcje `trimOldRecords`, `main`. Workflow: `orchestrate-full-sync.yml`,
job `sync_deployments`. Trigger: krok `notify_shipscope` w `notify-deployment.yml`.)

### Co to jest `docs/data/summary.json` i dlaczego istnieje obok `deployments.json`?

To mały, **wstępnie wyliczony** plik: dla każdego komponentu i środowiska zawiera tylko jeden rekord
aktualnego (ostatniego udanego) deploymentu i jeden rekord ostatniego deploymentu w ogóle, niezależnie od
tego, czy się powiódł. Istnieje wyłącznie dla szybkości renderowania, nie dlatego, że dashboard potrzebuje
jakichś danych, których nie ma już w `deployments.json`.

Bez niego pokazanie „co aktualnie działa na produkcji dla usługi X” wymaga przeszukania *całej* tablicy
`deployments.json` — każdego rekordu, dla każdego komponentu, w całym oknie retencji — i posortowania
wyników, i to każdy raz, gdy to pytanie jest zadawane. Dashboard zadaje to pytanie wielokrotnie już przy
pierwszym załadowaniu: raz dla każdego komponentu (górne karty podsumowania) i jeszcze raz dla każdej pary
komponent×środowisko (matryca). Dla dużej, śledzonej floty z miesiącami przechowywanej historii, powtarzanie
tego pełnego przeszukania dziesiątki razy, zanim strona nawet skończy się renderować, jest zmarnowaną pracą
— bo odpowiedź praktycznie nigdy nie zmienia się między synchronizacjami.

`summary.json` wylicza tę odpowiedź raz, po stronie serwera, w dokładnie tym momencie, w którym skrypt
synchronizujący już ma te dane pod ręką — zbudowanie go nie kosztuje nic dodatkowego: `trimOldRecords()`
i tak już musi ustalić „jaki jest najnowszy rekord, i najnowszy *udany* rekord, dla każdego
komponentu/środowiska”, żeby zdecydować, co bezpiecznie zachować przy przycinaniu starej historii — zapisanie
tych samych dwóch wartości do osobnego, małego pliku to więc powtórne wykorzystanie już wykonanej pracy, nie
nowa praca. Dashboard czyta potem bezpośredni odczyt z tego pliku, zamiast liczyć to na nowo w przeglądarce,
i wraca do starego, pełnego przeszukania tylko wtedy, gdy danego komponentu lub środowiska w tym pliku nie
ma (np. komponent dołączony po tym, jak ten plik już istniał, potrzebuje jeszcze jednej synchronizacji, żeby
się w nim pojawić).

Ponieważ plik jest wstępnie wyliczony, a nie prowadzony niezależnie, nie może nigdy w istotny sposób
rozminąć się z `deployments.json` — oba są zapisywane z tych samych danych w tym samym przebiegu
synchronizacji. Jedyna zaakceptowana szczelina: jednorazowy, ręcznie wyzwalany skrypt
`backfill-deployment-metadata.js` edytuje starsze rekordy deploymentów bezpośrednio i nie aktualizuje tego
pliku — więc poprawka wprowadzona backfillem do rekordu, który akurat jest „aktualnym” rekordem komponentu,
nie będzie tu widoczna do najbliższej regularnej synchronizacji tego komponentu. To nieaktualny cache na
najwyżej kilka minut, nie błędny dashboard — mechanizm pełnego przeszukania jako fallback jest zawsze
dostępny, gdyby ten plik był nieobecny albo nieaktualny.

(Skrypt: `sync-github-deployments.js`, funkcje `trimOldRecords`, `buildSummary`. Plik: `docs/app.js`,
funkcja `currentVersion`.)

### Dlaczego niektóre zapytania do API GitHuba korzystają z zapytań warunkowych (ETag), a inne nie?

REST API GitHuba wspiera standardowy mechanizm HTTP zwany zapytaniami warunkowymi: odpowiedź niesie
nagłówek `ETag` (odcisk palca tej konkretnej odpowiedzi), a kolejne zapytanie o ten sam URL może przekazać
ten odcisk jako `If-None-Match`. Jeśli nic się nie zmieniło, GitHub odpowiada `304 Not Modified` bez treści,
zamiast wysyłać te same dane jeszcze raz jako prawdziwe `200`. Konkretna korzyść dla ShipScope: odpowiedź
`304` **nie** liczy się do limitu zapytań API GitHuba, podczas gdy zwykłe `200` się liczy.

ShipScope korzysta z tego dla dokładnie trzech endpointów: pierwszej strony deploymentów komponentu, jego
tagów i jego release'ów — trzech zapytań listujących, odpytywanych przy *każdym pojedynczym* przebiegu
synchronizacji, niezależnie od tego, czy po stronie GitHuba cokolwiek faktycznie się zmieniło od ostatniego
razu. W typowym przypadku — przebieg crona w stanie ustabilizowanym, dla wielu komponentów, z których
większość nie ma nic nowego — te zapytania teraz najczęściej wracają jako darmowe `304`, a nie zużywają
realnego budżetu limitu zapytań na dane, które i tak okazały się identyczne z już znanymi.

Celowo **nie** jest to zastosowane do wielu innych zapytań do GitHuba wykonywanych per deployment w ramach
jednego przebiegu (pobranie commita, porównanie dwóch commitów, odczyt statusów deploymentu, rozwiązanie
przebiegu workflow) — nie z braku starań, ale dlatego, że żadne z nich faktycznie by na tym nie zyskało:
każdy z tych URL-i jest pobierany, maksymalnie, raz w całym cyklu życia tego skryptu (kursor synchronizacji
gwarantuje, że dany deployment jest przetwarzany tylko raz) — nie ma więc nic do zweryfikowania przy drugim
zapytaniu, które nigdy nie nastąpi. Cache'owanie ETag opłaca się tylko dla URL-a, który zostanie odpytany
ponownie później, z szansą, że odpowiedź się nie zmieniła — to prawda dla trzech endpointów listujących
powyżej, nieprawda dla jednorazowego odpytania per deployment.

Żeby cache faktycznie pomagał, musi przetrwać *między* osobnymi przebiegami workflow, nie tylko w ramach
jednego — cache żyjący tylko na czas jednego joba resetowałby się do pustego (a więc nigdy nie dawałby
`304`) przy każdym zaplanowanym przebiegu. Job `sync_deployments` w `orchestrate-full-sync.yml` dołącza
krok `actions/cache` wokół katalogu, do którego skrypt synchronizujący zapisuje swój plik cache ETag per
komponent, kluczowany tak, żeby świeży przebieg mógł odtworzyć cache z poprzedniego przebiegu, zanim
zdecyduje, co pobrać na nowo.

(Skrypt: `scripts/lib/github-api.js`, funkcje `githubApiRequest`/`githubApiGet`, parametr `etagCache`;
`sync-github-deployments.js`, konstanta `ETAG_CACHE_PATH`. Workflow: `orchestrate-full-sync.yml`, job
`sync_deployments`, krok „Cache GitHub API ETags”.)

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

### Jak podzielone są pliki z danymi Jiry, i kiedy coś nowego w sprincie faktycznie staje się widoczne?

Dane z Jiry nie są w jednym pliku. Jest jeden plik JSON per PI (np. `docs/data/jira-issues/PI-27.3.json`),
plus `index.json` z listą wszystkich PI, dla których ShipScope ma dane — razem z nazwami i datami sprintów
każdego PI — oraz osobny `status-index.json`, płaska mapa `klucz → {pi, statusCategory}` obejmująca
wszystkie PI naraz, używana tylko przez panel Flags w Technical View, bo ten panel nie ma własnego
selectora PI, którym mógłby wybrać shard. Dashboard wczytuje z góry `index.json`, a potem tylko plik
dokładnie jednego, aktualnie wybranego PI — nigdy nie trzyma w pamięci issue z więcej niż jednego PI naraz.

Automatycznie odświeżany jest tylko bieżący PI — ten, który `sync-jira.js` wyznacza z aktywnego sprintu
skonfigurowanego boarda — i robi to pełnym nadpisaniem przy każdej synchronizacji, nie mergem: to, co
zwróci najnowszy fetch, staje się **całą** nową treścią pliku tego PI. Issue, które wypadło z PI, po prostu
nie jest w nowej wersji, bez osobnego kroku czyszczącego.

Plik każdego innego PI jest snapshotem z momentu, gdy ktoś ostatnio ręcznie odpalił workflow
`backfill-jira-issues.yml` dla niego, i nigdy automatycznie nie jest dotykany ponownie. Jeśli sprint należy
do PI innego niż bieżący, nic nowego w nim się nie pojawi, dopóki ten backfill nie zostanie ponownie
odpalony ręcznie.

Synchronizacja Jiry to job `sync_jira` w `orchestrate-full-sync.yml`, odpalany po każdym deploymencie
jakiegokolwiek śledzonego komponentu (przez `repository_dispatch`), na dziennym harmonogramie
bezpieczeństwa o 3:00, albo ręcznie — i biegnie przy każdej z tych okazji, nie tylko przy „sync wszystkiego”,
bo job ma `if: always()`, żeby porażka synchronizacji deploymentów jednego komponentu nie mogła go pominąć.

W praktyce: nowy item dodany do bieżącego sprintu bieżącego PI staje się widoczny po najbliższej
synchronizacji Jiry — co w rozsądnie aktywnej organizacji oznacza w ciągu minut od *czyjegokolwiek*
kolejnego deploymentu, bo to samo wystarczy, aby ponownie odpalić cały workflow. Jeśli nic się tego dnia nie
deployuje, i tak pojawi się najpóźniej przy najbliższym przebiegu crona o 3:00. Ręczne odpalenie workflowa
sprawia, że pojawia się natychmiast. Item dodany do PI, który nie jest bieżący, nie pojawi się wcale, dopóki
ktoś nie odpali dla niego backfillu.

(Skrypt: `sync-jira.js`, funkcje `resolveCurrentPiForSpaces`, `runCurrentPiMode`, `writePiShards`. Workflow:
`orchestrate-full-sync.yml`, job `sync_jira`. Ścieżka ręcznego snapshotu: `backfill-jira-issues.yml`.)

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

## Sekrety i tokeny — które poświadczenie do czego służy?

### Czy `create-github-app-token` nadal jest potrzebny, skoro `JIRA_API_TOKEN` jest już w Repository Secrets?

Tak — oba służą do zupełnie różnych systemów i żaden nie zastępuje drugiego.

- **`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`** (Repository Secrets) dają dostęp **wyłącznie do Jiry** —
  `scripts/sync-jira.js` wysyła je jako HTTP Basic przy każdym wywołaniu API Jiry. GitHub nic o nich nie wie.
- **`actions/create-github-app-token`** wymienia klucz prywatny GitHub App (`SHIPSCOPE_APP_PRIVATE_KEY` albo
  `CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY`) na krótkotrwały token (ok. godziny), ograniczony do wskazanych
  repozytoriów. Służy **wyłącznie do operacji na GitHubie**.

Token App jest używany w siedmiu miejscach, zawsze z tego samego powodu — domyślny `GITHUB_TOKEN` nie da rady:

| Workflow | Do czego służy token App |
|---|---|
| `orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml` | Odczyt Deployments, commitów i compare z repozytorium aplikacji (`repositories: ${{ matrix.repo }}`). |
| `retrigger-app-checks.yml` | Ponowne uruchamianie nieudanych przebiegów `check-flags` w repozytoriach aplikacji (`actions: write` tam). |
| `check-flags.yml`, `notify-deployment.yml` | Działają w workflowie repozytorium aplikacji, ale zapisują do / wysyłają zdarzenia do `evdt-service-shipscope`. |
| `fill-flag-metadata.yml`, `sync-runtime-be-flags.yml` | Wysyłają zdarzenie `repository_dispatch` `flags-meta-changed`. |

`GITHUB_TOKEN` nie jest zamiennikiem z dwóch powodów: obejmuje tylko repozytorium, w którym działa workflow (nie
dosięgnie repozytorium aplikacji ani ShipScope z jego poziomu), a tworzone nim zdarzenia i pushe celowo nie
uruchamiają kolejnych workflowów (więc nie wyśle `repository_dispatch`, który ma wystartować inny workflow).

### Czy job `sync_jira` używa tokenu GitHub App?

Nie. `sync_jira` w `orchestrate-full-sync.yml` potrzebuje tylko sekretów Jiry i zwykłego `GITHUB_TOKEN`. Widać to
w logu przebiegu: dwa kroki `actions/checkout` (`main` w katalogu głównym — skrypty, `live` do `data/` — pliki
JSON), a potem composite action `sync-with-retry` — w tym jobie nie ma kroku `create-github-app-token`. Sekrety
Jiry są przekazywane jako `env:` tylko do tego jednego kroku, a commit na `live` wykonywany jest domyślnymi
poświadczeniami `GITHUB_TOKEN` z checkoutu, co wystarcza, bo job zapisuje tylko do tego samego repozytorium, w
którym działa. Token App widoczny wcześniej w tym samym workflowie należy do jobu `sync_deployments` (czyta
repozytorium *aplikacji*), a nie do `sync_jira`.

Skutek uboczny wart zapamiętania: ponieważ ten push jest wykonany `GITHUB_TOKEN`-em, sam nie uruchamia innych
workflowów. Nic dalej nie ma reagować na commit z danymi Jiry, więc to w porządku — ale to dlatego wszystko, co
*powinno* się rozchodzić dalej (jak `flags-meta-changed`), używa tokenu App.

### Które z tych poświadczeń jest długowieczne i najbardziej warte ochrony?

**Klucz prywatny** App. Tokeny, które wydaje, wygasają po ok. godzinie, ale sam klucz nie, a może wydawać tokeny z
zapisem do `live` i do repozytoriów aplikacji. Dlatego warto: przypiąć do SHA akcje firm trzecich, które go
obsługują (`create-github-app-token`), ograniczyć `permission-*` każdego tokenu do minimum potrzebnego w danym
kroku oraz śledzić właściciela i datę rotacji klucza — patrz `design-docs/TODO.md`.
