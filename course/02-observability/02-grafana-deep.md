# Grafana Deep — Dashboards, Alerting, Multi-Source Composition

---

## What Grafana is (and is not)

Grafana is a **visualization and alerting layer**. It stores nothing. All data lives in backends (Prometheus, Jaeger, Quickwit, CloudWatch, etc.). Grafana's job is to query those backends and present the data.

```
Grafana queries:
  Prometheus  → metrics, alert states
  Jaeger      → traces, trace search
  Quickwit    → logs, log search
  CloudWatch  → AWS metrics (if needed)
  Loki        → logs (alternative to Quickwit)

Grafana stores:
  Dashboard definitions (JSON)
  Alert rules
  User/team config
  Data source connections
```

The power is **composition**: one Grafana dashboard can show a metric spike, the correlated log lines, and a button to jump to the trace — all from different backends.

---

## Data sources — connecting to backends

In Winamax's stack:

```yaml
# Example Grafana provisioning (grafana/provisioning/datasources/datasources.yaml)
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus.monitoring:9090
    isDefault: true
    jsonData:
      httpMethod: POST
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: jaeger-uid  # click trace_id in a metric → jump to Jaeger

  - name: Jaeger
    type: jaeger
    uid: jaeger-uid
    url: http://jaeger-query.monitoring:16686

  - name: Quickwit
    type: quickwit-quickwit-datasource  # community plugin
    url: http://quickwit.monitoring:7280

  - name: CloudWatch
    type: cloudwatch
    jsonData:
      defaultRegion: eu-west-1
```

**Exemplars** are the bridge between Prometheus metrics and Jaeger traces. When a histogram metric is recorded, the SDK can attach an exemplar — a sample trace_id — to the data point. When you click a spike on a Grafana latency graph, it jumps directly to a representative trace in Jaeger.

---

## Dashboard structure

A good SRE dashboard has layers — from overview to detail:

```
Layer 1: Service health overview (one row per service)
  ├── Error rate (current vs SLO threshold)
  ├── P99 latency (current vs SLO threshold)
  ├── RPS (traffic)
  └── Saturation (CPU, memory, connection pool)

Layer 2: Drill-down by endpoint
  ├── Error rate heatmap by endpoint
  ├── Latency percentiles (P50, P95, P99) per endpoint
  └── Top slowest endpoints

Layer 3: Infrastructure
  ├── ECS task count (desired vs running)
  ├── CPU/memory per task
  └── ALB healthy host count

Layer 4: Dependencies
  ├── Database connection pool usage
  ├── Kafka consumer lag
  └── External API error rates
```

### Dashboard-as-code (Grafana provisioning)

Do not click to create dashboards in production. Store them as JSON in git and provision them via config:

```yaml
# grafana/provisioning/dashboards/dashboards.yaml
apiVersion: 1
providers:
  - name: 'winamax-dashboards'
    folder: 'Winamax'
    type: file
    options:
      path: /etc/grafana/dashboards
      foldersFromFilesStructure: true
```

Deploy the dashboard JSON files via a ConfigMap (K8s) or ECS task with a volume mount. Dashboard changes go through git → CI/CD → Grafana.

### Key panel types

| Panel | Use case |
|---|---|
| Time series | Metrics over time — latency, RPS, error rate |
| Stat | Single current value — "current error rate: 0.02%" |
| Gauge | Value relative to min/max — "pool utilization: 67%" |
| Table | Multiple metrics per service (overview tables) |
| Heatmap | Distribution of values over time (latency distribution) |
| Logs | Log lines from Quickwit/Loki inline with metrics |
| Traces | Trace list from Jaeger |
| Node Graph | Service dependency graph (from trace data) |

---

## Grafana alerting

Grafana has its own alerting engine (unified alerting, introduced in Grafana 9). It can alert on any data source, not just Prometheus.

### Alert rule anatomy

```
Alert rule:
  Name: "Betting API High Error Rate"
  Data source: Prometheus
  Query:
    A: sum(rate(http_requests_total{service="betting-api", status=~"5.."}[5m]))
       /
       sum(rate(http_requests_total{service="betting-api"}[5m]))

  Condition: WHEN A > 0.01 FOR 5 minutes

  Labels:
    severity: critical
    team: platform

  Annotations:
    summary: "Betting API error rate {{ $values.A }}% is above 1%"
    runbook: "https://wiki..."
```

### Notification policies and contact points

Grafana routes alerts to **contact points** (PagerDuty, Slack, email, webhook) via **notification policies**:

```
Notification policy:
  Match: severity=critical  → contact point: PagerDuty
  Match: severity=warning   → contact point: Slack #alerts
  Default                   → contact point: email
```

This is separate from alert rules — you define the routing once, apply it to all alerts via label matching.

### Silences and inhibition

- **Silence**: suppress alerts matching labels for a time window (use during maintenance)
- **Inhibition**: suppress lower-priority alerts when a critical alert is firing (e.g., don't alert on "service slow" when "service down" is already firing)

---

## The critical debugging workflow in Grafana

This is the story you tell in an interview when asked about an incident:

```
1. Grafana overview dashboard shows: betting-api error rate spiked at 21:03

2. Click on the spike → Grafana shows exemplar data point with trace_id=7d3f2a1b

3. Click trace_id → jumps to Jaeger → shows the full trace tree
   → db.insert bet span: 622ms (vs normal 8ms)

4. Copy trace_id → go to Quickwit/Logs panel → search for trace_id=7d3f2a1b
   → Log line: "slow query detected: INSERT INTO bets — missing index on player_id"

5. Fix: add missing index
   → Grafana shows latency drops back to normal within minutes of deploy
```

The key is that Grafana is the unified entry point. You do not need to switch between Jaeger and Quickwit manually — Grafana ties them together via `trace_id` linking and the Explore view.

---

## Grafana Explore

Explore is the ad-hoc investigation mode — no dashboard needed:

```
Grafana → Explore tab

Select data source: Prometheus
Query: rate(http_requests_total{service="betting-api", status=~"5.."}[5m])
→ See the spike at 21:03

Add panel → Select data source: Quickwit  
Query: service.name:betting-api AND level:ERROR AND timestamp:[21:00 TO 21:10]
→ See matching log lines alongside the metric

Add panel → Select data source: Jaeger
Query: service="betting-api" tags="error=true" min_duration=500ms
→ See slow/error traces from the incident window
```

Explore lets you correlate data across all three pillars in one view without building a dashboard first.

---

## Grafana for Kafka lag monitoring

Kafka consumer lag is a critical metric for Winamax's event-driven architecture:

```
Dashboard: Kafka Operations

Row: Consumer group health
  - kafka_consumer_lag per consumer group (time series)
  - Current max lag per group (stat panels, red if > threshold)
  - Lag rate of change (is it growing or shrinking?)

Row: Throughput
  - Messages/sec produced per topic
  - Messages/sec consumed per consumer group
  - Lag / consumption_rate = estimated time to catch up (minutes)

Row: Broker health
  - Under-replicated partitions (should be 0)
  - Active controller count (should be 1)
  - ISR shrinks (leader health)
```

For Winamax at 75,000 msg/sec: consumer lag is the primary leading indicator. If lag grows, consumers are falling behind. Alert at 50k messages of lag for warning, 200k for critical — the exact thresholds depend on the topic and acceptable processing delay.
