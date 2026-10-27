# Uproszczenie rdzenia (krok 4 z „ShipScope bez pdi i z pdi”)

Stan: 2026-10-27. Dokument decyzji: https://claude.ai/artifact/JScDm4HD95kfpboNnyTzsr; kroki 1–3 to #115, #116
i dbqm45/pdi#32. Warstwa pdi już się chowa; teraz rdzeń ma być prosty dla kogoś, kto pdi nie ma.

## Co
1. **Jedna polecana ścieżka flag** (D1). Na stronie Sources pierwszy jest formularz „Add a source that sends its
   flags” (token albo OIDC z GitHub Actions). Czytanie z kodu i z endpointu (z wyszukiwaniem plików, podglądem,
   sekretem podpisu) przechodzi do zwiniętej sekcji „Advanced sources”. Sekcja jest rozwinięta, gdy workspace ma już
   takie źródło albo admin jest w trakcie kreatora lub testu endpointu. Istniejące źródła zostają na liście bez zmian.
   Karta repo w GitHub (Find flags files / Read from code) zostaje, bo admin tam wchodzi celowo.
2. **Getting started** w kroku flag poleca tę samą ścieżkę: źródło z tokenem i adapter w pipeline'ie, a flagi
   z kodu lub z endpointu jako „Advanced sources”.
3. **Insights jako ustawienie workspace'u** (D2). Migracja `046`: `tenants.insights_enabled` (domyślnie wyłączone).
   `GET/PUT …/settings` przyjmuje `insightsEnabled` (admin, wpis `insights_changed` w aktywności); każde pole
   ustawień jest opcjonalne, ale przynajmniej jedno wymagane. Dane dashboardu dostają `capabilities.insights`.
   Zakładka Insights pokazuje się, gdy ustawienie jest włączone albo adres ma `?insights=1` (podgląd, także dla
   `FALLBACK`). Settings → General: przełącznik pod retencją.
4. **ONBOARDING.md**: na początku krótka ścieżka (GitHub, Jira, źródło z tokenem), reszta jako dodatki.
5. **CLAUDE.md** i dokument „Flagi w ShipScope” opisują nowy układ.

Poza tym PR-em: podpowiedź „widzimy `docs/project/changes`, połącz pdi” (wariant D). Bez połączenia worker nie
czyta już folderu zmian, więc podpowiedź wymagałaby osobnego, taniego sprawdzenia w synchronizacji; wróci osobno,
jeśli będzie potrzebna.

## Testy (najpierw czerwone)
`settings-ui.test.js`: formularz z tokenem przed sekcją zaawansowaną, sekcja zwinięta bez takich źródeł i rozwinięta
z nimi lub w kreatorze; krok flag w Getting started; przełącznik Insights. `server/test/insights-setting.test.js`:
ustawienie przez trasę (admin, członek 403, pusta treść 400), wpis w aktywności, `capabilities.insights` w danych
dashboardu. Root: zakładka Insights z `capabilities.insights` i z `?insights=1`, bez nich ukryta.
