# Hands-On Lab 04 — Prometheus + Grafana Locally

## Goal

Run Prometheus and Grafana locally, instrument a toy app with OTel, write the four golden signal PromQL queries from memory, and build an alert rule. Do not look at the course material while doing this.

**Time required:** 1.5–2 hours  
**Prerequisites:** Docker Compose, Node.js

---

## Part 1: Start the stack

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - ./alert_rules.yml:/etc/prometheus/alert_rules.yml
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=1d'

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana

volumes:
  grafana-data:
```

Create `prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "alert_rules.yml"

scrape_configs:
  - job_name: 'betting-api'
    static_configs:
      - targets: ['host.docker.internal:8080']
        labels:
          service: 'betting-api'
          env: 'local'
```

Create `alert_rules.yml` — **write this from memory first, then check:**

```yaml
groups:
  - name: betting_api
    rules:
      # Write alert rules for:
      # 1. Error rate > 5% for 2 minutes
      # 2. P99 latency > 500ms for 3 minutes
      # 3. Request rate dropped to 0 (service down)
```

```bash
docker compose up -d
```

---

## Part 2: Instrument a Node.js app with OTel

Create `betting-api.js`:

```javascript
'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { httpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { MeterProvider } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const http = require('http');

// Set up Prometheus metrics exporter
const exporter = new PrometheusExporter({ port: 8080 });
const meterProvider = new MeterProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'betting-api',
  }),
});
meterProvider.addMetricReader(exporter);

const meter = meterProvider.getMeter('betting-api');

// Create metrics
const requestCounter = meter.createCounter('http_requests_total', {
  description: 'Total HTTP requests',
});

const requestDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const route = req.url.split('?')[0];

  // Simulate different latencies for different routes
  let latency = 10;
  let status = 200;

  if (route === '/api/bet/place') {
    latency = Math.random() < 0.05 ? 800 : 50 + Math.random() * 50; // 5% slow
    if (Math.random() < 0.02) status = 500; // 2% errors
  } else if (route === '/api/odds') {
    latency = 5 + Math.random() * 10;
  } else if (route === '/health') {
    latency = 1;
  } else if (route === '/metrics') {
    // Prometheus scrapes here — handled by the exporter
    // The exporter listens on its own port (8080), not this server
    res.writeHead(404);
    res.end('use port 8080 for metrics');
    return;
  }

  await new Promise(r => setTimeout(r, latency));

  // Record metrics
  requestCounter.add(1, { route, status: String(status), method: req.method });
  requestDuration.record((Date.now() - start) / 1000, { route, status: String(status) });

  res.writeHead(status);
  res.end(status === 200 ? `{"status":"ok","route":"${route}"}` : '{"error":"internal"}');
});

server.listen(3000, () => {
  console.log('betting-api listening on port 3000');
  console.log('metrics available at http://localhost:8080/metrics');
});
```

```bash
npm init -y
npm install @opentelemetry/sdk-node @opentelemetry/exporter-prometheus \
  @opentelemetry/sdk-metrics @opentelemetry/resources \
  @opentelemetry/semantic-conventions @opentelemetry/instrumentation-http

node betting-api.js
```

Verify metrics are available:
```bash
curl http://localhost:8080/metrics | grep http_requests
```

---

## Part 3: Generate traffic

```bash
# Generate continuous traffic (run in a background terminal)
while true; do
  curl -s http://localhost:3000/api/bet/place > /dev/null
  curl -s http://localhost:3000/api/odds > /dev/null
  curl -s http://localhost:3000/health > /dev/null
  sleep 0.1
done &

# Generate a burst of traffic to see rate changes
for i in $(seq 1 200); do
  curl -s http://localhost:3000/api/bet/place > /dev/null &
done
wait
```

---

## Part 4: Write PromQL queries from memory

Go to Prometheus at http://localhost:9090. Write these queries **without looking at your notes**. Verify they return data.

**Query 1 — Requests per second for betting-api:**
```
# Write this yourself first
```

Reference:
```promql
sum(rate(http_requests_total{service="betting-api"}[5m]))
```

**Query 2 — Error ratio (5xx / total):**
```
# Write this yourself first
```

Reference:
```promql
sum(rate(http_requests_total{service="betting-api", status=~"5.."}[5m]))
/
sum(rate(http_requests_total{service="betting-api"}[5m]))
```

**Query 3 — P99 latency:**
```
# Write this yourself first
# Remember: what label is required for histogram_quantile?
```

Reference:
```promql
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{service="betting-api"}[5m])) by (le)
)
```

**Query 4 — P99 latency per route:**
```
# Add a by clause to see latency per endpoint
```

Reference:
```promql
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{service="betting-api"}[5m])) by (le, route)
)
```

**Query 5 — Rate of change of error ratio (is it getting worse?):**
```promql
deriv(
  (sum(rate(http_requests_total{status=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m])))[10m:]
)
```

---

## Part 5: Write alert rules

Write `alert_rules.yml` from scratch. Do not look at the reference until after:

```yaml
groups:
  - name: betting_api_alerts
    rules:
      - alert: HighErrorRate
        # Fill in: expr, for, labels, annotations
        
      - alert: HighP99Latency
        # Fill in
        
      - alert: ServiceDown
        # Fill in: how do you detect when request rate drops to 0?
```

Reference:
```yaml
groups:
  - name: betting_api_alerts
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
          /
          sum(rate(http_requests_total[5m]))
          > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Error rate above 5% for 2 minutes"
          description: "Current error rate: {{ printf \"%.2f\" $value | humanizePercentage }}"

      - alert: HighP99Latency
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route)
          ) > 0.5
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "P99 latency above 500ms on {{ $labels.route }}"

      - alert: ServiceDown
        expr: absent(rate(http_requests_total[2m]))
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "betting-api appears to be down — no requests in 2 minutes"
```

Reload Prometheus config after writing:
```bash
curl -X POST http://localhost:9090/-/reload
```

Check alert status at http://localhost:9090/alerts.

---

## Part 6: Build a Grafana dashboard

Go to http://localhost:3001 (admin/admin).

Add Prometheus data source: http://prometheus:9090

Build a dashboard with 4 panels:
1. Requests per second — time series
2. Error rate % — stat or gauge with threshold coloring (green < 1%, yellow 1-5%, red > 5%)
3. P99 latency by route — time series with multiple series
4. Request rate per route — bar chart

**Do not use the import feature. Build each panel manually.**

---

## Part 7: The recording rule exercise

Without recording rules, the P99 query runs on every dashboard refresh for every panel that shows it. With 700 services, this adds up.

Add to `alert_rules.yml`:

```yaml
  - name: precomputed
    rules:
      - record: service:http_error_ratio:rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
          /
          sum(rate(http_requests_total[5m])) by (service)
```

Now update your error rate alert and dashboard to use `service:http_error_ratio:rate5m` instead of the full expression. The query runs once on the Prometheus server; all dashboards and alerts use the pre-computed result.

---

## Cleanup

```bash
# Stop traffic generator
kill %1

docker compose down -v
```
