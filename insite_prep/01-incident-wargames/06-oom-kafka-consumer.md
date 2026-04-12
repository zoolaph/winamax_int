# Wargame 06 — Kafka Consumer OOM After Performance Fix

## The scenario

Yesterday, the fraud-detection consumer was slow — processing time was 2.3 seconds per message due to a missing database index. You added the index at 09:15 today. Consumer lag dropped to zero. Success.

At 11:40 today, a new alert fires:

```
WARNING: ECS Task Memory Utilization
  Service: fraud-detection-service
  Task: abc123def456
  MemoryUtilization: 94%
  Threshold: 85%
  
At 12:05:
CRITICAL: ECS Task OOM Killed
  Service: fraud-detection-service
  StopCode: OutOfMemoryError
  Container: fraud-detection
```

The consumer is being OOM killed. ECS restarts it. It runs for ~25 minutes and gets killed again. The cycle repeats.

Timeline:
- 09:15 — index added, consumer lag drops to 0
- 11:40 — memory warning
- 12:05 — first OOM kill
- 12:30 — second OOM kill (after ECS restart)

---

## Your job

1. What is the connection between fixing the index and the OOM kills 2.5 hours later?
2. What are the three specific code patterns that cause this symptom?
3. How do you diagnose which one is responsible?
4. What is the fix for each, and what do you do right now to stop the kill cycle?

**Speak through all four before reading on.**

---
---
---
---
---
---

## Diagnosis path

### The connection between the index fix and the OOM

Before the index fix: each message took 2.3 seconds to process. The consumer processed ~0.4 messages/second. At this rate, the in-memory state accumulated slowly — GC had time to collect between messages.

After the index fix: each message takes ~5ms to process. The consumer now processes ~200 messages/second. The same accumulation patterns that were invisible at 0.4 msg/sec are now visible at 200 msg/sec.

The slow query was acting as accidental backpressure. Removing it revealed that the consumer was not designed to run at the throughput it is now capable of.

### The three patterns that cause this

**Pattern A: Unbounded in-memory accumulation**

The consumer builds up a data structure that is never cleared or evicted:

```python
# Accumulates every alarm_id it has ever processed — grows forever
processed_cache = {}

def process_message(msg):
    bet = deserialize(msg.value)
    units = get_affected_units(bet.user_id)   # DB call (now fast)
    processed_cache[bet.user_id] = units       # ← never evicted
    notify_units(units)
```

At 200 msg/sec, if each entry is 2KB and the consumer runs for 25 minutes: `200 × 60 × 25 × 2KB = 600MB`. OOM at ~25 minutes. This matches the observed timeline exactly.

**Pattern B: Kafka pulling large batches into memory**

`max.poll.records` defaults to 500. At 0.4 msg/sec, the consumer never actually pulled 500 messages — it was too slow to accumulate them. At 200 msg/sec, the consumer now regularly polls full 500-message batches and holds them all in memory simultaneously:

```
max.poll.records = 500
Each message references 20 user records
Each user record = 5KB in memory

500 messages × 20 records × 5KB = 50MB per poll cycle
At 200 cycles/sec: GC cannot collect fast enough
```

**Pattern C: Unbounded thread pool for async notifications**

The consumer spawns threads to notify units in parallel, without capping concurrency:

```python
def process_message(msg):
    units = get_units(msg.user_id)
    # At 200 msg/sec × 20 units each = 4000 threads/sec
    threads = [Thread(target=notify, args=(u,)) for u in units]
    for t in threads: t.start()
    # No join, no pool limit
```

Each thread object occupies stack memory. 4000 threads/sec overwhelms GC and thread limits.

### Diagnosing which pattern is responsible

**Step 1 — Take a heap dump while memory is growing**

```bash
# For a Python consumer
pip install memory-profiler
# Run with: mprof run consumer.py
# Plot with: mprof plot

# For a JVM consumer
kubectl exec <pod> -- jcmd <pid> GC.heap_info
jmap -histo:live <pid> | head -30
```

The object type with the largest count that is growing over time is your target.

**Step 2 — Check batch sizes in consumer logs**

```bash
aws logs filter-log-events \
  --log-group-name /ecs/fraud-detection-service \
  --filter-pattern "poll_records" \
  --start-time $(date -d '1 hour ago' +%s000)
```

If logs show consistent 500-message batches: Pattern B.

**Step 3 — Check active thread count**

```bash
# Linux: check /proc/<pid>/status for thread count
cat /proc/<consumer-pid>/status | grep Threads

# Or via application metrics if exposed
```

Rapidly growing thread count: Pattern C.

**Step 4 — Code review**

Fastest diagnosis is often reading the consumer code directly. Look for:
- Any `dict`, `list`, or `set` that is appended to but never has a bounded size or TTL
- `max.poll.records` configuration (check both code and environment variables)
- Thread or executor creation without explicit pool size or max workers

### Right now — stop the kill cycle

**Immediate: scale down the consumer throughput**

```bash
# Reduce max poll records to give GC breathing room
# Set environment variable on ECS task definition
aws ecs register-task-definition \
  --family fraud-detection \
  --container-definitions '[{
    "name": "fraud-detection",
    "environment": [
      {"name": "KAFKA_MAX_POLL_RECORDS", "value": "50"}
    ]
  }]'
# Then force a new deployment
aws ecs update-service \
  --cluster winamax-prod \
  --service fraud-detection-service \
  --force-new-deployment
```

Reducing `max.poll.records` from 500 to 50 reduces peak memory usage by 10x and gives GC time to collect. The consumer will still process messages; just in smaller batches.

**Then: fix the root cause in code**

Fix A — add LRU eviction:
```python
from functools import lru_cache

@lru_cache(maxsize=10000)
def get_units_for_user(user_id):
    return db.query("SELECT * FROM units WHERE user_id = %s", user_id)
```

Fix B — reduce batch size permanently:
```python
consumer = KafkaConsumer(
    max_poll_records=50,
    fetch_max_bytes=1_048_576  # 1MB max per fetch
)
```

Fix C — cap thread pool:
```python
from concurrent.futures import ThreadPoolExecutor

def process_message(msg):
    units = get_units(msg.user_id)
    with ThreadPoolExecutor(max_workers=10) as executor:
        executor.map(notify, units)
```

### The answer you give out loud

> "The OOM is a direct consequence of fixing the slow query. The 2.3-second processing time was acting as a rate limiter — the consumer could only process 0.4 messages per second, so memory pressure was low. After the index fix, it's processing 200 per second, and something that accumulates memory is now filling it up 500 times faster.
>
> The three usual suspects are: an unbounded cache or map that grows with each message, Kafka pulling 500-message batches that are all held in memory simultaneously, or a thread pool with no cap.
>
> I'd take a heap snapshot and look at which object type is growing. Fastest path is usually code review — look for any data structure that's written to but never evicted.
>
> Right now, to stop the kill cycle: reduce `max.poll.records` to 50 and force a redeploy. That's a one-line config change that immediately reduces peak memory usage. Then fix the actual root cause in code and deploy properly."

---

## Follow-up questions they will ask

**"The consumer is restarting every 25 minutes like clockwork. Why is the interval consistent?"**

Consistent interval = consistent accumulation rate. At 200 msg/sec with a fixed memory leak of N bytes per message, the time to OOM is `(memory_limit / N) / 200`. The fact that it's consistent tells you it's proportional to message rate, not time — which rules out time-based leaks (like a timer that doesn't clear) and points to per-message accumulation.

**"After your fix, how do you verify the consumer is healthy at the new throughput?"**

Three metrics to watch for 30 minutes after the fix: heap size (should be stable, not growing), GC pause time (should be short and infrequent), and consumer lag (should stay near 0). If heap is stable and lag is 0, you're done. I'd also add a heap utilization alert at 70% so we catch this pattern earlier next time.
