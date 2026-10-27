# Dane warstwy pdi po rozłączeniu (D5 z „ShipScope bez pdi i z pdi”)

Stan: 2026-10-27. Dokument decyzji: https://claude.ai/artifact/JScDm4HD95kfpboNnyTzsr. Decyzja D5: po rozłączeniu
worker przestaje czytać dane warstwy pdi, zostają one 30 dni, a potem usuwa je zadanie retencji. Po krokach 1–4
worker już ich nie czyta (bramka), ale nic ich nie usuwa.

## Co
1. **Model** (`lib/pdi-connection-model.js`): `PDI_DATA_KEEP_DAYS = 30`; `judgePdiConnection()` podaje przy
   rozłączonym połączeniu `dataKeptUntil` (rozłączenie + 30 dni) albo `dataRemovedAt`, gdy dane już usunięto.
2. **Migracja `047`**: `pdi_connections.data_removed_at`. Ponowne połączenie zeruje ją razem z `disconnected_at`.
3. **Retencja** (`lib/retention.js`, `cleanupPdiLayer()`, w dziennym `cleanupAll()`): dla połączenia rozłączonego
   ponad 30 dni temu i jeszcze nie wyczyszczonego, w jednej transakcji, usuwa `work_items`, `release_plans`
   i `event_state` workspace'u, zeruje w `tracked_repos` `work_items_ref`, `work_items_error` i `work_items_version`
   (po ponownym połączeniu folder zmian czyta się od nowa) i zapisuje `data_removed_at`. Do 30 dni nic nie znika,
   więc ponowne połączenie zaczyna z tymi samymi danymi.
4. **Zostaje**: linie wydań z Jiry (`release_lines`) i powiązania z dopisku `Flag:` (`flag_commit_links`), bo
   zapisuje je synchronizacja rdzenia także bez pdi. Kolejka zdarzeń znika już przy rozłączeniu razem z subskrypcją.
5. **Settings → pdi**: po rozłączeniu „dane warstwy pdi zostają do X; połącz ponownie wcześniej, żeby je zachować”
   albo „usunięte X”.

Przy okazji dokument decyzji: dopisek `Flag:` w commicie zostaje w rdzeniu (jedno z czterech źródeł powiązań flaga →
zadanie, nie wymaga pdi), zamiast „bramka go nie objęła”.

## Testy (najpierw czerwone)
`server/test/pdi-data-retention.test.js`: dzień 29 nic nie znika; dzień 31 dane warstwy znikają, rdzeń zostaje
(wdrożenia, linie wydań z Jiry), repo czyta folder od nowa, `data_removed_at` ustawione, drugie przejście nic nie
robi; ponowne połączenie przed terminem zachowuje dane i zeruje termin. Model: `dataKeptUntil`/`dataRemovedAt`.
`settings-ui.test.js`: oba komunikaty.
