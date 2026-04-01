// instrumentation.js
// Load this file BEFORE any other module:
//   node --require ./instrumentation.js bet-validator.js
// Or via environment:
//   NODE_OPTIONS=--require ./instrumentation.js

'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
const { ParentBasedSampler, TraceIdRatioBased } = require('@opentelemetry/sdk-trace-base');

const collectorEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4317';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'bet-validator',
    [ATTR_SERVICE_VERSION]: process.env.APP_VERSION || '0.0.0',
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),

  // Sampler: honor parent decision if set; otherwise sample 10% of new traces
  // The Collector's tail_sampling will make the final keep/drop decision
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBased(0.1),
  }),

  traceExporter: new OTLPTraceExporter({
    url: collectorEndpoint,
  }),

  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: collectorEndpoint }),
    exportIntervalMillis: 15000,
  }),

  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable filesystem instrumentation — too noisy
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },

      // HTTP instrumentation: ignore health check endpoint
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => {
          return req.url === '/health' || req.url === '/metrics' || req.url === '/ready';
        },
      },

      // pg instrumentation: DISABLE db.statement capture
      // SQL queries may contain player IDs or bet data in query parameters
      '@opentelemetry/instrumentation-pg': {
        dbStatementSerializer: (operation) => {
          // Only capture the SQL keyword (SELECT, INSERT, etc.), not the full query
          return operation;
        },
        // Don't capture query parameters/values at all
        enhancedDatabaseReporting: false,
      },
    }),
  ],
});

sdk.start();

// Graceful shutdown: flush buffered spans before process exits
// ECS sends SIGTERM when stopping a task
process.on('SIGTERM', async () => {
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('OTel SDK shutdown error:', err);
  } finally {
    process.exit(0);
  }
});

process.on('SIGINT', async () => {
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('OTel SDK shutdown error:', err);
  } finally {
    process.exit(0);
  }
});
