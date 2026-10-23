# ShipScope FAQ — jak to jest liczone?

*English version: [FAQ.md](FAQ.md)*

Dla każdej liczby i plakietki na dashboardzie: skąd bierze się wartość, opisane zwykłym językiem, z nazwą pliku albo
funkcji, która ją liczy, żeby dało się to sprawdzić. `README.pl.md` mówi, czym jest ShipScope; `CLAUDE.md` to opis
techniczny; `docs/GLOSSARY.md` wyjaśnia pojęcia, które mają więcej niż jedną nazwę. Settings oznacza niżej stronę
ustawień workspace'u (`/t/<workspace>/settings`).

## Deploymenty (widok Technical)

### Jak wyliczany jest „rollback”?

Każdy nowy deployment jest porównywany na GitHubie z tym, co wcześniej działało na tym samym środowisku (to samo
porównanie, które znajduje jego zadania Jiry i buduje link do zakresu commitów). Jeśli GitHub odpowie, że nowy
commit jest **`behind`** — jest przodkiem tego, co już działało — środowisko cofnęło się w historii, a deployment
dostaje plakietkę rollbacku z commitem, do którego wrócono. Nie ma znaczenia, czy to był celowy revert, czy pomyłka.
Nie wymaga to dodatkowego zapytania do API. (`server/lib/deployment-sync.js`.)

### Jak ustalane jest, czy deployment był ręczny („manual”), czy automatyczny?

Historia statusów deploymentu zwykle wskazuje przebieg GitHub Actions, który go wykonał. ShipScope pyta GitHuba, co
uruchomiło ten przebieg: `workflow_dispatch` (przycisk „Run workflow”) oznacza ręczny; push, harmonogram i podobne —
automatyczny. Bez takiego wskazania deployment liczy się jako nie-ręczny. Na jedno repozytorium i jedną
synchronizację sprawdzanych jest najwyżej 30 przebiegów, żeby duża zaległość nie zużyła limitu zapytań na plakietkę.
Wymaga uprawnienia GitHub App do odczytu Actions. (`server/lib/deployment-people.js`.)

### Jak liczony jest czas trwania deploymentu?

To czas między najwcześniejszym a najpóźniejszym statusem zapisanym przez GitHuba (w kolejce, w toku, sukces…).
Znacznik `inactive`, który GitHub dopisuje później, gdy nowszy deployment zastępuje ten, jest pomijany. Przy jednym
statusie nie ma czego mierzyć, więc czas nie jest pokazywany — to nie znaczy, że deploy trwał chwilę.
(`computeDeployDurationMs`, `server/lib/deployment-logic.js`.)

### Skąd bierze się wersja pokazywana przy deploymencie?

Zasada jest ta sama dla każdego środowiska; różni się tylko to, który commit jest tam wdrożony. Wygrywa pierwsze
trafienie:

1. **Release** na GitHubie wskazujący dokładnie ten commit;
2. zwykły **tag** gita na tym commicie;
3. **plik wersji** we wdrożonym commicie, jeśli repozytorium ma go ustawionego (Settings → GitHub → Tracked
   repositories → Version file) — dla repozytoriów, których commity wdrażane na QA/PROD zawierają tylko linię w
   rodzaju `version=v1.6.0`;
4. ciąg wyglądający na wersję (`v1.2.3`, `1.2.3`) w **opisie commita**;
5. skrócony **SHA commita**.

Wartość z pliku wersji jest dopasowywana do taga: tak jak zapisana, potem z dodanym albo usuniętym prefiksem `v`,
a dla wersji z sufiksem, np. `1.4.25-okta`, `2.0.0-rc.1`, `1.0.0+build5` czy `1.0.0_hotfix`, tag bazowy `1.4.25`
(dokładny tag zawsze wygrywa). Pokazywana wersja zostaje taka, jak zapisana (`1.4.25-okta`); tag służy do powiązanych
zadań, rollbacku i driftu. `version=latest` oznacza najnowszy opublikowany release (nie przedpremierowy), który
istniał w chwili utworzenia deploymentu, i ten tag jest pokazywany. Lepiej jednak, żeby pipeline zapisywał konkretną
wersję (`version=v1.1.46`): „latest” to tylko domysł.

Release i tag są przed opisem commita, bo wolny tekst może wspominać niezwiązaną wersję; Release albo tag to celowy
sygnał. Deploy prosto z commita z gałęzi funkcjonalnej zwykle kończy się na SHA, bo żadnego sygnału nie ma. Do
porównań na GitHubie używany jest tylko potwierdzony Release/tag (albo SHA); wersja wzięta z opisu jest tylko
pokazywana. (`server/lib/version-resolution.js`.)

### Co znaczy „Diff to TEST” i kiedy się pojawia?

Karta środowiska pokazuje **„Diff to TEST”** (albo „Diff to QA” — poprzedni etap w `test` → `qa` → `prod`) tylko
wtedy, gdy **kod** jej bieżącego deploymentu różni się od kodu tamtego środowiska. Szczegóły po kliknięciu.

Jak to jest ustalane dla każdej pary środowisk:

1. Porównywane są **drzewa gita** obu wdrożonych commitów. To samo drzewo oznacza te same pliki: brak znacznika,
   niezależnie od liczby commitów między nimi (merge, squash i gałęzie wdrożeniowe tworzą nowe commity dla
   identycznego kodu).
2. W przeciwnym razie listy plików są porównywane po ścieżce i treści. Ścieżki wyłączone w ustawieniach
   repozytorium (elementy wdrożenia, np. `.github/`, `README.md`, `trigger.properties`; Settings → GitHub → Paths not
   counted as drift) się nie liczą. Jeśli nie zostaje żaden różniący się plik — brak znacznika.
3. Jeśli porównaniu nie da się ufać — błąd GitHuba albo repozytorium za duże na jedną listę (100 000 pozycji /
   7 MB) — wynik to **Unknown**, nigdy „brak różnicy”.

Okno pokazuje liczbę różniących się plików (zmiana nazwy liczy się jako dwa), pierwsze 20 ścieżek i liczbę
pominiętych; potem liczby z **historii gita**: commity, które ma drugie środowisko, a tego brakuje, i odwrotnie (np.
hotfix, który ominął wcześniejsze środowisko). Historia liczy commity, nie kod, więc „786 behind TEST” może oznaczać
zero zmienionych plików; to tylko kontekst. Porównanie nie obejmuje konfiguracji, zmiennych środowiskowych, obrazów
ani feature flag.

Żeby sprawdzić, czy dwa środowiska naprawdę mają różne zmiany, porównaj zadania Jiry (albo link do zakresu
commitów) ich bieżących deploymentów w historii deploymentów: brak części wspólnej oznacza niezwiązane zmiany, a
nie to samo wydanie w innym tempie. (`server/lib/env-drift.js`, `server/lib/tree-diff.js`.)

### Jak długo trzymane są deploymenty i kiedy pojawia się nowy?

ShipScope pokazuje stan bieżący; pełną historię ma GitHub. Deploymenty starsze niż okres przechowywania workspace'u
(Settings → Workspace, 7–730 dni, domyślnie 90) są codziennie usuwane, z wyjątkiem — dla każdego repozytorium i
środowiska — najnowszego deploymentu i najnowszego udanego, których potrzebują „bieżąca wersja”, drift i rollback.
To, czy zadanie kiedykolwiek trafiło na środowisko, jest zapamiętywane osobno i przeżywa to sprzątanie (tabela
`issue_deployments`). Nowe deploymenty przychodzą z okresową synchronizacją (domyślnie co 15 minut) albo ok.
30 sekund po zgłoszeniu z GitHuba, gdy webhooki są włączone. (`server/lib/retention.js`, `server/worker.js`.)

## Feature flagi

### Skąd pochodzą flagi i jak ustalany jest ich stan?

ShipScope sam nigdy nie czyta flag (`design-docs/ADR-001-flags-pushed-from-outside.md`). Admin dodaje źródła flag w
Settings; każde źródło wysyła pełny stan swoich flag (`off` / `on` / `partial` z procentem rolloutu) własnym tokenem
do `POST /api/flags/ingest`. Flaga, której źródło przestaje wysyłać, znika; starsza wiadomość nigdy nie nadpisuje
nowszej.

Każda flaga ma dla każdego środowiska dwa miejsca: **build** (ze źródeł rodzaju build) i **runtime** (rodzaju
runtime). Gdy kilka źródeł jednego rodzaju zgłasza tę samą flagę, wygrywa wyższy priorytet. Gdy oba miejsca mają
wartość, dashboard pokazuje runtime, a niezgodność jest oznaczana (zob. niżej). (`server/lib/flags.js`, reguły w
`server/lib/flags-logic.js`.)

### Do których zadań Jiry należy flaga?

Z trzech miejsc, połączonych: klucze dołączane przez źródło, klucze ustawione ręcznie przez admina w Settings
(źródło ich nie nadpisuje) oraz sama Jira — pole niestandardowe albo prefiks etykiety wybrany w Settings (Jira →
Feature flags in Jira).

### Jak liczona jest notka o nieużywanej fladze (🧹)?

Tylko dla flagi z co najmniej jednym powiązanym zadaniem Jiry, z których wszystkie są Done. ShipScope bierze wtedy
najdłuższy czas, przez jaki flaga jest włączona na którymkolwiek środowisku; od 60 dni sugeruje jej usunięcie. Jeśli
któreś zadanie nie jest Done albo flaga jest wszędzie wyłączona, nic nie jest pokazywane. (`flagStaleWarning`,
`STALE_FLAG_DAYS`, `docs/app-technical-flags.js`.)

### Jak liczone jest ostrzeżenie „blast radius”?

Tylko dla flagi powiązanej z więcej niż jednym zadaniem Jiry: jeśli przynajmniej jedno jest Done, a przynajmniej
jedno nie, włączenie flagi wypuściłoby niedokończoną pracę razem z gotową, więc pojawia się ostrzeżenie.
(`flagBlastRadius`.)

### Jak pokazywana jest niezgodność build i runtime?

Gdy flaga na danym środowisku ma wartość build i wartość runtime, które się różnią, plakietka środowiska na liście
flag ma przerywaną ramkę, a podpowiedź pokazuje ukrytą wartość build — tę, która wróci, jeśli nadpisanie runtime
zostanie usunięte. (`renderFlags`, `docs/app-technical-flags.js`.)

### Kto i kiedy zmieniał flagę?

Każda zmiana wartości zgłoszona przez źródło trafia do historii flagi (`flag_value_history`), z czasem zmiany podanym przez
nadawcę i nazwą, którą poda (albo nazwą źródła).

### Jak wypróbować adapter flag w innym repozytorium?

Zacznij od próby na sucho (`dry-run`): nie potrzebuje ShipScope ani tokenu, a pokazuje dokładnie tę wiadomość, którą
adapter by wysłał.

1. **Pozwól innemu repozytorium korzystać z Action.** Jeśli to repozytorium jest prywatne, w jego Settings → Actions →
   General → Access zezwól na dostęp repozytoriom tego samego właściciela. Publiczne nie wymaga niczego.
2. **Próba na sucho.** W innym repozytorium dodaj plik flag, np. `config/flags.prod.json` z
   `{ "newCheckout": true, "darkMode": "off", "search": 25 }`, i workflow uruchamiany ręcznie:

   ```yaml
   # .github/workflows/shipscope-flags.yml
   name: ShipScope flags
   on: workflow_dispatch
   jobs:
     flags:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v7
         - uses: dbqm45/evdt-service-shipscope/adapters/flags@v0.2.11   # albo nowszy tag wydania
           with:
             environment: prod
             files: config/flags.prod.json
             dry-run: true
   ```

   Uruchom go z zakładki Actions. W logu zobaczysz wiadomość (`newCheckout` on, `darkMode` off, `search` partial 25)
   i „Dry run: 3 flags for prod, nothing sent.”; wartość, której adapter nie umie odczytać, kończy krok błędem z nazwą
   flagi i pliku.
3. **Wysyłka naprawdę.** W ShipScope, Settings → Feature flags: dodaj źródło (rodzaj build) i skopiuj jego token.
   W innym repozytorium dodaj sekret `SHIPSCOPE_FLAGS_TOKEN` (token) i zmienną `SHIPSCOPE_URL` (adres ShipScope, np. ten
   z Rendera; runnery GitHuba nie dosięgną `localhost`). Zamiast `dry-run: true` wpisz:

   ```yaml
             shipscope-url: ${{ vars.SHIPSCOPE_URL }}
             token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
   ```

   Log kończy się linią „ShipScope (<źródło>): 3 flags for prod, 3 changed, 0 removed, new: …”.
4. **Sprawdź w ShipScope.** Przy źródle widać „received” z liczbami, flagi są w Settings → Feature flags i na
   dashboardzie (Technical view → flagi). Ponowne uruchomienie niczego nie zmienia (0 changed); usunięcie flagi z pliku
   i uruchomienie oznacza ją jako usuniętą.
5. **Zobacz odrzucenie.** Wpisz zły token: krok kończy się błędem 401. Daj fladze wartość w rodzaju `"maybe"`: adapter
   zatrzyma się przed wysłaniem. Wiadomość odrzuconą przez sam ShipScope widać przy źródle jako „last message refused”
   z powodem.

Flagi w innym układzie (jeden plik `.ts` na środowisko i domenę, jak w monorepo Nx): w kroku 2 zamiast `environment`
i pliku JSON użyj `files: domains/*/config/flags/{env}.ts` i `env-map: dev=test, qa=qa, prod=prod`; log wymienia pliki,
które pominął (np. `local.ts`). Kiedy i jak użyć adaptera, ze wszystkimi opcjami i błędami: `ONBOARDING.pl.md`, „Kiedy użyć adaptera”
i „Adapter krok po kroku”.

Na lokalnym serwerze (`npm run dev`) użyj wiersza poleceń zamiast Action, z kopii tego repozytorium:
`SHIPSCOPE_URL=http://localhost:3000 SHIPSCOPE_FLAGS_TOKEN=shpi_... node adapters/flags/shipscope-flags.js --env prod
--file <ścieżka do innego repozytorium>/config/flags.prod.json`. Opcje: `adapters/flags/README.md`; więcej przykładów:
`ONBOARDING.pl.md`, „Wysyłanie feature flag”.

### Jak wygląda kompletny workflow?

Plik do skopiowania do innego repozytorium (wersja adaptera **v0.2.11**). Wysyła flagi wszystkich środowisk po każdym
merge'u, który je zmienia, i można go uruchomić ręcznie, domyślnie na sucho:

```yaml
# .github/workflows/shipscope-flags.yml
name: ShipScope flags

on:
  push:
    branches: [main]
    paths: ['config/flags/**']           # tylko gdy zmieniają się flagi
  workflow_dispatch:                     # ręcznie, z zakładki Actions
    inputs:
      dry-run:
        description: Wypisz wiadomość, nic nie wysyłaj
        type: boolean
        default: true

permissions:
  contents: read

concurrency:
  group: shipscope-flags                 # jedno uruchomienie naraz, po kolei
  cancel-in-progress: false

jobs:
  flags:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v7
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@v0.2.11
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          files: config/flags/{env}.json        # config/flags/test.json, qa.json, prod.json, …
          env-map: dev=test, qa=qa, prod=prod   # dev.json to test; inne pliki (local.json) są pomijane
          changed-by: ${{ github.actor }}
          dry-run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry-run }}
```

Potrzebuje zmiennej `SHIPSCOPE_URL` i sekretu `SHIPSCOPE_FLAGS_TOKEN` (w repozytorium: Settings → Secrets and
variables → Actions), a gdy repozytorium ShipScope jest prywatne — dostępu do jego Actions (poprzednie pytanie, krok 1).
Push do `main` zawsze wysyła; uruchomienie ręczne wysyła tylko z odznaczonym „dry-run”.

Inne układy zmieniają tylko linie w `with:`:

| Twoje flagi | Zamiast `files` / `env-map` |
| --- | --- |
| Monorepo Nx, `domains/<domena>/config/flags/{local,dev,test,qa,prod}.ts` | `files: domains/*/config/flags/{env}.ts`, `env-map: dev=test, qa=qa, prod=prod` (i `paths: ['domains/*/config/flags/**']`) |
| Plik YAML na środowisko z listą flag | `files: config/flags/{env}.yaml`, `path: features`, `rollout-path: rollout` |
| Jeden plik dla jednego środowiska | `environment: prod`, `files: config/flags.prod.json` (bez `env-map`) |
| Flagi przełączane na żywo pod adresem URL | `environment: prod`, `url: https://…/flags`; wyzwalacz `schedule: [{ cron: '*/15 * * * *' }]` zamiast `push` |

Żeby wysyłać przy każdym wdrożeniu, wstaw sam krok adaptera na końcu joba wdrażającego, z `environment:` i plikiem tego
środowiska. Przypnij wersję (`@v0.2.11`); nowsze wydanie ShipScope wchodzi po zmianie tagu.

Tag na GitHubie da się jednak przesunąć (tagi wydań tego repo nie są chronione, `design-docs/SECURITY.md`). Jeśli krok
ma uruchamiać dokładnie ten kod, który przejrzałeś, przypnij commit wydania, z wersją w komentarzu, żeby Dependabot
i czytelnik wiedzieli, która to:

```yaml
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@839b1b082a20798fc1734eb04613fde3d1f42ca5 # v0.2.11
```

Commit dowolnego wydania: `git ls-remote https://github.com/dbqm45/evdt-service-shipscope 'refs/tags/v0.2.11^{}'`
(to tag z adnotacją: bez `^{}` dostaniesz obiekt tagu, nie commit).

## Jira

### Które zadania pokazuje ShipScope?

Admin wybiera tablice w Settings. Każda synchronizacja czyta w całości bieżący okres każdej tablicy (PI, sprint,
wydanie albo miesiąc — zależnie od rytmu tablicy) oraz Epiki jego zadań; pierwsza synchronizacja tablicy bierze też
poprzedni okres. Sprint zadania to ten z synchronizowanej tablicy. Starsze okresy zostają takie, jakie były przy
ostatnim odczycie. Zmiany widać po kolejnej synchronizacji (domyślnie co 15 minut) albo ok. 30 sekund po webhooku z
Jiry. (`server/lib/jira-sync.js`, reguły w `server/lib/jira-model.js`.)

### Czym różni się „sprint” od „PI”?

PI (Program Increment) obejmuje zwykle kilka sprintów. Oba pochodzą z pola Sprint w Jirze: `pi` jest wyliczane z
nazwy sprintu (`27.3.1` → `PI-27.3` albo według szablonu nazwy PI ustawionego dla tablicy), `sprint` to sama
nazwa. Dla tablic, które nie pracują w PI, okresem jest sprint, wydanie albo miesiąc i to pokazuje selektor.
(`server/lib/jira-model.js`.)

### Jak zadanie łączy się z wdrożeniem i dlaczego może mieć „Not deployed”?

Przez klucze Jiry w opisach commitów wdrożenia. Zadanie jest wdrożone na środowisku, gdy udane wdrożenie na nim
wymienia jego klucz albo klucz jednego z jego sub-tasków. Zadanie bez własnego wdrożenia i bez flagi liczy się też
jako wdrożone tam, gdzie wdrożone jest **każde** zadanie, przez które jest „is blocked by” (każde dopasowywane po
kluczu i kluczach jego sub-tasków): błąd naprawiony w sub-tasku Story pokazuje wdrożenia tej Story. Brany jest tylko
jeden poziom blokad. „Not deployed” znaczy, że nic z tego nie pasuje; zadania zsynchronizowane przed dodaniem kluczy
sub-tasków i blokad pasują tylko po własnym kluczu do następnej synchronizacji Jiry. (`issueKeys()`,
`deployedViaBlockers()` w `docs/app-model.js`; `subtaskKeys`/`blockedByKeys` z `server/lib/jira-model.js`.)

## Zakładka Delivery summary

### Co pokazuje?

Zadania, które są dostępne dla użytkowników na PROD — `released` (wdrożone i z włączoną flagą) albo wdrożone bez
flagi, na którą trzeba czekać — pogrupowane po okresie i sprincie (od najnowszych) i podzielone na „Features &
Improvements” oraz „Bug Fixes”. Niewydane zadania nie są pokazywane. Każda pozycja ma plakietkę statusu na PROD,
klucz Jiry i datę pierwszego trafienia na PROD. Filtr Service zawęża listę do jednej aplikacji.
(`docs/app-release-notes.js`, `issueIsReleasedToProd`, `earliestProdDeployedAt`.)

### Dlaczego jest pusto, choć Jira jest połączona?

W wybranym okresie nic jeszcze nie trafiło na PROD albo opisy commitów wdrożeń nie wymieniają kluczy tych zadań ani
ich sub-tasków (tak zadanie łączy się z deploymentem; commit z samym kluczem sub-taska liczy się dla jego Story). Sprawdź w Settings połączenie z Jirą i czas synchronizacji tablic.

## Aktualność danych

### Co znaczy „synced HH:MM” w nagłówku?

Najnowsza udana synchronizacja deploymentów któregokolwiek repozytorium workspace'u. Repozytorium, którego
synchronizacja się nie udaje, pokazuje błąd w Settings → GitHub.

## Poświadczenia

W repozytoriach aplikacji nie ma żadnych sekretów. Workspace łączy GitHub App ShipScope (instalowaną przez
organizację, tylko na wybranych repozytoriach, z dostępem do odczytu) i Jirę (logowanie przez Atlassian; ShipScope
przechowuje tylko zaszyfrowany refresh token). Źródła flag mają własne tokeny, tworzone i unieważniane w Settings.
