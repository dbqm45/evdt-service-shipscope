# Propozycja: synchronizacja deploymentów za pomocą webhooka GitHub App

*English version: [DEPLOYMENT-WEBHOOK-PROPOSAL.md](DEPLOYMENT-WEBHOOK-PROPOSAL.md)*

> **Status: propozycja, niezaimplementowana.** Niniejszy dokument opisuje docelowe rozwiązanie oraz kroki
> niezbędne do jego wdrożenia. Nie stanowi decyzji architektonicznej — jest materiałem wyjściowym do takiej
> decyzji.

## Opis problemu

Obecny mechanizm powiadamiania ShipScope o wykonanym deploymencie opiera się na tym, że repozytorium
danego serwisu samodzielnie wywołuje krok o nazwie `notify_shipscope` (reużywalny workflow
`notify-deployment.yml`, wykorzystywany w `prod-on-demand-deployment.yml`,
`qa-on-demand-deployment.yml` oraz `test-auto-deployment.yml`), który wywołuje zdarzenie
`repository_dispatch: deployment-completed` w repozytorium `evdt-service-shipscope`.

Mechanizm ten jest z natury niepewny: GitHub Actions odczytuje treść pliku workflow z referencji (brancha
lub commita), która wywołała dany przebieg, nie z brancha `main`. Jeżeli deployment jest wywoływany z
długo żyjącego brancha (na przykład `deployment/qa`), a krok `notify_shipscope` został dodany do danego
workflow wyłącznie na branchu `main`, każdy branch deploymentowy, który nie przeszedł od tego czasu
scalenia lub rebase'u, po prostu nie zawiera tego kroku w swojej wersji pliku — w rezultacie ShipScope nie
otrzymuje sygnału o takim deploymencie. Sytuacja ta dotyczy każdego serwisu korzystającego z tego samego
wzorca trzech workflow, nie jednego wybranego repozytorium, i będzie się powtarzać przy każdej kolejnej
zmianie tych workflow, dopóki model pozostaje oparty na kroku zdefiniowanym wewnątrz pliku workflow
przypisanego do konkretnego brancha.

Istniejący mechanizm zabezpieczający — harmonogram `schedule: cron '0 3 * * *'` w
`orchestrate-full-sync.yml` — łagodzi skutek, nie przyczynę problemu. Skrypt
`sync-github-deployments.js` odczytuje dane deploymentów bezpośrednio z GitHub Deployments API,
niezależnie od zdarzenia dispatch, jednak rozwiązuje to problem jedynie w zakresie, w jakim obiekt GitHub
Deployment został utworzony niezależnie od brakującego kroku, i wyłącznie z opóźnieniem sięgającym do 24
godzin. Nie zapewnia to danych aktualnych i zgodnych ze stanem faktycznym przy każdym wdrożeniu.

**Cel niniejszego dokumentu**: rozwiązanie, w którym ShipScope zawsze otrzymuje sygnał o deploymencie,
niezależnie od treści pliku workflow w jakimkolwiek repozytorium lub branchu serwisu, oraz bez konieczności
wprowadzania jakichkolwiek zmian w repozytoriach serwisów — takie zmiany podlegają wewnętrznemu procesowi
zatwierdzeń.

## Proponowane rozwiązanie

Zamiast opierać się na tym, że workflow deployowanego serwisu aktywnie powiadamia ShipScope, punkt
wywołania sygnału zostaje przeniesiony na poziom aplikacji GitHub (GitHub App), która jest już
zainstalowana w każdym śledzonym repozytorium w celu odczytu danych przez API. Aplikacje GitHub mogą
subskrybować zdarzenia `deployment_status` (oraz `deployment`) dla wszystkich repozytoriów, w których
zostały zainstalowane — jest to zdarzenie na poziomie samej platformy GitHub, niezależne od treści
jakiegokolwiek pliku workflow. GitHub dostarcza takie zdarzenia na jeden skonfigurowany adres webhooka.

Ponieważ ShipScope nie posiada własnego serwera aplikacyjnego (statyczne pliki oraz GitHub Actions),
wymagany jest niewielki, zewnętrzny komponent nasłuchujący (funkcja typu serverless). Jego zadania
ograniczają się do:

1. odebrania webhooka,
2. weryfikacji podpisu,
3. odwzorowania wartości `repository.name` z treści zdarzenia na `COMPONENT` obecny w
   `docs/components.json`,
4. wywołania tego samego zdarzenia `repository_dispatch: deployment-completed`, z tą samą strukturą
   `client_payload.component`, które dziś wywołuje `notify-deployment.yml`.

Kluczowe jest to, że `orchestrate-full-sync.yml` nie wymaga żadnej modyfikacji — kontrakt zdarzenia
dispatch (`event_type`, `client_payload.component`) pozostaje niezmieniony. Komponent nasłuchujący
zastępuje wyłącznie stronę wywołującą zdarzenie: krok w workflow serwisu zostaje zastąpiony przez sam
GitHub, za pośrednictwem webhooka.

## Kroki wdrożenia

### Faza 1 — decyzje wstępne

- [ ] TODO: Wybrać platformę dla komponentu nasłuchującego (kandydaci: AWS Lambda z API Gateway,
      Cloudflare Worker, Azure Function). Kryteria wyboru: istniejące konta/uprawnienia organizacyjne,
      podmiot odpowiedzialny za bieżące utrzymanie, koszt.
- [ ] TODO: Określić administracyjną odpowiedzialność za ten element infrastruktury (zespół,
      repozytorium, dostęp do sekretów) — jedyny komponent całego rozwiązania funkcjonujący poza
      repozytorium `evdt-service-shipscope`.
- [ ] TODO: Potwierdzić z zespołem platformowym lub bezpieczeństwa, że dodanie webhooka na poziomie
      aplikacji GitHub (obejmującego wszystkie repozytoria, w których aplikacja jest zainstalowana) nie
      wymaga tego samego procesu zatwierdzeń, co zmiana workflow w repozytorium serwisu — jest to zmiana
      konfiguracji jednej aplikacji, nie zmiana kodu w wielu repozytoriach.

### Faza 2 — konfiguracja aplikacji GitHub

- [ ] TODO: W ustawieniach istniejącej aplikacji GitHub (wykorzystywanej przez `notify-deployment.yml`
      oraz `orchestrate-full-sync.yml` — dane uwierzytelniające `SHIPSCOPE_APP_ID` /
      `CIRCLEK_GLOBAL_GITHUB_EVDT_APP_ID`) dodać webhook: `Settings → Developer settings → GitHub Apps →
      [nazwa aplikacji] → Webhook`.
- [ ] TODO: Ustawić **adres webhooka** na adres komponentu nasłuchującego (patrz Faza 3).
- [ ] TODO: Wygenerować i bezpiecznie przechować **sekret webhooka**, wykorzystywany do weryfikacji
      podpisu (`X-Hub-Signature-256`) w komponencie nasłuchującym. Przechowywać w menedżerze sekretów
      platformy wybranej w Fazie 1, nigdy w kodzie źródłowym.
- [ ] TODO: W sekcji **Permissions & events** subskrybować zdarzenia `Deployment` oraz
      `Deployment status`.
- [ ] TODO: Potwierdzić, że aplikacja posiada już uprawnienie `deployments: read` do repozytoriów
      serwisów (powinna, ponieważ korzysta z niego już `sync-github-deployments.js`); w razie potrzeby
      uzupełnić.

### Faza 3 — implementacja komponentu nasłuchującego

- [ ] TODO: Jeden punkt końcowy HTTP przyjmujący żądania `POST` z nagłówkami `X-GitHub-Event`,
      `X-Hub-Signature-256` oraz treścią w formacie JSON.
- [ ] TODO: Weryfikacja podpisu — obliczenie HMAC-SHA256 z surowej treści żądania przy użyciu sekretu
      webhooka z Fazy 2; odrzucenie żądania (`401`) w przypadku niezgodności. Weryfikacja musi być
      wykonana przed jakimkolwiek dalszym przetwarzaniem.
- [ ] TODO: Filtrowanie zdarzeń — obsługa wyłącznie zdarzeń `X-GitHub-Event: deployment_status`, i tylko
      gdy `payload.deployment_status.state` odpowiada stanowi terminalnemu już rozpoznawanemu przez
      `sync-github-deployments.js` (`STATE_MAP`: `success` / `failure` / `error`); pozostałe stany
      (`pending`, `in_progress`, `queued`) należy ignorować, aby nie generować wielu zdarzeń dispatch dla
      jednego deploymentu.
- [ ] TODO: Odwzorowanie `payload.repository.name` na `COMPONENT` — pobranie `docs/components.json` z
      brancha `live` za pośrednictwem Contents API (analogicznie do mechanizmu już zastosowanego w
      `notify-deployment.yml`, linie 32–47) oraz weryfikacja, że dane repozytorium jest śledzonym
      komponentem. W przeciwnym wypadku zdarzenie należy odrzucić bez zgłaszania błędu — nie stanowi to
      sytuacji wyjątkowej.
- [ ] TODO: Uzyskanie tokena instalacyjnego aplikacji GitHub (identyfikator aplikacji oraz klucz
      prywatny z Fazy 2; standardowy przepływ JWT → token instalacyjny, odpowiadający działaniu
      `actions/create-github-app-token`, wykonywany bezpośrednio w komponencie nasłuchującym) oraz
      wywołanie `POST /repos/circlek-global/evdt-service-shipscope/dispatches` z treścią
      `{"event_type":"deployment-completed","client_payload":{"component":"<COMPONENT>"}}` — zgodnie z
      kontraktem zdefiniowanym w `notify-deployment.yml:49-57`.
- [ ] TODO: Rejestrowanie zdarzeń — dla każdego przyjętego webhooka zapisanie (z wyłączeniem sekretów)
      nazwy repozytorium, identyfikatora deploymentu, stanu oraz wyniku wywołania dispatch, w celu
      umożliwienia diagnostyki bez dostępu do samego przebiegu GitHub Actions.
- [ ] TODO: Obsługa błędów — jeżeli wywołanie dispatch do ShipScope zakończy się niepowodzeniem
      (przekroczenie limitu żądań, przejściowy błąd API), należy zwrócić GitHubowi status inny niż 2xx,
      aby GitHub automatycznie powtórzył dostarczenie webhooka; na tym etapie nie należy budować własnej
      kolejki ponowień.

### Faza 4 — testy

- [ ] TODO: Test kompleksowy dla jednego serwisu: wywołanie rzeczywistego deploymentu (albo ręczne
      utworzenie statusu deploymentu przez API w środowisku testowym); potwierdzenie, że webhook został
      dostarczony, komponent nasłuchujący zweryfikował podpis, dispatch dotarł do
      `evdt-service-shipscope`, przebieg `orchestrate-full-sync.yml` został wywołany, a plik
      `docs/data/deployments.json` na branchu `live` został zaktualizowany.
- [ ] TODO: Test na branchu deploymentowym nieposiadającym kroku `notify_shipscope` — potwierdzenie, że
      nowy mechanizm działa prawidłowo także w tym przypadku. Jest to rozstrzygający test potwierdzający
      rozwiązanie problemu opisanego powyżej.
- [ ] TODO: Test odporności na nieprawidłowy lub podrobiony podpis webhooka (żądanie musi zostać
      odrzucone ze statusem `401`, bez dalszego przetwarzania).
- [ ] TODO: Test dla nieznanego repozytorium (nieobecnego w `docs/components.json`) — zdarzenie musi być
      zignorowane bez generowania błędu lub alertu.

### Faza 5 — wdrożenie i okres przejściowy

- [ ] TODO: Włączenie webhooka na produkcyjnej aplikacji GitHub oraz obserwacja logów komponentu
      nasłuchującego równolegle z istniejącym mechanizmem `notify_shipscope` przez określony okres (oba
      mechanizmy mogą działać jednocześnie — zduplikowane zdarzenie dispatch jest bezpieczne, ponieważ
      `sync-github-deployments.js` wykonuje cykl odczyt-scalenie-zapis i w sposób idempotentny odfiltrowuje
      już znane identyfikatory deploymentów).
- [ ] TODO: Po potwierdzeniu stabilności rozwiązania podjąć decyzję, czy krok `notify_shipscope` w
      workflow serwisów staje się zbędny. Może on pozostać bez ryzyka — jego usunięcie nie wymaga żadnej
      akcji ani zgłoszenia do zespołu odpowiedzialnego za dany serwis.
- [ ] TODO: Podjąć decyzję, czy zachować dzienny harmonogram cron w `orchestrate-full-sync.yml` jako
      dodatkowy mechanizm zabezpieczający (rekomendacja: zachować — stanowi ostatnią linię obrony w
      przypadku niedostępności komponentu nasłuchującego; koszt jednego dodatkowego przebiegu dziennie
      jest znikomy).
- [ ] TODO: Skonfigurować monitorowanie i alerty dla samego komponentu nasłuchującego (błędy 5xx, brak
      dostarczonych zdarzeń) — bez tego niezauważona niedostępność komponentu nasłuchującego przywraca
      dotychczasowe opóźnienie sięgające do 24 godzin.

## Elementy pozostające bez zmian

- **Brak zmian w repozytoriach serwisów.** Pliki `prod-on-demand-deployment.yml`,
  `qa-on-demand-deployment.yml`, `test-auto-deployment.yml` oraz branche deploymentowe nie wymagają
  żadnej modyfikacji — było to podstawowe wymaganie tego podejścia.
- **Brak zmian w `orchestrate-full-sync.yml`.** Kontrakt zdarzenia `repository_dispatch:
  deployment-completed` wraz z `client_payload.component` pozostaje identyczny jak dotychczas.
- **`notify-deployment.yml` nie wymaga usunięcia.** Może pozostać jako redundantna ścieżka bez ryzyka —
  nowy mechanizm nie konkuruje z istniejącym, lecz dodaje drugie źródło sygnału, niezależne od treści
  workflow.

## Ryzyka i otwarte pytania

1. **Jest to pierwszy krok w kierunku posiadania przez ShipScope własnej infrastruktury usługowej.**
   ShipScope obecnie nie posiada niczego, co działałoby w sposób nieprzerwany, przechowywałoby sekret w
   czasie działania czy wymagałoby monitorowania lub dyżuru — wszystkie elementy stanowią statyczne pliki
   JSON oraz GitHub Actions. Komponent nasłuchujący narusza tę właściwość: wprowadza trwały punkt
   końcowy, odpowiedzialność za sekret webhooka oraz klucz prywatny aplikacji GitHub, a także potrzebę
   obserwacji jego działania. Nie jest to równoznaczne z przekształceniem ShipScope w produkt SaaS (patrz
   `ARCHITECTURE-NOTES.md` — odrębne, szersze zagadnienie izolacji wielu zespołów i samoobsługowego
   dołączania), jednak operacyjnie stanowi krok w tym kierunku: pierwszy element wymagający utrzymania,
   budżetu i odpowiedzialności za dostępność, którego ShipScope obecnie nie posiada. **Powinna to być
   jawna decyzja o przyjęciu tej odpowiedzialności, nie skutek wdrożenia jednej funkcjonalności.**
2. Jest to jedyny element całego ShipScope wymagający infrastruktury poza GitHub Actions i GitHub Pages —
   konieczne jest ustalenie podmiotu odpowiedzialnego za utrzymanie, rotację sekretów oraz budżet.
3. Sekret webhooka oraz klucz prywatny aplikacji GitHub muszą być przechowywane w sposób bezpieczny w
   środowisku wykonawczym komponentu nasłuchującego — odmienny model zarządzania sekretami od GitHub
   Secrets wykorzystywanych w niniejszym repozytorium.
4. GitHub automatycznie powtarza niedostarczone webhooki, jednak limity oraz zasady ponawiania dla
   wykorzystywanego typu aplikacji GitHub należy zweryfikować, nie przyjmować ich jako pewne.
5. Zakres danych udostępnianych przez webhook na poziomie aplikacji GitHub należy potwierdzić z zespołem
   bezpieczeństwa — aplikacja posiada już dostęp do tych repozytoriów; rozwiązanie wprowadza nowy kanał
   dostarczania już dostępnych informacji, nie nowy zakres danych.
## Alternatywa bez serwera: `workflow_run` na domyślnym branchu

Jeżeli zmiana w każdym repozytorium serwisu jest jednak akceptowalna (jednorazowa, tylko na domyślnym
branchu), ten sam problem można rozwiązać bez żadnego komponentu nasłuchującego. Workflow na domyślnym
branchu repozytorium serwisu, wyzwalany przez `workflow_run`, odpala się po zakończeniu wskazanych
workflow deploymentowych **niezależnie od brancha, na którym one działały**, bo GitHub uruchamia workflow
`workflow_run` wyłącznie z YAML-a domyślnego brancha. Deploy z `deployment/qa` (podbicie
`trigger.properties`) jest więc sygnalizowany, mimo że kopia workflow deploymentowego na tym branchu nie ma
kroku `notify_shipscope`.

```yaml
name: Notify ShipScope

on:
  workflow_run:
    # wartości muszą być dokładnie równe polu `name:` workflow deploymentowych
    workflows: ["QA on-demand deployment", "PROD on-demand deployment", "TEST auto deployment"]
    types: [completed]

permissions: {}

jobs:
  notify:
    # porażek nie pomijamy: ShipScope pokazuje nieudane próby w historii
    if: github.event.workflow_run.conclusion != 'skipped' && github.event.workflow_run.conclusion != 'cancelled'
    uses: circlek-global/evdt-service-shipscope/.github/workflows/notify-deployment.yml@main
    with:
      component: ${{ github.event.repository.name }}
    secrets:
      SHIPSCOPE_APP_ID: ${{ secrets.SHIPSCOPE_APP_ID }}
      SHIPSCOPE_APP_PRIVATE_KEY: ${{ secrets.SHIPSCOPE_APP_PRIVATE_KEY }}
```

Uwagi:

- Sprawdzenie tożsamości w `notify-deployment.yml` nadal przechodzi (`github.repository` to repo serwisu).
- Brak checkoutu, więc kod z brancha deploymentowego nie wykonuje się z dostępem do sekretów.
- Po zmianie nazwy workflow wyzwalacz po cichu przestaje pasować; po wdrożeniu zweryfikuj jednym deployem na QA.
- `completed` odpala się po zakończeniu całego workflow, więc GitHub Deployment musi mieć już terminalny
  status; deploy, którego workflow kończy się przed zapisaniem `success`, czeka na kolejny sygnał.
- Dla TEST/PROD stary krok w workflow może nadal strzelać; zdublowany dispatch jest bezpieczny
  (synchronizacja jest idempotentna). Dzienny cron zostaje jako ostatnia siatka bezpieczeństwa.
- Koszt: jeden mały job na deployment, zamiast harmonogramu odpalanego niezależnie od tego, czy coś wyszło.

W porównaniu z webhookiem powyżej wymaga zmiany w każdym repozytorium serwisu (proces zatwierdzeń), ale
nie wymaga infrastruktury, przechowywania sekretów ani dyżurów, więc ShipScope pozostaje bezserwerowy.
