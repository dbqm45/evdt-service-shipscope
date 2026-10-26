# F5 — API dla usług (ShipScope)

Stan: 2026-10-26, zrobione (PR w toku). Krok z planu jednego flow (dbqm45/pdi `docs/plan-jeden-flow-sdlc.md` §6, F5:
„ShipScope: API usług”). Decyzja właściciela z 2026-10-26: najpierw ten element F5, bo od niego zależą graf śladu
i ocena skutku w pdi oraz pasma kontrolne w tf. Powiadomienia zgłaszającego czekają na F3 (pdi nie ma jeszcze
zgłoszeń).

## Cel
Inna usługa (pdi, tf, skrypt w CI) czyta z ShipScope tokenem usługi, bez sesji człowieka:
1. **status elementu** — Jira issue, zmiana CHG albo cięcie TSK: na każdym środowisku to, co pokazuje pill w
   dashboardzie (`issueStatusForEnv()`: `none`/`deployed`/`released`/`partial`/`deployed_code_only`, wątpliwości
   i ostrzeżenie FE/BE) oraz pierwsze wdrożenie na PROD;
2. **metryki** — szereg dzienny dla PROD: wdrożenia, wdrożenia nieudane, rollbacki, mediana lead time Done → PROD
   i liczba elementów (drift nie ma historii — `tracked_repos.drift` trzyma tylko stan bieżący — więc nie wchodzi do
   szeregu), w JSON albo CSV (CSV czyta wprost `control_band.py --column rollbacks` w tf).

## Tokeny usług
- Migracja `040_service_tokens.sql`: `service_tokens` (RLS, kaskada z `tenants`): `name`, `token_hash` (SHA-256,
  jak `ingest_tokens`), `created_by`, `created_at`, `expires_at` (domyślnie 365 dni, albo bez końca),
  `last_used_at`. Polityka `service_tokens_token_read` jak `ingest_tokens_token_read`: żądanie z tokenem widzi
  dokładnie swój wiersz (`app.service_token_hash`), a dalej pracuje w jego tenancie. Token `shps_` + 32 bajty
  base64url, pokazany raz. Najwyżej 10 tokenów na workspace.
- Administrator: `GET/POST/DELETE /tenants/:tenantId/service-tokens[/:tokenId]`, audyt `service_token_created`,
  `service_token_revoked` (nazwa tokenu, nigdy token). Settings → General „Service tokens”: lista, nowy (nazwa,
  ważność), token raz w `SecretBox`, cofnięcie.
- Tokeny są tylko do odczytu, dla całego workspace'u. Wygasły → 401, nieznany → 401 bez szczegółów. Limit żądań per
  token jak przy ingeście (`lib/request-limiter.js`, 429 + `Retry-After`).

## Trasy usług (`Authorization: Bearer shps_…`)
- `GET /api/service/v1/items/:key` → `{ key, title, type, source: 'jira'|'repo', envs: { test, qa, prod }: { status,
  uncertain[], mismatch[] }, firstProdAt, releasedOnProd }`; 404 dla nieznanego klucza. Element: najnowsza
  zsynchronizowana kopia issue z `jira_issues` albo element pracy z repo (`workItemIssues()`).
- `GET /api/service/v1/metrics?from=RRRR-MM-DD&to=RRRR-MM-DD&format=json|csv` → wiersze
  `{ date, deployments, failedDeployments, rollbacks, leadTimeDaysMedian, leadTimeCount }` dla każdego dnia zakresu (dni bez
  danych też, z zerami; mediana pusta). Domyślnie ostatnie 90 dni, najwyżej 400. CSV: nagłówek
  `date,deployments,failed_deployments,rollbacks,lead_time_days_median,lead_time_count`.
- Obliczenia przez prawdziwe `docs/app-*.js` w `vm` (jak `lib/release-status.js` w G1.5), żeby status i lead time
  miały jedną implementację: `issueStatusForEnv()`, `earliestProdDeployedAt()`; rollbacki jak
  `rollbackDriftByMonth()` (`rollback`), ale dziennie i tylko PROD.

## Elementy
`server/migrations/040_service_tokens.sql`, `lib/scope.js` (`RLS_TABLES`, `serviceTokenHash`), `lib/service-api.js`
(tokeny i odczyty), `lib/release-status.js` (wspólny sandbox + `itemStatus()`, `metricsByDay()`),
`routes/service.js` (nowy plugin) i trasy administratora w `routes/tenants.js`, `ERROR_STATUS` w `web.js`,
`lib/audit-log.js` (`AUDIT_EVENT_KINDS`), `server/ui/settings.js` (sekcja i etykiety audytu), dokumentacja (CLAUDE.md,
server/README.md „Service API”, FAQ).

## Testy (najpierw czerwone)
`server/test/service-api.test.js` (node:test): token tworzy tylko admin, pokazany
raz, w bazie tylko hash; cofnięty i wygasły → 401; token jednego workspace'u nie widzi drugiego; status elementu
(issue, CHG, nieznany), metryki (dni, mediana, CSV, zakres > 400 dni → 400, zły format daty → 400); audyt bez tokenu;
limit żądań. Do tego `web-routes-characterization`, `withscope-guard` (28 tabel), `tenant-delete`,
`settings-ui.test.js`.

## Wynik (2026-10-26)
- `server/test/service-api.test.js` 4/4 (najpierw czerwone), cały `npm test` serwera 375/375 na prawdziwym Postgresie,
  testy główne 280/280; zaktualizowane testy przypięte do tras i tabel (`web-routes-characterization` — tylko dopisane
  trasy, `withscope-guard` 28 tabel, `tenant-delete`, `migrate`, `settings-ui`).
- Drift nie wchodzi do szeregu metryk: `tracked_repos.drift` nie ma historii. Szereg ma za to wdrożenia nieudane.
- Dalej w F5: graf śladu i ocena skutku w pdi oraz pasma kontrolne w tf czytają to API.
