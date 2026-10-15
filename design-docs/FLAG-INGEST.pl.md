# Zunifikowany ingest wartości flag

*English version: [FLAG-INGEST.md](FLAG-INGEST.md)*

Status (2026-10-13): kroki 1–3 zrobione (`flag-ingest.js`, przepięte oba skrypty, `ingest-flags.js`), plus composite action `.github/actions/ingest-flags`. Niezrobione: `flagSource` w `components.json` i znacznik świeżości (kroki 4–5). Akcja nie była jeszcze uruchomiona w prawdziwym workflowie.

## Problem

ShipScope pozyskuje wartości flag na dwa sposoby: z plików w repo aplikacji (`flag-parts/`, `*.generated.ts`) i z URL-i (`sync-runtime-be-flags.js`). Chcemy zostawić dowolność co do źródła wartości, bez przepisywania ShipScope przy każdym nowym sposobie.

Zunifikowany format *wyjścia* już istnieje: `docs/data/flag-states.json` (key → env → source → `{enabled, changedAt, changedBy, component}`). Brakuje zunifikowanego *wejścia*. Trzy skrypty zapisują do tego pliku i każdy ma własną kopię tej samej logiki:

- `resolve-all-flag-states.js` (pliki),
- `sync-runtime-be-flags.js` (URL-e),
- `update-flag-state.js` (ręczny dispatch).

Każdy osobno robi: guard kolizji komponentów, scaffold `flags-meta.json`, idempotentne `changedAt`, wpis do `flag-state-history.json`. Nowe źródło oznaczałoby czwartą kopię.

## Decyzja

**Wspólny rdzeń ingestu + cienkie adaptery**, bez osobnego serwera (zgodnie z modelem „bez serwera", zob. `INTEGRATION-VISION.md`). To deterministyczna funkcja, nie „orkiestrator" ze stanem.

```
adapter (per źródło)  →  obserwacje  →  rdzeń ingestu  →  flag-states / flags-meta / history
```

### Rdzeń: `scripts/lib/flag-ingest.js`

`applyObservations(...)` przejmuje wszystko, co dziś jest zduplikowane: guard kolizji (`::error::`, bez rzucania), scaffold `flags-meta`, idempotencję (brak zmiany = brak zapisu i brak wpisu historii), historię. Zachowanie istniejących skryptów ma się nie zmienić; chronią je testy w `test/`.

### Kontrakt (format pośredni)

```json
{
  "schemaVersion": 1,
  "component": "evapl-service-frontend",
  "source": "runtime-be",
  "observations": [
    { "key": "myFlag", "env": "prod", "enabled": true }
  ]
}
```

Pola opcjonalne obserwacji: `observedAt`, `changedBy`, `value`, `kind`.

### Adaptery

| Adapter | Źródło | Uwagi |
|---|---|---|
| `url` | obecny `sync-runtime-be-flags.js` | domyślny, „zero pracy po stronie aplikacji", cron jako siatka bezpieczeństwa |
| `flag-parts` | obecny `resolve-all-flag-states.js` | flagi `build` z plików |
| `payload` | nowy `ingest-flags.js` | czyta JSON w kontrakcie, waliduje; repo aplikacji generuje go dowolnie (Actuator, plik, zewnętrzny system) |

## Rozstrzygnięcia

### 1. Typ wartości: na razie boolean, kontrakt rozszerzalny

Wszyscy konsumenci zakładają `enabled: boolean` (`effectiveFlagState()`, statusy released/deployed/partial, stale flags, Insights, historia). Warianty/procenty/stringi teraz wymusiłyby przepisanie tych miejsc bez realnej potrzeby (YAGNI).

- `enabled: boolean` jest obowiązkowe; `value`/`kind` opcjonalne, na razie tylko zapisywane lub ignorowane.
- `schemaVersion` jest w kontrakcie od v1, więc nieboolowskie flagi można dodać jako v2 bez łamania repozytoriów wysyłających v1.
- Jeśli pojawi się konkretny przypadek flagi nieboolowskiej do wyświetlenia, trzeba to zaprojektować od razu razem z UI.

### 2. Transport: push jako ścieżka główna, URL (pull) jako fallback

- **Push (`payload`)**: workflow w repo aplikacji zna swoje źródło i ma do niego dostęp; ShipScope nie musi znać adresów ani poświadczeń. Zgodne z wizją onboardingu (instalacja GitHub App + konfiguracja ShipScope). Wzorzec już istnieje w `check-flags.yml`. Obsługuje też źródła niewidoczne z runnera GitHuba i zmiany natychmiastowe.
- **Pull (`url`)**: opcja bez pracy po stronie aplikacji + cron.
- **Dlaczego nie tylko push**: zawodzi po cichu (precedens: `notify-deployment.yml`, deploy bez kroku `notify_shipscope` po prostu znika). Dla komponentów z `flagSource: payload` zapisujemy znacznik „ostatnia wiadomość od komponentu" (np. w `sync-meta.json`) i pokazujemy w UI nieświeżość danych.
- **Dlaczego nie tylko pull**: nie obsłuży źródeł bez dostępu sieciowego z runnera ani zmian natychmiastowych.

Konfiguracja per komponent w `docs/components.json`:

```json
"flagSource": { "type": "url", "urls": { "test": "...", "qa": "...", "prod": "..." } }
// albo
"flagSource": { "type": "payload" }
```

Onboarding to jedna edycja w jednym miejscu, jak dziś.

## Zagrożenia i wymagania bezpieczeństwa

- **`component` nie może pochodzić z payloadu.** Guard kolizji opiera się na tym polu; gdyby repo je deklarowało samo, mogłoby podszyć się pod cudzy komponent. Ma wynikać z tożsamości wywołującego (nazwa repo / token GitHub App → mapowanie na `components.json`).
- **Transport**: `repository_dispatch` ma limit `client_payload` (10 pól, ~65 KB), więc nie nadaje się do dużych zestawów. Wzorzec jak w `check-flags.yml`: workflow w repo aplikacji wywołuje skrypt z plikiem JSON.
- **Walidacja payloadu**: schemat, limity rozmiaru, odrzucanie kluczy `__proto__`/`constructor`/`prototype` (jak w `update-flag-state.js`), `env` tylko `test`/`qa`/`prod`. Nie ufamy wejściu.
- Wykonywalny kod nadal pochodzi wyłącznie z `main` (podział `main`/`live` z `CLAUDE.md`); payload to dane.

## Plan wdrożenia

1. ✅ Wydzielić `flag-ingest.js` z `sync-runtime-be-flags.js` (bez zmiany zachowania, pokryte testami).
2. ✅ (częściowo) Przepięto `resolve-all-flag-states.js` na ten sam rdzeń. `update-flag-state.js` świadomie zostaje bez zmian: to ręczna zmiana jednej flagi, bez `COMPONENT` i bez guardu kolizji, więc nie pasuje do `applyObservations`.
3. ✅ Dodać `ingest-flags.js` (adapter `payload`): walidacja schematu, `COMPONENT` z zewnątrz, nie z payloadu.
4. ✅ (częściowo) Composite action `.github/actions/ingest-flags` wiąże komponent z tożsamością wywołującego. **Niezrobione:** `flagSource` w `components.json` (odroczone, bo przy trybie `payload` nic go nie czyta; potrzebne dopiero przy pull i świeżości).
5. ✅ (częściowo) Znacznik świeżości: `ingest-flags.js` zapisuje `docs/data/flag-ingest-meta.json` (`{ [component]: { lastMessageDay, source } }`, granularność dnia, żeby nie łamać „brak zmiany = brak commita”). **Niezrobione:** sygnał nieświeżości w UI — czeka na pierwszy komponent, który faktycznie wysyła payload.

## Do zrobienia

Stan na 2026-10-13. Kody, testy (406 z 406) i dokumentacja (`CLAUDE.md`, oba `CHANGELOG`) są w working tree, kod jest w commicie `50575a4` (gałąź `feat/EBO-16414-feature-flags-input`, jeszcze nie w `main`); znacznik świeżości w working tree.

### Przed mergem do `main`

- [ ] Commit, najlepiej w dwóch częściach: (a) refaktor rdzenia (`scripts/lib/flag-ingest.js`, przepięte `sync-runtime-be-flags.js` i `resolve-all-flag-states.js`, `test/flag-ingest.test.js`), (b) nowy adapter (`scripts/ingest-flags.js`, `test/ingest-flags.test.js`, `.github/actions/ingest-flags/`).
- [ ] Sprawdzić refaktor na prawdziwych danych: uruchomić ręcznie `sync-runtime-be-flags.yml` i `check-flags.yml` po mergu na `live` i potwierdzić, że diff w `docs/data` jest pusty. Dotąd sprawdzone tylko testami z fixture'ami.
- [x] Zwalidować `action.yml`: 2026-10-15, ręcznie (brak `actionlint`/PyYAML) — trzy bloki `run` przechodzą `bash -n`, brak tabulatorów, każde `steps.<id>.outputs.*` wskazuje istniejący krok, wersje akcji, ścieżka `jq` i dispatch `flags-meta-changed` zgodne z istniejącymi workflowami. Nadal nieuruchomiona na prawdziwym runnerze.
- [ ] Zapamiętać jedyną widoczną różnicę refaktoru: `resolve-all-flag-states.js` wypisuje podsumowanie kolizji przed linią `Resolved…` (stderr; testy tego nie asertują).

### Pilotaż akcji (zablokowany: na razie bez zmian w workflowach repo serwisów)

- [ ] Sprawdzić, czy repo serwisów mogą używać akcji z `circlek-global/evdt-service-shipscope` (ustawienie org-owe dla akcji; reusable workflow stamtąd już działa, ale to osobne ustawienie, niesprawdzone).
- [ ] Wybrać jeden komponent i uruchomić akcję z prawdziwym payloadem. Zweryfikować: guard domyślnej gałęzi, odrzucenie repo spoza `components.json`, push z retry, wysłanie `flags-meta-changed`, idempotencję drugiego biegu.
- [ ] Akcja nie ma własnych testów (testowane są tylko skrypty); rozważyć, czy dla kodu YAML/bash potrzebny jest jakikolwiek test automatyczny.

### Dalsze kroki wdrożenia

- [ ] `flagSource` w `components.json` (`url` lub `payload`) i odczyt go przez cron, żeby wiedział, które komponenty odpytywać.
- [ ] Znacznik „ostatnia wiadomość od komponentu" i sygnał nieświeżości w UI (krok 5), zob. otwarte pytania.
- [ ] Opcjonalnie: adapter `url` jako zwykły wejściowy format kontraktu (dziś `sync-runtime-be-flags.js` buduje obserwacje sam, co wystarcza).

### Dokumentacja

- [x] Wersja angielska tego dokumentu.
- [x] Jednozdaniowy odnośnik do tego dokumentu w `design-docs/ARCHITECTURE-NOTES.md` i `.pl.md` (omawiają ten sam temat: model pull i wariant „hybrid").
- [ ] Wzmianka o trasie `payload` w `ONBOARDING.md` / `ONBOARDING.pl.md` dopiero po udanym pilotażu.

### Odroczone świadomie

- Wartości inne niż boolean (`value`/`kind`, `schemaVersion: 2`): dopiero przy konkretnym przypadku, razem ze zmianą UI (`effectiveFlagState()`, statusy, stale flags, Insights).

## Użycie przez repo serwisu (opt-in)

Komponent jest ustalany z tożsamości wywołującego (`github.event.repository.name`, ten sam wzorzec co `check-flags.yml`/`notify-deployment.yml`), musi być w `components.json`, a zapis działa tylko na domyślnej gałęzi. Akcja jest composite (nie reusable workflow), żeby widzieć workspace joba, w którym powstał payload.

```yaml
- name: Build flag payload
  run: ./scripts/dump-flags.sh > flags-payload.json   # dowolne źródło
- uses: circlek-global/evdt-service-shipscope/.github/actions/ingest-flags@main
  with:
    payload-path: flags-payload.json
    shipscope-app-id: ${{ secrets.SHIPSCOPE_APP_ID }}
    shipscope-app-private-key: ${{ secrets.SHIPSCOPE_APP_PRIVATE_KEY }}
```

## Otwarte pytania

- ~~Gdzie przechowywać znacznik?~~ Rozstrzygnięte: osobny `flag-ingest-meta.json` (`sync-meta.json` ma inną semantykę — „pełny sync potwierdzony”). Próg nieświeżości: 48 h w UI, tylko dla komponentów, które choć raz wysłały payload (brak wpisu = komponent nie używa push, nic nie pokazujemy). Do zrobienia razem z UI.
- ~~Czy flagi `build` przechodzą przez `payload`?~~ Rozstrzygnięte: zostają przy `flag-parts` (`check-flags.yml`); `payload` jest dodatkową, opcjonalną drogą. Nic nie zmienia się w workflow repo serwisów.
