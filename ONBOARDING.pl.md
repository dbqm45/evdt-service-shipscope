# Wdrożenie

*English version: [ONBOARDING.md](ONBOARDING.md)*

Co zrobić, w jakiej kolejności, żeby dane trafiły do workspace'u ShipScope. Jak to działa pod spodem, opisuje
`CLAUDE.md`; jak liczona jest każda wartość — `FAQ.pl.md`.

**Wymagane najpierw:** potok wdrożeniowy każdej aplikacji musi tworzyć prawdziwy **GitHub Deployment** ze
statusami dla każdego środowiska, na które wdraża (`test`/`qa`/`prod`). ShipScope czyta historię wdrożeń wyłącznie
przez GitHub Deployments API. W GitHub Actions job z `environment: test` (albo `qa`, `prod`) tworzy go przy każdym
uruchomieniu. Nazwy środowisk są dopasowywane luźno (`production` → `prod`, `dev` → `test`, `preprod` to nie
`prod`); inne (`staging`, `uat`) są pomijane.

## Zakładanie workspace'u

Zaloguj się przez GitHuba i utwórz workspace pod adresem `/start`. Jego strona Settings (`/t/<workspace>/settings`)
zaczyna się listą kontrolną **Getting started**, która pokazuje, na jakim etapie jesteś; admin może ją ukryć. Kroki:

1. **Install the GitHub App** — zainstaluj aplikację na organizacji albo koncie GitHub, z którego wdrażasz
   (Settings → GitHub → Install). GitHub odeśle cię z powrotem; instalacja zostaje połączona tylko wtedy, gdy twoje
   własne konto GitHub ją widzi.
2. **Choose repositories to track** — kliknij Track przy każdym repozytorium, którego deploymenty chcesz widzieć.
   Opcjonalnie dla każdego repozytorium: plik wersji (dla wdrożeń QA/PROD, których commity zawierają tylko linię w
   rodzaju `version=v1.6.0`) i ścieżki, które nie liczą się jako drift (np. `.github/`, `README.md`).
3. **First deployments arrive** — w ciągu 15 minut (domyślny odstęp synchronizacji) albo ok. 30 sekund, jeśli
   serwer ma skonfigurowane webhooki GitHuba. Błąd synchronizacji widać w sekcji GitHub.
4. **Connect Jira** (opcjonalnie, tylko odczyt) — zaloguj się przez Atlassian i wybierz witrynę Jiry.
5. **Choose Jira boards** — zaznacz tablicę każdego zespołu i zapisz. Rytm tablicy (PI, sprinty, wydania albo
   miesięczny przepływ) jest wykrywany; można go zmienić dla każdej tablicy, razem z szablonem nazwy PI. Kliknij
   Sync now albo poczekaj na kolejną synchronizację.
6. **Send feature flags** (opcjonalnie) — ShipScope sam nie czyta flag. Dodaj źródło dla każdego miejsca, w którym
   trzymasz flagi (krok budowania, serwis flag; rodzaj build albo runtime, priorytet, opcjonalnie komponent),
   utwórz dla niego token i niech wysyła pełny stan swoich flag do `POST /api/flags/ingest`. W Jira → Feature flags
   in Jira można też wskazać pole albo prefiks etykiety, które łączą zadania Jiry z flagami.
7. **Invite your team** — jeden link zaproszenia na osobę. Członkowie widzą wszystko; admini mogą zmieniać
   ustawienia.

W sekcji Workspace admin ustawia też, ile dni historii deploymentów przechowywać (7–730), i może usunąć workspace.
