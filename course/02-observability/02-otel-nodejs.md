# OTel Auto-Instrumentation for Node.js

Node.js is Winamax's dominant backend language. Understanding how OTel works in Node.js specifically — not just conceptually — is important for this role.

---

## How auto-instrumentation works in Node.js

Auto-instrumentation uses **monkey-patching**: the OTel SDK wraps well-known library functions at import time to add span creation automatically, without you changing business logic code.

```javascript
// What happens under the hood when auto-instrumentation is active:

// ORIGINAL express handler (your code, unchanged)
app.get('/api/odds/:matchId', async (req, res) => {
  const odds = await db.query('SELECT * FROM odds WHERE match_id = $1', [req.params.matchId]);
  res.json(odds.rows);
});

// WHAT OTEL DOES automatically (you do not write this):
// 1. Wraps express routing → creates SERVER span for GET /api/odds/:matchId
// 2. Wraps pg (PostgreSQL) query → creates CLIENT span for db.query
// 3. Reads traceparent header from req → uses as parent
// 4. Adds span.setAttributes({ 'http.method': 'GET', 'http.route': '/api/odds/:matchId', ... })
// 5. Closes both spans when promises resolve
// 6. Records status ERROR if the handler throws
```

This is why it is called "zero-code instrumentation" — you do not touch business logic.

---

## Setup: the instrumentation file

The instrumentation file must be loaded **before any other module**. This is critical. If express or pg loads before the OTel SDK patches them, the patches do not apply.

```javascript
// instrumentation.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'betting-api',
    [ATTR_SERVICE_VERSION]: process.env.APP_VERSION || '0.0.0',
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),

  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
  }),

  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
    }),
    exportIntervalMillis: 10000,  // export every 10 seconds
  }),

  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable file system instrumentation — too noisy
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // Configure HTTP instrumentation
      '@opentelemetry/instrumentation-http': {
        // Don't trace health check endpoints — noise, not signal
        ignoreIncomingRequestHook: (req) => req.url === '/health' || req.url === '/metrics',
      },
      // Configure pg instrumentation
      '@opentelemetry/instrumentation-pg': {
        // Don't capture db.statement — may contain query parameters that are PII
        dbStatementSerializer: (operation, queryConfig) => operation,
      },
    }),
  ],
});

sdk.start();

// Graceful shutdown: flush remaining spans before process exits
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
```

### How to load it

```bash
# Option 1: NODE_OPTIONS (recommended — no code change needed)
NODE_OPTIONS="--require ./instrumentation.js" node server.js

# Option 2: --require flag directly
node --require ./instrumentation.js server.js

# Option 3: In package.json scripts
{
  "scripts": {
    "start": "node --require ./instrumentation.js server.js"
  }
}
```

In your ECS task definition / Docker environment:
```json
{
  "environment": [
    { "name": "NODE_OPTIONS", "value": "--require /app/instrumentation.js" },
    { "name": "OTEL_SERVICE_NAME", "value": "betting-api" },
    { "name": "OTEL_EXPORTER_OTLP_ENDPOINT", "value": "http://otel-collector:4317" }
  ]
}
```

---

## What gets instrumented automatically

The `getNodeAutoInstrumentations()` package includes instrumentations for:

| Library | What gets traced |
|---|---|
| `http` / `https` | All inbound HTTP requests (SERVER spans) + outbound calls (CLIENT spans) |
| `express` / `fastify` / `koa` | Route matching, middleware timing |
| `pg` (PostgreSQL) | Every query — db name, operation, duration |
| `mysql` / `mysql2` | Same as pg |
| `mongodb` | Every operation |
| `redis` | Every command |
| `kafkajs` | Producer `send` (PRODUCER spans) + consumer `run` (CONSUMER spans) |
| `@aws-sdk/client-*` | AWS SDK calls — S3, DynamoDB, SQS, etc. |
| `grpc-js` | gRPC calls both directions |
| `dns` | DNS lookups (useful for debugging name resolution latency) |

**What is NOT auto-instrumented:**
- Your business logic (custom functions, calculations, loops)
- Third-party HTTP clients that are not `http`/`https` (e.g., raw TCP)
- Custom message queue clients that are not kafkajs

---

## Manual instrumentation for business logic

Auto-instrumentation gives you the infrastructure layer. For business logic spans, you add them manually:

```javascript
const { trace, context, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('betting-service');

async function validateBetSlip(betSlip) {
  // Start a span for this business operation
  return tracer.startActiveSpan('bet.validate_slip', async (span) => {
    try {
      span.setAttributes({
        'bet.id': betSlip.id,
        'bet.type': betSlip.type,          // OK — not PII
        'bet.selection_count': betSlip.selections.length,
        // DO NOT: 'bet.amount': betSlip.amount — financial data
        // DO NOT: 'player.name': betSlip.playerName — PII
      });

      if (betSlip.selections.length > 20) {
        span.addEvent('validation.warning', {
          reason: 'too_many_selections',
          count: betSlip.selections.length,
        });
      }

      const result = await runValidationRules(betSlip);

      if (!result.valid) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.reason });
        span.setAttributes({ 'bet.validation.failure_reason': result.reason });
      }

      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

### `startActiveSpan` vs `startSpan`

```javascript
// startActiveSpan — sets the span as ACTIVE in the current context
// Child spans and auto-instrumented calls will automatically use it as parent
tracer.startActiveSpan('outer', (span) => {
  // any spans created here (including auto-instrumented db calls) will be children
  await db.query('...');  // creates child span automatically
  span.end();
});

// startSpan — creates a span but does NOT set it as active
// Use when you need manual context control
const span = tracer.startSpan('my-span');
// db.query here would NOT be a child of my-span
span.end();
```

Prefer `startActiveSpan` for most cases.

---

## Adding custom metrics

OTel metrics in Node.js work through the `MeterProvider` from the SDK:

```javascript
const { metrics } = require('@opentelemetry/api');

const meter = metrics.getMeter('betting-service');

// Counter — for totals
const betPlacedCounter = meter.createCounter('bets.placed.total', {
  description: 'Total number of bets placed',
});

// Histogram — for latency distributions
const betValidationDuration = meter.createHistogram('bet.validation.duration', {
  description: 'Duration of bet validation in milliseconds',
  unit: 'ms',
});

// Gauge (UpDownCounter) — for values that go up and down
const activeWebsocketConnections = meter.createUpDownCounter('websocket.connections.active');

// Usage in business logic:
async function placeBet(betSlip) {
  const start = Date.now();
  try {
    const result = await validateBetSlip(betSlip);
    betPlacedCounter.add(1, {
      'bet.type': betSlip.type,
      'bet.valid': result.valid,
    });
    betValidationDuration.record(Date.now() - start, { 'bet.type': betSlip.type });
    return result;
  } catch (err) {
    betPlacedCounter.add(1, { 'bet.type': betSlip.type, 'bet.valid': false, 'error': true });
    throw err;
  }
}
```

---

## Connecting logs to traces

The most common missing piece: your logs and your traces should be correlated via `trace_id`. With OTel active, you can inject the current trace context into every log line:

```javascript
// Using pino (common Node.js logger)
const pino = require('pino');
const { trace, context } = require('@opentelemetry/api');

// Create a custom pino serializer that injects trace context
const logger = pino({
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const { traceId, spanId, traceFlags } = span.spanContext();
    return {
      trace_id: traceId,
      span_id: spanId,
      trace_flags: traceFlags,
    };
  },
});

// Now every log line automatically includes trace_id
logger.info({ bet_id: 'BET-98234', event: 'bet_validation_started' });
// Output: {"trace_id":"7d3f2a1b...","span_id":"aa11bb22...","bet_id":"BET-98234","event":"bet_validation_started"}
```

This `trace_id` is what lets you jump from a slow trace in Jaeger directly to the matching log lines in Quickwit.

---

## Environment variables for configuration

You can configure the OTel SDK entirely through environment variables — no code change needed. This is how you configure per-environment in ECS:

```bash
OTEL_SERVICE_NAME=betting-api
OTEL_SERVICE_VERSION=1.2.3
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1       # 10% sampling rate
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,team=platform
OTEL_PROPAGATORS=tracecontext,baggage  # W3C TraceContext + Baggage
```

---

## Common pitfalls in Node.js OTel

| Pitfall | Symptom | Fix |
|---|---|---|
| Instrumentation file loaded after other modules | No auto-instrumentation for those modules | Always use `--require` before any other `require` |
| No graceful shutdown | Last spans lost on SIGTERM | Add `sdk.shutdown()` on SIGTERM |
| Context lost in custom async code | Broken trace trees | Use `startActiveSpan` or explicit `context.bind()` |
| Missing `span.end()` on error paths | Memory leak, incomplete spans | Use try/finally |
| PII in span attributes | Privacy violation | Review all `setAttributes` calls |
| Health check endpoints traced | Noise in Jaeger | Use `ignoreIncomingRequestHook` |
| `db.statement` captured with parameters | SQL with PII values in trace | Override `dbStatementSerializer` |
