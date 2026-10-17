# ShipScope

*English version (default): [README.md](README.md)*

ShipScope jest dashboardem łączącym dane z wielu repozytoriów, odpowiadającym na powtarzające się pytanie:
czy dana funkcja jest już realnie widoczna dla użytkowników, czy tylko wdrożona, z flagą wciąż wyłączoną.

Wdrożenie kodu a wydanie funkcji to dwie różne rzeczy, gdy w grę wchodzą feature flagi. ShipScope łączy trzy
sygnały — issue z Jiry, deploymenty i stany feature flag — w środowiskach `test`, `qa` i `prod`, dzięki czemu
inżynierowie i product ownerzy mogą zobaczyć realny status wydania danego elementu pracy bez ręcznego
zestawiania logów deploymentów, dashboardu flag i tablicy Jiry.

Jest to statyczny dashboard, bez backendowego serwera, zasilany przez zaplanowane workflowy GitHub Actions,
które pobierają dane z GitHuba, Jiry i endpointów flagowych backendu do plików JSON renderowanych przez
prostą stronę HTML/JS.

## Co pokazuje

Dwa widoki, oba czytające te same dane źródłowe:

- **Product view (PI)** — Epiki, Story i Taski z Jiry pogrupowane po Program Increment, każdy ze statusem
  wydania per środowisko: **Not deployed** / **Deployed (hidden)** / **Released** / **Partial**, plus blokery
  zależności z Jiry, które uniemożliwiłyby bezpieczne wydanie na produkcję.
- **Technical view** — matryca komponent-środowisko pokazująca, co jest wdrożone gdzie, stan każdej flagi i
  rozjazd między środowiskami; połączona oś czasu deploymentów i zmian flag (typ triggera, czas trwania,
  linki, wykrywanie rollbacku, pełna historia flag); oraz lista flag z trzema dodatkowymi sprawdzeniami,
  których nie znajdzie się w zwykłym dashboardzie flag — **blast radius**, **rozjazd build vs. runtime-be** i
  **stale flags** — możliwymi dzięki uwzględnieniu również statusu ticketów z Jiry.

Zobacz [FAQ.pl.md](FAQ.pl.md) po szczegółowe wyjaśnienie, jak każda z tych liczb, badge'y i sprawdzeń jest
liczona.

### Release Notes

Trzecia zakładka wymienia zadania z Jiry już wydane na PROD, według PI → sprintu, z podziałem na funkcje i
poprawki błędów, z filtrem „Service” według **aplikacji** (pole w `docs/components.json`, nie w Jirze, bo jeden
wdrażany komponent może obsługiwać więcej niż jedną aplikację, np. współdzielony BFF). Zobacz
[FAQ.pl.md](FAQ.pl.md), jak ustalane jest „wydane”.

## Jak to działa

- **Deploymenty** są pobierane z GitHub Deployments API dla każdego śledzonego repozytorium aplikacji,
  wzbogacone o powiązane klucze Jiry, czas trwania, typ triggera, wykrywanie rollbacku i rozwiązaną wersję
  (Release → tag → komunikat commita → SHA). Starsze rekordy można doprowadzić do zgodności retroaktywnie;
  patrz `scripts/backfill-deployment-metadata.js`.
- **Feature flagi** pochodzą z dwóch źródeł śledzonych osobno: flag `build`, zaszytych na etapie budowania, i
  flag `runtime-be`, przełączanych na żywo przez serwis backendowy. Każda zmiana jest zapisywana w pełnej,
  append-only historii (`flag-state-history.json`), a każda flaga wymaga ręcznie wypełnionego wpisu w
  `flags-meta.json`.
- **Issue z Jiry** są pobierane przez JQL dla projektów, do których należą klucze wspomniane w ostatnich
  deploymentach, z lekkim fallbackiem opartym na commitach, gdy Jira jest tymczasowo nieosiągalna.

Zobacz [FAQ.pl.md](FAQ.pl.md) po mechanikę stojącą za każdym z tych punktów, i `CLAUDE.md` (po angielsku) po
pełne techniczne odniesienie.

W wariancie plikowym zajmują się tym workflowy GitHub Actions w oryginalnym repozytorium
(`circlek-global/evdt-service-shipscope`), które zapisują JSON pod `docs/data/` na jego gałęzi `live`, serwowanej
przez GitHub Pages. Serwer ShipScope (`server/`) robi to samo z bazą danych i sam serwuje dashboard.

## Jak to się ma do istniejących narzędzi

Nie ma jednego gotowego produktu, który robi dokładnie to, co ShipScope, ale są pokrewne kategorie:

- **Platformy feature flag z „release insights”** — LaunchDarkly, Split.io (teraz część Harness), Unleash.
  Dobrze pokazują stan flagi per środowisko (jak Technical view w ShipScope), a „Code References” w
  LaunchDarkly nawet linkuje flagi do ticketów Jiry i kodu. Ale generalnie nie zestawiają tego z historią
  deploymentów w wielu repo w jeden status „released vs. deployed-but-hidden”, a skoro nie widzą statusu issue
  z Jiry, nie mogą ostrzec, że flaga gate'uje mieszankę skończonej i nieskończonej pracy, albo że „gotowa”
  strona flagi siedzi za nieaktualnym przełącznikiem od miesięcy.
- **Wewnętrzne developer portale** — Backstage (open-source, od Spotify), Cortex, OpsLevel, Faros AI. To
  koncepcyjnie najbliższy odpowiednik: agregują dane CI/CD, Jiry i GitHuba w widok per serwis. Ale są zwykle
  zorientowane na metryki szybkości inżynieryjnej (jak często i jak szybko zespół wydaje — „metryki DORA” jak
  lead time i częstotliwość deploymentów), a nie na konkretne pytanie „czy ten Epik jest już realnie widoczny
  dla użytkowników”. Uzyskanie tego, co robi ShipScope, z jednego z nich oznaczałoby napisanie własnego pluginu
  do Backstage albo własnej logiki Cortex/Faros — czyli wciąż szyta na miarę robota.
- **Śledzenie deploymentów/release'ów** — Octopus Deploy, Harness CD. Pokazują, co jest wdrożone gdzie, ale bez
  warstwy flag albo tego typu połączenia z Jirą.

Konkretna kombinacja, którą ShipScope pokrywa — wdrożony kod + stan ON/OFF flagi + ticket z Jiry, połączone w
jeden status per środowisko, w wielu repo — to dość wąskie przecięcie trzech osi, które większość zespołów albo
łata ręcznie, albo buduje samodzielnie, tak jak ten projekt. Najbliżej mu do lekkiego, samodzielnie zbudowanego
„dashboardu gotowości do wydania” — czegoś, co inaczej kończy jako niestandardowy widok w Backstage albo arkusz
kalkulacyjny, nie jako gotowy produkt SaaS.

## Zobacz też

- [FAQ.pl.md](FAQ.pl.md) — proste odpowiedzi na pytanie „jak jest liczona ta konkretna liczba/badge?”
- [ONBOARDING.pl.md](ONBOARDING.pl.md) — zakładanie workspace'u na serwerze ShipScope albo dodawanie komponentu do synchronizacji plikowej.
- [CLAUDE.md](CLAUDE.md) — pełne techniczne odniesienie (po angielsku): skrypty, workflowy, model danych,
  podział `main`/`live`.
- [CHANGELOG.pl.md](CHANGELOG.pl.md) — najważniejsze zmiany w czasie.
