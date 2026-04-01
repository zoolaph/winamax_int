# Kafka Consumer Patterns — At-Least-Once, Exactly-Once, Idempotent Consumers

## The core question: when do you commit the offset?

The processing guarantee is not a Kafka feature — it is a consequence of when your application commits its offset relative to when it processes the message.

```
Message received → [commit?] → Process message → [commit?]
```

---

## At-most-once

Commit the offset **before** processing.

```
1. Read message at offset 42
2. Commit offset 43 to Kafka
3. Process message
4. [CRASH HERE]
→ On restart, consumer reads from offset 43
→ Message at offset 42 was NEVER processed
```

**Guarantee:** Each message is processed at most once. Failures cause data loss.

**Use case:** Very rarely correct. Acceptable only if the cost of reprocessing exceeds the cost of loss — e.g., a firehose of low-value telemetry where duplicates would be more damaging than occasional gaps. Almost never used at Winamax.

---

## At-least-once (the default, and correct for most cases)

Commit the offset **after** processing.

```
1. Read message at offset 42
2. Process message
3. Commit offset 43
4. [CRASH AFTER STEP 2 BUT BEFORE STEP 3]
→ On restart, consumer reads from offset 42 again
→ Message at offset 42 is processed AGAIN
```

**Guarantee:** Each message is processed at least once. Failures cause reprocessing (duplicates), not loss.

**Use case:** Almost everything. The standard Kafka consumption model. The application must handle duplicates — either by making the processing idempotent or by deduplicating downstream.

### Auto-commit trap

`enable.auto.commit=true` (default in most clients) commits on a schedule, not after processing:

```
1. Read messages at offsets 42, 43, 44
2. Auto-commit fires: commits offset 45
3. Begin processing offset 42
4. CRASH
→ On restart, consumer reads from offset 45
→ Offsets 42, 43, 44 are LOST
```

This accidentally gives you at-most-once behavior. For production: **disable auto-commit** and call `consumer.commitSync()` or `consumer.commitAsync()` explicitly after processing.

```javascript
// Node.js kafka-node / kafkajs example
consumer.run({
  eachMessage: async ({ message, heartbeat }) => {
    await processMessage(message);           // process first
    await consumer.commitOffsets([...]);     // then commit
  },
});
```

---

## Exactly-once semantics (EOS)

**Exactly-once** means a message is processed exactly once even in the presence of failures. This requires coordination between the consumer, the processing logic, and the output.

### The read-process-write pattern

```
Consumer reads from topic A
→ Transforms data
→ Writes result to topic B
→ Commits offset for topic A
```

Without transactions: if the consumer crashes after writing to B but before committing offset A, it replays offset A and writes to B again → duplicate in B.

With Kafka transactions (exactly-once):

```java
// All three operations are atomic
producer.beginTransaction();
  producer.send("topic-B", result);
  producer.sendOffsetsToTransaction(currentOffsets, groupId);
producer.commitTransaction();
```

If the transaction aborts, consumers of topic B configured with `isolation.level=read_committed` will not see the uncommitted output.

### Cost of exactly-once

- ~2-3x latency overhead from transaction coordinator round-trips
- Requires `transactional.id` per producer instance (must be unique and stable)
- Requires topic B to have `cleanup.policy=delete` (compaction breaks EOS)
- Complexity: transaction coordinator, `__transaction_state` topic, zombie fencing

**Winamax's approach:** For most pipelines, at-least-once + idempotent consumer logic. Kafka transactions reserved for genuine double-spend risks (bet settlement writing to the balance topic).

---

## Idempotent consumers

The practical solution for at-least-once + no-duplicate side effects:

Design the consumer so that processing the same message twice has the same outcome as processing it once.

### Pattern 1: Upsert by event ID

```sql
INSERT INTO bets (bet_id, player_id, amount, status, event_time)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (bet_id) DO UPDATE SET status = EXCLUDED.status;
```

Re-processing the same `bet_id` event overwrites with the same data — no net change.

### Pattern 2: Deduplicate with a seen-IDs store

```javascript
async function processMessage(message) {
  const eventId = message.headers['event-id'];
  if (await redis.exists(`processed:${eventId}`)) {
    return; // already processed, skip
  }
  await doActualWork(message);
  await redis.setex(`processed:${eventId}`, 86400, '1'); // TTL: 24h
}
```

TTL on the dedup store ensures it does not grow forever. Works well if your retry window is bounded (e.g., at-least-once with a 1-hour processing guarantee — set TTL > 1 hour).

### Pattern 3: Conditional state transition

```javascript
// Only transition bet status if current state allows it
// "settled" cannot go back to "accepted"
if (currentBet.status === 'accepted' && event.type === 'BET_SETTLED') {
  await updateBetStatus(event.betId, 'settled');
}
// If bet is already 'settled', this is a no-op → safe to replay
```

State machines are naturally idempotent — a transition that has already occurred simply does not re-trigger.

---

## Consumer group rebalance and offset management

### Graceful shutdown

Always call `consumer.close()` on shutdown. This commits the current offset and sends a leave-group request to the broker, triggering an immediate rebalance rather than waiting for the session timeout (`session.timeout.ms`). Failing to close cleanly means the broker waits up to 45 seconds before reassigning partitions.

### `max.poll.interval.ms`

If your message processing takes longer than `max.poll.interval.ms` (default: 5 minutes), the broker assumes the consumer is dead and triggers a rebalance. For batch-heavy consumers:

```properties
max.poll.interval.ms=600000   # 10 minutes if processing is slow
max.poll.records=50           # reduce batch size to process faster
```

### Partition assignment strategies

| Assignor | Behavior | Use case |
|---|---|---|
| `RangeAssignor` (default) | Assigns contiguous ranges of partitions per consumer | Simple but uneven when partition count is not divisible by consumer count |
| `RoundRobinAssignor` | Distributes partitions evenly across consumers | Better balance |
| `StickyAssignor` | Tries to preserve existing assignments during rebalance | Reduces rebalance disruption |
| `CooperativeStickyAssignor` | Incremental rebalance — only moves partitions that need to move | Best for production at scale |

---

## Winamax decision matrix

| Use case | Pattern | Reason |
|---|---|---|
| Bet placed → fraud check | At-least-once + idempotent (upsert) | Fraud check replay is safe; transaction overhead not worth it |
| Bet placed → balance debit | At-least-once + conditional state machine | Balance debit with existing idempotency key prevents double-charge |
| Analytics event → data warehouse | At-least-once | Duplicate analytics rows are filtered in the warehouse query layer |
| Consume → transform → produce pipeline | Exactly-once (transactions) | If the output topic feeds billing, duplicates are unacceptable |
| Odds update → WebSocket broadcast | At-most-once | Stale odds are discarded by the client anyway; loss is acceptable |
