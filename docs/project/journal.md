---
artifact: journal
phase: meta
status: accepted
version: 1
author: system
created: 2026-10-15
updated: 2026-10-15
inputs: []
---
# Dziennik projektu
<!-- Tylko dopisywanie. Najłatwiej: py .claude/hooks/project_record.py log --by <kto> --phase <faza> "<co i dlaczego>" -->

| Kiedy | Kto | Faza | Zdarzenie |
|---|---|---|---|
| 2026-10-15 09:57 | maja | delivery | Checkpoint: wydzielono komponenty do docs/app-components.js (widoki przepięte, 395 testów OK, CHANGELOG/CLAUDE.md zaktualizowane, bez commita). Następne: zamiana stringów 'prod'/'FE'/'BE' na enumy (ENVIRONMENT.PROD itd.) — nie rozpoczęte. |
| 2026-10-15 09:57 | system | meta | Utworzono dziennik projektu (docs/project/) |
| 2026-10-15 09:57 | maja | delivery | Checkpoint: komponenty w docs/app-components.js gotowe (widoki przepiete, 395 testow OK, CHANGELOG/CLAUDE.md zaktualizowane, bez commita). Nastepne: zamiana stringow 'prod'/'FE'/'BE' na enumy (ENVIRONMENT.PROD) - nie rozpoczete. |
| 2026-10-15 19:02 | claude | delivery | Uporządkowanie po rebase/PR: szkielet backendu (web.js/worker.js/lib/db.js/render.yaml) zginął na main (revert e19c991 + squash #3), Server tests czerwony. Przywrócony revertem reverta; server 15/15 na realnym Postgresie, root 419/419. PR #4 zbędny (treść = zmergowany #5). Następne: auth dla HTTP (FR-001 lub tymczasowy auth) — decyzja użytkownika. |
| 2026-10-16 13:52 | claude | delivery | FR-001: logowanie przez GitHub App (Fastify, sesje w Postgresie — tylko hash tokenu, token GitHuba niezapisywany), POST /tenants, GET /tenants/:id/members, /me. RLS zaostrzone (migracja 002: zapis tylko w zakresie tenanta, self-read), scope przez set_config(..., true) w transakcji. Server 44/44 na realnym Postgresie, root 419/419. Następne: zaproszenia członków przez HTTP (FR-003) i instalacja GitHub App na repo. |
| 2026-10-16 14:07 | claude | delivery | FR-003: zaproszenia linkiem (token jednorazowy, hash w bazie, 7 dni, RLS po tenancie + odczyt po hashu tokenu), akceptacja atomowa, odwoływanie, usuwanie członków z blokadą ostatniego admina, powrót po logowaniu z allowlistą. Server 57/57 na Postgresie, 4 mutacje zabezpieczeń wykryte. Pierwsze wydanie v0.1.0 otagowane automatycznie. |
| 2026-10-16 14:15 | claude | delivery | FR-004/FR-006: podłączenie GitHub App do tenanta (weryfikacja dostępu do instalacji tokenem użytkownika, nie z installation_id z przekierowania), wybór śledzonych repo, odłączanie. JWT RS256 przez node:crypto, tokeny instalacji nieprzechowywane. Server 73/73 na Postgresie, 5 mutacji wykrytych. v0.1.1 wydane automatycznie. Następne: FR-005 (ingest deploymentów z repo). |
| 2026-10-16 14:37 | claude | delivery | FR-005: worker synchronizuje deploymenty śledzonych repo do bazy (port reguł z sync-github-deployments: kursor, pending/stuck, inactive, zakres commitów → issue, rollback, redeploy tej samej wersji), retencja per tenant (domyślnie 90 dni, 7–730) z codziennym czyszczeniem, blokady advisory. Decyzja: krótka historia + auto-cleanup zamiast pełnego archiwum (użytkownik jeszcze to przemyśli). Server 89/89, 7 mutacji wykrytych. |
| 2026-10-16 16:41 | claude | delivery | Dashboard z bazy: serwer udostępnia docs/ pod /t/<tenantId>/ (allowlista plików), app-data.js w tym trybie bierze dane z /api/tenants/:id/dashboard-data w kształcie data/*.json — widoki bez zmian, bez frameworka (decyzja odłożona do ekranów ustawień). Zweryfikowane w Chromium (zrzut). Luki: drift nieprzeniesiony (kafelek 'in sync' bez danych), flagi i Jira puste. |
