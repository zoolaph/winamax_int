# Backpressure — How Upstream Services Protect Themselves When Kafka Is Overwhelmed

## The problem

Kafka does not push back on producers. A producer will write as fast as the broker accepts messages. Consumers can fall behind indefinitely. At 75,000 msg/sec, if the consumer processing pipeline slows down for any reason, lag accumulates — and it accumulates fast.

**Backpressure** is the mechanism by which upstream components signal capacity constraints to downstream components (or vice versa), causing the system to slow its input rate when the processing pipeline cannot keep up.

---

## Why Kafka does not apply backpressure to producers

Kafka is an append-only log. The broker does not know whether consumers are caught up. It accepts writes independently of consumer state. This is by design — Kafka's producer and consumer sides are fully decoupled. But it means: **the responsibility for protecting the system lies with the application layer, not Kafka itself.**

---

## Backpressure mechanism 1: Consumer-side — pause and resume

When a consumer is falling behind and cannot keep up with the partition rate, it can pause specific partitions to create processing breathing room:

```javascript
const kafka = require('kafkajs').Kafka;

consumer.run({
  eachBatch: async ({ batch, pause, resume, heartbeat }) => {
    for (const message of batch.messages) {
      const success = await tryProcess(message);

      if (!success) {
        // Pause this partition — stop fetching new messages for it
        const pauseFn = pause();

        // Schedule resume after recovery time
        setTimeout(() => {
          pauseFn(); // resume
        }, 5000);

        break; // stop processing this batch
      }

      await heartbeat(); // prevent session timeout during slow processing
    }
  },
});
```

Pausing a partition tells the consumer to stop fetching new messages for that partition, but other partitions continue. This is useful when one downstream dependency (e.g., a specific database shard) is slow but others are fine.

---

## Backpressure mechanism 2: Producer throttling at the application layer

The upstream service writing to Kafka can check consumer lag before writing:

```javascript
async function publishBetEvent(event) {
  const lag = await getConsumerGroupLag('fraud-detection-service', 'bet-placed');

  if (lag > LAG_THRESHOLD) {
    // Option A: Wait and retry
    await sleep(100);
    return publishBetEvent(event); // backoff + retry

    // Option B: Drop low-priority events (not appropriate for financial events)
    // Option C: Return HTTP 429 to the caller (only if caller can retry)
  }

  await producer.send({
    topic: 'bet-placed',
    messages: [{ key: event.betId, value: JSON.stringify(event) }],
  });
}
```

This pattern requires the producer to query Kafka consumer group offsets, which adds latency. Use cautiously — if the lag threshold is too aggressive, you throttle valid traffic. Better used as a circuit breaker for non-critical event types than for every message.

---

## Backpressure mechanism 3: Kafka producer `max.block.ms`

If the producer's internal send buffer fills up (because the broker is slow to accept), the `send()` call blocks up to `max.block.ms` (default: 60 seconds), then throws an exception.

```properties
max.block.ms=10000          # block for up to 10 seconds before throwing
buffer.memory=67108864      # 64 MB in-memory buffer before blocking
```

This is implicit backpressure from the broker back to the producer. If you see `TimeoutException: Failed to allocate memory within the configured max blocking time`, the producer is being overwhelmed and needs either faster brokers or reduced production rate.

---

## Backpressure mechanism 4: HTTP API layer — reject requests upstream

The cleanest form of backpressure: reject traffic at the API gateway or service boundary when the internal queue is full.

```
Browser → API Gateway → Bet Service → Kafka
                          ↓ (checks internal queue depth)
                        HTTP 429 (Too Many Requests)
```

If the Bet Service's internal Kafka send buffer is full or consumer lag exceeds a threshold, it returns HTTP 429 with a `Retry-After` header. The client (or API gateway) backs off and retries later. This prevents the entire event pipeline from being overwhelmed.

This is the approach used in high-traffic systems like Winamax during major sporting events (Champions League finals, World Cup matches) where bet volume spikes are predictable and managed.

---

## Backpressure mechanism 5: Consumer scaling (horizontal)

The most operationally clean response to sustained consumer lag: add more consumer instances.

```
Topic: bet-placed (24 partitions)
Current: 8 consumer instances → lag growing
Scale to: 24 consumer instances → 3x throughput, lag decreases

If lag still grows at 24 instances:
  → The bottleneck is not consumer count — it is downstream (DB, external API)
  → Investigate the downstream bottleneck, not Kafka
```

With ECS (Winamax's runtime), this is a Task count update:

```bash
aws ecs update-service \
  --cluster winamax-prod \
  --service fraud-detection \
  --desired-count 24
```

Combined with ECS autoscaling policies triggered by consumer lag CloudWatch metrics, this can be automatic.

---

## Backpressure mechanism 6: Circuit breaker upstream

When a downstream dependency (database, external API) is slow or failing, a circuit breaker in the consumer opens and stops sending requests to it. While the circuit is open, the consumer pauses processing (and accumulates lag intentionally) rather than hammering a failing dependency.

```
Consumer reads message
→ Calls database
→ Database timeout (3 attempts)
→ Circuit breaker opens (state: OPEN)
→ Consumer pauses partition (mechanism 1)
→ Waits 30 seconds
→ Circuit breaker moves to HALF-OPEN
→ Consumer tries one message
→ Success → circuit CLOSED, resume
→ Failure → circuit OPEN again, wait longer
```

Libraries: Netflix Hystrix (deprecated), Resilience4j (JVM), opossum (Node.js).

---

## The backpressure decision tree

```
Consumer lag is growing →
  Is it growing faster than we can scale consumers? →
    NO → Scale consumers horizontally (up to partition count)
    YES → Find the bottleneck:
            Is the downstream DB slow? → DB connection pool tuning / read replicas
            Is an external API rate-limiting us? → Circuit breaker + retry with backoff
            Is there a bad message causing retries? → DLQ pattern (see 03-poison-messages.md)
            Is Kafka itself slow? → Broker performance investigation (disk, network)
            Is the production rate genuinely too high to process? →
              → HTTP 429 at the API layer (shed load at the source)
              → Accept the lag for non-critical topics
              → Alert and escalate
```

---

## Winamax context

During a Champions League final, Winamax likely sees 10-20x normal bet volume for 30-minute windows. The system must absorb this spike without degrading or losing messages.

The layered defense:
1. **API gateway rate limiting** — prevents runaway clients from flooding the system
2. **Kafka as the buffer** — accepts the burst, smooths it over time to downstream consumers
3. **Consumer autoscaling** — ECS scales up consumer task count in response to lag metrics
4. **Partition count** — designed at topic creation to allow enough parallelism for peak load
5. **DLQ** — any processing failures during the burst do not stall partitions

The key insight: **Kafka itself is the backpressure buffer.** The durability and retention of Kafka mean you can accept bursts that exceed instantaneous processing capacity, as long as consumers catch up before retention expires.
