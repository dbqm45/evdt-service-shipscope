# Kopie zapasowe bazy i test odtwarzania

Jak chronić bazę ShipScope (Render Postgres, `shipscope-db` w `render.yaml`), jak ją odtworzyć po awarii i jak
regularnie sprawdzać, że to działa. Klucze szyfrujące sekrety klientów opisuje [SEKRETY.pl.md](SEKRETY.pl.md). Bez
kluczy z tamtego czasu odtworzona baza ma nieczytelne tokeny.

## Co daje Render

Stan na październik 2026; sprawdź w [dokumentacji Rendera](https://render.com/docs/postgresql-backups), bo limity się
zmieniają.

| Mechanizm | Co to jest | Jak długo | Uwagi |
|---|---|---|---|
| **Point-in-time recovery (PITR)** | odtworzenie bazy z dowolnej chwili w oknie | 3 dni w workspace'ie Hobby, 7 dni w Pro i wyższych | Tylko płatne bazy (`plan` w `render.yaml` nigdy nie jest `free`). Tworzy **nową** instancję, stara zostaje |
| **Eksport logiczny** | `pg_dump` w formacie katalogu (`.dir.tar.gz`), uruchamiany z panelu (Recovery) | 7 dni u Rendera, potem tylko tam, gdzie go pobierzesz | Przywraca się go `pg_restore` w wersji zgodnej z bazą |
| **Kopia poza Renderem** | Twój własny `pg_dump` w innym miejscu (np. S3) | ile ustawisz | Jedyna ochrona, gdy baza albo konto zostanie usunięte. Render nie gwarantuje kopii usuniętej bazy |

## Ustawienie (raz)

1. **Plan bazy płatny.** W `render.yaml` jest `plan: starter`, a PITR działa od razu. Okno wynosi 3 dni (Hobby). Jeśli
   awaria może zostać zauważona później (weekend, urlop), przejdź na workspace Pro: okno wzrośnie do 7 dni, ale nie
   wstecz.
2. **Kopia poza Renderem.** Wybierz jedno:
   - **Ręcznie, co tydzień:** Render → `shipscope-db` → Recovery → Export. Pobierz plik i trzymaj go w zaszyfrowanym
     miejscu co najmniej 30 dni.
   - **Automatycznie:** cron job z szablonu Rendera „PostgreSQL S3 Backups” (codzienny `pg_dump` do bucketu S3) z
     regułą usuwania po 30–90 dniach. Bucket musi być prywatny i szyfrowany. Kopia zawiera dane klientów (wdrożenia,
     issue z Jiry, flagi), ale tokeny klientów są w niej zaszyfrowane.
3. **Klucze.** `TOKEN_ENCRYPTION_KEY`, `SECRETS_PRIVATE_KEY` i ich poprzednie wersje trzymaj w menedżerze haseł z
   datą wymiany. Kopia sprzed wymiany klucza otwiera się tylko starym kluczem.
4. **Sprawdzaj kopie raz na kwartał** (niżej). Kopia, której nikt nie odtworzył, to tylko nadzieja.

## Odtworzenie po awarii

Typowy powód: ktoś usunął dane, migracja zepsuła tabelę albo trzeba cofnąć stan.

1. **Zatrzymaj zapisy.** Wstrzymaj workera (Render → `shipscope-worker` → Suspend). Serwis web może działać, ale
   zmiany w Settings zrobione w tym czasie przepadną.
2. **Odtwórz.**
   - Z PITR: Render → `shipscope-db` → Recovery → Point-in-time recovery. Wybierz chwilę **przed** awarią (czas UTC).
     Render utworzy nową instancję.
   - Z eksportu albo kopii z S3: utwórz nową bazę w Renderze, rozpakuj plik i uruchom
     `pg_restore --no-owner --no-acl -d "<External URL nowej bazy>" <katalog>`. Wersja `pg_restore` musi odpowiadać
     wersji bazy.
3. **Sprawdź kopię**, zanim cokolwiek na nią przełączysz:

   ```
   RESTORE_DATABASE_URL="<External URL nowej bazy>" \
   TOKEN_ENCRYPTION_KEY=... SECRETS_PUBLIC_KEY=... SECRETS_PRIVATE_KEY=... \
     npm run verify-restore --prefix server
   ```

   Skrypt (`server/scripts/verify-restore.js`) tylko czyta. Sprawdza, że:
   - są wszystkie migracje z bieżącego kodu;
   - każda tabela workspace'ów ma wymuszone RLS;
   - zapisane sekrety otwierają się podanymi kluczami.

   Pokazuje też liczbę workspace'ów i najnowsze dane (ostatnie wdrożenie, zmianę flagi i zmianę ustawień), czyli z
   jakiej chwili jest kopia. Kończy się kodem 1, gdy kopii nie da się użyć. `DATABASE_URL` nigdy nie bierze, więc nie
   da się nim przypadkiem sprawdzić bazy produkcyjnej.
4. **Przełącz serwisy.** W obu serwisach (web i worker) ustaw `DATABASE_URL` na Internal URL nowej bazy. Potem w
   osobnym PR zmień w `render.yaml` nazwę bazy w `databases` i obu `fromDatabase` na nową instancję, żeby następna
   synchronizacja blueprintu nie wróciła do starej. Wdrożenie uruchomi migracje (`preDeployCommand`); te, których
   kopia nie ma, dojdą same.
5. **Wznów workera.** Synchronizacje GitHuba i Jiry same dociągną to, co działo się od chwili kopii. Flagi wysyłane
   z zewnątrz wrócą przy następnej wysyłce. Zmiany ustawień i zaproszenia z tego okresu trzeba powtórzyć ręcznie;
   ich listę w starej bazie pokazuje Settings → General → „Settings activity”.
6. **Starą instancję** zostaw na kilka dni do porównań, potem ją usuń.

## Test odtwarzania (raz na kwartał)

Ten sam przebieg co wyżej, ale bez przełączania i bez wstrzymywania workera:

1. PITR do chwili sprzed godziny → nowa instancja `shipscope-db-restore-test`.
2. `npm run verify-restore` z kluczami, jak w kroku 3. Oczekiwany wynik to `✓ The copy is usable.`, a pokazane liczby
   workspace'ów i wdrożeń powinny być zbliżone do produkcji.
3. To samo z ostatnią kopią spoza Rendera (eksport albo S3): `pg_restore` do nowej, pustej bazy, potem
   `verify-restore`.
4. Usuń obie testowe instancje. Zapisz w issue lub w kalendarzu datę testu, wynik i czas trwania.

Gdy skrypt zgłasza:

| Komunikat | Co znaczy | Co zrobić |
|---|---|---|
| `migrations not applied: …` | kopia jest starsza niż kod | Normalne dla starej kopii; wdrożenie doda brakujące migracje |
| `migrations this checkout does not have` | kod jest starszy niż kopia | Uruchom skrypt z nowszego checkoutu |
| `table … is not under forced row-level security` | odtworzenie pominęło polityki RLS (np. `pg_restore` z filtrem) | Odtwórz bez wyłączania polityk; takiej kopii nie podłączaj |
| `stored secret(s) do not open with the keys given` | klucze z innego okresu niż kopia | Podaj klucze z tamtego czasu (także `…_PREVIOUS`) |
| `not tried` | nie podano kluczy | Powtórz z kluczami |
