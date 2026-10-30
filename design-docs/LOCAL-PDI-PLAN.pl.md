# pdi na tym samym komputerze (krok L1 z „cały przepływ lokalnie z sdlc up”)

Stan: 2026-10-30. Źródło: dbqm45/pdi `docs/plan-sdlc-lokalnie.md` §2 Z1 i §4 L1, decyzja DL2 w `docs/decyzje.md`
(wszystkie usługi to procesy na localhost, tylko Postgres w Dockerze).

## Cel
ShipScope uruchomiony przez `npm run dev` łączy się z pdi-receiverem na tej samej maszynie
(`http://127.0.0.1:8787`) bez tunelu, a Settings → Integrations → pdi → Test pokazuje `connected`.

## Co
1. **Tryb lokalny** (`lib/local-mode.js`, `localModeEnabled(env)`, czysta funkcja): włączony tylko, gdy
   `PUBLIC_BASE_URL` to `http://localhost[:port]` albo `http://127.0.0.1[:port]` i `NODE_ENV` nie jest `production`
   (ten sam warunek, którym `dev:mock` odmawia gdzie indziej). Decydowany raz przy starcie `web.js` i `worker.js`,
   przekazywany jawnie (`buildApp({ localMode })` → `ctx.localMode`; ticki workera dostają `{ localMode }`); oba
   procesy logują wtedy ostrzeżenie, jak przy `SHIPSCOPE_MOCK_DATA`.
2. **`lib/safe-fetch.js`**: opcja `loopback` w `checkUrl()` i `safeFetch()`. Z `loopback: true` adres, którego host to
   dokładnie `localhost`, `127.0.0.1` albo `::1`, może być http albo https na dowolnym porcie; połączenie idzie na
   adres pętli zwrotnej wprost (`localhost` → `127.0.0.1`), bez DNS. Bez przekierowań, z limitem czasu i rozmiaru
   jak dotąd. Każdy inny adres — także z `loopback: true` — podlega dzisiejszym regułom (https, 443, publiczny).
3. **Tylko odbiornik pdi** dostaje `loopback: localMode`: `connectPdi()` (adres odbiornika), `pingPdi()`/
   `pingPdiConnections()`/`testPdiConnection()` (ping), `deliverEvents()` tylko dla subskrypcji należącej do aktywnego
   połączenia z pdi. `addSubscription()`, źródła flag z endpointów i `checkEndpointConfig()` zostają bez zmian.
4. **`loadAtlassianConfig()`**: grupę Atlassian tworzą `ATLASSIAN_CLIENT_ID`/`_SECRET`; sam `TOKEN_ENCRYPTION_KEY`
   (dziś używany też przez flagi, zdarzenia i pdi) nie jest już „niepełną konfiguracją Jira”. Bez tego klucz
   wygenerowany przez `dev.js` zatrzymałby start.
5. **`scripts/dev.js`**: gdy `server/.env` nie ma `TOKEN_ENCRYPTION_KEY`, generuje go raz (32 losowe bajty, base64) i
   zapisuje; istniejącej wartości nigdy nie zmienia; mówi o tym w wyjściu (`encryptionKeyUpdate()`, czysta).
6. **Dokumentacja**: `server/README.md` (lokalna konfiguracja, tryb lokalny i co dopuszcza), `CLAUDE.md` (safe-fetch,
   połączenie z pdi, `npm run dev`), `design-docs/SECURITY.md` (dlaczego to bezpieczne).

## Kolejność i testy (najpierw czerwone)
1. `test/local-mode.test.js`: warunek trybu lokalnego (localhost/127.0.0.1 po http tak; https, inne hosty, brak
   wartości, `NODE_ENV=production` nie).
2. `test/safe-fetch.test.js`: pętla zwrotna odrzucana bez trybu lokalnego; z `loopback` przyjmowana (http i https,
   dowolny port, bez DNS); adres prywatny spoza pętli (10/8, 192.168/16), `127.0.0.2`, publiczny http i inny port na
   publicznym hoście nadal odrzucane z `loopback`; przekierowanie z lokalnego serwera nie jest śledzone; limit rozmiaru.
3. `test/jira.test.js`: sam `TOKEN_ENCRYPTION_KEY` → `null`.
4. `test/dev.test.js`: klucz generowany raz, istniejący zostaje.
5. `test/pdi-connection.test.js` (Postgres): Connect z `http://127.0.0.1:8787` w trybie lokalnym tworzy token,
   subskrypcję i połączenie; bez trybu lokalnego — 400 jak dziś; ping i dostawa zdarzenia do lokalnego serwera http
   przez prawdziwy `safeFetch()` → `connected`; zwykła subskrypcja na adres pętli nadal odrzucana.
6. Kod, potem dokumentacja. Bramki: `npm test` (root i `server/` z `TEST_DATABASE_URL`),
   `node scripts/check-module-boundaries.js`, `npm run lint:commit`.
