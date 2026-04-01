# Module 2 Interview Questions — Observability

These are the questions Winamax will actually ask. Each answer is written in the voice you should use: direct, operational, connected to their context.

---

## Q1: Walk me through Winamax's observability stack. Why did you build it instead of buying it?

**Answer:**

Winamax built a fully self-hosted stack based on OpenTelemetry, Jaeger, Quickwit, Prometheus, and Grafana. The decision to not use SaaS tools is not about cost preference — it is about data confidentiality. Player data and bet data are protected under GDPR and French gambling regulations. Sending any telemetry to Datadog or New Relic would mean player-linked data leaving Winamax's infrastructure to a third-party SaaS. That is not acceptable.

The stack works like this: every service is instrumented with the OTel SDK, which sends traces and metrics to the OTel Collector. The Collector is where we apply privacy enforcement — PII fields are scrubbed in processor pipelines before data reaches any backend. Traces go to Jaeger, logs go to Quickwit on S3, metrics go to Prometheus, and everything is visualized in Grafana. The Collector is also where we do tail-based sampling — we cannot store 100% of traces at our volume, but we never drop an error trace.

---

## Q2: What is OpenTelemetry? How is it different from Jaeger or Prometheus?

**Answer:**

OpenTelemetry is a vendor-neutral standard and set of SDKs for generating and collecting telemetry. It is the instrumentation layer — it defines how spans are created, how metrics are recorded, how context propagates between services. OpenTelemetry does not store or query data.

Jaeger is a trace backend — it stores spans and lets you search and visualize traces. Prometheus is a metrics backend — it scrapes and stores time-series metrics. These are completely different concerns.

The power of OTel is the separation: you instrument once with the OTel SDK, send to the OTel Collector, and the Collector exports to whichever backends you choose. If Winamax decides tomorrow to replace Jaeger with Grafana Tempo, they change the Collector exporter config. Application code does not change. This is why OTel has become the industry standard — it prevents lock-in to any specific observability vendor.

---

## Q3: How does a trace span get from Service A to Service B?

**Answer:**

Through context propagation. When Service A makes an outbound HTTP call to Service B, the OTel SDK automatically injects the current trace context into the HTTP headers. The specific header is `traceparent`, defined by the W3C TraceContext standard. It contains the trace ID and the current span ID.

When Service B receives the request, its OTel SDK extracts the `traceparent` header and creates a new child span with the same trace ID and the parent span ID set to what Service A sent. The result is that both spans share a trace ID, so Jaeger can stitch them into a single trace tree.

For Kafka messages, the same concept applies but uses message headers instead of HTTP headers.

With auto-instrumentation, this happens automatically for standard HTTP clients and Kafka clients. The places where it breaks are: a service that does not forward the header, an async boundary that loses the active context, or a custom message queue client that does not copy headers.

---

## Q4: A developer reports that their service's traces are fragmented — they appear as separate unconnected traces instead of one tree. What do you investigate?

**Answer:**

This is almost always a context propagation issue. I would investigate in this order:

First, check if the service is actually reading the `traceparent` header. Check the auto-instrumentation configuration — is the http or express instrumentation enabled? If it was disabled or not loaded before the http module, it would not extract headers.

Second, check if the service is making outbound calls before OTel is initialized. If `instrumentation.js` is loaded after other modules, the http module is already imported and the auto-instrumentation patch did not apply.

Third, check async boundaries. If the service uses setTimeout, setImmediate, or worker threads without explicitly binding the OTel context, the context is lost. With `@opentelemetry/sdk-node` and Node.js AsyncLocalStorage, this is usually handled automatically, but custom async patterns may need explicit `context.bind()`.

Fourth, if the service uses a Kafka consumer: check that the consumer extracts the trace context from message headers. Not all Kafka instrumentation packages handle this — verify with `@opentelemetry/instrumentation-kafkajs`.

Finally, check if a proxy or load balancer between the services is stripping unknown HTTP headers.

---

## Q5: How do you sample traces at 75,000 messages/second without losing signal on errors?

**Answer:**

Tail-based sampling at the OTel Collector level. The key insight is that head-based sampling decides whether to keep a trace at the start — before you know if it will error or be slow. If you sample at 5% head-based, you will drop 95% of error traces. That is not acceptable.

Tail-based sampling buffers all spans until the trace completes, then applies policies. Our policies are: always keep traces where any span has status=ERROR, always keep traces that exceed 300ms latency, always keep traces on the critical betting and payment paths. For everything else — healthy, fast, non-critical traffic — we apply 5% probabilistic sampling.

The operational constraint is that tail sampling requires all spans of a trace to arrive at the same Collector instance. We handle this with consistent hash routing by trace ID across our Collector gateway cluster.

The trade-off: the Collector must buffer in-flight traces in memory. At 10,000 requests/sec with a 10-second decision window, that is roughly 100,000 traces in memory. We size the Collector appropriately and set a `memory_limiter` processor as the first stage so the Collector degrades gracefully under load rather than crashing.

---

## Q6: How do you prevent player data from ending up in your traces and logs?

**Answer:**

Three layers.

First, developer standards: we define what is allowed in telemetry — IDs, enum values, counts, durations — and what is not: names, emails, amounts, any user-provided string. The instrumentation guide makes this explicit. When developers add manual spans, they know the rules.

Second, SDK configuration: we configure the OTel auto-instrumentation to suppress the most dangerous default behaviors. The `db.statement` capture is the biggest risk — SQL queries often contain parameter values that may include player data. We override the `dbStatementSerializer` to capture only the SQL operation type, not the full query.

Third, the Collector processor: this is the enforcement layer that protects us even if an application makes a mistake. Every pipeline runs an `attributes` processor that deletes any field that should never reach a backend — `player.name`, `player.email`, `db.statement`, `http.client_ip`. This runs before the export step, so the backends never see PII even if it was accidentally included in a span.

And the final layer: all backends are self-hosted. No telemetry ever reaches a third-party SaaS.

---

## Q7: What is an OTel Collector pipeline, and why does it matter?

**Answer:**

A pipeline is the data flow path within the Collector: receivers → processors → exporters. Data enters through receivers (e.g., OTLP from your services), flows through processors in order, and exits through exporters to backends.

The processors are where the value is. Without processors, the Collector is just a forwarder. With processors, it is a transformation layer: you can filter out noise (health check spans), enrich data (add deployment environment), enforce privacy (delete PII fields), make sampling decisions (tail-based sampling), and batch for efficiency.

Why it matters architecturally: you can add new observability capabilities across all 700 services by changing Collector configuration, without touching application code. If we need to start redacting a new PII field, we add one line to the Collector's attributes processor. That change applies immediately to all services. Compare that to requiring 700 teams to update their instrumentation code.

---

## Q8: How does Prometheus discover ECS tasks to scrape?

**Answer:**

Prometheus has a pull model — it needs to know the address and port of every target it should scrape. In Kubernetes, this is solved by the Kubernetes API and ServiceMonitors. In ECS, there is no native equivalent.

The three approaches: first, static configuration if you have a fixed number of Collector instances with stable DNS names — this is the simplest and works well when you route all metrics through the OTel Collector as a metric aggregation layer.

Second, EC2 service discovery — Prometheus queries the EC2 API to find instances, then uses ECS agent metadata or custom tags to find which tasks are running on each instance.

Third, file-based service discovery — a sidecar or Lambda polls AWS Cloud Map or the ECS API and writes a targets.json file that Prometheus reads.

For Winamax, I would use the OTel Collector as the Prometheus aggregation point. The Collector exposes a `/metrics` endpoint, and Prometheus scrapes the Collector. Since the Collector receives metrics from all services via OTLP push, Prometheus only needs to discover the Collector instances, which have stable DNS names as ECS service discovery entries. This eliminates the per-service Prometheus discovery problem entirely.

---

## Q9: What is Quickwit and why use it over Elasticsearch?

**Answer:**

Quickwit is a log search engine that indexes and queries data stored on object storage — S3 or compatible. It is designed specifically for immutable, append-only log data, which is exactly what observability logs are.

Elasticsearch stores its indexes on attached SSD disk. For a company generating terabytes of logs per day, that means running a large Elasticsearch cluster with expensive attached disk, managing shards, handling rebalancing, and paying accordingly.

Quickwit stores its indexes on S3. The cost difference is significant: S3 Standard is about $0.023/GB/month versus $0.1-0.2/GB/month for provisioned SSD. At Winamax's log volume, Quickwit on S3 could be an order of magnitude cheaper than Elasticsearch.

The trade-off is query latency — recent data is fast (under a second), older data takes a few seconds as the Searcher fetches index segments from S3. For log debugging in an incident, that is acceptable. For a millisecond-sensitive query? That is not what you use log search for.

The other factor is operational overhead: Quickwit has no shard management, no cluster rebalancing, no hot/warm tier management. S3 manages durability. Winamax's SRE team manages the Quickwit processes, not the storage.

---

## Q10: The betting API P99 latency spiked to 800ms at 21:03. Walk me through your debugging process.

**Answer:**

I start in Grafana. I pull up the betting-api service dashboard, confirm the P99 latency spike at 21:03, and check the other golden signals: error rate (to know if bets are failing, not just slow), traffic (to see if it is a load issue), and saturation (CPU, memory, connection pool).

If the error rate is also elevated, I go to traces first. In Jaeger or Grafana's Explore view, I filter for traces on the betting-api service from 21:03 with duration over 500ms. I look for the common pattern — which span is consistently slow across the affected traces.

If I see a pattern — say, the `db.insert-bet` span is 600ms on all slow traces — I click on one trace to see the span details: what database, what operation. Then I correlate to logs using the `trace_id` from that span: I search Quickwit for that trace_id and find the specific log lines from the db-service at that time.

If Grafana shows a metric exemplar linked to a trace, I can jump directly from the spike on the latency graph to a representative trace in Jaeger — that is the fastest path.

In this specific case: P99 at 800ms with a clear spike suggests something changed — a deployment, a database migration, a traffic shape change. I would check recent deployments (git history or CI/CD pipeline), check if a database migration ran around 21:00, and check if there is Kafka consumer lag on downstream services (backpressure can slow the critical path if the betting API waits for event processing).

The investigation always follows the same path: alert → dashboard → trace → log. Each step narrows the scope until you have the file, line, and operation causing the problem.
