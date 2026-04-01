# OTel Collector Deep — Pipelines, Processors, Exporters, Scaling

---

## The Collector is a pipeline, not a proxy

A proxy forwards data unchanged. The Collector transforms data. This distinction is why it exists.

```
receivers → [pipeline] → exporters

pipeline = receivers → processors → exporters
```

The power is in the **processors**: filter, sample, enrich, batch, redact, transform. Without processors, the Collector would just be a dumb forwarder.

---

## The configuration file structure

The Collector is configured in YAML. Every section maps to a pipeline component:

```yaml
# otel-collector-config.yaml

receivers:       # How data enters the Collector
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:      # What happens to data inside the Collector
  batch:         # Group spans into batches before exporting
  memory_limiter: # Prevent OOM under load
  tail_sampling: # Sampling decisions after trace completes
  attributes:    # Add/modify/delete attributes (for enrichment or PII scrubbing)

exporters:       # Where data goes out
  otlp/jaeger:
    endpoint: jaeger-collector:4317
    tls:
      insecure: true
  prometheus:
    endpoint: 0.0.0.0:8889  # Prometheus scrapes this
  otlp/quickwit:
    endpoint: quickwit:7281

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes, batch]
      exporters: [otlp/quickwit]
```

A service has multiple **pipelines** (one per signal type). Each pipeline is independent.

---

## Key processors — what each one does

### `batch` processor

Groups telemetry into batches before exporting. Without batching, every span triggers an export call — at 75k msg/sec, that would overwhelm the backends.

```yaml
processors:
  batch:
    send_batch_size: 512      # send when batch reaches this size
    send_batch_max_size: 1024 # never exceed this
    timeout: 5s               # send even if batch_size not reached after 5s
```

**Always include `batch` in every pipeline.** It is not optional at production scale.

### `memory_limiter` processor

Prevents the Collector from crashing with OOM when a traffic spike overwhelms it. When memory exceeds the limit, it starts dropping telemetry and returns errors to the sender.

```yaml
processors:
  memory_limiter:
    limit_mib: 512         # max memory
    spike_limit_mib: 128   # buffer for spikes
    check_interval: 1s
```

**Always put `memory_limiter` first in every pipeline.** It must be the first processor so it can shed load before other processors allocate memory.

```yaml
# Correct order:
processors: [memory_limiter, tail_sampling, attributes, batch]
#            ^^^^^^^^^^^^^^ FIRST
```

### `tail_sampling` processor

Makes sampling decisions after all spans of a trace have arrived. See `02-otel-traces-deep.md` for the sampling theory.

```yaml
processors:
  tail_sampling:
    decision_wait: 10s      # wait up to 10s for all spans
    num_traces: 50000       # how many traces to buffer in memory
    expected_new_traces_per_sec: 500

    policies:
      # Always keep error traces
      - name: keep-errors
        type: status_code
        status_code: {status_codes: [ERROR]}

      # Always keep slow traces (>500ms)
      - name: keep-slow-traces
        type: latency
        latency: {threshold_ms: 500}

      # Keep all traces for the critical betting path
      - name: keep-betting-path
        type: string_attribute
        string_attribute:
          key: http.route
          values: ["/api/bet/place", "/api/bet/settle"]

      # Keep 5% of all other traces
      - name: probabilistic-sample
        type: probabilistic
        probabilistic: {sampling_percentage: 5}
```

**Tail sampling requires all spans of a trace to arrive at the SAME Collector instance.** This is a key constraint for scaling (see scaling section below).

### `attributes` processor

Add, modify, or delete span/metric/log attributes. The primary tool for:
- Enrichment: add `deployment.environment`, `region`, `team` to every span
- PII scrubbing: delete or hash sensitive fields before export

```yaml
processors:
  attributes/enrich:
    actions:
      - key: deployment.environment
        value: production
        action: insert          # insert if not present
      - key: region
        value: eu-west-1
        action: upsert          # insert or overwrite

  attributes/scrub-pii:
    actions:
      # Delete fields that may contain PII
      - key: player.name
        action: delete
      - key: player.email
        action: delete
      - key: db.statement      # SQL may contain values
        action: delete
      # Hash a field instead of deleting (keeps cardinality for debugging)
      - key: player.id
        action: hash            # replaces value with SHA256 hash
```

### `filter` processor

Drop telemetry entirely based on conditions. Useful for noise reduction:

```yaml
processors:
  filter/drop-health-checks:
    traces:
      span:
        # Drop spans for health check endpoints
        - 'attributes["http.route"] == "/health"'
        - 'attributes["http.route"] == "/metrics"'
    metrics:
      metric:
        # Drop metrics from test services
        - 'resource.attributes["deployment.environment"] == "test"'
```

### `transform` processor

More powerful than `attributes` — allows arbitrary expression-based transformations using OTTL (OpenTelemetry Transformation Language):

```yaml
processors:
  transform/sanitize:
    trace_statements:
      - context: span
        statements:
          # If span name contains "SELECT", keep only the operation type
          - set(name, "db.query") where name startsWith "SELECT"
          # Redact the db.statement value but keep the attribute key
          - set(attributes["db.statement"], "REDACTED") where attributes["db.statement"] != nil
```

---

## Receivers — how data enters

### OTLP receiver (primary)

Receives data from OTel SDKs and other Collectors.

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        max_recv_msg_size_mib: 4
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins: ["*"]  # for browser-side tracing
```

### Prometheus receiver (pull)

Scrapes Prometheus-format metrics from services. The Collector acts as a Prometheus scraper:

```yaml
receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: 'betting-api'
          scrape_interval: 15s
          static_configs:
            - targets: ['betting-api:9090']
```

### Kafka receiver

Consume telemetry data from a Kafka topic (for fan-out patterns):

```yaml
receivers:
  kafka:
    brokers: ["kafka-broker-1:9092", "kafka-broker-2:9092"]
    topic: otel-spans
    encoding: otlp_proto
```

---

## Exporters

### OTLP exporter (to Jaeger)

```yaml
exporters:
  otlp/jaeger:
    endpoint: jaeger-collector.monitoring:4317
    tls:
      insecure: true  # or configure certs for production
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
    sending_queue:
      enabled: true
      num_consumers: 10
      queue_size: 1000
```

### Prometheus exporter (metrics)

The Collector exposes a `/metrics` endpoint and Prometheus scrapes it:

```yaml
exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: winamax
    resource_to_telemetry_conversion:
      enabled: true  # converts resource attributes to metric labels
```

---

## Full production pipeline example (Winamax-style)

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  memory_limiter:
    limit_mib: 512
    spike_limit_mib: 128
    check_interval: 1s

  attributes/enrich:
    actions:
      - key: deployment.environment
        value: ${env:ENVIRONMENT}
        action: upsert
      - key: region
        value: eu-west-1
        action: upsert

  attributes/scrub-pii:
    actions:
      - key: player.name
        action: delete
      - key: player.email
        action: delete
      - key: player.phone
        action: delete
      - key: db.statement
        action: delete

  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: keep-errors
        type: status_code
        status_code: {status_codes: [ERROR]}
      - name: keep-slow
        type: latency
        latency: {threshold_ms: 500}
      - name: keep-critical-paths
        type: string_attribute
        string_attribute:
          key: service.name
          values: ["betting-api", "payment-service", "auth-service"]
      - name: probabilistic
        type: probabilistic
        probabilistic: {sampling_percentage: 5}

  batch:
    send_batch_size: 512
    timeout: 5s

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
    sending_queue:
      enabled: true
      queue_size: 5000

  prometheus:
    endpoint: "0.0.0.0:8889"

  otlp/quickwit:
    endpoint: quickwit:7281
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, attributes/scrub-pii, attributes/enrich, tail_sampling, batch]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, attributes/enrich, batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes/scrub-pii, attributes/enrich, batch]
      exporters: [otlp/quickwit]
```

---

## Scaling the Collector

### The tail-sampling constraint

Tail sampling requires all spans of a trace to arrive at the same Collector instance (so it can make the decision when the trace completes). This means you cannot randomly load-balance traces across multiple Collectors.

**Solution: two-tier deployment**

```
Apps → Collector Agents (sidecar, one per task)
                      ↓ consistent hash routing by trace_id
          Collector Gateways (2-N instances, stateful)
                      ↓
               Jaeger / Backends
```

- **Agent**: thin, no tail sampling, just receives, enriches, and forwards. Routes spans to the gateway using the trace_id as the hash key (consistent hashing ensures all spans of a trace go to the same gateway).
- **Gateway**: does tail sampling, heavy processing, buffering.

```yaml
# Agent config: forward with consistent hash routing
exporters:
  loadbalancing:
    protocol:
      otlp:
        tls:
          insecure: true
    resolver:
      dns:
        hostname: otel-gateway.monitoring.svc.cluster.local
        port: 4317
    routing_key: "traceID"  # consistent hash by trace ID
```

### Sizing the Collector

| Factor | Guidance |
|---|---|
| Memory | `num_traces × average_trace_size`. 100k traces × 10KB = 1GB. Add buffer. |
| CPU | Depends on processor complexity. Start with 1 CPU per Collector, benchmark. |
| Queue size | Size for maximum burst. If Jaeger is slow, queue absorbs the backlog. |
| `decision_wait` | Must be > your maximum trace duration. For Winamax: 10-30s is safe. |

### Horizontal scaling

Multiple Collector gateways behind a load balancer, but with consistent hashing by trace_id. Without consistent hashing, a trace's spans go to different instances and tail sampling cannot make a complete decision.

In ECS: run Collector gateways as an ECS service with 2-4 tasks behind an NLB (Network Load Balancer with consistent hash target group).
