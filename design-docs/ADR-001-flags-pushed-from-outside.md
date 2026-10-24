# ADR-001: Flagi są wypychane z zewnątrz — ShipScope ich nie czyta

- **Status**: przyjęta; zasada „ShipScope nigdy nie czyta flag" zastąpiona przez
  [ADR-003](ADR-003-flag-sources.md) (2026-10-24), kontrakt `schemaVersion: 2` obowiązuje dalej
- **Data**: 2026-10-16 (decyzja wcześniejsza, udokumentowana wprost w `CLAUDE.md`; ten ADR ją tylko wyodrębnia
  z prozy, nie zmienia jej treści — zob. `design-docs/REPORT_ARCH.md`, II.2, krawędź 4)

## Kontekst

ShipScope pokazuje stan feature-flagów dla wielu komponentów/serwisów jednego najemcy. Komponenty różnią się
sposobem przechowywania flag: pliki generowane w czasie builda (FE), serwis runtime z własnym API, albo brak
mechanizmu flag w ogóle. Alternatywą do rozważenia było: ShipScope samo odpytuje każdy komponent o jego
flagi (jeden adapter per mechanizm — plik, Spring Boot Actuator, LaunchDarkly, własne API...).

## Decyzja

ShipScope **nigdy nie czyta** stanu flag z komponentu. Każdy nadawca (jedno konkretne źródło flag — plik,
serwis, zewnętrzny provider) wysyła **pełny stan swoich flag** per środowisko, własnym tokenem, do jednego
publicznego kontraktu:

```
POST /api/flags/ingest
schemaVersion: 2
{ complete, environments, observations: [{ key, env, state, rollout?, changedAt? }], flags?: [...] }
```

Właściwości kontraktu (`server/lib/flags.js`/`flags-logic.js`):
- **Jawnie wersjonowany** (`schemaVersion: 2`) — zmiana kształtu nigdy nie jest cichym złamaniem istniejących
  nadawców.
- **Nic nie zakłada o tym, jak najemca trzyma swoje flagi** — nie ma specjalnej ścieżki dla "pliku" czy
  "serwisu"; każdy nadawca wygląda z perspektywy kontraktu identycznie.
- **Pełny stan, nie delta** (`complete`, domyślnie `true`) — flaga, którą nadawca przestał zgłaszać, jest
  usuwana po jego stronie (reguła widoczności w `visibleFlagsMeta()`), bez osobnego mechanizmu "usunięcia".
- **Starsza wiadomość nigdy nie cofa nowszej** (`planIngestWrites()`, porównanie `changedAt`) — nadawcy mogą
  się nakładać w czasie bez ryzyka race condition.
- **Token per nadawca**, nie sesja użytkownika — ingest działa bez logowania, bo to maszyna-do-maszyny.

To podręcznikowy wzorzec **Open Host Service** (DDD): publiczny, wersjonowany kontrakt na granicy kontekstu,
niezależny od wewnętrznego modelu żadnej ze stron.

## Rozważane opcje

- **ShipScope odpytuje każdy komponent** (adapter per mechanizm: plik, Actuator, LaunchDarkly...) —
  odrzucona. Każdy nowy mechanizm flag u najemcy wymagałby nowego adaptera w ShipScope; `design-docs/
  TODO.md` dokumentuje realny przypadek (`evsim-service-sim-adapter`), gdzie nawet "prosty" przypadek
  (Spring Boot Actuator) okazał się kosztowny i mniej bezpieczny (odsłania całą konfigurację serwisu, nie
  tylko flagi) niż mały, celowy endpoint po stronie komponentu.
- **Push z jednym, wspólnym formatem wymuszonym na każdym nadawcy** (odrzucona implicite) — kontrakt
  faktycznie jest jeden, ale projekt świadomie **nie** próbuje zmusić każdego nadawcy do tego samego
  mechanizmu wewnętrznego (build-time plik vs runtime serwis) — tylko do tego samego kontraktu na granicy.

## Konsekwencje

- Pozytywne: jeden model dashboardu obsługuje najemcę z plikami build-time, z serwisem runtime i bez żadnych
  flag, bez zmiany w ShipScope. Dodanie nowego mechanizmu flag u najemcy nie wymaga zmiany w ShipScope,
  tylko napisania nadawcy zgodnego z kontraktem.
- Negatywne: ShipScope nie ma własnej, pełnej historii — ufa temu, co nadawca zgłosi. Jeśli nadawca nigdy nie
  wyśle żadnej wiadomości (np. padł na stałe), jego flagi po prostu nigdy się nie pojawią — nie ma
  mechanizmu "wykryj, że ktoś przestał wysyłać" (ryzyko ciche, ale akceptowane: brak danych od nadawcy
  wygląda identycznie jak "nadawca jeszcze nigdy nie zgłosił tej flagi").
- Ten kontrakt (`schemaVersion: 2`, wielodzierżawczy) jest **odrębny** od starszego, jednodzierżawczego
  kontraktu sync'u plikowego (`scripts/lib/flag-ingest.js`, `schemaVersion: 1`) — `server/` **celowo nie
  portuje** tej biblioteki (`CLAUDE.md`). Najemca migrujący ze sync'u plikowego na SaaS musi przepisać
  swojego nadawcę flag na `schemaVersion: 2` — to fakt produktowy (koszt migracji), nie tylko techniczny,
  i powinien być widoczny w każdym planie wygaszenia sync'u plikowego (`design-docs/REPORT_ARCH.md`, Pytanie
  otwarte 1).
