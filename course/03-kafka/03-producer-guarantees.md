# Kafka Producer Guarantees — acks, Idempotence, Retries

## Why this matters at Winamax

A bet-placed event that gets lost = a player bet real money and has no record. A bet-placed event that gets duplicated = a player's bet is processed twice, their balance double-debited. Both are catastrophic. Producer guarantees are how you prevent each failure mode.

---

## The three-axis trade-off

Every producer configuration is a trade-off across three axes:

| Axis | Low | High |
|---|---|---|
| **Durability** | Messages can be lost | Messages survive broker failures |
| **Throughput** | Slow (waiting for acks) | Fast (fire and forget) |
| **Latency** | High (waiting for quorum) | Low (async, no waiting) |

Winamax financial events need maximum durability. Analytics events can trade some durability for throughput. You configure this per-topic or per-producer instance.

---

## `acks` — acknowledgment level

The `acks` setting controls how many brokers must acknowledge a write before the producer considers it successful.

### `acks=0`

Producer sends the message and does not wait for any acknowledgment.

```
Producer → Broker 1 (leader)
           [no response waited for]
```

- **Throughput:** Maximum — no round-trip waiting
- **Durability:** Zero. If the broker drops the message (full disk, crash), it is lost with no way to detect it
- **Use case:** High-volume metrics, logs where occasional loss is acceptable. Never for financial events.

### `acks=1`

Producer waits for the leader broker to acknowledge the write.

```
Producer → Broker 1 (leader) → ack
                ↓
           (follower replication happens asynchronously)
```

- **Throughput:** Good
- **Durability:** Medium. If the leader crashes after acknowledging but before followers replicate, the message is lost (follower elected as new leader does not have it)
- **Use case:** Acceptable for non-critical pipelines where the replication window is small

### `acks=all` (or `-1`)

Producer waits for all ISR (In-Sync Replica) members to acknowledge.

```
Producer → Broker 1 (leader)
                ↓
           Broker 2 (follower) → ack
           Broker 3 (follower) → ack
                ↓
           Leader sends ack to producer
```

- **Throughput:** Lower — must wait for all ISR members
- **Durability:** Maximum. Message survives any single broker failure (with RF=3)
- **Requires:** `min.insync.replicas=2` (or higher) to ensure the ISR has at least 2 members and a single broker outage does not break writes

---

## Idempotent producer

Problem without idempotence:

```
1. Producer sends message M (sequence unknown to broker)
2. Broker writes M, sends ack
3. Network drops the ack (producer never receives it)
4. Producer retries: sends M again
5. Broker writes M again → DUPLICATE
```

With `enable.idempotence=true`:

- The producer assigns a **Producer ID (PID)** and a **sequence number** to each message
- The broker tracks the last sequence number received per PID per partition
- On retry, the broker sees the same PID+sequence → deduplicates silently

```java
Properties props = new Properties();
props.put("enable.idempotence", "true");
// This automatically sets: acks=all, retries=Integer.MAX_VALUE, max.in.flight.requests.per.connection=5
```

**Important:** Idempotence guarantees deduplication within a single producer session (same PID). If the producer process restarts, it gets a new PID — a retry after restart could still produce a duplicate if the original write succeeded but was not confirmed before the crash.

---

## Retries

Without retries, a transient network failure = lost message. With retries:

```java
props.put("retries", Integer.MAX_VALUE);         // retry indefinitely
props.put("retry.backoff.ms", 100);              // wait 100ms between retries
props.put("delivery.timeout.ms", 120000);        // give up after 2 minutes total
```

**`max.in.flight.requests.per.connection`** — controls how many unacknowledged requests can be in-flight simultaneously. If this is > 1 and retries are enabled but idempotence is disabled, a retry for batch N could arrive after batch N+1, causing out-of-order delivery. With `enable.idempotence=true`, Kafka handles this safely up to `max.in.flight=5`.

---

## The production-safe configuration

For financial/critical events at Winamax:

```properties
# Durability
acks=all
min.insync.replicas=2          # topic-level config, not producer
replication.factor=3           # topic-level config

# Deduplication
enable.idempotence=true        # automatically sets acks=all and max.in.flight=5

# Retry behavior
retries=2147483647             # Integer.MAX_VALUE — retry until delivery.timeout
delivery.timeout.ms=120000     # total time budget for a message to be delivered
retry.backoff.ms=100

# Batching (throughput tuning)
linger.ms=5                    # wait up to 5ms to batch more messages together
batch.size=65536               # 64KB batch size
compression.type=lz4           # reduces network and disk IO
```

---

## Transactions — true exactly-once production

For cases where you need exactly-once semantics across multiple topics or combined with a consumer commit (read-process-write pipeline), Kafka supports transactions:

```java
producer.initTransactions();
try {
    producer.beginTransaction();
    producer.send(new ProducerRecord<>("output-topic", result));
    producer.sendOffsetsToTransaction(offsets, consumerGroupId); // atomic with output
    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

Transactions are expensive (2-3x latency overhead) and complex. Use only when:
- Duplicate processing would cause incorrect financial state (double bet settlement)
- You are running a consume-transform-produce pipeline and need atomic exactly-once

Most Winamax pipelines use at-least-once + idempotent consumers rather than Kafka transactions.

---

## Common producer failure modes

### Scenario: producer gets `NotEnoughReplicasException`

Cause: ISR dropped below `min.insync.replicas` (a broker restarted or fell behind).

Response:
- Short-term: produce will fail with retries until ISR recovers
- Check broker health: `kafka-topics.sh --describe --topic <topic>` to see ISR
- Do NOT lower `min.insync.replicas` to "fix" it — that defeats the durability guarantee

### Scenario: producer throughput drops suddenly

Possible causes:
- Batch accumulation (`linger.ms` too high for the load pattern)
- Broker leader concentrated on one broker (partition imbalance)
- Network saturation to a single broker
- GC pause on the producer JVM

Check: JMX metric `record-send-rate` and `request-latency-avg` on the producer.

### Scenario: messages arrive out of order

Cause: `max.in.flight.requests.per.connection > 1` with retries enabled and idempotence disabled.

Fix: set `enable.idempotence=true` (which sets `max.in.flight=5` safely) or set `max.in.flight=1` (lower throughput but strict order).

---

## Summary — the safety triangle

```
         Durability
            (acks=all)
               ▲
              / \
             /   \
            /     \
  Throughput ——— Deduplication
  (batching,    (idempotence,
   linger.ms)    transactions)
```

You pick two of three at the extremes. In practice, `acks=all` + `enable.idempotence=true` + reasonable batching gives you good durability and deduplication with only moderate throughput sacrifice. Pure throughput mode (`acks=0`) is for non-critical analytics only.
