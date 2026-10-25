# SLO i strona statusu

Co ShipScope obiecuje swoim użytkownikom, jak to mierzymy i co robimy, gdy cel jest zagrożony. Metryki opisuje
[README.md](README.md) („Monitoring and logs”, „Metrics”), a kopie zapasowe [KOPIE.pl.md](KOPIE.pl.md).

## Cele (okno 30 dni)

| SLI | Jak mierzony | Cel | Budżet błędów w 30 dniach |
|---|---|---|---|
| **Dostępność** serwisu web | odsetek odpowiedzi bez 5xx: `shipscope_http_responses_total`, a niezależnie zewnętrzny monitor `GET /health` co minutę | 99,5% | ok. 3 h 36 min |
| **Aktualność danych** | odsetek minut, w których worker działa: strona statusu, składnik „Background worker” (degraded liczy się jako działa) | 99% | ok. 7 h 12 min |
| **Synchronizacja GitHuba i Jiry** | odsetek minut bez awarii składników „GitHub deployments” i „Jira issues” | 99% | ok. 7 h 12 min |
| **Przyjęcie flag** | `accepted / (accepted + busy + error)` z `shipscope_flag_ingest_messages_total` (odmowy 400/401/403/429 to błędy nadawcy, nie nasze) | 99,9% | 1 na 1000 wiadomości |

Cele są celowo skromne: jedna instancja web, jeden worker i jedna baza na Renderze. Wyższe wymagałyby kilku
instancji (ROADMAP, „Skalowanie workera”). Nie obiecujemy czasu reakcji poza godzinami pracy.

## Strona statusu

- **`/status`**: publiczna strona HTML (bez skryptów i bez danych klientów). Pokazuje stan teraz i pasek 90 dni dla
  każdego składnika:
  - Background worker;
  - GitHub deployments;
  - Jira issues;
  - Feature flags from endpoints;
  - Webhook processing.

  Pokazuje tylko składniki, które dany serwer ma włączone.
- **`/status.json`**: to samo dla automatów: `status`, a dla każdego składnika `status`, `uptime` i `days`.
- **Skąd dane:** serwis web co minutę ocenia workera (`judgeWorker()`, te same reguły co `/health/worker`) i
  zapisuje wynik w `status_samples` (migracja 035, liczniki na dzień, 120 dni).
- **Ocena dnia:**
  - **awaria**, gdy ponad 1% próbek to `down`;
  - **degraded**, gdy jakaś próbka nie była ok;
  - **operational**, gdy wszystkie były ok;
  - **brak danych**, gdy próbek nie ma.
- **Czego strona nie pokazuje:** czy sam serwis web działa. Jeśli strona się nie ładuje, to już jest odpowiedź. Do
  tego potrzebny jest zewnętrzny monitor (niżej).

Link do `/status` daj klientom (np. w stopce maila powitalnego). Strona nie zbiera e-maili ani nie wysyła
powiadomień. Jeśli będą potrzebne, podłącz zewnętrzny serwis statusu (Better Stack, Instatus i podobne) do
`/status.json`.

## Monitorowanie i alerty

**Zewnętrzny monitor** (Better Stack, UptimeRobot i podobne), co 1 minutę:

| Adres | Alert, gdy |
|---|---|
| `https://<web>/health` | odpowiedź inna niż 200 przez 3 minuty: serwis web nie działa |
| `https://<web>/health/worker` | 503 przez 5 minut: worker stoi albo synchronizacja nie wychodzi |
| `https://<web>/status.json` | `"status"` różny od `"operational"` przez 30 minut |

**Prometheus** (z `METRICS_TOKEN`): alerty na tempo spalania budżetu. Szybkie spalanie oznacza, że przy tym tempie
cały miesięczny budżet zniknie w ok. 2 dni, wolne – w ok. 5 dni.

```yaml
groups:
  - name: shipscope-slo
    rules:
      - alert: ShipScopeErrorsFastBurn        # dostępność 99,5%: 14,4 × 0,5% w 1 h i w 5 min
        expr: |
          (sum(rate(shipscope_http_responses_total{status_class="5xx"}[1h])) / sum(rate(shipscope_http_responses_total[1h])) > 0.072)
          and
          (sum(rate(shipscope_http_responses_total{status_class="5xx"}[5m])) / sum(rate(shipscope_http_responses_total[5m])) > 0.072)
        labels: { severity: page }
      - alert: ShipScopeErrorsSlowBurn        # 6 × 0,5% w 6 h i w 30 min
        expr: |
          (sum(rate(shipscope_http_responses_total{status_class="5xx"}[6h])) / sum(rate(shipscope_http_responses_total[6h])) > 0.03)
          and
          (sum(rate(shipscope_http_responses_total{status_class="5xx"}[30m])) / sum(rate(shipscope_http_responses_total[30m])) > 0.03)
        labels: { severity: ticket }
      - alert: ShipScopeSyncStale             # synchronizacja wdrożeń nie wyszła od 3 interwałów (15 min) + 5 min
        expr: time() - shipscope_worker_job_last_success_timestamp_seconds{job="deployments"} > 3000
        labels: { severity: page }
      - alert: ShipScopeIngestFailing         # przyjęcie flag 99,9%
        expr: |
          sum(rate(shipscope_flag_ingest_messages_total{outcome=~"busy|error"}[1h]))
          / sum(rate(shipscope_flag_ingest_messages_total{outcome=~"accepted|busy|error"}[1h])) > 0.0144
        labels: { severity: ticket }
      - alert: ShipScopeFlagSourcesFailing    # źródła flag klientów: to nie nasz SLO, ale warto wiedzieć
        expr: shipscope_flag_source_environments{state="error"} > 0
        for: 6h
        labels: { severity: info }
```

## Budżet błędów: co robimy

| Zużyty budżet (30 dni) | Postępowanie |
|---|---|
| poniżej 50% | normalna praca |
| 50–100% | najpierw poprawki niezawodności z ostatnich incydentów, potem nowe funkcje; wdrożenia w godzinach pracy |
| ponad 100% | tylko poprawki i wycofania, dopóki budżet nie wróci poniżej 100% |

Stan budżetu odczytasz z Prometheusa, a dla aktualności danych z uptime na `/status`.

## Gdy coś się psuje

1. Zobacz `/status` i `/health/worker`: który składnik i od kiedy.
2. Logi serwisów na Renderze (Logs). Szukaj `level: error` i pola `job`. Wskazówki są w README, „Monitoring and logs”.
3. Typowe przyczyny:
   - worker stoi: restart serwisu;
   - limit zapytań GitHuba lub Jiry: pole `rate_limited_until`, samo minie;
   - wygasła instalacja albo token: komunikat w Settings klienta;
   - baza: KOPIE.pl.md.
4. Po incydencie: krótki opis (co, od kiedy do kiedy, ile budżetu zużył, co zmieniamy), żeby się nie powtórzyło.
