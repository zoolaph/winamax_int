# The Three Pillars of Observability — Metrics, Logs, Traces

---

## The core question each pillar answers

```
Metrics  →  "Is the system healthy right now, and how has it been trending?"
Logs     →  "What exactly happened at this specific time in this specific service?"
Traces   →  "Why was this specific request slow, and which service caused it?"
```

They are complementary, not competing. The failure mode is having only one or two.

---

## Pillar 1: Metrics

### What they are

Numbers over time. A metric is a measurement sampled at regular intervals with labels (dimensions) attached.

```
http_requests_total{service="betting-api", method="POST", status="200"} 9843  1711900800
http_request_duration_seconds{service="betting-api", p99="true"} 0.142        1711900800
```

### What they are good for

- Alerting — "p99 latency exceeded 500ms for 3 minutes"
- Dashboards — "current RPS, error rate, saturation"
- SLO tracking — "we are at 99.94% availability this week"
- Capacity planning — "CPU headroom before we need to scale"

### What they are bad at

You see **that** something is broken. You do not see **why** or **where** unless you already have good label cardinality (service, endpoint, status code).

```
❌ "Something is slow" — metrics give you this
✓  "The betting-slip-validation service is slow on POST /validate" — metrics with good labels give you this
✗  "The database query on line 142 of validator.js is slow" — you need traces for this
```

### The four golden signals (Google SRE)

| Signal | PromQL concept | Why it matters |
|---|---|---|
| **Latency** | `histogram_quantile(0.99, ...)` | Slow bets = unhappy users |
| **Traffic** | `rate(http_requests_total[5m])` | Baseline for all other signals |
| **Errors** | `rate(http_requests_total{status=~"5.."}[5m])` | Direct user impact |
| **Saturation** | CPU%, memory%, connection pool usage | Predictor of future failure |

Memorize these four. They come up in every SRE interview.

### Metric types in Prometheus

| Type | What it counts | Example |
|---|---|---|
| **Counter** | Monotonically increasing | `http_requests_total`, `kafka_messages_consumed_total` |
| **Gauge** | Value that goes up and down | `active_connections`, `queue_depth` |
| **Histogram** | Distribution of values in buckets | `http_request_duration_seconds` |
| **Summary** | Pre-computed quantiles | Less common, prefer histograms |

**Counter pitfall:** Counters only go up. When a service restarts, they reset to 0. Always use `rate()` or `increase()` to get per-second rates — never graph a raw counter.

---

## Pillar 2: Logs

### What they are

Structured records of discrete events. Every line is an event with a timestamp, severity level, and key-value fields.

```json
{
  "timestamp": "2026-04-01T21:03:42.183Z",
  "level": "ERROR",
  "service": "betting-api",
  "trace_id": "7d3f2a1b4e5c6d7e",
  "span_id": "1a2b3c4d",
  "bet_id": "BET-98234",
  "player_id": "PLY-44123",
  "event": "bet_validation_failed",
  "reason": "odds_changed",
  "duration_ms": 12
}
```

### What they are good for

- Root cause investigation after an alert fires
- Debugging logic errors and edge cases
- Audit trails (who did what, when)
- Correlating with traces via `trace_id` in the log line

### What they are bad at

- Real-time alerting at scale (too expensive to query raw logs on every check)
- Long-term trend analysis (storage cost is high)
- Cross-service causality (you cannot follow a request across 10 services through logs alone without trace IDs)

### Structured vs unstructured logs

```
# Unstructured — searchable only with text grep, poor for tooling
ERROR: Bet validation failed for player 44123 after 12ms

# Structured — queryable with any field, compatible with Quickwit indexing
{"level":"ERROR","event":"bet_validation_failed","player_id":"PLY-44123","duration_ms":12}
```

Always use structured logs. At 700+ microservices, unstructured logs are operationally useless at scale.

### Why Winamax uses Quickwit instead of Elasticsearch

Elasticsearch is the traditional choice for log indexing and search. Quickwit is a newer alternative built specifically for immutable log data on object storage (S3, GCS).

| | Elasticsearch | Quickwit |
|---|---|---|
| Storage | Shard-based, attached disk | Indexes directly on S3/object storage |
| Cost at scale | Expensive (disk + compute) | Cheap (S3 is ~$0.023/GB/month) |
| Query latency | Sub-second for hot data | Sub-second for recent, seconds for cold |
| Operational overhead | High (shard management, rebalancing) | Low (no cluster state to manage) |
| Winamax fit | Too expensive at their log volume | Fits: immutable logs, cost-sensitive, self-hosted |

The Winamax choice is driven by data volume + cost + self-hosting requirement (no SaaS). Quickwit on S3 solves all three.

---

## Pillar 3: Traces

### What they are

A trace is the full causal story of a single request across multiple services. It is a tree of spans.

```
Trace: POST /api/bet/place  (total: 187ms)
├─ span: auth-validate-token          (12ms)  [auth-service]
├─ span: get-odds                     (34ms)  [odds-service]
│   └─ span: db-query: SELECT odds    (31ms)  [odds-db]
├─ span: validate-bet-slip            (8ms)   [validation-service]
├─ span: publish-bet-placed-event     (5ms)   [kafka-producer]
└─ span: write-bet-to-db              (122ms) [db-service]   ← THIS IS THE SLOW ONE
    └─ span: db-query: INSERT bet     (119ms) [betting-db]
```

Without tracing, you would see "the betting API is slow" (metrics) and maybe "slow query" in one of seven services' logs (logs) — but you would not instantly know it was the INSERT on the betting-db, not the odds-service or the auth-service.

### What makes traces work

1. **Instrumentation** — every service must create spans for its operations
2. **Context propagation** — trace ID and parent span ID must be passed between services in headers
3. **A backend** — Jaeger, Tempo, Zipkin to store and query traces
4. **Sampling** — you cannot keep 100% of traces at 75,000 msg/sec; you keep a percentage and all errors

### When to reach for traces

- Latency debugging: "Why is P99 slow? Which service?"
- Error attribution: "Which of my 700 services is throwing the 500?"
- Dependency mapping: "What does the betting service actually call?"
- Performance optimization: "Where are we spending time in this request?"

---

## How the pillars work together — the investigation workflow

This is the answer to "walk me through debugging a production incident":

```
1. ALERT fires (metrics)
   "p99 latency on betting-api exceeded 800ms for 5 minutes"

2. DASHBOARD (metrics)
   → Grafana shows: latency spiked at 21:03, error rate normal, CPU fine
   → Conclusion: slow, not broken. Look deeper.

3. TRACES (Jaeger)
   → Filter traces from 21:03 with duration > 500ms
   → All slow traces show a common pattern: the "write-bet-to-db" span is slow
   → trace_id: 7d3f2a1b4e5c6d7e, span: write-bet-to-db, 622ms

4. LOGS (Quickwit)
   → Search for trace_id = "7d3f2a1b4e5c6d7e" in db-service logs
   → Find: "slow query detected: INSERT INTO bets — 619ms — index missing"

5. FIX
   → Missing index on the bets table after a migration
   → Add index, latency drops back to normal
```

This workflow — alert → dashboard → trace → log — is the core SRE debugging loop. You need to be able to describe it fluently.

---

## The correlation key: trace_id in logs

The bridge between traces and logs is the `trace_id` field. When your application logs an event, it should always include the current `trace_id` and `span_id` from the OTel context. This lets you jump from a slow trace in Jaeger directly to the relevant log lines in Quickwit.

OTel SDKs inject this automatically when you use their logging integration. Do not implement this manually.

```javascript
// With OTel active, the logger automatically includes trace context
logger.error('bet_validation_failed', {
  bet_id: 'BET-98234',
  reason: 'odds_changed',
  // trace_id and span_id injected automatically by OTel
});
```

---

## Winamax-specific context

With 700+ microservices:
- Metrics tell you which service is unhealthy
- Traces tell you the causal chain (Service A called B called C and C is the problem)
- Logs tell you the exact error message and context on the failing service

All three are necessary. The choice to self-host means Winamax manages the operational overhead of all three backends — this is part of the SRE role.
