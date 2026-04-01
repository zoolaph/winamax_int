# Module 2 — Observability: OpenTelemetry, Prometheus, Grafana, Distributed Tracing

**Why this is critical:** Winamax gave a Devoxx 2026 talk specifically about their open-source observability stack. They built it themselves because SaaS tools (Datadog, New Relic) cannot hold player data. This is not background knowledge — it is a live production initiative, and they will probe your depth.

---

## What Winamax built and why

Winamax processes 75,000 Kafka messages/sec, 900k+ bets/day, across 700+ microservices. When something breaks, you need to know **which** of 700 services caused it, **why**, and **when**. SaaS observability tools are out because player data and bet data are confidential under GDPR and French gambling law. So they built their own stack:

```
OpenTelemetry SDK  →  OTel Collector  →  Jaeger (traces)
                                       →  Quickwit (logs, indexed)
                                       →  Prometheus (metrics) → Grafana
```

Every part is open-source and self-hosted. You need to understand each layer and why it connects to the next.

---

## Module structure — what each file covers

| Topic | File | One-line summary |
|---|---|---|
| Three pillars | `02-three-pillars.md` | When to reach for metrics vs logs vs traces |
| OTel architecture | `02-otel-architecture.md` | SDK, API, Collector, Exporters — how data flows |
| Traces deep | `02-otel-traces-deep.md` | Spans, context propagation, sampling strategies |
| Node.js instrumentation | `02-otel-nodejs.md` | Auto-instrumentation in Node.js — Winamax's main backend language |
| OTel Collector deep | `02-otel-collector-deep.md` | Pipelines, processors, exporters, scaling the Collector |
| Prometheus deep | `02-prometheus-deep.md` | Scraping model, PromQL, alerting rules |
| Grafana deep | `02-grafana-deep.md` | Dashboards, alerting, multi-source composition |
| Jaeger + Quickwit | `02-jaeger-storage-deep.md` | Trace storage on object storage, what "terabytes of traces" means operationally |
| Privacy in observability | `02-privacy.md` | Why you cannot log raw bet/player data — and how to design around it |

---

## Part 1: The three pillars — quick map

See `02-three-pillars.md` for the full breakdown.

**The one thing to keep sharp: each pillar answers a different question.**

- **Metrics** — *Is the system healthy? What are the rates and saturation levels?* Numbers over time. Cheap to store, great for alerting and dashboards.
- **Logs** — *What exactly happened at this timestamp?* Structured events with context. Expensive at scale (Winamax uses Quickwit for indexed search instead of Elasticsearch).
- **Traces** — *Why was this request slow? Which service caused this error?* Causal chain across services. Requires instrumentation but essential at 700+ microservices.

The failure mode when you only have metrics: you know something is broken but not where. The failure mode when you only have logs: you can see what happened on one service but cannot follow the request across 10 services. Traces are what connect everything.

---

## Part 2: OTel architecture — quick map

See `02-otel-architecture.md` for the full breakdown.

**The one thing to keep sharp: the separation between SDK and Collector.**

- The **SDK** lives in your application code. It generates telemetry (spans, metrics, logs).
- The **Collector** is a separate process/pod/sidecar. It receives, processes, and exports telemetry.
- This separation means you can change where telemetry goes (Jaeger? S3? Prometheus?) without changing application code.

The SDK sends to the Collector. The Collector fans out to backends. Applications never talk directly to Jaeger or Quickwit.

---

## Part 3: Traces — quick map

See `02-otel-traces-deep.md` for the full breakdown.

**The one thing to keep sharp: context propagation is what makes distributed tracing work.**

A trace is a tree of spans. Each span is one operation. When a request hops from Service A to Service B over HTTP or Kafka, the trace context (trace ID + span ID) must be carried in the request headers. If any service fails to forward the context, the trace breaks into disconnected fragments.

For Winamax: 700+ services means 700+ potential points where context propagation can fail. The OTel Collector cannot fix a broken propagation — it must be correct in the application code (or auto-instrumented correctly).

---

## Part 4: Node.js instrumentation — quick map

See `02-otel-nodejs.md` for the full breakdown.

**The one thing to keep sharp: auto-instrumentation uses monkey-patching.**

The Node.js OTel SDK patches well-known libraries (http, express, pg, kafka-node, etc.) at import time. You do not need to add spans manually to most standard library calls — they appear automatically. Manual instrumentation is for your business logic spans (e.g., "calculate-bet-odds", "validate-bet-slip").

The instrumentation file must be loaded before any other code via `--require` or `NODE_OPTIONS`.

---

## Part 5: OTel Collector — quick map

See `02-otel-collector-deep.md` for the full breakdown.

**The one thing to keep sharp: the Collector is a pipeline, not a router.**

```
receivers → processors → exporters
```

Processors are where you do sampling, PII scrubbing, enrichment, and batching. This is where Winamax's privacy requirements are enforced — a processor can drop or redact attributes that contain player data before the telemetry ever leaves the Collector.

---

## Part 6: Prometheus — quick map

See `02-prometheus-deep.md` for the full breakdown.

**The one thing to keep sharp: Prometheus pulls, not pushes.**

Prometheus scrapes `/metrics` endpoints on a schedule. Services do not send metrics to Prometheus. This matters for ECS because tasks do not have stable IPs — you need service discovery (ECS service discovery or a sidecar exporter) for Prometheus to find them.

You already know Prometheus from K8s. The gap here is the scrape discovery model in ECS and PromQL for SLO alerting.

---

## Part 7: Grafana — quick map

See `02-grafana-deep.md` for the full breakdown.

**The one thing to keep sharp: Grafana is a viewer, not a storage layer.**

Grafana queries data sources (Prometheus, Jaeger, Quickwit, CloudWatch). It stores nothing itself. You can build a single dashboard that shows a metric spike, the correlated log lines, and the trace that shows which service was slow — all from different backends.

---

## Part 8: Jaeger + Quickwit — quick map

See `02-jaeger-storage-deep.md` for the full breakdown.

**The one thing to keep sharp: trace storage at scale is an IO and query problem.**

Storing 700 services × all traffic = terabytes/day of trace data. You cannot store it all forever. The operational decisions are: sampling strategy (what fraction do you keep?), storage backend (Jaeger supports Cassandra, Elasticsearch, and object storage), and retention policy. Quickwit is Winamax's choice for log indexing — it indexes directly on object storage (S3), which is much cheaper than running Elasticsearch at this volume.

---

## Part 9: Privacy — quick map

See `02-privacy.md` for the full breakdown.

**The one thing to keep sharp: privacy compliance is not optional, it changes your instrumentation design.**

You cannot put a player's name, bet amount, or card number in a trace span attribute or log field and send it to an observability backend — even a self-hosted one. The design principle is: use IDs (bet_id, player_id), never values. Sanitize in the OTel Collector processor before export. And the observability backend itself must be self-hosted, not SaaS.

---

## Part 10: Bridge from Kubernetes

You already know Prometheus + Grafana deeply from K8s. Here is what maps directly and what is new:

| K8s experience | Observability equivalent | Gap? |
|---|---|---|
| Prometheus scraping K8s pods | Same concept, different service discovery | Minor — ECS discovery is different |
| Grafana dashboards | Identical | None |
| Liveness/readiness probes as health signal | Still needed; metrics are deeper signal | None |
| kubectl logs | Structured logs → Quickwit | New: indexing and search at scale |
| No distributed tracing experience | OTel traces + Jaeger | **Gap — this is the main new area** |
| No privacy-aware instrumentation | OTel Collector processors for PII scrubbing | **Gap — important for Winamax** |

The gap is not Prometheus or Grafana. The gap is distributed tracing (how spans work, how context propagates, how sampling works) and privacy-aware telemetry design.

---

## Part 11: Hands-on exercises

Go to `exercises/02-observability/` for the labs.

The exercises cover:
1. Write an OTel Collector config that receives OTLP, redacts a PII field, and exports to Jaeger + Prometheus
2. Write PromQL queries for the four golden signals for a betting API
3. Instrument a Node.js service with OTel auto-instrumentation
4. Design a sampling strategy for 75k msg/sec

---

## Part 12: Interview Q&A

See `interview/02-observability-questions.md` for full story-angle answers.

**Quick reference — the questions they will ask:**

1. Walk me through your observability stack at Winamax — why did you build it instead of buying it?
2. What is OpenTelemetry and how does it differ from Jaeger or Prometheus?
3. How does a trace span get from Service A to Service B?
4. What is context propagation and what breaks it?
5. How do you sample traces at 75,000 messages/second without losing signal on errors?
6. How do you prevent player data from ending up in traces?
7. What is a Collector pipeline and why does it matter?
8. How does Prometheus discover ECS tasks to scrape?
9. What is Quickwit and why use it over Elasticsearch?
10. You see a latency spike on the betting API. Walk me through your debugging process.
