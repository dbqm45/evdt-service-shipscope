# Dodawanie nowego komponentu

*English version (default): [ONBOARDING.md](ONBOARDING.md)*

Niniejszy dokument stanowi praktyczną checklistę czynności niezbędnych do tego, aby nowe repozytorium
aplikacji (komponent) zaczęło być wyświetlane w ShipScope. Wyjaśnienie mechaniki działania (dlaczego
poszczególne kroki zostały tak podzielone, model gałęzi `main`/`live`) znajduje się w dokumencie
`CLAUDE.md` — niniejszy dokument opisuje wyłącznie kolejność wymaganych czynności.

## 0. Wymagania wstępne na poziomie ShipScope (jednorazowo, nie per komponent)

Wszystko poniżej (punkty 1–5) zakłada, że ShipScope jest już skonfigurowany i działa. Poniżej opisane są
konta, poświadczenia i uprawnienia, które sprawiają, że cała maszyneria synchronizacji działa w ogóle —
konfigurowane jednorazowo, centralnie, nie dla każdego nowego komponentu z osobna. Jeśli czegokolwiek z
tego brakuje, żaden onboarding pojedynczego komponentu opisany poniżej nie wyprodukuje żadnych danych — to
jest checklista do uruchomienia zupełnie nowej instancji ShipScope, albo do diagnozowania sytuacji „nic się
nie synchronizuje dla *żadnego* komponentu”.

**GitHub — dwie osobne aplikacje GitHub Apps, każda do innego zadania:**

- **Aplikacja synchronizująca** — sekrety `CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID`/
  `CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY`, przechowywane w repozytorium `evdt-service-shipscope`.
  Zarejestrowana na poziomie organizacji i **zainstalowana na każdym monitorowanym repozytorium aplikacji**
  (Organization settings → GitHub Apps → aplikacja → Configure → repository access). Potrzebuje odczytu
  **Deployments** danego repozytorium (wywołania `/deployments`/`/deployments/{id}/statuses` w
  `sync-github-deployments.js`), **Contents** (`/compare`, `/commits`, `/tags`, `/releases` — rozwiązywanie
  wersji/rollbacku/driftu) oraz **Actions** (lookup przebiegu workflowa w `resolveManualFlag`, oraz
  listowanie i ponowne uruchamianie nieudanych przebiegów w `retrigger-app-checks.js` — to drugie wymaga
  dodatkowo zapisu w Actions, nie tylko odczytu). Wykorzystywana przez `orchestrate-full-sync.yml`,
  `backfill-deployment-metadata.yml`, `retrigger-app-checks.yml`. Bez zainstalowania tej aplikacji na danym
  repozytorium każdy krok synchronizacji/backfillu dla niego zakończy się błędem dostępu — to najczęstsza
  pojedyncza przyczyna „czemu nic się nie pojawia dla repozytorium X”.
- **Aplikacja pisząca do ShipScope** — sekrety `SHIPSCOPE_APP_ID`/`SHIPSCOPE_APP_PRIVATE_KEY`.
  Zainstalowana na samym `evdt-service-shipscope`, z odczytem i zapisem do jego **Contents** — potrzebnym
  zarówno do wypychania commitów na `live` z przebiegu workflowa *wywołującego* repozytorium
  (`check-flags.yml`), jak i do odebrania `repository_dispatch` wystrzelonego w to repozytorium
  (`notify-deployment.yml`, oraz jakiekolwiek poświadczenie, którym backendowy serwis flag wystrzeliwuje
  `flags-updated`/`flag-changed`). W przeciwieństwie do aplikacji synchronizującej, poświadczenia tej
  aplikacji muszą dodatkowo istnieć jako sekret *na każdym monitorowanym repozytorium* (przekazywany, gdy
  to repozytorium wywołuje reużywalny `notify-deployment.yml`/`check-flags.yml`) — to własny workflow
  każdego monitorowanego repozytorium generuje token ograniczony z powrotem do
  `evdt-service-shipscope`, więc jest to jedyny element tarcia, którego nie da się scentralizować (patrz
  `design-docs/INTEGRATION-VISION.md`).
- Własne workflowy `evdt-service-shipscope` (`sync-with-retry`, `sync-main-to-live.yml`,
  `update-flag-state.yml`, `sync-runtime-be-flags.yml`) deklarują `permissions: contents: write` i
  korzystają z domyślnego, automatycznego `GITHUB_TOKEN` — żadna aplikacja GitHub App nie jest potrzebna do
  niczego, co zostaje całkowicie wewnątrz tego jednego repozytorium (commitowanie do `live`, mergowanie
  `main` do `live`).
- Pipeline wdrożeniowy każdego monitorowanego komponentu musi tworzyć realny obiekt **GitHub Deployment +
  status deploymentu** dla każdego środowiska, na które wdraża (`test`/`qa`/`prod`). ShipScope odczytuje
  historię deploymentów **wyłącznie** przez GitHub Deployments API — nie istnieje żaden fallback dla
  pipeline'u, który ich nie tworzy; trzeba to najpierw naprawić we własnym pipeline tego repozytorium,
  zanim ShipScope będzie w stanie pokazać dla niego cokolwiek, niezależnie od tego, jak poprawnie
  skonfigurowano wszystko inne.

**Jira — jedno konto, tylko do odczytu:**

- **Konto Jira Cloud** z **tokenem API** (token API Atlassian, wygenerowany z ustawień Atlassian ID tego
  konta) — przechowywany jako sekrety repozytorium `JIRA_EMAIL`/`JIRA_API_TOKEN`, wysyłany jako HTTP Basic
  Auth, plus `JIRA_BASE_URL` dla samej instancji Atlassian. Wszystkie trzy są odczytywane przez
  `sync-jira.js` poprzez `orchestrate-full-sync.yml`/`backfill-jira-issues.yml`.
- To konto potrzebuje tylko uprawnienia **do odczytu („Browse projects”)** każdego projektu Jira, w którym
  ShipScope ma widzieć issue — każde wywołanie `sync-jira.js` (`/rest/api/3/search/jql`,
  `/rest/api/3/project/search`, `/rest/api/3/field`) jest odczytem. ShipScope nigdy nie zapisuje do Jiry,
  więc żadne uprawnienie do zapisu nie jest tam nigdy wymagane.
- Jeśli `docs/jira-spaces.json` konfiguruje `boards` dla danej przestrzeni (aby wyznaczać bieżący PI z
  aktywnego sprintu tablicy, zamiast korzystać z fallbacku — zwykłego wyszukiwania kluczy issue
  referencjonowanych przez deploymenty), to samo konto potrzebuje dodatkowo odczytu tych konkretnych tablic
  Jira Software/Agile (`/rest/agile/1.0/board`, `/rest/agile/1.0/board/{id}/sprint`).
  - **Diagnozowanie konkretnie błędu 401 tutaj**: jeśli wywołania board/sprint zwracają 401, a zwykłe
    wyszukiwanie projektów/issue (`project/search`, `search/jql`) działa z tymi samymi
    `JIRA_EMAIL`/`JIRA_API_TOKEN`, to znany wzorzec — patrz artykuł z bazy wiedzy Atlassiana
    ["401 Unauthorized error when service account accesses Jira or Confluence API"](https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/).
    Sprawdź, w tej kolejności: (a) czy konto to konkretnie **service account** Atlassiana (nie zwykłe konto
    człowieka ani bota) i, jeśli tak, czy jego token API jest tokenem **scoped**, który nigdy nie otrzymał
    osobnych zakresów Jira Software/Agile (np. `read:board-scope:jira-software`,
    `read:sprint:jira-software`) — token scoped działa tylko dla rodzin API wybranych jawnie przy jego
    tworzeniu, w przeciwieństwie do tokenu klasycznego; (b) czy konto rzeczywiście ma przypisaną **rolę
    produktową/licencję Jira Software** (Jira admin → Products), bo samo uprawnienie odczytu projektów nie
    daje tego automatycznie, a `/rest/agile/1.0/*` tego wymaga. Oba przypadki naprawia administrator Jiry po
    stronie Atlassiana — w kodzie tego repo nie trzeba zmieniać nic.

**Co to daje samo w sobie:** mając tylko powyższe skonfigurowane i pusty `docs/components.json`, dzienny
cron `orchestrate-full-sync.yml` już teraz uruchomi się z sukcesem (pusta macierz synchronizacji), a
synchronizacja Jiry przełączy się na swoją ścieżkę bez konfiguracji. Nic nie staje się jednak faktycznie
użyteczne, dopóki przynajmniej jeden komponent nie zostanie dodany — patrz punkty 1–5 poniżej.

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
pola po prostu pojawia się pod własną nazwą, a nie jest pomijany. `versionFile` (opcjonalne, np.
`"trigger.properties"`) jest potrzebne, gdy QA/PROD wdrażają się z branchy `deployment/*` zawierających tylko
commity-wyzwalacze (`version=v1.6.0`): bez niego drift porównuje te commity zamiast prawdziwego kodu i pokazuje
zawyżone liczby „N behind”. Pomiń je dla komponentów, które wdrażają sam commit z kodem. To jedyne źródło prawdy — plik ten
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

- **Szybszej synchronizacji** — dodania **jednego** pliku workflowa na **domyślnym branchu**
  repozytorium, `.github/workflows/notify-shipscope.yml`. Obserwuje on workflowy deploymentowe przez
  `workflow_run` i po każdym udanym wywołuje reużywalny `notify-deployment.yml`. Bez niego nowy komponent
  będzie nadal synchronizowany, jednak wyłącznie przez codzienny mechanizm awaryjny (cron o godzinie 3:00)
  w `orchestrate-full-sync.yml`, a nie bezpośrednio po każdym wdrożeniu.

  ```yaml
  name: Notify ShipScope

  on:
    workflow_run:
      # każda wartość musi być dokładnie równa `name:` workflowa deploymentowego (wielkość liter ma znaczenie)
      workflows: ["Test auto-deployment", "QA on-demand deployment", "Prod on-demand deployment"]
      types: [completed]

  permissions: {}

  jobs:
    notify_shipscope:
      name: Trigger ShipScope full sync
      # tylko udane przebiegi; żeby rejestrować też nieudane próby, użyj
      # conclusion != 'skipped' && conclusion != 'cancelled'
      if: github.event.workflow_run.conclusion == 'success'
      uses: circlek-global/evdt-service-shipscope/.github/workflows/notify-deployment.yml@v1.0.0
      with:
        component: ${{ github.event.repository.name }}
      secrets:
        SHIPSCOPE_APP_ID: ${{ secrets.CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID }}
        SHIPSCOPE_APP_PRIVATE_KEY: ${{ secrets.CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY }}
  ```

  Dlaczego osobny plik, a nie job `notify_shipscope` w każdym workflowie deploymentowym: GitHub czyta
  workflow z brancha, który go wywołał, więc deploy uruchomiony z długo żyjącego brancha, np.
  `deployment/qa` (podbicie `trigger.properties`), uruchamia kopię z tego brancha, w której nie ma kroku
  dodanego wyłącznie na `main` — i ShipScope nie dostaje sygnału. Workflowy `workflow_run` są czytane
  zawsze z domyślnego brancha, więc jeden plik tam obejmuje każdy branch i każde środowisko, bez
  utrzymywania czegokolwiek per branch. **Nie** zostawiaj dodatkowo joba `notify_shipscope` w workflowach
  deploymentowych (pozostawiony powoduje tylko zdublowany, nieszkodliwy dispatch).

  Uwagi: plik musi trafić na domyślny branch, zanim zacznie działać (nie da się go przetestować z brancha
  funkcjonalnego); `component` to nazwa własnego repozytorium, którą `notify-deployment.yml` dodatkowo
  sprawdza względem `docs/components.json` i repozytorium wywołującego; sekrety muszą być na poziomie
  repozytorium lub organizacji, nie sekretami environmentu (job nie deklaruje `environment:`). Zweryfikuj
  jednym prawdziwym deployem: w zakładce Actions powinien uruchomić się „Notify ShipScope”, a
  `orchestrate-full-sync.yml` powinien dostać dispatch. Zmiana nazwy workflowa deploymentowego po cichu
  przestaje pasować — wtedy zaktualizuj `workflows:`. Zob. `design-docs/DEPLOYMENT-WEBHOOK-PROPOSAL.pl.md`
  → „Alternatywa bez serwera”.
- **Flag typu build-time, o ile dotyczy** — dodania workflowa wywołującego reużywalny `check-flags.yml`
  (`workflow_call`) z tego repozytorium, analogicznie do rozwiązania zastosowanego w
  `evapl-service-frontend`. Punkt ten należy pominąć, jeżeli komponent nie posiada flag typu build-time
  (np. jest serwisem backendowym lub repozytorium infrastrukturalnym).

## 4. Jeśli ma flagi build-time: ustaw `featureFlagsIncluded: true` w `docs/components.json`

Workflow `retrigger-app-checks.yml` (ponownie uruchamia nieudane przebiegi `check-flags` w repozytoriach
aplikacji po zmianie `flags-meta.json` na gałęzi `live`) stanowi matrycę po wszystkich komponentach z
`docs/components.json`, dla których `featureFlagsIncluded: true` — nie wymaga edycji workflowa per
komponent. Dla każdego wpisu matrycy generuje też token GitHub App ograniczony do repozytorium tego
komponentu, więc wspólna aplikacja (`CIRCLEK_GLOBAL_GITHUB_EVDT_APP`) musi być faktycznie zainstalowana
również na nowym repozytorium, tak jak w przypadku każdego innego wywołania między repozytoriami opisanego
w tym dokumencie — samo ustawienie `featureFlagsIncluded` nie wystarczy, jeśli aplikacja nigdy tam nie
została zainstalowana.

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