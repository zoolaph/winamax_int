# Redis Data Structures — Deep Dive

Redis is not just a key-value cache. It is a data structure server. Each data type has specific commands, specific time complexities, and specific use cases. Picking the wrong type at Winamax's scale (millions of keys, real-time access patterns) causes either poor performance or excess memory usage.

---

## String — the universal type

The simplest type. A string value can hold text, JSON, binary data, or integers. Atomic integer operations (`INCR`, `DECR`) make strings useful for counters.

```redis
SET user:456:session_token "abc123xyz" EX 3600   # Set with 1-hour TTL
GET user:456:session_token

INCR api:ratelimit:user:456:minute              # Atomic increment
EXPIRE api:ratelimit:user:456:minute 60         # Reset after 60 seconds
```

**Winamax use case:** Session tokens (casino user authenticated sessions), rate limiting counters per user/minute, feature flag values.

**Memory note:** Every key in Redis has overhead (~50–70 bytes). Storing 10 million individual string keys for user attributes costs more than storing them as hashes (one hash per user, multiple fields). Rule: if an entity has multiple attributes, use a hash.

---

## Hash — structured entity storage

A hash stores field-value pairs under one key. Think of it as a row in a database, or a Go struct, or a Python dict — one Redis key, multiple named fields.

```redis
HSET bet:88991234 betId "88991234" userId "456" amount "25.00" sport "football" status "pending" createdAt "1712500000"
HGET bet:88991234 status
HMGET bet:88991234 userId amount status
HSET bet:88991234 status "settled"    # Update a single field

HGETALL bet:88991234                  # Get entire bet record
```

**Winamax use case:** In-flight bet records during a live match, user profile cache (avoiding repeated Aurora reads for each request), game state for Casino (hand state, chip counts).

**Memory efficiency:** A hash with fewer than `hash-max-listpack-entries` entries (default 128) is stored as a compact listpack internally — much more memory-efficient than equivalent individual string keys.

---

## List — ordered queue / stack

A linked list of strings. Supports push/pop from both ends (O(1)). Can be used as a queue (LPUSH + BRPOP) or stack (LPUSH + LPOP).

```redis
LPUSH notifications:user:456 "Your bet was settled"
LPUSH notifications:user:456 "Odds updated on match 789"

LRANGE notifications:user:456 0 9    # Last 10 notifications
RPOP notifications:user:456          # Process oldest notification

# Blocking pop — consumer waits for new items (no polling)
BRPOP job:queue 0                    # Block indefinitely until item arrives
```

**Winamax use case:** Notification queues, simple task queues for low-throughput internal jobs, recently viewed bets per user.

**Caution:** Lists do not support consumer groups or acknowledgments. If a consumer crashes after `BRPOP` but before processing, the item is lost. For reliable processing, use Redis Streams or Kafka.

---

## Sorted Set — ranked data

A set where each member has a score. Members are unique; scores can repeat. Retrieval by rank (ZRANGE) or score range (ZRANGEBYSCORE) is O(log N + M) where M is the number of returned elements.

```redis
# Add players to a tournament leaderboard
ZADD tournament:1234:leaderboard 15000 "player:farouq"
ZADD tournament:1234:leaderboard 22500 "player:alice"
ZADD tournament:1234:leaderboard 8000  "player:bob"

# Get top 10 by descending score
ZREVRANGE tournament:1234:leaderboard 0 9 WITHSCORES

# Get player's rank (0-indexed)
ZREVRANK tournament:1234:leaderboard "player:farouq"

# Rate limiting: use timestamp as score, trim old entries
ZADD ratelimit:user:456:requests 1712500100 "req_abc"
ZREMRANGEBYSCORE ratelimit:user:456:requests 0 1712500040  # Remove entries older than 60s
ZCARD ratelimit:user:456:requests                           # Count requests in window
```

**Winamax use case:** Poker tournament leaderboards (updated on every hand result), sliding window rate limiting, scheduling delayed events (score = Unix timestamp of execution time), sports match ranking.

**K8s bridge:** `ZADD` with timestamp as score + `ZRANGEBYSCORE` is how you implement a delayed job queue entirely in Redis — like a lightweight version of what Kubernetes does with scheduled requeue timers.

---

## Set — unique membership

An unordered collection of unique strings. O(1) for add, remove, and membership check. Supports set operations: `SUNION`, `SINTER`, `SDIFF`.

```redis
SADD match:789:active_bettors "user:456" "user:789" "user:101"
SISMEMBER match:789:active_bettors "user:456"   # 1 (true)
SCARD match:789:active_bettors                  # Count of unique bettors

# Find users who bet on both match A and match B
SINTER match:789:active_bettors match:790:active_bettors
```

**Winamax use case:** Tracking which users have an active bet on a specific match (for real-time notifications when odds change), deduplication of processed event IDs, blacklisting.

---

## Stream — persistent ordered event log

A stream is an append-only log. Each entry has an auto-generated ID (`timestamp-sequence`) and arbitrary field-value pairs. Supports consumer groups — multiple consumers can coordinate reading, with per-consumer acknowledgment.

```redis
# Producer: append an event
XADD bet:events * betId 88991234 userId 456 action "placed" amount 25.00

# Consumer group: create
XGROUP CREATE bet:events processors $ MKSTREAM

# Consumer reads up to 10 new messages (> means "messages not yet delivered to this group")
XREADGROUP GROUP processors consumer-1 COUNT 10 BLOCK 1000 STREAMS bet:events >

# Acknowledge processed messages
XACK bet:events processors 1712500100-0

# Check pending (delivered but not acknowledged) messages
XPENDING bet:events processors - + 10
```

**Consumer group semantics:**
- `>` means "give me messages not yet delivered to any consumer in this group"
- Each consumer in the group gets a different subset of messages — no duplicate processing
- After crash/restart, `XPENDING` shows what was delivered but not acknowledged — claim those with `XCLAIM` for reprocessing

**Winamax use case:** Real-time Casino event streams (card dealt, bet placed, outcome), short-lived event pipelines where you want Redis-native delivery guarantees without the overhead of a full Kafka topic.

---

## Memory footprint summary

| Type | Memory per entry | Use when |
|------|-----------------|----------|
| String | 50–100 bytes overhead + value | Simple scalar values, atomic ops |
| Hash | Very efficient for <128 fields | Structured entities (bets, users) |
| List | ~40 bytes per element | Ordered queues, stacks |
| Sorted Set | ~90 bytes per element | Ranked data, rate limiting, delayed jobs |
| Set | ~40 bytes per element | Unique membership, set math |
| Stream | ~100 bytes per entry | Event logs with delivery guarantees |

---

## Key naming conventions

Consistent key naming prevents collisions and makes debugging possible.

Pattern: `{namespace}:{entity_type}:{id}:{attribute}`

```
bet:record:88991234            # Hash of bet data
user:session:456               # String: session token
tournament:1234:leaderboard    # Sorted set: player scores
match:789:active_bettors       # Set: unique bettors
bet:events                     # Stream: bet event log
ratelimit:user:456:api:minute  # String: counter
```

With Redis Cluster, use hash tags to co-locate related keys on the same slot:
`{user:456}:session`, `{user:456}:cart`, `{user:456}:preferences` — all route to the same slot, enabling multi-key operations.
