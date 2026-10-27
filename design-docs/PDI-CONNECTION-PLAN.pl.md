# Połączenie z pdi (krok 1 z „ShipScope bez pdi i z pdi”)

Stan: 2026-10-27. Dokument decyzji: https://claude.ai/artifact/JScDm4HD95kfpboNnyTzsr (decyzje D1–D6 przyjęte
2026-10-27). Funkcje warstwy pdi (zmiany z repo, plan wydania, zdarzenia, API usług, MCP, lead time z intencji)
mają być widoczne dopiero po połączeniu workspace'u z pdi. Ten PR robi samo połączenie i jego stany; **niczego
jeszcze nie chowa**. Bramka przyjdzie w następnym PR-ze, żeby nikt nie stracił funkcji, zanim może się połączyć.

## Co
1. **Model.** Migracja `044_pdi_connection.sql`: tabela `pdi_connections` (RLS, jedna na workspace, kaskada
   z `tenants`): adres odbiornika pdi, id tokenu usługi i subskrypcji zdarzeń, które należą do połączenia, wynik
   ostatniego pingu (`last_ping_ok_at`, `last_ping_error`, `last_ping_error_at`), `disconnected_at`.
   `event_subscriptions.signing_secret_enc`: subskrypcja może mieć własny sekret podpisu (zapieczętowany
   `TOKEN_ENCRYPTION_KEY`, AAD: workspace, subskrypcja); bez niego podpisuje sekret workspace'u jak dotąd.
2. **Połączenie** (`lib/pdi-connection.js`, admin): `POST …/pdi-connection { receiverUrl }` w jednej transakcji
   tworzy token usługi „pdi” (bez końca ważności), subskrypcję obu zdarzeń na `<adres>/events/shipscope` z własnym
   sekretem i wiersz połączenia; odpowiedź raz pokazuje `PDI_SHIPSCOPE_URL`, `PDI_SHIPSCOPE_TOKEN`,
   `PDI_SHIPSCOPE_SIGNING_SECRET`. `DELETE` odwołuje token i usuwa subskrypcję (z kolejką), zostawia wiersz
   z `disconnected_at`. Drugie połączenie przy aktywnym — 409. Oba w aktywności ustawień (`pdi_connected`,
   `pdi_disconnected`, bez sekretów). Sekret jest w rotacji kluczy i w teście odtworzenia kopii.
3. **Potwierdzenia.** pdi → ShipScope: token połączenia użyty na API usług (`last_used_at`); nowa trasa
   `GET /api/service/v1/connection` (workspace i stan połączenia, dowolny token usługi). ShipScope → pdi:
   podpisany ping `GET <adres>/events/shipscope` (`X-ShipScope-Event: ping`, podpis jak zdarzeń nad pustą treścią)
   z workera co godzinę i z przycisku „Test” (`POST …/pdi-connection/test`), albo dostarczone zdarzenie.
4. **Stany** (`judgePdiConnection()`, czyste, `lib/pdi-connection-model.js`): `none`, `pending` (brak jednego
   z potwierdzeń), `connected`, `degraded` (ostatni kontakt z pdi nieudany, a ostatni udany starszy niż godzina; albo
   pdi nie czytało ShipScope od 14 dni), `disconnected`. `GET …/pdi-connection` (członkowie) zwraca stan
   i listę kontrolną; Settings → Integrations → pdi pokazuje kartę (formularz, blok zmiennych raz, stan,
   Test, Rozłącz).

## Testy (najpierw czerwone)
`server/test/pdi-connection.test.js`: stany z czystego modelu; połączenie przez trasy (admin, członek 403,
drugie 409, blok zmiennych raz, token i subskrypcja istnieją); potwierdzenia (odczyt API usług, ping podpisany
sekretem połączenia, błąd pingu), stan `connected`/`degraded`; zdarzenia podpisane sekretem połączenia;
rozłączenie (token 401, subskrypcja usunięta, ponowne połączenie); `GET /api/service/v1/connection`; RLS.
`settings-ui.test.js`: karta w każdym stanie. Do tego `migrate`, tablica tras, rotacja sekretów, usuwanie
workspace'u.
