# Aktualizacja, wdrożenie na Render i testy ręczne

Poniżej wszystko, co jest do zrobienia po zmergowaniu PR #22–#27. Najpierw zaktualizuj środowisko lokalne, potem
wdróż na Render, a na końcu przejdź testy (część C), kiedy będziesz mieć czas. Testy automatyczne używają atrap
GitHuba, Atlassiana i Rendera. Te kroki sprawdzają prawdziwe usługi.

Sekretów (tokenów, client secretów, kluczy `.pem`) nie wklejaj do repo, czatu ani issue. Szczegóły konfiguracji są w
[SETUP.pl.md](SETUP.pl.md).

## A. Lokalnie

1. Pobierz nowy kod (w katalogu repo):

   ```
   git checkout main
   git pull
   ```

2. Uruchom migracje w katalogu `server/`. Dojdą `011`, `012` i `013`:

   ```
   node --env-file=.env scripts/migrate.js
   ```

3. Dodaj zakres w konsoli Atlassiana. Wejdź na https://developer.atlassian.com/console/myapps/ → ShipScope (dev) →
   Permissions → Jira API → Configure → Classic scopes i zaznacz `manage:jira-webhook`. Bez tego każde nowe łączenie
   Jiry skończy się błędem, bo ShipScope prosi teraz o ten zakres.
4. Zrestartuj `npm run dev` i worker (`node --env-file=.env worker.js`).
5. Otwórz ustawienia: `http://localhost:3000/t/<tenant-id>/settings`. Tam jest już wszystko w UI: tablice, rytmy,
   repozytoria, flagi, zaproszenia.
6. Opcjonalnie kliknij „Reconnect Jira” w ustawieniach. Lokalnie webhooki i tak nie zadziałają, bo jesteś na `http`,
   ale sprawdzisz, że łączenie z nowym zakresem przechodzi.

## B. Wdrożenie na Render

### Przygotowanie

7. GitHub App do produkcji. Utwórz nową albo użyj obecnej i ustaw:
   - Callback URL: `https://<adres>/auth/github/callback`
   - Setup URL: `https://<adres>/github/setup`
   - Webhook: Active, URL `https://<adres>/webhooks/github`, Secret wygenerowany przez `openssl rand -hex 32`
   - w zakładce Permissions & events zaznacz zdarzenie Deployment status
   - jeśli ma działać w organizacji EVDT: Advanced → Make public

   `<adres>` to zwykle `https://shipscope-web.onrender.com`. Dokładny poznasz po utworzeniu serwisu i wtedy go
   poprawisz.
8. Aplikacja Atlassian do produkcji. Zakresy jak w dev, łącznie z `manage:jira-webhook`. Callback URL:
   `https://<adres>/auth/atlassian/callback`.
9. Wygeneruj i zapisz w menedżerze haseł:
   - `TOKEN_ENCRYPTION_KEY`: `openssl rand -base64 32` (nowy, nie lokalny). Zachowaj kopię: jego zmiana albo utrata
     oznacza, że każdy workspace łączy Jirę od nowa.
   - `GITHUB_APP_WEBHOOK_SECRET`: ten sam, który wpisałeś w GitHub App.

### Utworzenie

10. Render → New → Blueprint → repo `dbqm45/evdt-service-shipscope`, gałąź `main`.
11. Wpisz wartości, o które poprosi Render:
    - web: `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
      `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`,
      `TOKEN_ENCRYPTION_KEY`
    - worker: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `ATLASSIAN_CLIENT_ID`,
      `ATLASSIAN_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`
    - `DATABASE_URL` Render ustawi sam. `DATABASE_SSL` zostaw puste.
12. Kliknij Apply i poczekaj. Render utworzy bazę, zbuduje serwisy, uruchomi migracje i wystartuje. W logu
    pre-deploy jednego serwisu zobaczysz `Applied: 001_… 013_…`, a drugiego `No pending migrations.`

### Po utworzeniu

13. Jeśli faktyczny adres serwisu jest inny niż wpisany, popraw `PUBLIC_BASE_URL` w obu serwisach oraz adresy w
    GitHub App i w aplikacji Atlassian.
14. Sprawdź:
    - `https://<adres>/health` zwraca `{"status":"ok",…}`;
    - `https://<adres>/health/db` zwraca `ok: true`.
15. Pierwsze użycie:
    1. Zaloguj się. Trafisz na `/start`, gdzie utworzysz workspace, a potem przejdziesz do ustawień.
    2. W sekcji GitHub kliknij Install i wybierz repozytoria → Repositories → Track.
    3. W sekcji Jira kliknij Connect, zaznacz tablice → Save selection → Sync now.
    4. Otwórz Dashboard.
16. Sprawdź webhooki:
    - GitHub App → Advanced → Recent Deliveries: odpowiedzi powinny mieć kod 202;
    - w ustawieniach Jiry powinno być „instant updates on”.

Po wdrożeniu przyślij mi adres serwisu i wynik `/health`. Jeśli coś nie działa, dołącz logi, zwłaszcza gdy dostawy z
Jiry dostają 401.

## C. Testy (można odłożyć)

Każdy krok ma oczekiwany wynik. Jeśli jest inny, zapisz numer kroku, adres, odpowiedź (status i treść) i fragment logu.
Kroki od 17 do 33 i od 44 do 52 możesz zrobić lokalnie albo na Renderze, a kroki od 34 do 43 tylko na Renderze, bo
GitHub i Atlassian muszą móc wywołać publiczny adres `https`.

### Logowanie, workspace, zaproszenia

17. Wyczyść ciasteczka strony i otwórz `/t/<id>/settings`. Powinno przekierować do logowania GitHub i wrócić na tę
    samą stronę.
18. Settings → Workspace → Create invitation link (rola `member`). Link pokazuje się raz, w ramce. Po
    „Done, I copied it” znika.
19. Otwórz link drugim kontem GitHub (okno prywatne), zaloguj się i w konsoli przeglądarki (F12) wpisz:

    ```
    fetch(location.pathname + '/accept', { method: 'POST' }).then(r => r.json()).then(console.log)
    ```

    Drugie konto widzi dashboard i ustawienia bez przycisków zmian, a u admina pojawia się nowy członek.
20. Jako jedyny admin kliknij Leave. Powinien pojawić się komunikat błędu, a członkostwo zostaje.

### GitHub: repozytoria i deploye

21. Po Install aplikacja prosi o ponowne zalogowanie. To celowe, bo ShipScope sprawdza w ten sposób dostęp. Potem
    wracasz na `…/settings#github` z instalacją na liście.
22. Po Track repozytorium ma etykietę „not synced yet”. Do 15 minut później (od razu po restarcie workera) zmienia się
    na „synced …”, a dashboard pokazuje wersje i historię deployów.
23. Deploye do `test`/`dev`, `qa`, `prod`/`production` trafiają do właściwych kolumn. Inne nazwy (np. `staging`) są
    pomijane, z ostrzeżeniem w logu workera.
24. Deploy commita z tagiem albo release'em pokazuje nazwę tagu, a nie skrót SHA.
25. Jeśli repo deployuje z gałęzi `deployment/*`, wpisz w ustawieniach repo plik wersji (np. `trigger.properties`) i
    ścieżki ignorowane (np. `.github/`) → Save. Po synchronizacji wersja i „Diff to ENV” pokazują prawdziwy kod.
26. Odbierz aplikacji dostęp do jednego repo (GitHub → instalacja → Configure). Przy tym repo pojawia się „sync failed”,
    a pozostałe synchronizują się dalej.
27. Stop tracking, potem Unlink. Deploye znikają z dashboardu, a aplikacja zostaje zainstalowana na GitHubie.

### Jira: OAuth, tablice, rytmy

28. Po Connect i zgodzie wracasz na `…/settings#jira` z napisem „Connected to <witryna>”. Jeśli Atlassian pokazuje
    błąd zakresu, w konsoli brakuje któregoś zakresu, najczęściej `manage:jira-webhook`.
29. Lista tablic pokazuje wszystkie tablice witryny z typem (`scrum`, `simple`, `kanban`). Po Save selection i
    Sync now pojawia się komunikat „Synced N board(s)…”, a przy każdej tablicy „Now: <przyrost>”.
30. Rytm `auto` daje:
    - `PI-27.3` dla sprintów w konwencji PI;
    - `Sprint 7` dla zwykłych sprintów;
    - `PAY 1.2` albo `Flow 2026-10` dla kanbana i tablic bez sprintów.

    Przy tablicach w różnych przyrostach dashboard otwiera się na „Now: …”.
31. Ustaw rytm Program increments z szablonem `PI {pi} / Iteration {n}` → Save → Sync now. Sprint
    `PI 7 / Iteration 2` trafia do `PI-7`. Szablon bez `{pi}` jest odrzucany, a przy rytmie Sprints pole jest
    wyłączone.
32. Rytm Releases: bieżąca jest najbliższa niewydana wersja według daty, a wersje zarchiwizowane są pomijane. Rytm
    Monthly flow: zadania rozwiązane w tym miesiącu i wszystkie w toku, bez „To Do”.
33. Usuń dostęp aplikacji na https://id.atlassian.com/manage-profile/apps → Sync now. Pojawia się czerwona etykieta
    „Jira access was revoked…”, a Reconnect Jira naprawia połączenie.

### Webhooki (tylko Render)

34. W ustawieniach GitHub i Jira jest „instant updates on”. Jeśli przy Jirze jest „off”, przeczytaj powód (np.
    „Reconnect Jira…”) i zrób, co mówi.
35. Zrób deploy w śledzonym repo. W Recent Deliveries dostawa `deployment_status` ma kod 202 i `{"queued":1}`.
36. Deploy pojawia się na dashboardzie w ciągu około minuty. W logu workera jest `github webhook sync done`.
37. Zmień tymczasowo sekret w GitHub App → Redeliver. Odpowiedź ma kod 401. Przywróć sekret.
38. Zmień status zadania w zsynchronizowanej tablicy. W logu serwisu web jest `POST /webhooks/jira` z kodem 202.
39. Zmiana widoczna na dashboardzie w ciągu około minuty. W logu workera jest `jira webhook sync done`.
40. Dodaj tablicę z innego projektu → Save selection → Sync now. Nadal „instant updates on”, a zmiany zadań z nowego
    projektu też przychodzą od razu.
41. Jeśli w kroku 38 jest kod 401 albo zmiany nie przychodzą, przyślij mi (bez sekretów):
    - kod odpowiedzi z logu serwisu web;
    - czy dostawa ma nagłówek `Authorization: Bearer …` i jaki `alg` jest w pierwszej części tokenu przed kropką
      (dekoduje się ją z base64url bez sekretu);
    - czy treść dostawy ma pole `matchedWebhookIds`.

    To jedyna rzecz w kodzie, której nie dało się potwierdzić bez prawdziwej dostawy. Do czasu poprawki Jira
    synchronizuje się co 15 minut.
42. Po merge'u zmieniającym `server/**` oba serwisy wdrażają się same, a `/health` pokazuje nową wersję. Commit z
    danymi (`docs/data/**`) nie wdraża niczego.
43. Render → serwis → Rollback do poprzedniego wdrożenia. `/health` pokazuje starą wersję. Migracje bazy się nie
    cofają.

### Feature flagi

44. Settings → Feature flags → Add source (np. `LaunchDarkly`, kind `runtime`). Token pokazuje się raz. Skopiuj go do
    zmiennej w terminalu, nie do pliku.
45. Wyślij stan:

    ```
    export SS=https://<adres>          # albo http://localhost:3000
    export TOKEN=<token>
    curl -s -X POST "$SS/api/flags/ingest" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"schemaVersion":2,"observations":[{"key":"newCheckout","env":"prod","state":"partial","rollout":25},{"key":"newCheckout","env":"test","state":"on"}],"flags":[{"key":"newCheckout","description":"Nowy checkout","jiraKeys":["ABC-1"]}]}'
    ```

    Odpowiedź zawiera `created`/`changed`, a flaga widać w widoku technicznym dashboardu.
46. Ten sam `curl` z `Bearer xyz` zwraca kod 401.
47. New token → wysyłka nowym tokenem → revoke starego. Stary dostaje 401, nowy działa.

### Ustawienia i bezpieczeństwo

48. Retencja: przy `3` przeglądarka blokuje wysłanie (minimum 7). Po `120` → Save i odświeżeniu nadal jest 120.
49. Stop tracking, Unlink, Disconnect, Delete i revoke pytają o potwierdzenie. Anuluj niczego nie zmienia.
50. W widoku telefonu (narzędzia deweloperskie, ok. 390 px) strona nie przewija się w poziomie, a w konsoli nie ma
    błędów.
51. Drugie konto spoza workspace'u: `/t/<cudze id>/settings` i `/api/tenants/<cudze id>/dashboard-data` zwracają 404.
    Konto z rolą `member`: `PUT /tenants/<id>/settings` zwraca 403.
52. Ochrona przed atakami:
    - `/t/<id>/data/deployments.json`, `/ui/web.js` i `/auth/github/login?returnTo=https://example.com` zwracają
      400 albo 404, nigdy treść pliku ani przekierowanie;
    - workspace o nazwie `<img src=x onerror=alert(1)>` wyświetla się jako tekst, bez okienka alert.

Po testach dopisz w `docs/project/journal.md` datę, środowisko i numery kroków, które nie przeszły.
