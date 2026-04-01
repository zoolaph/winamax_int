# Solution: Exercise 2 — PromQL for the Four Golden Signals

---

## 1. Requests per second for betting-api

```promql
sum(rate(http_requests_total{service="betting-api"}[5m]))
```

Why `sum`: there may be multiple instances of betting-api. Sum aggregates across all instances.
Why `rate()`: http_requests_total is a counter; rate() gives per-second rate.
Why `[5m]`: 5-minute window smooths out noise while staying responsive.

---

## 2. Error ratio (5xx / total) for betting-api

```promql
sum(rate(http_requests_total{service="betting-api", status=~"5.."}[5m]))
/
sum(rate(http_requests_total{service="betting-api"}[5m]))
```

As a percentage:
```promql
(
  sum(rate(http_requests_total{service="betting-api", status=~"5.."}[5m]))
  /
  sum(rate(http_requests_total{service="betting-api"}[5m]))
) * 100
```

The `status=~"5.."` is a regex match: any status code starting with 5.

---

## 3. P99 latency for POST /api/bet/place

```promql
histogram_quantile(0.99,
  sum(
    rate(http_request_duration_seconds_bucket{
      service="betting-api",
      route="/api/bet/place",
      method="POST"
    }[5m])
  ) by (le)
)
```

Critical detail: `by (le)` is REQUIRED. `le` is the bucket boundary label. Without it, histogram_quantile cannot compute quantiles.

In seconds. To display in milliseconds: multiply by 1000.

---

## 4. Connection pool saturation

```promql
db_connection_pool_active{service="betting-api"}
/
db_connection_pool_max{service="betting-api"}
```

As a percentage:
```promql
(
  db_connection_pool_active{service="betting-api"}
  /
  db_connection_pool_max{service="betting-api"}
) * 100
```

Alert threshold: > 80% means you are approaching exhaustion.

---

## 5. Kafka consumer lag alert

Alert when any single partition exceeds 100,000 messages lag:

```promql
max(kafka_consumer_lag{consumer_group="betting-consumers"}) by (topic, partition) > 100000
```

Or as an alerting rule:
```yaml
- alert: BettingKafkaConsumerLagCritical
  expr: |
    max(kafka_consumer_lag{consumer_group="betting-consumers"}) by (topic, partition) > 100000
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Kafka lag critical: {{ $labels.topic }}/{{ $labels.partition }} has {{ $value }} messages backlog"
```

Why `max` not `sum`: you care if ANY single partition is far behind, not the total across all partitions. A single slow partition means certain keys/events are delayed.

---

## 6. Recording rule for error ratio per service

```yaml
groups:
  - name: winamax_precomputed
    interval: 30s
    rules:
      - record: service:http_error_ratio:rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
          /
          sum(rate(http_requests_total[5m])) by (service)
```

Now dashboards and alerts use `service:http_error_ratio:rate5m` — the query runs once on the Prometheus server and is stored as a time series.

Naming convention: `<level>:<metric>:<operation>` — this is the standard Prometheus recording rule naming convention.
