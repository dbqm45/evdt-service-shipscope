# Bramka warstwy pdi (krok 2 z „ShipScope bez pdi i z pdi”)

Stan: 2026-10-27. Dokument decyzji: https://claude.ai/artifact/JScDm4HD95kfpboNnyTzsr; krok 1 (połączenie) to #115,
druga strona w pdi to dbqm45/pdi#32. Teraz warstwa pdi chowa się bez połączenia.

## Co
- **Stan warstwy** (`lib/pdi-layer.js`, `pdiLayer()`): `visible` przy `connected`/`degraded` — ludzie widzą warstwę;
  `active` także przy `pending` — działają API usług i zdarzenia, żeby pdi mogło połączenie potwierdzić.
- **Dane dashboardu** dostają `capabilities: { pdi }`. Bez widocznej warstwy: bez zmian z repo (przyrost „Changes
  (repo)”, `workItemUrls`, klucze w `issueStatusIndex`), pusty `releasePlan`; `jira-issues?pi=@changes` zwraca `[]`.
  Worker i API usług czytają pełne dane jak dotąd.
- **Frontend:** bez `capabilities.pdi` znikają zakładka „Release plan” i wykresy lead time od intencji i od
  zgłoszenia. Próbka `FALLBACK` pokazuje warstwę pdi z `?pdi=1` (D6); `npm run dev:mock` pokazuje wszystko.
- **Settings:** „Outgoing events” i „Service tokens” w General, konwencja linii wydania w Jira i błędy folderu zmian
  w GitHub tylko przy widocznej warstwie.
- **Worker:** czyta `docs/project/changes` i szuka zdarzeń wydania tylko dla workspace'ów z aktywnym połączeniem.
- **API usług:** trasy poza `/connection` odpowiadają 404 bez aktywnego połączenia.
- **Istniejące workspace'y** (`backfillPdiConnections()`, raz przy starcie workera, idempotentnie): każdy z
  subskrypcją zdarzeń albo tokenem usługi, a bez połączenia, dostaje połączenie `pending` z tą subskrypcją (adres
  odbiornika z jej adresu) i tokenem („pdi”, inaczej ostatnio użyty). Ich dotychczasowe dostawy i odczyty liczą się
  jako potwierdzenia, więc zwykle są od razu `connected`. Migracja `045`: `receiver_url` może być pusty (sam token).

## Testy (najpierw czerwone)
`server/test/pdi-layer.test.js`: bez połączenia — dane bez warstwy, `@changes` puste, API usług 404, zdarzenia nie
powstają; `pending` — API działa, warstwa ukryta; `connected` — warstwa widoczna; uzupełnienie dla starych
workspace'ów. Testy, które sprawdzają warstwę pdi, dostają połączenie z pomocnika `connectPdiForTest()`.
Root: zakładka i wykresy chowane bez `capabilities.pdi`.
