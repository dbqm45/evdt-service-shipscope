# Dodawanie nowego komponentu

*English version (default): [ONBOARDING.md](ONBOARDING.md)*

Niniejszy dokument stanowi praktyczną checklistę czynności niezbędnych do tego, aby nowe repozytorium
aplikacji (komponent) zaczęło być wyświetlane w ShipScope. Wyjaśnienie mechaniki działania (dlaczego
poszczególne kroki zostały tak podzielone, model gałęzi `main`/`live`) znajduje się w dokumencie
`CLAUDE.md` — niniejszy dokument opisuje wyłącznie kolejność wymaganych czynności.

## Przed rozpoczęciem

Należy znać lub ustalić:

- Dokładną nazwę repozytorium danego komponentu na GitHubie (np. `evapl-service-frontend`). Nazwa ta jest
  wykorzystywana jednocześnie jako etykieta `component` oraz jako nazwa repozytorium, z którego pobierane są
  dane — nie istnieje osobna nazwa wyświetlana.
- Czy komponent wykonuje wdrożenia za pośrednictwem GitHub Deployments (tworzy obiekt GitHub Deployment
  wraz ze statusem deploymentu dla danego środowiska przy każdym wdrożeniu na `test`/`qa`/`prod`). ShipScope
  odczytuje historię deploymentów wyłącznie z GitHub Deployments API (`sync-github-deployments.js`) — jeżeli
  pipeline wdrożeniowy repozytorium tego dotychczas nie robi, należy to najpierw naprawić w pipeline
  aplikacji; żaden mechanizm w niniejszym repozytorium nie jest w stanie tego zastąpić.
- Czy komponent posiada flagi typu build-time (generowane pliki `*.generated.ts`, katalogi `flag-parts/`)
  — od tego zależy, czy wymagany jest opisany poniżej krok związany z `check-flags.yml`.

## 1. Dodanie komponentu do `docs/components.json` (niniejsze repozytorium)

Należy dodać wpis do tablicy `components` w pliku `docs/components.json`:

```json
{ "name": "nazwa-repo", "description": "Co robi ten komponent.", "serviceType": null, "featureFlagsIncluded": null, "application": null }
```

`name` to jedyne pole, po którym cokolwiek po stronie serwera się kieruje — `description` (tooltip przy
nazwie komponentu) i `featureFlagsIncluded` (jawne `false` renderuje ikonkę „flagi jeszcze nie śledzone” przy
nazwie — zostaw `null`, dopóki faktycznie nie wiesz jednego albo drugiego) są opcjonalne, ale warto je
wypełnić. `serviceType` jest zarezerwowane na przyszłość — zostaw `null`. `application` (tablica stringów,
np. `["EBO"]`) grupuje ten komponent z innymi, które składają się na tę samą biznesową aplikację, na
potrzeby zakładki Release Notes — zostaw `null`, dopóki nie znasz właściwego grupowania; komponent bez tego
pola po prostu pojawia się pod własną nazwą, a nie jest pomijany. To jedyne źródło prawdy — plik ten
odczytują po stronie serwera `orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml` oraz
`notify-deployment.yml` (po `name`), a po stronie klienta `docs/app.js`, w tym samym celu plus tooltip i
ikonka śledzenia flag (patrz `CLAUDE.md`, sekcja „Tracked components”). Jest to **jedyny** plik w
repozytorium `evdt-service-shipscope`, który wymaga edycji.

Należy otworzyć pull request do `main`. Po jego zmergowaniu workflow `sync-main-to-live.yml` automatycznie
zmerguje `main` do `live` (uruchamia się przy każdym pushu do `main` dotykającym `scripts/**`, `docs/**` lub
`.github/workflows/**` — gałąź `main` nie serwuje działającego dashboardu, robi to gałąź `live`). Wszystko
poniżej odczytuje `docs/components.json` z gałęzi `live`, dlatego ten merge musi nastąpić, zanim nazwa
nowego komponentu zostanie gdziekolwiek rozpoznana.

## 2. Przyznanie dostępu do repozytorium aplikacjom GitHub Apps

Zaangażowane są dwa osobne poświadczenia (credentials), z których każde musi mieć widoczność nowego
repozytorium:

- **`CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID` / `CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY`** — wykorzystywane
  przez `orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml` oraz `retrigger-app-checks.yml`
  (poprzez `actions/create-github-app-token@v3`, `repositories: ${{ matrix.repo }}`) do wygenerowania
  tokena ograniczonego do nowego repozytorium. Jeżeli aplikacja GitHub App odpowiadająca tym sekretom nie
  jest zainstalowana na nowym repozytorium, każdy krok synchronizacji lub backfillu dla tego komponentu
  zakończy się błędem dostępu. Należy to skonfigurować w ustawieniach GitHuba: Organization settings →
  GitHub Apps → odpowiednia aplikacja → Configure → dodać nowe repozytorium do listy dostępu.
- **`SHIPSCOPE_APP_ID` / `SHIPSCOPE_APP_PRIVATE_KEY`** — wykorzystywane wewnątrz reużywalnego workflowa
  `notify-deployment.yml` (wywoływanego z repozytorium nowego komponentu) do wygenerowania tokena
  ograniczonego do repozytorium `evdt-service-shipscope`, umożliwiającego wywołanie zwrotne
  `repository_dispatch`. Sekrety te są przekazywane jako `secrets:` do tego reużywalnego workflowa —
  jeżeli są to sekrety organizacyjne widoczne dla wszystkich repozytoriów („All repositories”), nie jest
  wymagane żadne dodatkowe działanie; jeżeli natomiast są ograniczone do wybranej listy repozytoriów,
  należy dodać do niej nowe repozytorium.

## 3. Konfiguracja repozytorium nowego komponentu

W repozytorium nowego komponentu należy dodać kroki workflowa dotyczące:

- **Szybszej synchronizacji** — wywołania reużywalnego workflowa `notify-deployment.yml`
  (`component: <nazwa-repozytorium>`) bezpośrednio po udanym wdrożeniu, z przekazaniem sekretów
  `SHIPSCOPE_APP_ID`/`SHIPSCOPE_APP_PRIVATE_KEY`. Bez tego kroku nowy komponent będzie nadal
  synchronizowany, jednak wyłącznie przez codzienny mechanizm awaryjny (cron o godzinie 3:00) w
  `orchestrate-full-sync.yml`, a nie bezpośrednio po każdym wdrożeniu.
- **Flag typu build-time, o ile dotyczy** — dodania workflowa wywołującego reużywalny `check-flags.yml`
  (`workflow_call`) z tego repozytorium, analogicznie do rozwiązania zastosowanego w
  `evapl-service-frontend`. Punkt ten należy pominąć, jeżeli komponent nie posiada flag typu build-time
  (np. jest serwisem backendowym lub repozytorium infrastrukturalnym).

## 4. Weryfikacja `retrigger-app-checks.yml` w przypadku flag build-time

Workflow `retrigger-app-checks.yml` (ponownie uruchamia nieudane przebiegi `check-flags` w repozytoriach
aplikacji po zmianie `flags-meta.json` na gałęzi `live`) jest obecnie zdefiniowany wyłącznie dla
repozytorium `evapl-service-frontend` — **nie** stanowi matrycy opartej na `docs/components.json`.
Jeżeli nowy komponent posiada flagi typu build-time, workflow ten należy rozbudować (o matrycę lub
dodatkowy job), w przeciwnym razie ponowne uruchomienia następujące po uzupełnieniu metadanych nigdy nie
dotrą do nowego komponentu, bez żadnego komunikatu o błędzie.

## 5. Backfill historycznych deploymentów (opcjonalnie)

Gdy dla nowego komponentu zaczną napływać rzeczywiste deploymenty, w przypadku istnienia historii
deploymentów wartej uzupełnienia należy ręcznie uruchomić workflow `backfill-deployment-metadata.yml`
(`workflow_dispatch`). Uzupełnia on pola `workflowRunUrl`/`durationMs`/`manual`/`rollback`/zakres
`commitUrl`/rozwiązaną nazwę wyświetlaną `deployedBy`/ponownie rozwiązaną wartość `version` dla rekordów
utworzonych przed wprowadzeniem tych pól. Liczba przetwarzanych rekordów jest ograniczona per uruchomienie
(`MAX_RECORDS_PER_RUN`), a sam workflow jest bezpieczny do wielokrotnego uruchamiania.

## Elementy niewymagające modyfikacji

- **`scripts/*.js`** — każdy skrypt synchronizacji lub backfillu jest już niezależny od konkretnego
  komponentu — jest w pełni sterowany zmiennymi środowiskowymi `COMPONENT`/`APP_REPO` ustawianymi przez
  workflow.
- **`docs/app.js` / `docs/index.html`** — lista komponentów, listy rozwijane filtrów oraz wykrywanie
  projektów Jira są wyliczane dynamicznie na podstawie `docs/data/deployments.json` w momencie
  renderowania. Kolejność wierszy w Technical view już teraz automatycznie idzie za `docs/components.json`
  (pobieranym po stronie klienta) — nic dodatkowego nie trzeba tu edytować.
- **Integracja z Jirą** — `sync-jira.js` samodzielnie wykrywa, które klucze projektów Jira należy pobrać,
  na podstawie wartości `relatedIssues` już obecnych w `deployments.json` — nie jest więc wymagana żadna
  konfiguracja dla poszczególnych komponentów, o ile komunikaty commitów nowego komponentu odwołują się do
  kluczy Jira w standardowym formacie `XXX-123`.