# Poison Messages — DLQ Patterns, Skip vs Halt Strategies

## The problem

A **poison message** is a message your consumer cannot successfully process. It can be:

- **Malformed data:** invalid JSON, unexpected field, wrong encoding
- **Schema incompatibility:** producer upgraded schema, consumer has old deserializer
- **Dependency failure:** the database is down, an external API times-out, a downstream service rejects the event
- **Bug in consumer logic:** unhandled edge case, null pointer, division by zero

The critical consequence: Kafka is an ordered log per partition. If your consumer cannot process offset N, it will never advance past N. Offsets N+1, N+2, N+3 accumulate behind it. **A single poison message can halt an entire partition's consumption indefinitely.**

---

## The failure pattern — illustrated

```
Partition 0:
[offset 100][offset 101][offset 102][offset 103: POISON][offset 104][offset 105]...

Consumer attempts to process offset 103:
  → Deserialization fails: "Unexpected field: bet_currency_v2"
  → Consumer retries (at-least-once retry loop)
  → Fails again
  → Retries again
  → ... continues forever
  → Offset never committed past 103
  → Lag grows: 104, 105, 106... accumulate
```

On Kafka monitoring you will see:
- Lag on partition 0 growing continuously
- Consumer instances are running and healthy
- The consumer logs show the same error repeating

---

## The three strategic responses

### Strategy 1: Retry with backoff (for transient failures)

If the failure is transient (downstream service temporarily unavailable, brief DB overload), retrying after a delay will eventually succeed.

```javascript
async function processWithRetry(message, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await processMessage(message);
      return; // success
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const backoff = Math.min(1000 * Math.pow(2, attempt), 30000); // exponential, max 30s
      await sleep(backoff);
    }
  }
}
```

**When to use:** Dependency failures (DB down, API unavailable). The message itself is valid; the environment is temporarily broken.

**Risk:** If you retry in the consumer's main poll loop, you block the partition. Either retry in a side thread or use Kafka's `pause()/resume()` partition API to pause the affected partition during the retry delay while other partitions continue processing.

---

### Strategy 2: Dead Letter Queue (DLQ) — skip and quarantine

After N failed attempts, move the message to a separate "dead letter" topic and commit the offset. The partition advances; the bad message is not lost — it is quarantined for inspection and manual replay.

```javascript
async function processWithDLQ(message, topic) {
  const MAX_ATTEMPTS = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await processMessage(message);
      return;
    } catch (err) {
      lastError = err;
      await sleep(1000 * attempt);
    }
  }

  // All attempts failed — send to DLQ
  await producer.send({
    topic: `${topic}.dlq`,  // e.g., "bet-placed.dlq"
    messages: [{
      key: message.key,
      value: message.value,
      headers: {
        'dlq-original-topic': topic,
        'dlq-original-partition': String(message.partition),
        'dlq-original-offset': String(message.offset),
        'dlq-error': lastError.message,
        'dlq-failed-at': new Date().toISOString(),
        'dlq-attempts': String(MAX_ATTEMPTS),
      },
    }],
  });

  // Commit the offset — partition advances, DLQ message is the record
  await commitOffset(message);
}
```

**The DLQ topic structure:**

```
bet-placed           → primary topic (fast path)
bet-placed.dlq       → quarantine for failed messages
bet-placed.dlq.retry → optional: replay queue for manual retry after fix
```

**When to use:** Malformed messages, schema issues, persistent deserialization failures. The message cannot be processed regardless of retries. Quarantine it so you can inspect and fix the underlying issue without blocking the partition.

**Alert on DLQ size:** An empty DLQ is healthy. Messages appearing in the DLQ should page the on-call engineer.

```yaml
- alert: KafkaDLQNonEmpty
  expr: kafka_topic_partition_current_offset{topic=~".*\\.dlq"} > 0
  annotations:
    summary: "Dead letter queue has messages — consumer is failing on some inputs"
```

---

### Strategy 3: Halt and alert (for data-corruption risk)

In some cases, skipping a message would corrupt downstream state. If the poison message is a "bet-settled" event and your consumer cannot process it, sending it to a DLQ means the player's balance will never be updated. That is worse than stopping.

```javascript
async function processWithHalt(message) {
  try {
    await processMessage(message);
  } catch (err) {
    logger.fatal({ err, offset: message.offset }, 'Unrecoverable processing failure — halting');
    // Do NOT commit the offset
    // Do NOT send to DLQ
    // Shut down the consumer
    process.exit(1); // or throw to let the orchestrator restart the pod
  }
}
```

**When to use:** When the message represents a state transition that cannot be skipped (financial settlement, balance debit, compliance audit record). Skipping would leave the system in an incorrect state. Halting preserves the guarantee that every message will eventually be processed, once the bug is fixed.

**The trade-off:** Halt causes an incident (partition stops, lag builds, alert fires). DLQ avoids the incident but risks data inconsistency. **You must choose based on business impact.**

---

## The decision framework

```
Can you retry and expect eventual success?
  ├── YES (dependency temporarily unavailable) → Retry with backoff + jitter
  └── NO → Is the message itself malformed or invalid?
              ├── YES and skipping is safe → DLQ + skip + alert
              └── YES but skipping corrupts state → HALT + page oncall
```

In practice, most teams implement both: retry for transient failures (3-5 attempts), then DLQ for persistent failures, except for a small category of critical topics that halt.

---

## DLQ operational procedures

### Inspecting the DLQ

```bash
# Read the first 10 messages from the DLQ
kafka-console-consumer.sh \
  --bootstrap-server kafka-broker:9092 \
  --topic bet-placed.dlq \
  --from-beginning \
  --max-messages 10 \
  --property print.headers=true
```

### Replaying from DLQ after a fix

Once the consumer bug is fixed, replay the DLQ back to the main topic:

```bash
# Option 1: Kafka Mirror Maker / kafka-mirror
# Option 2: A simple replay consumer that reads DLQ and re-publishes to the original topic

# kafka-producer-perf-test can replay to a topic, but a custom script is cleaner
```

A custom replay script:
1. Read from `bet-placed.dlq`
2. Validate the message (if the fix corrected validation logic)
3. Publish to `bet-placed` with the original message key/value
4. Commit DLQ offset

**Important:** Ensure the replayed messages are idempotent — since they have now been seen twice (original attempt + replay), the consumer must handle duplicates.

### Preventing DLQ buildup from schema issues

If DLQ fills up due to schema evolution (new fields consumers do not recognize), the fix is to deploy the updated consumer schema and replay. This is why a schema registry matters: with a schema registry, the producer cannot deploy an incompatible schema without the consumer being updated first (depending on compatibility mode).

---

## Winamax context

At 75,000 msg/sec, if even 0.001% of messages are malformed, that is 75 poison messages per second. Without DLQ handling, they would stall partitions within seconds. DLQ is not optional at this scale — it is a required safety valve for any consumer that cannot guarantee 100% deserialization success on all future messages.

The deeper lesson: invest in schema governance (schema registry, compatibility checks in CI) to prevent poison messages at the source, and invest in DLQ infrastructure to handle the ones that slip through.
