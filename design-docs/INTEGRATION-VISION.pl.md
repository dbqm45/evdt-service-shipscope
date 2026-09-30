# Wizja docelowa: podłączanie serwisów do ShipScope

*English version: [INTEGRATION-VISION.md](INTEGRATION-VISION.md)*

> **Status: wizja, niezdecydowana i niezaimplementowana.** Niniejszy dokument opisuje możliwy docelowy
> model integracji nowego serwisu z ShipScope, tarcie występujące w obecnym procesie oraz elementy
> niezbędne do osiągnięcia tego stanu docelowego. Jest przeznaczony jako materiał do rozmowy z biznesem o
> priorytecie i koszcie tej zmiany, nie jako plan wdrożenia.

## Cel, ujęty w jednym zdaniu

**Podłączenie nowego serwisu do ShipScope powinno polegać na zainstalowaniu jednej aplikacji GitHub w
repozytorium tego serwisu oraz dodaniu jednego wpisu konfiguracyjnego wewnątrz ShipScope — bez pull
requestu do repozytorium serwisu, bez sekretów oraz bez zmian w jego procesie CI/CD — przy zachowaniu
automatycznej i bieżącej synchronizacji danych o deploymentach, statusach oraz flagach funkcjonalnych,
bez opóźnień.**

## Stan obecny

Podłączenie nowego serwisu wymaga obecnie trzech zmian w repozytorium tego serwisu, nie tylko w
repozytorium ShipScope:

1. Dodania kroku wywołującego reużywalny workflow ShipScope (`notify-deployment.yml`) po każdym
   deploymencie, wraz z przekazaniem odpowiednich sekretów (`SHIPSCOPE_APP_ID` /
   `SHIPSCOPE_APP_PRIVATE_KEY`) do tego workflow.
2. W przypadku serwisów, w których flagi funkcjonalne są kompilowane do builda, a nie odczytywane w
   czasie działania — dodania drugiego kroku wywołującego inny reużywalny workflow (`check-flags.yml`),
   który analizuje wygenerowane pliki źródłowe serwisu.
3. Potwierdzenia, że repozytorium nowego serwisu otrzymało dostęp dla odpowiedniej aplikacji GitHub
   (`retrigger-app-checks.yml` dodatkowo wymaga ręcznego rozszerzenia, ponieważ jest obecnie
   zahardkodowany do jednego, wybranego repozytorium).

Każda z tych zmian stanowi modyfikację konfiguracji CI/CD danego serwisu, a więc podlega wewnętrznemu
procesowi zatwierdzeń organizacji. Jest to rzeczywiste źródło tarcia przy każdym onboardingu, niezależnie
od jakości dokumentacji samego procesu (`ONBOARDING.md`).

## Co obecnie nie działa dobrze

- **Sygnał o deploymencie jest niepewny.** Krok powiadamiający ShipScope znajduje się wewnątrz pliku
  workflow danego serwisu, a GitHub Actions odczytuje treść tego pliku z brancha, który wywołał dany
  przebieg, nie z brancha `main`. Jeżeli serwis deployuje z długo żyjącego brancha (na przykład
  `deployment/qa`), a krok powiadamiający dodano wyłącznie na branchu `main`, taki branch może nigdy nie
  powiadomić ShipScope. Sytuacja taka wystąpiła w praktyce (deployment serwisu `evnm` na środowisko QA) i
  może się powtórzyć dla każdego innego serwisu korzystającego z tego samego wzorca.
- **Istniejący mechanizm zabezpieczający adresuje skutek, nie przyczynę.** Codzienne zadanie cron w
  ShipScope w ostateczności odczyta dane deploymentów z API GitHub, jednak oznacza to opóźnienie sięgające
  do 24 godzin, nie synchronizację bieżącą, i działa wyłącznie w zakresie, w jakim obiekt deploymentu
  został w ogóle utworzony w GitHub.
- **Flagi funkcjonalne wykorzystują dwa odrębne mechanizmy** (kompilowane do builda oraz odczytywane w
  czasie działania), o różnym poziomie tarcia dla zespołu odpowiedzialnego, różnej kompletności danych oraz
  z odrębnym krokiem w CI, który może zablokować budowę serwisu w przypadku niekompletnych metadanych
  flagi.
- **Każdy onboarding wymaga zmiany w repozytorium innego zespołu**, nie tylko w repozytorium ShipScope.
  Jest to główne źródło opóźnień oraz najbardziej kosztowny element całego procesu — istotniejszy niż
  którykolwiek z opisanych powyżej problemów technicznych.

## Wizja docelowa

### Deploymenty — sygnał na poziomie platformy, nie krok w repozytorium serwisu

Zamiast kroku w workflow danego serwisu, ShipScope nasłuchuje na zdarzenia o deploymencie na poziomie
aplikacji GitHub, która musi już być zainstalowana w repozytorium serwisu, aby możliwy był odczyt danych
przez API. Sygnał dociera niezależnie od treści pliku workflow na jakimkolwiek branchu tego repozytorium.
Wymaga to jednego, niewielkiego, nowego komponentu odpowiedzialnego za odebranie tego sygnału — opisanego
szczegółowo w `DEPLOYMENT-WEBHOOK-PROPOSAL.pl.md`.

### Jira — zdarzenia w czasie rzeczywistym zamiast odpytywania ograniczonego do PI

Obecnie `sync-jira.js` wyłącznie *odpytuje*: na harmonogramie lub na żądanie, domyślnie ograniczone tylko
do aktywnego PI (patrz sekcja o zgłoszeniach Jira w `CLAUDE.md`), z szerszym trybem zastępczym, gdy nie da
się wyznaczyć bieżącego PI. Nigdy nie dowiaduje się o zmianie w Jirze — zmianie statusu, starcie sprintu,
przełożeniu zgłoszenia na inny PI — przed kolejnym przebiegiem.

Jira Cloud może zamiast tego *wysyłać* zdarzenia samodzielnie. Webhook, zarejestrowany jednorazowo przez
panel administracyjny Jiry albo jej REST API (`/rest/webhooks/1.0/webhook`), z filtrem JQL oraz wybranym
zestawem zdarzeń (`jira:issue_updated`, start sprintu itd.), dostarcza payload JSON na wskazany adres przy
każdej pasującej zmianie. Realne wykorzystanie tego wymaga tego samego, nowego komponentu, którego już
wymaga propozycja webhooka dla deploymentów powyżej — publicznie dostępnego, stale działającego endpointu
HTTPS — z jedną dodatkową komplikacją: klasyczne webhooki Jira Cloud nie niosą żadnego podpisu do
weryfikacji (w przeciwieństwie do webhooków GitHub, podpisywanych HMAC), więc ochrona takiego endpointu
musiałaby oprzeć się na wspólnym sekrecie w adresie/headerze albo na allowliście adresów IP.

Istnieje tańsza droga pośrednia, niewymagająca żadnej z tych nowych elementów infrastruktury: reguła Jira
Automation (wbudowana w Jirę, bez instalowania odrębnej aplikacji), której akcją jest "Send web request" —
może wywołać bezpośrednio endpoint GitHub `POST /repos/{owner}/{repo}/dispatches` na triggerze po stronie
Jiry — ten sam mechanizm `repository_dispatch`, z którego już dziś korzysta CI każdego podłączonego
serwisu, by powiadomić ShipScope o deploymencie. Dzięki temu cała logika obliczeniowa ShipScope zostaje
wewnątrz GitHub Actions — bez nasłuchującego komponentu, bez nowego sekretu przechowywanego przez
ShipScope — kosztem konfiguracji reguły Automation per projekt/space Jiry (żyjącej wewnątrz Jiry, nie w
tym repozytorium) oraz limitu wykonań reguł Automation, jaki dopuszcza plan Jira Cloud danej organizacji.

### Flagi funkcjonalne — jeden dostawca, jedna integracja, dla wszystkich serwisów

Zamiast każdego serwisu wystawiającego lub kompilującego własne flagi niezależnie, każdy serwis odczytuje
flagi w czasie działania z jednego, wspólnego dostawcy usługi zarządzania flagami (na przykład
LaunchDarkly lub Unleash). ShipScope implementuje jedną integrację z API tego dostawcy — zgodnie z
wzorcem już wykorzystanym dla integracji z Jirą — która obsługuje jednocześnie wszystkie serwisy i
środowiska, bez odrębnego mechanizmu dla każdego serwisu.

### Onboarding — dwa kroki, żaden niewymagający zmian w repozytorium serwisu

1. Nadanie aplikacji GitHub ShipScope dostępu do repozytorium serwisu — czynność administracyjna
   wykonywana w ustawieniach organizacji GitHub, nie zmiana kodu.
2. Dodanie wpisu we własnej konfiguracji ShipScope (nazwa repozytorium oraz, opcjonalnie, odwzorowanie na
   projekt w systemie zarządzania flagami).

Bez pull requestu do repozytorium serwisu. Bez sekretów przechowywanych przez serwis. Bez zmian w jego
procesie CI/CD.

## Koszt i tradeoffy tej wizji

Nie jest to zmiana bez kosztu, co należy jasno przedstawić stronie biznesowej:

- **ShipScope musiałby zbudować i utrzymywać swój pierwszy rzeczywisty, nieprzerwanie działający
  komponent infrastrukturalny** (nasłuchujący na zdarzenia webhook z GitHub). Obecnie ShipScope składa się
  wyłącznie ze statycznych plików oraz GitHub Actions, bez elementu wymagającego hostingu, monitorowania
  czy dyżuru. Jest to pierwszy krok w kierunku prowadzenia usługi, nie tylko narzędzia, wraz z
  rzeczywistym kosztem utrzymania oraz odpowiedzialnością za dostępność.
- **Migracja wszystkich serwisów na jednego, wspólnego dostawcę flag funkcjonalnych (LaunchDarkly,
  Unleash lub podobny) stanowi odrębne, znaczące przedsięwzięcie**, niezależne od ShipScope — obejmuje
  koszt licencji takiego narzędzia oraz pracę każdego zespołu przy przeniesieniu swoich flag z modelu
  kompilowanego na model odczytu w czasie działania. ShipScope nie może przeprowadzić tej migracji w
  imieniu żadnego zespołu — jest to warunek wstępny, nie zadanie inżynieryjne ShipScope.
- **Traci się dotychczasową blokadę w CI** — obecnie budowa serwisu zostaje przerwana, jeżeli flaga nie
  posiada opisu lub powiązanych zgłoszeń Jira. W modelu, w którym ShipScope wyłącznie odpytuje zewnętrzne
  API, kontrola ta nie jest już zsynchronizowana z budową serwisu; jej odtworzenie wymaga dodatkowego
  mechanizmu zgłaszającego wynik z powrotem do GitHub (kolejny element infrastruktury i kolejny koszt).
- **Jeden, scentralizowany kredencjał** (klucz API do dostawcy flag funkcjonalnych, obejmujący wszystkie
  serwisy) byłby przechowywany przez ShipScope — mniej sekretów rozproszonych po repozytoriach serwisów,
  lecz większa koncentracja ryzyka w jednym miejscu.
- **Rzeczywisty, przychodzący webhook — zarówno z GitHub, jak i z Jiry — wymaga tego samego, brakującego
  dziś elementu: publicznie dostępnego, stale działającego endpointu HTTPS**, wraz z kredencjałem na nim
  zdolnym do zapisu na branchu `live` (dziś taki kredencjał żyje wyłącznie wewnątrz zaszyfrowanych
  sekretów GitHub Actions, nigdy poza własnym, hostowanym endpointem). Dostawy webhooków GitHub są
  podpisane HMAC; klasyczne webhooki Jira Cloud nie — komponent nasłuchujący na zdarzenia Jiry musiałby
  więc dodatkowo wprowadzić własny, słabszy mechanizm ochrony (wspólny sekret lub allowlistę adresów IP)
  zamiast tej weryfikacji podpisu. Opisana wyżej droga Jira Automation → `repository_dispatch` unika tego
  konkretnego kosztu dla Jiry, ponieważ to Jira wykonuje wywołanie wychodzące, a nie ShipScope przyjmuje
  wywołanie przychodzące.

## Elementy niezbędne do rozpoczęcia — decyzje wymagane

1. Decyzja biznesowa dotycząca tego, czy i kiedy przeprowadzić migrację na wspólnego dostawcę flag
   funkcjonalnych (LaunchDarkly, Unleash lub inny), wraz z budżetem na licencję oraz czasem wymaganym od
   każdego zespołu na migrację.
2. Decyzja dotycząca podmiotu odpowiedzialnego za utrzymanie nowego komponentu infrastrukturalnego
   ShipScope (komponentu nasłuchującego na zdarzenia GitHub) — zespół, budżet oraz odpowiedzialność za
   dostępność i bezpieczeństwo.
3. Zgoda na jednorazowe rozszerzenie zakresu uprawnień aplikacji GitHub ShipScope (dodatkowe
   subskrybowane zdarzenia) — zmiana konfiguracji jednej aplikacji, nie zmiana w repozytoriach serwisów.
4. Ustalenie, czy i w jaki sposób odtworzyć dotychczasową blokadę CI dla niekompletnych metadanych flag w
   nowym modelu, czy zaakceptować jej utratę.
5. Decyzja, czy integracja z Jirą powinna w ogóle przejść na model zdarzeniowy, a jeśli tak — którą drogą:
   rzeczywisty webhook Jiry do tego samego, nowego komponentu nasłuchującego, jakiego wymaga propozycja
   dla deploymentów, czy reguła Jira Automation per projekt/space wywołująca `repository_dispatch`
   GitHub bezpośrednio (bez nowej infrastruktury ShipScope, ale z konfiguracją żyjącą wewnątrz Jiry, nie w
   tym repozytorium).

## Dokumenty powiązane, opisane szerzej

- Plan techniczny komponentu nasłuchującego na zdarzenia deploymentów (fazy, kroki, ryzyka):
  `DEPLOYMENT-WEBHOOK-PROPOSAL.pl.md`.
- Szersza dyskusja dotycząca modelu wielu zespołów oraz otwartych pytań w zakresie izolacji danych:
  `ARCHITECTURE-NOTES.pl.md`.