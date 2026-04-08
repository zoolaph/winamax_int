# Redis Streams vs Kafka — Deep Dive

Winamax uses both. Understanding when to use each — and being able to articulate the trade-offs clearly — is the expected depth.

---

## The core difference: storage model

**Kafka:** Messages are written to disk on a distributed, partitioned log. A topic has N partitions spread across N brokers. Messages persist for a configured retention period (days to weeks) regardless of whether they have been consumed. Consumers can re-read from offset 0 at any time.

**Redis Streams:** Messages are written to memory. A stream lives on one Redis node (or one shard in cluster mode). Retention is bounded by `MAXLEN` — once the stream reaches the configured length, old entries are trimmed (approximate or exact). There is no replay of trimmed entries.

This single difference drives most of the decision framework.

---

## Delivery semantics — what both systems guarantee

### Both support consumer groups with acknowledgment

Redis:
```redis
XREADGROUP GROUP processors worker-1 COUNT 10 BLOCK 1000 STREAMS bet:events >
# Process messages
XACK bet:events processors 1712500100-0 1712500101-0
```

Kafka:
```
consumer.subscribe(["bet-events"])
records = consumer.poll(1000)
# Process
consumer.commitSync()
```

Both guarantee **at-least-once delivery**: if a consumer crashes before acknowledging, the message is redelivered. Exactly-once requires idempotent processing logic in both cases.

### Key difference: who tracks position

- **Kafka:** The consumer group offset is stored in Kafka (`__consumer_offsets` topic). The broker knows where each group is.
- **Redis:** The pending-entries list (PEL) is stored in the stream itself. `XPENDING` shows unacknowledged messages per consumer. `XCLAIM` lets another consumer take over a stuck message.

---

## Throughput comparison

| Metric | Redis Streams | Kafka |
|--------|--------------|-------|
| Single shard write throughput | ~200,000–500,000 msg/sec | ~1M msg/sec per partition |
| Horizontal scaling | Add more streams (manual sharding) | Add partitions (automatic) |
| Winamax max throughput | Fine for Casino real-time events | Required for 75,000 msg/sec bet pipeline |

**Note:** 75,000 msg/sec is within Redis's range for a single high-memory node, but Kafka's partitioning model is operationally safer for that sustained load — no single point of throughput bottleneck.

---

## Retention comparison

**Kafka:**
- Configured by time (`log.retention.hours=168`) or size (`log.retention.bytes`)
- Messages persist on disk — memory is not the bottleneck
- A consumer that is down for 24 hours comes back and replays from its last committed offset
- Compacted topics: keep only the latest value per key — useful for state tables

**Redis Streams:**
```redis
XADD bet:events MAXLEN ~ 100000 * betId 88991234 ...
# ~ means approximate trimming (faster), exact trimming without ~
```
- Once trimmed, gone. A consumer that is down for too long misses messages.
- Typically used for streams where the consumer is always up and latency matters more than durability.

---

## Operational cost comparison

**Kafka:**
- Separate cluster: 3+ broker nodes + ZooKeeper (or KRaft in newer versions)
- MSK (Amazon Managed Streaming for Kafka) removes the operational burden of broker management but not the networking or cost
- Schema Registry, Kafka Connect, Kafka Streams — the ecosystem adds complexity
- Topic partition rebalancing during consumer group membership changes causes a brief pause

**Redis Streams:**
- No separate infrastructure — streams live in your existing Redis cluster
- Operational simplicity: one tool, one connection, one monitoring stack
- But Redis is memory-limited — you cannot retain 7 days of 75,000 msg/sec messages in memory

---

## Pub/Sub vs Streams — the simpler comparison

Redis also has pub/sub (`PUBLISH`/`SUBSCRIBE`), which is different from streams:

| | Pub/Sub | Streams |
|--|---------|---------|
| Persistence | None — fire and forget | Yes — entries persist until trimmed |
| Consumer groups | No | Yes |
| Replay | No | Yes (within MAXLEN) |
| Delivery guarantee | At-most-once | At-least-once (with ACK) |
| Use case | Real-time notifications (nobody cares if they miss one) | Events that must be processed |

**Use pub/sub for:** Live score updates broadcast to connected WebSocket clients. If a client misses one, the next update will correct it.

**Use streams for:** Casino hand outcomes that must be processed for settlement, audit logs, anything where "I missed that message" is a problem.

---

## The decision framework — Winamax context

```
Is durability required (message must not be lost even if consumer is down for hours)?
  YES → Kafka
  NO  → continue

Is replay of historical events required (new consumer needs to re-read from the beginning)?
  YES → Kafka
  NO  → continue

Is this a cross-team event bus (multiple teams consume the same topic independently)?
  YES → Kafka
  NO  → continue

Is the consumer latency-critical and already using Redis?
  YES → Redis Streams
  NO  → evaluate operational cost of adding Kafka vs using Redis Streams
```

**Winamax-specific mapping:**
- Bet placed → bet settlement pipeline: **Kafka** (durability, cross-service fan-out, replay)
- Casino hand result → game state update: **Redis Streams** (low latency, ephemeral, Casino team owns both producer and consumer)
- Live match score → WebSocket broadcast: **Redis Pub/Sub** (at-most-once is fine, clients reconnect)
- Airflow trigger → batch pipeline: **S3 event → SQS → Lambda** (not Redis/Kafka — this is AWS-native orchestration)

---

## Interview framing

When asked "Kafka vs Redis Streams at Winamax" — the right answer is not "Kafka is better." The right answer is:

> "We use Kafka for the core bet pipeline because we need durability, cross-team fan-out, and guaranteed replay. We use Redis Streams for Casino real-time events where we already have Redis in the stack, the consumer is always up, and latency matters more than replay guarantees. The systems complement each other — we do not try to replace Kafka with Redis."
