# Prometheus Deep — Scraping, PromQL, Alerting Rules

You already know Prometheus from K8s. This file covers the gaps: the scraping model in non-K8s environments (ECS), PromQL for SLO alerting, and recording rules for efficiency.

---

## The pull model — why it matters in ECS

Prometheus **scrapes** targets. Targets do not push to Prometheus. This seems like a detail, but it changes everything about service discovery.

```
In K8s:
  Prometheus → ServiceMonitor CRD → discovers pods via K8s API → scrapes /metrics
  K8s does the discovery for you.

In ECS:
  Prometheus → ??? → discovers ECS tasks → scrapes /metrics
  ECS does NOT have a native Prometheus discovery mechanism.
  You must bridge the gap.
```

### Service discovery options in ECS

**Option 1: ECS service discovery + file-based SD**

ECS Service Discovery registers tasks in AWS Cloud Map (Route 53-backed DNS). A sidecar or Lambda polls Cloud Map and writes a `targets.json` file that Prometheus reads:

```yaml
scrape_configs:
  - job_name: 'ecs-services'
    file_sd_configs:
      - files:
        - /etc/prometheus/targets/*.json
        refresh_interval: 30s
```

**Option 2: EC2 SD (for EC2-backed ECS)**

Prometheus queries the EC2 API directly to discover instances, then scrapes the ECS tasks running on them:

```yaml
scrape_configs:
  - job_name: 'ecs-tasks'
    ec2_sd_configs:
      - region: eu-west-1
        port: 9090
    relabel_configs:
      - source_labels: [__meta_ec2_tag_ECSServiceName]
        target_label: service
```

**Option 3: Push via OTel Collector (recommended for Winamax)**

The OTel Collector exposes a `/metrics` endpoint. Prometheus scrapes the Collector, which has already aggregated metrics from all services. This avoids the ECS discovery problem entirely — you only need to discover the Collector services, which have stable DNS names.

```yaml
scrape_configs:
  - job_name: 'otel-collector'
    static_configs:
      - targets: ['otel-collector.monitoring:8889']
```

**Option 4: Amazon Managed Service for Prometheus (AMP) with remote_write**

Services push metrics via `remote_write` to AMP. Solves the discovery problem at the cost of coupling to AWS.

For Winamax (self-hosted preference): Option 3 (OTel Collector as aggregation point) is the cleanest architectural choice.

---

## PromQL — the queries that matter

### Rate and increase

```promql
# Requests per second over a 5-minute window
rate(http_requests_total{service="betting-api"}[5m])

# Total requests in the last hour
increase(http_requests_total{service="betting-api"}[1h])

# IMPORTANT: rate() requires a counter (monotonically increasing)
# NEVER use rate() on a gauge
```

### Error rate

```promql
# Raw error rate (requests/sec returning 5xx)
rate(http_requests_total{service="betting-api", status=~"5.."}[5m])

# Error ratio (fraction of requests that are errors)
rate(http_requests_total{service="betting-api", status=~"5.."}[5m])
/
rate(http_requests_total{service="betting-api"}[5m])

# As a percentage
(
  rate(http_requests_total{service="betting-api", status=~"5.."}[5m])
  /
  rate(http_requests_total{service="betting-api"}[5m])
) * 100
```

### Latency percentiles (histograms)

```promql
# P99 latency for betting-api over the last 5 minutes
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{service="betting-api"}[5m]))
  by (le)
)

# P50, P95, P99 together (for a dashboard)
histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))

# By service (for comparison across 700 services)
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (service, le)
)
```

**Key PromQL gotcha for histograms:** Always `sum by (le)` before `histogram_quantile`. The `le` label is the bucket boundary — if you lose it in an aggregation, the quantile calculation breaks.

### Saturation

```promql
# CPU usage per ECS task
rate(process_cpu_seconds_total[5m]) * 100

# Memory usage ratio
process_resident_memory_bytes / container_spec_memory_limit_bytes * 100

# Database connection pool saturation
db_connection_pool_active / db_connection_pool_max * 100

# Kafka consumer lag (custom metric from your consumer)
kafka_consumer_group_lag{consumer_group="betting-consumers", topic="bet-placed"}
```

### The four golden signals as PromQL (betting-api example)

```promql
# 1. LATENCY — P99 response time
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{service="betting-api"}[5m])) by (le)
)

# 2. TRAFFIC — requests per second
sum(rate(http_requests_total{service="betting-api"}[5m]))

# 3. ERRORS — error ratio
sum(rate(http_requests_total{service="betting-api", status=~"5.."}[5m]))
/
sum(rate(http_requests_total{service="betting-api"}[5m]))

# 4. SATURATION — connection pool usage
db_connection_pool_active{service="betting-api"}
/
db_connection_pool_max{service="betting-api"}
```

---

## Alerting rules

Prometheus alerting rules are evaluated on the Prometheus server. When a condition is true for `for:` duration, an alert fires to Alertmanager.

### Basic structure

```yaml
# alerts/betting-api.yaml
groups:
  - name: betting-api
    interval: 30s
    rules:
      - alert: BettingAPIHighErrorRate
        expr: |
          (
            sum(rate(http_requests_total{service="betting-api", status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{service="betting-api"}[5m]))
          ) > 0.01
        for: 5m
        labels:
          severity: critical
          team: platform
          service: betting-api
        annotations:
          summary: "Betting API error rate above 1%"
          description: "Error rate is {{ $value | humanizePercentage }} over the last 5 minutes."
          runbook: "https://wiki.winamax.internal/runbooks/betting-api-errors"

      - alert: BettingAPIHighLatency
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{service="betting-api"}[5m])) by (le)
          ) > 0.5
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Betting API P99 latency above 500ms"
          description: "P99 latency is {{ $value | humanizeDuration }}"

      - alert: BettingAPIDown
        expr: |
          absent(http_requests_total{service="betting-api"})
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Betting API is not reporting metrics"
```

### SLO-based alerting (more advanced)

Instead of arbitrary thresholds, alert on SLO burn rate:

```yaml
# SLO: 99.9% of requests succeed (error budget = 0.1%)
# Alert when burning through error budget too fast

- alert: BettingAPIErrorBudgetBurnRateFast
  expr: |
    # 1-hour burn rate > 14.4x normal (burns monthly budget in 2 hours)
    (
      sum(rate(http_requests_total{service="betting-api", status=~"5.."}[1h]))
      /
      sum(rate(http_requests_total{service="betting-api"}[1h]))
    ) > 0.001 * 14.4
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Betting API burning error budget 14.4x faster than normal"

- alert: BettingAPIErrorBudgetBurnRateSlow
  expr: |
    # 6-hour burn rate > 6x normal (page the on-call, not critical)
    (
      sum(rate(http_requests_total{service="betting-api", status=~"5.."}[6h]))
      /
      sum(rate(http_requests_total{service="betting-api"}[6h]))
    ) > 0.001 * 6
  for: 30m
  labels:
    severity: warning
```

---

## Recording rules

If you run the same expensive PromQL query in multiple dashboards and alerts, you waste CPU. Recording rules pre-compute and store the result as a new metric.

```yaml
groups:
  - name: winamax_precomputed
    interval: 30s
    rules:
      # Pre-compute error ratio for all services
      - record: service:http_error_ratio:rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
          /
          sum(rate(http_requests_total[5m])) by (service)

      # Pre-compute P99 latency per service
      - record: service:http_p99_duration:rate5m
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (service, le)
          )

      # Pre-compute Kafka lag per consumer group
      - record: kafka:consumer_lag:max
        expr: |
          max(kafka_consumer_group_lag) by (consumer_group, topic)
```

Now your dashboards use `service:http_error_ratio:rate5m` instead of the full query.

---

## Kafka consumer lag metric — custom metric

Kafka does not expose consumer lag to Prometheus natively. You need a Kafka exporter or custom metric in your consumer:

```javascript
// In your Kafka consumer (Node.js)
const lagGauge = meter.createObservableGauge('kafka.consumer.lag', {
  description: 'Current consumer lag per partition',
});

lagGauge.addCallback(async (observableResult) => {
  const offsets = await admin.fetchOffsets({ groupId: 'betting-consumers', topics: ['bet-placed'] });
  const topicOffsets = await admin.fetchTopicOffsets('bet-placed');

  for (const partition of offsets[0].partitions) {
    const latestOffset = topicOffsets.find(t => t.partition === partition.partition);
    const lag = parseInt(latestOffset.offset) - parseInt(partition.offset);
    observableResult.observe(lag, {
      'kafka.consumer_group': 'betting-consumers',
      'kafka.topic': 'bet-placed',
      'kafka.partition': partition.partition.toString(),
    });
  }
});
```

This gives you a `kafka.consumer.lag` metric you can alert on:

```yaml
- alert: KafkaBettingConsumerLagHigh
  expr: kafka_consumer_lag{consumer_group="betting-consumers", topic="bet-placed"} > 50000
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Betting Kafka consumer lag is high — {{ $value }} messages behind"
```
