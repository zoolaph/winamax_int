# Module 2 Exercises — Observability

These four exercises cover the practical hands-on skills you will need. No AWS account or running infrastructure required — all configs can be written and validated locally.

---

## Exercise 1: Write a production OTel Collector config

**Scenario:** You are setting up the OTel Collector for Winamax's betting-api service. It runs on ECS and needs to:
- Receive traces and metrics from the OTel SDK via OTLP/gRPC
- Scrub PII fields from spans before export
- Apply tail-based sampling (keep all errors, keep all traces > 300ms, keep 5% of the rest)
- Export traces to Jaeger at `jaeger-collector.monitoring:4317`
- Export metrics to a Prometheus scrape endpoint on port 8889
- Enrich every span with `deployment.environment=production` and `region=eu-west-1`

**Deliverable:** A complete `otel-collector-config.yaml` file.

**Check your work against:** [solution-exercise-1.yaml](solution-exercise-1.yaml)

---

## Exercise 2: Write PromQL queries for the four golden signals

**Scenario:** You are building a Grafana dashboard for the betting-api. The service exports these metrics:

```
# Counter: HTTP requests by method, route, status code
http_requests_total{service, method, route, status}

# Histogram: request duration
http_request_duration_seconds_bucket{service, route, le}
http_request_duration_seconds_count{service, route}
http_request_duration_seconds_sum{service, route}

# Gauge: database connection pool
db_connection_pool_active{service, pool_name}
db_connection_pool_max{service, pool_name}

# Custom counter: bets placed
bets_placed_total{bet_type, valid}

# Gauge: Kafka consumer lag
kafka_consumer_lag{consumer_group, topic, partition}
```

**Write PromQL for:**

1. Requests per second for betting-api (all routes)
2. Error ratio (5xx / total) for betting-api
3. P99 latency for `POST /api/bet/place` specifically
4. Connection pool saturation (ratio: active/max) for betting-api
5. Kafka consumer lag alert threshold: fire when any partition in `betting-consumers` group exceeds 100,000 messages lag
6. A recording rule that pre-computes error ratio per service (all services, not just betting-api)

**Check your work against:** [solution-exercise-2.md](solution-exercise-2.md)

---

## Exercise 3: Instrument a Node.js service with OTel

**Scenario:** You have a Node.js Express service for bet validation:

```javascript
// bet-validator.js
const express = require('express');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.post('/validate', async (req, res) => {
  const { betId, playerId, selections } = req.body;

  // Check each selection's odds are still valid
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT match_id, odds FROM current_odds WHERE match_id = ANY($1)',
      [selections.map(s => s.matchId)]
    );

    const oddsMap = {};
    result.rows.forEach(row => {
      oddsMap[row.match_id] = parseFloat(row.odds);
    });

    const valid = selections.every(s =>
      Math.abs(oddsMap[s.matchId] - s.expectedOdds) < 0.001
    );

    res.json({ valid, betId });
  } finally {
    client.release();
  }
});

app.listen(3000);
```

**Tasks:**

1. Write the `instrumentation.js` file that:
   - Initializes the OTel SDK with the service name `bet-validator`
   - Uses auto-instrumentation for http, express, and pg
   - Disables `db.statement` capture (to avoid SQL with player data)
   - Ignores the `/health` endpoint
   - Exports to OTLP/gRPC at `http://otel-collector:4317`
   - Handles graceful shutdown

2. Add a manual span for the "validate odds" business logic with:
   - Span name: `bet.validate_odds`
   - Attributes: `bet.id`, `bet.selection_count`
   - Error recording if the check fails
   - **Without** including `player.id` in attributes

3. Write the Docker CMD or ECS task definition environment variable that loads the instrumentation file before the app

**Check your work against:** [solution-exercise-3/](solution-exercise-3/)

---

## Exercise 4: Design a sampling strategy

**Scenario:** You are designing the sampling strategy for Winamax's OTel Collector. Requirements:

- Services: 700+ microservices
- Kafka throughput: 75,000 messages/second
- Critical paths: bet placement, payment processing, user authentication
- SLO: 99.9% of bets placed successfully
- Storage budget: retain traces on S3 for 30 days
- Rough estimate: 10,000 HTTP requests/second across all services

**Answer these questions in writing:**

1. What type of sampling should you use — head-based or tail-based? Why?

2. What should the sampling policy look like? Define:
   - Which traces should always be kept (100%)
   - Which traces should be sampled at a lower rate
   - What the probabilistic rate should be for "normal" traces

3. What is the approximate volume of traces you will retain per day under your policy? (show the math)

4. The Collector gateway needs to hold in-memory state for tail sampling. With `decision_wait: 10s` and 10,000 requests/sec at 5% sampling rate, estimate the memory needed for the trace buffer. (rough order-of-magnitude is fine)

5. What happens to sampling when a Collector gateway crashes? How do you mitigate the data loss?

**Check your work against:** [solution-exercise-4.md](solution-exercise-4.md)
