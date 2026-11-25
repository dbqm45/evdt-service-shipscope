# Logowanie przez tożsamość suity (DI Identity) — plan

Stan: 2026-11-25, decyzje 1–5 przyjęte przez właściciela; krok 1 zrobiony (#138), krok 2 rozpisany niżej (do zatwierdzenia), krok 3 czeka. Krok 3 przejścia aplikacji w ADR 17 §3
(`dbqm45/pdi` `docs/17-tozsamosc-suity.md`): „logowanie OIDC zamiast OAuth GitHub; najemca z organizacji; aplikacja
GitHub zostaje do czytania repozytoriów i wdrożeń”. Wcześniej przeszły DI Release Control (`evdt-shipscope-flags`
0.7.6) i DI Definition (`ci_for_sdlc` 0.1.72, `docs/SUITE-LOGIN-PLAN.md` — ten sam wzór).

## Co dziś wiąże logowanie z GitHubem

- `users` ma `github_user_id NOT NULL` (unikalny) i `github_login NOT NULL`; `githubLogin` pokazują ustawienia,
  członkowie, dziennik zmian i `GET /me` (32 miejsca w `lib/` i `routes/`).
- Połączenie instalacji GitHub App (FR-004) kończy się w callbacku logowania: instalacja jest łączona dopiero, gdy
  **token tej osoby** potwierdzi dostęp (`userCanAccessInstallation()`), więc logowanie GitHub nie może po prostu zniknąć.
- Role w najemcy: `admin` i `member`. Zaproszenia (`lib/invitations.js`) i strażnik ostatniego admina.

## Co daje token suity

ID token klienta `di-release` (Keycloak 26.4.7, realm z `di-identity` 0.1.3): `sub`, `name`, `preferred_username`,
`organization` (aliasy), `resource_access.di-release.roles` (`viewer`, `editor`, `admin`); bez e-maila (DI3).

## Decyzje do potwierdzenia (rekomendacja w każdej)

1. **Obok GitHuba, nie zamiast — na ten krok.** „Log in with the suite” obok „Sign in with GitHub”. Rekomendacja:
   tak. Powód: łączenie instalacji wymaga tokenu GitHub tej osoby; zastąpienie logowania wymaga osobnego „połącz konto
   GitHub” bez zmiany sesji (krok 2 poniżej). Odpowiada to temu, co zrobiły DI Release Control i DI Definition.
2. **Najemca ↔ organizacja suity:** kolumna `tenants.suite_organization` (alias, unikalna), ustawiana przez admina
   najemcy w Ustawieniach (audyt `suite_organization_changed`). Rekomendacja: tak — wielu najemców, więc nie zmienna
   środowiskowa jak w DI Definition.
3. **Role:** `admin` → admin, `editor` i `viewer` → member (DI Release nie ma roli tylko do odczytu). Rekomendacja:
   tak; rola tylko do odczytu — osobna decyzja produktowa.
4. **Członkostwo z tokenu przy każdym logowaniu** w każdym najemcy powiązanym z organizacją z tokenu: dodane albo
   zmienione na rolę z tokenu; członkostwo osoby suity w powiązanym najemcy, którego organizacji już nie ma w tokenie
   albo bez roli — usunięte. Strażnik ostatniego admina dalej obowiązuje: ostatni admin nie jest usuwany ani
   obniżany automatycznie (zostaje, z wpisem w logu). Rekomendacja: tak.
5. **Osoba suity to osobny użytkownik:** migracja `051`: `users.github_user_id` i `github_login` dopuszczają NULL,
   nowe `suite_sub` (unikalne) i `display_name`, `CHECK (github_user_id IS NOT NULL OR suite_sub IS NOT NULL)`;
   wyświetlana nazwa = `github_login` albo `display_name`. Połączenie z kontem GitHub tej samej osoby — z krokiem 2.
   Rekomendacja: tak.

## Kroki

1. **Logowanie suity** (decyzje 1–5): `lib/suite-oidc.js` (kod z PKCE, `state`, `nonce`, ID token RS256 z JWKS
   wystawcy na `node:crypto`, jak `lib/github-oidc.js`), trasy `/auth/suite/login` i `/auth/suite/callback`,
   migracja `051`, pole w Ustawieniach → General, przycisk na stronie logowania, `SUITE_ISSUER`, `SUITE_CLIENT_ID`
   (domyślnie `di-release`), `SUITE_CLIENT_SECRET`. Testy z fałszywym wystawcą jak w `test/github-oidc.test.js`.
2. **„Połącz konto GitHub”** dla osoby zalogowanej przez suitę: autoryzacja GitHub tylko po token do sprawdzenia
   instalacji, bez zmiany sesji; potem łączenie instalacji działa bez logowania GitHub.
3. **Wyłączenie logowania GitHub** w najemcy powiązanym z suitą (ustawienie admina) — dopiero po 1–2.

## Krok 2 — szczegóły (2026-11-25, do zatwierdzenia)

**Dziś osoba suity nie połączy instalacji.** `/github/setup` wysyła ją po świeży token GitHub
(`/auth/github/login`). Callback robi z tego logowanie: tworzy albo aktualizuje użytkownika GitHub i **zastępuje
sesję suity jego sesją**. `linkInstallation` sprawdza potem, czy ten użytkownik GitHub jest adminem najemcy. Zwykle
nie jest, więc kończy się na `403`, a osoba zostaje wylogowana z suity.

Decyzje (rekomendacja w każdej):

1. **Weryfikacja instalacji nie zmienia sesji.** Gdy callback GitHub ma oczekujące łączenie (`gh_link`) i w
   przeglądarce jest ważna sesja:
   - token GitHub służy tylko do `userCanAccessInstallation()`;
   - łączy admin z sesji (`actorUserId`, audyt `github_linked` na niego);
   - sesja zostaje ta sama;
   - token nie jest nigdzie zapisywany (jak dziś).

   Bez sesji (wygasła między instalacją a powrotem) zostaje dzisiejsze zachowanie. Dotyczy tak samo osób
   zalogowanych przez GitHub, dla których nic się nie zmienia, bo i tak łączyli sami. Rekomendacja: tak.
2. **Bez zapisywania konta GitHub przy osobie suity:** `users.github_user_id` osoby suity zostaje NULL. Połączenie
   kont (ta sama osoba z kontem GitHub i kontem suity, scalenie członkostw) to osobna decyzja, razem z krokiem 3.
   Rekomendacja: tak.
3. **Bez osobnego przycisku „Połącz konto GitHub”:** weryfikacja jest częścią „Connect GitHub” w Ustawieniach →
   GitHub. GitHub pyta o autoryzację tylko za pierwszym razem, potem wraca od razu. Rekomendacja: tak.

Testy: osoba suity (admin najemcy) instaluje App, a instalacja zostaje połączona z nią jako autorem, z tą samą
sesją. Do tego: token GitHub bez dostępu do instalacji daje `403` i sesja zostaje; bez sesji jest dzisiejsze
zachowanie; osoba suity, która nie jest adminem, nie dochodzi do `/auth/github/login`.

## Ryzyka

- Najemca powiązany z organizacją, której członkowie dostają rolę `admin` w suicie, przejmuje się bez zaproszenia:
  powiązanie ustawia tylko admin najemcy, a audyt to zapisuje.
- Członkostwo osoby suity zmienia się dopiero przy jej logowaniu (sesja do wygaśnięcia ma starą rolę), jak w DI
  Release Control i DI Definition.
