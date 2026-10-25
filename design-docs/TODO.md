# TODO

Dług techniczny i otwarte sprawy, które nie są nowymi funkcjami (te są w [FEATURES.pl.md](FEATURES.pl.md)).
Zdecydowane prace na przyszłość, w kolejności: [ROADMAP.md](ROADMAP.md).
Każdy punkt sprawdzony z kodem 2026-10-17.

## Testy — czego jeszcze brakuje poza kodem

`test.yml` (`npm test`) i `server-test.yml` (serwer na prawdziwym Postgresie) działają na PR, a `main` testuje job
`verify` w `release.yml`.
Brakuje:

- reguły ochrony gałęzi `main`, która wymaga obu zielonych checków (ustawienia repozytorium);
- sprawdzania układu w prawdziwej przeglądarce w CI (atrapa DOM nie parsuje HTML, więc wyrównywanie wysokości
  wierszy i synchronizacja przewijania nie są sprawdzane; Playwright był dotąd uruchamiany tylko ręcznie).

## Zmiana sekretu podpisu endpointów jednego tenanta i log audytowy sekretów

Rotacja `TOKEN_ENCRYPTION_KEY` już działa (`TOKEN_ENCRYPTION_KEY_PREVIOUS`, `lib/secret-rotation.js`), a sekret
podpisu jest zapisany per tenant (`tenants.endpoint_signing_secret_enc`). ADR-003 (punkt 5) wymaga jeszcze: zmiany
sekretu podpisu przez admina jednego workspace'u (na wypadek wycieku) i logu audytowego dostępu do sekretów (kto
pokazał sekret podpisu, ustawił lub usunął token endpointu, połączył Jirę).

## Tryb jasny nie pokrywa wszystkich kolorów

Przy ostatnim przeglądzie tryb jasny obejmował ok. 36 z ~91 zahardkodowanych kolorów w `docs/style.css`.
Obejrzeć wszystkie widoki w trybie jasnym i uzupełnić brakujące zmienne.

## Wydzielenie `buildFallbackData()` z `docs/app-data.js`

Funkcja (ok. 300 linii przykładowych danych dla podglądu z `file://`) zaśmieca plik z logiką pobierania danych.
Przy przenoszeniu do osobnego pliku (np. `docs/app-fallback.js`) uważać na kolejność ładowania:
`const FALLBACK = buildFallbackData()` działa przy ładowaniu skryptu, więc nowy plik musi być wczytany w
`docs/index.html` po `app-model.js` (korzysta z jego helperów), a przed `app-main.js`. Bez modułów ES — nie
ładują się przez `file://`. Po zmianie sprawdzić podgląd otwarty z `file://`.
