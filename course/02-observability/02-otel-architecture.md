# OpenTelemetry Architecture — SDK, API, Collector, Exporters

---

## What OpenTelemetry is (and is not)

OpenTelemetry (OTel) is a **vendor-neutral standard and SDK** for generating, collecting, and exporting telemetry data (traces, metrics, logs). It is not a backend. It does not store or query your data.

```
What OTel IS:
  - A specification (how data is structured, how context propagates)
  - SDKs for every language (the code that runs in your app)
  - The Collector (the pipeline process that receives, processes, exports)
  - A protocol: OTLP (OpenTelemetry Protocol)

What OTel is NOT:
  - Jaeger (trace backend/storage)
  - Prometheus (metrics backend)
  - Quickwit (log backend)
  - Grafana (visualization)
```

The key insight: OTel standardizes the **instrumentation** side. Backends remain independent. This is why Winamax can send traces to Jaeger and metrics to Prometheus using the same SDK — they just change the Collector exporter configuration.

---

## The four components

```
┌─────────────────────────────────────────────────────────────────────┐
│  YOUR APPLICATION                                                   │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────────────────────────────┐  │
│  │  OTel API    │    │  OTel SDK                                │  │
│  │              │    │                                          │  │
│  │  Interfaces  │◄───│  TracerProvider   MeterProvider          │  │
│  │  you call    │    │  LoggerProvider                         │  │
│  │  in code     │    │  Propagator       Sampler               │  │
│  └──────────────┘    └──────────────┬───────────────────────────┘  │
└────────────────────────────────────│────────────────────────────────┘
                                     │ OTLP (gRPC or HTTP)
                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  OTel COLLECTOR                                                     │
│                                                                     │
│  Receivers  →  Processors  →  Exporters                             │
│  (OTLP)        (filter,       (Jaeger, Prometheus,                  │
│                sample,        Quickwit, S3, ...)                    │
│                enrich,                                              │
│                redact)                                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Component 1: The API

The OTel API is the **interface** your application code calls. Think of it as the contract.

```javascript
const { trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('betting-service', '1.0.0');

const span = tracer.startSpan('validate-bet');
// ... do work ...
span.end();
```

The API is intentionally thin. If no SDK is registered (e.g., in tests or when OTel is disabled), all API calls are no-ops. This means you can add instrumentation to a library without forcing users to install the SDK.

### Component 2: The SDK

The SDK is the **implementation** of the API. It is what actually creates spans, records measurements, and decides what to do with them.

Key SDK responsibilities:
- **TracerProvider** — creates Tracer instances, manages the span lifecycle
- **MeterProvider** — creates Meter instances for metrics
- **Propagator** — reads/writes trace context from/to HTTP headers, Kafka message headers
- **Sampler** — decides which traces to keep (see `02-otel-traces-deep.md`)
- **Exporter** — sends data to the Collector (or directly to a backend)
- **BatchSpanProcessor** — buffers spans and sends in batches for efficiency

**The SDK is configured once at application startup**, typically in an instrumentation file loaded before anything else:

```javascript
// instrumentation.js — loaded via NODE_OPTIONS=--require ./instrumentation.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');

const sdk = new NodeSDK({
  serviceName: 'betting-api',
  traceExporter: new OTLPTraceExporter({
    url: 'http://otel-collector:4317',  // send to local Collector
  }),
});

sdk.start();
```

### Component 3: The Collector

The OTel Collector is a **standalone binary** that runs as a sidecar, daemonset, or standalone service. It is the hub of the pipeline.

Why run a Collector instead of exporting directly from the SDK to Jaeger?

| Direct export (SDK → Jaeger) | Via Collector (SDK → Collector → Jaeger) |
|---|---|
| Simple | More moving parts |
| Coupled to backend choice | Backend-agnostic |
| No processing possible | Can filter, sample, enrich, redact |
| Each app manages its own retry/buffer | Centralized retry + buffering |
| Must update app code to change backend | Change Collector config, not app code |
| Privacy: PII leaves the app | Privacy: redact PII in Collector before export |

For Winamax, the Collector is essential because of privacy requirements. PII scrubbing happens in the Collector processor — you do not need to modify application code in 700 services.

### Component 4: Exporters

Exporters are plugins that translate OTel data format into the format a specific backend understands.

| Exporter | Where it sends data | Used for |
|---|---|---|
| `otlp` | Another Collector or OTLP-compatible backend | General |
| `jaeger` | Jaeger backend | Traces |
| `prometheus` | Prometheus scrape endpoint | Metrics |
| `loki` | Grafana Loki | Logs |
| `debug` | stdout | Development only |
| `file` | Local file | Debugging |

In Winamax's stack:
- Traces → `otlp` exporter → Jaeger
- Metrics → `prometheus` exporter (Prometheus scrapes the Collector)
- Logs → `otlp` exporter → Quickwit

---

## OTLP: the protocol

OTLP (OpenTelemetry Protocol) is the native wire format for OTel data. It is Protobuf over gRPC (port 4317) or JSON over HTTP (port 4318).

```
SDK → Collector:  OTLP/gRPC on port 4317 (preferred, lower overhead)
SDK → Collector:  OTLP/HTTP on port 4318 (easier for browsers, firewalled envs)
Collector → Jaeger: Jaeger's native gRPC format or OTLP (Jaeger v1.35+ accepts OTLP)
```

In your Collector config you declare which ports it listens on:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
```

---

## Deployment patterns

### Pattern 1: Sidecar (per-task in ECS)

```
ECS Task:
  ├── app-container  →  OTLP → localhost:4317
  └── otel-collector →  receives, processes, exports
```

Pros: isolation, no single point of failure
Cons: more CPU/memory per task, Collector config replicated

### Pattern 2: Collector as a dedicated ECS service (gateway)

```
All app tasks  →  OTLP → otel-collector-service:4317
otel-collector-service → Jaeger, Prometheus, Quickwit
```

Pros: centralized, easier to scale and update
Cons: becomes a critical dependency, needs HA deployment

### Pattern 3: Agent + Gateway (two-tier)

```
App → local Collector agent (sidecar/daemonset) → Collector gateway → backends
```

The agent does minimal processing (batching, local buffer). The gateway does heavy processing (sampling decisions, enrichment, PII scrubbing). This is the production-grade pattern for large deployments.

---

## How data flows end to end (Winamax example)

```
1. HTTP POST /api/bet/place hits betting-api (Node.js)

2. OTel SDK (auto-instrumented) starts a root span:
   trace_id=7d3f2a1b  span_id=aa11bb22  operation=POST /api/bet/place

3. betting-api calls odds-service via HTTP:
   SDK adds headers: traceparent: 00-7d3f2a1b...-aa11bb22-01
   odds-service SDK reads headers → creates child span with same trace_id

4. All spans end → BatchSpanProcessor buffers them

5. Every N milliseconds (or when buffer full), SDK sends batch to Collector
   Protocol: OTLP/gRPC → localhost:4317

6. Collector receives spans:
   - Processor: redact player_name, card_number fields
   - Processor: tail-based sampling (keep 100% of errors, 10% of success)
   - Processor: add environment=production, region=eu-west-1 attributes

7. Collector exports:
   - Traces → Jaeger (gRPC)
   - Metrics → Prometheus scrapes /metrics endpoint on Collector

8. Jaeger stores trace, Grafana queries Jaeger for trace visualization
```

---

## The K8s analogy

| Kubernetes concept | OTel equivalent |
|---|---|
| Container image | OTel SDK (embedded in app) |
| DaemonSet for node-level collection | OTel Collector as sidecar/per-host agent |
| Prometheus scraping pods | Prometheus scraping Collector /metrics |
| ConfigMap for app config | OTel SDK config at startup |
| Kubernetes Service for backend | Collector address (OTLP endpoint) |

The conceptual model is the same: embed a lightweight agent in the workload, have it send to a central processor, which fans out to storage backends. The difference is that OTel is not Kubernetes-specific and works in any environment — which is why it fits Winamax's ECS-based infrastructure.
