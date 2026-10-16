# Wersjonowanie i wydania

*English version: [RELEASING.md](RELEASING.md)*

ShipScope ma jeden numer wersji zgodny z [Semantic Versioning 2.0.0](https://semver.org/lang/pl/)
(`MAJOR.MINOR.PATCH`), zapisany w `package.json`, `server/package.json` i `server/package-lock.json` (`server/`
to osobna granica zależności z własnym `package.json`, więc sam przechowuje numer). Wydaną wersję oznacza tag git `vX.Y.Z`, a do
każdego tagu powstaje [GitHub Release](https://github.com/dbqm45/evdt-service-shipscope/releases) z wpisem z
`CHANGELOG.md`. Działający serwer podaje numer w `GET /health` (`version`).

Mechanizm jest taki sam jak w `dbqm45/ci_for_sdlc`; różnice są na końcu.

## Commity: Conventional Commits

Commity i **tytuły PR** mają format [Conventional Commits 1.0.0](https://www.conventionalcommits.org/pl/v1.0.0/).
PR-y łączymy przez *squash merge*, więc tytuł PR staje się commitem na `main` i decyduje o kolejnej wersji.

```
<typ>(<zakres>)!: <opis>

[treść: dlaczego, nie co]

[stopki, np. Refs: #21  albo  BREAKING CHANGE: <co i jak migrować>]
```

- **Opis**: w trybie rozkazującym, bez kropki na końcu, maks. 72 znaki.
- **Zakres** (opcjonalny), jedno słowo: klucz projektu `SHP`, jak w dotychczasowej historii, albo np. `server`,
  `deps`, `release`.

| Typ | Kiedy | Wpływ na wersję |
|---|---|---|
| `feat` | nowa funkcja dla użytkownika | MINOR |
| `fix` | poprawka błędu | PATCH |
| `perf` | szybciej, bez zmiany zachowania | PATCH |
| `refactor`, `test`, `docs`, `style`, `build`, `ci`, `chore`, `revert` | bez zmiany widocznej dla użytkownika | brak |
| `!` po typie/zakresie albo stopka `BREAKING CHANGE:` | zmiana niezgodna wstecz (dowolny typ) | MAJOR |

Sprawdzanie:

- **CI**: workflow `PR title` (`.github/workflows/pr-title.yml`) odrzuca tytuł PR niezgodny z formatem, także po
  edycji tytułu.
- **Lokalnie** (opcjonalnie, raz na klon): `npm run hooks:install` włącza hook `commit-msg` z `.githooks/`.
  Pojedynczy komunikat sprawdzisz poleceniem `npm run lint:commit -- "feat(SHP): …"`.

## Które podbicie (SemVer)

Decyduje **najpoważniejsza** zmiana od ostatniego tagu.

| Zmiana w publicznym API | Od 1.0.0 | W fazie 0.y.z (teraz) |
|---|---|---|
| niezgodna wstecz (usunięte/przemianowane pole lub trasa, zmiana znaczenia, nowe wymagane pole) | MAJOR | MINOR |
| nowa funkcja zgodna wstecz, nowe pole w odpowiedzi, oznaczenie jako przestarzałe | MINOR | PATCH |
| poprawka zgodna wstecz, łatka bezpieczeństwa, aktualizacja zależności | PATCH | PATCH |
| tylko dokumentacja, testy, CI, refaktoryzacja | bez wydania | bez wydania |

**0.y.z** oznacza, że publiczne API nie jest jeszcze stabilne (reguła 4 SemVer). **1.0.0** wydajemy świadomie
(ręczny PR, `npm run release -- 1.0.0`), gdy ktoś zacznie polegać na usłudze. To decyzja człowieka, CI jej nie
podejmie.

Publiczne API to tu to, na czym polegają użytkownicy i integracje: trasy HTTP `server/` (ścieżki, metody, pola
żądań i odpowiedzi, kody statusu, cookies), jego zmienne środowiskowe, schemat bazy widziany przez migracje,
formaty `docs/data/*.json` czytane przez dashboard oraz reużywalne workflowy wołane z repo aplikacji
(`check-flags.yml`, `notify-deployment.yml`). Szczegóły wewnętrzne (układ kodu, treść logów)
się nie liczą.

## Jak podbijana jest wersja (automatycznie)

Po każdym merge'u do `main` workflow `Release` (`.github/workflows/release.yml`):

1. **Liczy wersję** (`node scripts/release.js --ci`) z commitów od ostatniego tagu `vX.Y.Z`, według tabel wyżej.
   - Brak `feat`, `fix`, `perf` i zmian niezgodnych (np. same `docs`, `test`, `ci`, `chore`, `build`, `refactor`):
     brak nowej wersji, nic więcej się nie dzieje.
   - W przeciwnym razie ustawia nową wersję w trzech plikach wyżej i dopisuje wpis na górze `CHANGELOG.md`
     (sekcje *Breaking*, *Added*, *Fixed*) i `CHANGELOG.pl.md` (*Niezgodne*, *Nowe*, *Poprawione*) z tytułów commitów.
2. **Commituje** to na `main` jako `github-actions[bot]` z komunikatem `chore(release): X.Y.Z`. Push tokenem
   `GITHUB_TOKEN` nie uruchamia innych workflow, więc commit wydania nie wywołuje kolejnego wydania.
3. **Sprawdza** ten commit: `npm test` w katalogu głównym i testy `server/` na prawdziwym Postgresie.
4. **Tworzy tag** `vX.Y.Z` z adnotacją na commicie wydania, tylko gdy testy przeszły.
5. **Tworzy GitHub Release** `vX.Y.Z` z wpisem z changelogu (`node scripts/release-notes.js X.Y.Z`). Istniejący
   Release zostaje bez zmian; brakujący (np. przebieg padł po utworzeniu tagu) dorobi kolejny przebieg na `main`
   albo ręczne *Run workflow*.

Kilka PR-ów zmergowanych szybko po sobie: przebiegi czekają w kolejce (`concurrency: release`), więc nie policzą
tej samej wersji dwa razy. Gdy w trakcie wydania na `main` trafi nowy commit, push commitu wydania zostanie
odrzucony, a wszystko wyda przebieg dla nowszego commitu.

### Wydanie ręczne

Tylko gdy wynik z commitów trzeba nadpisać: źle oznaczony commit, przeredagowany changelog albo **1.0.0**.

1. Na świeżej gałęzi od `main`: `npm run release -- --dry-run`, potem `npm run release -- minor` (lub `major` /
   `patch` / `X.Y.Z`).
2. Przejrzyj i przeredaguj oba wpisy w changelogach.
3. Commit `chore(release): X.Y.Z` i PR o tym samym tytule.
4. Po merge'u workflow widzi w `package.json` wersję bez tagu i wydaje ją bez przeliczania: sprawdza wpis
   `## [X.Y.Z]` w `CHANGELOG.md` (bez niego nic nie zostanie otagowane), dalej jak w krokach 3–5.

Pierwsza wersja, **0.1.0**, powstała właśnie tak: po jej merge'u workflow tworzy tag `v0.1.0` i Release.

Zasady:

- **Wydanej wersji się nie zmienia.** Taga nie przesuwamy ani nie usuwamy; błąd w wydaniu naprawia kolejna wersja.
- **Wycofywanie funkcji**: najpierw MINOR z oznaczeniem „przestarzałe” i zastępstwem, usunięcie dopiero w MAJOR.

## Wymagania po stronie GitHuba

- *Settings → Actions → General → Workflow permissions*: workflow deklaruje `contents: write` dla jobów, które
  pushują; polityka organizacji ograniczająca `GITHUB_TOKEN` do odczytu blokuje wydanie.
- Reguła ochrony gałęzi `main` zabraniająca bezpośrednich pushy blokuje też commit `chore(release)`; pozwól
  `github-actions[bot]` ją omijać, inaczej wydanie zatrzyma się na kroku 2 z ostrzeżeniem.

## Różnice względem ci_for_sdlc

- Brak obrazu Dockera: `server/` wdraża się z `main` na Renderze, dashboard z `live` na GitHub Pages. Test dymny
  obrazu zastępuje krok 3 (testy na commicie wydania) i nic nie jest publikowane do rejestru.
- Skrypty to CommonJS `.js`, jak reszta `scripts/`, z testami w `test/conventional.test.js` i `test/release.test.js`.
- Zakres może być wielkimi literami (`SHP`), zgodnie z historią tego repo.
- Dwa changelogi (angielski i polski); wpis wersji trafia nad starsze sekcje z samą datą, a notatki wydania kończą
  się na następnym nagłówku drugiego poziomu dowolnego rodzaju.
- Brak pliku kontraktu API do odświeżania.
