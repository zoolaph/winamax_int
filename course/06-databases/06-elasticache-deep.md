# ElastiCache (Valkey/Redis) — Deep Dive

## What ElastiCache is

ElastiCache is AWS's managed in-memory data store. It supports two engines:
- **Redis** (and its open-source fork **Valkey**, which AWS now defaults to) — rich data structures, persistence options, replication, cluster mode.
- **Memcached** — simpler, no replication, for pure caching use cases.

For Winamax: Valkey/Redis. The capabilities (streams, sorted sets, pub/sub, replication) are required.

---

## Deployment modes

### Standalone (no replication)
Single node. Data is lost if the node fails. Only for development or non-critical caching.

### Replication group (primary + replicas)
```
Primary node  →  Replica 1 (same AZ or different AZ)
              →  Replica 2 (different AZ — for HA)
```
- Reads can go to replicas (distribute read load).
- Writes go to primary only.
- If primary fails, a replica is promoted automatically (~30 seconds).
- Multi-AZ deployment: replicas in different AZs. ElastiCache promotes the replica with the least replication lag.

### Cluster mode (sharding)
```
Shard 1: keys hashed to slots 0–5460        Primary + 2 replicas
Shard 2: keys hashed to slots 5461–10922    Primary + 2 replicas
Shard 3: keys hashed to slots 10923–16383   Primary + 2 replicas
```
- Redis keyspace is divided into 16,384 hash slots.
- Each shard owns a range of slots.
- Scales horizontally — add shards to increase throughput and memory.
- **Limitation:** multi-key commands and transactions must target the same shard (same hash slot). Use hash tags `{userId}:session` to force related keys to the same shard.

**Winamax recommendation:** Cluster mode with 3 shards and 2 replicas each. Handles the live odds data volume and provides HA across all AZs.

---

## Eviction policies — this will be asked

When memory is full, Redis must decide what to evict. The policy is set via `maxmemory-policy`:

| Policy | Behavior | Use case |
|--|--|--|
| `noeviction` | Return error on write when full | Never use for a cache — breaks the application |
| `allkeys-lru` | Evict least recently used keys across all keys | **Default choice for general caching** |
| `allkeys-lfu` | Evict least frequently used keys across all keys | Better when access patterns are consistent over time |
| `volatile-lru` | LRU but only evict keys with TTL set | When some keys must survive (no TTL = pinned) |
| `volatile-ttl` | Evict keys with shortest TTL first | Prefer evicting keys that were expiring soon anyway |
| `allkeys-random` | Random eviction | Avoid — unpredictable behavior |

**Winamax scenario:**
- Live odds cache: `allkeys-lru`. Old odds for yesterday's match are evicted first. Recent odds for today's match stay in memory.
- Session store: `volatile-lru`. Sessions have TTLs. Evict the longest-inactive sessions first.

---

## Data structures at Winamax

Redis is not just a key-value store. The data structures matter:

**Strings** — simple key-value, counters:
```
SET user:U-12345:session "abc123" EX 3600     # Session token, expires in 1 hour
INCR bet:today:count                          # Atomic counter — total bets today
GETSET odds:MATCH-001 "1.85"                  # Update odds and return old value atomically
```

**Hashes** — objects:
```
HSET user:U-12345 name "Farouq" tier "premium" last_login "2024-01-15"
HGET user:U-12345 tier
HMGET user:U-12345 name tier   # Get multiple fields in one round trip
```

**Sorted sets** — leaderboards, rate limiting:
```
# Live bet leaderboard — score = stake amount
ZADD leaderboard 1000.50 "U-12345"
ZRANGE leaderboard 0 9 REV WITHSCORES  # Top 10 bettors by stake
```

**Sorted sets for rate limiting:**
```
# Sliding window rate limiter: max 10 bets per user per minute
ZADD ratelimit:U-12345 {now_ms} {now_ms}    # Add current request
ZREMRANGEBYSCORE ratelimit:U-12345 0 {now_ms - 60000}  # Remove requests older than 1 min
count = ZCARD ratelimit:U-12345              # Count requests in window
if count > 10: reject
EXPIRE ratelimit:U-12345 60                  # Auto-cleanup
```

**Lists** — queues (though use Kafka for serious queueing):
```
RPUSH notifications:U-12345 "Your bet settled — you won €15.75"
LPOP notifications:U-12345
```

**Pub/Sub** — fire-and-forget notifications:
```
PUBLISH odds_updates "MATCH-001:football:1.85"
SUBSCRIBE odds_updates  # All listeners receive every message
```
Note: pub/sub has no persistence and no acknowledgement. If a subscriber is down, it misses messages. For reliable messaging, use Kafka or Redis Streams.

---

## Cache patterns

**Cache-aside (lazy loading):**
```python
def get_user_profile(user_id):
    # 1. Try cache
    data = redis.get(f"user:{user_id}")
    if data:
        return json.loads(data)
    
    # 2. Cache miss — read from Aurora
    data = aurora.query("SELECT * FROM users WHERE id = %s", user_id)
    
    # 3. Populate cache for next request
    redis.setex(f"user:{user_id}", 300, json.dumps(data))  # TTL: 5 minutes
    return data
```
**Pros:** Only caches what is actually requested. Cache miss is always recoverable.
**Cons:** First request after a cold start (or TTL expiry) hits the database.

**Write-through:**
```python
def update_user_profile(user_id, data):
    # Write to both database AND cache atomically
    aurora.execute("UPDATE users SET ... WHERE id = %s", user_id)
    redis.setex(f"user:{user_id}", 300, json.dumps(data))
```
**Pros:** Cache is always warm after a write. No stale reads.
**Cons:** Writes are slower. Cached data for rarely-read items wastes memory.

**Winamax recommendation:** Cache-aside for read-heavy data (user profiles, event metadata). Write-through for live odds (must be current immediately after an update).

---

## Cache stampede prevention

**The problem:** A popular item's TTL expires. 1,000 requests arrive simultaneously, all get a cache miss, all hit Aurora at the same time. Aurora is now handling 1,000 concurrent queries for the same item.

**Solution 1: Probabilistic early re-expiration:**
```python
def get_with_jitter(key, ttl):
    data = redis.get(key)
    remaining_ttl = redis.ttl(key)
    
    # If TTL is under 10% remaining, 10% chance to refresh early
    if remaining_ttl < ttl * 0.1 and random.random() < 0.1:
        data = None  # Trigger refresh in this one request
    
    if not data:
        data = fetch_from_db()
        redis.setex(key, ttl, data)
    return data
```

**Solution 2: Redis SETNX (set if not exists) mutex:**
```python
def get_with_lock(key):
    data = redis.get(key)
    if data:
        return data
    
    # Try to acquire lock
    lock_key = f"lock:{key}"
    if redis.setnx(lock_key, "1"):
        redis.expire(lock_key, 5)  # Lock expires in 5 seconds
        try:
            data = fetch_from_db()
            redis.setex(key, 300, data)
        finally:
            redis.delete(lock_key)
    else:
        # Another process is fetching — wait briefly and retry
        time.sleep(0.05)
        return get_with_lock(key)
    return data
```

**Solution 3: Stagger TTLs:**
Instead of `TTL = 300` exactly, use `TTL = 300 + random(0, 30)`. Keys expire at different times, spreading database load.

---

## ElastiCache vs self-managed Redis

AWS ElastiCache handles:
- Patching and minor version upgrades (optional automatic minor version upgrade).
- Replication setup — creating replica groups, configuring cluster mode.
- Automatic failover promotion.
- CloudWatch metrics: `CacheHits`, `CacheMisses`, `CurrConnections`, `Evictions`, `ReplicationLag`.

**Monitoring the critical metrics:**
```
CacheHitRate = CacheHits / (CacheHits + CacheMisses)
Target: > 95% for a healthy cache

Evictions > 0 → memory is full, items are being evicted
  Either increase instance size, add shards, or review TTL strategy

ReplicationLag (cluster mode) > 1000ms → replica is falling behind primary
  Replica reads may be stale
```
