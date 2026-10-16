# Wczytywanie wartości flag w synchronizacji plikowej

*English version: [FLAG-INGEST.md](FLAG-INGEST.md)*

> **Zakres: tylko synchronizacja plikowa (jeden tenant)** — `scripts/`, `docs/data/*.json` na `live`. Serwer ma
> własny kontrakt (`POST /api/flags/ingest`, `schemaVersion: 2`, nazwane źródła flag z własnymi tokenami; patrz
> `server/README.md`) i celowo nie korzysta z tego. Nowe źródła flag powinny iść przez serwer; ta ścieżka nie
> jest dalej rozwijana.

## Co to jest

Trzy skrypty zapisują wartości flag do `docs/data/flag-states.json` (klucz → środowisko → źródło →
`{ enabled, changedAt, changedBy, component }`). Dwa z nich korzystają ze wspólnego rdzenia zamiast trzymać kopie
tej samej logiki:

```
adapter (per źródło)  →  obserwacje  →  scripts/lib/flag-ingest.js  →  flag-states / flags-meta / historia
```

`applyObservations()` robi: ochronę przed kolizją (inny komponent jest już właścicielem stanu tego klucza dla
tego źródła: `::error::`, pominięcie, bez wyjątku), szkielet wpisów w `flags-meta.json` i sumę `components`,
idempotencję (brak zmiany = brak zapisu i wpisu w historii) oraz wpisy w `flag-state-history.json`. Skrypty
odpowiadają za odczyt i zapis plików oraz za to, skąd biorą wartości.

| Adapter | Źródło | Uwagi |
|---|---|---|
| `resolve-all-flag-states.js` | pliki `flag-parts/` w repo aplikacji (`check-flags.yml`) | flagi `build` |
| `sync-runtime-be-flags.js` | adresy per środowisko zwracające `{ flaga: true\|false }` | `runtime-be`; jedyny, który poprawia istniejące `source` w `flags-meta` (`correctMetaSource`) |
| `ingest-flags.js` | JSON wygenerowany przez repo aplikacji (dowolne źródło) | waliduje ładunek, patrz niżej |

`update-flag-state.js` (jedna ręczna zmiana, bez `COMPONENT`) celowo nie korzysta z rdzenia.

## Kontrakt ładunku (`ingest-flags.js`, `schemaVersion: 1`)

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

Inne pola (`observedAt`, `changedBy`, `value`, `kind` były zarezerwowane na później) są pomijane: każdy odbiorca
zakłada logiczne `enabled`. Skrypt zapisuje też `docs/data/flag-ingest-meta.json` (`{ [komponent]:
{ lastMessageDay, source } }`, z dokładnością do dnia, żeby przebieg bez zmian nic nie commitował).

Zasady bezpieczeństwa, wszystkie egzekwowane:

- **`component` nigdy nie pochodzi z ładunku.** Przychodzi jako `COMPONENT` z tożsamości wywołującego; ładunek
  wskazujący inny komponent jest odrzucany — inaczej repo mogłoby podszyć się pod inne i obejść ochronę przed
  kolizją.
- Wejście jest niezaufane: sprawdzenie schematu, najwyżej 5000 obserwacji, wzorzec klucza, odrzucanie
  `__proto__`/`constructor`/`prototype`, `env` tylko `test`/`qa`/`prod`, `enabled` logiczne, bez sprzecznych
  duplikatów.
- Wykonywalny kod nadal pochodzi tylko z `main` (podział `main`/`live` w `CLAUDE.md`); ładunek to dane.

## Stan

Rdzeń, oba przeniesione skrypty i `ingest-flags.js` są gotowe i przetestowane. **Nie ma w tym repozytorium:**
akcji złożonej `.github/actions/ingest-flags`, która miała wiązać `COMPONENT` z wywołującym repo — patrz
[TODO.md](TODO.md). Bez niej żaden workflow nie uruchamia dziś `ingest-flags.js`.
