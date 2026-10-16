# TODO

Dług techniczny i otwarte sprawy, które nie są nowymi funkcjami (te są w [FEATURES.pl.md](FEATURES.pl.md)).
Każdy punkt sprawdzony z kodem 2026-10-16.

## Linki do Jiry na sztywno na `circlek.atlassian.net` — także w trybie SaaS

`docs/app-core.js` ma `const JIRA_BASE_URL = 'https://circlek.atlassian.net/browse'`. Z niego powstaje każdy
klikalny link „otwórz w Jirze” (`app-product.js`, `app-release-notes.js`, `app-technical.js`). Dane nie idą tą
drogą, tylko linki.

- **Tryb SaaS (`/t/<id>/`)**: to jest błąd, nie tylko dług. Każdy workspace ma własną witrynę Jiry
  (`jira_connections.site_url`), a linki na dashboardzie i tak prowadzą do `circlek.atlassian.net`. Naprawa:
  `lib/dashboard-data.js` dokłada adres witryny (np. `jiraBrowseUrl`), a `docs/app-data.js` w trybie API go
  używa.
- **Tryb plikowy (GitHub Pages)**: frontend nie ma dostępu do sekretów, więc wartość zgadza się z sekretem
  `JIRA_BASE_URL` (czytanym przez `scripts/sync-jira.js`) tylko przypadkiem. Naprawa: `sync-jira.js` zapisuje
  `${JIRA_BASE_URL}/browse` jako pole w `docs/data/jira-issues/index.json`, a stała zostaje jako zapas dla
  `file://`/`FALLBACK` i starych plików.

## Akcja `.github/actions/ingest-flags` opisana, ale nie ma jej w repozytorium

`FLAG-INGEST.md` i `CLAUDE.md` opisują akcję złożoną `.github/actions/ingest-flags`, która wiąże komponent z
tożsamością wywołującego repo. W historii gita tego katalogu nie ma (jest tylko `sync-with-retry`); jest sam
skrypt `scripts/ingest-flags.js`. Albo odtworzyć akcję (projekt w `FLAG-INGEST.md`), albo usunąć wzmianki.
Dla nowych źródeł flag właściwą drogą jest już API serwera (`POST /api/flags/ingest`, `schemaVersion: 2`).

## Ujednolicenie odczytu stanu flag przez dedykowane endpointy (`evsim`, `evam`)

Warto dodać do `evsim-service-sim-adapter` i `evam-service-host` endpointy zwracające stan flag per
środowisko w płaskim formacie `{ nazwaFlagi: true|false }` — dokładnie takim, jaki
`scripts/sync-runtime-be-flags.js` czyta bez zmian. W `docs/components.json` mają dziś
`featureFlagsIncluded: false` (`evsim`) i `null` (`evam`); endpoint pozwoliłby ustawić `true`.

Dlaczego nie Spring Boot Actuator wprost: `evsim` definiuje flagi jako placeholdery `${ENV_VAR:default}` w
`application.yml`, więc plik w repo pokazuje tylko wartość domyślną, a prawdziwa jest widoczna dopiero przez
`/actuator/env/{name}` (po jednej właściwości, wartość jako tekst) albo `/actuator/configprops` (całe drzewo
konfiguracji). Żaden kształt nie pasuje do skryptu (potrzebne byłoby nowe parsowanie i mapowanie flaga →
właściwość Springa), endpoint wymaga osobnego poświadczenia, a przy tym odsłania całą konfigurację serwisu, nie
tylko flagi. Mały, celowy endpoint jest tańszy i bezpieczniejszy. To samo można kiedyś zrobić dla
`evapl-service-frontend` (dziś flagi build-time), żeby każdy serwis czytać jednym mechanizmem.

## Zbyt szerokie uprawnienia tokenów GitHub App w niektórych workflowach

Kilka workflowów żąda od `create-github-app-token` szerszych `permission-*` niż wykorzystuje dany krok (zapis
tam, gdzie krok tylko czyta, albo zakres większy niż potrzebne zasoby). Przejrzeć każde użycie i zwęzić do
minimum: token dla `SHIPSCOPE_APP`/`CIRCLEK_GLOBAL_GITHUB_EVDT_APP` ma realny dostęp do `live` i repozytoriów
aplikacji (sekcja „Branch model” w `CLAUDE.md`).

## CODEOWNERS nie chroni `scripts/**` i `.github/actions/**`

`CODEOWNERS` wymusza przegląd zmian tylko w `.github/workflows/*`. Tak samo krytyczne są
`.github/actions/sync-with-retry/action.yml` i cały `scripts/**`, bo to one są wykonywane przez workflowy
(dlatego nigdy nie są uruchamiane z `live`, patrz „Branch model” w `CLAUDE.md`). Rozszerzyć reguły na te ścieżki.

## Akcje firm trzecich przypięte do tagów, nie do commit SHA

Workflowy używają `actions/checkout@v7`/`@v4`, `actions/setup-node@v4` i `actions/create-github-app-token@v3`.
Tag można przesunąć na inny commit bez ostrzeżenia, co jest szczególnie groźne dla `create-github-app-token`
(generuje tokeny z prawem zapisu). Przypiąć do SHA, przynajmniej tę akcję:

```yaml
uses: actions/create-github-app-token@<40-znakowy-sha> # v3.0.0
```

Podbijanie robi Dependabot (`.github/dependabot.yml` jeszcze nie istnieje):

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Przy każdym wydaniu Dependabot otwiera PR ze zmianą SHA i komentarza `# vX.Y.Z`; opcjonalne `cooldown` opóźnia
bardzo świeże wydania. Ręcznie: `gh api repos/actions/create-github-app-token/git/ref/tags/v3 --jq .object.sha`
(dla tagu *annotated* trzeba rozwinąć obiekt tagu o krok dalej). Przypięcie czyni wydanie niezmiennym, nie
godnym zaufania, więc przegląd PR nadal ma znaczenie. Nie dotyczy własnych reusable workflowów ShipScope
(`check-flags.yml`, `notify-deployment.yml`) — repozytorium aplikacji samo wybiera ich `@ref`.

## Testy — czego jeszcze brakuje poza kodem

`test.yml` (`npm test`) i `server-test.yml` (serwer na prawdziwym Postgresie) działają na PR i na `main`.
Brakuje:

- reguły ochrony gałęzi `main`, która wymaga obu zielonych checków (ustawienia repozytorium);
- sprawdzania układu w prawdziwej przeglądarce w CI (atrapa DOM nie parsuje HTML, więc wyrównywanie wysokości
  wierszy i synchronizacja przewijania nie są sprawdzane; Playwright był dotąd uruchamiany tylko ręcznie).

## XSS przez pliki `docs/` serwowane z `live`

Przygotowana rekomendacja (ruleset na `live` zamiast samego podziału uprawnień App) czeka na decyzję i
wdrożenie poza kodem — wymaga uprawnień administracyjnych do ustawień repozytorium.

## Tryb jasny nie pokrywa wszystkich kolorów

Przy ostatnim przeglądzie tryb jasny obejmował ok. 36 z ~91 zahardkodowanych kolorów w `docs/style.css`.
Obejrzeć wszystkie widoki w trybie jasnym i uzupełnić brakujące zmienne.

## Włączenie `JIRA_BOARD_LOOKUP_STRICT=true`

Admin naprawił dostęp konta serwisowego do Agile API (2026-10-08), więc flagę można przełączyć na `true`
(zmienna środowiskowa poza kodem) — patrz sekcja „Jira issues” w `CLAUDE.md`.

## Wydzielenie `buildFallbackData()` z `docs/app-data.js`

Funkcja (ok. 300 linii przykładowych danych dla podglądu z `file://`) zaśmieca plik z logiką pobierania danych.
Przy przenoszeniu do osobnego pliku (np. `docs/app-fallback.js`) uważać na kolejność ładowania:
`const FALLBACK = buildFallbackData()` działa przy ładowaniu skryptu, więc nowy plik musi być wczytany w
`docs/index.html` po `app-model.js` (korzysta z jego helperów), a przed `app-main.js`. Bez modułów ES — nie
ładują się przez `file://`. Po zmianie sprawdzić podgląd otwarty z `file://`.
