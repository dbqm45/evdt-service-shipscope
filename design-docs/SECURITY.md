# Bezpieczeństwo

Decyzje i zabezpieczenia, których nie widać od razu w kodzie: dlaczego są, przed czym chronią i czego nie
załatwiają. Szczegóły działania aplikacji (RLS, sesje, tokeny) są w `CLAUDE.md` i `server/README.md`.

## Akcje GitHub przypięte do SHA

**Stan:** wszystkie `uses:` w `.github/workflows/` wskazują pełny SHA commitu z wersją w komentarzu
(`actions/checkout@3d3c42e… # v7.0.1`). Pilnuje tego `test/workflows.test.js`. Aktualizacje proponuje Dependabot
(`.github/dependabot.yml`): raz w miesiącu jeden PR ze wszystkimi akcjami.

### Przed czym to chroni

`uses: actions/checkout@v7` wskazuje **tag**, a tag to ruchoma etykieta. Właściciel akcji albo ktoś, kto przejmie
jego konto lub token, może przesunąć `v7` na inny commit. Nasz workflow przy następnym uruchomieniu pobrałby nowy
kod bez żadnej zmiany w naszym repo i bez śladu w naszym PR. Tak się zdarzało: w marcu 2025 przejęto
`tj-actions/changed-files` i przestawiono wszystkie jej tagi na kod, który wypisywał sekrety do logów w tysiącach
repozytoriów.

Kod akcji działa w jobie z jego uprawnieniami i tokenem `GITHUB_TOKEN`. U nas:

| Job | Uprawnienia | Co mogłaby zrobić podmieniona akcja |
| --- | --- | --- |
| `release.yml` → `prepare` | `contents: write` | wypchnąć dowolny commit na `main`, zmienić wersję lub kod |
| `release.yml` → `publish` | `contents: write` | utworzyć albo przesunąć tag `vX.Y.Z` i wydanie |
| `release.yml` → `verify`, `test.yml`, `server-test.yml` | odczyt | odczytać kod (repo jest prywatne), zafałszować wynik testów |

Najgroźniejszy jest tag: inne repozytoria używają `adapters/flags@vX.Y.Z`, więc fałszywy tag to obcy kod w ich
potokach, z ich tokenami ShipScope — szkoda wychodzi poza to repo.

### Co daje przypięcie

- **SHA jest niezmienny** — commit o tym hashu ma zawsze tę samą treść; przesunięcie tagu po stronie akcji nas nie
  dotyczy.
- **Każda zmiana wersji akcji przechodzi przez nasz PR** — Dependabot otwiera „ci(deps): bump …” z listą zmian i
  dopiero merge wpuszcza nowy kod. Bez tego aktualizacja działa się po cichu.
- **Powtarzalność** — ten sam commit naszego repo zawsze uruchamia ten sam kod akcji.

### Czego to nie załatwia

- **Zależności samych akcji.** Akcja przypięta do SHA może w środku wołać inną akcję po tagu albo pobierać pliki
  (`setup-node` ściąga Node). Przypięcie chroni pierwszy poziom.
- **Obrazów Dockera.** `postgres:16-alpine` w `verify` i `server-test.yml` jest przypięty do tagu; można go
  przypiąć po digeście (`postgres@sha256:…`), ale te joby mają tylko odczyt.
- **Złego kodu w wersji, którą sami zatwierdzimy.** PR Dependabota trzeba przeczytać, nie mergować automatycznie.
- **Naszych własnych tagów.** To osobna sprawa: ruleset na `refs/tags/v*` (Settings → Rules → Rulesets) blokuje
  przesuwanie i usuwanie tagów wydań. Chroni tych, którzy używają naszego adaptera — przypięcie u nas tego nie robi.
  Zespoły, które chcą tej samej pewności po swojej stronie, mogą przypiąć adapter do SHA zamiast do tagu.

### Ocena

Ryzyko **niskie**: używamy tylko akcji GitHuba (`actions/checkout`, `actions/setup-node`), nie zewnętrznych
autorów, więc przejęcie jest dużo mniej prawdopodobne niż przy `tj-actions`. Skutek byłby jednak poważny (zapis do
`main` i tagi używane przez inne repo), a koszt poprawki mały: jednorazowa zmiana w trzech workflowach i jeden PR
Dependabota miesięcznie (kilka minut Actions na jego testy).

### Utrzymanie

- Nowy `uses:` w workflowie: pełny SHA i wersja w komentarzu (`git ls-remote --tags https://github.com/<owner>/<repo>`
  daje SHA dla tagu). Bez tego `npm test` nie przejdzie.
- PR Dependabota: przejrzeć listę zmian (notatki wydania akcji) przed merge'em; tytuł jest w formacie Conventional
  Commits, więc przechodzi sprawdzenie w `test.yml`.
- Opcjonalnie, w ustawieniach repozytorium (Settings → Actions → General) można wymusić, żeby workflowy używały
  wyłącznie akcji przypiętych do SHA — wtedy reguła nie zależy od testu. Do zrobienia ręcznie.

## Do zrobienia ręcznie (ustawienia, nie kod)

- Ruleset na tagi `v*`: blokada tworzenia, przesuwania i usuwania poza administratorami.
- Ruleset na `main`: blokada force-push i usuwania gałęzi.
- Limit wydatków na Actions ($0) i pomiar zużycia (Settings → Billing).
- Uprawnienia produkcyjnej GitHub App: tylko odczyt `actions`, `contents`, `deployments`, `metadata` (serwer i tak
  prosi o tokeny tylko z tymi uprawnieniami, `TOKEN_PERMISSIONS` w `server/lib/github-app.js`).
