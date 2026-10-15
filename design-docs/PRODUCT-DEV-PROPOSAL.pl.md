# Hipoteza: jak zbudować ShipScope od zera, bez ograniczeń hostingu/notyfikacji

*English version: [PRODUCT-DEV-PROPOSAL.md](PRODUCT-DEV-PROPOSAL.md)*

> **Status: scenariusz hipotetyczny, nie plan do wdrożenia.** Ten dokument odpowiada na jedno konkretne
> pytanie „co by było, gdyby": gdyby usunąć obydwa fundamentalne ograniczenia ShipScope — statyczny hosting
> na GitHub Pages i mechanizm kroku CI `notify_shipscope` jako sposób dowiadywania się o deploymencie — jak
> wyglądałby najlepszy, najszybszy, najtańszy i najbardziej niezawodny sposób zbudowania ShipScope od zera?
> To nie jest wdrożony plan, nie jest mapą drogową i nie jest rekomendacją zaczynania tej pracy teraz — ten
> sam duch co „niezdecydowana wizja, nie wdrożony plan" w `INTEGRATION-VISION.md`. Istnieje, żeby
> przyszła, realna decyzja o inwestycji w infrastrukturę miała konkretny cel, do którego się odnieść,
> zamiast zaczynać tę rozmowę od zera.

Dokument buduje bezpośrednio na dwóch istniejących już w repo dokumentach, których treści nie powtarza:

- `INTEGRATION-VISION.md` już opisuje docelowe doświadczenie onboardingu (instalacja GitHub App + jeden
  wpis konfiguracyjny, brak PR-a, brak sekretów, brak zmiany CI) i już wskazuje mechanizm webhooka na
  poziomie GitHub App dla deploymentów, plus kompromis push/hybrid vs. pull dla feature flag.
- `DEPLOYMENT-WEBHOOK-PROPOSAL.md` ma już kompletny, fazowany plan techniczny konkretnie dla listenera
  webhooka deploymentów — weryfikacja podpisu, filtrowanie zdarzeń, kontrakt dispatcha, wdrożenie.
- `ARCHITECTURE-NOTES.md` już mapuje pytanie o wielozespołowość/izolację i wnioskuje, że model
  push/hybrid jest strukturalnie bliższy niezależności zespołów niż utrzymywanie przez ShipScope danych
  uwierzytelniających każdego zespołu do jego dostawcy flag.

Ten dokument nie powtarza tych analiz. Zadaje jedno pytanie, na które żaden z trzech nie odpowiada:
**gdybyś budował to dzisiaj, mając pozwolenie na realny serwer i brak wymogu przepuszczania każdego zapisu
przez commit w GitHub Actions, czy nadal chciałbyś `docs/data/*.json` na GitHub Pages, czy coś innego — i
jak konkretnie wygląda to „coś innego", od początku do końca?**

## Rekomendacja, od razu

Zbudować mały, nudny, trójwarstwowy wewnętrzny serwis webowy: lekki backend API w TypeScript, zarządzaną
bazę Postgres i frontend, który zachowuje większość dzisiejszej logiki renderowania i łączenia danych z
`docs/app.js` — tylko wskazuje na realne API zamiast na statyczne pliki JSON, plus jeden kanał
aktualizacji na żywo (Server-Sent Events), żeby dashboard odzwierciedlał deployment albo przełączenie
flagi w ciągu sekund, nie w cyklu synchronizacji. Ingestia przechodzi z „krok CI wywołuje dispatch GitHub,
który wywołuje workflow, który commituje plik JSON" na „webhook GitHub App i webhook Jira trafiają
bezpośrednio na własne endpointy backendu, które piszą prosto do bazy danych". Onboarding to instalacja
GitHub App na repozytorium plus dodanie jednego wiersza przez mały wewnętrzny ekran administracyjny — bez
pull requesta, bez sekretu, bez zmiany CI, zarówno dla deploymentów, jak i (jeśli zespół wysyła zmiany flag
w ten sam sposób) feature flag.

To nie jedyny działający projekt — zobacz „Rozważone i odrzucone alternatywy" poniżej — ale ten dokument
rekomenduje właśnie ten, i reszta tekstu wyjaśnia dlaczego, szczegółowo, włącznie z tym, co to kosztuje i
co trzeba stracić.

## Czemu nie po prostu „zostawić obecny model, ale z realnym webhookiem"?

Bo gdy serwer w ogóle może istnieć, przepuszczanie każdego zapisu przez cykl commit-do-`live` w GitHub
Actions przestaje mieć sens jako ścieżka *podstawowa* — istniał tylko dlatego, że nie było serwera, do
którego można zapisać bezpośrednio. Konkretnie, dzisiejsza ścieżka zapisu dla jednego zdarzenia
deploymentu to:

GitHub deployment_status → (proponowany) listener webhooka → `repository_dispatch` → checkout dwóch
branchy w GitHub Actions → `sync-github-deployments.js` → odczyt-scalenie-zapis JSON → `git commit` →
push, powtarzany przez `sync-with-retry` wobec przegranego wyścigu.

Z realnym backendem i bazą danych to samo zdarzenie staje się: GitHub deployment_status → endpoint
webhooka → jedna transakcja SQL. Taniec odczytaj-scal-zapisz-i-powtórz, plik kursora, przycinanie
retencyjne, podział na dwa checkouty między `main` i `live` i cały mechanizm wyścigu-push-powtórz istnieją
*konkretnie*, żeby „dane żyją w gicie, mutowane przez bota, czytane przez statyczne pliki" działało
bezpiecznie. Nic z tego nie jest celem samym w sobie — to podpórka wymagana przez to ograniczenie.
Usunięcie ograniczenia powinno usunąć podpórkę razem z nim, nie trzymać jej przykręconej do serwera, który
już jej nie potrzebuje.

## Architektura

### Backend i hosting

Jeden mały serwis w TypeScript (Fastify albo NestJS — oba są w porządku, to nie tutaj leżą trudne decyzje),
skonteneryzowany, wdrożony na jakiejkolwiek platformie kontenerowej, którą organizacja już operuje
(istniejący klaster Kubernetes albo zarządzana usługa kontenerowa typu Cloud Run/Fargate/App Runner — dobrą
decyzją jest „nie stawiać nowej platformy tylko dla tego", nie konkretny dostawca). Udostępnia:

- `POST /webhooks/github` — odbiera zdarzenia `deployment`/`deployment_status`, weryfikuje HMAC
  `X-Hub-Signature-256` dokładnie tak, jak `DEPLOYMENT-WEBHOOK-PROPOSAL.md` już określił dla swojego
  samodzielnego listenera, i pisze bezpośrednio do tabeli `deployments` w jednej transakcji — bez przebiegu
  przez `repository_dispatch`, bo nie ma już powodu wychodzić z GitHub Actions i wracać.
- `POST /webhooks/jira` — odbiera dostawy webhooka Jira Cloud (`jira:issue_updated`, start sprintu itd.),
  chronione wspólnym sekretem (klasyczne webhooki Jiry są niepodpisane, to samo zastrzeżenie już w
  `INTEGRATION-VISION.md`) albo allowlistą IP, i wykonuje upsert do tabeli `jira_issues`.
- `POST /webhooks/flags` — odbiera push zarówno z webhooka wspólnego dostawcy flag (LaunchDarkly, Unleash),
  jak i z własnego małego relaya zespołu (opcja „hybrid" już rekomendowana w `ARCHITECTURE-NOTES.md`), i
  pisze do `flag_states` plus do append-only `flag_state_history`.
- API do odczytu (`GET /api/deployments`, `/api/flags`, `/api/jira-issues` itd.) zasilające frontend —
  filtrowanie i paginacja po stronie serwera, zamiast wysyłania wielomegabajtowego pliku JSON do każdego
  odwiedzającego niezależnie od tego, czego szuka.
- `GET /api/events` (Server-Sent Events) — jedno długotrwałe połączenie na każdą otwartą kartę dashboardu;
  przy każdym zapisie do `deployments`/`flag_states`/`jira_issues` backend wysyła mały komunikat „to się
  zmieniło", a frontend odświeża tylko dotknięty fragment. To jest faktyczny „real-time" w tej propozycji —
  nie aplikacja czatowa na websocketach, tylko dość pushu, by zamienić „odśwież strону jutro" na „wiersz
  aktualizuje się, gdy właśnie na niego patrzysz".

Dzienne zadanie wyrównujące (ten sam duch co dzisiejszy cron w `orchestrate-full-sync.yml`, to samo
uzasadnienie, które `DEPLOYMENT-WEBHOOK-PROPOSAL.md` już podaje dla zachowania swojego crona jako
zabezpieczenia) wciąż odpytuje API GitHub i Jira bezpośrednio i naprawia ewentualny dryf — webhooki mogą
zostać przeoczone, to jest siatka bezpieczeństwa, teraz ścieżka wtórna, nie jedyna.

Większość faktycznej logiki danych nie musi być wymyślona na nowo: `scripts/lib/github-api.js`,
`scripts/lib/jira-api.js`, `scripts/lib/extract-flags.js` oraz logika rozstrzygania statusu per
env/source już istniejąca w `sync-github-deployments.js`/`sync-jira.js`/`resolve-all-flag-states.js`
przenoszą się praktycznie bez zmian — jedyną prawdziwą operacją jest zamiana ich zakończeń „odczytaj
istniejący JSON, scal, zapisz z powrotem" na „odczytaj z Postgresa, scal, zapisz z powrotem w transakcji".
To jest główny powód, dla którego ten projekt jest szybszy do zbudowania niż się wydaje: trudna logika
domenowa (wykrywanie rollbacków, wykrywanie dryfu, rozstrzyganie PI/sprintu, obsługa kolizji źródeł flag)
już istnieje i już jest poprawna.

### Baza danych

Zarządzany Postgres (RDS, Cloud SQL albo odpowiednik — znowu: cokolwiek organizacja już operuje). Zamiana
`docs/data/*.json` na realne tabele usuwa kilka problemów, które istnieją tylko dlatego, że plikami JSON na
gicie był model przechowywania od początku:

- Koniec ręcznego przycinania retencyjnego (`RETENTION_DAYS`, nigdy-nieprzycinane pliki
  towarzyszące kursora/issue-deployments) — przechowuj wszystko, zastosuj retencję przez zwykłe
  zaplanowane `DELETE`/drop partycji, jeśli koszt storage'u kiedykolwiek faktycznie zacznie mieć znaczenie,
  co długo nie nastąpi przy wolumenach danych ShipScope.
- Koniec plików shardów PI, `index.json`, `status-index.json`, `pruned-pis.json` jako ręcznie napisanego
  zestawu reguł zgodności między plikami — PI to po prostu kolumna do filtrowania; „w jakim PI jest teraz
  to zgłoszenie" to jedno zapytanie, nie wyszukiwanie między shardami z własnym plikiem wykluczeń.
- Koniec wykrywania kolizji tego samego klucza między komponentami piszącymi do tego samego obiektu JSON
  (odrzucenie `::error::`-ale-nie-throw w `resolve-all-flag-states.js`) — właściwy schemat z
  `(key, env, source, component)` jako częścią unikalnego ograniczenia, albo wyraźna kolumna właściciela z
  realnym ograniczeniem, czyni ten niezmiennik wymuszanym przez bazę danych, nie ręcznie pisanym w każdym
  skrypcie.
- Realne zapytania zamiast łączeń całego zbioru danych wykonywanych w przeglądarce przy każdym ładowaniu
  strony — „każde zgłoszenie wydane na prod w tym sprincie", „każdy komponent aktualnie zdryfowany", stają
  się klauzulami `WHERE`, nie `Array.filter` po stronie klienta nad wszystkim, co kiedykolwiek pobrano.

### Frontend

Celowo konserwatywnie: zachować czysty JS, frontend bez kroku budowania, bo faktyczna wartość
`docs/app.js` — logika rozstrzygania statusu (`effectiveFlagState`, kategorie statusu wydania, wykrywanie
rollbacku/dryfu, grupowanie po Epikach, wykresy Insights) — jest niezależna od tego, skąd pochodzą dane, a
przepisanie jej we frameworku nie daje nic, czego realny backend sam już nie dał. Jedyna zmiana to to, na
co wskazuje `fetch()`: paginowane, filtrowalne API REST zamiast kilku ciągle rosnących statycznych plików
JSON, plus jedno połączenie `EventSource` dla aktualizacji na żywo. Uwierzytelnianie (poniżej) to drugi
nowy element; wszystko inne — renderowanie, pięć wykresów Insights, grupowanie Epików w Product view,
Release Notes — przenosi się praktycznie bez zmian.

### Uwierzytelnianie i pytanie o izolację

Realny serwer wreszcie daje realną odpowiedź na pytanie otwarte w `ARCHITECTURE-NOTES.md` („czy wspólna
widoczność między zespołami jest cechą czy problemem?") — bo teraz jest gdzie wymusić odpowiedź. Postaw
istniejące SSO organizacji (OIDC) przed API i frontendem. Jeśli biznes zdecyduje, że izolacja jest
wymagana, kolumna `tenant_id`/`team_id` plus row-level security (albo prosta klauzula `WHERE` wymuszana
po stronie serwera, nie klienta) wykonuje faktyczne rozdzielenie. Jeśli wspólna widoczność pozostaje
preferowanym modelem (łączenie sygnałów z różnych zespołów było pierwotnym deklarowanym celem ShipScope),
SSO wciąż daje uwierzytelniony dostęp zamiast „publiczny GitHub Pages albo w pełni prywatny za
uwierzytelnianiem GitHub", co było jedynym wyborem, jaki `ARCHITECTURE-NOTES.md` mógł zaproponować pod
starym ograniczeniem.

### Onboarding, od początku do końca

1. Zainstaluj GitHub App ShipScope na nowym repozytorium (akcja administracyjna, bez PR-a, bez sekretu,
   bez zmiany CI — tak jak docelowa wizja w `INTEGRATION-VISION.md`).
2. Dodaj jeden wiersz przez mały wewnętrzny ekran administracyjny (albo jedno wywołanie API): nazwa
   komponentu, opcjonalne źródło feature flag, opcjonalne mapowanie na projekt Jira. Bez commitu w gicie,
   bez procesu review, bo to teraz dane aplikacji w bazie danych, nie plik konfiguracyjny w repozytorium,
   które przy okazji jest też artefaktem wdrożenia ShipScope.
3. Jeśli pipeline wdrożeniowy zespołu już produkuje obiekty GitHub Deployment widoczne dla App, po jego
   stronie nie trzeba robić nic więcej — webhook odpala się już na poziomie platformy GitHub, nie z pliku
   workflow zespołu, dokładnie tak, jak zaprojektował już `DEPLOYMENT-WEBHOOK-PROPOSAL.md`.

To w pełni spełnia jednosentencyjny cel z `INTEGRATION-VISION.md` — nie jako przyrostowe usprawnienie
obecnego modelu, ale dlatego, że usunięcie obydwu ograniczeń jest tym, co ten dokument we własnej sekcji
„koszt i kompromisy" już wskazał jako wymagane, żeby tam faktycznie dotrzeć.

## Co to kosztuje, uczciwie

To jest część najważniejsza dla interesariusza biznesowego i nie powinna być łagodzona:

- **Powstaje realny, nieprzerwanie działający serwis**, z całym tego znaczeniem: pipeline wdrożeniowy dla
  samego serwisu, custody sekretów (sekrety webhooków, prywatny klucz GitHub App, dane uwierzytelniające
  DB, sekret klienta OIDC) w środowisku uruchomieniowym zamiast w szyfrowanych sekretach GitHub Actions,
  monitoring, alerty i rotacja dyżurów — ten sam krok, który `DEPLOYMENT-WEBHOOK-PROPOSAL.md` już oznaczył
  jako „nie niejawna konsekwencja dostarczenia jednej funkcji", teraz podjęty w pełni i celowo, nie
  częściowo.
- **Realna powierzchnia ataku.** Publiczne endpointy webhooków, uwierzytelnione API, baza danych
  przechowująca dane organizacyjne o deploymentach/Jirze/flagach — każde wymaga zwykłej staranności
  każdego serwisu backendowego (walidacja wejścia, limitowanie ruchu, łatanie zależności, ćwiczenia
  backup/restore), czego statyczna strona plus GitHub Actions nigdy nie musiała brać pod uwagę.
- **Git przestaje być dziennikiem audytowym.** Dzisiaj każda mutacja danych to commit — `git log` na
  `live` to kompletna, darmowa, odporna na manipulację historia każdej zmiany flagi i każdego zapisanego
  rekordu deploymentu, czego dokładnie wykopuje `backfill-flag-state-history.js`, gdy dedykowany plik
  historii jeszcze nie istniał. Baza danych nie ma darmowego odpowiednika; realny ślad audytowy
  (kto/co/kiedy dla każdego zapisu) musi być celowo zbudowany jako własna tabela, nie odziedziczony po
  mechanizmie przechowywania.
- **„Wdrożenie" przestaje znaczyć „push do main".** Dzisiaj dostarczenie zmiany w ShipScope to `git push`,
  który w końcu podłapuje workflow synchronizacji; nie ma osobnego procesu wydania do zaprojektowania,
  wersjonowania czy wycofania. Realny backend potrzebuje własnego CI/CD, wersjonowania i historii
  wycofań — zwyczajne dla serwisu backendowego, ale nowe względem tego, czego ShipScope dotąd potrzebował.
- **Utrata zapasowego trybu offline/degradowanego.** Wbudowany przykładowy zbiór `FALLBACK` w
  `docs/app.js` do podglądu przez `file://` oraz „GitHub Pages przypadkiem wciąż działa, gdy wszystko inne
  nie działa" — obydwa odchodzą; dostępność dashboardu teraz zależy całkowicie od własnego uptime'u nowego
  serwisu.
- **Realny, ciągły koszt**, gdzie dzisiejszy jest praktycznie zerowy: compute (prawdopodobnie niewielki,
  bo to wewnętrzne narzędzie z niskim ruchem — platforma skalująca się do prawie zera między zdarzeniami
  utrzymuje to umiarkowanym), zarządzana baza danych (najmniejszy sensowny tier) oraz czas inżynierski na
  zbudowanie i potem operowanie wszystkim powyższym. Przybliżony rząd wielkości, nie wycena: kilka tygodni
  skoncentrowanej pracy inżynierskiej, żeby dorównać temu, co istnieje dzisiaj, plus realny push na żywo,
  oraz ułamek etatu w trybie ciągłym na łatanie, monitoring i reakcję na incydenty po ustabilizowaniu —
  mało w liczbach absolutnych, ale ściśle więcej niż model „jeden inżynier, wolny czas, zero złotych", na
  którym ShipScope działał dotychczas.
- **To nie jest szybsze do zbudowania niż obecny system.** Jest szybsze do *rozszerzania* po zbudowaniu
  (każda nowa funkcja staje się zwykłą zmianą CRUD/API zamiast starannego skryptu scalania JSON z
  idempotencją i własnymi warunkami wyścigu do przemyślenia), i jest szybsze w *dotarciu do real-time* niż
  jakiekolwiek pollowanie — ale dotarcie do tego stanu od zera zajmuje realne tygodnie, nie godziny, które
  dzisiaj zajmuje nowy skrypt synchronizacji.

## Co to daje, konkretnie

- **Real-time, nie eventual.** Deployment albo przełączenie flagi dociera do dashboardu w czasie,
  w jakim webhook dociera i przeglądarka odbiera komunikat push — bez crona, bez wskaźnika nieświeżości
  „Ostatnia synchronizacja: <data>", bez najgorszego przypadku do 24 godzin.
- **Brak zmiany CI per serwis, nigdy, dla onboardingu** — faktyczny cel wyrażony w
  `INTEGRATION-VISION.md`, w pełni zrealizowany, nie przybliżony.
- **Realna odpowiedź na pytanie o izolację wielu zespołów**, zamiast binarnego ograniczenia
  wszystko-publiczne-albo-wszystko-prywatne GitHub Pages.
- **Filtrowanie i paginacja po stronie serwera** zamiast pobierania ciągle rosnącego pliku JSON na każdy
  widok, niezależnie od tego, jak bardzo `docs/data/` miałby inaczej narosnąć.
- **Baza danych wymusza niezmienniki, które skrypt dotąd musiał bronić ręcznie** — przypadek kolizji
  tego samego klucza między komponentami, reguły zgodności shardów PI, księgowość kursora/retencji — to
  wszystko zwija się w zwykłe ograniczenia schematu i zapytania.

## Rozważone i odrzucone alternatywy

- **Zostawić statyczny JSON na gicie, dodać tylko warstwę push na żywo na wierzchu** (np. listener
  webhooka z `DEPLOYMENT-WEBHOOK-PROPOSAL.md`, wciąż commitujący do `live`, plus mały relay SSE
  obserwujący branch na nowe commity). Odrzucone jako stan docelowy dla tej hipotezy konkretnie dlatego,
  że zachowuje każdy element podpórki git-jako-baza-danych (powtarzanie przy przegranym push, pliki
  kursora, przycinanie retencyjne, reguły zgodności shardów PI) *dodatkowo do* nowego serwera — płacąc
  koszt operacyjny serwera bez zrzucenia złożoności, która istniała tylko, żeby obejść jego brak. To
  pozostaje właściwym wyborem pod obecnymi, rzeczywistymi ograniczeniami (zobacz analizę Części 1 w
  ramach ograniczeń); przestaje być właściwym wyborem, gdy serwer w ogóle jest na stole.
- **Baza dokumentowa (np. DynamoDB/Mongo) zamiast Postgresa.** Odrzucone: dane ShipScope są faktycznie
  relacyjne (komponenty, deploymenty, zgłoszenia, flagi, środowiska odwołują się wzajemnie, a istniejące
  łączenia w `docs/app.js` to już dokładnie relacyjne join'y) — baza dokumentowa oznaczałaby reimplementację
  join'ów w kodzie aplikacji, który relacyjna baza danych już robi dobrze, bez żadnej korzyści w skali
  ShipScope.
- **Pełne przepisanie frontendu na framework (React/Angular itd.).** Odrzucone: żadna z faktycznych
  złożoności w `docs/app.js` nie jest problemem zarządzania stanem czy reużywalności komponentów, który
  rozwiązuje framework; to logika domenowa (rozstrzyganie statusu wydania, wykrywanie dryfu/rollbacku,
  grupowanie PI), która czyta się tak samo niezależnie od podejścia. Przepisanie kosztowałoby realny czas
  i ryzykowałoby realne regresje w już poprawnej, już starannie zrecenzowanej logice, dla korzyści, której
  ten dokument nie może zidentyfikować.
- **Funkcje bezserwerowe dla wszystkiego, bez trwałego kontenera.** Rozważone poważnie, bo zmniejszyłoby
  to dalej koszt bezczynności — odrzucone tylko jako domyślna rekomendacja, nie wykluczone: długotrwałe
  połączenie SSE do pushu na żywo nie wpisuje się dobrze w klasyczną funkcję bezserwerową o zakresie
  żądania na każdej platformie, a mały, zawsze-włączony kontener jest wystarczająco prosty w skali
  ShipScope, że dalsza optymalizacja kosztu bezczynności nie jest warta dodanej złożoności platformy.
  Warto to zrewidować, jeśli ktokolwiek ostatecznie będzie właścicielem tego komponentu już standaryzuje
  się na platformie bezserwerowej dobrze obsługującej długotrwałe połączenia.

## Pytania otwarte, których ten dokument nie rozstrzyga

- Kto byłby właścicielem, operatorem i osobą na dyżurze dla tego serwisu — to samo pytanie otwarte, które
  `DEPLOYMENT-WEBHOOK-PROPOSAL.md` już podniósł tylko dla listenera, teraz przeskalowane na pełny backend.
- Czy biznes jest skłonny zmigrować każdy serwis na wspólnego dostawcę feature flag, czy ten projekt
  powinien raczej wsparcie ingestii push z tylu mechanizmów flag, ile zespoły już faktycznie używają —
  tabela źródeł flag w `ARCHITECTURE-NOTES.md` już przedstawia ten kompromis i ten dokument nie musi go
  rozstrzygać na nowo.
- Czy wspólna widoczność między zespołami pozostaje pożądana, gdy realna izolacja staje się technicznie
  możliwa — pytanie otwarte już postawione w `ARCHITECTURE-NOTES.md`, teraz faktycznie odpowiadalne, nie
  zamknięte przez model wszystko-albo-nic GitHub Pages.
- Konkretny wybór platformy (jaka platforma kontenerowa, jaki zarządzany Postgres, jaki dostawca OIDC) —
  celowo pozostawiony temu, kto faktycznie będzie właścicielem tej decyzji, bo „użyj tego, co organizacja
  już operuje" ma tu większe znaczenie niż jakakolwiek konkretna nazwa dostawcy, którą ten dokument mógłby
  wybrać.
