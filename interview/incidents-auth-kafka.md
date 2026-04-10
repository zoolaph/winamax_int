# Incident Deep Dive — Auth Stampede & Kafka Consumer Lag

Two real incidents. Full diagnosis, monitoring, fix, and interview story for each.

---

## Incident 1 — API Gateway Auth Stampede

### What Happened

A web interface allowed clients to view and edit alarms. Each alarm change needed to reach connected units instantly. The system used API Gateway as the entry point, with services authenticating on every request.

Under normal load everything worked. Under higher load, API Gateway RAM climbed, connections started dropping, then recovered — a repeating sawtooth pattern. The system never fully crashed but was visibly degraded.

### Root Cause

Every service and connector was authenticating independently on every request — once per second per service. With N services, that is N authentication requests per second hitting API Gateway simultaneously.

```
BROKEN MODEL
============

Service A  ──auth every 1s──→
Service B  ──auth every 1s──→
Service C  ──auth every 1s──→   API Gateway (synchronous, no buffer)
...
Service N  ──auth every 1s──→

Total load = N × 1 req/s
```

API Gateway is synchronous. Every auth request opens a connection and holds it open waiting for a response. API Gateway has a finite connection pool. When the pool fills, new connections are dropped. Because the services eventually retry and tokens have a long validity period, the system partially recovered — hence the sawtooth.

**Why API Gateway specifically:** unlike a queue-backed system where pressure accumulates in the queue and services wait longer, API Gateway has no buffer. Pressure lands directly on it. When the pool is full, the next connection is refused immediately. There is no waiting room.

### Why This Does Not Happen With a Queue

```
QUEUE-BACKED (SQS, Kafka)           API GATEWAY (synchronous)
──────────────────────────          ──────────────────────────
Requests pile up in queue           Requests hold open connections
Services get fast 202 response      Services wait for response
Consumer processes when ready       Gateway absorbs all pressure
Pressure = longer wait time         Pressure = dropped connections
```

### Monitoring You Should Have Had

```
ALERTS (page someone)
─────────────────────
Connection pool utilization > 80% for 3 minutes
p99 auth endpoint latency > 2× baseline for 5 minutes
Auth error rate > 1% for 3 minutes

DASHBOARD
─────────
Auth requests/sec broken down by calling service
  → would have shown N × services requests/sec immediately
Active connection count trending over time
  → would have shown growth before connections dropped
p99 latency per endpoint
  → climbing latency is always the early warning before connection drops
```

### Fix

Services cache the token after first authentication and reuse it until it is close to expiry.

```
FIXED MODEL
===========

Service A  ──auth once──→ cache token ──reuse for token lifetime - 30s──→ re-auth
Service B  ──auth once──→ cache token ──reuse for token lifetime - 30s──→ re-auth
...

Total load = N × (1 / token_ttl_seconds) req/s
             instead of N × 1 req/s
```

Implementation:

```python
import time

_token_cache = {"token": None, "expires_at": 0}

def get_valid_token():
    now = time.time()
    # re-authenticate 30s before expiry as safety buffer
    if _token_cache["token"] is None or now >= _token_cache["expires_at"] - 30:
        response = authenticate()
        _token_cache["token"] = response["access_token"]
        _token_cache["expires_at"] = now + response["expires_in"]
    return _token_cache["token"]

def make_request(endpoint, payload):
    token = get_valid_token()
    return http.post(endpoint, headers={"Authorization": f"Bearer {token}"}, json=payload)
```

A JWT contains an `exp` claim. You can decode it to get the exact expiry without trusting the server response:

```python
import jwt  # PyJWT

def token_expires_at(token: str) -> float:
    payload = jwt.decode(token, options={"verify_signature": False})
    return payload["exp"]
```

### Other Possible Root Causes With the Same Symptom

When you see RAM grow → connections drop → recovery without full crash, do not assume auth stampede. Other causes produce identical symptoms:

| Cause | Differentiator |
|---|---|
| Connection leak | Connection count grows even when traffic is flat |
| Slow upstream causing pileup | Upstream response time increases at the same time |
| Keep-alive misconfiguration | Many connections in idle/established state with no active traffic |
| Large payload memory pressure | RAM per request grows, not just request count |
| TLS handshake storm | Correlates with deployments or node restarts, CPU spikes simultaneously |
| Retry amplification | Request rate is much higher than expected traffic volume |

### Diagnosis Process

```
1. Read the symptom pattern
   RAM up → connections drop → recovery = accumulation with partial release
   Ask: is this periodic? Does it correlate with deployments or traffic spikes?

2. Follow the signal chain
   Connections dropping
     → what is holding those connections?
       → check active connection count
         → is it accumulating or just spiking?
           → check request rate per endpoint
             → which endpoint, which caller?

3. In this case
   Auth endpoint request rate = N × services/sec
   Each request holds a synchronous connection
   Connection pool fills
   New connections refused
   ROOT CAUSE CONFIRMED

4. Fix and verify
   Deploy token caching
   Monitor auth request rate → should drop by ~N×
   Monitor connection pool utilization → should stabilize
```

---

## Incident 2 — Kafka Consumer Lag and RAM Growth

### What Happened

Alarm changes needed to reach connected units within seconds. Users reported delays of up to 1 minute in the worst case. The system was using Kafka — alarm changes were published to a topic and a consumer service read from it to notify units.

### Phase 1 — Diagnosing the Lag

The 1-minute worst-case is a strong signal. Random slowness produces variable delays. A consistent ceiling near 60 seconds points at a configuration value — a poll interval, a timeout, a retry backoff.

**Confirmation step before touching anything:**

```bash
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --describe \
  --group alarm-consumer-group

TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
alarms.updated  0          4521000         4521050         50
alarms.updated  1          4521000         4521200         200
alarms.updated  2          4521000         4521000         0
```

Run this twice 30 seconds apart. If LAG is growing → consumer is falling behind. If LAG is 0 → wrong diagnosis, look elsewhere.

**Other causes to rule out before assuming lag:**

| Cause | How to identify |
|---|---|
| Polling interval (cron job) | Delay is consistently close to the interval value |
| `linger.ms` set high on producer | Producer config shows high linger value, delay is on publish side |
| Consumer group rebalancing | Kafka logs show "Assignment received from leader", correlates with deployments |
| `fetch.min.bytes` misconfigured | Delay only happens when message volume is low |

### Phase 2 — Finding the Slow Step

Consumer lag means messages arrive faster than they are processed. Add timing at every step to find where the time goes:

```python
def process_message(msg):
    t0 = time.time()

    alarm = deserialize(msg)
    t1 = time.time()

    units = get_affected_units(alarm.id)   # DB call
    t2 = time.time()

    notify_units(units)                    # HTTP call per unit
    t3 = time.time()

    log(f"deserialize={t1-t0:.3f}s  db={t2-t1:.3f}s  notify={t3-t2:.3f}s")
```

In this incident the logs showed:

```
deserialize=0.001s  db=2.340s  notify=0.050s
deserialize=0.001s  db=2.180s  notify=0.048s
```

The DB call was consuming 2+ seconds per message. Processing was effectively rate-limited to one message every 2 seconds.

### Phase 3 — The DB Fix and Its Side Effect

```sql
EXPLAIN ANALYZE SELECT * FROM units WHERE alarm_id = 123;
-- Seq Scan on units (rows=50000, actual time=2341ms)

CREATE INDEX idx_units_alarm_id ON units(alarm_id);

EXPLAIN ANALYZE SELECT * FROM units WHERE alarm_id = 123;
-- Index Scan using idx_units_alarm_id (rows=12, actual time=0.8ms)
```

After adding the index: alarm updates became instant. Lag dropped to 0. Success on latency.

But: **service RAM began growing steadily**.

### Phase 4 — Understanding the RAM Growth

The slow query was acting as accidental backpressure:

```
BEFORE (slow query = accidental rate limiter)
─────────────────────────────────────────────
Processing time per message: ~2s
Consumer throughput: ~0.5 messages/sec
Memory pressure: 1 message in flight at a time → low

AFTER (fast query)
──────────────────
Processing time per message: ~5ms
Consumer throughput: ~200 messages/sec
Memory pressure: batches of messages in flight simultaneously → growing
```

Removing the bottleneck revealed that nothing was controlling memory consumption at the new throughput.

**Three most common causes of this pattern:**

**1. Unbounded accumulation in the consumer code**

```python
# This grows forever — a list or dict that is never cleared or evicted
results_cache = {}

def process_message(msg):
    units = get_affected_units(msg.alarm_id)
    results_cache[msg.alarm_id] = units   # grows with every unique alarm_id
    notify_units(units)
```

**2. Kafka pulling large batches into memory**

`max.poll.records` defaults to 500. When processing was slow, the consumer never actually held 500 messages — it was too slow to consume them. After the fix:

```
max.poll.records = 500
Each message references 50 units
Each unit object = 2KB in memory

500 messages × 50 units × 2KB = 50MB per poll cycle
At 200 cycles/sec → GC cannot keep up
```

**3. Parallel notification threads accumulating**

If `notify_units()` spawns threads without a cap:

```python
# Unbounded — at 200 msg/sec, this spawns 200 × 50 = 10,000 threads simultaneously
threads = [Thread(target=notify, args=(u,)) for u in units]
for t in threads: t.start()
```

### How to Find What Is Growing

Take two heap snapshots while RAM is growing and compare them. The object type that is increasing is your target.

```bash
# Java
jmap -histo:live <pid> | head -30
# Look for the class with the most instances and growing count

# Python
pip install memory-profiler
mprof run consumer.py
mprof plot
# Shows memory over time, peaks correlate with processing bursts
```

### Fixes

**Fix unbounded cache — add eviction:**

```python
from functools import lru_cache

@lru_cache(maxsize=1000)
def get_affected_units(alarm_id: int):
    return db.query("SELECT * FROM units WHERE alarm_id = %s", alarm_id)
```

**Fix batch size — reduce messages held in memory at once:**

```properties
max.poll.records=50
fetch.max.bytes=1048576
```

**Fix thread pool — cap parallelism:**

```python
from concurrent.futures import ThreadPoolExecutor

def notify_units(units):
    with ThreadPoolExecutor(max_workers=10) as executor:
        executor.map(notify, units)
```

**Fix throughput ceiling — add more consumers if lag returns:**

Kafka partitions are the unit of parallelism. Maximum useful consumers = number of partitions. If you have 3 partitions and 1 consumer, scaling to 3 consumers gives 3× throughput:

```
BEFORE: 3 partitions, 1 consumer
  Partition 0 ─┐
  Partition 1 ─┼─→ [Consumer 1]   all work on one instance
  Partition 2 ─┘

AFTER: 3 partitions, 3 consumers
  Partition 0 ──→ [Consumer 1]
  Partition 1 ──→ [Consumer 2]   parallel processing
  Partition 2 ──→ [Consumer 3]
```

If you need more than 3 consumers, increase partition count first — but partition count cannot be decreased after creation, so size it carefully.

### Monitoring to Set Up

```yaml
# Prometheus alert rules

- alert: KafkaConsumerLagHigh
  expr: kafka_consumergroup_lag{group="alarm-consumer-group"} > 100
  for: 5m
  annotations:
    summary: "Alarm consumer falling behind — unit notification delays expected"

- alert: KafkaConsumerLagGrowing
  expr: deriv(kafka_consumergroup_lag{group="alarm-consumer-group"}[5m]) > 0
  for: 10m
  annotations:
    summary: "Consumer lag is increasing — processing cannot keep up with ingestion"

- alert: AlarmConsumerHighMemory
  expr: process_resident_memory_bytes{job="alarm-consumer"} > 500e6
  for: 5m
  annotations:
    summary: "Alarm consumer memory above 500MB — possible accumulation issue"
```

**Dashboard panels:**

```
Top row:    Consumer lag per partition (should be flat near 0)
Mid row:    Processing time p99 (should be stable)
            Messages/sec produced vs consumed (gap = lag building)
Bottom row: Consumer RAM over time (should be flat after warmup)
            Active DB connections from consumer
```

---

## The Lesson Connecting Both Incidents

Both incidents share the same underlying pattern: **a system running under load reveals the next bottleneck when the current one is removed.**

- Auth stampede: connection pool was the bottleneck. Fix = reduce request rate via caching.
- Kafka lag: DB query was the bottleneck acting as a rate limiter. Fix = add index. Side effect = RAM pressure because nothing replaced the rate limiting function of the slow query.

In distributed systems, fixing throughput without also fixing the resource consumption at the new throughput level always produces a second incident.

---

## Interview Story

### Story 1 — Auth Stampede

> "We had a degradation where API Gateway was intermittently dropping connections under load — RAM would climb, connections would drop, then partially recover. The pattern repeated. Because it never fully crashed, it was not immediately obvious.
>
> I traced the connection count and found it was proportional to the number of services calling the auth endpoint. Each service was authenticating independently on every request — every second, regardless of whether its existing token was still valid. With N services that was N requests per second, all holding synchronous connections open at the API Gateway level.
>
> The key insight was that API Gateway is synchronous with no buffer. Unlike a queue where pressure means longer wait times, API Gateway has a finite connection pool. When it fills, connections are refused immediately — which explains the sharp drops rather than gradual degradation.
>
> The fix was token caching at the client side. Each service authenticates once and reuses the token until close to expiry. We added a 30-second buffer before the `exp` claim as a safety margin. Auth request volume dropped by roughly 90% and the connection pressure disappeared.
>
> The monitoring gap was that we had no metric for auth request rate broken down by caller. Connection pool utilization was also unmonitored. We added both, with alerts at 80% pool utilization — that would have caught this 10 minutes before users noticed."

---

### Story 2 — Kafka Consumer Lag and RAM Growth

> "We had alarm updates that were supposed to reach connected units in near real-time but were sometimes delayed up to a minute. The 1-minute ceiling was the first signal — that is not random slowness, that is a configuration boundary somewhere.
>
> I confirmed consumer lag first using kafka-consumer-groups — lag was growing, not stable. Then I added timing logs around each step in the consumer: deserialization, the DB call to find affected units, and the notification calls. The DB call was taking over 2 seconds per message. The query was a full table scan — no index on the alarm_id column.
>
> Adding the index cut the query from 2 seconds to under a millisecond. Alarm updates became instant. But RAM on the consumer service started climbing steadily.
>
> What happened was that the slow query was acting as accidental backpressure — it rate-limited the consumer to about one message every 2 seconds. With the index the consumer could now process 200 messages per second, and at that throughput an unbounded cache in the processing code was accumulating entries faster than GC could release them. We identified it with heap profiling and added LRU eviction with a max size.
>
> The lesson I took from this: when you fix a latency problem that was caused by a slow step, you must also check what that slow step was doing to memory and throughput control. The bottleneck you removed was probably the only thing stopping the system from running at a speed it was not designed to sustain."
