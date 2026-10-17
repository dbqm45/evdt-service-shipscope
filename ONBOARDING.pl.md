# Wdrożenie

*English version: [ONBOARDING.md](ONBOARDING.md)*

Co zrobić, w jakiej kolejności, żeby dane trafiły do ShipScope. Część A dotyczy workspace'u na serwerze ShipScope;
część B — synchronizacji plikowej uruchamianej przez GitHub Actions. Jak to działa pod spodem, opisuje `CLAUDE.md`;
jak liczona jest każda wartość — `FAQ.pl.md`.

**Wymagane w obu przypadkach:** potok wdrożeniowy każdej aplikacji musi tworzyć prawdziwy **GitHub Deployment** ze
statusami dla każdego środowiska, na które wdraża (`test`/`qa`/`prod`). ShipScope czyta historię wdrożeń wyłącznie
przez GitHub Deployments API. W GitHub Actions job z `environment: test` (albo `qa`, `prod`) tworzy go przy każdym
uruchomieniu. Nazwy środowisk są dopasowywane luźno (`production` → `prod`, `dev` → `test`, `preprod` to nie
`prod`); inne (`staging`, `uat`) są pomijane.

## A. Serwer ShipScope (workspace)

Zaloguj się przez GitHuba i utwórz workspace pod adresem `/start`. Jego strona Settings (`/t/<workspace>/settings`)
zaczyna się listą kontrolną **Getting started**, która pokazuje, na jakim etapie jesteś; admin może ją ukryć. Kroki:

1. **Install the GitHub App** — zainstaluj aplikację na organizacji albo koncie GitHub, z którego wdrażasz
   (Settings → GitHub → Install). GitHub odeśle cię z powrotem; instalacja zostaje połączona tylko wtedy, gdy twoje
   własne konto GitHub ją widzi.
2. **Choose repositories to track** — kliknij Track przy każdym repozytorium, którego deploymenty chcesz widzieć.
   Opcjonalnie dla każdego repozytorium: plik wersji (dla wdrożeń QA/PROD, których commity zawierają tylko linię w
   rodzaju `version=v1.6.0`) i ścieżki, które nie liczą się jako drift (np. `.github/`, `README.md`).
3. **First deployments arrive** — w ciągu 15 minut (domyślny odstęp synchronizacji) albo ok. 30 sekund, jeśli
   serwer ma skonfigurowane webhooki GitHuba. Błąd synchronizacji widać w sekcji GitHub.
4. **Connect Jira** (opcjonalnie, tylko odczyt) — zaloguj się przez Atlassian i wybierz witrynę Jiry.
5. **Choose Jira boards** — zaznacz tablicę każdego zespołu i zapisz. Rytm tablicy (PI, sprinty, wydania albo
   miesięczny przepływ) jest wykrywany; można go zmienić dla każdej tablicy, razem z szablonem nazwy PI. Kliknij
   Sync now albo poczekaj na kolejną synchronizację.
6. **Send feature flags** (opcjonalnie) — ShipScope sam nie czyta flag. Dodaj źródło dla każdego miejsca, w którym
   trzymasz flagi (krok budowania, serwis flag; rodzaj build albo runtime, priorytet, opcjonalnie komponent),
   utwórz dla niego token i niech wysyła pełny stan swoich flag do `POST /api/flags/ingest`. W Jira → Feature flags
   in Jira można też wskazać pole albo prefiks etykiety, które łączą zadania Jiry z flagami.
7. **Invite your team** — jeden link zaproszenia na osobę. Członkowie widzą wszystko; admini mogą zmieniać
   ustawienia.

W sekcji Workspace admin ustawia też, ile dni historii deploymentów przechowywać (7–730), i może usunąć workspace.

## B. Synchronizacja plikowa

Synchronizacja plikowa i jej workflowy działają z oryginalnego repozytorium, `circlek-global/evdt-service-shipscope`
(tego, na które wskazują `uses:` w repozytoriach aplikacji); to repozytorium nie ma kopii tych workflowów.

### 0. Jednorazowa konfiguracja samego ShipScope

Potrzebna tylko przy nowej instancji ShipScope albo gdy nic nie synchronizuje się dla żadnego komponentu.

**Dwie aplikacje GitHub:**

- **Aplikacja synchronizacji** (`CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID` / `..._PRIVATE_KEY`, sekrety w
  `evdt-service-shipscope`). Zainstalowana na **każdym monitorowanym repozytorium aplikacji** (Organization
  settings → GitHub Apps → aplikacja → Configure → repository access) z odczytem **Deployments**, **Contents**
  (porównania, commity, tagi, releasy) i **Actions** (ustalanie, czy deploy był ręczny; `retrigger-app-checks.yml`
  potrzebuje też zapisu w Actions). Brak instalacji na repozytorium to najczęstszy powód, dla którego nic się dla
  niego nie pokazuje.
- **Aplikacja zapisu do ShipScope** (`SHIPSCOPE_APP_ID` / `SHIPSCOPE_APP_PRIVATE_KEY`). Zainstalowana na
  `evdt-service-shipscope` z odczytem i zapisem Contents. Jej poświadczenia muszą być dostępne także w każdym
  monitorowanym repozytorium, bo to workflow repozytorium aplikacji tworzy token, którym daje sygnał ShipScope
  (`notify-deployment.yml`) albo zapisuje dane flag (`check-flags.yml`).

Własne workflowy ShipScope działające tylko w tym repozytorium (commity na `live`, merge `main` do `live`) używają
domyślnego `GITHUB_TOKEN` z `contents: write`.

**Jedno konto Jiry, tylko do odczytu:** token API Atlassian zapisany jako `JIRA_EMAIL` / `JIRA_API_TOKEN` oraz
`JIRA_BASE_URL`. Konto potrzebuje uprawnienia „Browse projects” w każdym projekcie, który ShipScope ma widzieć;
ShipScope nigdy nie zapisuje do Jiry. Jeśli `docs/jira-spaces.json` wymienia `boards`, konto potrzebuje też odczytu
tych tablic Jira Software (`/rest/agile/1.0/board`, `/rest/agile/1.0/board/{id}/sprint`).

Jeśli tylko zapytania o tablice i sprinty zwracają 401, a wyszukiwanie projektów i zadań działa z tymi samymi
poświadczeniami, zobacz artykuł Atlassian ["401 Unauthorized error when service account accesses Jira or Confluence API"](https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/).
Zwykle albo token jest tokenem **z zakresami** (scoped) konta serwisowego bez zakresów Jira Software
(`read:board-scope:jira-software`, `read:sprint:jira-software`), albo konto nie ma **dostępu do produktu Jira
Software**. Jedno i drugie naprawia admin Jiry; w tym repozytorium nic się nie zmienia.

Z samą tą konfiguracją codzienna synchronizacja już działa (bez niczego do synchronizowania), a Jira korzysta ze
ścieżki bez konfiguracji. Dane pojawiają się po dodaniu komponentu.

### Przed dodaniem komponentu

Potrzebujesz: dokładnej **nazwy repozytorium GitHub** komponentu (np. `evapl-service-frontend`, używanej wszędzie
jako jego nazwa); potwierdzenia, że tworzy GitHub Deployments (zob. początek dokumentu); informacji, czy ma
**feature flagi build-time** (pliki `*.generated.ts`, katalogi `flag-parts/`).

### 1. Dodaj go do `docs/components.json`

```json
{ "name": "your-repo-name", "description": "What this component does.", "serviceType": null, "featureFlagsIncluded": null, "application": null }
```

- `name` — nazwa repozytorium; jedyne wymagane pole.
- `description` — podpowiedź przy nazwie komponentu.
- `featureFlagsIncluded` — `true`, jeśli ShipScope śledzi jego flagi, `false`, żeby pokazać ikonę „flagi nie są tu
  śledzone”, `null`, dopóki nie wiadomo.
- `serviceType` — zarezerwowane; zostaw `null`.
- `application` — tablica nazw biznesowych (np. `["EBO"]`) dla filtra Service w Release Notes; bez niej komponent
  występuje pod własną nazwą.
- `versionFile` (opcjonalnie, np. `"trigger.properties"`) — gdy QA/PROD wdrażają z gałęzi `deployment/*` z samymi
  commitami-wyzwalaczami (`version=v1.6.0`); bez tego drift porównuje commity-wyzwalacze zamiast kodu.
- `driftIgnorePaths` (opcjonalnie, np. `[".github/", "README.md", "trigger.properties"]`) — pliki, które nie liczą
  się jako różnica w kodzie między środowiskami.

To jedyny plik ShipScope, który edytujesz. Otwórz PR do `main`; po merge'u `sync-main-to-live.yml` przenosi zmianę
na `live`, skąd wszystko ją czyta.

### 2. Daj aplikacjom GitHub dostęp do repozytorium

- Zainstaluj aplikację synchronizacji na nowym repozytorium (zob. krok 0).
- Udostępnij mu `SHIPSCOPE_APP_ID` / `SHIPSCOPE_APP_PRIVATE_KEY` (nic do zrobienia, jeśli to sekrety organizacji
  widoczne dla wszystkich repozytoriów; w przeciwnym razie dodaj repozytorium do ich listy).

### 3. Podłącz repozytorium aplikacji

**Powiadamiaj ShipScope po każdym deployu.** Dodaj jeden workflow na **domyślnej gałęzi** repozytorium aplikacji,
`.github/workflows/notify-shipscope.yml`. Bez niego komponent jest synchronizowany tylko codziennie o 3:00.

```yaml
name: Notify ShipScope

on:
  workflow_run:
    # each value must equal the `name:` of a deployment workflow exactly (case-sensitive)
    workflows: ["Test auto-deployment", "QA on-demand deployment", "Prod on-demand deployment"]
    types: [completed]

permissions: {}

jobs:
  notify_shipscope:
    name: Trigger ShipScope full sync
    # successful runs only; to also record failed attempts use
    # conclusion != 'skipped' && conclusion != 'cancelled'
    if: github.event.workflow_run.conclusion == 'success'
    uses: circlek-global/evdt-service-shipscope/.github/workflows/notify-deployment.yml@v1.0.0
    with:
      component: ${{ github.event.repository.name }}
    secrets:
      SHIPSCOPE_APP_ID: ${{ secrets.CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID }}
      SHIPSCOPE_APP_PRIVATE_KEY: ${{ secrets.CIRCLEK_GLOBAL_GITHUB_EVDT_APP_PRIVATE_KEY }}
```

Dlaczego osobny plik: GitHub uruchamia workflow z gałęzi, która go wyzwoliła, więc deploy uruchomiony z gałęzi w
rodzaju `deployment/qa` użyłby kopii workflowu wdrożeniowego z tej gałęzi, bez kroków dodanych tylko na `main`.
Workflow `workflow_run` jest zawsze czytany z gałęzi domyślnej, więc ten jeden plik obejmuje każdą gałąź i każde
środowisko. Nie zostawiaj dodatkowo kroku powiadamiania w workflowach wdrożeniowych (tylko dubluje sygnał).

Uwagi: nic nie robi, dopóki nie trafi na gałąź domyślną; `component` musi zgadzać się z `docs/components.json`;
sekrety muszą być sekretami repozytorium albo organizacji, nie środowiska. Sprawdź jednym prawdziwym deployem:
„Notify ShipScope” uruchamia się w zakładce Actions repozytorium aplikacji, a w ShipScope startuje
`orchestrate-full-sync.yml`. Po zmianie nazwy workflowu wdrożeniowego zaktualizuj `workflows:`.

**Flagi build-time (jeśli są).** Dodaj workflow wywołujący reużywalny `check-flags.yml`, tak jak robi to
`evapl-service-frontend`. Jego sprawdzenie metadanych nie przechodzi, dopóki wpis każdej flagi nie jest uzupełniony
(`fill-flag-metadata.yml`); `check-flags-metadata.js` może zamiast tego ostrzegać (`WARN_ONLY=true`), jeśli workflow
to przekazuje.

### 4. Flagi build-time: ustaw `featureFlagsIncluded: true`

`retrigger-app-checks.yml` ponawia nieudane przebiegi `check-flags` w repozytorium aplikacji po zmianie
`flags-meta.json`, dla komponentów z `featureFlagsIncluded: true`. Do tego też aplikacja synchronizacji musi być
zainstalowana na repozytorium.

### 5. Opcjonalnie: uzupełnij starsze deploymenty

`backfill-deployment-metadata.yml` (ręcznie) uzupełnia nowsze pola — link do przebiegu, czas trwania, ręczny,
rollback, zakres commitów, nazwę osoby, wersję — w rekordach deploymentów sprzed ich wprowadzenia. Ma limit na
uruchomienie (`MAX_RECORDS_PER_RUN`) i można go uruchamiać wielokrotnie.

### Czego nie trzeba ruszać

- **`scripts/*.js`** — każdy skrypt bierze komponent z `COMPONENT`/`APP_REPO`.
- **`docs/app-*.js` / `docs/index.html`** — listy komponentów i filtry wynikają z danych; kolejność wierszy idzie
  za `docs/components.json`.
- **Jira** — bez skonfigurowanych tablic synchronizacja Jiry używa kluczy zadań znalezionych w opisach commitów
  komponentu (`XXX-123`). Żeby pokazać całe bieżące PI, dodaj przestrzeń i tablicę zespołu do
  `docs/jira-spaces.json` (`CLAUDE.md` → „Configuration files in `docs/`”).
