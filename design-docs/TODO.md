# TODO

## Ujednolicenie odczytu stanu feature flag przez dedykowane endpointy

Warto rozważyć dodanie do serwisów `evsim-service-sim-adapter` oraz `evam-service-host` dedykowanych
endpointów zwracających aktualny stan feature flag per środowisko, w płaskim formacie
`{ nazwaFlagi: true|false }` — dokładnie takim, jaki `scripts/sync-runtime-be-flags.js` już potrafi
odczytać bez jakichkolwiek zmian w kodzie. Kontekst i uzasadnienie tego podejścia (w odróżnieniu od
sięgania bezpośrednio do Spring Boot Actuatora) zostało opisane w `ARCHITECTURE-NOTES.md`, w sekcji
dotyczącej konkretnego przypadku `evsim-service-sim-adapter`.

W przyszłości warto rozważyć wprowadzenie analogicznego endpointu również dla `evapl-service-frontend`,
niezależnie od tego, że jego flagi są dziś typu build-time. Umożliwiłoby to jednolite i spójne odczytywanie
stanu flag dla każdego z serwisów za pośrednictwem tego samego mechanizmu (endpoint/API), niezależnie od
tego, czy dany serwis jest komponentem frontendowym, czy backendowym.

Powiązane pole w schemacie: `docs/components.json` oznacza już dziś `featureFlagsIncluded: false` dla
`evsim-service-sim-adapter` oraz `null` (nierozstrzygnięte) dla `evam-service-host`. Dodanie wymienionych
endpointów byłoby naturalnym sposobem na zamknięcie tego długu i zmianę odpowiadających im wartości na
`true`.

## Hardcodowany JIRA_BASE_URL we frontendzie

`docs/app.js` ma na stałe wpisany `const JIRA_BASE_URL = 'https://circlek.atlassian.net/browse'`, używany
wyłącznie do budowania klikalnych linków "otwórz w Jirze" (nie do pobierania danych — te zawsze idą z
lokalnych `docs/data/*.json`). To niezależna wartość od sekretu `JIRA_BASE_URL`, który czyta
`scripts/sync-jira.js` i który jest realnym adresem API Jira Cloud używanym do synchronizacji. Frontend nie
ma dostępu do repository secrets (statyczna strona na GitHub Pages), więc hardcode jest obecnie wymuszony —
ale oznacza to, że obie wartości muszą zostać zgodne tylko przez przypadek, i jeśli sekret kiedyś się zmieni
(inny Jira Cloud site, instancja self-hosted), link w UI przestanie być poprawny bez żadnego ostrzeżenia.

Rozważyć: `sync-jira.js` wylicza `${JIRA_BASE_URL}/browse` z sekretu i zapisuje je jako pole (np.
`jiraBrowseUrl`) w `docs/data/jira-issues/index.json` — plik, który `app.js` i tak pobiera jako pierwszy przy
starcie. `app.js` czytałby wartość odtąd, z hardcodowanym adresem jako fallback (dla `file://`/`FALLBACK` i
starych `index.json` bez tego pola).

## Zbyt szerokie uprawnienia tokenów GitHub App w niektórych workflowach

Kilka workflowów w `.github/workflows/` żąda od `create-github-app-token` szerszych uprawnień
(`permission-*`) niż faktycznie wykorzystuje dany krok — np. uprawnienie do zapisu tam, gdzie krok tylko
czyta, albo zakres obejmujący więcej zasobów niż te, do których workflow faktycznie sięga. Warto przejrzeć
każde użycie `create-github-app-token` w tym repo i zweryfikować, czy żądany zestaw `permission-*` da się
zwęzić do rzeczywiście potrzebnego minimum — zasada najmniejszych uprawnień ma tu szczególne znaczenie,
bo token wygenerowany dla `SHIPSCOPE_APP`/`CIRCLEK_GLOBAL_GITHUB_EVDT_APP` jest realnym poświadczeniem z
dostępem do `live` i do repozytoriów aplikacji (patrz sekcja "Branch model" w `CLAUDE.md`).

## CODEOWNERS nie chroni `scripts/**` i `.github/actions/**` tak samo jak `.github/workflows/*`

Plik CODEOWNERS wymusza przegląd zmian w `.github/workflows/*`, ale nie obejmuje w ten sam sposób
`.github/actions/sync-with-retry/action.yml` ani całego katalogu `scripts/**` — mimo że te pliki są
dokładnie tak samo krytyczne z punktu widzenia bezpieczeństwa: to one są faktycznie *wykonywane* przez
workflowy, a nie tylko dane. Patrz sekcja "Branch model" w `CLAUDE.md`, która wyjaśnia, dlaczego
`scripts/`/`.github/actions/**` nigdy nie powinny być wykonywane z `live` — ten sam powód, dla którego
zmiany w nich na `main` zasługują na obowiązkowy przegląd, nie tylko zmiany w samych definicjach
workflowów. Warto rozszerzyć reguły CODEOWNERS tak, aby obejmowały również te dwie ścieżki.

## Akcje firm trzecich przypięte do tagów, nie do commit SHA

Akcje firm trzecich używane w `.github/workflows/*` (np. `actions/checkout@v7`,
`actions/create-github-app-token@v3`) są przypięte do tagów wersji, nie do konkretnego commit SHA.
Właściciel akcji może przesunąć tag na inny commit bez żadnego ostrzeżenia — co jest szczególnie istotne
dla `create-github-app-token`, bo ta akcja generuje tokeny z realnymi uprawnieniami zapisu do repozytoriów
tego org'u; podstawiona wersja mogłaby wyciekać lub nadużywać te tokeny. Warto rozważyć przypięcie
przynajmniej tej akcji (a najlepiej wszystkich akcji firm trzecich w tym repo) do konkretnego commit SHA
zamiast do mutowalnego tagu.

### Jak aktualizowane byłyby akcje firm trzecich przypięte do SHA?

Tag taki jak `@v3` zastępujemy niezmiennym commitem, a czytelną wersję zostawiamy w komentarzu:

```yaml
uses: actions/create-github-app-token@<40-znakowy-sha> # v3.0.0
```

Nikt nie ma podbijać tego ręcznie — robi to **Dependabot**, włączony plikiem `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Za każdym razem, gdy akcja opublikuje nowe wydanie, Dependabot otwiera PR, który podmienia SHA na SHA nowego
wydania **i** aktualizuje komentarz `# vX.Y.Z`. Przegląd jest taki sam jak każdego innego PR: diff + notatki
wydania, potem merge. Opcjonalne `cooldown` opóźnia bardzo świeże wydania o kilka dni, co daje społeczności czas
na zauważenie złośliwego wydania. Renovate robi to samo, jeśli jest już używany w organizacji.

Droga ręczna (jednorazowa zmiana): `gh api repos/actions/create-github-app-token/git/ref/tags/v3 --jq .object.sha`.
Dla tagu *annotated* zwraca to obiekt tagu, nie commit — trzeba go rozwinąć o jeden krok dalej, dlatego
automatyzacja jest lepsza niż ręczne podbijanie.

Czego to **nie** obejmuje:
- Dotyczy tylko akcji firm trzecich wywoływanych z workflowów tego repo. Własne skrypty i reusable workflowy
  ShipScope (`check-flags.yml`, `notify-deployment.yml`) są wersjonowane przez gałęzie `main`/`live`; repozytorium
  aplikacji, które je wywołuje, samo wybiera swój `@ref`.
- Przypięcie do SHA czyni wydanie *niezmiennym*, nie *godnym zaufania* — złośliwe wydanie, które zostanie później
  przypięte, nadal jest złośliwe. Dlatego krok przeglądu PR (i najlepiej cooldown) nadal mają znaczenie.

## Testy automatyczne — braki i CI

Od 2026-10-09 istnieje zestaw testów na wbudowanym `node:test` (`npm test`, katalog `test/`) obejmujący wszystkie
skrypty, biblioteki i pliki `docs/app-*.js` (ok. 99,8% linii). Workflow `.github/workflows/test.yml` uruchamia `npm test` na PR i na `main`;
warto jeszcze ustawić regułę ochrony gałęzi wymagającą zielonego `Test` (ustawienia repozytorium, poza kodem)
oraz przypiąć akcje do SHA. Brakuje weryfikacji układu w prawdziwej przeglądarce (atrapa DOM nie parsuje HTML, więc wyrównywanie
wysokości wierszy i synchronizacja przewijania nie są sprawdzane).

## XSS przez `docs/app.js` serwowany z `live`

Przygotowana rekomendacja (ruleset na `live` zamiast samego podziału uprawnień App) czeka na decyzję i
wdrożenie poza kodem repo — zmiana wymaga uprawnień administracyjnych do ustawień repozytorium.

## Tryb jasny nie pokrywa wszystkich kolorów

Przy ostatnim przeglądzie tryb jasny obejmował ok. 36 z ~91 zahardkodowanych kolorów w `docs/style.css`.
Warto obejrzeć wszystkie widoki w trybie jasnym i uzupełnić brakujące zmienne.

## Włączenie `JIRA_BOARD_LOOKUP_STRICT=true`

Admin naprawił dostęp konta serwisowego do Agile API (2026-10-08), więc flagę można przełączyć na `true`
(zmiana zmiennej środowiskowej poza kodem repo) — patrz sekcja "Jira issues" w `CLAUDE.md`.

## Wydzielenie `buildFallbackData()` z `docs/app-data.js`

Funkcja (ok. 300 linii przykładowych danych dla podglądu z `file://`) siedzi w `app-data.js` i zaśmieca plik
z logiką pobierania danych. Przeniesienie do osobnego pliku (np. `docs/app-fallback.js`) wymaga uwagi na
kolejność ładowania: `const FALLBACK = buildFallbackData()` działa przy ładowaniu skryptu, więc nowy plik musi
być wczytany w `docs/index.html` przed `app-main.js`, a po `app-model.js` (korzysta z jego helperów). Nie
używać modułów ES — nie ładują się przez `file://`. Po zmianie sprawdzić podgląd otwarty z `file://`.

## Porządki w repo

- Dodać `.idea/` do `.gitignore` (katalog jest dziś nieśledzony).
- Zacommitować oczekujące zmiany (`CHANGELOG*.md`, `CLAUDE.md`, `docs/style.css`) oraz nieśledzone
  `design-docs/PRODUCT-DEV-PROPOSAL*.md`.
