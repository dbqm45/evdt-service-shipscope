# Notki o dryfcie przy tej samej etykiecie wersji na środowiskach

Status: **znaleziono przyczynę, rozwiązane konfiguracją** (zob. ostatnia aktualizacja, „przyczyna: commity-wyzwalacze").
Pierwotnie zapisane 2026-10-12 jako otwarte; sekcje poniżej zostawiono w brzmieniu z tamtej chwili.

## Obserwacja

W Technical view serwis pokazuje tę samą wersję na QA i PROD, a mimo to PROD ma „417 behind QA” oraz
„N commit(s) skipped QA”.

Konkretny przypadek, odczytany z `docs/data/deployments.json` na `live` (serwis
`evnm-service-charger-infrastructure`):

| Środowisko | Etykieta wersji | `resolvedRef` (SHA) | Wdrożono (UTC) |
|---|---|---|---|
| QA | `v1.4.19` | `9999cc58b9c463b5e6ddd2fec025e35dd49fd3d0` | 2026-10-08 04:44 |
| PROD | `v1.4.19` | `ba8fe699174ab92f9f7c128cf02784d1e8174032` | 2026-10-08 11:44 |

Ostatni rekord PROD ma `driftBehind: { behindEnv: "qa", commitCount: 417, untestedIn: "qa",
untestedCommitCount: 325 }`. (Zgłaszający podał 235 dla drugiej liczby, a na `live` było 325 — albo literówka,
albo dane zmieniły się po ostatnim syncu. Niezweryfikowane.)

## Skąd te liczby (z kodu)

- `computeEnvDrift()` w `scripts/sync-github-deployments.js` **nie** porównuje etykiet wersji. Woła GitHub
  `compare/{laterRef}...{earlierRef}` na `resolvedRef || version` i pomija wywołanie tylko wtedy, gdy oba ref-y
  są identycznymi napisami.
- `commitCount` = `ahead_by` (commity na QA, których brakuje na PROD); `untestedCommitCount` = `behind_by`
  (commity na PROD, których QA nigdy nie miało). Obie niezerowe oznaczają **rozbieżne historie**, a nie jedną
  linię przodków.
- `resolvedRef` to surowy SHA, czyli żaden Release ani tag nie wskazuje dokładnie na któryś z tych commitów.
  Wyświetlane `v1.4.19` najpewniej pochodzi więc z wyrażenia regularnego po treści commita
  (`extractPromotedVersion`), które służy tylko do wyświetlania (CLAUDE.md → Deployments). Równe etykiety nie
  dowodzą tego samego kodu.

## Hipoteza (niezweryfikowana)

QA i PROD zbudowano z różnych gałęzi/historii noszących ten sam numer wersji — np. gałąź release'owa vs.
mainline po squash-merge — więc `compare` pokazuje setki commitów w obie strony, choć w głowie zespołu to „ta
sama wersja”. To byłoby poprawne zachowanie ShipScope z mylącą etykietą, a nie błąd liczenia.

## Jak potwierdzić

1. Otworzyć
   `https://github.com/circlek-global/evnm-service-charger-infrastructure/compare/ba8fe699174ab92f9f7c128cf02784d1e8174032...9999cc58b9c463b5e6ddd2fec025e35dd49fd3d0`
   — jeśli GitHub też pokazuje setki commitów w obie strony, ShipScope liczy poprawnie.
2. Sprawdzić, czy istnieje tag/Release `v1.4.19` i na który commit wskazuje; sprawdzić, do jakich gałęzi
   należą oba commity i z czego buduje każdy pipeline.
3. Zajrzeć do treści obu commitów, żeby zobaczyć, skąd wzięła się każda etykieta `v1.4.19`.

## Opcje, jeśli wzorzec jest realny

1. Pokazać wyraźne ostrzeżenie w notce dryfu, gdy etykiety wersji są równe, a SHA różne („ta sama etykieta,
   inne commity”).
2. Wyciszyć dryf, gdy etykiety są równe i żaden commit nie ma tagu/Release'u (ryzyko: ukrycie prawdziwego
   hotfixa, który użył tej samej etykiety).
3. Zostawić jak jest i polegać na istniejącej legendzie/tooltipie (`driftNoteTooltip()`, `FAQ.md`), które już
   opisują „bypassed that environment”.

Preferencja: brak decyzji — wybrać po kroku 1 powyżej.

## Powiązane

- CLAUDE.md → Deployments (`driftBehind`, `resolvedRef` vs wyświetlane `version`).
- `scripts/sync-github-deployments.js` `computeEnvDrift()`; `scripts/lib/deployment-records.js` (scalanie dryfu).
- Insights → „Rollbacks & drift over time” liczy te same rekordy.

## Aktualizacja 2026-10-12 — potwierdzone i częściowo wdrożone

- Krok 1 wykonał zgłaszający: `compare` na GitHubie dla tych dwóch SHA pokazuje **417 commitów**, zgodnie z
  `commitCount`. Liczenie w ShipScope jest więc poprawne; mylące było sformułowanie „N behind” dla dwóch
  buildów o tej samej etykiecie wersji.
- Wdrożone (opcja 1, zawężona): `computeEnvDrift()` dodaje `sameVersion: true` do wpisu `driftBehind`, gdy
  późniejsze i wcześniejsze środowisko mają tę samą etykietę `version`, ale różne ref-y. Karta środowiska w
  Technical view pokazuje wtedy **jedną** notkę „same version, different build: A / B commits vs QA” (A =
  commity tylko we wcześniejszym środowisku, B = tylko w tym; tooltip z `driftNoteTooltip('sameVersion', …)`)
  zamiast „A behind QA” + „B commit(s) skipped QA”. Same liczby się nie zmieniają i nadal zasilają karty
  podsumowania, nagłówek karty środowiska i Insights.
- Niewdrożone: wyciszanie dryfu, porównanie tag-do-tagu, użycie `merge_base_commit` do odróżnienia zwykłego
  opóźnienia od rozbieżnych historii. Istniejące rekordy dostaną flagę przy następnym syncu.

## Aktualizacja 2026-10-12 (później) — przyczyna: commity-wyzwalacze; naprawione przez `versionFile`

### Co ustalono

Sprawdzone przez GitHub API na `evapl-service-frontend`, który pokazywał „1135 behind test” (ten sam wzorzec co
w przypadku wyżej):

| Środowisko | Wdrożony commit | Czym jest commit | `trigger.properties` tam |
|---|---|---|---|
| QA | `4f516edc…` | „Deploy v1.6.0 to QA” — HEAD `deployment/qa`, zmienia tylko `trigger.properties` | `version=v1.6.0` |
| PROD | `0c8141d7…` | „Deploy v1.6.0 to PROD” — HEAD `deployment/prod`, zmienia tylko `trigger.properties` | `version=v1.6.0` |
| test | tag `v1.7.0` | sam kod aplikacji (na tym commicie nie ma `trigger.properties` — 404) | — |

- Prawdziwy kod to tag `v1.6.0` (`45fdc8c8…`, „feat(CHG-4640): Enabled export on PROD”). Release'u na GitHubie
  brak. Żaden z wdrożonych SHA nie jest tym tagiem, więc etykieta `v1.6.0` w ShipScope pochodziła z regexu po
  treści commita.
- `compare` QA…`v1.7.0`: ahead 1135 / behind 239, `diverged`; PROD…QA: 239 / 71, `diverged`. Wszystkie trzy mają
  wspólny merge base (`4cdd725d`), czyli to linie równoległe, a nie jedna ścieżka promocji. Tree SHA wszystkich
  trzech są różne, więc `sameTree()` słusznie niczego nie wyciszył. QA i PROD różnią się w 5 plikach, wszystkie to
  infrastruktura branchy deployment (`CODEOWNERS`, workflow, `.gitignore`, `README.md`, `trigger.properties`),
  a nie kod aplikacji.
- Wniosek: `computeEnvDrift()` liczył odległość w historii gita między **commitami-wyzwalaczami na osobnych
  branchach `deployment/*`**, a nie między wdrożonym kodem. Liczby były poprawne jako fakty z gita i bezużyteczne
  jako sygnał „o ile w tyle”. Hipoteza z sekcji wyżej („różne gałęzie z tym samym numerem wersji”) była trafna.
- `evnm-service-charger-infrastructure` i pozostałe serwisy działają tak samo (potwierdził zespół, nie
  weryfikowano ponownie przez API).

### Poprawka (tylko konfiguracja, bez zmian w kodzie)

`"versionFile": "trigger.properties"` jest teraz ustawione w `docs/components.json` dla wszystkich sześciu
komponentów (`evboweb-service-frontend` już je miał). Sam mechanizm już istniał (CLAUDE.md → Tracked components).

### Obecne działanie, per środowisko

Dla każdego deploymentu `sync-github-deployments.js` woła
`GET /repos/circlek-global/<komponent>/contents/trigger.properties?ref=<SHA deploymentu>` — plik **na wdrożonym
commicie**, nie na HEAD-zie brancha — i parsuje `version=…`.

1. Jeśli wartość jest istniejącym tagiem (`v1.6.0`), staje się `version`, `resolvedRef` i refem do compare.
2. W przeciwnym razie jest rozwiązywana jako commit (`/commits/<wartość>`) i używany jest ten SHA; `version`
   zachowuje etykietę.
3. Przy braku pliku, błędzie API lub nierozwiązywalnej wartości następuje powrót do dawnego zachowania
   (SHA / Release / tag / regex); sync się nie wywala, w logu jest `could not resolve trigger.properties version`.

Skutki w Technical view:

- **QA i PROD** rozwiązują się do `v1.6.0`. Równe ref-y pomijają compare, więc notka dryfu QA→PROD znika.
- Jeśli się różnią, `compare` idzie tag-do-tagu, więc liczby to commity prawdziwego kodu, a wykrywanie rollbacku
  (`status: "behind"`) też działa na tagach.
- **test** wdraża się z samego commitu z kodem, który nie ma `trigger.properties` (404 → ostrzeżenie w logu →
  fallback), więc zostaje przy swoim tagu (`v1.7.0`). To ostrzeżenie przy każdym deploymencie na test jest oczekiwane.
- `sameVersion` zostaje jako zabezpieczenie dla komponentów bez `versionFile` albo gdy plik nie da się rozwiązać.

### Wdrożenie i ograniczenia

- `orchestrate-full-sync.yml` czyta `components.json` z **`live`**, więc zmiana zadziała dopiero po scaleniu jej
  przez `sync-main-to-live.yml`; sync odpalony wcześniej nic nie zmieni.
- Dryf najnowszych rekordów jest liczony od nowa przy każdym syncu, a rekordy bez `versionFromFile` dostają ref
  z pliku w locie, więc dashboard powinien poprawić się już przy pierwszym syncu. Jeszcze nieobserwowane na `live`.
- Poprawne `version`/`relatedIssues` dostają tylko **nowo zsynchronizowane** deploymenty;
  `backfill-deployment-metadata.js` ich nie przelicza, więc starsze rekordy zachowają swoje do przycięcia przez
  `RETENTION_DAYS`.
- Wartość z pliku musi być istniejącym tagiem lub refem. Nie sprawdzono dla każdego komponentu: `evboweb-service-bff`
  miał przed zmianą na QA `4.2.15` (bez prefiksu `v`), co może nie być nazwą taga.
- Token GitHub App używany w syncu potrzebuje `contents: read` w każdym repo aplikacji (już czyta tam
  commity/compare).

### Nadal niewdrożone

Wyciszanie dryfu po etykiecie, użycie `merge_base_commit` do odróżnienia opóźnienia od rozbieżności i liczenie
zmienionych plików zamiast commitów. Wracać do tego tylko, jeśli komponent bez pipeline'u z commitami-wyzwalaczami
pokaże ten sam wzorzec.
