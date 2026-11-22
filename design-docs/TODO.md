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

## Limit pamięci parsera plików flag znika przy fladze sterty w `NODE_OPTIONS`

Sprawdzone 2026-11-22. `lib/flag-file-parser.js` czyta pliki flag klientów w osobnym wątku z
`resourceLimits` (domyślnie 64 MB). Flagi V8 obowiązują cały proces, więc `--max-old-space-size` w `NODE_OPTIONS`
albo w linii poleceń zastępuje limit wątku: wątek dostaje stertę procesu (w kontenerze z
`--max-old-space-size=8192` parsowanie zużyło 446 MB przy limicie 8 MB). Dziś `render.yaml` nie ustawia
`NODE_OPTIONS`, a pozostałe limity (256 KB na plik, liczba węzłów, głębokość, czas) i tak ograniczają pamięć, więc
to obrona w głąb, nie dziura. Do zrobienia: przy starcie `web.js` i `worker.js` zmierzyć raz w próbnym wątku
`v8.getHeapStatistics().heap_size_limit` i zalogować ostrzeżenie, gdy limit nie działa; nie ustawiać flagi sterty
w `NODE_OPTIONS` na Renderze bez tej kontroli. Test pamięci w `server/test/flag-file-parser.test.js` w takim
środowisku jest pomijany z powodem.

## Tryb jasny nie pokrywa wszystkich kolorów

Przy ostatnim przeglądzie tryb jasny obejmował ok. 36 z ~91 zahardkodowanych kolorów w `docs/style.css`.
Obejrzeć wszystkie widoki w trybie jasnym i uzupełnić brakujące zmienne.

## Wydzielenie `buildFallbackData()` z `docs/app-data.js`

Funkcja (ok. 300 linii przykładowych danych dla podglądu z `file://`) zaśmieca plik z logiką pobierania danych.
Przy przenoszeniu do osobnego pliku (np. `docs/app-fallback.js`) uważać na kolejność ładowania:
`const FALLBACK = buildFallbackData()` działa przy ładowaniu skryptu, więc nowy plik musi być wczytany w
`docs/index.html` po `app-model.js` (korzysta z jego helperów), a przed `app-main.js`. Bez modułów ES — nie
ładują się przez `file://`. Po zmianie sprawdzić podgląd otwarty z `file://`.
