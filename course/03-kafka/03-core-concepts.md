# Kafka Core Concepts — Brokers, Partitions, Replication, Consumer Groups, Offsets

## Why this matters at Winamax

700+ microservices communicate through Kafka. When you talk to a Winamax engineer about a production incident, they will say things like "the ISR dropped to 1 on the bet-placed topic" or "the consumer group lag on fraud-detection hit 2 million." If you do not have these concepts as instinct, you will lose the thread.

---

## The mental model: Kafka is a distributed commit log

A traditional message queue destroys a message once it is delivered. Kafka does not. It stores messages as an ordered, append-only log on disk. Consumers do not remove messages — they track their position in the log (the offset) and advance it. This means:

- Multiple independent consumer groups can read the same topic without interfering
- A consumer can replay from offset 0 if it needs to reprocess
- Data is retained according to a retention policy (time or size), not consumer acknowledgment

---

## Brokers

A Kafka cluster is a group of **broker** processes, each running on its own machine (or EC2 instance, or ECS task if you're brave — but in practice brokers need persistent local disk). Each broker:

- Holds a subset of partition data on disk
- Handles producer writes and consumer reads for its assigned leader partitions
- Replicates partition data from/to other brokers as a follower

At Winamax scale, you need enough brokers to distribute the write throughput of 75,000 msg/sec across their disks and network cards without saturating any single broker.

**Practical number:** 3 brokers is the minimum for production (gives you replication factor 3 with one broker failure tolerance). Winamax likely runs many more given the volume.

---

## Topics and partitions

A **topic** is a named log category — think of it as a table name in a database. A **partition** is a shard of that topic.

```
Topic: bet-placed
  Partition 0: [msg0, msg1, msg2, msg5, msg9 ...]
  Partition 1: [msg3, msg6, msg7, msg10 ...]
  Partition 2: [msg4, msg8, msg11 ...]
```

Key properties:

- **Ordering is per-partition only.** Within partition 0, msg0 always comes before msg1. But there is no global ordering guarantee across partitions.
- **Parallelism is bounded by partition count.** If a topic has 12 partitions, you can have at most 12 active consumer instances in a consumer group (one per partition). A 13th consumer would sit idle.
- **Partition count is mostly permanent.** You can increase partition count but not decrease it. Increasing it changes the partition-to-key mapping, which breaks ordering guarantees for keyed messages. Do this during design, not during an incident.

**How many partitions?** A rough formula: `throughput_goal / throughput_per_partition`. If one partition handles ~10 MB/s, and your topic needs 100 MB/s, you need ~10 partitions. Also ensure partition count >= expected peak consumer instances.

---

## Replication

Each partition has one **leader** and N-1 **followers** (where N = replication factor). The leader handles all reads and writes. Followers replicate from the leader.

```
Partition 0:
  Leader:   Broker 1  ← producers write here, consumers read here
  Follower: Broker 2  ← replicates from broker 1
  Follower: Broker 3  ← replicates from broker 1
```

**ISR — In-Sync Replicas:** The set of replicas that are fully caught up with the leader. If a follower falls behind (network issue, broker restart), it is removed from the ISR. A replica is in-sync if it has fetched all messages within `replica.lag.time.max.ms` (default: 30 seconds).

**Why ISR matters:**
- With `acks=all`, the producer waits for all ISR members to acknowledge before the write is confirmed.
- `min.insync.replicas` (topic config) sets the minimum ISR size required for a write to succeed. Common production value: 2 (so you need at least 2 brokers available for writes to proceed).
- If ISR < `min.insync.replicas`, the topic goes into a "not enough replicas" state and produces will fail. This is safer than silently writing to a single copy.

**Unclean leader election:** If the leader broker dies and no ISR member is available (all followers are behind), Kafka has a choice: refuse to elect a new leader (blocks writes, preserves consistency) or elect an out-of-sync follower (resumes writes, may lose messages). This is controlled by `unclean.leader.election.enable`. For Winamax financial data: keep this `false`.

---

## Consumer groups

A **consumer group** is a set of consumer instances that collectively read a topic. Kafka divides partitions among the group members — each partition is read by exactly one member at a time.

```
Topic: bet-placed (12 partitions)
Consumer group: fraud-detection-service (4 instances)

Instance A: partitions 0, 1, 2
Instance B: partitions 3, 4, 5
Instance C: partitions 6, 7, 8
Instance D: partitions 9, 10, 11
```

**Rebalance:** When a consumer instance joins or leaves the group, Kafka triggers a rebalance — it redistributes partitions across the remaining members. During a rebalance, consumption pauses. At 75k msg/sec, a rebalance that takes 10 seconds means 750,000 messages queued up during that window.

Rebalance triggers:
- Consumer joins the group (new deployment rolling out)
- Consumer leaves (crash or graceful shutdown)
- Consumer fails to poll within `max.poll.interval.ms` (processing is too slow)
- Broker-side session timeout (`session.timeout.ms`) — heartbeat missed

**Cooperative rebalancing (incremental):** Available since Kafka 2.4 and the cooperative-sticky assignor. Instead of stopping all consumers and reassigning everything, only the partitions that need to move are revoked. This reduces pause time dramatically. Use `CooperativeStickyAssignor` in production.

**Multiple consumer groups:** Different services reading the same topic each have their own group ID. They are fully independent — one group's lag does not affect another.

---

## Offsets

An **offset** is the position of a message within a partition. It is a monotonically increasing integer, starting at 0.

```
Partition 0: [offset 0][offset 1][offset 2][offset 3]...
                                                  ↑
                                     consumer committed offset = 3
                                     (consumer has processed up to offset 2, offset 3 is next)
```

Consumers commit their offset to Kafka (stored in the `__consumer_offsets` internal topic) to record progress. If a consumer crashes and restarts, it resumes from the last committed offset.

**Auto-commit vs manual commit:**
- `enable.auto.commit=true` — Kafka commits on a schedule (default every 5 seconds). Risk: auto-commit fires, then consumer crashes before finishing processing → message lost (at-most-once).
- Manual commit — application controls when to commit. Commit after successful processing → at-least-once. Commit before processing → at-most-once (less common).

**Offset reset policy (`auto.offset.reset`):**
- `latest` — new consumer group starts at the end of the log (only reads new messages)
- `earliest` — new consumer group starts from offset 0 (replays entire history)
- `none` — throw an exception if no committed offset exists

For a new fraud-detection consumer group at Winamax: `earliest` to process the backlog, unless the backlog is days old and irrelevant.

---

## Key topology terms at a glance

| Term | Definition |
|---|---|
| Broker | A Kafka server process holding partition data |
| Topic | A named category of messages |
| Partition | An ordered, append-only shard of a topic |
| Replication factor | Number of copies of each partition |
| Leader | The broker handling reads/writes for a partition |
| Follower | A broker replicating a partition for fault tolerance |
| ISR | In-Sync Replicas — followers caught up with leader |
| Consumer group | A set of consumers sharing the work of reading a topic |
| Offset | A message's position within a partition |
| Committed offset | The position a consumer has durably recorded as processed |
| Rebalance | Redistribution of partitions across consumer group members |

---

## Bridge from Kubernetes

| K8s concept | Kafka equivalent | Notes |
|---|---|---|
| Pod | Consumer instance | Stateless worker reading from Kafka |
| ReplicaSet | Consumer group | Kafka balances partitions across members like K8s balances load across pods |
| StatefulSet | Kafka broker | Both have stable identity and persistent storage |
| PodDisruptionBudget | `min.insync.replicas` | Both ensure a quorum stays available during disruptions |
| Rolling update | Rolling broker restart | Both require going one at a time to avoid losing quorum |
| Namespace | Consumer group ID | Logical isolation without physical separation |
