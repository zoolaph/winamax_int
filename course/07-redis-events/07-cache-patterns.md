# Cache Patterns — Deep Dive

At Winamax's scale — 900,000 bets per day, 700+ services — every database read that can be served from Redis instead of Aurora is a win. But caching introduces correctness problems: stale data, thundering herds, and incorrect eviction decisions. This file covers the patterns and their failure modes.

---

## Cache-Aside (Lazy Loading) — the default pattern

The application is responsible for reading from and writing to the cache. The cache does not know about the database.

```python
def get_bet_odds(match_id: str) -> dict:
    cache_key = f"odds:{match_id}"
    
    # 1. Try cache first
    cached = redis.get(cache_key)
    if cached:
        return json.loads(cached)
    
    # 2. Cache miss — read from Aurora
    odds = db.query("SELECT * FROM match_odds WHERE match_id = %s", match_id)
    
    # 3. Populate cache with TTL
    redis.setex(cache_key, 30, json.dumps(odds))  # 30-second TTL
    
    return odds
```

**Pros:**
- Only caches what is actually requested (no pre-loading waste)
- Cache failure is non-fatal — application falls back to DB
- Easy to reason about

**Cons:**
- First request after cache miss (or after TTL expiry) hits the database
- **Cache stampede** risk when many requests hit a hot key simultaneously after expiry

**TTL strategy for Winamax:**
- Live match odds: short TTL (5–30 seconds) — odds change frequently during a match
- User profile: longer TTL (5–15 minutes) — rarely changes, high read volume
- Static reference data (sports names, country codes): very long TTL (hours) with explicit invalidation on admin update

---

## Write-Through — cache stays warm on every write

Every write to the database also writes to the cache. The cache is always populated with the latest data for any key that has been written.

```python
def update_bet_status(bet_id: str, status: str):
    # Write to DB
    db.execute("UPDATE bets SET status = %s WHERE bet_id = %s", status, bet_id)
    
    # Write to cache (same TTL as read path)
    cache_key = f"bet:{bet_id}:status"
    redis.setex(cache_key, 300, status)
```

**Pros:**
- No cold-start problem — cache is always warm
- No thundering herd on the write path (cache is updated at write time, not on demand)

**Cons:**
- Writes are slower (two round trips: DB + Redis)
- Cache may hold data for keys that are never read again (wasted memory)
- In distributed systems, write-through + cache-aside together require careful consistency handling — if the DB write succeeds but the cache write fails, you have stale cache

**Write-through failure handling:**
```python
def update_bet_status(bet_id: str, status: str):
    db.execute("UPDATE bets SET status = %s WHERE bet_id = %s", status, bet_id)
    try:
        redis.setex(f"bet:{bet_id}:status", 300, status)
    except RedisConnectionError:
        # Cache write failed — delete the key instead of leaving stale data
        redis.delete(f"bet:{bet_id}:status")
        # Next read will be a cache miss and repopulate from DB
```

---

## Write-Behind (Write-Back) — async persistence

Write to cache first, persist to database asynchronously. Lowest write latency — the application does not wait for the DB round trip.

```python
def record_game_event(event: dict):
    # Write to Redis immediately (fast)
    redis.xadd("casino:game:events", event)
    
    # Background worker reads stream and persists to Aurora
    # (separate process — application does not wait)
```

**Risk:** If Redis fails before the async write completes, data is lost. Only appropriate when the data can be reconstructed or loss is acceptable (e.g., non-critical metrics, session activity logs — not financial bet records).

**Winamax constraint:** Any write-behind pattern for financial data (bets, payments) is unacceptable. The DB is the authoritative record. Cache is supplementary.

---

## Cache Stampede / Thundering Herd

**What it is:** A hot key's TTL expires. Before any consumer can repopulate the cache, thousands of simultaneous requests all get a cache miss, all query the database, and the database is overwhelmed.

**Why it matters at Winamax:** During a major sports event (Champions League final), the odds for the top matches are accessed millions of times per minute. When a 30-second TTL expires at peak load, the cache miss hits Aurora with a synchronized wave of queries.

### Solution 1: Probabilistic Early Expiration (PER)

Instead of expiring at exactly T seconds, randomly trigger a cache refresh slightly before TTL expiry. Only one consumer refreshes; others continue getting the cached value.

```python
import math, random, time

def get_with_per(redis, key, fetch_fn, ttl):
    data, remaining_ttl = redis.get_with_ttl(key)
    
    if data is None:
        # True miss — fetch and populate
        data = fetch_fn()
        redis.setex(key, ttl, data)
        return data
    
    # XFetch algorithm: decide if we should early-refresh
    beta = 1.0  # Higher = more eager to refresh
    delta = compute_delta()  # How long the fetch takes (measured)
    
    if time.time() - beta * delta * math.log(random.random()) >= remaining_ttl:
        # This consumer wins the refresh lottery — fetch in background
        threading.Thread(target=refresh, args=(key, fetch_fn, ttl)).start()
    
    return data
```

### Solution 2: Distributed Lock (SETNX)

Only one consumer fetches from the database; others wait.

```python
def get_odds_with_lock(match_id: str) -> dict:
    cache_key = f"odds:{match_id}"
    lock_key = f"odds:{match_id}:refresh_lock"
    
    cached = redis.get(cache_key)
    if cached:
        return json.loads(cached)
    
    # Try to acquire lock (NX = only set if not exists, EX = 5s timeout)
    lock_acquired = redis.set(lock_key, "1", nx=True, ex=5)
    
    if lock_acquired:
        # This thread is responsible for refreshing
        odds = db.query("SELECT * FROM match_odds WHERE match_id = %s", match_id)
        redis.setex(cache_key, 30, json.dumps(odds))
        redis.delete(lock_key)
        return odds
    else:
        # Another thread is refreshing — wait and retry
        time.sleep(0.05)
        return get_odds_with_lock(match_id)  # Retry
```

**Caution:** If the lock holder crashes before releasing (rare but possible), the `EX=5` timeout prevents permanent deadlock.

### Solution 3: Background Refresh

A dedicated background job refreshes hot keys before they expire, so the TTL effectively never expires from the user's perspective.

```python
# Cron/worker: every 25 seconds for 30-second TTL keys
def refresh_hot_odds():
    hot_matches = db.query("SELECT match_id FROM live_matches WHERE status = 'active'")
    for match in hot_matches:
        odds = db.query("SELECT * FROM match_odds WHERE match_id = %s", match.id)
        redis.setex(f"odds:{match.id}", 30, json.dumps(odds))
```

Best for known-hot keys (live match odds). Does not help for unpredictably popular keys.

---

## Eviction Policies — what happens when Redis is full

When Redis reaches `maxmemory`, it must evict keys. The policy determines what gets evicted.

| Policy | Behavior | Use when |
|--------|----------|----------|
| `allkeys-lru` | Evict least recently used across all keys | Pure cache — everything is replaceable |
| `allkeys-lfu` | Evict least frequently used | Some keys are hot (live matches), evict the cold ones |
| `volatile-lru` | Evict LRU only among keys with TTL set | Mixed use: some keys must never be evicted |
| `volatile-ttl` | Evict keys with shortest remaining TTL first | Prioritize evicting soon-to-expire entries |
| `allkeys-random` | Evict random key | Never — unpredictable behavior |
| `noeviction` | Reject writes when full | Never for a cache — breaks the application |

**Winamax recommendation:**
- Pure cache cluster: `allkeys-lfu` — live match odds are accessed constantly and will be retained. Old settled bet odds will naturally be evicted.
- Mixed cluster (cache + streams + sets): `volatile-lru` — streams and permanent sets do not have TTLs, so they are protected from eviction.

**Monitoring eviction:**
```bash
redis-cli INFO stats | grep evicted_keys
# If this number is growing fast, Redis is undersized or TTLs are too long
```

---

## TTL design rules

1. **Every cache key must have a TTL.** Keys without TTL will never be evicted unless explicitly deleted or Redis runs `allkeys-*` eviction. A key for a match that ended 3 months ago should not live forever.

2. **Jitter on TTL prevents synchronized expiry.** If 10,000 keys all get `TTL=3600` at the same second, they all expire at the same second. Add jitter: `TTL = 3600 + random.randint(-300, 300)`.

3. **TTL should match the data's natural staleness window.** Live odds: 30 seconds. User profile: 10 minutes. Reference data: hours.

4. **Invalidation on write is cleaner than short TTL for write-heavy data.** For data that changes infrequently but must be consistent when it does change (user account details), an explicit `redis.delete(cache_key)` on write is more correct than a 30-second TTL that allows a 30-second window of stale data.
