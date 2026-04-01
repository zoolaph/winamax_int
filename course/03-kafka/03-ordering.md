# Kafka Ordering Guarantees — When You Have Them, When You Don't

## The single rule

**Kafka guarantees ordering within a partition. It guarantees nothing across partitions.**

That is the entire model. Everything else in this file is a consequence of that rule.

---

## Why ordering matters at Winamax

Consider the bet lifecycle:

```
BET_PLACED   → BET_ACCEPTED → BET_SETTLED
  offset 0       offset 1       offset 2
```

If these three events are processed out of order:
- `BET_SETTLED` before `BET_PLACED` → the settlement service tries to settle a bet that does not exist
- `BET_ACCEPTED` before `BET_PLACED` → same problem
- `BET_PLACED` twice → duplicate bet

Ordering is a correctness requirement for financial state machines.

---

## How ordering is preserved: the message key

When a producer sends a message with a key, Kafka's default partitioner hashes the key to select a partition. The same key always maps to the same partition (assuming partition count does not change).

```
Producer sends:
  key="player_12345", event=BET_PLACED   → hash("player_12345") % 12 = partition 7
  key="player_12345", event=BET_ACCEPTED → hash("player_12345") % 12 = partition 7
  key="player_12345", event=BET_SETTLED  → hash("player_12345") % 12 = partition 7

All three land on partition 7, in order.
```

The consumer reading partition 7 will see them in the order they were produced.

---

## When ordering breaks — the failure modes

### Failure 1: No message key (random partitioning)

```
key=null → random partition selection
  BET_PLACED   → partition 3
  BET_ACCEPTED → partition 7
  BET_SETTLED  → partition 1
```

Three different partitions, three different consumers, no ordering guarantee. Consumer reading partition 1 processes `BET_SETTLED` before the consumer on partition 3 finishes `BET_PLACED`.

**Fix:** Always use a stable, meaningful message key for ordered event streams. For the bet lifecycle, use `bet_id` as the key.

### Failure 2: Partition count change

If you increase the topic's partition count, the hash function `hash(key) % N` produces different results for the same key. A key that went to partition 7 on a 12-partition topic may go to partition 11 on a 24-partition topic.

During the transition:
- Messages with the same key before the change are on partition 7
- Messages after the change are on partition 11
- No consumer will see them in order

**Fix:** Never change partition count on a topic that requires ordering. If you must scale, use topic mirroring to a new topic with the higher partition count, drain the old topic, then cut over.

### Failure 3: Multiple producers with no coordination

If two producer instances simultaneously write events for the same key:

```
Producer A: BET_PLACED at t=100ms → arrives at partition 7 first
Producer B: BET_ACCEPTED at t=99ms → arrives at partition 7 second

Partition 7 contains: [BET_PLACED, BET_ACCEPTED] — correct, despite producer B sending earlier
```

Kafka's ordering guarantee is about arrival order at the broker, not production time. If both producers are writing to the same partition, Kafka serializes their writes. The issue arises only if one event must causally precede another and there is no coordination at the producer side.

**Fix:** For a single entity's lifecycle events, route through a single producer or use distributed coordination to ensure producer-side ordering.

### Failure 4: Consumer parallelism within a partition

A consumer group assigns one partition to one consumer instance. That instance processes messages serially within the partition. **If you parallelize within the consumer** (e.g., spawn a thread pool to process multiple messages concurrently), you break ordering.

```javascript
// WRONG: concurrent processing breaks partition ordering
for (const message of messages) {
  pool.submit(() => processMessage(message)); // order of completion is non-deterministic
}
```

```javascript
// CORRECT: sequential processing preserves order
for (const message of messages) {
  await processMessage(message); // next message waits for current to complete
}
```

---

## Global ordering (across partitions) — almost always wrong

If you need absolute global ordering of all events in a topic (e.g., "process every event across all players in the exact order they were produced"), you need a single partition. That means:
- Maximum parallelism: 1 consumer
- Throughput bottleneck: whatever one partition and one consumer can handle

At 75,000 msg/sec, a single partition is not viable. **Global ordering is almost always the wrong requirement.** The actual requirement is usually per-entity ordering: "process all events for player X in order." That is partition-level ordering by key — achievable with multiple partitions.

If you are ever asked about global ordering, probe what the actual requirement is. It is almost always reducible to per-key ordering.

---

## Exactly-once with ordering

Even with idempotence and transactions, the ordering guarantee remains at the partition level. Transactions do not change which partition a message lands on — they only ensure atomicity across writes to multiple topics.

---

## Summary — the design checklist for ordered event streams

1. Define the ordering unit: what entity must have its events ordered? (player, bet, tournament)
2. Use that entity's ID as the message key
3. Never change partition count for this topic without a migration plan
4. Never parallelize processing within a single partition in your consumer
5. If you need ordering across multiple topics for the same entity, that requires application-level sequencing (not a Kafka feature)
6. Test ordering under load — ordering bugs often only appear under high concurrency
