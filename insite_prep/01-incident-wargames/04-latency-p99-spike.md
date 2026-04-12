# Wargame 04 — P99 Latency Spike: Betting API at 800ms

## The scenario

It is 21:03. Grafana fires an alert:

```
ALERT: BettingAPI_P99Latency
  expr: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{service="betting-api"}[5m])) > 0.5
  Value: 0.847
  
Current golden signals for betting-api (last 5 minutes):
  Traffic:     1,240 req/sec  (baseline: 1,100 req/sec — slightly elevated, match traffic)
  Error rate:  0.3%           (baseline: 0.2% — essentially normal)
  P99 latency: 847ms          (baseline: 120ms — 7x elevated)
  Saturation:  CPU 34%, Mem 61% (normal)
```

Error rate is normal. Traffic is slightly elevated. CPU and memory are fine. Only latency is affected.

---

## Your job

1. What does "high latency, normal error rate" tell you about the failure mode?
2. Walk through your investigation from alert to root cause — what do you look at and in what order?
3. What are the three most likely causes for a 7x latency spike with no errors?
4. How do traces help you here in a way metrics alone cannot?

**Speak through all four points before reading on.**

---
---
---
---
---
---

## Diagnosis path

### What "high latency, normal error rate" means

Requests are completing — they are not timing out or erroring. They are just slow. This rules out:
- Total downstream failure (would produce errors)
- Total service outage (would produce errors or no traffic)

What it points to:
- A slow dependency somewhere in the request path (database, external API, cache miss)
- Lock contention or queue buildup
- A new code path introduced in a recent deploy that is slower than the old one

### Step 1 — Check recent deploys

Before touching traces or logs: was there a deploy in the last 30 minutes?

```bash
# Check ECS service events for recent deployments
aws ecs describe-services \
  --cluster winamax-prod \
  --services betting-api \
  --query 'services[0].events[:5]'
```

A deploy at 20:55 that correlates with a latency spike at 21:03 is the most important signal. The 8-minute gap is typical for a rolling deploy to fully propagate.

### Step 2 — Go to Grafana, look at the span breakdown

Open the betting-api service dashboard. Look at:
1. P99 latency per endpoint — is it all endpoints or one specific route?
2. Downstream dependency latency — the dashboard should have panels for DB query duration, external API call duration, cache hit rate

If the latency is isolated to one endpoint (e.g., `POST /api/v2/bet/place`) but not others, it is specific to that endpoint's code path.

### Step 3 — Use traces to find the slow span

In Jaeger or Grafana Explore:

```
Service: betting-api
Min duration: 500ms
Time range: 21:00 - 21:10
```

Look for the pattern: which span is consistently slow across all the slow traces?

Click one slow trace. The waterfall view shows:
```
betting-api                          [847ms total]
├── auth-validate                    [12ms]
├── bet-validator.validate           [8ms]
├── db.select-user-balance           [3ms]
├── db.insert-bet                    [791ms]  ← this span is the slow one
└── kafka.produce bet-placed         [4ms]
```

The `db.insert-bet` span at 791ms is the root cause.

### Step 4 — Drill into the database span

From the trace, you have:
- `db.system`: postgresql
- `db.name`: winamax_bets
- `db.operation`: INSERT
- `db.statement`: INSERT INTO bets (user_id, event_id, amount, ...) — if captured

Check the database at this time:

```bash
# Connect to Aurora and check for locks
psql -h aurora-writer.winamax.internal -U readonly -c "
SELECT
  pid,
  now() - query_start AS duration,
  state,
  wait_event_type,
  wait_event,
  left(query, 100) AS query_excerpt
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC
LIMIT 20;"
```

If you see many rows with `wait_event_type = Lock` and `wait_event = relation` or `tuple`: there is lock contention on the bets table.

**Likely cause: a database migration is running**

A migration that ALTERs the bets table (adding a column, adding an index) takes a lock on the table. Every INSERT waits behind the lock. The migration was probably triggered just before the latency spike.

Check:

```bash
# Long-running queries
psql -c "
SELECT pid, now() - query_start AS duration, state, query
FROM pg_stat_activity
WHERE now() - query_start > interval '1 minute'
ORDER BY duration DESC;"

# Blocking queries
psql -c "
SELECT blocked.pid, blocked.query, blocking.pid AS blocking_pid, blocking.query AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid));"
```

If a migration is holding the lock: you have two options depending on urgency.

Option A (if migration is almost done): wait. It will release the lock and latency will recover.

Option B (if migration is stuck or will run for 30+ more minutes): kill the migration process and plan a safe migration path (using `pg_repack` or a non-blocking DDL approach like adding a column with a default separately from the NOT NULL constraint).

### Step 5 — Other causes if it's not a lock

**Cause B: Slow query from missing index**

The deploy added a new query that scans the bets table without an index. At normal traffic it was acceptable; at match traffic volume it is now 700ms.

Signal in traces: `db.insert-bet` span is slow but there are no blocking queries. `EXPLAIN ANALYZE` on the query shows Seq Scan.

Fix: add the index with `CREATE INDEX CONCURRENTLY` (non-blocking).

**Cause C: Connection pool exhaustion**

The deploy increased the number of ECS tasks and the connection pool is now exhausted. Requests queue waiting for a connection.

Signal: `db.select-user-balance` and `db.insert-bet` are both slow (pool contention affects all queries). `Threads_connected` on Aurora is at or near `max_connections`.

Fix: reduce pool size per task, or add RDS Proxy.

**Cause D: Redis cache miss storm**

The deploy cleared the Redis cache. All requests are going to the database cold. Cache hit rate metric dropped to 0 at deploy time.

Signal: cache miss rate is 100% since deploy. DB query rate spiked proportionally.

Fix: pre-warm cache, or accept the degradation while cache rebuilds.

---

## The answer you give out loud in the interview

> "P99 up, error rate flat — requests are completing, just slow. Not a crash. My first question is: was there a deploy in the last 30 minutes? That's the most common cause of a correlated latency spike.
>
> Then I go to traces. I filter for traces over 500ms in Jaeger, look at one, and follow the waterfall to find the slow span. In this kind of pattern — one slow internal span, everything else normal — it's almost always a database issue. Lock contention from a migration, a missing index, or connection pool exhaustion.
>
> I check pg_stat_activity for blocking queries. If there's a migration holding a lock on the bets table, I assess whether to wait or kill it. If it's an index issue, I `EXPLAIN ANALYZE` the slow query and create the index concurrently.
>
> The whole investigation from alert to root cause should take under 10 minutes with traces wired up correctly."

---

## Follow-up questions they will ask

**"What if traces show no slow spans — all spans are fast but total request time is still 800ms?"**

That is a trace instrumentation gap. Time is being spent somewhere not covered by a span — most likely in connection establishment, middleware, or framework-level code that is not instrumented. I would look at the time between the first span start and the HTTP request receipt timestamp to find the gap, and add instrumentation to cover it.

**"The deploy was a config change, not a code change. Can a config change cause this?"**

Yes. A config change that reduces `max_connections` in the connection pool, changes the database endpoint (cold connections instead of warm ones), or modifies a feature flag that enables a slower code path will all cause latency spikes with no errors.
