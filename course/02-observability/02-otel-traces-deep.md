# Distributed Tracing Deep — Spans, Context Propagation, Sampling

---

## What a trace actually is

A trace is a **directed acyclic graph (DAG) of spans** that represents the full execution path of a single request across every service it touched.

```
Trace ID: 7d3f2a1b4e5c6d7e8f9a0b1c2d3e4f50

POST /api/bet/place  ──────────────────────────────────── 187ms
│
├─ auth.validate_token ──────── 12ms                      [auth-service]
│
├─ odds.get_current ─────────────────────── 34ms          [odds-service]
│   └─ db.query SELECT ───────────────── 31ms             [odds-db-proxy]
│
├─ bet.validate_slip ── 8ms                               [validation-service]
│
├─ kafka.publish bet_placed ──── 5ms                      [betting-api internal]
│
└─ db.insert bet ────────────────────────────────── 122ms [db-service]  ← SLOW
    └─ db.query INSERT INTO bets ──────────────── 119ms   [betting-db]
```

Every box is a **span**. The tree structure is the **trace**.

---

## What a span contains

A span is the atomic unit of a trace. Each span records:

```
SpanContext:
  trace_id:      7d3f2a1b4e5c6d7e8f9a0b1c2d3e4f50  (128-bit, shared across all spans)
  span_id:       9c8d7e6f5a4b3c2d                   (64-bit, unique to this span)
  parent_span_id: aa11bb22cc33dd44                  (ID of the span that called this one)
  trace_flags:   01                                 (sampled=true)

Span data:
  name:           "db.insert bet"
  kind:           CLIENT                            (INTERNAL, SERVER, CLIENT, PRODUCER, CONSUMER)
  start_time:     2026-04-01T21:03:42.183Z
  end_time:       2026-04-01T21:03:42.305Z
  duration:       122ms

Attributes (key-value pairs):
  db.system:       "postgresql"
  db.name:         "bets"
  db.operation:    "INSERT"
  net.peer.name:   "betting-db.internal"
  http.status_code: 200
  # Note: NO player data, NO bet amounts — see 02-privacy.md

Events (timestamped log-like entries within the span):
  21:03:42.200: "connection acquired from pool"
  21:03:42.301: "query returned 1 row"

Status:
  code: OK   (or ERROR)
  message: "" (error description if status=ERROR)

Links:
  (optional: links to other traces, e.g. the Kafka message that triggered this request)
```

---

## Context propagation — the mechanism that makes distributed tracing work

Context propagation is how a trace ID "travels" from one service to another. Without it, each service creates an isolated trace fragment — you cannot connect them.

### The W3C TraceContext standard

OTel uses the W3C TraceContext specification. The trace context is carried in HTTP headers:

```
traceparent: 00-7d3f2a1b4e5c6d7e8f9a0b1c2d3e4f50-aa11bb22cc33dd44-01
             ^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^  ^^
             version   trace_id (128-bit hex)       parent_span_id   flags

tracestate: winamax=custom-value  (optional vendor-specific data)
```

### How it flows through a request

```
1. betting-api receives POST /api/bet/place (no traceparent header)
   OTel SDK generates new trace_id = 7d3f2a1b...
   Creates root span: parent_span_id = null

2. betting-api calls odds-service via HTTP
   OTel SDK (auto-instrumentation) INJECTS traceparent header:
   traceparent: 00-7d3f2a1b...-[current_span_id]-01

3. odds-service receives the HTTP request
   OTel SDK (auto-instrumentation) EXTRACTS traceparent header
   Creates child span with:
     trace_id = 7d3f2a1b...  (same as parent)
     parent_span_id = [betting-api's span_id]

4. When odds-service calls its database, it creates another child span
   All spans share the same trace_id
```

### Context propagation in Kafka

HTTP headers are straightforward. Kafka is slightly different — trace context goes into **message headers**:

```javascript
// Producer side: inject context into Kafka message headers
const headers = {};
propagator.inject(context.active(), headers, {
  set: (carrier, key, value) => { carrier[key] = Buffer.from(value); }
});
producer.send({ topic: 'bet-placed', messages: [{ value: payload, headers }] });

// Consumer side: extract context from Kafka message headers
const ctx = propagator.extract(context.active(), message.headers, {
  get: (carrier, key) => carrier[key]?.toString(),
  keys: (carrier) => Object.keys(carrier),
});
// Create span as child of extracted context
tracer.startActiveSpan('process-bet-placed', { context: ctx }, span => { ... });
```

With auto-instrumentation, `@opentelemetry/instrumentation-kafkajs` handles this automatically for kafkajs. If you use a custom Kafka client, you must implement this manually.

### What breaks context propagation

This is a critical operational concept. Propagation breaks when:

1. **A service does not forward the header** — receives `traceparent`, makes outbound calls, but does not attach it
2. **A service recreates the context** — reads the header but creates a new trace_id instead of using the received one
3. **A message queue strips headers** — some queue clients or proxies do not copy message headers
4. **A load balancer strips headers** — uncommon, but some configs strip unknown headers
5. **Async boundary without context** — using `setTimeout` or a Promise without capturing the active context

```javascript
// WRONG — context lost across setTimeout
const span = tracer.startSpan('my-operation');
setTimeout(() => {
  // span is NOT in the active context here
  doWork();
  span.end();
}, 100);

// CORRECT — preserve context explicitly
const span = tracer.startSpan('my-operation');
const ctx = trace.setSpan(context.active(), span);
setTimeout(context.bind(ctx, () => {
  doWork();
  span.end();
}), 100);
```

With `@opentelemetry/sdk-node` auto-instrumentation, most async patterns (Promise, async/await, callbacks) are handled via `AsyncLocalStorage`. Custom callback patterns may require explicit context binding.

---

## Span kinds

Span kind tells you the role of the span in the request:

| Kind | Meaning | Example |
|---|---|---|
| `SERVER` | Receives an inbound request | HTTP server handling POST /bet |
| `CLIENT` | Makes an outbound request | HTTP client calling odds-service |
| `PRODUCER` | Publishes to a message queue | Kafka producer |
| `CONSUMER` | Reads from a message queue | Kafka consumer |
| `INTERNAL` | Internal operation, no network | validate-bet-slip business logic |

Why it matters: Jaeger uses span kind to draw the call direction in the trace UI. CLIENT spans connect to SERVER spans across service boundaries.

---

## Sampling — the most important operational decision

At 75,000 messages/second, keeping 100% of traces is not feasible. A single trace can be 10-50KB. At 75k/sec, that is 3.75+ GB/sec just of raw trace data. You need a sampling strategy.

### Head-based sampling

The sampling decision is made at the **start** of the trace (at the root span). All downstream spans inherit the decision.

```
Root span created → coin flip (10%) → if sampled, ALL spans in trace are kept
                                    → if not sampled, NO spans are kept
```

Pros: simple, low overhead, decision is propagated automatically via `trace_flags` in `traceparent`
Cons: you cannot preferentially keep traces that turn out to be errors or slow — you decided before you knew

```javascript
// Head-based sampling in SDK config
const sdk = new NodeSDK({
  sampler: new TraceIdRatioBased(0.1),  // keep 10% of traces
});
```

### Tail-based sampling (what Winamax should use)

The sampling decision is deferred until the **trace is complete**. The Collector buffers all spans for a trace, waits for the root span to complete, then decides whether to keep or drop the trace.

```
All spans arrive at Collector → buffer → trace complete? 
  → if ANY span has status=ERROR → keep
  → if trace duration > 500ms → keep
  → otherwise → 10% chance of keeping
```

Pros: you always keep error traces and slow traces — maximum signal
Cons: requires the Collector to buffer and hold in-memory state; adds latency; must route all spans of a trace to the same Collector instance

```yaml
# In OTel Collector config
processors:
  tail_sampling:
    decision_wait: 10s  # wait up to 10s for all spans of a trace
    policies:
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}
      - name: slow-traces-policy
        type: latency
        latency: {threshold_ms: 500}
      - name: probabilistic-policy
        type: probabilistic
        probabilistic: {sampling_percentage: 10}
```

**For Winamax:** Tail-based sampling is the right choice. You cannot afford to miss an error trace on the betting path. Use the Collector's `tail_sampling` processor with error and latency policies at 100%, and probabilistic sampling at 5-10% for normal traces.

### Parent-based sampling

If the incoming request already has a sampling decision (`trace_flags` bit set), honor it. This is what downstream services use so the sampling decision made at the entry point propagates consistently.

```javascript
// Typical production setup: parent-based wrapping ratio-based
new ParentBasedSampler({
  root: new TraceIdRatioBased(0.1),  // 10% for new traces (no parent)
  remoteParentSampled: new AlwaysOnSampler(),    // honor upstream decision to sample
  remoteParentNotSampled: new AlwaysOffSampler(), // honor upstream decision to drop
});
```

---

## Trace attributes — what to add, what to avoid

### Semantic conventions

OTel defines standard attribute names so all services use consistent naming. Always prefer semantic conventions over custom names.

```
HTTP:
  http.method, http.url, http.status_code, http.route

DB:
  db.system, db.name, db.operation, db.statement (be careful — may contain PII)

Messaging:
  messaging.system, messaging.destination, messaging.message_id

Service:
  service.name, service.version, deployment.environment
```

### What NOT to put in span attributes

See `02-privacy.md` for the full guide. Summary:

```
❌ player.name, player.email, player.phone
❌ bet.amount (raw financial data)
❌ card.number, card.cvv
❌ session.token, auth.token

✓ player.id (internal ID, not PII itself)
✓ bet.id (reference ID)
✓ bet.type (e.g., "single", "accumulator")
✓ error.type, error.message (sanitized, no data values)
```

---

## Reading a trace in Jaeger — what to look for

When debugging a latency spike:

1. **Span timeline** — which span takes the most wall-clock time?
2. **Gaps between spans** — time between parent starting a child and the child starting = network/queue time
3. **Parallel vs sequential spans** — parallel calls are fine; unnecessary sequential calls waste time
4. **Error spans** — red spans = errors; click for the error message and stack trace
5. **Attributes on slow spans** — `db.statement`, `http.url` tell you exactly what the slow operation was

```
Common patterns to recognize:

"Staircase pattern" — each service waits for the previous to finish
→ N sequential RPCs, each adding latency. Fix: parallelize where possible.

"Fat leaf span" — all time is in one leaf (e.g., a DB query)
→ Query optimization, missing index, connection pool exhaustion

"Cascade of errors" — one service fails, all callers fail with it
→ Single point of failure, missing circuit breaker

"Ghost spans" — trace has gaps with no child spans covering the time
→ Uninstrumented code, async boundary losing context
```
