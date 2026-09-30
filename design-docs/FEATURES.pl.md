# Notatki funkcjonalne — kandydujące funkcje dla ShipScope

*English version: [FEATURES.md](FEATURES.md)*

> **Status: rozpoznanie, nie decyzja.** Ten dokument zapisuje kandydujące funkcje, które wypłynęły w
> rozmowie, razem z ustaleniami zebranymi przy sprawdzaniu ich wykonalności. Nic z tego nie zostało
> zaimplementowane. Każda sekcja jest materiałem wyjściowym do ewentualnej decyzji, nie samą decyzją.

## Health check CI per komponent (Sonar / Checkmarx / ESLint / Orca)

### Motywacja

Grafana (czy jakikolwiek inny monitoring w organizacji) nie ma wglądu w wyniki skanów jakości/bezpieczeństwa
kodu — to żyje w UI każdego z tych narzędzi z osobna, albo jest rozsiane po GitHub Checks w każdym app-repo.
ShipScope już agreguje „co jest zdeployowane” i „co jest przełączone” per komponent — trzeci sygnał: „czy
kod tego komponentu jest teraz czysty, czy coś wymaga spojrzenia” wpisuje się w ten sam model i tę samą
publiczność.

### Docelowa semantyka

Trójstanowy wskaźnik (np. kolorowa kropka/serduszko) per komponent, **niemający** pokazywać dokładnej
liczby findingów — tylko na tyle, by wiedzieć, czy coś wymaga uwagi:

- 🟢 **Zielony** — wszystko, co sprawdzono, wyszło czysto.
- 🟡 **Żółty** — nic nie jest faktycznie zepsute, ale coś jest niejednoznaczne (pominięte, wyłączone, brak
  ostatniego przebiegu itd.) — „wymaga spojrzenia”, nie „jest zepsute”.
- 🔴 **Czerwony** — przynajmniej jeden check zaraportował realny błąd/failure.

### Co znaleziono sprawdzając `evapl-service-frontend`

Lokalny clone `evapl-service-frontend` jest nieaktualny (ostatni commit 2026-06-11) i nie udało się go
odświeżyć — `git fetch` zwraca 403, bo `circlek-global` wymusza SAML SSO i trzeba ponownie autoryzować Git
Credential Manager. `gh` CLI też nie jest zainstalowane w tym środowisku. Poniższe ustalenia pochodzą z tego,
co było lokalnie dostępne, oraz z plików workflow, które użytkownik wkleił wprost.

- **Samo app-repo nie ma prawie żadnej konfiguracji CI.** Jedyny obecny workflow to
  `prod-on-demand-deployment.yml`. Cała logika build/lint/test/scan żyje w **wspólnym, reużywalnym
  workflow**: `circlek-global/arp-global-workflow-build-npm@v7` (`build-npm.yml`). To jest scentralizowane
  na poziomie organizacji, nie per-repo — żeby wiedzieć, jak dany tool raportuje wyniki, trzeba czytać
  reużywalny workflow, nie app-repo.
- **Sonar** — działa jako dwa kroki wewnątrz wspólnego joba `build_code`: `sonarsource/sonarqube-scan-action@v7`,
  a potem `sonarsource/sonarqube-quality-gate-action@v1.2.0`. Akcja quality-gate failuje *krok* tylko przy
  statusie gate `ERROR` — status `WARN` (o ile w ogóle jeszcze istnieje; nowsze SonarQube/SonarCloud w
  większości zdeprekowały `WARN` na rzecz samego `OK`/`ERROR`) nie byłby w ogóle widoczny przez conclusion
  GitHub Actions. Żeby dostać realny `OK`/`WARN`/`ERROR`, trzeba wywołać bezpośrednio Sonar Web API
  (`api/qualitygates/project_status`) z `SONAR_HOST_URL` + tokenem.
- **Checkmarx** — działa jako osobny job (`checkmarx-scan`) przez wewnętrzną, niestandardową akcję
  `circlek-global/sdlc-global-action-checkmarx@v4`, która owija Checkmarx One CLI (`ast-cli`) i obejmuje
  jednym zamachem SAST, SCA, IaC Security, API Security, Container Security i SCS. Uprawnienia tego joba to
  `contents: read`, `issues: write`, `pull-requests: write` — **brak `security-events: write`**, co jest
  silnym sygnałem, że **nie** uploaduje SARIF-a do GitHub Code Scanning — musi raportować przez
  komentarze PR/issues. Realny status per severity wymagałby bezpośredniego wywołania Checkmarx One API z
  `CHECKMARX_ONE_CLIENT_ID`/`CHECKMARX_ONE_CLIENT_SECRET` (już używanych gdzie indziej w organizacji do
  odpalania skanów, ale to credentiale do triggerowania skanu, nie koniecznie właściwe do reużycia dla
  samego odczytu — patrz uwaga o credentialach poniżej).
- **ESLint** (`NPM_LINT_CMD`) — zwykły krok „Run lint” wewnątrz *tego samego* joba co install/build/test, bez
  żadnego reportera czy adnotacji. Tu nie da się uzyskać żadnej granularności severity; najwięcej co można
  dostać to pass/fail dla tego konkretnego kroku (przez Workflow Jobs API na poziomie kroku, nie statusu
  joba, bo job zawiera też kroki build/test, które mogą failować niezależnie).
- **Orca** — nie występuje w żadnym ze sprawdzonych do tej pory workflowów (`prod-on-demand-deployment.yml`,
  `build-npm.yml`, workflow auto-update CLI Checkmarxa, workflow `Publish`/semantic-version). Otwarte
  pytanie: jest podłączona gdzie indziej (inny reużywalny workflow, inny trigger), działa na poziomie
  cloud/infra a nie per-repo CI, czy może została faktycznie zastąpiona przez pakiet
  SAST/SCA/IaC/API/Container/SCS Checkmarx One, który nakłada się zakresem? **To blokuje zamknięcie
  zakresu** — trzeba to rozstrzygnąć, zanim zdecydujemy się na implementację.

### Dwie rozważane ścieżki implementacji

**A — natywne API każdego toola (dokładne, ale wymaga nowych credentiali).**
Wywołanie Sonar Web API i Checkmarx One API bezpośrednio, żeby dostać realny status `OK`/`WARN`/`ERROR`
(albo per severity). Wymaga:
- Nowych sekretów w samym repo `evdt-service-shipscope` (Settings → Secrets and variables → Actions) —
  credentiale z jednego repo/organizacji nie są widoczne dla workflowów innego repo. Warto najpierw
  sprawdzić, czy `SONAR_TOKEN`/`CX_CLIENT_ID`/`CX_CLIENT_SECRET` nie są już sekretami **na poziomie
  organizacji** z widocznością „All repositories” (wtedy nic nie trzeba dodawać).
- Najlepiej **osobnego, read-only credentiala o minimalnych uprawnieniach**, a nie reużycia credentiali do
  triggerowania skanów już używanych w app-repo — to jest prośba organizacyjna do administratora
  Sonar/Checkmarx One, nie coś do samoobsługowego zrobienia z poziomu tego repo.
- Niesekretnego mapowania komponent → identyfikator projektu w danym tool (np. `SONAR_PROJECT_KEY`),
  podobnego w duchu do istniejącego wzorca zmiennej `COMPONENT`.

**B — tylko GitHub Checks/Workflow Jobs API (bez nowych credentiali) — preferowany punkt startowy.**
Reużycie tego samego typu tokena, który ShipScope już ma do czytania danych z app-repo (ta sama kategoria,
którą używa `sync-github-deployments.js`), by odczytać conclusion ostatniego przebiegu dla relewantnego
joba/kroku per komponent na branchu głównym, i zmapować natywne wartości conclusion z GitHuba na trzy stany
zamiast realnej severity zaraportowanej przez tool:

- 🔴 **Czerwony** — którykolwiek relewantny check ma ostatni conclusion `failure` (albo `timed_out` /
  `action_required`).
- 🟡 **Żółty** — żaden nie jest `failure`, ale przynajmniej jeden jest `skipped` / `neutral` / `cancelled`,
  albo nie ma żadnego ostatniego przebiegu (np. zaobserwowany przypadek `CHECKMARX_ENABLED: false` w
  `evapl-service-frontend` — to dziś realnie `skipped`, czyli „nie potwierdzone jako czyste”, nie „zepsute”).
- 🟢 **Zielony** — wszystkie relewantne checki mają ostatni conclusion `success`.

To traci realną granularność warningów (dokładne liczby findingów, prawdziwy status gate Sonara, podział
severity Checkmarxa), ale odpowiada semantyce, o którą faktycznie chodzi — „potwierdzone czyste / wymaga
spojrzenia / zepsute” — zero nowych credentiali i żadnej zależności organizacyjnej. **Decyzja na razie:
zacząć od B; dokładać A per tool później, tylko jeśli dodatkowa precyzja uzasadni koszt provisioningu.**

### Otwarte punkty / następne kroki

1. Ustalić, gdzie (albo czy w ogóle) Orca jest realnie podłączona, zanim zamknięty zostanie zakres.
2. Zaprojektować kształt `docs/data/health.json` (per komponent × check? per komponent × środowisko, na
   wzór `flag-states.json`?) oraz nowy `sync-health.js` / `sync-health.yml`, zgodnie z istniejącymi
   konwencjami skryptów (idempotentny zapis, brak commitu, gdy nic się nie zmieniło).
3. Ustalić, które nazwy jobów/kroków liczą się jako „ten relewantny check” per komponent — to są wspólne,
   reużywalne workflowy, więc nazewnictwo powinno być konsystentne między różnymi app-repo, ale trzeba to
   potwierdzić na więcej niż tylko `evapl-service-frontend`.

## Pole `dependencies` we wpisach `docs/components.json`

### Motywacja

Wpisy w `docs/components.json` mają już `name`/`description`/`serviceType`/`featureFlagsIncluded` (patrz
`CLAUDE.md` → „Tracked components”). Pole `dependencies` — od jakich innych śledzonych komponentów zależy
dany komponent — było częścią pierwotnego pomysłu na schemat, ale zostało celowo pominięte przy dodawaniu
`featureFlagsIncluded`/`description`/`serviceType`, bo (w przeciwieństwie do tych trzech) nic w ShipScope
jeszcze go nie czyta. Zapisane tutaj jako realny kandydat na później, nie odrzucone na dobre.

### Możliwe zastosowania, jeśli kiedyś zaprojektuje się konsumenta

- Widok grafu zależności (od czego dany komponent zależy, i pośrednio co mogłoby zostać dotknięte, gdyby
  padł albo został wycofany) — najbardziej bezpośrednie zastosowanie pola, zgodne z jego nazwą.
- Kontekst driftu/blast radius między komponentami, obok istniejącego sygnału `driftBehind` liczonego dla
  jednego komponentu — np. flagowanie, że komponent został promowany na `prod`, mimo że zadeklarowana
  zależność nie została, co dzisiejszy `driftBehind` per-komponent (tylko `test` → `qa` → `prod` w ramach
  jednego komponentu) nie jest w stanie zobaczyć między komponentami.
- Wskazówki do kolejności w przyszłym check „promuj w kolejności zależności”, gdyby to kiedyś stało się
  realnym problemem.

### Otwarte pytania

- **Kierunek/semantyka** — czy lista `dependencies` we wpisie opisuje to, od czego *ten komponent zależy*,
  czy to, co *zależy od niego*? Odwrócenie tego w cichy sposób produkuje graf skierowany w złą stronę;
  trzeba to ustalić i zapisać przed pierwszym realnym wpisem, nie wywnioskować później z użycia.
- **Kto pilnuje aktualności** — w przeciwieństwie do `featureFlagsIncluded`/`description`, lista zależności
  dryfuje po cichu wraz z realnymi zmianami architektury (nic nie zgłasza błędu, gdy jest nieaktualna),
  więc potrzebuje właściciela/nawyku przeglądu, a nie tylko miejsca w schemacie.
- **Brak zaprojektowanego konsumenta** — dodanie pola teraz, przed rozstrzygnięciem powyższego, byłoby
  tylko martwym polem w schemacie, którego nikt nie czyta (to samo rozumowanie, które trzymało je poza
  schematem obiektowym przy jego wprowadzeniu). Wrócić do tego, gdy jedno z „możliwych zastosowań” powyżej
  zamieni się w realną, zakresowaną funkcję.

## Zakładka „Insights” — trzy wykresy zbiorcze

### Motywacja

Trzecia zakładka obok „Product view (PI)” i „Technical view”, pokazująca kilka zbiorczych sygnałów, które
dziś istnieją tylko niejawnie, rozsiane po wielu wierszach (status wydania per issue, wiek per flaga, flagi
rollback/drift per deployment). Żaden z trzech poniższych wykresów nie liczy niczego, czego nie liczy już
istniejący kod — `issueStatusForEnv`, `effectiveFlagState`, `flagStaleWarning` oraz pola
`rollback`/`driftBehind` już obecne w rekordach `deployments.json`. To czysto widok zbiorczy nad danymi,
które ShipScope już ma; **zero nowych skryptów syncu, zero nowych workflowów, zero nowych plików danych.**
(Wykres 4 poniżej jest tu jedynym zamierzonym wyjątkiem od tego ostatniego punktu.)

Celowo z dystansem od generycznych metryk częstotliwości deployu/lead time (patrz `README.md` → „How this
compares to existing tools”) — każdy wykres tutaj to albo sygnał widoczności wydania (czy user to widzi),
albo sygnał zdrowia procesu (czy pominięto normalną ścieżkę promocji), nigdy metryka szybkości; to właśnie
odróżnia ShipScope od narzędzi w stylu DORA i dashboardów w stylu Backstage.

### Wykres 1 — status wydania per PI (PROD)

Stacked bar per PI, jeden segment per status, liczący `issueStatusForEnv(issue, 'prod')` dla każdego issue
w tym PI — dokładnie ta sama funkcja per-issue, którą Product view już renderuje wiersz po wierszu, tylko
zagregowana. Celowo **tylko PROD**, nie „najlepszy status ze wszystkich środowisk”: cała teza ShipScope to
„czy to jest widoczne dla użytkownika”, a to jest pytanie tylko o PROD — Story, które jest `released` w
`test`, ale `none` w `prod`, powinno tu wyjść jako jeszcze niewidoczne, nie dostać kredyt za swój stan
testowy. `deployed_code_only` (poziom z fallbacku deployment-derived, używany gdy issue nie ma podlinkowanej
żadnej flagi) jest wrzucany do tego samego koszyka co `deployed` („Deployed (hidden)”) specyficznie na
potrzeby tego wykresu — na poziomie zbiorczym per PI różnica („kod jest, nie widzimy flagi” vs. „kod jest,
flaga potwierdzona jako wyłączona”) to ten sam praktyczny komunikat: wysłane, widoczność niepotwierdzona/skryta.

### Wykres 2 — stare flagi: dni ON w PROD

Jeden bar per flaga, biorący `effectiveFlagState(flagStates[key].prod)`, żeby dostać aktualnie efektywny
stan w PROD, a potem liczba dni od `changedAt` tego stanu, sortowana malejąco (najdłużej trwające na
początku). Bary powyżej `STALE_FLAG_DAYS` (60 — ten sam próg, który `flagStaleWarning` już używa do swojego
ostrzeżenia per flaga) renderują się bursztynowo zamiast domyślnego koloru, więc odczyt „to pewnie już
przeżyło swoją użyteczność” jest natychmiastowy, bez otwierania szczegółów każdej flagi. Zweryfikowane na
przykładowym zbiorze `FALLBACK`: `changeCpmsAllowed` jest ON w prod od ~93 dni (renderuje się bursztynowo),
`templateChargersListEnabled` od ~51 dni (jeszcze pod progiem, renderuje się w domyślnym kolorze) —
zachowanie progu jest widocznie poprawne na danych już obecnych w repo, nie tylko w teorii.

### Wykres 3 — rollbacki i drift w czasie

Deploymenty bucketowane per miesiąc, licząc ile ich w danym miesiącu ma ustawione `rollback`, i ile ma
ustawione `driftBehind.commitCount` albo `driftBehind.untestedCommitCount` (dwa kształty `driftBehind` już
liczone przez `sync-github-deployments.js`: środowisko zostające w tyle za wcześniejszym, albo środowisko z
commitami, których wcześniejsze nigdy nie widziało — hotfix albo deploy bezpośredni z pominięciem normalnej
promocji). To sygnał „jak często normalna ścieżka promocji jest łamana”, celowo nie metryka szybkości — bez
liczby deployów, bez lead time, nic w stylu DORA. Na przykładowym zbiorze `FALLBACK` renderuje się to jako
stan pusty („No rollbacks or drift detected in this data”), bo żaden z przykładowych rekordów akurat nie
niesie tych pól — to oczekiwane, bo to dane przykładowe, nie błąd wykresu; logika agregacji jest już
przetestowana przez `flagStaleWarning`/`driftBehind` gdzie indziej i potrzebuje tylko realnych rekordów
`deployments.json` z tymi polami ustawionymi (co `sync-github-deployments.js` już dziś robi), żeby pokazać
stan niepusty.

### Wykres 4 (kandydat, wymaga nowego syncu) — PR-y per etykieta

#### Motywacja

PR-y w repo aplikacji mają już etykiety opisujące element/typ zmiany, ale nic w ShipScope nie agreguje, jak
etykieta X wypada po zmergowaniu. W przeciwieństwie do wykresów 1–3 **to nie jest czysty rollup istniejących
danych** — ShipScope dziś nie syncuje PR-ów wcale, więc to wymaga nowego pliku danych i nowej ścieżki syncu.

#### Model syncu — event-driven, nie polling

Zwykły cron/polling po GitHub API byłby najdroższy: osobny harmonogram, osobny budżet rate-limitu,
redundantny z tym, co już robi `sync-github-deployments.js`. Efektywniejszy wariant: reużywalny workflow na
wzór `notify-deployment.yml`, wywoływany z repo aplikacji przy **PR merged** (`repository_dispatch`),
append-only zapis do nowego pliku (analogicznie do `flag-state-history.json`) — zero pollingu, koszt tylko
przy realnym mergu, żadnego dodatkowego zużycia rate-limitu poza samym eventem.

#### Jakie dane mają sens — nie duplikować Grafany/Prometheusa

Surowe liczby „PR success/failure” (wynik CI) to już domena Grafany/GitHub Insights i nie wnosi tu niczego
nowego. Wartość ShipScope leży w **łączeniu** etykiety PR-a z danymi domenowymi, które już ma, a generyczny
dashboard CI/CD nie ma o nich pojęcia:

- czas od merge PR-a (z daną etykietą) do faktycznego `released` w prod — join z `deployments.json` +
  `flag-states.json`, realny lead time per typ zmiany, nie tylko wynik CI.
- korelacja etykiety z `rollback` / `driftBehind.untestedIn` — czy PR-y danej etykiety (np. „hotfix”)
  częściej lądują jako rollback albo skip promocji `test`→`qa`→`prod`.
- per PI/komponent: ile PR-ów danej etykiety zmergowano vs ile faktycznie trafiło do `released` w tym samym
  PI — most między „kod wysłany” a „feature włączony”, który `app.js` już modeluje dla issues.

#### Status

Niezaimplementowane, nierozstrzygnięte co do zakresu. Zanim to zaprojektować: zdecydować kształt nowego
pliku danych (per etykieta × miesiąc? płaski append-only log jak `flag-state-history.json`?), potwierdzić że
`notify-deployment.yml`-owy wzorzec faktycznie da się odtworzyć dla eventu PR merged bez dodatkowych
credentiali, i rozstrzygnąć dokładną definicję „success/failure” dla już zmergowanego PR-a (status CI w
momencie merge'a, nie wynik samego merge'a, który z definicji się powiódł).

### Uwagi do renderowania

Bez biblioteki do wykresów — to repo nie ma build stepu ani zależności (patrz `CLAUDE.md`), więc wszystkie
trzy byłyby ręcznie zrobione w czystym HTML/CSS (poziome bary na flexboksie dla wykresów 1–2, przewijalny
wykres kolumnowy per miesiąc dla wykresu 3) — to samo ograniczenie, o którym już była mowa przy każdej
wizualizacji na tym dashboardzie.

### Status

Wykresy 1–3 są zaimplementowane: czwarta zakładka „Insights” (`INSIGHTS_ENABLED` w `docs/app.js`, schowana za
`?insights=1` tak samo, jak wcześniej Release Notes przed przejściem na zawsze-widoczne), z trzema panelami
(`#chartPi`, `#chartStaleFlags`, `#chartRollbackDrift`) renderowanymi przez `renderPiStatusChart()`/
`renderStaleFlagsChart()`/`renderRollbackDriftChart()`. Ręcznie zrobiony CSS (`.bar-row`, `.bar-track`,
`.bar-segment`, `.col-chart`, `.col-bar` itd.) — bez biblioteki wykresów, zgodnie z zasadą braku zależności w
tym repo. Wykres 4 (PR-y per etykieta) pozostaje niezaimplementowany, patrz jego własny „Status” wyżej.