# ShipScope

*English version (default): [README.md](README.md)*

ShipScope jest dashboardem łączącym dane z wielu repozytoriów, odpowiadającym na powtarzające się pytanie:
czy dana funkcja jest już realnie widoczna dla użytkowników, czy tylko wdrożona, z flagą wciąż wyłączoną.

Wdrożenie kodu a wydanie funkcji to dwie różne rzeczy, gdy w grę wchodzą feature flagi. ShipScope łączy trzy
sygnały — issue z Jiry, deploymenty i stany feature flag — w środowiskach `test`, `qa` i `prod`, dzięki czemu
inżynierowie i product ownerzy mogą zobaczyć realny status wydania danego elementu pracy bez ręcznego
zestawiania logów deploymentów, dashboardu flag i tablicy Jiry.

Działa jako hostowana usługa dla wielu organizacji: każda dostaje workspace, łączy swoją instalację GitHub App i
witrynę Jiry i widzi dashboard pod własnym adresem. Backend (`server/`, Node.js + Postgres) synchronizuje dane;
dashboard to prosta strona HTML/JS (`docs/`).

## Uruchomienie lokalne

```bash
npm run dev
```

Wymaga Node.js 20+ i Dockera. Polecenie uruchamia bazę danych, stosuje migracje, startuje serwer i worker, a na
końcu wypisuje link do otwarcia; przy pierwszym uruchomieniu prosi o jedno kliknięcie, którym GitHub tworzy
aplikację do logowania. `npm run dev:mock` robi to samo, ale dashboard pokazuje dane przykładowe — do sprawdzania zmian w interfejsie.
Szczegóły: [server/README.md](server/README.md#running-locally).

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

### Delivery summary

Trzecia zakładka wymienia zadania z Jiry już wydane na PROD, według PI → sprintu, z podziałem na funkcje i
poprawki błędów, z filtrem „Service” według **aplikacji**. Zobacz
[FAQ.pl.md](FAQ.pl.md), jak ustalane jest „wydane”.

## Jak to działa

- **Deploymenty** są czytane z GitHub Deployments API każdego śledzonego repozytorium, przez instalację GitHub App
  workspace'u, i wzbogacane o powiązane klucze Jiry, czas trwania, typ wyzwalacza, wykrywanie rollbacku, rozjazd
  między środowiskami i ustaloną wersję (Release → tag → plik wersji → opis commita → SHA).
- **Feature flagi** wysyłają do ShipScope własne źródła flag workspace'u (krok budowania, serwis flag), każde z
  własnym tokenem; ShipScope sam ich nie czyta. Każda zmiana trafia do historii flagi.
- **Zadania z Jiry** są synchronizowane z tablic wybranych przez admina, przez logowanie Atlassian, okres po okresie
  (PI, sprint, wydanie albo miesiąc — zależnie od tablicy).

Synchronizacje działają domyślnie co 15 minut i w ciągu ok. 30 sekund od webhooka z GitHuba albo Jiry. Zobacz
[FAQ.pl.md](FAQ.pl.md) po mechanikę stojącą za każdym z tych punktów, i `CLAUDE.md` (po angielsku) po pełne
techniczne odniesienie.

ShipScope zaczynał jako dashboard plikowy (workflowy GitHub Actions zapisujące JSON na gałąź serwowaną przez GitHub
Pages) w oryginalnym repozytorium `circlek-global/evdt-service-shipscope`, gdzie ten wariant nadal działa; to
repozytorium zawiera usługę.

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
- [ONBOARDING.pl.md](ONBOARDING.pl.md) — zakładanie workspace'u.
- [CLAUDE.md](CLAUDE.md) — pełne techniczne odniesienie (po angielsku): backend, model danych, frontend.
- [server/README.md](server/README.md) — ścieżki HTTP, model bezpieczeństwa, uruchamianie serwera lokalnie.
- [CHANGELOG.pl.md](CHANGELOG.pl.md) — najważniejsze zmiany w czasie.
