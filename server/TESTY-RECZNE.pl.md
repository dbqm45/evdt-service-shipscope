# ShipScope: aktualizacja, uruchomienie w internecie i sprawdzenie — krok po kroku

Ten dokument prowadzi za rękę przez trzy rzeczy:

- **Część A** — aktualizacja wersji, która działa na Twoim komputerze.
- **Część B** — uruchomienie ShipScope w internecie, w serwisie Render, żeby inni mogli z niego korzystać.
- **Część C** — sprawdzenie, czy wszystko działa. Tę część możesz zrobić później.

Rób kroki po kolei. Przy każdym kroku jest napisane, co powinno się stać. Jeśli dzieje się coś innego, zatrzymaj się
i zanotuj numer kroku, adres strony i to, co widzisz na ekranie (zrzut ekranu wystarczy).

**Ważne:** niektóre wartości to tajne hasła — „sekrety”: klucz prywatny, „client secret”, tokeny. Zapisuj je tylko w
menedżerze haseł (np. 1Password, Bitwarden) i wklejaj tylko tam, gdzie ten dokument każe. Nigdy nie wysyłaj ich na
czacie, mailem ani nie wklejaj do repozytorium.

## Słowniczek

| Słowo | Co znaczy |
|---|---|
| **Workspace** | Przestrzeń jednego zespołu lub firmy w ShipScope: jej repozytoria, tablice Jiry, flagi, członkowie |
| **Terminal** | Okno do wpisywania poleceń. Na Macu: aplikacja „Terminal”. Na Windows: „Git Bash” (instaluje się razem z Gitem) |
| **Migracja** | Polecenie, które przygotowuje bazę danych do nowej wersji programu (dodaje tabele i kolumny) |
| **GitHub App** | „Aplikacja” zarejestrowana na GitHubie, przez którą ShipScope loguje użytkowników i czyta deploye z repozytoriów |
| **Aplikacja Atlassian** | To samo dla Jiry: przez nią ShipScope czyta zadania i tablice |
| **Webhook** | Powiadomienie, które GitHub lub Jira wysyła do ShipScope, gdy coś się zmieni, żeby nie czekać 15 minut na synchronizację |
| **Render** | Serwis, który uruchamia ShipScope w internecie (serwer, baza danych) |
| **`<adres>`** | Adres ShipScope w internecie, np. `https://shipscope-web.onrender.com` |
| **`<id>`** | Identyfikator workspace'u — patrz krok 5 |

---

## A. Aktualizacja na Twoim komputerze

Dotyczy wersji, którą już uruchamiałeś lokalnie (na `http://localhost:3000`).

1. **Pobierz najnowszy kod.** Otwórz terminal, przejdź do katalogu z repozytorium (np. `cd ~/evdt-service-shipscope`)
   i wpisz:

   ```
   git checkout main
   git pull
   ```

   Powinno być: lista zmienionych plików albo komunikat „Already up to date”.

2. **Przygotuj bazę danych (migracje).** W tym samym terminalu:

   ```
   cd server
   npm install
   node --env-file=.env scripts/migrate.js
   ```

   Powinno być: `Applied: 011_jira_rhythms.sql, 012_jira_release_flow.sql, 013_webhooks.sql` (albo
   `No pending migrations.`, jeśli robiłeś to już wcześniej). Jeśli pojawia się błąd połączenia, sprawdź, czy
   działa baza danych (kontener Dockera `shipscope-pg`: w Docker Desktop powinien mieć status „Running”).

3. **Dodaj nowe uprawnienie w aplikacji Atlassian.**
   1. Wejdź na https://developer.atlassian.com/console/myapps/ i zaloguj się.
   2. Kliknij swoją aplikację deweloperską (np. „ShipScope (dev)”).
   3. W menu po lewej wybierz **Permissions**.
   4. Przy **Jira API** kliknij **Configure** (albo **Add**, jeśli jeszcze nie dodane).
   5. Kliknij **Edit Scopes**, przejdź na zakładkę **Classic scopes** i zaznacz **Manage Jira webhooks**
      (`manage:jira-webhook`).
   6. Kliknij **Save**.

   Dlaczego: ShipScope prosi teraz Jirę o to uprawnienie. Bez niego każda próba połączenia z Jirą skończy się
   błędem.

4. **Uruchom ShipScope ponownie.** Potrzebne są dwa okna terminala, oba w katalogu `server`:
   - w pierwszym zatrzymaj stary serwer (`Ctrl+C`) i uruchom go ponownie: `npm run dev`;
   - w drugim zatrzymaj stary worker (`Ctrl+C`) i uruchom go ponownie: `node --env-file=.env worker.js`.

   Powinno być: serwer pisze, że nasłuchuje na porcie 3000, a worker co 30 sekund pisze `heartbeat ok`.

5. **Znajdź identyfikator workspace'u (`<id>`).** Otwórz w przeglądarce `http://localhost:3000/` i zaloguj się.
   Trafisz na dashboard. Spójrz na pasek adresu: wygląda tak:

   ```
   http://localhost:3000/t/3f2a9c1e-1b2c-4d5e-8f90-123456789abc/
   ```

   Ten długi ciąg po `/t/` to `<id>`. Jeśli zamiast dashboardu widzisz stronę „Create a workspace”, nie masz jeszcze
   workspace'u: wpisz nazwę i kliknij **Create**.

6. **Otwórz ustawienia.** Na dashboardzie kliknij **Settings** w prawym górnym rogu (albo wpisz
   `http://localhost:3000/t/<id>/settings`). Tu jest teraz wszystko: repozytoria, tablice Jiry, flagi, zaproszenia.

7. **(Opcjonalnie) Połącz Jirę ponownie.** W sekcji **Jira** kliknij **Reconnect Jira** i zaakceptuj w Atlassian.
   Powinno być: powrót do ustawień z napisem „Connected to …”. Sprawdzasz w ten sposób, że nowe uprawnienie z kroku 3
   działa. Lokalnie zobaczysz „instant updates off” — to normalne, bo powiadomienia (webhooki) działają tylko w
   internecie, nie na `localhost`.

---

## B. Uruchomienie w internecie (Render)

### Przygotowanie (ok. 30 minut)

Najpierw zbierasz wszystkie dane, potem wklejasz je w Renderze. Przygotuj menedżer haseł i zrób w nim wpis
„ShipScope produkcja”.

8. **Wygeneruj dwa sekrety.** W terminalu wpisz dwa polecenia (każde wypisze jedną linię losowych znaków):

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   - Wynik pierwszego zapisz jako **`TOKEN_ENCRYPTION_KEY`**. Tym kluczem ShipScope szyfruje dostęp do Jiry. Jeśli go
     zgubisz albo zmienisz, każdy zespół będzie musiał połączyć Jirę od nowa, więc zachowaj kopię.
   - Wynik drugiego zapisz jako **`GITHUB_APP_WEBHOOK_SECRET`**.

9. **Przygotuj GitHub App do produkcji.** Najprościej utworzyć nową, osobną od lokalnej.
   1. Wejdź na GitHub. Jeśli aplikacja ma należeć do organizacji (np. EVDT): strona organizacji → **Settings** →
      na dole menu po lewej **Developer settings** → **GitHub Apps** → **New GitHub App**. Jeśli do Ciebie: zdjęcie
      profilowe (prawy górny róg) → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
   2. **GitHub App name**: np. „ShipScope”.
   3. **Homepage URL**: na razie `https://shipscope-web.onrender.com` (poprawisz w kroku 17, jeśli adres będzie inny).
   4. **Callback URL**: `https://shipscope-web.onrender.com/auth/github/callback`.
   5. **Setup URL**: `https://shipscope-web.onrender.com/github/setup`, zaznacz **Redirect on update**.
   6. **Request user authorization (OAuth) during installation**: **NIE** zaznaczaj.
   7. **Webhook**: zaznacz **Active**. **Webhook URL**: `https://shipscope-web.onrender.com/webhooks/github`.
      **Webhook secret**: wklej `GITHUB_APP_WEBHOOK_SECRET` z kroku 8.
   8. **Permissions** → **Repository permissions**, wszystkie **Read-only**:
      - **Contents**;
      - **Deployments**;
      - **Actions**;
      - **Metadata** (ustawia się sama).
   9. **Subscribe to events** (pojawia się pod uprawnieniami): zaznacz **Deployment status**.
   10. **Where can this GitHub App be installed?**: **Any account** (żeby mogła ją zainstalować organizacja).
   11. Kliknij **Create GitHub App**.

   Teraz zbierz dane z widocznej strony aplikacji (zakładka **General**):
   - **App ID** (liczba u góry, w sekcji „About”) → zapisz jako `GITHUB_APP_ID`;
   - **Client ID** (tamże) → zapisz jako `GITHUB_APP_CLIENT_ID`;
   - **Public link**, np. `https://github.com/apps/shipscope`. Ostatnia część (`shipscope`) to `GITHUB_APP_SLUG`;
   - **Client secrets** → **Generate a new client secret** → skopiuj od razu (pokazuje się tylko raz) jako
     `GITHUB_APP_CLIENT_SECRET`;
   - na dole **Private keys** → **Generate a private key**. Pobierze się plik `.pem`. Otwórz go w zwykłym edytorze
     tekstu (Notatnik, TextEdit) i skopiuj **całą** zawartość, razem z liniami `-----BEGIN …-----` i
     `-----END …-----`, jako `GITHUB_APP_PRIVATE_KEY`. Plik zachowaj w bezpiecznym miejscu albo usuń po
     skopiowaniu.

10. **Przygotuj aplikację Atlassian do produkcji.**
    1. https://developer.atlassian.com/console/myapps/ → **Create** → **OAuth 2.0 integration**, nazwa np. „ShipScope”.
    2. **Permissions** → **Jira API** → **Add**, potem **Configure** → **Edit Scopes**. Zaznacz:
       - na zakładce **Classic scopes**: „View Jira issue data” (`read:jira-work`), „View user profiles”
         (`read:jira-user`) i „Manage Jira webhooks” (`manage:jira-webhook`);
       - na zakładce **Granular scopes**: `read:project:jira`.
    3. Jeśli na liście jest osobno **Jira Software** (albo „Jira platform REST API” z zakresami agile): dodaj i
       zaznacz `read:board-scope:jira-software` i `read:sprint:jira-software`.
    4. **Authorization** → przy **OAuth 2.0 (3LO)** kliknij **Configure** → **Callback URL**:
       `https://shipscope-web.onrender.com/auth/atlassian/callback` → **Save**.
    5. **Settings**: skopiuj **Client ID** jako `ATLASSIAN_CLIENT_ID` i **Secret** jako `ATLASSIAN_CLIENT_SECRET`.
    6. **Distribution**: jeśli z ShipScope mają korzystać inne firmy (inne Jiry), ustaw udostępnianie („Sharing”) i
       uzupełnij wymagane dane. Dla jednej, własnej Jiry nie trzeba.

### Utworzenie w Renderze (ok. 15 minut)

11. **Załóż konto i połącz z GitHubem.** Wejdź na https://dashboard.render.com i zaloguj się kontem GitHub (przycisk
    „GitHub”). Jeśli Render poprosi o dostęp do repozytoriów, zezwól na `evdt-service-shipscope`.

12. **Utwórz usługi z gotowego przepisu.** Kliknij **New +** (prawy górny róg) → **Blueprint**. Wybierz repozytorium
    `dbqm45/evdt-service-shipscope` i gałąź `main`. Render odczyta plik `render.yaml` i pokaże trzy elementy:
    - `shipscope-web` — strona i API;
    - `shipscope-worker` — synchronizacja w tle;
    - `shipscope-db` — baza danych.

    Plan „starter” jest płatny celowo: darmowa baza w Renderze kasuje się po 30 dniach. Sprawdź ceny przed
    zatwierdzeniem.

13. **Wklej wartości, o które poprosi Render.** Render pokaże pola do uzupełnienia, osobno dla każdej usługi:
    - **shipscope-web**:
      - `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
        `GITHUB_APP_PRIVATE_KEY` (krok 9);
      - `GITHUB_APP_WEBHOOK_SECRET`, `TOKEN_ENCRYPTION_KEY` (krok 8);
      - `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` (krok 10);
      - `PUBLIC_BASE_URL`: `https://shipscope-web.onrender.com` (bez ukośnika na końcu).
    - **shipscope-worker**:
      - `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`;
      - `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`;
      - `PUBLIC_BASE_URL` (ta sama wartość co w web).

    `DATABASE_URL` Render ustawi sam. Pola `DATABASE_SSL` nie ma i nie dodawaj go.

14. **Zatwierdź.** Kliknij **Apply** (albo „Deploy Blueprint”). Render utworzy bazę, zbuduje obie usługi,
    przygotuje bazę (migracje) i je uruchomi. Trwa to kilka–kilkanaście minut. Postęp widać po kliknięciu usługi →
    zakładka **Logs** (albo **Events**). Powinno być: obie usługi ze statusem „Live” (zielony).

### Po utworzeniu (ok. 15 minut)

15. **Sprawdź adres.** Kliknij usługę `shipscope-web`. Pod jej nazwą, u góry, jest adres, np.
    `https://shipscope-web.onrender.com` albo z dopiskiem (np. `https://shipscope-web-a1b2.onrender.com`). To jest
    Twój `<adres>`.

16. **Jeśli adres jest inny niż wpisany w krokach 9, 10 i 13**, popraw go w czterech miejscach:
    1. Render → `shipscope-web` → **Environment** → `PUBLIC_BASE_URL` → **Save changes** (usługa uruchomi się sama
       ponownie).
    2. Render → `shipscope-worker` → **Environment** → `PUBLIC_BASE_URL` → **Save changes**.
    3. GitHub App (krok 9.1, potem przycisk **Edit**) → Homepage URL, Callback URL, Setup URL, Webhook URL →
       **Save changes**.
    4. Aplikacja Atlassian → **Authorization** → **Configure** → Callback URL → **Save**.

17. **Sprawdź, czy działa.** Otwórz w przeglądarce:
    - `<adres>/health` — powinno być `{"status":"ok","version":"…"}`;
    - `<adres>/health/db` — powinno być coś z `"ok":true`.

18. **Pierwsze użycie.**
    1. Otwórz `<adres>` i zaloguj się przez GitHub. Trafisz na stronę „Create a workspace”: wpisz nazwę (np. nazwę
       zespołu) i kliknij **Create**. Przejdziesz do ustawień.
    2. Sekcja **GitHub** → **Install the GitHub App…** → wybierz organizację lub konto i repozytoria → **Install**.
       GitHub poprosi o ponowne zalogowanie — to celowe. Po powrocie kliknij **Repositories** przy instalacji, a
       potem **Track** przy repozytoriach, które chcesz widzieć.
    3. Sekcja **Jira** → **Connect Jira** → zaakceptuj w Atlassian. Zaznacz tablice swoich zespołów →
       **Save selection** → **Sync now**.
    4. Kliknij **Dashboard** u góry. Deploye pojawią się w ciągu kilku minut, zadania Jiry od razu po „Sync now”.

19. **Sprawdź powiadomienia (webhooki).**
    - GitHub: strona GitHub App (krok 9.1 → **Edit**) → zakładka **Advanced** → **Recent Deliveries**. Po pierwszym
      deployu w śledzonym repo powinien tam być wpis z kodem **202** (zielony znaczek).
    - Jira: w ustawieniach ShipScope, w sekcji Jira, powinno być „instant updates on”.

20. **Daj znać, jak poszło.** Przyślij adres serwisu i to, co pokazuje `<adres>/health`. Jeśli coś nie działa, przyślij
    zrzut ekranu i logi: Render → usługa → **Logs**. Skopiuj kilkadziesiąt linii z okolic błędu, ale sprawdź, czy
    nie ma w nich sekretów. Szczególnie ważne są logi, jeśli w kroku 19 powiadomienia z Jiry dostają kod **401**.

---

## C. Sprawdzenie, czy wszystko działa (można później)

Tę część możesz robić na komputerze (`<adres>` = `http://localhost:3000`) albo w Renderze. Kroki 39–48 działają
tylko w Renderze.

Dwie umiejętności, które się przydadzą:
- **Konsola przeglądarki**: naciśnij `F12` (na Macu `Cmd+Option+J` w Chrome), wybierz zakładkę **Console**. Tam można
  wkleić polecenie i nacisnąć Enter. Czerwone linie to błędy.
- **Drugie konto GitHub**: do testów zaproszeń i uprawnień przyda się drugie konto (np. kolegi) albo okno
  prywatne/incognito z innym kontem.

### Logowanie i zaproszenia

21. W oknie incognito otwórz `<adres>/t/<id>/settings`. Powinno poprosić o logowanie GitHub i po nim wrócić na tę
    samą stronę.
22. W ustawieniach, sekcja **Workspace** → wybierz rolę `member` → **Create invitation link**. Powinien pojawić się
    link w żółtej ramce z napisem „shown only once”. Skopiuj go, potem kliknij **Done, I copied it**. Ramka znika.
23. Otwórz ten link drugim kontem GitHub (okno incognito). Po zalogowaniu wklej w konsoli przeglądarki:

    ```
    fetch(location.pathname + '/accept', { method: 'POST' }).then(r => r.json()).then(console.log)
    ```

    Powinno być: w konsoli informacja o dołączeniu. Drugie konto, po otwarciu `<adres>`, widzi dashboard. Ustawienia
    widzi bez przycisków zmian. U Ciebie w sekcji **Workspace** widać nowego członka.
24. Jako jedyny admin kliknij **Leave** przy sobie. Powinien pojawić się czerwony komunikat, a Ty zostajesz w
    workspace (ostatniego admina nie da się usunąć).

### Repozytoria i deploye (GitHub)

25. Po **Track** repozytorium ma etykietę „not synced yet”. Po maksymalnie 15 minutach zmienia się na „synced …”, a
    na dashboardzie, w widoku technicznym, widać wersje w tabeli środowisk i historię deployów.
26. Deploye do środowisk o nazwach `test`/`dev`, `qa`, `prod`/`production` trafiają do odpowiednich kolumn.
    Środowisko o innej nazwie (np. `staging`) jest pomijane.
27. Deploy oznaczony tagiem lub release'em (np. `v1.4.0`) pokazuje tę nazwę zamiast ciągu znaków (skrótu commita).
28. Jeśli repozytorium wdraża przez osobne gałęzie z plikiem wersji (np. `trigger.properties`): w ustawieniach repo
    wpisz nazwę tego pliku w polu **Version file**, a w polu **Paths not counted as drift** po jednej ścieżce w
    linii (np. `.github/`) → **Save**. Po następnej synchronizacji wersja i przycisk „Diff to …” pokazują
    rzeczywisty kod.
29. Odbierz aplikacji dostęp do jednego repozytorium: na GitHubie organizacja → **Settings** → **GitHub Apps** →
    aplikacja → **Configure** → odznacz repo. Po synchronizacji przy tym repo w ShipScope pojawia się czerwone
    „sync failed”, a pozostałe działają dalej.
30. **Stop tracking**, potem **Unlink** przy instalacji. Deploye znikają z dashboardu. Aplikacja zostaje
    zainstalowana na GitHubie (odinstalowuje się ją tam osobno).

### Jira: tablice i rytm pracy zespołów

31. Po **Connect Jira** i zgodzie wracasz do ustawień z napisem „Connected to <nazwa Twojej Jiry>”. Jeśli Atlassian
    pokazuje błąd o uprawnieniach („scope”), w aplikacji Atlassian brakuje któregoś uprawnienia z kroku 10.
32. Lista tablic pokazuje wszystkie tablice z rodzajem: `scrum`, `simple` albo `kanban`. Po zaznaczeniu →
    **Save selection** → **Sync now** pojawia się zielony komunikat „Synced N board(s)…”, a przy każdej tablicy
    „Now: …” z bieżącym okresem.
33. **Rytm** to sposób, w jaki ShipScope grupuje pracę zespołu. Przy ustawieniu „Auto-detect” powinno być:
    - zespół z nazwami sprintów typu `Sparks 27.3.1` → okres `PI-27.3`;
    - zespół ze zwykłymi sprintami → nazwa sprintu, np. `Sprint 7`;
    - tablica kanban albo bez sprintów → wersja (np. `PAY 1.2`), jeśli projekt używa wersji, albo miesiąc
      (`Flow 2026-10`).
34. Jeśli zespoły są w różnych okresach, dashboard otwiera się na „Now: …” — zadaniach wszystkich zespołów naraz.
    Pozostałe okresy są do wybrania z listy u góry.
35. Własne nazewnictwo PI: przy tablicy wybierz rytm **Program increments (SAFe)**, w polu **PI naming** wpisz np.
    `PI {pi} / Iteration {n}` → **Save** → **Sync now**. Sprint `PI 7 / Iteration 2` trafia do okresu `PI-7`.
    Tekst bez `{pi}` jest odrzucany z komunikatem. Przy rytmie **Sprints (Scrum)** to pole jest nieaktywne.
36. Rytm **Releases (Fix Version)**: bieżący okres to najbliższa niewydana wersja projektu. Rytm
    **Monthly flow (Kanban)**: zadania zakończone w tym miesiącu plus wszystkie w toku.
37. Odbierz ShipScope dostęp do Jiry: https://id.atlassian.com/manage-profile/apps → przy aplikacji **Remove access** →
    w ShipScope **Sync now**. Powinna pojawić się czerwona informacja „Jira access was revoked…”. Kliknij
    **Reconnect Jira**, żeby przywrócić dostęp.
38. **Disconnect** usuwa połączenie i zadania z dashboardu (do testu na końcu albo na osobnym workspace).

### Powiadomienia i aktualizacje (tylko Render)

39. W ustawieniach przy GitHub i przy Jira jest zielone „instant updates on”. Jeśli przy Jirze jest „off”, obok jest
    powód (np. „Reconnect Jira…”) — zrób to, co mówi, i kliknij **Sync now**.
40. Zrób deploy w śledzonym repozytorium. W GitHub App → **Advanced** → **Recent Deliveries** pojawia się wpis
    `deployment_status` z kodem **202**. Deploy widać na dashboardzie w ciągu ok. minuty.
41. Test zabezpieczenia: w GitHub App (**General** → **Webhook secret**) wpisz na chwilę inny sekret → zapisz →
    w **Recent Deliveries** przy ostatnim wpisie kliknij **Redeliver**. Powinien być kod **401** (ShipScope odrzucił
    niepodpisane powiadomienie). Przywróć właściwy sekret (krok 8).
42. Zmień w Jirze status zadania z zsynchronizowanej tablicy. W ciągu ok. minuty zmiana jest widoczna na dashboardzie.
    W Renderze, w **Logs** usługi `shipscope-web`, widać wpis `/webhooks/jira` z kodem 202.
43. **Jeśli krok 42 nie działa** (kod 401 w logach albo brak zmiany po kilku minutach), przyślij:
    - fragment logu `shipscope-web` z wpisami `/webhooks/jira`;
    - informację, czy w ustawieniach jest „instant updates on”.

    To jedyna rzecz, której nie dało się sprawdzić przed prawdziwym wdrożeniem: dokładny format powiadomień z Jiry.
    Do czasu poprawki zadania aktualizują się co 15 minut, jak dotąd.
44. Dodaj w ustawieniach tablicę z innego projektu Jiry → **Save selection** → **Sync now**. Nadal jest „instant
    updates on”, a zmiany w zadaniach nowego projektu też przychodzą od razu.
45. Nowa wersja: po każdym zatwierdzeniu (merge) zmian w programie Render sam wdraża nową wersję.
    `<adres>/health` pokazuje wtedy nowy numer w polu `version`.
46. Cofnięcie wersji: Render → usługa → **Events** (albo **Deploys**) → przy poprzednim wdrożeniu **Rollback**.
    `<adres>/health` pokazuje poprzedni numer. Uwaga: zmiany w bazie danych się nie cofają.
47. Restart workera: Render → `shipscope-worker` → **Manual Deploy** albo **Restart**. W **Logs** od razu pojawia się
    synchronizacja i co 30 sekund `heartbeat ok`.
48. Ciasteczko logowania jest bezpieczne: `F12` → zakładka **Application** (Chrome) → **Cookies** → ciasteczko `sid`
    ma zaznaczone **Secure** i **HttpOnly**.

### Feature flagi

Tu potrzebny jest terminal (część „Słowniczek”). `curl` to polecenie do wysyłania zapytań do serwera, jest
zainstalowane na Macu i w Git Bash.

49. W ustawieniach, sekcja **Feature flags** → **Add a source**: nazwa np. `LaunchDarkly`, Kind `runtime` →
    **Add source**. Pojawi się token w żółtej ramce (pokazuje się tylko raz). Skopiuj go.
50. W terminalu wpisz (podmień `<adres>` i `<token>`):

    ```
    export SS=<adres>
    export TOKEN=<token>
    curl -s -X POST "$SS/api/flags/ingest" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"schemaVersion":2,"observations":[{"key":"newCheckout","env":"prod","state":"partial","rollout":25},{"key":"newCheckout","env":"test","state":"on"}],"flags":[{"key":"newCheckout","description":"Nowy checkout","jiraKeys":["ABC-1"]}]}'
    ```

    Powinno być: odpowiedź z liczbami (`created`, `changed`), a na dashboardzie, w widoku technicznym, flaga
    `newCheckout`.
51. To samo polecenie z innym tokenem (np. `export TOKEN=xyz`) zwraca błąd 401 — obcy nie może wysłać flag.
52. Przy źródle kliknij **New token**, wyślij flagi nowym tokenem (krok 50), potem przy starym tokenie kliknij
    **revoke**. Stary przestaje działać (401), nowy działa.
52a. Powiązanie z Jirą przez pole: poproś admina Jiry o pole „Feature flag” (SETUP.pl.md §4, „Powiązanie flag z
    zadaniami w Jirze”) i wpisz w nim `newCheckout` w jednym zadaniu z synchronizowanej tablicy. W ShipScope:
    Jira → „Feature flags in Jira” → **In a field** → wybierz pole → **Save** → **Sync now**. Powinno być: w sekcji
    Feature flags przy `newCheckout` to zadanie z dopiskiem „(from Jira)”.
52b. Bez admina: zamiast pola wybierz **In labels with a prefix** (np. `flag:`) i dodaj zadaniu etykietę
    `flag:newCheckout` → **Save** → **Sync now**. Efekt jak w 52a.
52c. Przy fladze wpisz opis i klucz zadania (np. `ABC-12`) → **Save**. Opis zastępuje opis ze źródła, a zadanie ma
    dopisek „(set here)”. Wyślij jeszcze raz polecenie z kroku 50: opis i ręczne powiązanie zostają.

### Ustawienia i bezpieczeństwo

53. **Workspace** → pole „Keep deployment history”: wpisz `3` → **Save**. Przeglądarka nie pozwala zapisać (minimum
    to 7). Wpisz `120` → **Save** → odśwież stronę. Nadal jest 120.
54. Przyciski usuwania (**Stop tracking**, **Unlink**, **Disconnect**, **Delete**, **revoke**) pytają „Czy na pewno”.
    **Anuluj** niczego nie zmienia.
55. Na telefonie (albo `F12` → ikonka telefonu u góry narzędzi → szerokość ok. 390) strona ustawień mieści się na
    ekranie bez przesuwania w bok. W konsoli nie ma czerwonych błędów.
56. Drugie konto, które nie jest członkiem workspace'u, otwiera `<adres>/t/<id>/settings`. Powinno zobaczyć błąd
    „not found” (404), a nie Twoje dane.
57. Drugie konto z rolą `member` wkleja w konsoli na stronie ustawień:

    ```
    fetch('/tenants/<id>/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deploymentRetentionDays: 30 }) }).then(r => console.log(r.status))
    ```

    Powinno być: `403` — zwykły członek nie może zmieniać ustawień.
58. Otwórz kolejno adresy:
    - `<adres>/t/<id>/data/deployments.json`;
    - `<adres>/ui/web.js`;
    - `<adres>/auth/github/login?returnTo=https://example.com`.

    Każdy powinien dać błąd (400 albo 404). Żaden nie pokazuje zawartości pliku i żaden nie przenosi na
    example.com.
59. Utwórz drugi workspace (strona `<adres>/start`) o nazwie `<img src=x onerror=alert(1)>`. Nazwa wyświetla się jako
    zwykły tekst i nie wyskakuje żadne okienko.

60. Usuwanie workspace'u (na końcu, na workspace założonym do testów — np. tym z kroku 59): w ustawieniach, sekcja
    **Workspace**, na dole **Delete workspace**. Wpisz nazwę z błędem → **Delete workspace** → czerwony komunikat, nic
    nie znika. Wpisz nazwę dokładnie → potwierdź w okienku. Powinno być: przejście na `/start` (albo do innego Twojego
    workspace'u); stary adres `<adres>/t/<id>/settings` pokazuje „not found”. Członek bez roli admin nie widzi tej
    sekcji.

Po testach zapisz w `docs/project/journal.md` (albo prześlij mi) datę, gdzie testowałeś (komputer czy Render) i
numery kroków, które nie przeszły.
