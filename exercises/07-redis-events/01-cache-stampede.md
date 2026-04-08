# Exercise 1 — Cache Stampede Incident

## Scenario

It is 21:45 on a Tuesday night. The Champions League final is in progress — Winamax is serving peak traffic: ~400,000 active users, 95,000 requests/second. Your monitoring shows:

- Aurora CPU: 87% (normal peak: 45%)
- Aurora read IOPS: 42,000 (normal: 8,000)
- ElastiCache CPU: 12% (normal)
- API P99 latency: 4.2 seconds (SLO: 500ms)
- CacheMisses CloudWatch metric: spiked from 200/min to 45,000/min 3 minutes ago

Your bet odds service serves real-time odds for the match. Each page view requests odds for 15–20 markets (1X2, BTTS, correct score, etc.). The cache key per market is `odds:{matchId}:{marketId}` with TTL of 30 seconds.

---

## Task 1: Diagnose the root cause

Given the metrics above, describe the most likely cause of this incident. What specific event triggered the spike in Aurora IOPS?

```
Root cause hypothesis:
____________________

Triggering event:
____________________

Why Aurora is overwhelmed (not Redis):
____________________
```

---

## Task 2: Immediate mitigation

You need to stop the bleeding in the next 5 minutes. You cannot deploy new code. What actions do you take?

List up to 3 actions in priority order:

```
Action 1 (fastest to execute):
____________________
Expected effect:
____________________

Action 2:
____________________
Expected effect:
____________________

Action 3:
____________________
Expected effect:
____________________
```

---

## Task 3: Fix the stampede in code

The current implementation is:

```python
def get_odds(match_id: str, market_id: str) -> dict:
    cache_key = f"odds:{match_id}:{market_id}"
    cached = redis.get(cache_key)
    if cached:
        return json.loads(cached)
    
    odds = db.query(
        "SELECT * FROM market_odds WHERE match_id = %s AND market_id = %s",
        match_id, market_id
    )
    redis.setex(cache_key, 30, json.dumps(odds))
    return odds
```

Rewrite this function using the distributed lock (SETNX) pattern to prevent stampede. Handle the case where the lock holder crashes.

```python
import redis
import json
import time

def get_odds(match_id: str, market_id: str) -> dict:
    cache_key = f"odds:{match_id}:{market_id}"
    lock_key = f"odds:{match_id}:{market_id}:lock"
    
    # Your implementation here
    pass
```

---

## Task 4: TTL improvement

Currently all odds keys expire at exactly T=30 seconds from when they were set. During a match, thousands of odds keys were all set within the same 5-second window at kickoff when odds first populated. They all expire simultaneously.

Propose a specific code change to the `redis.setex` call to prevent synchronized expiry.

```python
# Current
redis.setex(cache_key, 30, json.dumps(odds))

# Improved
____________________
```

---

## Task 5: Long-term architectural fix

After the incident, your manager asks for a proposal to prevent this class of problem permanently. The requirement: live match odds should never miss the cache during a match, regardless of TTL.

Describe the architecture change (no more than one paragraph). What new component do you add, what does it do, and what is the trade-off?

---

## Answer Key

### Task 1: Root cause

```
Root cause hypothesis:
All odds keys for the Champions League final were set with a 30-second TTL.
30 seconds after they were first populated (or the last synchronized refresh),
they all expired simultaneously.

Triggering event:
Synchronized expiry of ~300+ odds keys (15-20 markets × match odds variants)
at the same second, all under peak load of 95,000 requests/second.

Why Aurora is overwhelmed:
With 400,000 active users, each page making 15-20 odds requests, and all
cache keys expired at the same moment, every request became a DB read for
~30 seconds (until the cache was repopulated). 95,000 requests/sec × 15-20
DB reads = up to 1,900,000 DB reads/sec in a 30-second window.
```

### Task 2: Immediate mitigation

```
Action 1: Manually re-seed the cache
Run a script or Lambda that queries all match odds for the live match and
writes them to Redis with a new TTL. This immediately serves future requests
from cache. Can be done without a code deploy.
Expected effect: Aurora IOPS drops within 30 seconds as cache repopulates.

Action 2: Temporarily increase Aurora read replicas
Via AWS Console or CLI, add 1-2 read replicas to the Aurora cluster. Route
the odds service to the reader endpoint (if not already doing so).
Expected effect: Distributes the DB read load across more nodes.

Action 3: Throttle the API at the load balancer / API Gateway
Rate-limit the odds endpoint to a sustainable DB read rate (e.g., 5,000
requests/sec instead of 95,000). Return 429s to excess requests.
Expected effect: Protects Aurora from being overwhelmed, at cost of user
experience degradation. Use as last resort.
```

### Task 3: Distributed lock implementation

```python
import redis
import json
import time

def get_odds(match_id: str, market_id: str) -> dict:
    cache_key = f"odds:{match_id}:{market_id}"
    lock_key = f"odds:{match_id}:{market_id}:lock"
    
    # Check cache first
    cached = redis.get(cache_key)
    if cached:
        return json.loads(cached)
    
    # Cache miss — try to acquire the refresh lock
    max_attempts = 20
    for attempt in range(max_attempts):
        # NX = only set if not exists, EX = 5s lock timeout (handles crash)
        lock_acquired = redis.set(lock_key, "1", nx=True, ex=5)
        
        if lock_acquired:
            try:
                # Double-check after acquiring lock (another thread may have refreshed)
                cached = redis.get(cache_key)
                if cached:
                    return json.loads(cached)
                
                # Fetch from DB and populate cache
                odds = db.query(
                    "SELECT * FROM market_odds WHERE match_id = %s AND market_id = %s",
                    match_id, market_id
                )
                ttl = 30 + random.randint(-5, 5)  # Jitter to avoid synchronized expiry
                redis.setex(cache_key, ttl, json.dumps(odds))
                return odds
            finally:
                redis.delete(lock_key)  # Always release lock
        else:
            # Another thread is refreshing — wait briefly and retry
            time.sleep(0.05)
            cached = redis.get(cache_key)
            if cached:
                return json.loads(cached)
    
    # Could not get data from cache after all attempts — fall back to DB directly
    return db.query(
        "SELECT * FROM market_odds WHERE match_id = %s AND market_id = %s",
        match_id, market_id
    )
```

### Task 4: TTL jitter

```python
import random

# Current
redis.setex(cache_key, 30, json.dumps(odds))

# Improved: jitter ±5 seconds
ttl = 30 + random.randint(-5, 5)   # Range: 25–35 seconds
redis.setex(cache_key, ttl, json.dumps(odds))
```

### Task 5: Background refresh architecture

Add a dedicated **cache warmer service** — a small ECS task that continuously refreshes live match odds in the background. Every 20 seconds (before the 30-second TTL expires), it queries Aurora for all active match markets and writes the results to Redis. The odds service never relies on a cache miss triggering a DB read; it always reads from a warm cache. The trade-off is that odds may be up to 20 seconds stale (acceptable for betting — odds updates are controlled by the odds engine, not fetched in real-time by end users). This also decouples the read throughput on the odds service from Aurora — the cache warmer has a predictable, low read pattern regardless of user traffic.
