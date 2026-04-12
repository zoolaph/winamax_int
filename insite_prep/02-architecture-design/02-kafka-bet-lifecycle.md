# Architecture Design 02 — Kafka Topic Layout for the Bet Lifecycle

## Set the timer: 10 minutes. Close your notes.

---

## The constraints

- 900,000 bets/day, peaks at ~10,000 bets/sec during major matches
- Cluster-wide throughput: 75,000 msg/sec
- Bet lifecycle events: BET_PLACED, BET_ACCEPTED, BET_REJECTED, BET_SETTLED, BET_CANCELLED
- Consumers:
  - **Fraud detection**: must process all events for the same bet in order, needs 2-day replay window
  - **Settlement service**: processes BET_SETTLED only, must be exactly-once (no double payouts)
  - **Analytics pipeline**: receives all events, order does not matter, needs 30-day retention
  - **Live odds service**: needs BET_PLACED near real-time to adjust odds, latency-sensitive
  - **Notification service**: sends user notifications on BET_ACCEPTED and BET_SETTLED
- Replication must tolerate 1 broker failure without data loss
- The cluster runs 6 brokers

**Design:**
1. Topic names and what goes in each
2. Message key strategy and why
3. Partition count per topic with calculation
4. Replication factor and min.insync.replicas
5. Retention policy per topic
6. How settlement achieves exactly-once
7. Consumer group strategy

**Draw the data flow. Show your math for partition count.**

---

**STOP. Design it now.**

---
---
---
---
---
---

## Reference design

### Topic layout

```
TOPIC: bet-events
  Purpose: All bet lifecycle events (PLACED, ACCEPTED, REJECTED, CANCELLED)
  Key: bet_id
  Consumers: fraud-detection, analytics, live-odds, notification
  Retention: 2 days (fraud detection's max replay window)

TOPIC: bet-settled
  Purpose: BET_SETTLED events only
  Key: bet_id
  Consumer: settlement-service (exactly-once)
  Retention: 2 days

TOPIC: bet-analytics
  Purpose: Mirror of all events for analytics
  Key: null (round-robin — order does not matter for analytics)
  Consumer: analytics-pipeline
  Retention: 30 days
```

**Why separate bet-settled from bet-events?**

The settlement service needs exactly-once semantics. Implementing Kafka transactions on a high-throughput topic consumed by multiple groups is complex. A dedicated topic lets the settlement service use transactions without affecting other consumers. It also has different retention requirements and different throughput characteristics.

**Why a separate analytics topic?**

The analytics pipeline needs 30-day retention. If you set `bet-events` to 30 days, you are storing 30 days of data that fraud detection only needs for 2 days — wasting disk proportionally. A separate topic for analytics allows different retention per use case.

Alternative: use a single `bet-events` topic with 30-day retention and accept the storage cost. Defensible trade-off if operational simplicity matters more than storage cost.

### Message key strategy

```
bet-events:     key = bet_id (string)
bet-settled:    key = bet_id
bet-analytics:  key = null
```

`bet_id` as the key ensures all lifecycle events for a given bet land on the same partition. This guarantees ordering within a bet: PLACED always arrives before ACCEPTED before SETTLED for the same bet_id.

Fraud detection relies on this ordering — it builds per-bet state as events arrive in sequence. Without `bet_id` as the key, events for the same bet could arrive on different partitions in any order.

### Partition count calculation

```
bet-events topic:

Peak production rate: 10,000 bets/sec (BET_PLACED events at peak)
Average message size: ~1 KB (bet metadata, event type, timestamp)
Peak throughput: 10 MB/sec

Safe throughput per partition:
  Producer side: ~10 MB/sec (limited by broker disk write throughput)
  Consumer side: fraud-detection needs to process 10,000 msg/sec total
  
Fraud detection consumer throughput: 
  ~50ms per message processing time
  With 1 consumer per partition = 20 msg/sec per partition
  For 10,000 msg/sec total: 10,000 / 20 = 500 partitions

That is too many partitions for most clusters.

Realistic approach:
  Fraud detection should be async and fast — target 5ms per message
  At 5ms: 200 msg/sec per consumer
  For 10,000 msg/sec: 10,000 / 200 = 50 partitions

Round to: 64 partitions (next power of 2 for even distribution)

At 64 partitions with 6 brokers: ~10-11 partitions per broker (balanced)
```

```
bet-settled topic:
  ~10% of bets settle per minute at peak (the rest are pre-match)
  Peak: ~1,000 BET_SETTLED/sec
  Settlement is slow (DB writes): 100ms per message
  At 100ms: 10 msg/sec per consumer
  For 1,000 msg/sec: 1,000 / 10 = 100 partitions
  
  Round to: 128 partitions
  
  Note: settlement throughput is the bottleneck, not Kafka.
  If 128 consumers are too many to manage, use 32 partitions
  and optimize the settlement consumer to 25ms per message.
```

```
bet-analytics topic:
  Same event volume as bet-events but lower consumer throughput requirement
  Analytics is batch-oriented, lag is acceptable
  24 partitions — enough for parallelism, manageable overhead
```

### Replication and ISR

```
All topics:
  replication.factor = 3
  min.insync.replicas = 2

With 6 brokers and RF=3:
  Each partition has 1 leader + 2 followers
  Tolerates 1 broker failure without interrupting writes
  
  If 2nd broker fails simultaneously:
    ISR drops to 1 (below min.insync.replicas=2)
    Writes rejected (not silently degraded)
    This is correct — surfaces the problem rather than losing data silently
```

### Retention policy

```
bet-events:      retention.ms = 172800000    (2 days)
bet-settled:     retention.ms = 172800000    (2 days)
bet-analytics:   retention.ms = 2592000000   (30 days)
```

The 30-day analytics retention is stored on the analytics topic only. `bet-events` stays at 2 days — cheaper, smaller footprint.

### Exactly-once for settlement

**Option A: Idempotent consumer (recommended)**

The settlement service writes to an Aurora table using a unique constraint on `bet_id`:

```sql
INSERT INTO settlements (bet_id, amount, settled_at)
VALUES ($1, $2, NOW())
ON CONFLICT (bet_id) DO NOTHING;
```

If the consumer reprocesses a BET_SETTLED event (crash after processing, before commit), the second `INSERT` is a no-op. The player's balance is updated exactly once regardless of how many times the message is processed.

This is at-least-once delivery + idempotent consumer = effectively exactly-once. Simpler than Kafka transactions, no performance overhead.

**Option B: Kafka transactions (when idempotent consumer is not sufficient)**

The settlement service reads from `bet-settled`, writes to `balance-updates` topic, and commits the offset atomically. Used when the output itself (not just the DB write) must be deduplicated. More complex, higher latency.

For Winamax: Option A is the right choice. The idempotency key is the bet_id, and the Aurora constraint enforces it.

### Consumer group strategy

```
bet-events topic consumers:
  group: fraud-detection-service    (64 consumers, 1 per partition)
  group: analytics-pipeline         (reads from bet-analytics, not this topic)
  group: live-odds-service          (16 consumers, latency-sensitive)
  group: notification-service       (8 consumers)

bet-settled topic:
  group: settlement-service         (128 consumers, 1 per partition)

bet-analytics topic:
  group: analytics-pipeline         (24 consumers)
```

Each consumer group maintains its own offset independently. Adding a new consumer (notification service) does not affect existing groups — it starts from its configured offset without disturbing fraud detection's position.

### Data flow diagram

```
Betting API
    │
    │ BET_PLACED (key=bet_id)
    ▼
bet-events ──────────────────────────────────────────────┐
  [64 partitions]                                         │
    │               │                │                    │
    ▼               ▼                ▼                    ▼
fraud-detection  live-odds       notification        analytics-mirror
  (in-order,       (latency-        (on ACCEPTED       Lambda/Kinesis
   per-bet_id)     sensitive,       and SETTLED)       → bet-analytics
                   16 consumers)                        [24 partitions]
                                                              │
                                                              ▼
BET_SETTLED event ──────────────────────────────► bet-settled analytics-pipeline
  (published by                                    [128 partitions] (30-day retention)
   bet-validator)                                       │
                                                        ▼
                                                  settlement-service
                                                  (idempotent INSERT,
                                                   ON CONFLICT DO NOTHING)
```
