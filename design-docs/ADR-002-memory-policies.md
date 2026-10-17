# ADR-002: Trzy polityki pamięci ShipScope — nazwane jako jedna decyzja

- **Status**: przyjęta (opisuje zachowanie, które już istnieje; ten ADR tylko nazywa je jako jedną decyzję —
  zob. `design-docs/REPORT_ARCH.md`, II.3, „Zdarzenia domenowe" i Pytanie otwarte 4)

## Kontekst

ShipScope modeluje trzy różne rodzaje zdarzeń domenowych: zmianę stanu flagi, deployment, i stan zadania
Jiry. Pytanie "czy ShipScope pamięta X" ma dziś **trzy różne odpowiedzi** zależnie od tego, czym jest X —
każda osobno uzasadniona i udokumentowana w kodzie, ale nigdzie nazwana jako jedna, świadoma decyzja
produktowa. Ten ADR spisuje te trzy polityki w jednym miejscu, żeby nowa funkcja domenowa (czwarty rodzaj
zdarzenia) miała od czego zacząć, zamiast wymyślać czwartą politykę przez przypadek.

## Decyzja

| Dziedzina | Polityka | Mechanizm | Konsekwencja |
|---|---|---|---|
| **Flagi** | Pełny log zdarzeń, **bez retencji** — wszystko na zawsze | `flag_value_history` (append-only), `scripts/lib/flag-history.js` po stronie plikowej | Pamięta każdą zmianę, jaka kiedykolwiek zaszła. Odpowiedź dashboardu rośnie liniowo z liczbą przełączeń w historii najemcy, bez górnego ograniczenia (`readDashboardFlags()` czyta całą historię bez okna czasowego — zob. Pytanie otwarte 4 niżej). |
| **Deploymenty** | Snapshot + **retencja** (`deployment_retention_days`, 7-730 dni) + dwa wieczne, nigdy-nietrymowane companion-pliki/kolumny | `trimOldRecords()` (plikowo) / `server/lib/retention.js` (SQL `DELETE`); `deployments-cursor.json`/kursor ID; `issue-deployments.json`/`issue_deployments` | Zapomina *szczegóły* starych deploymentów, ale pamięta *fakty*, które muszą przeżyć retencję: "co jest teraz" (najnowszy i najnowszy udany rekord per komponent/env, zawsze zachowywane niezależnie od wieku) i "czy to kiedykolwiek pojechało" (per issue/env/komponent, raz zapisane, nigdy usuwane). |
| **Zadania Jiry** | **Pełna podmiana** bieżącego increment-u przy każdym sync'u; starsze increment-y jako snapshoty | `writePiShards()` (plikowo, scope `'full'`/`'partial'`/`'partial-merge'`) / `server/lib/jira-sync.js`'s `syncTenantUnrecorded()` ("Full replace: what this board no longer has in this PI is gone from it") | Bieżący increment jest zawsze dokładnym odbiciem stanu w Jirze teraz. Starsze increment-y **nie są
automatycznie odświeżane** — to, co jest zapisane, jest tym, co było widziane przy ostatnim sync'u tego
increment-u (plikowo: `BACKFILL_PIS`; serwerowo: ten increment przestaje być "current" i nie jest już
re-syncowany). |

Te trzy polityki **nie są błędem** — każda odpowiada realnej różnicy w naturze danych: flaga ma mało
zdarzeń ale każde jest cenne (audyt "kto, kiedy, co"); deployment ma dużo zdarzeń ale stare szczegóły tracą
wartość szybko; zadanie Jiry ma jeden, zawsze-aktualny stan "teraz" bez potrzeby audytu historii zmian
statusu. Decyzją jest **nazwanie** tego zróżnicowania, nie jego usunięcie.

## Rozważane opcje

- **Jedna uniwersalna polityka retencji dla wszystkiego** — odrzucona. Flagi mają mało zdarzeń ale duże
  znaczenie dowodowe (kto zmienił co i kiedy) — retencja by to niszczyła. Deploymenty mają dużo zdarzeń o
  szybko spadającej wartości — pełny log rosłby bez końca bez proporcjonalnej korzyści. Jedna polityka
  musiałaby być kompromisem gorszym niż każda z trzech dla jej własnej dziedziny.
- **Pełny log zdarzeń także dla deploymentów i issues Jiry** (symetria z flagami) — odrzucona jako
  nieopłacalna: GitHub i Jira już są systemami źródłowymi prawdy dla własnej historii (deploymentów,
  statusów); ShipScope deklaruje się jako "pokazuje stan bieżący, nie archiwum" (`CLAUDE.md`, sekcja
  "Deployments").

## Konsekwencje

- Przyszła funkcja domenowa (np. nowy rodzaj śledzonego zdarzenia) powinna wybrać jedną z tych trzech
  polityk *świadomie*, z uzasadnieniem tego wyboru — nie przez domyślne skopiowanie wzorca z sąsiedniego
  pliku.
- **Pytanie otwarte 4** (`design-docs/REPORT_ARCH.md`): czy historia flag ma zostać pełnym logiem na
  zawsze, czy potrzebuje okna czasowego/limitu, zanim odpowiedź dashboardu (`readDashboardFlags()`) zacznie
  realnie rosnąć wraz z wiekiem najemcy. To decyzja produktowa (jak długo historia flag ma wartość
  biznesową), nie techniczna — rekomendacja z Problemu 2 (`design-docs/REPORT_ARCH.md`, priorytet J) czeka na
  nią.
