# Testy ręczne: co sprawdzić i jak, krok po kroku

Lista rzeczy, których testy automatyczne nie sprawdzą, bo wymagają prawdziwych kont i usług: GitHuba, Atlassiana,
Rendera i przeglądarki. Testy w repozytorium (`npm test` w `server/` i w katalogu głównym) używają atrap tych usług.
Ta lista potwierdza, że prawdziwe usługi zachowują się tak samo jak atrapy.

Jak z niej korzystać:
- Bloki są w kolejności zależności. Każdy zaczyna się od tego, czego wymaga.
- Zaznaczaj `[x]` w kopii pliku albo w issue.
- Przy każdym kroku jest **Oczekiwane**. Jeśli wynik jest inny, zapisz krok, adres, odpowiedź (status i treść) oraz
  fragment logu i przekaż dalej. Sekretów (tokenów, client secretów, kluczy `.pem`) nie wklejaj nigdzie.

Konfiguracja, do której odsyłają kroki, jest w [SETUP.pl.md](SETUP.pl.md) (sekcje 1–6).

| Blok | Gdzie | Wymaga | Czas |
|---|---|---|---|
| [A. Lokalnie: start](#a-lokalnie-start-serwera) | komputer | Docker, Node 22 | 15 min |
| [B. Logowanie GitHub i workspace](#b-logowanie-przez-github-i-workspace) | lokalnie lub Render | A albo H, GitHub App | 10 min |
| [C. GitHub App: repozytoria i deploye](#c-github-app-repozytoria-i-deploye) | lokalnie lub Render | B, repo z deploymentami | 20 min |
| [D. Strona ustawień](#d-strona-ustawień) | przeglądarka | B | 15 min |
| [E. Jira: OAuth Atlassian](#e-jira-oauth-atlassian) | lokalnie lub Render | B, aplikacja Atlassian | 15 min |
| [F. Jira: tablice i rytmy](#f-jira-tablice-i-rytmy) | lokalnie lub Render | E | 30 min |
| [G. Feature flagi (ingest)](#g-feature-flagi-ingest) | terminal | B | 10 min |
| [H. Render: wdrożenie](#h-render-wdrożenie) | Render | konto Render | 30–45 min |
| [I. Webhooki GitHub](#i-webhooki-github) | Render | H, C | 10 min |
| [J. Webhooki Jira](#j-webhooki-jira) | Render | H, F | 15 min |
| [K. Wdrożenia, migracje, wycofanie](#k-kolejne-wdrożenia-migracje-wycofanie) | Render | H | 15 min |
| [L. Bezpieczeństwo (szybkie sprawdzenia)](#l-bezpieczeństwo-szybkie-sprawdzenia) | przeglądarka, terminal | B | 10 min |

Webhooki (I, J) da się sprawdzić tylko pod publicznym adresem `https`, czyli w praktyce na Renderze. Pozostałe bloki
można zrobić lokalnie albo od razu na Renderze.

---

## A. Lokalnie: start serwera

Wymaga: Dockera, Node 22 oraz GitHub App „dev” z callbackiem `http://localhost:3000/auth/github/callback`
(SETUP.pl.md §1).

- [ ] **A1. Baza i migracje**
  ```bash
  cd server
  docker run -d --name shipscope-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
  npm install
  cp .env.example .env     # uzupełnij zmienne (SETUP.pl.md §2)
  node --env-file=.env scripts/migrate.js
  ```
  Oczekiwane: `Applied: 001_… 013_webhooks.sql`. Drugie uruchomienie wypisuje `No pending migrations.`
- [ ] **A2. Testy automatyczne na prawdziwym Postgresie** (opcjonalnie; potwierdza środowisko)
  ```bash
  ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node scripts/setup-test-db.js   # jednorazowo
  TEST_DATABASE_URL=postgres://shipscope_app:shipscope_app@localhost:5432/postgres npm test
  ```
  Oczekiwane: `# fail 0`.
- [ ] **A3. Start serwisu web**: `npm run dev`.
  Oczekiwane:
  - `http://localhost:3000/health` zwraca `{"status":"ok","version":"<wersja z package.json>"}`;
  - `http://localhost:3000/health/db` zwraca `{"ok":true,…}`.
- [ ] **A4. Start workera** (drugi terminal): `node --env-file=.env worker.js`.
  Oczekiwane: co 30 s linia `heartbeat ok`. Bez zmiennych GitHub App lub Atlassian pojawiają się linie
  `… sync is off` (to poprawne).

## B. Logowanie przez GitHub i workspace

Wymaga: A3 (lokalnie) albo H (Render).

- [ ] **B1. Logowanie**: otwórz `/`. Oczekiwane: przekierowanie do GitHuba, zgoda, powrót do ShipScope.
- [ ] **B2. Pierwszy workspace**: bez workspace'u trafiasz na `/start`. Wpisz nazwę i kliknij **Create**.
  Oczekiwane: przejście do `/t/<id>/settings`, a w nagłówku `<nazwa> · Settings`.
- [ ] **B3. Dashboard**: link **Dashboard** w ustawieniach. Oczekiwane: pusty dashboard bez błędów w konsoli
  przeglądarki (F12) i z linkiem **Settings** w nagłówku.
- [ ] **B4. Wylogowanie i powrót**: wyczyść ciasteczka strony i otwórz `/t/<id>/settings`. Oczekiwane: logowanie
  przez GitHuba i powrót na tę samą stronę.
- [ ] **B5. Zaproszenie**: Settings → Workspace → **Create invitation link** (rola `member`).
  Oczekiwane: link pokazany raz, w ramce. Po **Done, I copied it** znika.
- [ ] **B6. Przyjęcie zaproszenia drugim kontem GitHub** (np. w oknie prywatnym): otwórz link, zaloguj się, wywołaj
  `POST` na `/invitations/<token>/accept`, np. z konsoli przeglądarki:
  ```js
  fetch(location.pathname + '/accept', { method: 'POST' }).then(r => r.json()).then(console.log)
  ```
  Oczekiwane:
  - status 201;
  - drugie konto widzi dashboard i ustawienia tylko do odczytu, bez przycisków zmian;
  - w sekcji Workspace u admina pojawia się drugi członek.
- [ ] **B7. Ostatni admin nie może odejść**: jako jedyny admin kliknij **Leave**.
  Oczekiwane: komunikat błędu, a członkostwo zostaje.

## C. GitHub App: repozytoria i deploye

Wymaga: B oraz GitHub App z uprawnieniami z SETUP.pl.md §1: Metadata, Deployments, Contents i opcjonalnie Actions,
wszystkie read-only. Do tego repozytorium, które tworzy deploymenty (GitHub Deployments API, np. przez
`environment:` w workflow).

- [ ] **C1. Instalacja**: Settings → GitHub → **Install the GitHub App…**, wybierz konto lub organizację i
  repozytoria. Oczekiwane: po instalacji GitHub prosi o ponowne zalogowanie (to celowe, ShipScope sprawdza w ten
  sposób dostęp), a potem wracasz na `…/settings#github` z instalacją na liście.
- [ ] **C2. Śledzenie**: przy instalacji kliknij **Repositories**, potem **Track** przy repozytorium.
  Oczekiwane: repo pojawia się w „Tracked repositories” z etykietą „not synced yet”.
- [ ] **C3. Pierwsza synchronizacja**: poczekaj na przebieg workera (do 15 min; po restarcie workera od razu).
  Oczekiwane:
  - etykieta „synced …”;
  - na dashboardzie, w widoku technicznym, wersje w macierzy środowisk i historia deployów;
  - w logu workera `sync done: N repos, +M deployments`.
- [ ] **C4. Środowiska**: deploye do środowisk `test`/`dev`, `qa`, `prod`/`production` trafiają do właściwych kolumn.
  Środowisko o innej nazwie (np. `staging`) jest pomijane, a log pokazuje ostrzeżenie.
- [ ] **C5. Wersja**: deploy commita z tagiem albo release'em pokazuje nazwę tagu, a nie skrót SHA.
- [ ] **C6. Plik wersji i rozjazd** (jeśli repo ma gałęzie `deployment/*` z plikiem wersji): w ustawieniach repo wpisz
  plik wersji (np. `trigger.properties`) i ścieżki ignorowane (np. `.github/`), potem kliknij **Save**.
  Oczekiwane: po następnej synchronizacji wersja i „Diff to ENV” odpowiadają prawdziwemu kodowi.
- [ ] **C7. Ręczny deploy** (z uprawnieniem Actions): deploy uruchomiony przez `workflow_dispatch` ma znaczek „manual”.
- [ ] **C8. Błąd repozytorium**: odbierz aplikacji dostęp do jednego repo (GitHub → instalacja → Configure).
  Oczekiwane: przy tym repo etykieta „sync failed” z opisem w dymku, a pozostałe repo synchronizują się dalej.
- [ ] **C9. Odłączenie**: **Stop tracking**, a potem **Unlink**. Oczekiwane: deploye repo znikają z dashboardu,
  a aplikacja zostaje zainstalowana na GitHubie.

## D. Strona ustawień

Wymaga: B. Sprawdzaj w Chrome lub Firefox, z otwartą konsolą (F12).

- [ ] **D1. Brak błędów w konsoli** po załadowaniu i po każdej akcji.
- [ ] **D2. Retencja**: wpisz `3` i kliknij **Save**. Oczekiwane: przeglądarka nie wysyła formularza (minimum 7).
  Wpisz `120`, kliknij **Save** i odśwież stronę. Oczekiwane: komunikat „Saved.”, po odświeżeniu nadal 120.
- [ ] **D3. Potwierdzenia**: **Stop tracking**, **Unlink**, **Disconnect**, **Delete**, **revoke** pytają o
  potwierdzenie. **Anuluj** niczego nie zmienia.
- [ ] **D4. Komunikaty**: po akcji w jednej sekcji znika komunikat z poprzedniej akcji w innej sekcji.
- [ ] **D5. Telefon**: narzędzia deweloperskie → widok urządzenia ok. 390 px szerokości. Oczekiwane: strona bez
  poziomego przewijania, a formularze da się wypełnić.
- [ ] **D6. Motyw jasny**: na dashboardzie przełącz motyw na jasny i otwórz ustawienia. Oczekiwane: też jasne.
- [ ] **D7. Bez konfiguracji**: na serwerze bez zmiennych GitHub App lub Atlassian sekcje pokazują „not configured
  on this server”, a nie błąd.

## E. Jira: OAuth Atlassian

Wymaga: B oraz aplikacji OAuth 2.0 w https://developer.atlassian.com/console/myapps/ (SETUP.pl.md §5) z zakresami:
- `read:jira-work`, `read:jira-user`, `read:project:jira`;
- `read:board-scope:jira-software`, `read:sprint:jira-software`;
- **`manage:jira-webhook`**.

Callback URL to `<adres>/auth/atlassian/callback`. Na serwerze muszą być ustawione `ATLASSIAN_CLIENT_ID`,
`ATLASSIAN_CLIENT_SECRET` i `TOKEN_ENCRYPTION_KEY`.

- [ ] **E1. Połączenie**: Settings → Jira → **Connect Jira**, zgoda w Atlassian.
  Oczekiwane: powrót na `…/settings#jira` z napisem „Connected to <witryna>”.
  - Jeśli Atlassian pokazuje błąd zakresu, w konsoli brakuje któregoś zakresu z listy wyżej (najczęściej
    `manage:jira-webhook`).
- [ ] **E2. Kilka witryn** (jeśli konto ma kilka): formularz „Jira site” i **Use this site**.
  Oczekiwane: lista tablic.
- [ ] **E3. Projekty**: `GET /tenants/<id>/jira/projects` (otwórz w przeglądarce). Oczekiwane: lista projektów JSON.
- [ ] **E4. Odświeżanie tokenu**: odczekaj ponad godzinę (token dostępu wygasa) i kliknij **Sync now**.
  Oczekiwane: działa bez ponownego łączenia (ShipScope sam odświeża token).
- [ ] **E5. Odebranie dostępu**: na https://id.atlassian.com/manage-profile/apps usuń dostęp aplikacji, potem
  kliknij **Sync now**.
  Oczekiwane: czerwona etykieta „Jira access was revoked or has expired; connect Jira again”, a **Reconnect Jira**
  naprawia połączenie.
- [ ] **E6. Rozłączenie**: **Disconnect**. Oczekiwane: sekcja wraca do „Connect Jira”, a zadania znikają
  z dashboardu.

## F. Jira: tablice i rytmy

Wymaga: E. Najlepiej z tablicami różnych rodzajów:
- Scrum ze sprintami nazwanymi w konwencji PI (`Zespół 27.3.1`);
- Scrum ze zwykłymi sprintami (`Sprint 7`);
- projekt z wersjami (Fix Version);
- tablica kanban.

- [ ] **F1. Lista tablic**: wszystkie tablice witryny z typem (`scrum`, `simple`, `kanban`) i projektem.
- [ ] **F2. Wybór**: zaznacz tablice, kliknij **Save selection**, potem **Sync now**.
  Oczekiwane: komunikat „Synced N board(s), M issue(s); now: …”, a przy każdej tablicy „Now: <przyrost>”.
- [ ] **F3. Rytm `auto`**:
  - tablica ze sprintami PI → przyrost `PI-27.3`;
  - zwykłe sprinty → `Sprint 7`;
  - kanban albo tablica bez sprintów → `PAY 1.2` (gdy projekt ma niewydaną wersję) albo `Flow 2026-10`.
- [ ] **F4. „Now”**: przy tablicach w różnych przyrostach dashboard otwiera się na „Now: …”, pokazując zadania
  wszystkich zespołów naraz. Pozostałe przyrosty są dalej w selektorze.
- [ ] **F5. Szablon PI**: dla tablicy z nazwami typu `PI 7 / Iteration 2` ustaw rytm **Program increments** z
  szablonem `PI {pi} / Iteration {n}`, potem **Save** i **Sync now**. Oczekiwane: przyrost `PI-7`.
  - Szablon bez `{pi}` jest odrzucany z komunikatem.
  - Przy rytmie `sprint` pole szablonu jest wyłączone.
- [ ] **F6. Wydania**: rytm **Releases** dla projektu z wersjami. Oczekiwane:
  - bieżąca jest najbliższa niewydana wersja (według daty wydania);
  - zadania to te z tą Fix Version;
  - wersje zarchiwizowane są pomijane.
- [ ] **F7. Flow**: rytm **Monthly flow** na tablicy kanban. Oczekiwane: `Flow <rok-miesiąc>` zawiera zadania
  rozwiązane w tym miesiącu i wszystkie w toku. Zadania „To Do” nie wchodzą.
- [ ] **F8. Zmiana rytmu**: po zmianie rytmu i **Sync now** stare przyrosty tej tablicy znikają, a nowe się
  pojawiają.
- [ ] **F9. Widoki**: Product view (epiki, statusy), Release Notes, Insights (`?insights=1`). Wszystkie działają dla
  każdego rodzaju przyrostu.

## G. Feature flagi (ingest)

Wymaga: B.

- [ ] **G1. Źródło**: Settings → Feature flags → **Add source** (np. `LaunchDarkly`, kind `runtime`).
  Oczekiwane: token pokazany raz. Skopiuj go do zmiennej powłoki, nie do pliku w repo.
- [ ] **G2. Wysłanie stanu**:
  ```bash
  export SS=<adres>                 # np. http://localhost:3000
  export TOKEN=<token z G1>
  curl -s -X POST "$SS/api/flags/ingest" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"schemaVersion":2,"observations":[{"key":"newCheckout","env":"prod","state":"partial","rollout":25},{"key":"newCheckout","env":"test","state":"on"}],"flags":[{"key":"newCheckout","description":"Nowy checkout","jiraKeys":["ABC-1"]}]}'
  ```
  Oczekiwane: JSON z `created`/`changed`, a flaga widoczna w widoku technicznym dashboardu.
- [ ] **G3. Pełny stan usuwa brakujące**: wyślij to samo bez `newCheckout` dla `prod` (np. inną flagę). Oczekiwane:
  `newCheckout` na `prod` oznaczona jako usunięta.
- [ ] **G4. Zły token**: ten sam `curl` z `Bearer xyz`. Oczekiwane: status 401.
- [ ] **G5. Rotacja**: **New token**, wysyłka nowym tokenem, potem **revoke** starego. Oczekiwane: stary dostaje 401,
  nowy działa.

## H. Render: wdrożenie

Wymaga: konta Render oraz „produkcyjnych” aplikacji GitHub i Atlassian. Pełna instrukcja jest w SETUP.pl.md §6.
Tu tylko punkty kontrolne.

- [ ] **H1. Blueprint**: New → Blueprint → repo `dbqm45/evdt-service-shipscope`, gałąź `main`.
  Oczekiwane: trzy zasoby (`shipscope-web`, `shipscope-worker`, `shipscope-db`), a Render prosi o każdy sekret.
- [ ] **H2. Pierwsze wdrożenie**: w logu buildu `npm ci --prefix server`, w pre-deploy `Applied: 001_…013_…` (u
  jednego serwisu; drugi pokazuje `No pending migrations.`), potem start.
- [ ] **H3. Zdrowie**: `https://<adres>/health` → `status: ok` z wersją, `https://<adres>/health/db` → `ok: true`.
- [ ] **H4. Dashboard się serwuje**: po zalogowaniu `/t/<id>/` i `/t/<id>/settings` ładują się, a nie odpowiadają
  503. W logu serwisu web nie ma `dashboard files not found`.
- [ ] **H5. Adresy**: jeśli Render nadał inny adres niż wpisany, popraw:
  - `PUBLIC_BASE_URL` w obu serwisach;
  - w GitHub App: Callback URL, Setup URL i Webhook URL;
  - w aplikacji Atlassian: Callback URL.
  Logowanie musi działać po tej poprawce.
- [ ] **H6. Bloki B–G na Renderze**: przejdź je ponownie, przynajmniej B1–B3, C1–C3, E1, F2 i G2.
- [ ] **H7. Ciasteczka**: w narzędziach przeglądarki ciasteczko `sid` ma `Secure`, `HttpOnly` i `SameSite=Lax`.

## I. Webhooki GitHub

Wymaga: H oraz C.
- W GitHub App → General → Webhook: **Active**, URL `<adres>/webhooks/github`, Secret równy
  `GITHUB_APP_WEBHOOK_SECRET` w serwisie web.
- W Permissions & events → Subscribe to events: zaznaczone **Deployment status**.

- [ ] **I1. Status**: w Settings → GitHub widać „instant updates on”.
- [ ] **I2. Dostawa**: zrób deploy w śledzonym repo. W GitHub App → Advanced → Recent Deliveries dostawa
  `deployment_status` ma odpowiedź **202** i treść `{"queued":1}`.
- [ ] **I3. Szybkość**: deploy pojawia się na dashboardzie w ciągu około minuty. W logu workera
  `github webhook sync done`.
- [ ] **I4. Zły sekret**: zmień tymczasowo sekret w GitHub App i kliknij **Redeliver**. Oczekiwane: **401**.
  Przywróć sekret.
- [ ] **I5. Inne zdarzenia** (np. `ping` przy zapisie ustawień): odpowiedź 202 z `{"queued":0}`.

## J. Webhooki Jira

Wymaga:
- H oraz F;
- `PUBLIC_BASE_URL` (`https`) ustawione również w workerze;
- zakres `manage:jira-webhook` w aplikacji Atlassian;
- połączenia Jiry nawiązanego po dodaniu tego zakresu (w razie potrzeby **Reconnect Jira**).

**Tu jest jedyna niepotwierdzona rzecz w kodzie.** Format podpisu dostaw z Jiry (JWT HS256 podpisany client
secretem) i pole `matchedWebhookIds` przyjęto z opisów Atlassian, bez sprawdzenia na prawdziwej dostawie. Jeśli J3
nie przejdzie, synchronizacja co 15 minut działa dalej, a do poprawki potrzebne są logi z J5.

- [ ] **J1. Rejestracja**: po **Sync now** w Settings → Jira widać „instant updates on”.
  - Jeśli „off”: odczytaj powód (np. „Reconnect Jira…”) i postępuj według niego.
- [ ] **J2. Zmiana zadania**: zmień status lub tytuł zadania w zsynchronizowanej tablicy. W logu serwisu web pojawia
  się `POST /webhooks/jira` ze statusem **202**.
- [ ] **J3. Szybkość**: zmiana widoczna na dashboardzie w ciągu około minuty. W logu workera
  `jira webhook sync done`.
- [ ] **J4. Zmiana tablic**: dodaj tablicę z innego projektu, kliknij **Save selection** i **Sync now**. Oczekiwane:
  dalej „instant updates on”, a zmiany zadań z nowego projektu też przychodzą od razu.
- [ ] **J5. Gdy J2 lub J3 nie działa — co zebrać**:
  - status odpowiedzi na `/webhooks/jira` z logu serwisu web (401 oznacza, że podpis jest w innym formacie);
  - nagłówki dostawy bez wartości tokenu (sam fakt, czy jest `Authorization: Bearer …` i jaki ma `alg`; nagłówek
    tokenu JWT to pierwsza część przed kropką, zakodowana base64url, którą można zdekodować bez sekretu);
  - czy treść dostawy zawiera `matchedWebhookIds` (sama nazwa pola, bez danych zadań).
- [ ] **J6. Odnowienie po 30 dniach** (do sprawdzenia po miesiącu): w ustawieniach dalej „instant updates on”.
  Webhook odnawia się sam na 7 dni przed wygaśnięciem.

## K. Kolejne wdrożenia, migracje, wycofanie

Wymaga: H.

- [ ] **K1. Automatyczne wdrożenie**: merge do `main`, który zmienia `server/**`, wdraża oba serwisy. Zmiana tylko
  w `docs/*.js` wdraża tylko serwis web. Commit z danymi (`docs/data/**`) nie wdraża niczego.
- [ ] **K2. Wersja**: po merge'u i commicie `chore(release): X.Y.Z` endpoint `/health` pokazuje nową wersję.
- [ ] **K3. Nieudana migracja** (opcjonalnie, na osobnym środowisku): migracja z błędem zatrzymuje wdrożenie, a
  poprzednia wersja nadal odpowiada na `/health`.
- [ ] **K4. Wycofanie**: Render → serwis → **Rollback** do poprzedniego wdrożenia. Oczekiwane: `/health` pokazuje
  starą wersję. Pamiętaj, że migracje bazy się nie cofają.
- [ ] **K5. Restart workera**: Render → worker → **Restart**. Oczekiwane: w logu od razu synchronizacja i
  `heartbeat ok`.

## L. Bezpieczeństwo (szybkie sprawdzenia)

Wymaga: B i drugiego konta GitHub spoza workspace'u.

- [ ] **L1. Cudzy workspace**: zalogowany drugim kontem otwórz `/t/<id cudzego workspace'u>/settings` i
  `/api/tenants/<id>/dashboard-data`. Oczekiwane: 404 (nie 403, by nie zdradzać, że workspace istnieje).
- [ ] **L2. Członek bez uprawnień**: konto z rolą `member` wywołuje `PUT /tenants/<id>/settings` (np. z konsoli).
  Oczekiwane: 403.
- [ ] **L3. Pliki spoza listy**: `/t/<id>/data/deployments.json`, `/t/<id>/components.json`, `/ui/web.js`,
  `/ui/..%2Fweb.js`. Oczekiwane: 400 lub 404 i nigdy treść pliku.
- [ ] **L4. Otwarte przekierowanie**: `/auth/github/login?returnTo=https://example.com`. Oczekiwane: 400.
- [ ] **L5. XSS**: nazwij workspace `<img src=x onerror=alert(1)>`. Oczekiwane: nazwa wyświetla się jako tekst,
  bez okienka alert.

---

Po przejściu całości dopisz w `docs/project/journal.md` datę, środowisko i bloki, które przeszły, oraz numery tych,
które nie przeszły.
