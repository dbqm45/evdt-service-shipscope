# Wdrożenia w repozytoriach aplikacji: co zmienić, żeby wersje i statusy były prawdziwe

Stan: 2026-10-29. Źródło: analiza US14 (EBO-17365) na `evnm-service-charger-infrastructure` i problem „PROD 5 wersji
przed QA, choć na PROD nic się nie zmieniło”. Ten dokument opisuje zmiany **poza ShipScope**, w workflow
wdrożeniowych repozytoriów aplikacji. ShipScope tylko odczytuje GitHub Deployments, więc to, co pokazuje, jest tak
dobre, jak to, co pipeline zapisze. Zmiany po stronie ShipScope są w [ROADMAP.md](ROADMAP.md), sekcja „Wersje
i wdrożenia”.

Cel: **jedna wersja = jeden niezmienny artefakt, który przechodzi test → QA → PROD w kolejności wymuszonej
technicznie**, a każde wdrożenie mówi, co faktycznie wdrożono. Nie wymaga to przejścia na trunk-based (gałęzie
funkcjonalne i review zostają), wymaga promocji jednego artefaktu.

Kolejność poniżej to kolejność wdrażania, od najtańszej zmiany. Punkty 1–3 można zrobić od razu w obecnym modelu
z gałęziami `deployment/*`.

## 1. Wersja wpisana do wdrożenia (`payload`)

- **Co:** przy tworzeniu GitHub Deployment pipeline wpisuje do jego `payload` pola `version` (tag, np. `v1.4.45`)
  i `sha` (pełny SHA commita, z którego zbudowano artefakt).
- **Jak:** wdrożenie tworzone przez API zamiast automatycznie przez `environment:` w jobie (automatyczne nie ma
  payloadu):

  ```bash
  gh api "repos/$GITHUB_REPOSITORY/deployments" --input - <<EOF
  { "ref": "$GITHUB_SHA", "environment": "production", "auto_merge": false, "required_contexts": [],
    "payload": { "version": "$VERSION", "sha": "$ARTIFACT_SHA" } }
  EOF
  ```

  potem statusy `in_progress` i `success`/`failure` jak dziś. Szczegóły: [ONBOARDING.md](../ONBOARDING.md),
  „Versions from your pipeline”.
- **Gdzie:** job wdrożeniowy każdego środowiska (test, QA, PROD) w repo aplikacji.
- **Dlaczego:** GitHub zapisuje wdrożenie przy commicie, na którym uruchomił się workflow. W modelu z gałęziami
  `deployment/*` albo z wersją jako inputem to tylko wyzwalacz (głowa gałęzi), a nie wdrożony kod. ShipScope bez
  payloadu zgaduje wersję z taga, pliku wersji albo opisu commita wyzwalacza — stąd PROD z wersją i commitami,
  których tam nie ma. Od ShipScope 0.2.61 payload ma pierwszeństwo przed wszystkim innym, a `sha` służy do porównań
  i driftu. Dopóki pipeline go nie wpisuje, zostaje plik wersji (`trigger.properties`, Settings → GitHub).

## 2. Tag przed wdrożeniem

- **Co:** tag semver (`vX.Y.Z`) powstaje przy budowie artefaktu, zanim artefakt trafi na jakiekolwiek środowisko.
- **Jak:** krok `git tag` + `git push --tags` (albo release) w jobie build po merge'u do głównej gałęzi; wdrożenie
  przyjmuje istniejący tag i nie buduje ponownie.
- **Gdzie:** workflow budujący artefakt w repo aplikacji.
- **Dlaczego:** wdrożenie commita bez taga ShipScope pokazuje jako surowy SHA (np. test `35686c75bfaa` 29.10, który
  dopiero później dostał `v1.4.52`) i nie ma czym go porównać z innym środowiskiem. Tag przed wdrożeniem usuwa
  wersje-SHA u źródła.

## 3. Bramka QA → PROD

- **Co:** wdrożenie na PROD jest możliwe tylko dla wersji, która ma udane wdrożenie na QA.
- **Jak** (jedno z dwóch):
  - QA i PROD jako joby **jednego** workflow, PROD z `needs: deploy-qa`, wersja przekazywana z joba QA (output),
    nie wpisywana ponownie;
  - przy osobnych workflow: pierwszy krok joba PROD sprawdza przez API (`GET /repos/{repo}/deployments?environment=qa`
    + statusy), że ta sama wersja/SHA ma `success` na QA, i kończy job błędem, jeśli nie. Do tego environment
    `production` z required reviewers.

  Ręczne uruchomienie (`workflow_dispatch`) musi przechodzić przez to samo sprawdzenie — warunek w workflow, nie
  konwencja. Uwaga: job pominięty przez `if:` raportuje „Success”, więc bramka nie może opierać się na pominięciu.
- **Gdzie:** workflow wdrożeniowy PROD; ustawienia environment `production` w repo (Settings → Environments).
- **Dlaczego:** US14: v1.4.45 trafiło na PROD 26.10, gdy QA było na v1.4.40 — nic tego nie zatrzymało. GitHub nie ma
  natywnej reguły „wymagany udany deploy na innym environment”; reguły environment działają osobno dla każdego.
  [Dostępność required reviewers w repo prywatnych na planie zespołu — do sprawdzenia w dokumentacji GitHub przed
  decyzją.]

## 4. Jeden Deployment na jedno wdrożenie

- **Co:** jedno wdrożenie na środowisko tworzy dokładnie jeden rekord GitHub Deployment.
- **Jak:** sprawdzić, które joby mają `environment: <prod…>` (każdy taki job tworzy własny Deployment), zostawić
  `environment:` tylko w jobie, który wdraża; joby pomocnicze (zatwierdzenie, migracje, odczyt sekretów) bez
  `environment:` albo z environment o nazwie, której ShipScope nie mapuje na PROD (albo `skip` w Settings → GitHub →
  ołówek → environments).
- **Gdzie:** workflow wdrożeniowe w repo aplikacji.
- **Dlaczego:** PROD 26.10 ma 4 rekordy w 7 minut, 29.10 aż 8. Historia wdrożeń w ShipScope je zwija, ale liczby
  w API usług (wdrożenia i nieudane wdrożenia na dzień, CSV dla tf) są zawyżone, a job, który nie wdraża, wygląda
  jak wdrożenie. ShipScope mapuje środowiska po fragmencie nazwy: wszystko z „prod” w nazwie (np.
  `production-approval`) trafia na PROD.

## 5. Rollback tym samym pipeline'em

- **Co:** cofnięcie to wdrożenie poprzedniej wersji tą samą ścieżką (z payloadem i bramką), a nie osobny
  skrypt czy ręczna zmiana.
- **Jak:** uruchomić workflow wdrożeniowy z `version` = poprzedni tag.
- **Gdzie:** workflow wdrożeniowy PROD.
- **Dlaczego:** ShipScope rozpoznaje rollback, gdy nowa wersja jest przodkiem poprzedniej (29.10: PROD z v1.4.45
  wrócił do v1.4.40, wykryte poprawnie), i od tej zmiany przestaje liczyć cofnięte zadania jako wdrożone. Działa to
  tylko wtedy, gdy rollback jest zwykłym wdrożeniem z prawdziwą wersją.

## 6. Odejście od gałęzi `deployment/*` (pilot)

- **Co:** wdrożenie jako parametr (`version`, `environment`) zamiast commita z `trigger.properties` na gałęzi
  wdrożeniowej.
- **Jak:** pilot na jednym komponencie (`evnm-service-charger-infrastructure`): `workflow_dispatch` z inputem
  `version` albo kolejne joby po buildzie; gałąź z `trigger.properties` zostaje jako przejściowe źródło parametru.
  Po migracji komponentu wyłączyć mu plik wersji w ShipScope; ignorowane ścieżki driftu i porównanie drzew mogą
  zostać.
- **Gdzie:** repo pilotowego komponentu.
- **Dlaczego:** gałęzie per środowisko tworzą nowe commity dla identycznego kodu (stąd „786 commits behind” przy
  zerowej różnicy plików) i nie dają „build once, deploy many”. Wariant z commitami-wyzwalaczami jest do przyjęcia,
  ale tylko z punktami 1–3; sam niczego nie wymusza.

## Otwarte

- Kto jest właścicielem workflow w repozytoriach aplikacji i kiedy ma na to czas.
- Czy QA i PROD w `evnm-service-charger-infrastructure` to jeden workflow (wybór w punkcie 3) i skąd wiele rekordów
  Deployment (punkt 4) — workflow nie zostały jeszcze obejrzane.
- Ile komponentów używa gałęzi `deployment/*` (Settings → GitHub: repozytoria z ustawionym plikiem wersji).
