# Klucze i sekrety klientów: po co są i jak je ustawić

ShipScope przechowuje sekrety klientów: tokeny odświeżania Jiry, tokeny do endpointów z flagami i sekret, którym
podpisuje żądania do tych endpointów. Ten dokument opisuje, czym są szyfrowane, co trzeba ustawić na Renderze, jak
wymieniać klucze i co robić, gdy coś pójdzie nie tak. Ogólna konfiguracja serwera jest w [SETUP.pl.md](SETUP.pl.md),
szczegóły techniczne (po angielsku) w [README.md](README.md), w sekcjach „Rotating TOKEN_ENCRYPTION_KEY” i
„Customer tokens only the worker can read”.

## W skrócie

| Zmienna | Web | Worker | Do czego | Bez niej |
|---|---|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | tak | tak | Klucz symetryczny (AES-256-GCM): sekret podpisu każdego workspace'u, krótkotrwałe tokeny dostępu Jiry, a bez pary kluczy niżej także tokeny Jiry i endpointów | Jira i flagi z endpointów są wyłączone |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | tylko przy rotacji | tylko przy rotacji | Poprzednie klucze symetryczne, żeby stare wartości dało się odczytać do czasu przeszyfrowania | — |
| `SECRETS_PUBLIC_KEY` | tak | tak | Klucz publiczny (X25519): web szyfruje nim tokeny Jiry i endpointów, ale nie umie ich odszyfrować | Tokeny szyfruje `TOKEN_ENCRYPTION_KEY`, czytelny dla obu serwisów |
| `SECRETS_PRIVATE_KEY` | **nigdy** | tak | Klucz prywatny: tylko worker odczytuje tokeny klientów | Worker nie wystartuje, jeśli jest klucz publiczny |
| `SECRETS_PRIVATE_KEY_PREVIOUS` | **nigdy** | tylko przy rotacji | Poprzednie klucze prywatne przy wymianie pary | — |

Wszystkie są w `render.yaml` z `sync: false`: Render prosi o wartość, a ta nigdy nie trafia do repozytorium.
Test `server/test/render-blueprint.test.js` pilnuje, żeby `SECRETS_PRIVATE_KEY` nie było zadeklarowane w serwisie web.

## Po co dwa rodzaje kluczy

**Serwis web jest wystawiony do internetu, worker nie.** Każdy, kto przejmie serwis web (jego zmienne środowiskowe,
pamięć, logi albo żądania), ma też wszystko, co ten serwis umie odszyfrować. Dlatego:

- **`TOKEN_ENCRYPTION_KEY`** chroni sekrety w bazie (kopia zapasowa, zrzut bazy), ale znają go oba serwisy.
- **Para kluczy `SECRETS_*`** sprawia, że web tylko szyfruje tokeny klientów. Odszyfrować je może wyłącznie worker.
  - **Tokeny endpointów:** „Testuj” z zapisanym tokenem trafia do kolejki, a worker wykonuje go w ciągu ok. 2 s.
  - **Tokeny Jiry:** gdy Settings potrzebuje Jiry (listy tablic i pól, „Sync now”, odłączenie), web prosi workera
    o token dostępu. Worker odświeża dostęp i zwraca krótkotrwały token ważny do godziny. Web używa go, dopóki nie
    wygaśnie.

| Co wycieka | Bez pary kluczy | Z parą kluczy |
|---|---|---|
| Sama baza (np. kopia zapasowa) | nic czytelnego | nic czytelnego |
| Środowisko serwisu web + baza | wszystkie tokeny Jiry i endpointów | żaden zapisany token; najwyżej token dostępu Jiry ważny do godziny i sekrety podpisu |
| Środowisko workera + baza | wszystko | wszystko (worker musi czytać tokeny, żeby pracować) |

Sekret podpisu żądań (nagłówki `X-ShipScope-Timestamp` i `X-ShipScope-Signature`) pozwala endpointowi klienta
odróżnić ShipScope od kogokolwiek innego. Jest zapisany zaszyfrowany osobno dla każdego workspace'u. Nie zmienia się
przy rotacji kluczy. Admin workspace'u może go wymienić sam (Settings → Sources → „Replace it”), na przykład po
wycieku.

Połączenie z pdi (Settings → Integrations → pdi) ma własny sekret podpisu zdarzeń i pingu, niezależny od sekretu
workspace'u. ShipScope pokazuje go raz przy połączeniu jako `PDI_SHIPSCOPE_SIGNING_SECRET` i trzyma zaszyfrowany
`TOKEN_ENCRYPTION_KEY` przy subskrypcji zdarzeń (`event_subscriptions.signing_secret_enc`). Rotacja kluczy go
przeszyfrowuje, a test odtworzenia kopii sprawdza, czy się otwiera. Nowy sekret daje rozłączenie i ponowne
połączenie.

## Pierwsze ustawienie (produkcja)

1. **Klucz symetryczny.** Wygeneruj go poleceniem `openssl rand -base64 32` i zachowaj kopię w menedżerze haseł.
   Ustaw go jako `TOKEN_ENCRYPTION_KEY` w obu serwisach.
2. **Para kluczy.** Wygeneruj ją poleceniem `npm run sealing-keys --prefix server`, które wypisze dwie linie:

   ```
   SECRETS_PUBLIC_KEY=MCowBQYDK2VuAyEA…
   SECRETS_PRIVATE_KEY=MC4CAQAwBQYDK2VuBCIEI…
   ```

   Klucz prywatny też zachowaj w menedżerze haseł. Jego utrata oznacza, że klienci muszą od nowa podać tokeny
   endpointów i połączyć Jirę.
3. Ustaw `SECRETS_PUBLIC_KEY` w **obu** serwisach, a `SECRETS_PRIVATE_KEY` **tylko w workerze**.
4. **Wdróż.** Worker przy starcie i potem raz na dobę (zadanie `secrets`) przeszyfrowuje istniejące tokeny:
   - tokeny zaszyfrowane `TOKEN_ENCRYPTION_KEY` przenosi na parę kluczy;
   - zapisuje sekret podpisu każdego workspace'u, który ma źródło typu endpoint.
5. **Sprawdź logi workera.** Powinna się w nich pojawić linia:

   ```
   secrets re-sealed: N in M tenant(s), 0 still on an older key (0 unreadable)
   ```

**Kolejność ma znaczenie.** Tę wersję wdróż i pozwól workerowi wystartować raz, zanim po raz pierwszy zmienisz
`TOKEN_ENCRYPTION_KEY`. Dopiero wtedy sekrety podpisu wszystkich workspace'ów są zapisane w bazie i zmiana klucza
ich nie ruszy.

Lokalnie (`npm run dev`) para kluczy nie jest potrzebna: bez niej wszystko działa na `TOKEN_ENCRYPTION_KEY`.

## Wymiana `TOKEN_ENCRYPTION_KEY`

Zaszyfrowane wartości zawierają identyfikator klucza (skrót SHA-256, nigdy sam klucz), więc klucz można wymienić bez
ponownego łączenia czegokolwiek:

1. Wygeneruj nowy klucz (`openssl rand -base64 32`).
2. W **obu** serwisach ustaw nowy jako `TOKEN_ENCRYPTION_KEY`, a stary jako `TOKEN_ENCRYPTION_KEY_PREVIOUS`. Kilka
   starych kluczy podaj po przecinku, od najnowszego. Wdróż.
3. Poczekaj, aż log workera pokaże `0 still on an older key`. Przy starcie dzieje się to od razu, potem raz na dobę.
4. Usuń `TOKEN_ENCRYPTION_KEY_PREVIOUS` z obu serwisów i wdróż.

## Wymiana pary kluczy `SECRETS_*`

1. Wygeneruj nową parę (`npm run sealing-keys --prefix server`).
2. **Web:** ustaw nowy `SECRETS_PUBLIC_KEY`.
3. **Worker:** ustaw nowy `SECRETS_PUBLIC_KEY` i nowy `SECRETS_PRIVATE_KEY`, a stary klucz prywatny wpisz do
   `SECRETS_PRIVATE_KEY_PREVIOUS`. Wdróż.
4. Poczekaj na `0 still on an older key` w logu workera, potem usuń `SECRETS_PRIVATE_KEY_PREVIOUS`.

## Wymiana sekretu podpisu jednego workspace'u

Robi to admin workspace'u w Settings → Sources → „Replace it”. Nowy sekret pokazuje się raz. Stary przestaje działać
od razu, więc endpoint klienta odrzuca odczyty, dopóki nie dostanie nowego sekretu. Flagi zostają takie, jakie były,
a środowisko pokazuje błąd i „?” na dashboardzie.

## Kto i kiedy dotykał sekretów

Settings → Sources → „Secret activity” pokazuje log audytowy: kto pokazał lub wymienił sekret podpisu, kto ustawił
lub usunął token endpointu i kto połączył lub odłączył Jirę. Log nigdy nie zawiera samego sekretu. Te same dane daje
`GET /tenants/:id/secret-events`. Pozostałe zmiany ustawień (członkowie, repozytoria, źródła flag, Jira) admin
widzi razem z nimi w Settings → General → „Settings activity” (`GET /tenants/:id/audit-events`).

## Gdy coś nie działa

| Objaw | Przyczyna | Co zrobić |
|---|---|---|
| Worker nie startuje: `SECRETS_PRIVATE_KEY does not belong to SECRETS_PUBLIC_KEY` | Klucze z różnych par | Ustaw w workerze klucz publiczny i prywatny z tej samej pary |
| Worker nie startuje: `the worker needs SECRETS_PRIVATE_KEY with SECRETS_PUBLIC_KEY` | Klucz publiczny jest, prywatnego brak | Dodaj `SECRETS_PRIVATE_KEY` w workerze |
| Przy źródle endpoint: `The endpoint token is sealed for the worker: set SECRETS_PRIVATE_KEY on it` | Worker nie ma klucza prywatnego | Jak wyżej |
| „Testuj” w Settings: `The worker did not run the test within a minute` | Worker nie działa albo nie ma klucza prywatnego | Sprawdź `/health/worker` i zmienne workera |
| Settings → Jira: 503 `The worker did not hand over a Jira token in time` | Worker nie odpowiada | Jak wyżej |
| Log: `N still on an older key (N unreadable)` | Stary klucz usunięty za wcześnie | Przywróć go w `…_PREVIOUS`. Jeśli przepadł, klient musi od nowa połączyć Jirę albo podać token endpointu |
| `The stored Jira token cannot be read` / `The stored endpoint token cannot be read` | Jak wyżej | Jak wyżej |
