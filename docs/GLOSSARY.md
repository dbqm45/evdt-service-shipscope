# Glosariusz

Jedno miejsce, jedna definicja. Projekt ma dziś dwa równoległe konteksty (synchronizacja plikowa i backend
SaaS), które czasem nazywają to samo pojęcie inaczej, albo nazywają dwa różne pojęcia tym samym słowem —
zob. `design-docs/REPORT_ARCH.md`, sekcja II.5. Ten plik jest jedynym miejscem, gdzie to rozróżnienie jest
spisane raz, zamiast wnioskowane z prozy `CLAUDE.md` przy każdej okazji.

| Pojęcie | Definicja (jedno zdanie) | Kontekst plikowy | Kontekst SaaS | UI |
|---|---|---|---|---|
| **Component / Tracked repo** | Jeden śledzony repozytorium/serwis, dla którego ShipScope zbiera deploymenty, flagi i (opcjonalnie) Jirę. | `component` (`docs/components.json`, zmienna `COMPONENT` w każdym skrypcie, `orderedComponents()`) | `tracked_repos` (tabela), `repo_id` | „Component” w macierzy komponent×środowisko (Technical view) |
| **PI / Increment** | Okres planowania, do którego przypisane jest zadanie Jiry i jego sprint; nie każdy najemca używa SAFe, więc serwer uogólnił to pojęcie. | `pi` (shard `docs/data/jira-issues/{PI}.json`, `index.json`'s `currentPi`) | `increment` wewnętrznie (`rhythmOf()`, `piOfSprint()`, `currentPiOf()`, `previousPiOf()`, `comparePiDesc()` w `jira-model.js`); kontrakt zewnętrzny (`dashboard-data`) wciąż mówi `pi`/`currentPi` | Selektor „PI” w nagłówku dashboardu |
| **Rhythm** | Sposób, w jaki board Jiry wyznacza granice increment-u: `pi` (SAFe), `sprint`, `release` (fixVersion), `flow` (miesiąc kalendarzowy), `auto` (wybrane automatycznie). | — (brak odpowiednika; sync plikowy zakłada zawsze `pi`) | `jira_boards.rhythm`, `rhythmOf()` w `jira-model.js` | ustawienie boardu w panelu Jira (`PUT /tenants/:id/jira/boards/:boardId`) |
| **Source (nadawca) / Slot** | **Nadawca** to konkretny wysyłający stan flag (nazwa, priorytet, opcjonalny komponent). **Slot** to jedna z dwóch szufladek na stan flagi: `build` albo `runtime-be`. To dwa różne pojęcia — nie mylić. | `flagsMeta[key].source` = slot (`'build'` / `'runtime-be'`) | `flag_sources` (tabela) = nadawca; kolumna `kind`; `slot: s.kind === 'runtime' ? 'runtime-be' : 'build'` (`flags.js`) | „Build” / „Runtime” w panelu flag |
| **Enabled / State** | **State** to rzeczywisty trójstanowy status flagi (`off`/`on`/`partial`) plus `rollout` (0-100%). **Enabled** to wniosek z niego (`state !== 'off'`), nie fakt — flaga `partial` z rolloutem 10% ma `enabled: true`. | `flag-states.json`: tylko boolean `enabled` (kontrakt v1) | `flag_values.state` + `rollout` (kontrakt v2); `enabled` w odpowiedzi dashboardu jest wyliczany (`flags.js:449`) | pigułka statusu flagi (zielona/szara/częściowa) |
| **Drift** | Czy dwa środowiska różnią się realnie w plikach repozytorium (porównanie drzewa git), nie w liczbie commitów — commit-count to tylko kontekst, bo merge/squash/branch mnożą commity bez zmiany treści. | `driftBehind`, `compareTrees()` w `scripts/lib/tree-diff.js` | ten sam algorytm, port w `server/lib/tree-diff.js` (dziś rozjechany — zob. `REPORT_ARCH.md` Problem 3) | przycisk „Diff to ENV” + modal driftu w Technical view |
| **Status wydania** (`none` / `deployed` / `released` / `partial` / `deployed_code_only`) | `none` = nic nie wdrożono; `deployed` = kod wdrożony, flaga wyłączona; `released` = kod wdrożony, flaga włączona; `partial` = flaga włączona z rolloutem < 100%; `deployed_code_only` = kod wdrożony, nie ma żadnej flagi do sprawdzenia. „Deployed” ≠ „done” — to świadome rozróżnienie. | `effectiveFlagState()`, `prodStatusBucket()`, `issueIsReleasedToProd()` w `docs/app-model.js`/`app-core.js` | `lib/flags.js`, `lib/deployment-logic.js` | pigułka statusu w Product view + Release Notes + macierz Technical view (z tooltipem `statusLabelTooltip()`) |
| **Rollback** | Deployment, który — po porównaniu z poprzednim na tym samym środowisku — okazał się być commitem *wcześniejszym* w historii (`status: "behind"` w GitHub compare), czyli środowisko wróciło do tyłu. | `rollback: { toRef }` w `deployments.json` | `lib/deployment-sync.js` (ten sam algorytm, port z `scripts/sync-github-deployments.js`) | odznaka „Rollback” na karcie deploymentu |
| **Ingest token** | Token uwierzytelniający jeden konkretny nadawca (`flag source`) przy wysyłce stanu flag do `POST /api/flags/ingest` — nie to samo, co sesja użytkownika. | — (sync plikowy nie ma tokenów nadawców; każdy skrypt ma własny sekret per repo) | `ingest_tokens` (tabela), `createIngestToken()`/`revokeIngestToken()` w `flags.js` | „Tokens” w ustawieniach źródła flagi (`server/ui/settings.js`) |

## Jak dodawać wpis

Nowy wpis dopisujesz tutaj, gdy zauważysz, że jedno pojęcie ma więcej niż jedną nazwę w kodzie (plikowy
kontekst / SaaS / UI), albo gdy jedno słowo znaczy w kodzie dwie różne rzeczy — tak jak `source` powyżej.
Nie kopiuj tu definicji z `CLAUDE.md` dla pojęć, które mają tam już jedną, spójną nazwę wszędzie — ten plik
jest tylko dla rozjazdów, nie dla powtórzenia całej domeny.
