# Konfiguracja ShipScope (serwer): wymagania i ustawienia

Co trzeba ustawić **poza kodem** (na GitHubie, w Renderze, w `.env`), żeby serwer w `server/` działał.
Szczegóły techniczne (trasy, model bezpieczeństwa, testy) są w [README.md](README.md). Krótka ścieżka „zaktualizuj, wdróż,
przetestuj” krok po kroku: [TESTY-RECZNE.pl.md](TESTY-RECZNE.pl.md).

Sekretów (client secret, klucz prywatny `.pem`, hasła do bazy) nigdy nie wklejaj do repo, czatu ani issue —
tylko do `server/.env` (lokalnie, jest w `.gitignore`) albo do zmiennych środowiskowych w Renderze.

## 1. GitHub App

ShipScope używa jednej GitHub App do dwóch rzeczy: logowania użytkowników i odczytu deploymentów z
podłączonych repozytoriów.

Gdzie: **github.com → awatar → Settings → Developer settings → GitHub Apps → New GitHub App** (albo
**Organizacja → Settings → Developer settings → GitHub Apps**, jeśli aplikacja ma należeć do organizacji).
Edycja istniejącej: ta sama lista → **Edit** przy aplikacji.

Zalecane są **dwie aplikacje**: jedna do pracy lokalnej (`http://localhost:3000`), druga do wdrożenia
(adres z Rendera). Wszystkie ustawienia poniżej robisz w każdej z nich, z jej własnym adresem.

### Ustawienia ogólne (zakładka *General*)

| Pole | Wartość | Po co |
|---|---|---|
| Callback URL | `<adres>/auth/github/callback` | Powrót po zalogowaniu |
| Setup URL | `<adres>/github/setup` | Powrót po instalacji aplikacji na repozytoriach |
| Redirect on update | zaznaczone | Powrót do ShipScope także po zmianie listy repozytoriów |
| Request user authorization (OAuth) during installation | **odznaczone** | ShipScope sam loguje użytkownika po instalacji, żeby sprawdzić, że ma on dostęp do tej instalacji |
| Webhook → Active | zaznaczone (opcjonalnie) | Deploy pojawia się w ShipScope w ciągu minuty, a nie przy następnej synchronizacji |
| Webhook URL | `<adres>/webhooks/github` | Musi być publiczny (lokalnie: zostaw webhook wyłączony) |
| Webhook secret | losowy, min. 20 znaków (`openssl rand -hex 32`) | Ten sam do `GITHUB_APP_WEBHOOK_SECRET`; ShipScope odrzuca dostawy bez zgodnego podpisu |
| Where can this GitHub App be installed? | Any account | Żeby mogły ją zainstalować inne organizacje (tenanci) |

`<adres>` to `http://localhost:3000` lokalnie albo publiczny adres https serwisu `shipscope-web` w Renderze.
Musi się zgadzać z `PUBLIC_BASE_URL`.

### Uprawnienia (zakładka *Permissions & events* → *Repository permissions*)

Wszystkie tylko do odczytu (**Read-only**). Nic więcej nie jest potrzebne — żadnych uprawnień do zapisu,
żadnych uprawnień organizacji ani konta.

| Uprawnienie | Wymagane? | Do czego | Co się dzieje bez niego |
|---|---|---|---|
| Metadata | tak (GitHub ustawia samo) | Lista repozytoriów instalacji | — |
| Deployments | tak | Lista deploymentów i ich statusów | Synchronizacja nic nie pobierze (błąd przy repo) |
| Contents | tak | Zakres commitów między deployami (zadania z Jiry), tagi i release'y (wersja), plik wersji, drzewa git (rozjazd środowisk) | Brak wersji, powiązanych zadań i rozjazdu; synchronizacja zgłasza błąd przy repo |
| Actions | opcjonalne | Rozpoznanie, czy deploy uruchomiono ręcznie (`workflow_dispatch`) | Wszystko działa, tylko znaczek „manual” nigdy się nie pojawia |

Przy włączonym webhooku w **Subscribe to events** (na dole tej zakładki) zaznacz **Deployment status**. Nic
więcej nie jest potrzebne; inne zdarzenia ShipScope przyjmuje i pomija.

Po dodaniu nowego uprawnienia do istniejącej aplikacji (**Save changes** na dole strony) GitHub prosi
właściciela każdej instalacji o akceptację. Zaakceptuj ją w **Settings → Applications → Installed GitHub
Apps → aplikacja → Configure** (albo w ustawieniach organizacji): na górze jest baner z prośbą o przegląd
uprawnień. Do czasu akceptacji instalacja działa na starych uprawnieniach.

Nowe uprawnienie działa od następnej synchronizacji (co 15 minut) bez restartu serwera. Dotyczy deployów
zsynchronizowanych od tej chwili — wcześniej zapisane nie są sprawdzane ponownie.

### Dane do skopiowania

| Skąd | Zmienna środowiskowa |
|---|---|
| Client ID | `GITHUB_APP_CLIENT_ID` |
| Generate a new client secret | `GITHUB_APP_CLIENT_SECRET` |
| App ID | `GITHUB_APP_ID` |
| Nazwa w adresie publicznej strony aplikacji (`github.com/apps/<slug>`) | `GITHUB_APP_SLUG` |
| Private keys → Generate a private key (zawartość pliku `.pem`) | `GITHUB_APP_PRIVATE_KEY` |

Bez trzech ostatnich logowanie działa, ale podłączanie repozytoriów i synchronizacja są wyłączone.

## 2. Zmienne środowiskowe

Lokalnie: `cp server/.env.example server/.env` i uzupełnij. W Renderze: te same nazwy w ustawieniach
serwisów (`render.yaml` ustawia `DATABASE_URL` sam; sekrety mają `sync: false`, czyli wpisujesz je ręcznie).

| Zmienna | Web | Worker | Uwagi |
|---|---|---|---|
| `DATABASE_URL` | tak | tak | Lokalnie z kontenera Postgresa; w Renderze z bazy `shipscope-db` |
| `DATABASE_SSL=false` | tylko lokalnie | tylko lokalnie | W Renderze nie ustawiaj (TLS jest wymagany) |
| `PUBLIC_BASE_URL` | tak | opcjonalnie | Adres serwisu widziany z przeglądarki; `https` włącza ciasteczka `Secure`. Workerowi potrzebny do webhooków Jiry (rejestruje je na `<adres>/webhooks/jira`); bez publicznego `https` Jira synchronizuje się tylko okresowo |
| `GITHUB_APP_WEBHOOK_SECRET` | opcjonalnie | — | Sekret webhooka GitHub App (sekcja 1); bez niego `/webhooks/github` jest wyłączone |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | tak | — | Logowanie |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | tak | tak | Podłączanie repozytoriów (web) i synchronizacja (worker) |
| `SYNC_INTERVAL_MINUTES` | — | opcjonalnie | Co ile minut synchronizacja (1–1440, domyślnie 15) |
| `DASHBOARD_DIR` | opcjonalnie | — | Gdzie są pliki dashboardu (`docs/`); bez nich strona `/t/<id>/` odpowiada 503 |
| `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` | tak | tak | Aplikacja OAuth w Atlassian (sekcja 5); bez nich połączenie z Jirą jest wyłączone |
| `TOKEN_ENCRYPTION_KEY` | tak | tak | Klucz szyfrujący zapisane tokeny Jiry: `openssl rand -base64 32`. Zmiana klucza = każdy tenant łączy Jirę od nowa |

## 3. Pierwsze uruchomienie (po stronie użytkownika)

Wszystko poniżej da się zrobić na stronie ustawień `/t/<id>/settings` (link „Settings” w nagłówku dashboardu);
w nawiasach są odpowiadające jej wywołania API, gdyby ktoś wolał skrypt.

1. Zaloguj się przez GitHuba — bez tenanta trafisz na `/start`, gdzie go tworzysz (`POST /tenants`).
2. Jako admin tenanta zainstaluj GitHub App na repozytoriach z deploymentami (sekcja GitHub → „Install the GitHub
   App”, `/tenants/<id>/github/install`) i wybierz śledzone repozytoria („Repositories” → „Track”).
3. Opcjonalnie, per repozytorium: plik wersji i ścieżki ignorowane przy rozjeździe
   (`PUT /tenants/<id>/github/repos/<repoId>/settings`), np.
   `{ "versionFile": "trigger.properties", "driftIgnorePaths": [".github/", "README.md"] }`.
4. Opcjonalnie: czas przechowywania historii deploymentów (sekcja Workspace, `PUT /tenants/<id>/settings`,
   `deploymentRetentionDays` 7–730, domyślnie 90).
5. Zaproś resztę zespołu linkiem (sekcja Workspace → „Create invitation link”, `POST /tenants/<id>/invitations`).
   Link jest pokazywany tylko raz.

Pierwsze dane pojawią się po najbliższej synchronizacji workera (do 15 minut).

## 4. Feature flagi (opcjonalnie)

ShipScope nie odczytuje flag sam: każdy trzyma je po swojemu (pliki build-time, API w runtime, usługa
zewnętrzna typu LaunchDarkly/Unleash), więc to Twój system **wysyła** ich stan. Bez flag po prostu nic nie
wysyłasz — dashboard działa, panel flag jest pusty.

### Źródła flag

Źródło to nazwany nadawca, np. „LaunchDarkly”, „CI frontendu”, „Backend API”. Admin tworzy je raz:

```
POST /tenants/<id>/flag-sources
{ "name": "LaunchDarkly", "kind": "runtime" }
```

- `kind`: `build` (wartość wbudowana przy budowaniu aplikacji) albo `runtime` (przełączana na żywo — backend,
  usługa flag).
- `priority` (opcjonalnie, 0–1000; domyślnie 0 dla `build`, 100 dla `runtime`): gdy kilka źródeł tego samego
  rodzaju podaje tę samą flagę, wygrywa wyższy priorytet, a przy równym — nowsza zmiana. Dashboard pokazuje
  wartość `runtime`, jeśli jest, inaczej `build`.
- `repoId` (opcjonalnie): śledzone repozytorium, do którego należą flagi tego źródła (komponent w dashboardzie).
  Usługa flag wspólna dla wielu serwisów może go nie mieć.

W odpowiedzi jest token (`shpi_...`) — pokazany **tylko raz**, zapisz go od razu jako sekret (np. GitHub Actions
secret `SHIPSCOPE_FLAGS_TOKEN`). Kolejny token do tego samego źródła (rotacja bez przerwy w działaniu):
`POST /tenants/<id>/flag-sources/<sourceId>/tokens`; unieważnienie: `DELETE /tenants/<id>/ingest-tokens/<tokenId>`.
Lista źródeł z datą ostatniego użycia tokenów: `GET /tenants/<id>/flag-sources`; zmiana nazwy, rodzaju, priorytetu
lub komponentu: `PUT /tenants/<id>/flag-sources/<sourceId>`.

### Wysyłanie stanu

Źródło wysyła **pełny stan** swoich flag dla środowisk, które zna — po każdej zmianie albo cyklicznie (wysłanie
tego samego stanu niczego nie zmienia):

```bash
curl -sf -X POST "$SHIPSCOPE_URL/api/flags/ingest" \
  -H "Authorization: Bearer $SHIPSCOPE_FLAGS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": 2,
    "changedBy": "ci",
    "observations": [
      { "key": "newCheckout", "env": "test", "state": "on" },
      { "key": "newCheckout", "env": "prod", "state": "partial", "rollout": 25 },
      { "key": "darkMode",    "env": "prod", "state": "off", "changedAt": "2026-10-16T09:30:00Z" }
    ],
    "flags": [
      { "key": "newCheckout", "description": "Nowy proces zakupu", "jiraKeys": ["ABC-123"] }
    ]
  }'
```

- `state`: `on`, `off` albo `partial` (włączona dla części użytkowników; `rollout` to procent, opcjonalnie).
- `env`: `test`, `qa` albo `prod`.
- **Pełny stan:** flaga, której źródło już nie podaje w środowisku obecnym w wiadomości, zostaje oznaczona jako
  usunięta (np. kod z flagą został wycięty) i znika z dashboardu; wróci, gdy znów się pojawi. Inne środowiska
  wiadomość zostawia w spokoju. Środowiska można podać jawnie: `"environments": ["prod"]` z pustą listą
  `observations` oznacza „w prod nie ma już żadnych flag z tego źródła”.
- Tylko zmiany zamiast pełnego stanu: `"complete": false` — wtedy nic nie jest usuwane.
- `changedAt` (opcjonalnie): kiedy flaga naprawdę się zmieniła, jeśli wysyłasz z opóźnieniem; inaczej liczy się
  moment odbioru. Musi być w przedziale od 7 dni wstecz do 5 minut naprzód. Spóźniona wiadomość ze starszą datą
  nie nadpisze nowszej wartości (w odpowiedzi liczona jako `stale`).
- `flags` (opcjonalnie): opis i powiązane zadania z Jiry, tylko dla flag z tej samej wiadomości — to po nich
  dashboard liczy, czy funkcja jest już dostępna dla użytkowników („released”), czy tylko wdrożona.

Odpowiedź: `{ source, flags, changed, removed, stale, created }`. Usunięcie źródła usuwa jego tokeny, wartości
i historię; przestanie śledzenia repozytorium zostawia źródło, tylko bez komponentu.

## 5. Jira (Atlassian OAuth)

Gdzie: **https://developer.atlassian.com/console/myapps/ → Create → OAuth 2.0 integration**. Tak jak przy GitHubie:
osobna aplikacja do pracy lokalnej (np. „ShipScope (dev)”) i do wdrożenia („ShipScope”). Nazwa aplikacji jest
widoczna dla użytkownika na ekranie zgody Atlassian.

| Ustawienie | Wartość |
|---|---|
| Permissions → Jira API | `read:jira-work`, `read:jira-user`, `read:project:jira` (ten ostatni wśród uprawnień szczegółowych / granular; bez niego lista tablic zwraca 401) |
| Permissions → Jira Software (jeśli konsola pokazuje ją osobno) | `read:board-scope:jira-software`, `read:sprint:jira-software` |
| Permissions → Jira API (klasyczne) | `manage:jira-webhook` — rejestracja webhooków, które informują ShipScope o zmianach zadań. **Musi być dodane w konsoli**: ShipScope prosi o nie przy łączeniu, a Atlassian odrzuca zgodę na zakres, którego aplikacja nie ma |
| Authorization → Callback URL | `<adres>/auth/atlassian/callback` (lokalnie `http://localhost:3000/auth/atlassian/callback`) |
| Settings → Client ID / Secret | do `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` |
| Dostęp / dystrybucja | do pracy lokalnej: prywatna (tylko Ty); do wdrożenia: udostępniona (inne firmy łączą swoje Jiry) — Atlassian wymaga wtedy danych dostawcy i polityki prywatności |

Webhooki Jiry: worker sam rejestruje jeden webhook na tenanta (zmiany zadań w projektach wybranych tablic),
odnawia go przed upływem 30 dni i rejestruje od nowa po zmianie tablic. Działa to tylko przy publicznym adresie
`https` (`PUBLIC_BASE_URL` u workera) i połączeniu z zakresem `manage:jira-webhook`. Połączenie sprzed tej zmiany
trzeba odnowić („Reconnect Jira” w ustawieniach); do tego czasu strona ustawień pokazuje „instant updates off”, a
synchronizacja działa jak dotąd, co 15 minut.

`offline_access` (odświeżanie dostępu bez obecności użytkownika) ShipScope prosi sam przy łączeniu — w konsoli się
go nie zaznacza. Wszystkie uprawnienia są tylko do odczytu. ShipScope prosi dokładnie o zakresy z listy w kodzie
(`SCOPES` w `server/lib/atlassian.js`) — sama zmiana w konsoli nic nie da, a po dodaniu nowego zakresu do kodu
każdy tenant musi połączyć Jirę ponownie, żeby udzielić zgody na nowy zakres.

Połączenie (admin tenanta): otwórz `/tenants/<id>/jira/connect`, zaakceptuj dostęp w Atlassian. Jeśli konto ma
kilka witryn Jira, wybierz jedną: `PUT /tenants/<id>/jira/site` z `{ "cloudId": "..." }` (lista w
`GET /tenants/<id>/jira`). Działanie sprawdzisz przez `GET /tenants/<id>/jira/projects`. Gdy dostęp zostanie
odwołany w Atlassian albo wygaśnie, `GET /tenants/<id>/jira` pokaże `lastError` — wystarczy połączyć ponownie.

Synchronizacja zadań (admin tenanta):

1. Lista tablic z witryny: `GET /tenants/<id>/jira/boards`, z typem każdej: `scrum` (projekt company-managed),
   `simple` (projekt team-managed) albo `kanban`. Wybrać można każdą; tablica bez sprintów (kanban albo team-managed
   z wyłączonymi sprintami) synchronizuje się według wydań albo miesięcy (rytmy niżej).
2. Wybór tablic: `PUT /tenants/<id>/jira/boards` z `{ "boardIds": [10, 11] }`. Tablica wyznacza zespół: synchronizowane
   są tylko zadania z jej sprintów (w rytmach `release` i `flow` — z jej projektu).
3. Synchronizacja od razu: `POST /tenants/<id>/jira/sync` (worker i tak robi to co przebieg, domyślnie co 15 minut).
   Pierwsza synchronizacja tablicy pobiera bieżący i poprzedni przyrost, kolejne tylko bieżący.

Rytm tablicy (każda tablica osobno, więc zespoły SAFe i nie-SAFe mogą być w jednym tenancie):
`PUT /tenants/<id>/jira/boards/<boardId>` z `{ "rhythm": "...", "piTemplate": null }`.

| `rhythm` | Działanie |
|---|---|
| `auto` (domyślnie) | Jeśli któryś sprint tablicy ma nazwę w konwencji PI (`Sparks 27.3.2` → `PI-27.3`), sprinty są grupowane w PI; w przeciwnym razie każdy sprint jest osobnym przyrostem. Tablica bez sprintów: `release`, jeśli projekt ma niewydaną wersję, inaczej `flow`. |
| `pi` | Sprinty grupowane w PI według szablonu nazwy (albo domyślnej konwencji `27.3.1`). Sprint niepasujący do szablonu jest osobnym przyrostem. |
| `sprint` | Każdy sprint osobno (Scrum), nawet gdy nazwy wyglądają jak PI. |
| `release` | Przyrostem jest wersja projektu tablicy (Fix Version), np. `PAY 1.2`: bieżąca to najbliższa niewydana (według daty wydania), a gdy wszystkie wydane — ostatnia wydana. Zadania: te z tą wersją w projekcie. Wersje zarchiwizowane są pomijane. |
| `flow` | Kanban: przyrostem jest miesiąc kalendarzowy (`Flow 2026-10`): zadania rozwiązane w tym miesiącu, a w bieżącym miesiącu także wszystkie w toku. |

W rytmach `release` i `flow` zakresem jest projekt tablicy (ten, który Jira podaje jako jej lokalizację), a nie jej
filtr; nie są potrzebne nowe uprawnienia ani ponowne połączenie Jiry.

`piTemplate` (tylko z `pi` albo `auto`) — własna konwencja nazw PI, np. `PI {pi} / Iteration {n}` albo `Release {pi} (week {n})`: `{pi}` (wymagane,
dokładnie raz) to numer PI z kropkami, `{n}` numer sprintu, `*` dowolny tekst, reszta dosłownie, bez rozróżniania
wielkości liter. Zmiana rytmu usuwa zapisane zadania tablicy; następna synchronizacja pobiera je ponownie.

Gdy wybrane tablice są w różnych bieżących przyrostach (np. jeden zespół w `PI-27.3`, drugi w `Sprint 7`), dashboard
otwiera się na „Now: PI-27.3, Sprint 7” — zadaniach bieżącego przyrostu każdej tablicy razem (pusty przyrost, np. miesiąc
bez zadań, się nie liczy). Pozostałe przyrosty
są dalej do wyboru w selektorze. Zmiana witryny Jira usuwa wybrane tablice i pobrane zadania.
Worker potrzebuje tych samych trzech zmiennych (`ATLASSIAN_*`, `TOKEN_ENCRYPTION_KEY`) co serwis web.


## 6. Wdrożenie na Render

Wszystko jest opisane w `render.yaml` (Blueprint): serwis web `shipscope-web`, worker `shipscope-worker` i baza
`shipscope-db`. Oba serwisy budują się z katalogu głównego repozytorium (tak, żeby serwis web miał dostęp do
`docs/`, czyli dashboardu i strony ustawień), a migracje bazy uruchamiają się same przed każdym wdrożeniem.

### Przed pierwszym wdrożeniem

1. Osobne aplikacje „produkcyjne”: GitHub App (sekcja 1) i aplikacja Atlassian (sekcja 5) z adresami Rendera.
   Adres serwisu to zwykle `https://shipscope-web.onrender.com` (Render dopisuje końcówkę, gdy nazwa jest zajęta —
   dokładny adres zobaczysz po utworzeniu serwisu i wtedy go poprawisz).
2. Przygotuj wartości (w menedżerze haseł, nigdzie indziej):
   - `TOKEN_ENCRYPTION_KEY`: `openssl rand -base64 32` — **zachowaj kopię**; jej utrata albo zmiana oznacza, że każdy
     tenant łączy Jirę od nowa;
   - `GITHUB_APP_WEBHOOK_SECRET`: `openssl rand -hex 32` (ten sam wpisujesz w GitHub App → Webhook secret);
   - z GitHub App: Client ID, client secret, App ID, slug, klucz prywatny (zawartość `.pem`);
   - z aplikacji Atlassian: Client ID i Secret.

### Utworzenie

1. Render → **New → Blueprint** → połącz repozytorium `dbqm45/evdt-service-shipscope`, gałąź `main`.
2. Render pokaże trzy zasoby z `render.yaml`. Plan `starter` (płatny) jest celowy: darmowa baza wygasa po 30 dniach,
   a darmowy serwis usypia (patrz `context/foundation/infrastructure.md`). Sprawdź aktualne ceny przed akceptacją.
3. Render poprosi o każdą zmienną z `sync: false` — wpisz wartości z listy wyżej. `PUBLIC_BASE_URL` wpisz w **obu**
   serwisach (web: logowanie i ciasteczka; worker: adres, pod który Jira wysyła webhooki).
   `DATABASE_URL` Render ustawia sam; `DATABASE_SSL` zostaw nieustawione.
4. **Apply**. Kolejność: baza → build → migracje (`preDeployCommand`) → start. Nieudana migracja zatrzymuje
   wdrożenie, a poprzednia wersja działa dalej.

### Po utworzeniu

1. Jeśli adres serwisu różni się od wpisanego: popraw `PUBLIC_BASE_URL` w obu serwisach (Render wdroży je ponownie)
   oraz adresy w GitHub App (Callback URL, Setup URL, Webhook URL) i w aplikacji Atlassian (Callback URL).
2. Sprawdź:
   - `https://<adres>/health` → `{"status":"ok","version":"…"}`, `https://<adres>/health/db` → `ok: true`;
   - zaloguj się: bez workspace'u trafisz na `/start`, utwórz go, przejdź do ustawień;
   - GitHub: zainstaluj aplikację, śledź repozytoria; pierwsze deploye w ciągu kilku minut (worker przy starcie
     od razu synchronizuje);
   - Jira: połącz, wybierz tablice, „Sync now”, otwórz dashboard (link „Dashboard” w ustawieniach).
3. Webhooki:
   - GitHub App → **Advanced → Recent Deliveries**: dostawy `deployment_status` powinny mieć odpowiedź **202**;
   - Jira: w ustawieniach „instant updates on” (po pierwszej synchronizacji tablic); zmień zadanie, a w logach workera
     pojawi się `jira webhook sync done`. Jeśli dostawy z Jiry dostają **401**, a w logach serwisu web widać odrzucone
     żądania na `/webhooks/jira` — format podpisu Atlassian różni się od opisanego; synchronizacja co 15 minut
     działa dalej, a logi pozwolą to poprawić.

### Na co dzień

- **Wdrożenia**: każdy merge do `main`, który zmienia `server/**` (albo pliki dashboardu w `docs/`), wdraża się sam;
  commity z danymi botów nie wywołują wdrożeń.
- **Wycofanie**: Render → serwis → **Rollback** do poprzedniego wdrożenia (bez przebudowy). Migracje są tylko „do
  przodu”: wycofanie kodu nie cofa zmian w bazie.
- **Własna domena** (opcjonalnie): po dodaniu w Renderze zmień `PUBLIC_BASE_URL` w obu serwisach i adresy w obu
  aplikacjach (GitHub, Atlassian).
