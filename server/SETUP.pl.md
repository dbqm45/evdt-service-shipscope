# Konfiguracja ShipScope (serwer): wymagania i ustawienia

Co trzeba ustawić **poza kodem** (na GitHubie, w Renderze, w `.env`), żeby serwer w `server/` działał.
Szczegóły techniczne (trasy, model bezpieczeństwa, testy) są w [README.md](README.md).

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
| Webhook → Active | odznaczone | Webhooki nie są jeszcze używane |
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
| `PUBLIC_BASE_URL` | tak | — | Adres serwisu widziany z przeglądarki; `https` włącza ciasteczka `Secure` |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | tak | — | Logowanie |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | tak | tak | Podłączanie repozytoriów (web) i synchronizacja (worker) |
| `SYNC_INTERVAL_MINUTES` | — | opcjonalnie | Co ile minut synchronizacja (1–1440, domyślnie 15) |
| `DASHBOARD_DIR` | opcjonalnie | — | Gdzie są pliki dashboardu (`docs/`); bez nich strona `/t/<id>/` odpowiada 503 |
| `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` | tak | tak | Aplikacja OAuth w Atlassian (sekcja 5); bez nich połączenie z Jirą jest wyłączone |
| `TOKEN_ENCRYPTION_KEY` | tak | tak | Klucz szyfrujący zapisane tokeny Jiry: `openssl rand -base64 32`. Zmiana klucza = każdy tenant łączy Jirę od nowa |

## 3. Pierwsze uruchomienie (po stronie użytkownika)

1. Zaloguj się przez GitHuba i utwórz tenanta (organizację w ShipScope).
2. Jako admin tenanta zainstaluj GitHub App na repozytoriach z deploymentami
   (`/tenants/<id>/github/install`) i wybierz śledzone repozytoria.
3. Opcjonalnie, per repozytorium: plik wersji i ścieżki ignorowane przy rozjeździe
   (`PUT /tenants/<id>/github/repos/<repoId>/settings`), np.
   `{ "versionFile": "trigger.properties", "driftIgnorePaths": [".github/", "README.md"] }`.
4. Opcjonalnie: czas przechowywania historii deploymentów (`PUT /tenants/<id>/settings`,
   `deploymentRetentionDays` 7–730, domyślnie 90).
5. Zaproś resztę zespołu linkiem (`POST /tenants/<id>/invitations`).

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
| Permissions → Jira API | `read:jira-work`, `read:jira-user` |
| Permissions → Jira Software (jeśli konsola pokazuje ją osobno) | `read:board-scope:jira-software`, `read:sprint:jira-software` |
| Authorization → Callback URL | `<adres>/auth/atlassian/callback` (lokalnie `http://localhost:3000/auth/atlassian/callback`) |
| Settings → Client ID / Secret | do `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` |
| Dostęp / dystrybucja | do pracy lokalnej: prywatna (tylko Ty); do wdrożenia: udostępniona (inne firmy łączą swoje Jiry) — Atlassian wymaga wtedy danych dostawcy i polityki prywatności |

`offline_access` (odświeżanie dostępu bez obecności użytkownika) ShipScope prosi sam przy łączeniu — w konsoli się
go nie zaznacza. Wszystkie uprawnienia są tylko do odczytu.

Połączenie (admin tenanta): otwórz `/tenants/<id>/jira/connect`, zaakceptuj dostęp w Atlassian. Jeśli konto ma
kilka witryn Jira, wybierz jedną: `PUT /tenants/<id>/jira/site` z `{ "cloudId": "..." }` (lista w
`GET /tenants/<id>/jira`). Działanie sprawdzisz przez `GET /tenants/<id>/jira/projects`. Gdy dostęp zostanie
odwołany w Atlassian albo wygaśnie, `GET /tenants/<id>/jira` pokaże `lastError` — wystarczy połączyć ponownie.

Synchronizacja zadań (admin tenanta):

1. Lista tablic Scrum z witryny: `GET /tenants/<id>/jira/boards`. Tablice Kanban się nie pojawiają — nie mają
   sprintów, więc nie da się z nich wyznaczyć PI.
2. Wybór tablic: `PUT /tenants/<id>/jira/boards` z `{ "boardIds": [10, 11] }`. Tablica wyznacza zespół: synchronizowane
   są tylko zadania z jej sprintów.
3. Synchronizacja od razu: `POST /tenants/<id>/jira/sync` (worker i tak robi to co przebieg, domyślnie co 15 minut).
   Pierwsza synchronizacja tablicy pobiera bieżące i poprzednie PI, kolejne tylko bieżące.

PI wynika z nazw sprintów: `Sparks 27.3.2` należy do `PI-27.3`. Jeśli sprinty nazywają się inaczej (np. `Sprint 42`),
każdy sprint jest osobnym „PI” w widokach. Zmiana witryny Jira usuwa wybrane tablice i pobrane zadania.
Worker potrzebuje tych samych trzech zmiennych (`ATLASSIAN_*`, `TOKEN_ENCRYPTION_KEY`) co serwis web.

