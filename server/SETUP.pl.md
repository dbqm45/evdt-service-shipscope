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
