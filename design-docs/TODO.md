# TODO

Dług techniczny i otwarte sprawy, które nie są nowymi funkcjami (te są w [FEATURES.pl.md](FEATURES.pl.md)).
Każdy punkt sprawdzony z kodem 2026-10-17.

## Akcje przypięte do tagów, nie do commit SHA

Workflowy (`test.yml`, `server-test.yml`, `pr-title.yml`, `release.yml`) używają `actions/checkout@v7` i
`actions/setup-node@v4`. Tag można przesunąć na inny commit bez ostrzeżenia, a `release.yml` ma prawo zapisu do
`main` i tworzy wydania. Przypiąć do SHA z komentarzem wersji (`uses: actions/checkout@<40-znakowy-sha> # v7.x.y`)
i dodać `.github/dependabot.yml`, który będzie je podbijał:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

## Testy — czego jeszcze brakuje poza kodem

`test.yml` (`npm test`) i `server-test.yml` (serwer na prawdziwym Postgresie) działają na PR i na `main`.
Brakuje:

- reguły ochrony gałęzi `main`, która wymaga obu zielonych checków (ustawienia repozytorium);
- sprawdzania układu w prawdziwej przeglądarce w CI (atrapa DOM nie parsuje HTML, więc wyrównywanie wysokości
  wierszy i synchronizacja przewijania nie są sprawdzane; Playwright był dotąd uruchamiany tylko ręcznie).

## Tryb jasny nie pokrywa wszystkich kolorów

Przy ostatnim przeglądzie tryb jasny obejmował ok. 36 z ~91 zahardkodowanych kolorów w `docs/style.css`.
Obejrzeć wszystkie widoki w trybie jasnym i uzupełnić brakujące zmienne.

## Wydzielenie `buildFallbackData()` z `docs/app-data.js`

Funkcja (ok. 300 linii przykładowych danych dla podglądu z `file://`) zaśmieca plik z logiką pobierania danych.
Przy przenoszeniu do osobnego pliku (np. `docs/app-fallback.js`) uważać na kolejność ładowania:
`const FALLBACK = buildFallbackData()` działa przy ładowaniu skryptu, więc nowy plik musi być wczytany w
`docs/index.html` po `app-model.js` (korzysta z jego helperów), a przed `app-main.js`. Bez modułów ES — nie
ładują się przez `file://`. Po zmianie sprawdzić podgląd otwarty z `file://`.
