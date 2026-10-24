# Wdrożenie

*English version: [ONBOARDING.md](ONBOARDING.md)*

Co zrobić, w jakiej kolejności, żeby dane trafiły do workspace'u ShipScope. Jak to działa pod spodem, opisuje
`CLAUDE.md`; jak liczona jest każda wartość — `FAQ.pl.md`.

**Wymagane najpierw:** potok wdrożeniowy każdej aplikacji musi tworzyć prawdziwy **GitHub Deployment** ze
statusami dla każdego środowiska, na które wdraża (`test`/`qa`/`prod`). ShipScope czyta historię wdrożeń wyłącznie
przez GitHub Deployments API. W GitHub Actions job z `environment: test` (albo `qa`, `prod`) tworzy go przy każdym
uruchomieniu. Nazwy środowisk są dopasowywane luźno (`production` → `prod`, `dev` → `test`, `preprod` to nie
`prod`); inne (`staging`, `uat`) są pomijane.

## Zakładanie workspace'u

Zaloguj się przez GitHuba i utwórz workspace pod adresem `/start`. Jego strona Settings (`/t/<workspace>/settings`)
zaczyna się listą kontrolną **Getting started**, która pokazuje, na jakim etapie jesteś; admin może ją ukryć. Kroki:

1. **Install the GitHub App** — zainstaluj aplikację na organizacji albo koncie GitHub, z którego wdrażasz
   (Settings → GitHub → Install the GitHub App). GitHub odeśle cię z powrotem; instalacja zostaje połączona tylko wtedy, gdy twoje
   własne konto GitHub ją widzi.
2. **Choose repositories to track** — kliknij Track repository, a potem Track przy każdym repozytorium, którego deploymenty chcesz widzieć.
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
   utwórz dla niego token i niech wysyła pełny stan swoich flag do `POST /api/flags/ingest` — zob.
   [Wysyłanie feature flag](#wysyłanie-feature-flag). W Jira → Feature flags in Jira można też wskazać pole albo
   prefiks etykiety, które łączą zadania Jiry z flagami.
7. **Invite your team** — jeden link zaproszenia na osobę. Członkowie widzą wszystko; admini mogą zmieniać
   ustawienia.

W sekcji Workspace admin ustawia też, ile dni historii deploymentów przechowywać (7–730), i może usunąć workspace.

## Wysyłanie feature flag

ShipScope nigdy nie czyta twoich flag: to, co je przechowuje, wysyła ich stan do ShipScope
(`design-docs/ADR-001-flags-pushed-from-outside.md`). Dzięki temu nie ma znaczenia, gdzie flagi są — w pliku
w repozytorium, pod adresem aplikacji, w AWS AppConfig czy w serwisie flag. Każde takie miejsce to jedno
**źródło flag** (flag source):

1. W Settings → Sources dodaj źródło: nazwę, rodzaj — **build** (wartość wbudowana przy budowaniu, np. plik
   w repozytorium) albo **runtime** (przełączana na żywo, np. AppConfig albo serwis flag) — priorytet (gdy kilka źródeł
   jednego rodzaju podaje tę samą flagę, wygrywa wyższy) i opcjonalnie komponent (śledzone repozytorium), do którego
   należą jego flagi. Dashboard pokazuje wartość runtime, jeśli jest, inaczej build.
2. Utwórz token dla źródła. Jest pokazany tylko raz: zapisz go jako sekret tam, gdzie działa nadawca (np. sekret
   GitHub Actions `SHIPSCOPE_FLAGS_TOKEN`). Drugi token pozwala na rotację bez przerwy.
3. Niech nadawca wysyła **pełny stan** flag źródła po każdej zmianie albo cyklicznie. Ponowne wysłanie tego samego
   stanu niczego nie zmienia, więc harmonogram jest bezpieczny.

### Wiadomość

`POST /api/flags/ingest`, `Authorization: Bearer <token>`, `Content-Type: application/json`:

```json
{
  "schemaVersion": 2,
  "environments": ["test", "prod"],
  "changedBy": "ci",
  "observations": [
    { "key": "newCheckout", "env": "test", "state": "on" },
    { "key": "newCheckout", "env": "prod", "state": "partial", "rollout": 25 },
    { "key": "darkMode", "env": "prod", "state": "off" }
  ],
  "flags": [
    { "key": "newCheckout", "description": "Nowy proces zakupu", "jiraKeys": ["ABC-123"] }
  ]
}
```

- `observations` — jeden wpis na flagę i środowisko: `key` (wielkość liter ma znaczenie; litery, cyfry i `_ . : -`; nie nazwa, którą ma
  każdy obiekt JavaScript, np. `constructor` czy `toString`),
  `env` (`test`, `qa` albo `prod`: swoje nazwy mapujesz sam, np. `staging` → `qa`, `production` → `prod`), `state`
  (`on`, `off` albo `partial` — włączona dla części użytkowników, z opcjonalnym procentem `rollout`) i opcjonalny
  `changedAt` (ISO 8601), gdy wysyłasz z opóźnieniem; musi mieścić się w ostatnich 7 dniach, a starsza wartość nigdy
  nie zastąpi nowszej.
- **Pełny stan:** flaga, której źródło już nie podaje w środowisku objętym wiadomością, zostaje oznaczona jako
  usunięta i znika z dashboardu (wraca, gdy znów się pojawi). `environments` wskazuje objęte środowiska (domyślnie
  te z `observations`); `"environments": ["prod"]` bez obserwacji znaczy „w prod nie ma już flag z tego źródła”.
  Innych środowisk wiadomość nie rusza. Żeby wysłać tylko zmiany, dodaj `"complete": false` — wtedy nic nie jest
  usuwane.
- `flags` (opcjonalnie) — opis i zadania w Jirze stojące za flagą, tylko dla flag z tej samej wiadomości. Mogą też
  pochodzić z samej Jiry albo zostać ustawione ręcznie w Settings; zob. FAQ, „Feature flags”.
- `changedBy` (opcjonalnie) — pokazywane jako autor zmiany; domyślnie nazwa źródła.
- Najwyżej 5000 obserwacji w jednej wiadomości.

Odpowiedź to `{ source, flags, changed, removed, stale, created }`; błędna wiadomość dostaje 400 z powodem, nieznany
albo unieważniony token — 401. 429 (z jednego tokenu więcej niż seria 60 wiadomości, potem jedna na sekundę) i 503
(poprzednia wiadomość workspace'u jeszcze się zapisuje) są chwilowe: odczekaj tyle, ile mówi nagłówek `Retry-After`,
i wyślij ponownie; adapter robi to sam. Dokładny format to JSON Schema (draft-07), publikowany przez każdy serwer ShipScope pod
`GET /api/flags/ingest/schema` (w repozytorium: `server/schemas/flags-ingest.v2.schema.json`); jeśli piszesz
własnego nadawcę, sprawdzaj z nim wiadomość przed wysłaniem.

### Gdzie są twoje flagi

Każdy nadawca robi to samo: odczytuje flagi, zamienia je na jedną mapę `{ klucz: wartość }` na środowisko i ją
wysyła. Tabela zbiera typowe miejsca; zamianę i wysyłkę robi [adapter flag](#kiedy-użyć-adaptera), a bez niego to samo
robią [przepisy z `jq`](#bez-adaptera-przepisy-z-jq).

| Flagi są w | Rodzaj | Jak wysyłać |
| --- | --- | --- |
| Pliku w repozytorium (`flags.json`, YAML, konfiguracja w TypeScript/JavaScript, `.properties`, `.env`) | build | Krok w potoku wdrożeniowym, po jobie wdrożenia każdego środowiska: odczytaj plik tego środowiska, zamień, wyślij. |
| Endpoincie aplikacji (np. `/internal/flags`) | runtime | Zadanie cykliczne (np. co 15 minut) i/lub krok po każdym wdrożeniu: pobierz adres dla środowiska, zamień, wyślij. |
| AWS AppConfig (profil feature flags) | runtime | Zadanie cykliczne czytające każde środowisko AppConfig przez `aws appconfigdata` (poświadczenia przez OIDC, nie klucze) albo rozszerzenie AppConfig na `ON_DEPLOYMENT_COMPLETE` wywołujące małą Lambdę, która wysyła stan. |
| Azure App Configuration | runtime | Zadanie cykliczne czytające feature flagi dla każdej etykiety (`az appconfig feature list`); flaga `conditional` to `partial`. |
| Serwisie flag (LaunchDarkly, Unleash, Flagsmith, ConfigCat, GrowthBook, Flipt, …) | runtime | Zadanie cykliczne czytające API serwisu dla każdego środowiska albo webhook serwisu wywołujący małą funkcję, która odczytuje i wysyła stan. |
| ConfigMapie Kubernetesa albo zmiennych środowiskowych | build albo runtime | Krok po każdym wdrożeniu: `kubectl get configmap <nazwa> -o json`, weź `.data`, zamień, wyślij. |

Jedno źródło na jedno miejsce. Gdy ta sama flaga jest i wbudowana w build, i przełączana na żywo, utwórz dwa źródła
(build i runtime): dashboard pokaże wartość runtime i zachowa obie historie.

### Kiedy użyć adaptera

| Twoje flagi | Czego użyć |
| --- | --- |
| W plikach w repozytorium: JSON, YAML, TypeScript/JavaScript, `.properties`, `.env` | **Adapter**, tryb plików |
| Pod adresem URL, który zwraca JSON albo YAML (endpoint aplikacji, API serwisu flag) | **Adapter**, tryb URL |
| W AWS AppConfig, Azure App Configuration, ConfigMapie Kubernetesa, serwisie flag z własnym CLI | Pobierz je tym narzędziem w kroku wcześniej, potem **adapter**, tryb plików |
| Liczone w kodzie, importowane z innego pliku, XML, TOML, własny format | Mały krok, który zapisze je jako JSON, potem **adapter** ([każdy inny układ](#adapter-flag-przykłady)) |
| Usługa albo skrypt, który sam umie wysłać żądanie HTTP (np. webhook serwisu flag) | **Bez adaptera**: wyślij [wiadomość](#wiadomość) prosto do ShipScope |

Adapter działa tam, gdzie twój potok: jako GitHub Action w GitHub Actions, z wiersza poleceń (`node` 20 lub nowszy)
w GitLabie, Jenkinsie, Azure DevOps albo cronie.

**Kiedy go uruchamiać.** Flagi build (w plikach, które jadą z kodem): na końcu joba wdrażającego każde środowisko,
żeby ShipScope poznał flagi razem z wdrożeniem, albo raz po każdym merge'u do gałęzi głównej, gdy pliki opisują
wszystkie środowiska. Flagi runtime (przełączane na żywo): cyklicznie, np. co 15 minut, i po zmianie, jeśli twoje
narzędzie umie uruchomić potok. Ponowne wysłanie tego samego stanu niczego nie zmienia.

### Adapter krok po kroku

1. **Przyjrzyj się flagom.** Gdzie są, jeden plik na środowisko czy jeden na wszystkie, i jaki mają kształt (obiekt
   `{ klucz: wartość }`, obiekt na flagę, lista)? Czy flaga bywa przełączana bez wdrożenia? Wtedy to źródło runtime,
   inaczej build.
2. **Utwórz źródło.** Settings → Sources → dodaj źródło (nazwa, rodzaj, opcjonalnie komponent) i skopiuj token.
   Jedno źródło na jedno miejsce, w którym są flagi.
3. **Zapisz dane dostępu** tam, gdzie działa potok: token jako sekret (`SHIPSCOPE_FLAGS_TOKEN`), adres ShipScope jako
   zmienną (`SHIPSCOPE_URL`).
4. **Napisz krok** z opcjami dla swojego układu (tabela niżej i przykłady dalej).
5. **Wypróbuj z `dry-run: true`** (`--dry-run` w wierszu poleceń). Nic nie jest wysyłane; log pokazuje wiadomość ze
   wszystkimi flagami i środowiskami oraz pominięte pliki. Sprawdź klucze, wartości i środowiska.
6. **Wyślij naprawdę:** usuń `dry-run`, dodaj `shipscope-url` i `token`. Log kończy się tym, co zrobił ShipScope
   (`3 flags for prod, 3 changed, 0 removed`).
7. **Sprawdź w ShipScope:** przy źródle widać „received” z liczbami, flagi są w Settings → Flags i na
   dashboardzie. Od teraz odrzucona wiadomość też jest tam widoczna, z powodem.

**Dobór opcji** — decyduje o nich wygląd twoich plików:

| Twoje pliki | Opcje |
| --- | --- |
| Jeden plik dla jednego środowiska | `environment: prod`, `files: config/flags.prod.json` |
| Plik na środowisko, nazwa w ścieżce | `files: config/flags/{env}.yaml`; nazwy inne niż test, qa, prod: `env-map: dev=test, staging=qa, production=prod` |
| Kilka plików (domeny, aplikacje) dla tych samych środowisk | wzorzec: `files: domains/*/config/flags/{env}.ts` (klucze muszą być między nimi unikalne albo źródło na domenę) |
| Flagi wewnątrz większej konfiguracji (`{ apiUrl: …, features: { … } }`) | `path: features` |
| Każda flaga to obiekt (`{ newCheckout: { enabled: true } }`) | `value-path: enabled` |
| Lista flag (`[{ name: newCheckout, enabled: true }]`) | nic, jeśli pola nazywają się key/name/id/flag i enabled/value/state/on/status/active; inaczej `key-field` i `value-path` |
| Lista włączonych flag (`[newCheckout, darkMode]`) | `path` do listy |
| Procent obok wartości (`rollout: 25`) | `rollout-path: rollout` |
| Flagi wśród innych ustawień (`feature.newCheckout=true`) | `prefix: feature.` |
| Plik TypeScript z kilkoma eksportowanymi obiektami | `path: <nazwa const>` |

**Gdy coś nie działa**, krok kończy się jedną linią z nazwą pliku i flagi:

| Komunikat | Co zrobić |
| --- | --- |
| `no file matches …` | Wzorzec jest względem katalogu głównego repozytorium; sprawdź go `ls` w tym samym kroku. |
| `Skipped …: "local" is not in env-map` | Normalne dla środowisk, których ShipScope nie pokazuje; dopisz nazwę do `env-map`, jeśli ma się liczyć. |
| `cannot read … as on, off or a rollout percentage` | Ta wartość nie jest flagą (inne ustawienie): zawęź `path` albo `prefix`; dla obiektów na flagę ustaw `value-path`. |
| `… is not written out as a value` | Wartość wyliczana albo importowana w pliku `.ts`: wpisz ją wprost albo wypisz flagi jako JSON w kroku wcześniej. |
| `several objects (…); name the one with the flags in path` | Ustaw `path` na nazwę const. |
| `flag x differs between a and b` | Dwa pliki dają jednej fladze różne wartości w jednym środowisku: użyj osobnego źródła dla każdej grupy plików. |
| `ShipScope answered 401` | Zły albo unieważniony token albo sekret nie trafia do kroku. |
| `ShipScope answered 429` albo `503` | Chwilowe; adapter już odczekał i spróbował jeszcze trzy razy. Wysyłaj rzadziej albo spróbuj później. |
| `ShipScope answered 400: …` | Wiadomość łamie regułę (np. klucz ze spacją); powód jest w tej linii i przy źródle w Settings. |

### Adapter flag: przykłady

`adapters/flags/` w tym repozytorium odczytuje flagi z **plików** (JSON, YAML, TypeScript/JavaScript, `.properties`,
`.env`) albo spod **adresu URL**, buduje wiadomość i ją wysyła; `dry-run` tylko ją drukuje. Działa jako GitHub Action i z wiersza poleceń (Node 20+,
bez zależności), z tymi samymi opcjami, opisanymi w [`adapters/flags/README.md`](adapters/flags/README.md). Wartość
flagi może być `true`/`false`, `on`/`off`, `enabled`/`disabled` albo liczbą 0–100 dla częściowego rolloutu.

**Pliki** — na końcu joba wdrażającego każde środowisko (jedno źródło rodzaju build):

```yaml
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@vX.Y.Z   # tag wydania ShipScope
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          environment: prod
          files: config/flags.prod.json      # po jednym w linii; działają wzorce, np. config/flags/*.json
```

Obsługiwane są też pliki YAML, `.properties` i `.env`; `prefix: feature.` zostawia tylko klucze `feature.*`. Kilka
plików trafia do jednej wiadomości, a flaga z różnymi wartościami w dwóch plikach to błąd. Flagi mogą być obiektem
(`{ newCheckout: true }` albo `{ newCheckout: { enabled: true } }` z `value-path: enabled`) albo listą
(`[{ name: newCheckout, enabled: true }]` — pola klucza i wartości adapter znajduje po typowych nazwach albo podajesz
je w `key-field` i `value-path`; `[newCheckout, darkMode]` to lista włączonych flag). `rollout-path: rollout` czyta
procent obok wartości. Tabela kształtów jest w [`adapters/flags/README.md`](adapters/flags/README.md).

**Plik na środowisko, np. monorepo Nx** z `domains/<domena>/config/flags/{local,dev,test,qa,prod}.ts`, w każdym
`export const flags = { newCheckout: true, ... }`. `{env}` we wzorcu oznacza środowisko pliku, więc jeden krok
wysyła wszystkie; `env-map` mówi, która nazwa jest którym środowiskiem ShipScope, a nazwy spoza mapy (`local`) są
pomijane:

```yaml
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@vX.Y.Z
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          files: domains/*/config/flags/{env}.ts
          env-map: dev=test, qa=qa, prod=prod
```

Uruchamiaj to po merge'u do gałęzi głównej (pliki opisują wszystkie środowiska) albo w jobie wdrożenia każdego
środowiska z jednym plikiem tego środowiska (`environment: prod` i `files: domains/*/config/flags/prod.ts`). Pliki
`.ts` są czytane, nie uruchamiane: wartości muszą być wpisane wprost (`true`, `25`, `'off'`), a plik z kilkoma
eksportowanymi obiektami potrzebuje `path: <nazwa const>`. Wszystkie domeny trafiają do jednej wiadomości, więc klucz
użyty w dwóch domenach musi mieć w nich tę samą wartość; gdy domeny powtarzają klucze, każda dostaje własne źródło
i krok (`files: domains/charger/config/flags/{env}.ts`).

**Adres URL** — cyklicznie (jedno źródło rodzaju runtime):

```yaml
on:
  schedule: [{ cron: '*/15 * * * *' }]
jobs:
  flags:
    runs-on: ubuntu-latest
    steps:
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@vX.Y.Z
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          environment: prod
          url: https://app.example.com/internal/flags
          url-headers: |
            Authorization: Bearer ${{ secrets.APP_FLAGS_TOKEN }}
          path: data.flags        # gdzie w odpowiedzi są flagi, jeśli nie na najwyższym poziomie
```

**AWS AppConfig:** najpierw odczytaj profil przez AWS CLI (poświadczenia przez OIDC), potem przekaż plik;
`value-path: enabled` czyta format AppConfig `{ "<flaga>": { "enabled": true } }`:

```yaml
    permissions: { id-token: write, contents: read }
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: '${{ vars.SHIPSCOPE_FLAGS_ROLE }}', aws-region: eu-west-1 }
      - run: |
          TOKEN=$(aws appconfigdata start-configuration-session --application-identifier shop \
            --environment-identifier production --configuration-profile-identifier flags \
            --query InitialConfigurationToken --output text)
          aws appconfigdata get-latest-configuration --configuration-token "$TOKEN" flags.json > /dev/null
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@vX.Y.Z
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          environment: prod
          files: flags.json
          value-path: enabled
```

Tak samo obsłużysz ConfigMap Kubernetesa (`kubectl get configmap <nazwa> -o json > cm.json`, potem `files: cm.json`
i `path: data`) i API serwisu flag (pobierz flagi jego CLI albo `curl`-em, potem `files:`).

**Każdy inny układ.** Opcje opisują większość układów: wzorce z `*`, `**` i `{env}`, `env-map`, `path` (gdzie w pliku
są flagi), `value-path`, `key-field`, `rollout-path` i `prefix`. Gdy nie wystarczą — flagi liczone w kodzie albo
importowane z innego pliku, XML, TOML, własny format — wypisz je jako JSON w kroku przed adapterem, jeden plik na
środowisko, i wskaż je w `files`. Dla TypeScriptu, który importuje flagi, zrobi to mały skrypt w projekcie
(uruchamiany przez `tsx`, bez budowania):

```ts
// tools/shipscope-flags.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { flags as test } from '../apps/web/src/flags.test';
import { flags as qa } from '../apps/web/src/flags.qa';
import { flags as prod } from '../apps/web/src/flags.prod';

mkdirSync('.shipscope', { recursive: true });
for (const [env, flags] of Object.entries({ test, qa, prod })) writeFileSync(`.shipscope/${env}.json`, JSON.stringify(flags));
```

```yaml
      - run: npx tsx tools/shipscope-flags.ts
      - uses: dbqm45/evdt-service-shipscope/adapters/flags@vX.Y.Z
        with:
          shipscope-url: ${{ vars.SHIPSCOPE_URL }}
          token: ${{ secrets.SHIPSCOPE_FLAGS_TOKEN }}
          files: .shipscope/{env}.json
```

**Wiersz poleceń** — wszędzie indziej (GitLab, Jenkins, cron); skopiuj `adapters/flags/` albo sklonuj to repozytorium:

```bash
export SHIPSCOPE_URL=https://shipscope.example.com SHIPSCOPE_FLAGS_TOKEN=shpi_...
node adapters/flags/shipscope-flags.js --env prod --file config/flags.prod.json
node adapters/flags/shipscope-flags.js --file 'domains/*/config/flags/{env}.ts' --env-map dev=test,qa=qa,prod=prod --dry-run
node adapters/flags/shipscope-flags.js --env prod --url https://app.example.com/internal/flags --dry-run
```

Action jest używana prosto z tego repozytorium, więc gdy jest ono prywatne, trzeba pozwolić innym repozytoriom z niej
korzystać (Settings → Actions → General → Access).

### Bez adaptera: przepisy z `jq`

Poniższy konwerter bierze mapę dla jednego środowiska i drukuje wiadomość. Wartość może być `true`/`false`,
`"on"`/`"off"`, `"true"`/`"false"` albo liczbą 0–100 (także jako tekst) dla częściowego rolloutu; `jq` jest
zainstalowany na runnerach GitHuba.

```bash
# to-shipscope.jq — wejście: { "newCheckout": true, "darkMode": "off", "search": 25 }
def value: if type == "string" then ascii_downcase
    | if . == "true" or . == "on" then true elif . == "false" or . == "off" then false else tonumber end
  else . end;
def state: if . == true or (type == "number" and . >= 100) then { state: "on" }
  elif . == false or (type == "number" and . <= 0) then { state: "off" }
  else { state: "partial", rollout: . } end;
{ schemaVersion: 2, environments: [$env],
  observations: [ to_entries[] | { key, env: $env } + (.value | value | state) ] }
```

Wysyłka:

```bash
send_flags() {  # użycie: <mapa flag na stdin> send_flags <środowisko>
  jq --arg env "$1" -f to-shipscope.jq | curl -sS --fail-with-body -X POST "$SHIPSCOPE_URL/api/flags/ingest" \
    -H "Authorization: Bearer $SHIPSCOPE_FLAGS_TOKEN" -H "Content-Type: application/json" --data-binary @-
}
```

- **Plik JSON na środowisko:** `send_flags prod < config/flags.prod.json`. W GitHub Actions uruchom to jako ostatni
  krok joba wdrażającego na `prod`, z `SHIPSCOPE_URL` jako zmienną i `SHIPSCOPE_FLAGS_TOKEN` jako sekretem.
- **YAML:** `yq -o=json config/flags.yaml | jq .prod | send_flags prod`.
- **`.properties` albo `.env`:** wybierz linie flag po prefiksie, np. `feature.newCheckout=true`:
  `jq -Rn '[inputs | capture("^feature\\.(?<k>[^=]+)=(?<v>.*)$") | { (.k): .v }] | add // {}' application-prod.properties | send_flags prod`.
- **Endpoint:** `curl -sSf https://app.example.com/internal/flags | send_flags prod`.
- **AWS AppConfig:** profil feature flags zwraca `{ "<flaga>": { "enabled": true, ... } }`:

  ```bash
  TOKEN=$(aws appconfigdata start-configuration-session --application-identifier shop \
    --environment-identifier production --configuration-profile-identifier flags \
    --query InitialConfigurationToken --output text)
  aws appconfigdata get-latest-configuration --configuration-token "$TOKEN" flags.json > /dev/null
  jq 'map_values(.enabled)' flags.json | send_flags prod
  ```

Gdy coś się nie pokazuje, odpowiedź na wysyłkę mówi dlaczego (`400` ze wskazaniem pola, `401` przy tokenie).
Settings → Sources pokazuje to samo przy każdym źródle: kiedy przyszła jego ostatnia wiadomość i co zmieniła albo
że została odrzucona i dlaczego, oraz kiedy każdy token był ostatnio użyty. Wiadomość z nieznanym tokenem nie należy
do żadnego źródła i dostaje tylko swoje 401.
