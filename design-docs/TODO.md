# TODO

## Ujednolicenie odczytu stanu feature flag przez dedykowane endpointy

Warto rozważyć dodanie do serwisów `evsim-service-sim-adapter` oraz `evam-service-host` dedykowanych
endpointów zwracających aktualny stan feature flag per środowisko, w płaskim formacie
`{ nazwaFlagi: true|false }` — dokładnie takim, jaki `scripts/sync-runtime-be-flags.js` już potrafi
odczytać bez jakichkolwiek zmian w kodzie. Kontekst i uzasadnienie tego podejścia (w odróżnieniu od
sięgania bezpośrednio do Spring Boot Actuatora) zostało opisane w `ARCHITECTURE-NOTES.md`, w sekcji
dotyczącej konkretnego przypadku `evsim-service-sim-adapter`.

W przyszłości warto rozważyć wprowadzenie analogicznego endpointu również dla `evapl-service-frontend`,
niezależnie od tego, że jego flagi są dziś typu build-time. Umożliwiłoby to jednolite i spójne odczytywanie
stanu flag dla każdego z serwisów za pośrednictwem tego samego mechanizmu (endpoint/API), niezależnie od
tego, czy dany serwis jest komponentem frontendowym, czy backendowym.

Powiązane pole w schemacie: `docs/components.json` oznacza już dziś `featureFlagsIncluded: false` dla
`evsim-service-sim-adapter` oraz `null` (nierozstrzygnięte) dla `evam-service-host`. Dodanie wymienionych
endpointów byłoby naturalnym sposobem na zamknięcie tego długu i zmianę odpowiadających im wartości na
`true`.