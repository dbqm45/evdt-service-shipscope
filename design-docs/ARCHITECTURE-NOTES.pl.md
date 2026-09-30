# Notatki architektoniczne — wsparcie wielozespołowe i wielotenantowe w ShipScope

*English version: [ARCHITECTURE-NOTES.md](ARCHITECTURE-NOTES.md)*

> **Status: rozpoznanie, nie decyzja.** Ten dokument zapisuje rozważania, ustalenia i rozważane opcje
> dotyczące tego, jak ShipScope mógłby stać się łatwy do wdrożenia dla wielu niezależnych zespołów i
> serwisów. Nic z tego nie zostało zaimplementowane. Dokument ma stanowić materiał wyjściowy do
> ewentualnego Architecture Decision Record, nie samą decyzję — pole gry zostało zmapowane, ale nic tu nie
> zostało rozstrzygnięte.

## Punkt wyjścia

ShipScope śledzi obecnie trzy z góry znane komponenty (`evapl-service-frontend`,
`evnm-service-charger-infrastructure`, `evboweb-service-bff`), z nazwami repozytoriów i konfiguracją flag
wpisanymi na sztywno w kilku miejscach: `.github/workflows/orchestrate-full-sync.yml`,
`sync-runtime-be-flags.yml` oraz `retrigger-app-checks.yml`.

Cel: każdy zespół posiadający deploymenty i/lub flagi — albo nieposiadający flag w ogóle — powinien móc
połączyć się z ShipScope minimalnym nakładem pracy, zachowując możliwie dużą niezależność od tego, jak inne
zespoły zarządzają swoimi deploymentami i flagami, bez konieczności zmiany centralnego repozytorium ShipScope
za każdy nowy przypadek.

## Co już działa dobrze

Ta sekcja jest istotna, bo zawęża zakres do faktycznie brakujących elementów, a nie sugeruje potrzeby
przebudowy wszystkiego.

- **Flagi build-time są już w pełni zdecentralizowane.** `check-flags.yml` jest reużywalnym workflowem
  (`workflow_call`); zespół dodaje u siebie mały workflow wołający go z własnymi parametrami
  (`FLAGS_SEARCH_ROOT`, `COMPONENT`). ShipScope nie musi wiedzieć z góry, że dany zespół istnieje.
- **Deploymenty mają już mechanizm push.** `orchestrate-full-sync.yml` reaguje na
  `repository_dispatch: deployment-completed` z payloadem `client_payload.component` wysyłanym przez CI
  danego zespołu. To nie jest odpytywanie — zgłaszający zespół sam decyduje, kiedy zgłosić deployment.
- **Pojedyncza aktualizacja flagi ma już mechanizm push.** `update-flag-state.yml` reaguje na
  `repository_dispatch: flag-changed` z payloadem `{FLAG_KEY, ENVIRONMENT, ENABLED, CHANGED_BY}`. Działa to
  już dziś, bez potrzeby nowego kodu, o ile dany zespół jest w stanie wywołać ten dispatch ze swojej strony.
- **Brak danych o flagach nie powoduje błędów.** `effectiveFlagState()` w `app.js` zwraca `null`, gdy nie ma
  wpisu dla danego źródła i środowiska, a interfejs renderuje to jako myślnik, nie błąd. Podobnie pusty
  `flags-meta.json` wyświetla „No flags defined”, nie wyjątek. Komponent bez żadnych flag nigdy nie jest
  blokowany w Product view — issue bez podpiętej flagi przechodzi prosto do statusu „Released” po deployu.
- **Odkrywanie issue z Jiry jest już dynamiczne.** `sync-jira.js` wyprowadza dokładnie, jakie issue
  odpytać, na podstawie kluczy znalezionych w komunikatach commitów już zsynchronizowanych deploymentów
  (`deriveIssueKeysFromDeployments`), nie na podstawie listy statycznej — i ogranicza wyszukiwanie do tych
  konkretnych issue, nie do całych projektów, do których akurat należą. To istniejący przykład
  wyprowadzania konfiguracji z danych, zamiast wpisywania jej na sztywno.

## Co faktycznie brakuje

1. **Harmonogram bezpieczeństwa w `orchestrate-full-sync.yml` i `sync-runtime-be-flags.yml`** sprawdza
   tylko z góry wymienioną listę komponentów; nowy zespół nie jest nią objęty, dopóki plik YAML nie zostanie
   zmieniony.
2. **`sync-runtime-be-flags.js` działa tylko w modelu pull** — adres znany z góry, zapisany jako wpis
   `vars` w repozytorium ShipScope. Onboarding nowego zespołu wymaga, aby administrator dodał adres tego
   zespołu. Nie istnieje dziś żaden adapter dla innych narzędzi, takich jak LaunchDarkly, Unleash, AWS
   AppConfig czy Bedrock.
3. **`retrigger-app-checks.yml`** ma zakres tokena ograniczony do jednego konkretnego repozytorium
   (`evapl-service-frontend`) i nie zadziała dla innych bez modyfikacji.
4. **Dashboard jest jedną statyczną stroną pod jednym adresem**, bez ścieżki lub izolacji per zespół; patrz
   sekcja o GitHub Pages poniżej.

## Rozważane opcje — deploymenty i harmonogram bezpieczeństwa

| Opcja | Mechanizm | Zalety | Wady |
|---|---|---|---|
| **A. Pozostanie przy hardkodowanej liście** | Stan obecny. | Brak nakładu pracy. | Każdy nowy zespół wymaga pull requestu do ShipScope. |
| **B. Centralny plik konfiguracyjny** (np. `shipscope.config.json`) | Zadanie `prepare` odczytuje plik z listą komponentów i repozytoriów, budując matrix dynamicznie — zastępując dzisiejszą hardkodowaną instrukcję bash `case` tą samą logiką, tylko czytaną z pliku. | Mały, niskoryzykowny krok. Pull request wciąż jest wymagany, ale ograniczony do jednego pliku, nie kilku plików YAML. | Wciąż wymaga pull requestu do repozytorium ShipScope za każdy nowy zespół; nie daje pełnej niezależności. |
| **C. Odkrywanie przez tematy (topics) GitHub** | Harmonogram odpytuje GitHub API o repozytoria w organizacji oznaczone tematem `shipscope-tracked`, zamiast czytać listę z pliku. | Zespół dokonuje onboardingu samodzielnie, dodając temat w ustawieniach własnego repozytorium, bez pull requestu do ShipScope. Harmonogram bezpieczeństwa automatycznie obejmuje nowe zespoły. | Wymaga uprawnień do przeszukiwania repozytoriów w organizacji (token z odpowiednim zakresem). Nie rozstrzyga samodzielnie, jak skonfigurować flagi dla nowo odkrytego repozytorium — to pozostaje osobną decyzją. |

**Wstępny wniosek**: opcja C wydaje się najbliższa celowi niezależności zespołów i jest relatywnie małą
zmianą, ponieważ główny sygnał push już istnieje. Opcja B jest bezpieczniejszym, mniej ambitnym pierwszym
krokiem, jeśli opcja C stanowi zbyt duży skok na początek.

## Rozważane opcje — źródła flag (LaunchDarkly, Unleash, Bedrock lub inne)

| Opcja | Mechanizm | Zalety | Wady |
|---|---|---|---|
| **Push, inicjowany przez zespół-właściciela** | Zespół-właściciel prowadzi u siebie mały relay: webhook z jego narzędzia wywołuje funkcję lub zadanie zaplanowane, które wywołuje `repository_dispatch: flag-changed` na ShipScope. | Sekret lub API key narzędzia nigdy nie trafia do repozytorium ShipScope. Działa już dziś, bez potrzeby nowego kodu w ShipScope. Maksymalizuje niezależność zespołu. | Zespół-właściciel musi hostować i utrzymywać coś, choćby niewielkiego. Wymaga jednorazowego nadania tokena z prawem dispatcha do repozytorium ShipScope — czynności administracyjnej, nie zmiany kodu. |
| **Pull, jeden adapter per typ narzędzia** | ShipScope utrzymuje skrypt taki jak `sync-launchdarkly-flags.js` albo `sync-unleash-flags.js`, normalizujący odpowiedź API danego narzędzia do wspólnego kształtu `flagStates[key][env][source]`. Napisany raz per typ narzędzia, używany przez wszystkie zespoły korzystające z tego narzędzia. | Brak nakładu pracy dla zespołu-właściciela poza podaniem adresu lub API key. | ShipScope musi przechowywać sekrety dla kont wielu zespołów w wielu narzędziach, zwiększając swoją odpowiedzialność i ryzyko, a zmniejszając niezależność zespołów. Adapter musi zostać napisany, jeśli narzędzie nie jest jeszcze obsługiwane. |
| **Hybryda** | Zespół-właściciel pisze własny skrypt zgodny z tym samym kontraktem wyjściowym co `sync-runtime-be-flags.js`, hostuje go samodzielnie i wysyła do ShipScope już znormalizowany payload. | Łączy zalety obu podejść: sekrety pozostają u zespołu-właściciela, a nikt nie musi czekać, aż ShipScope zbuduje adapter dla konkretnego narzędzia. | Wymaga od zespołu-właściciela zrozumienia kształtu danych oczekiwanego przez ShipScope, co stanowi nieco większe wymaganie niż samo skonfigurowanie webhooka. |

**Wstępny wniosek**: model push, albo jego wariant hybrydowy, jest strukturalnie bliższy celowi niezależności
zespołów, ponieważ ShipScope nigdy nie przechowuje odpowiednich sekretów. Adaptery pull mają sens głównie
jako wygoda dla zespołów niemogących lub niechcących utrzymywać nawet niewielkiego relaya i powinny być
rozpatrywane indywidualnie, nie jako domyślna ścieżka.

**To, gdzie zadeklarować źródło, nie jest trudną częścią tego problemu.** Można by bez trudu zapisać per
komponent — np. w `docs/components.json`, obok wpisów dodawanych przy onboardingu nowego komponentu
(patrz `ONBOARDING.pl.md`) — jaki mechanizm flag dany komponent wykorzystuje (`build`, `runtime-be`, a w
przyszłości może nazwany dostawca zewnętrzny) oraz nieautoryzacyjne wskaźniki, takie jak bazowy URL czy
identyfikator projektu. To niczym się nie różni od tego, co jest tam przechowywane już dziś, i nie jest
bardziej wrażliwe: nic tajnego nigdy nie miało prawa znaleźć się w tym pliku, dzisiejsze wartości
`COMPONENT`/`APP_REPO` też nie są sekretami. Decyzja, o której właściwie mówi ta tabela, dotyczy zupełnie
innej kwestii: **kto ostatecznie staje się opiekunem poświadczenia (credentiala), którego wymaga dane
źródło.** Pole ze źródłem wymusza tę decyzję tylko wtedy, gdy implikuje pull — czyli gdy ShipScope musiałby
samodzielnie posiadać klucz/token API, żeby cyklicznie sięgać do tego źródła. To właśnie ono scala sekrety
wielu narzędzi wielu zespołów w jednym miejscu — we własnych GitHub Secrets ShipScope — i czyni ze ShipScope
stronę odpowiedzialną za poprawne ograniczenie zakresu i rotację poświadczeń, których nie jest właścicielem — to jest
faktyczna wada wskazana w wierszu adaptera pull powyżej, nie problem formatu przechowywania. Push i hybryda
unikają tego całkowicie, bo poświadczenie dostępu do źródła nigdy nie musi istnieć wewnątrz ShipScope w
pierwszej kolejności — wpis w `components.json` dla tych wariantów jedynie dokumentuje, skąd przychodzi
push, a nie jak samodzielnie sięgnąć i pobrać dane.

**Konkretny przypadek, który się pojawił: flagi oparte na zmiennych środowiskowych Springa
(`evsim-service-sim-adapter`).** Niektóre komponenty definiują flagi jako placeholdery Springa
`${ENV_VAR:default}` w `application.yml` — plik w repozytorium pokazuje tylko *wartość domyślną*, bo
realna wartość może być nadpisana per środowisko przez faktyczną zmienną środowiskową. Żywą wartość widać
wyłącznie przez endpointy Spring Boot Actuatora tej aplikacji: `/actuator/env/{name}` (jedna właściwość na
raz, owinięta w metadane, wartość zwykle jako string, nie jako JSON boolean) albo `/actuator/configprops`
(całe drzewo konfiguracji, zagnieżdżone per bean `@ConfigurationProperties`, nie płaska mapa). Żaden z tych
kształtów nie pasuje do tego, co `sync-runtime-be-flags.js` już potrafi skonsumować — skrypt oczekuje
jednego płaskiego obiektu JSON na najwyższym poziomie, `{ flagKey: true|false, ... }` (`filterBooleanFlags`)
— więc skierowanie go na którykolwiek z endpointów Actuatora wymagałoby nowej logiki parsującej plus
utrzymywanego mapowania każdego klucza flagi na jego ścieżkę property w Springu, a do tego jeszcze
credentiala, którego wymaga `SecurityConfiguration` tego konkretnego endpointu (nowy, choć wąsko
zakresowany, sekret — dzisiejsze `fetchEnvFlags` nie wysyła żadnej autoryzacji). Ujawniałoby to też znacznie
więcej niż stan flag: `/actuator/env` i `/actuator/configprops` zrzucają całe rozwiązane drzewo konfiguracji
serwisu, nie tylko tę garstkę właściwości, które akurat są feature flagami. Tańsza i mniej eksponująca
alternatywa — zgodna z preferencją push/hybrid opisaną powyżej — to poprosić zespół-właściciela o
wystawienie jednego małego, dedykowanego endpointu zwracającego dokładnie ten płaski kształt, którego
`sync-runtime-be-flags.js` już oczekuje, ponownie wykorzystując ten skrypt bez zmian, zamiast uczyć
ShipScope sięgać do ogólnej powierzchni introspekcji konfiguracji.

## GitHub Pages — jeden adres, brak izolacji per zespół

To jest ograniczenie architektoniczne, nie coś konfigurowalne bez istotnie większej przebudowy.

- GitHub Pages serwuje jedną statyczną witrynę z jednego brancha (`live`), pod jednym adresem. Nie istnieje
  ścieżka per zespół, taka jak `/zespol-1` albo `/zespol-2`; nic takiego nie funkcjonuje w tym modelu.
- Pliki pod `docs/data/*.json` łączą dane wszystkich komponentów, flag i Jiry w pojedyncze pliki, pobierane w
  całości przez każdego odwiedzającego stronę.
- Filtry interfejsu dla środowiska i komponentu są czysto kosmetycznymi udogodnieniami po stronie klienta:
  pokazują lub chowają wiersze w ramach tego samego zbioru danych. Nie tworzą osobnych adresów i nie
  ograniczają dostępu. Bazowe pliki JSON pozostają publicznie dostępne niezależnie od zastosowanych filtrów.

### Rozważane opcje

| Opcja | Co zapewnia | Czego nie zapewnia |
|---|---|---|
| **Stan filtrów odzwierciedlony w adresie URL** (`?component=X&env=Y`) | Link możliwy do zapisania w zakładkach albo przekazania dalej, otwierający bezpośrednio konkretny widok. Mały, niskoryzykowny dodatek do tego, co już istnieje. | Realnej izolacji. Dane pozostają publicznie dostępne pod tym samym adresem i w tych samych plikach, niezależnie od użytych parametrów URL. |
| **Prawdziwa izolacja (osobne instancje per zespół)** | Rzeczywiste rozdzielenie danych, takie, że jeden zespół nie ma fizycznego dostępu do danych innego zespołu. | GitHub Pages nie wspiera częściowej kontroli dostępu per ścieżka; witryna jest albo w całości publiczna, albo w całości prywatna, za autoryzacją GitHuba. Ta opcja wymaga osobnych repozytoriów i wdrożeń Pages per zespół — istotnie większego przedsięwzięcia obejmującego rzeczywistą wielotenantowość, z rozdzieleniem danych, sekretów i uprawnień. |

**Otwarte pytanie, obecnie nierozstrzygnięte**: czy współdzielona widoczność między zespołami jest cechą
tego rozwiązania, biorąc pod uwagę, że łączenie sygnałów między repozytoriami jest zadeklarowanym celem
ShipScope zgodnie z README, czy problemem dla konkretnego przypadku wielu niezależnych zespołów? Zależy to od
tego, czy komponenty lub aplikacje mające się połączyć są od siebie biznesowo niezależne na tyle, że
połączenie ich danych w jednym widoku przestaje mieć sens. Zostało to zidentyfikowane jako pytanie do
rozstrzygnięcia, nie jako ustalona sprawa.

## Podsumowanie — zmiany uznane za niskiego ryzyka

Poniższe zmiany wydają się warte wprowadzenia niezależnie od tego, jak ostatecznie zostanie rozstrzygnięta
kwestia izolacji:

- Odkrywanie komponentów przez tematy GitHub dla harmonogramu bezpieczeństwa, usuwające ostatni hardkodowany
  element po stronie deploymentów.
- Dokumentowanie i preferowanie modelu push (`repository_dispatch: flag-changed`) jako domyślnej ścieżki dla
  nowych integracji flagowych, z adapterami pull traktowanymi jako wyjątek, nie norma.
- Odzwierciedlenie stanu filtrów w adresie URL, jako udogodnienie, nie środek bezpieczeństwa, niezależnie od
  decyzji dotyczącej izolacji.

## Otwarte pytania do rozstrzygnięcia przed napisaniem ADR

1. Czy współdzielona widoczność między zespołami jest akceptowalna, czy wymagana jest rzeczywista izolacja?
   Patrz sekcja o GitHub Pages.
2. Jakie konkretne narzędzia flagowe muszą być wsparte od początku — LaunchDarkly, Unleash, Bedrock, jakiś
   system wewnętrzny czy inne? To rozstrzyga, czy pisanie adapterów pull jest warte nakładu pracy, czy
   należy w pełni postawić na model push.
3. Kto administruje nadawaniem tokenów i uprawnień dispatch dla nowych zespołów, i jaki powinien być ten
   proces — samoobsługowy formularz czy ręczne żądanie do administratora?
4. Czy w pełni reużywalne, wielotenantowe wsparcie workflowów (opcja B w dyskusji o deploymentach) znajduje
   się w ogóle na horyzoncie, czy ShipScope pozostaje modelem jedna-instancja-per-organizacja?