# Module 3 — Kafka: Operational Depth

**Why this is high priority:** Winamax processes 75,000 messages/second on Kafka. That number is public and intentional — they put it in their job descriptions as a signal of what they expect you to handle. You will not be asked to describe Kafka. You will be asked to operate it.

---

## What Winamax uses Kafka for

Kafka is the backbone of Winamax's event-driven architecture. 700+ microservices produce and consume events. Examples of what flows through it:

- Bet slip events (placed, accepted, settled)
- Odds update broadcasts to thousands of concurrent users
- Fraud detection signals
- Analytics pipelines feeding real-time dashboards
- Cross-service state changes (user balance updated, tournament result posted)

At 75,000 msg/sec, a single misconfigured consumer group, a rebalance storm, or a partition skew is not theoretical — it is a production incident that takes down the betting flow.

---

## Module structure — what each file covers

| Topic | File | One-line summary |
|---|---|---|
| Core concepts | `03-core-concepts.md` | Brokers, partitions, replication, consumer groups, offsets |
| Producer guarantees | `03-producer-guarantees.md` | acks, idempotence, retries — the safety triangle |
| Consumer patterns | `03-consumer-patterns.md` | at-least-once, exactly-once, idempotent consumers |
| Consumer lag | `03-consumer-lag.md` | How to measure, alert, and respond to lag |
| Poison messages | `03-poison-messages.md` | DLQ patterns, skip vs halt — the hardest operational decision |
| Ordering guarantees | `03-ordering.md` | When you have them, when you don't, and how to design around it |
| Kafka on AWS | `03-kafka-aws.md` | MSK vs self-managed — the real trade-offs |
| Operational runbook | `03-runbook.md` | Partition reassignment, broker failure, topic cleanup |
| Kafka vs Redis Streams | `03-kafka-redis-streams.md` | Why both exist in the stack |
| Backpressure | `03-backpressure.md` | How upstream services protect themselves when Kafka is overwhelmed |

---

## Part 1: Core concepts — quick map

See `03-core-concepts.md` for the full breakdown.

**The one thing to keep sharp: a partition is the unit of parallelism AND ordering.**

A topic is split into partitions. Each partition is an ordered, append-only log. Parallelism comes from having multiple partitions. Ordering guarantees are per-partition only. You can have as many consumer instances as you have partitions — adding more consumers than partitions gains nothing.

The replication factor determines how many broker copies exist. With replication factor 3, you can lose 1 broker with no data loss. The leader partition handles all reads and writes; followers replicate.

---

## Part 2: Producer guarantees — quick map

See `03-producer-guarantees.md` for the full breakdown.

**The one thing to keep sharp: `acks=all` + idempotence + retries = exactly-once production.**

The three settings that matter:
- `acks=0` — fire and forget, fastest, no durability
- `acks=1` — leader acknowledges, follower lag can cause loss on leader crash
- `acks=all` (or `-1`) — all in-sync replicas acknowledge, safest

Idempotent producer (`enable.idempotence=true`) assigns a sequence number to each message. If a retry produces a duplicate, the broker deduplicates it. Without this, a producer retry on network failure creates a duplicate message.

---

## Part 3: Consumer patterns — quick map

See `03-consumer-patterns.md` for the full breakdown.

**The one thing to keep sharp: "at-least-once" is the default and almost everyone uses it.**

The processing guarantee is determined by when you commit the offset:
- Commit before processing → at-most-once (messages can be lost on crash)
- Commit after processing → at-least-once (messages can be reprocessed on crash)
- Transactional commit + processing → exactly-once (expensive, complex)

For most Winamax use cases, at-least-once + idempotent consumer logic (e.g., upsert by event ID) is the correct pattern. True exactly-once Kafka transactions are used only where re-processing a message causes double charges, double bets, etc.

---

## Part 4: Consumer lag — quick map

See `03-consumer-lag.md` for the full breakdown.

**The one thing to keep sharp: lag is offset distance, not time — but time is what you alert on.**

Consumer lag = latest offset in partition − consumer's committed offset. A lag of 500,000 messages on a 75k msg/sec topic means roughly 7 seconds of backlog. On an analytics topic, that might be acceptable. On the bet-placed topic feeding the fraud system, it is a critical incident.

Alert on: lag growing faster than consumption rate (the consumer is falling behind), or lag exceeding a threshold for a sustained window (not just a transient spike).

Tool of choice: `kafka-consumer-groups.sh --describe` or the JMX metric `records-lag-max`.

---

## Part 5: Poison messages — quick map

See `03-poison-messages.md` for the full breakdown.

**The one thing to keep sharp: a single poison message can halt an entire partition's consumption.**

A poison message is a message your consumer cannot process — malformed JSON, unexpected schema, a dependency service is down, a bug in deserialization. Because Kafka preserves order within a partition, a consumer that keeps retrying on offset N will never process N+1, N+2, etc. The partition stalls.

The response options: retry with backoff (good for transient failures), send to a Dead Letter Queue and skip (good for malformed messages), halt and alert (good when skipping would corrupt downstream state). The correct choice is context-dependent — it is a design decision, not a config setting.

---

## Part 6: Ordering guarantees — quick map

See `03-ordering.md` for the full breakdown.

**The one thing to keep sharp: ordering is guaranteed within a partition, never across partitions.**

If you need all events for a given player to be processed in order (e.g., balance debit before withdrawal confirmation), you must route all events for that player to the same partition. The standard way is to set the message key to the player ID — the default partitioner hashes the key to a consistent partition.

The failure mode: if you use a random key, events for the same entity can land on different partitions and be processed out of order by different consumers.

---

## Part 7: Kafka on AWS — quick map

See `03-kafka-aws.md` for the full breakdown.

**The one thing to keep sharp: MSK removes broker operations, but not Kafka operations.**

With MSK, AWS manages broker provisioning, OS patches, broker restarts, and ZooKeeper/KRaft. You still manage topics, partitions, consumer groups, offsets, ACLs, schema registry, and any performance tuning. MSK removes infrastructure overhead, not operational depth.

Self-managed Kafka on EC2 gives you full control — useful if you need specific broker configs, Kafka versions ahead of MSK support, or have cost constraints at very high volume.

---

## Part 8: Operational runbook — quick map

See `03-runbook.md` for the full breakdown.

**The one thing to keep sharp: partition reassignment is the most dangerous manual operation.**

Reassigning partitions moves data between brokers — it generates inter-broker network traffic and disk I/O proportional to partition size. On a loaded cluster at 75k msg/sec, an unthrottled reassignment can saturate broker network and cause producer timeouts. Always set `--throttle` when reassigning in production.

Other critical runbook items: what happens on broker failure (ISR shrinks, leader election), topic retention tuning (prevent disk exhaustion), and consumer group reset (how to replay from a specific offset when a bug processed messages incorrectly).

---

## Part 9: Kafka vs Redis Streams — quick map

See `03-kafka-redis-streams.md` for the full breakdown.

**The one thing to keep sharp: Kafka is a durable log for async workflows; Redis Streams is an in-memory queue for low-latency real-time fan-out.**

At Winamax, Kafka handles durable event flows (bet lifecycle, analytics). Redis Streams (or pub/sub) handles real-time broadcasts to WebSocket-connected clients — odds updates, live score pushes. Redis has no disk durability guarantee by default; if the Redis node dies, unacknowledged messages may be lost. That is acceptable for a live odds update. It is not acceptable for a financial transaction.

---

## Part 10: Backpressure — quick map

See `03-backpressure.md` for the full breakdown.

**The one thing to keep sharp: Kafka does not apply backpressure to producers by default.**

A producer will write as fast as the broker accepts, and consumers can fall behind indefinitely. At 75k msg/sec, if a consumer group falls behind, you have options: scale consumers horizontally (up to the partition count), throttle the producer, use a circuit breaker upstream, or accept the lag and alert. The correct response depends on whether lag is tolerable for the use case (analytics yes, fraud detection no).

---

## Part 11: Bridge from Kubernetes

Kafka is a stateful distributed log. You know how to operate stateful workloads in K8s. The operational instincts transfer:

| K8s experience | Kafka equivalent | Gap? |
|---|---|---|
| StatefulSet with PersistentVolumes | Kafka brokers with persistent log dirs | Minor — same durability concern, different tooling |
| Pod disruption budgets | ISR (In-Sync Replicas) minimum | Same idea: maintain quorum during rolling ops |
| Horizontal pod scaling | Consumer group instance scaling | Same idea: more parallelism up to partition count |
| Rolling deployments | Controlled rolling broker restart | Same caution: one broker at a time |
| Liveness probes causing restart storms | Rebalance storms from consumer crashes | Same failure mode: flapping triggers mass disruption |
| kubectl describe / logs | kafka-consumer-groups.sh, JMX metrics | New: different observability surface |
| Namespace network isolation | Kafka ACLs per topic | Different mechanism, same principle |

The gap is not operational instinct — it is Kafka-specific failure modes (ISR shrink, unclean leader election, partition skew) and the tooling to diagnose them.

---

## Part 12: Hands-on exercises

Go to `exercises/03-kafka/` for the labs.

The exercises cover:
1. Design a topic + partition layout for the Winamax bet lifecycle
2. Diagnose and respond to consumer lag on a critical topic
3. Implement a Dead Letter Queue pattern in pseudocode
4. Decide: MSK or self-managed? Justify with trade-offs
5. Write a runbook step for partition reassignment with throttling

---

## Part 13: Interview Q&A

See `interview/03-kafka-questions.md` for full story-angle answers.

**Quick reference — the questions they will ask:**

1. Describe how Kafka ensures durability when a broker fails
2. What is consumer lag and how do you alert on it?
3. You have a poison message stalling a partition. What are your options?
4. How do you guarantee ordered processing of events for a given user?
5. What is the difference between at-least-once and exactly-once semantics?
6. Why does Winamax use both Kafka and Redis? What does each handle?
7. A producer is writing at 75k msg/sec and consumers are falling behind. What do you do?
8. What is an ISR and why does it matter during a broker restart?
9. How do you safely reassign partitions on a live cluster?
10. MSK vs self-managed Kafka — when would you choose each?
