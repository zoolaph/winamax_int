# Architecture Design 01 — Observability Pipeline for 700 ECS Services

## Set the timer: 10 minutes. Close your notes.

---

## The constraints

- 700 microservices running on ECS (mix of Fargate and EC2-backed)
- ~75,000 events/second across the platform at peak
- French GDPR and gambling regulation: player data must never leave your infrastructure
- Budget: no SaaS observability (no Datadog, no New Relic)
- Must support: distributed tracing, metrics, logs
- Engineers must be able to debug a P99 latency spike and find the slow service/span within 5 minutes
- PII must be scrubbed before it reaches any backend

**Design the full observability pipeline. Include:**
1. How services emit telemetry
2. The collection and routing layer
3. The storage backends
4. The query and visualization layer
5. Where sampling happens and why
6. Where PII scrubbing happens and why
7. How Prometheus discovers targets in ECS

**Draw it as ASCII. Write your rationale for each component choice.**

---

**STOP. Design it now. Do not scroll.**

---
---
---
---
---
---

## Reference design

### Architecture diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        ECS Services (700)                        │
│                                                                  │
│  [bet-api]  [fraud-svc]  [odds-engine]  ...  [payment-api]      │
│      │            │            │                    │            │
│   OTel SDK      OTel SDK    OTel SDK             OTel SDK       │
│   (traces,      (traces,    (traces,             (traces,       │
│   metrics,      metrics,    metrics,             metrics,       │
│   logs)         logs)       logs)                logs)          │
└────────────────────────┬────────────────────────────────────────┘
                         │ OTLP gRPC (push)
                         ▼
┌────────────────────────────────────────────────────────────────┐
│              OTel Collector — Gateway Tier                      │
│              (3-5 instances, ECS service, ALB in front)        │
│                                                                │
│  Receivers:  OTLP (gRPC 4317, HTTP 4318)                      │
│                                                                │
│  Processors (in order):                                        │
│    1. memory_limiter     — shed load before OOM               │
│    2. attributes         — DELETE player.name, player.email,  │
│                            db.statement, http.client_ip        │
│    3. tail_sampler       — keep: status=ERROR, latency>300ms  │
│                            sample: 5% of healthy traces        │
│    4. batch              — batch for efficiency                │
│                                                                │
│  Exporters:                                                    │
│    traces  → Jaeger (OTLP)                                    │
│    metrics → Prometheus (remote_write)                        │
│    logs    → Kinesis Firehose → S3                            │
└────────────────────────────────────────────────────────────────┘
         │ traces              │ metrics            │ logs
         ▼                     ▼                    ▼
┌──────────────┐    ┌──────────────────┐   ┌──────────────────┐
│    Jaeger     │    │   Prometheus     │   │  Quickwit on S3  │
│   (traces)    │    │   (metrics TSDB) │   │  (log search)    │
│               │    │                  │   │                  │
│ Storage:      │    │ Storage: EBS or  │   │ Index: S3        │
│ Quickwit/S3  │    │ EBS (28d retain) │   │ (S3 lifecycle    │
│ (long term)  │    │                  │   │  tiers: 30d Std  │
│               │    │ Scrape: Collector│   │  90d IA          │
│               │    │ instances only   │   │  365d Glacier)   │
└──────────────┘    └──────────────────┘   └──────────────────┘
         │                   │                       │
         └───────────────────┼───────────────────────┘
                             ▼
                    ┌──────────────────┐
                    │     Grafana      │
                    │                  │
                    │ Data sources:    │
                    │  - Prometheus    │
                    │  - Jaeger        │
                    │  - Quickwit      │
                    │                  │
                    │ Features:        │
                    │  - Dashboards    │
                    │  - Alertmanager  │
                    │  - Exemplars     │
                    │    (metric →     │
                    │     trace link)  │
                    └──────────────────┘
```

### Component rationale

**OTel SDK — why not agent-based collection?**

Push model via OTel SDK gives each service control over what it emits. Auto-instrumentation handles HTTP, gRPC, database clients, Kafka without code changes. The SDK propagates trace context through HTTP headers (`traceparent`) and Kafka message headers automatically.

**OTel Collector Gateway — why a gateway tier, not sidecar per task?**

At 700 services with multiple tasks each, a sidecar approach means 1,000+ Collector processes to manage. A gateway tier reduces this to 3-5 stable instances with an ALB in front. Services push to the ALB DNS name — no per-service discovery needed. The gateway handles sampling and PII scrubbing centrally.

The key operational point: centralized processors mean config changes apply to all 700 services by changing one Collector config. You do not need to redeploy 700 services to add a new PII field to the scrub list.

**Tail-based sampling — why not head-based?**

Head-based sampling decides at trace start whether to keep it. At 5% sampling, 95% of error traces are dropped — exactly the traces you need most. Tail-based buffers all spans until the trace completes, then applies policies:
- Always keep: `status = ERROR`
- Always keep: `duration > 300ms`
- Always keep: traces tagged with `critical_path = true` (betting, payment)
- Sample 5%: everything else

The constraint: tail sampling requires all spans of a trace to arrive at the same Collector instance. Solved by consistent hash routing on `trace_id` at the ALB level.

**Quickwit for logs — why not Elasticsearch?**

Quickwit indexes on S3. At Winamax's log volume (700 services × ~1000 log lines/sec = millions of lines/min), Elasticsearch on provisioned SSD is extremely expensive. Quickwit on S3 is 5-10x cheaper. Query latency is seconds instead of milliseconds, but for log debugging in an incident, seconds is acceptable.

**Prometheus scrape strategy for ECS**

ECS has no native service discovery equivalent to Kubernetes ServiceMonitors. Solution: Prometheus scrapes only the Collector gateway instances (stable DNS via ECS service discovery). The Collector exposes a `/metrics` endpoint and aggregates metrics received via OTLP push from all 700 services. Prometheus does not need to discover individual tasks — the Collector acts as a metrics aggregation proxy.

**PII scrubbing — why at the Collector, not the SDK?**

SDK-level scrubbing requires every developer on every team to correctly implement it. Human error at scale is certain. The Collector processor is the enforcement layer — it runs regardless of what the application sends. Even if a developer accidentally logs `player.email` in a span attribute, the Collector deletes it before it reaches Jaeger or Quickwit. Defense in depth.

### What a latency spike investigation looks like

1. Grafana alert fires on P99 latency for `betting-api`
2. Grafana panel has an exemplar — a metric data point linked to a trace ID
3. Click the exemplar → Jaeger opens the specific slow trace
4. Trace waterfall shows `db.insert-bet` span at 700ms
5. Click the span → copy `trace_id`
6. Quickwit query: `trace_id:"abc123"` → find all log lines from that request
7. Root cause: database lock from migration running at the same time

Total investigation time with this pipeline: under 5 minutes.
