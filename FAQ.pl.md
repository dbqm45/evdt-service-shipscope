# ShipScope FAQ — jak to jest liczone?

*English version: [FAQ.md](FAQ.md)*

Dla każdej liczby i plakietki na dashboardzie: skąd bierze się wartość, opisane zwykłym językiem, z nazwą skryptu
albo funkcji, która ją liczy, żeby dało się to sprawdzić. `README.pl.md` mówi, czym jest ShipScope; `CLAUDE.md` to
opis techniczny; `docs/GLOSSARY.md` wyjaśnia pojęcia, które mają więcej niż jedną nazwę.

ShipScope działa na dwa sposoby, z tym samym dashboardem: **synchronizacja plikowa** (GitHub Actions zapisują
pliki JSON, a GitHub Pages je serwuje) oraz **serwer ShipScope** (hostowany workspace dla organizacji,
konfigurowany w Settings). Zasady są w obu takie same, chyba że odpowiedź mówi inaczej.

## Deploymenty (widok Technical)

### Jak wyliczany jest „rollback”?

Każdy nowy deployment jest porównywany na GitHubie z tym, co wcześniej działało na tym samym środowisku (to samo
porównanie, które znajduje jego zadania Jiry i buduje link do zakresu commitów). Jeśli GitHub odpowie, że nowy
commit jest **`behind`** — jest przodkiem tego, co już działało — środowisko cofnęło się w historii, a deployment
dostaje plakietkę rollbacku z commitem, do którego wrócono. Nie ma znaczenia, czy to był celowy revert, czy pomyłka.
Nie wymaga to dodatkowego zapytania do API.
(Synchronizacja plikowa: `sync-github-deployments.js`, `issuesInRange`, pole `rollback: { toRef }`. Serwer:
`server/lib/deployment-sync.js`.)

### Jak ustalane jest, czy deployment był ręczny („manual”), czy automatyczny?

Historia statusów deploymentu zwykle wskazuje przebieg GitHub Actions, który go wykonał. ShipScope pyta GitHuba, co
uruchomiło ten przebieg: `workflow_dispatch` (przycisk „Run workflow”) oznacza ręczny; push, harmonogram i podobne —
automatyczny. Bez takiego wskazania deployment liczy się jako nie-ręczny. Synchronizacja plikowa sprawdza najwyżej
30 przebiegów na jedno uruchomienie, żeby duża zaległość nie zrobiła go kosztownym; reszta zostaje nieustalona.
(`sync-github-deployments.js`, `resolveManualFlag`, `MAX_MANUAL_LOOKUPS_PER_RUN`; serwer:
`server/lib/deployment-people.js`, który wymaga uprawnienia GitHub App do odczytu Actions.)

### Jak liczony jest czas trwania deploymentu?

To czas między najwcześniejszym a najpóźniejszym statusem zapisanym przez GitHuba (w kolejce, w toku, sukces…).
Znacznik `inactive`, który GitHub dopisuje później, gdy nowszy deployment zastępuje ten, jest pomijany. Przy jednym
statusie nie ma czego mierzyć, więc czas nie jest pokazywany — to nie znaczy, że deploy trwał chwilę.
(`computeDeployDurationMs`.)

### Skąd bierze się wersja pokazywana przy deploymencie?

Zasada jest ta sama dla każdego środowiska; różni się tylko to, który commit jest tam wdrożony. Wygrywa pierwsze
trafienie:

1. **Release** na GitHubie wskazujący dokładnie ten commit;
2. zwykły **tag** gita na tym commicie;
3. **plik wersji** we wdrożonym commicie, jeśli komponent ma go ustawionego (`versionFile` w synchronizacji
   plikowej; na serwerze Settings → GitHub → Tracked repositories → Version file) — dla repozytoriów, których
   commity wdrażane na QA/PROD zawierają tylko linię w rodzaju `version=v1.6.0`;
4. ciąg wyglądający na wersję (`v1.2.3`, `1.2.3`) w **opisie commita**;
5. skrócony **SHA commita**.

Release i tag są przed opisem commita, bo wolny tekst może wspominać niezwiązaną wersję; Release albo tag to celowy
sygnał. Deploy prosto z commita z gałęzi funkcjonalnej zwykle kończy się na SHA, bo żadnego sygnału nie ma. Do
porównań na GitHubie używany jest tylko potwierdzony Release/tag (albo SHA); wersja wzięta z opisu jest tylko
pokazywana. Releasy i tagi są pobierane raz na synchronizację, nie na każdy deployment.
(`sync-github-deployments.js`: `shaToRelease`, `shaToTag`, `extractPromotedVersion`; serwer:
`server/lib/version-resolution.js`.)

### Co znaczy „Diff to TEST” i kiedy się pojawia?

Karta środowiska pokazuje **„Diff to TEST”** (albo „Diff to QA” — poprzedni etap w `test` → `qa` → `prod`) tylko
wtedy, gdy **kod** jej bieżącego deploymentu różni się od kodu tamtego środowiska. Szczegóły po kliknięciu.

Jak to jest ustalane dla każdej pary środowisk:

1. Porównywane są **drzewa gita** obu wdrożonych commitów. To samo drzewo oznacza te same pliki: brak znacznika,
   niezależnie od liczby commitów między nimi (merge, squash i gałęzie wdrożeniowe tworzą nowe commity dla
   identycznego kodu).
2. W przeciwnym razie listy plików są porównywane po ścieżce i treści. Ścieżki z listy ignorowanych komponentu
   (elementy wdrożenia, np. `.github/`, `README.md`, `trigger.properties`; `driftIgnorePaths` w synchronizacji
   plikowej, Settings → GitHub na serwerze) się nie liczą. Jeśli nie zostaje żaden różniący się plik — brak
   znacznika.
3. Jeśli porównaniu nie da się ufać — błąd GitHuba albo repozytorium za duże na jedną listę (100 000 pozycji /
   7 MB) — wynik to **Unknown**, nigdy „brak różnicy”.

Okno pokazuje liczbę różniących się plików (zmiana nazwy liczy się jako dwa), pierwsze 20 ścieżek i liczbę
pominiętych; potem liczby z **historii gita**: commity, które ma drugie środowisko, a tego brakuje, i odwrotnie (np.
hotfix, który ominął wcześniejsze środowisko). Historia liczy commity, nie kod, więc „786 behind TEST” może oznaczać
zero zmienionych plików; to tylko kontekst. Porównanie nie obejmuje konfiguracji, zmiennych środowiskowych, obrazów
ani feature flag.

Żeby sprawdzić, czy dwa środowiska naprawdę mają różne zmiany, porównaj zadania Jiry (albo link do zakresu
commitów) ich bieżących deploymentów w historii deploymentów: brak części wspólnej oznacza niezwiązane zmiany, a
nie to samo wydanie w innym tempie.
(`compareTrees()`, `scripts/lib/tree-diff.js`; serwer: `server/lib/env-drift.js`.)

### Jak długo trzymane są deploymenty i kiedy pojawia się nowy?

ShipScope pokazuje stan bieżący; pełną historię ma GitHub. Deploymenty starsze niż 90 dni są usuwane przy każdej
synchronizacji (plikowo: `RETENTION_DAYS`; serwer: Settings → Workspace, 7–730 dni), z wyjątkiem — dla każdego
komponentu i środowiska — najnowszego deploymentu i najnowszego udanego, których potrzebują „bieżąca wersja”, drift
i rollback. To, czy zadanie kiedykolwiek trafiło na środowisko, jest zapamiętywane osobno i przeżywa to sprzątanie
(`issue-deployments.json` / tabela `issue_deployments`).

- **Synchronizacja plikowa:** jeden wspólny plik `docs/data/deployments.json` dla wszystkich komponentów. Deploy
  uruchamia synchronizację tylko tego komponentu (workflow „Notify ShipScope” w repozytorium aplikacji, zob.
  `ONBOARDING.pl.md`), więc pojawia się w ciągu kilku minut; codzienne uruchomienie o 3:00 synchronizuje wszystko
  na wypadek zgubionego sygnału. `deployments-cursor.json` pamięta najwyższy już przetworzony deployment, więc
  usunięte deploymenty nie są przetwarzane ponownie.
- **Serwer:** domyślnie co 15 minut, a przy włączonych webhookach w ciągu ok. 30 sekund od powiadomienia z GitHuba.

### Co to jest `docs/data/summary.json`?

Wyliczona z góry kopia — dla każdego komponentu i środowiska — bieżącego (najnowszego udanego) deploymentu i
najnowszego deploymentu niezależnie od wyniku, czyli dokładnie tego, co synchronizacja i tak ustala przy usuwaniu
starych rekordów. Służy tylko szybszemu pierwszemu wyświetleniu: bez niej strona przeszukuje cały
`deployments.json` dla każdego komponentu i każdej komórki macierzy. Gdy wpisu brakuje, strona wraca do
przeszukiwania, więc plik może być przez chwilę nieaktualny, ale nigdy nie daje złego wyniku. Tylko synchronizacja
plikowa. (`buildSummary`; `currentVersion()` w `docs/app-model.js`.)

### Dlaczego niektóre zapytania do API GitHuba są warunkowe (ETag)?

Na powtórzone zapytanie, którego dane się nie zmieniły, GitHub odpowiada `304 Not Modified`, co nie zużywa limitu
zapytań. Synchronizacja plikowa korzysta z tego dla trzech list pobieranych przy każdym uruchomieniu (pierwsza
strona deploymentów, tagi, releasy); większość uruchomień nie znajduje nic nowego, więc te odpowiedzi nic nie
kosztują. Zapytania dotyczące pojedynczego deploymentu są wykonywane raz, więc nie ma czego odświeżać. Pamięć
podręczna przetrwa między uruchomieniami dzięki `actions/cache`.
(`scripts/lib/github-api.js`, `etagCache`; `orchestrate-full-sync.yml`, krok „Cache GitHub API ETags”.)

## Feature flagi

### Skąd pochodzą flagi i jak ustalany jest ich stan?

Dla każdej flagi i środowiska są dwa osobne miejsca: **build** (wartość wbudowana w aplikację przy budowaniu) i
**runtime** (przełączana na żywo przez backend). Gdy są oba, dashboard pokazuje runtime, a niezgodność jest
oznaczana (zob. niżej).

- **Serwer:** ShipScope sam nigdy nie czyta flag (`design-docs/ADR-001-flags-pushed-from-outside.md`). Admin
  dodaje źródła flag w Settings; każde źródło wysyła pełny stan swoich flag (`off` / `on` / `partial` z procentem
  rolloutu) własnym tokenem do `POST /api/flags/ingest`. Flaga, której źródło przestaje wysyłać, znika; starsza
  wiadomość nigdy nie nadpisuje nowszej; gdy kilka źródeł jednego rodzaju zgłasza tę samą flagę, wygrywa wyższy
  priorytet. (`server/lib/flags.js`, reguły w `server/lib/flags-logic.js`.)
- **Synchronizacja plikowa:** flagi build są znajdowane przez przeszukanie repozytoriów aplikacji (pliki
  `*.generated.ts` pokazują, że flaga istnieje; katalogi `flag-parts/` z `default.ts` i opcjonalnymi
  `test.ts`/`qa.ts`/`prod.ts` dają wartość dla każdego środowiska; jedno i drugie wyrażeniami regularnymi, więc
  zmiana sposobu generowania tych plików to pierwsze miejsce do sprawdzenia). Flagi runtime są odpytywane z
  endpointu HTTP backendu dla każdego środowiska. Każda flaga wymaga wypełnionego wpisu w `flags-meta.json` (opis,
  klucze Jiry, komponenty); nowe flagi dostają szkic, a sprawdzenie w PR nie przechodzi, dopóki wpis nie jest
  uzupełniony. (`resolve-all-flag-states.js`, `sync-runtime-be-flags.js`, `check-flags-metadata.js`.)

### Do których zadań Jiry należy flaga?

- **Serwer:** z trzech miejsc, połączonych: klucze dołączane przez źródło, klucze ustawione ręcznie przez admina w
  Settings (źródło ich nie nadpisuje) oraz sama Jira — pole niestandardowe albo prefiks etykiety wybrany przez
  workspace w Settings (Jira → Feature flags in Jira).
- **Synchronizacja plikowa:** `jiraKeys` w `flags-meta.json`.

### Jak liczona jest notka o nieużywanej fladze (🧹)?

Tylko dla flagi z co najmniej jednym powiązanym zadaniem Jiry, z których wszystkie są Done. ShipScope bierze wtedy
najdłuższy czas, przez jaki flaga jest włączona na którymkolwiek środowisku; od 60 dni sugeruje jej usunięcie. Jeśli
któreś zadanie nie jest Done albo flaga jest wszędzie wyłączona, nic nie jest pokazywane. (`flagStaleWarning`,
`STALE_FLAG_DAYS`, `docs/app-technical-flags.js`.)

### Jak liczone jest ostrzeżenie „blast radius”?

Tylko dla flagi powiązanej z więcej niż jednym zadaniem Jiry: jeśli przynajmniej jedno jest Done, a przynajmniej
jedno nie, włączenie flagi wypuściłoby niedokończoną pracę razem z gotową, więc pojawia się ostrzeżenie.
(`flagBlastRadius`.)

### Jak pokazywana jest niezgodność build i runtime?

Gdy flaga na danym środowisku ma wartość build i wartość runtime, które się różnią, plakietka środowiska na liście
flag ma przerywaną ramkę, a podpowiedź pokazuje ukrytą wartość build — tę, która wróci, jeśli nadpisanie runtime
zostanie usunięte. (`renderFlags`, `docs/app-technical-flags.js`.)

### Kiedy flaga się pojawiła i kto ją zmieniał?

Synchronizacja plikowa zapisuje `createdAt` raz, gdy flaga zostaje po raz pierwszy znaleziona albo uzupełniona;
zmiany stanu flag są w `flag-state-history.json`. Zmiany sprzed powstania tego dziennika można odtworzyć z historii
gita gałęzi `live` (`backfill-flag-state-history.js`), ale bez autora — takie wpisy mają „unknown (backfilled from
git history)”. Serwer zapisuje każdą zmianę wartości w `flag_value_history`.

## Jira

### Które zadania pokazuje ShipScope?

- **Serwer:** admin wybiera tablice w Settings. Każda synchronizacja czyta w całości bieżący okres każdej tablicy
  (PI, sprint, wydanie albo miesiąc — zależnie od rytmu tablicy) oraz Epiki jego zadań; pierwsza synchronizacja
  tablicy bierze też poprzedni okres. Sprint zadania to ten z synchronizowanej tablicy. Starsze okresy zostają
  takie, jakie były przy ostatnim odczycie.
- **Synchronizacja plikowa:** bieżące PI jest ustalane z aktywnego sprintu tablic z `docs/jira-spaces.json` i
  pobierane są wszystkie zadania tego PI (po sprincie albo po etykiecie `PI-X.Y`, jeśli jest dowód, że należą do
  właściwego zespołu). Bez skonfigurowanych tablic ShipScope bierze klucze zadań znalezione w opisach wdrożonych
  commitów (`EBO-1234`), najpierw sprawdzając, czy projekt danego klucza istnieje w Jirze. Gdy Jira jest
  nieosiągalna, buduje z tych kluczy zadania zastępcze (bez tytułu i statusu), żeby dashboard nie był pusty.

### Czym różni się „sprint” od „PI”?

PI (Program Increment) obejmuje zwykle kilka sprintów. Oba pochodzą z tego samego pola Sprint w Jirze: `pi` jest
wyliczane z nazwy sprintu (`27.3.1` → `PI-27.3`), `sprint` to sama nazwa. Gdy zadanie ma kilka sprintów, liczy się
aktywny, a jeśli go nie ma — ostatni; w synchronizacji plikowej brane są pod uwagę tylko sprinty z tablic danej
przestrzeni. (`pickRelevantSprintInfo`, `extractPiFromSprintName` w `scripts/lib/jira-pi.js`; serwer:
`server/lib/jira-model.js`.)

### Jak zapisywane są zadania i kiedy widać zmianę?

Jeden plik na PI (`docs/data/jira-issues/PI-27.3.json`) oraz `index.json` (lista PI, ich sprinty z datami i
bieżące PI) i `status-index.json` (PI i status każdego zadania ze wszystkich PI, dla panelu flag). Strona wczytuje
jedno PI naraz. Automatycznie odświeżane jest tylko bieżące PI, i to w całości, więc zadanie, które z niego
wypadło, po prostu znika. Pozostałe PI to stan z ostatniego ręcznego uruchomienia `backfill-jira-issues.yml`.

W synchronizacji plikowej Jira jest synchronizowana po każdym deployu dowolnego komponentu, codziennie o 3:00 i na
żądanie, więc nowe zadanie w bieżącym sprincie zwykle pojawia się w ciągu kilku minut od najbliższego deployu. Na
serwerze pojawia się w ciągu 15 minut albo ok. 30 sekund po webhooku z Jiry.

## Zakładka Release Notes

### Co pokazuje?

Zadania, które są dostępne dla użytkowników na PROD — `released` (wdrożone i z włączoną flagą) albo wdrożone bez
flagi, na którą trzeba czekać — pogrupowane po PI i sprincie (od najnowszych) i podzielone na „Features &
Improvements” oraz „Bug Fixes”. Niewydane zadania nie są pokazywane. Każda pozycja ma plakietkę statusu na PROD,
klucz Jiry i datę pierwszego trafienia na PROD. Filtr Service zawęża listę do jednej aplikacji z
`docs/components.json` (`application`); komponent bez niej występuje pod własną nazwą.
(`docs/app-release-notes.js`, `issueIsReleasedToProd`, `earliestProdDeployedAt`.)

### Dlaczego jest pusto, choć PI ma zadania?

Wszystkie zadania są zastępcze, zbudowane z opisów commitów (zob. „Które zadania pokazuje ShipScope?”), i nie mają
prawdziwego PI. To znaczy, że synchronizacja nie dociera do Jiry: sprawdź jej log i sekrety `JIRA_BASE_URL` /
`JIRA_EMAIL` / `JIRA_API_TOKEN` (synchronizacja plikowa) albo połączenie z Jirą w Settings (serwer).

## Aktualność danych

### Co znaczy „synced HH:MM” w nagłówku?

- **Synchronizacja plikowa:** czas ostatniego uruchomienia, które zsynchronizowało deploymenty wszystkich
  komponentów i Jirę (codzienne, ręczne albo z nierozpoznanym wyzwalaczem) — nie synchronizacji pojedynczego
  komponentu po deployu, która może się po cichu nie uruchomić. Osobna plakietka `source: data/*.json` mówi tylko,
  że pliki zostały pobrane. (`record-full-sync.js`, `docs/data/sync-meta.json`.)
- **Serwer:** najnowsza udana synchronizacja deploymentów któregokolwiek repozytorium workspace'u.

## Workflowy (synchronizacja plikowa) — kiedy który się uruchamia?

Działają w repozytorium synchronizacji plikowej (`circlek-global/evdt-service-shipscope`), nie w repozytorium serwera.

- **`orchestrate-full-sync.yml`** (deploymenty i Jira) — po każdym deployu (`repository_dispatch` z repozytorium
  aplikacji), codziennie o 3:00 i ręcznie.
- **`check-flags.yml`** — bez harmonogramu; repozytoria aplikacji wywołują go ze swojego CI.
- **`sync-runtime-be-flags.yml`** — gdy serwis flag backendu zgłosi zmianę, po każdym deployu aplikacji,
  codziennie o 3:15 i ręcznie.
- **`update-flag-state.yml`** — ręcznie albo gdy backend zgłosi zmianę jednej flagi.
- **`fill-flag-metadata.yml`** — ręcznie, żeby uzupełnić opis, klucze Jiry albo komponenty flagi.
- **`retrigger-app-checks.yml`** — po zmianie `flags-meta.json`, żeby ponowić nieudane przebiegi `check-flags` w
  repozytoriach aplikacji.
- **`sync-main-to-live.yml`** — przy każdym pushu do `main` dotykającym `scripts/`, `docs/` albo `.github/`;
  przenosi kod na gałąź `live`, którą serwuje GitHub Pages.
- **`backfill-deployment-metadata.yml`, `backfill-flag-state-history.yml`, `backfill-jira-issues.yml`** — tylko
  ręczne prace porządkowe.

## Poświadczenia

### Serwer

Żadnych sekretów w repozytoriach aplikacji. Workspace łączy GitHub App ShipScope (instalowaną przez organizację,
tylko na wybranych repozytoriach) i Jirę (logowanie przez Atlassian; ShipScope przechowuje tylko zaszyfrowany
refresh token). Źródła flag mają własne tokeny, tworzone i unieważniane w Settings.

### Synchronizacja plikowa: po co token GitHub App, skoro są sekrety Jiry?

Służą do różnych systemów. `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` dają `sync-jira.js` dostęp do odczytu
**tylko Jiry**. `actions/create-github-app-token` zamienia klucz prywatny GitHub App na token ważny ok. godziny,
używany **tylko do GitHuba**:

| Workflow | Do czego token App |
|---|---|
| `orchestrate-full-sync.yml`, `backfill-deployment-metadata.yml` | Odczyt deploymentów, commitów i porównań z repozytorium aplikacji. |
| `retrigger-app-checks.yml` | Ponawianie nieudanych przebiegów `check-flags` w repozytoriach aplikacji. |
| `check-flags.yml`, `notify-deployment.yml` | Działają w repozytorium aplikacji, ale zapisują do ShipScope albo dają mu sygnał. |
| `fill-flag-metadata.yml`, `sync-runtime-be-flags.yml` | Wysłanie zdarzenia `flags-meta-changed`. |

Domyślny `GITHUB_TOKEN` go nie zastąpi: obejmuje tylko repozytorium, w którym działa workflow, a zdarzenia, które
tworzy, nie uruchamiają innych workflowów. Job synchronizacji Jiry nie potrzebuje tokenu App — zapisuje tylko do
własnego repozytorium ShipScope, a to `GITHUB_TOKEN` potrafi.

### Które poświadczenie jest najważniejsze?

**Klucz prywatny** GitHub App. Tokeny wygasają po godzinie, klucz nie, a może tworzyć tokeny z prawem zapisu do
`live` i repozytoriów aplikacji. Trzymaj uprawnienia tokenów na minimum, przypnij akcję, która go używa, do SHA
commita i wiedz, kto jest właścicielem klucza i kiedy był wymieniany.
