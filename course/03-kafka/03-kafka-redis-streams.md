# Kafka vs Redis Streams — Why Both Exist in the Stack

## The core distinction

Kafka and Redis Streams both handle event streams, but they optimize for different properties:

| Property | Kafka | Redis Streams |
|---|---|---|
| **Durability** | Persistent log on disk, replicated | In-memory, optional AOF/RDB persistence |
| **Retention** | Days to weeks (configurable) | Limited by RAM |
| **Throughput** | Millions of msg/sec (distributed) | Hundreds of thousands/sec per node |
| **Latency** | Low (milliseconds) | Very low (sub-millisecond) |
| **Consumer model** | Consumer groups, committed offsets | Consumer groups with XREADGROUP |
| **Replay** | Yes — consumers can seek to any offset | Limited — only messages still in memory |
| **Scale-out** | Horizontal (add brokers and partitions) | Vertical (more RAM) or Redis Cluster |
| **Ordering** | Per-partition | Per stream |
| **Use case focus** | Durable async workflows, event sourcing | Real-time low-latency fan-out, ephemeral queues |

---

## What Kafka is better for

### Durable event log

Kafka is an append-only commit log. Messages are retained on disk for a configurable period. This enables:

- **Replay:** a new consumer group can start from offset 0 and reprocess all historical events
- **Audit:** the Kafka log is an audit trail of every event that occurred
- **Multiple independent consumers:** the fraud service, analytics pipeline, and settlement service all consume from the same `bet-placed` topic without interfering

At Winamax:
- `bet-placed` events → durable Kafka topic (retained for 7+ days)
- `bet-settled` events → durable Kafka topic (financial record)
- Odds change events → may go to either, depending on whether historical odds matter

### High-throughput async processing

75,000 msg/sec is Kafka's natural territory. Kafka is designed to sustain this throughput with many producers and consumers, across many topics, over extended periods. The underlying storage model (sequential disk writes, zero-copy reads) is purpose-built for this.

### Decoupled microservices

Kafka enables producers and consumers to be completely decoupled. The bet-placement service does not know whether the fraud service or analytics pipeline is running. It writes to Kafka and moves on. This decoupling is fundamental to Winamax's 700+ microservice architecture.

---

## What Redis Streams is better for

### Real-time fan-out with sub-millisecond latency

A player watching a live match needs odds updates within tens of milliseconds. Kafka is fast, but the round-trip for read-from-Kafka → push-to-WebSocket adds latency. Redis Streams (or Redis pub/sub) operates in memory with sub-millisecond read latency.

At Winamax, odds update events from the odds calculation engine likely flow through Redis to a WebSocket broadcast layer:

```
Odds engine → Redis Streams/pub/sub → WebSocket broadcast service → Browser
             (sub-ms read latency)   (push to 250k+ concurrent users)
```

### Ephemeral state and short-lived queues

For things like "user session event stream" or "live session activity feed," you want fast reads and do not need to retain the data for days. Redis's TTL mechanism is a natural fit — set the stream key to expire and it auto-cleans.

### Small-scale, low-complexity pipelines

Setting up Kafka for a two-producer, one-consumer flow is heavy. Redis Streams is operationally simpler for lightweight use cases within a single service or a small group of services.

---

## The Winamax mental model

```
Kafka: the backbone
  ├── bet-placed events (durable, financial, audited)
  ├── bet-settled events (durable, financial, audited)
  ├── fraud signals (durable, replayed on model update)
  ├── analytics events (durable, multiple consumers)
  └── player balance changes (durable, exactly-once critical)

Redis: the fast lane
  ├── live odds updates (sub-ms latency, WebSocket fan-out)
  ├── live match score events (real-time broadcast)
  ├── user session state (ephemeral, expires with session)
  └── short-TTL rate limiting / throttling (per-IP, per-user)
```

---

## The failure mode for each

### If Kafka is down

- New bet placement events cannot be processed asynchronously
- Fraud detection falls behind (lag accumulates)
- Analytics data gaps
- Settlement processing halts
- **Severity: critical — financial operations affected**

### If Redis is down

- Live odds updates stop flowing to browsers
- WebSocket connections cannot push new odds
- Users see stale odds until they refresh
- **Severity: high — user experience degraded, but no financial data lost**

The distinction matters for incident prioritization and SLO design.

---

## Redis Streams: quick operational notes

Redis Streams were introduced in Redis 5.0. Key commands:

```bash
# Add a message to a stream
XADD odds-update * match_id 12345 home_odds 2.10 away_odds 1.80

# Read new messages (non-blocking)
XREAD COUNT 100 STREAMS odds-update 0

# Consumer group read (marks messages as pending until acknowledged)
XREADGROUP GROUP websocket-broadcast consumer-1 COUNT 100 STREAMS odds-update >

# Acknowledge processed messages
XACK odds-update websocket-broadcast <message-id>

# Trim stream to prevent unbounded growth
XTRIM odds-update MAXLEN 10000   # keep last 10k messages
```

Consumer groups in Redis Streams work similarly to Kafka: each consumer in the group gets a different subset of messages; acknowledgment advances the delivered-but-not-acked tracking.

The key difference from Kafka: there is no persistent offset that survives Redis restarts (unless you use Redis persistence). If Redis restarts and AOF/RDB was not configured, the stream history is gone.

---

## How to answer "why do you use both?" in an interview

> "Kafka and Redis serve different parts of the event processing spectrum. Kafka is the durable event log — bet placements, settlements, fraud signals, analytics. These need to survive broker failures, be replayed by new consumers, and be retained for compliance. Redis is the real-time fast lane — live odds updates pushed to WebSocket connections where sub-millisecond latency matters and you do not need 7-day retention. Trying to route WebSocket odds through Kafka adds unnecessary latency. Trying to use Redis for financial event durability is unsafe. The two tools complement each other rather than compete."
