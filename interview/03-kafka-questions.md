# Module 3 Interview Q&A — Kafka Operational Depth

## How to use this file

For each question, there is a short "what they are testing" note, a structured answer, and a bridge back to your experience where relevant. Internalize the answer structure — do not memorize word-for-word.

---

## Q1: Describe how Kafka ensures durability when a broker fails

**What they are testing:** Do you know what ISR is, how leader election works, and what the operational implications are?

**Answer:**

> "Kafka's durability under broker failure comes from replication and ISR — In-Sync Replicas. Each partition is replicated across N brokers (typically 3 in production). One broker is the leader for that partition; the others are followers. Followers continuously replicate from the leader, and as long as they stay within `replica.lag.time.max.ms`, they are considered in-sync.
>
> When a broker fails, ZooKeeper (or the KRaft controller in newer Kafka) detects the loss of heartbeat and triggers leader election. A new leader is elected from the ISR — a follower that was fully caught up. Because ISR members have all acknowledged writes, no committed messages are lost.
>
> The safety lever is `min.insync.replicas`. With `min.insync.replicas=2` and RF=3, a write is confirmed only when at least 2 replicas have it. If a second broker fails and ISR drops to 1, writes are rejected rather than silently writing to a single copy. This is safer — it surfaces the problem rather than hiding it behind apparent success.
>
> One edge case: `unclean.leader.election.enable`. If all ISR members are unavailable and this is enabled, Kafka will elect an out-of-sync follower as leader to restore availability — but may lose messages. For Winamax financial data, this should be disabled. Consistency over availability."

---

## Q2: What is consumer lag and how do you alert on it?

**What they are testing:** Practical observability knowledge. Can you explain it, measure it, and set appropriate alert thresholds?

**Answer:**

> "Consumer lag is the difference between the latest offset in a partition and the committed offset of a consumer group. It represents how many messages the consumer is behind.
>
> Lag alone is not enough to alert on — a lag of 100,000 messages on an analytics topic might be fine if the consumer catches up within minutes. What I alert on instead:
>
> First: sustained lag above a threshold for a business-meaningful window. For the fraud detection consumer at Winamax, 10,000 messages for 2 minutes is a critical alert — at 75k msg/sec, that is seconds of unchecked bets.
>
> Second: lag that is growing. If lag increases at a sustained rate, the consumer is falling behind indefinitely. I use a rate-of-change alert: `rate(consumer_lag[5m]) > 0 for 10m`.
>
> Third: consumer offset not advancing at all — the consumer is dead or stuck on a poison message.
>
> I expose lag metrics via kafka-exporter to Prometheus and build Grafana dashboards with per-partition lag heatmaps. The heatmap is particularly useful — if one partition has 500k lag and others are fine, that is almost always a poison message or hot partition, not a throughput problem."

---

## Q3: You have a poison message stalling a partition. What are your options?

**What they are testing:** Do you understand the consequence of not handling this, and can you reason through the trade-offs?

**Answer:**

> "A poison message is one the consumer cannot process — malformed, schema incompatible, triggering a bug. Because Kafka preserves order within a partition, the consumer keeps retrying the same offset and never advances. Lag on that partition grows indefinitely while the consumer appears healthy.
>
> The three options:
>
> **Retry with backoff** — if the failure is transient (downstream service temporarily unavailable), retrying after exponential backoff will eventually succeed. But I must not block the consumer's main poll loop — I pause the partition using Kafka's `pause()/resume()` API while retrying in a side thread.
>
> **Dead Letter Queue** — after N failed attempts, write the message to a `.dlq` topic with diagnostic headers (original topic, partition, offset, error), then commit the offset. The partition advances; the message is not lost. I alert on any DLQ activity. This is the right choice for malformed data — the message itself cannot be processed regardless of retries.
>
> **Halt** — for financial events where skipping means corrupted state, the correct response is to stop the consumer and page oncall. At Winamax, if the settlement consumer cannot process a `BET_SETTLED` event, sending it to DLQ means the player's balance is never updated. Halting is safer — it causes an incident, but it preserves the invariant that every event gets processed once the bug is fixed.
>
> The DLQ vs halt decision is a product and business decision, not just a technical one. I would define per-topic policies: analytics topics use DLQ, financial topics halt."

---

## Q4: How do you guarantee ordered processing of events for a given user?

**What they are testing:** Understand partition-level ordering and the implication of the message key choice.

**Answer:**

> "Kafka guarantees ordering within a partition, never across partitions. So if I need all events for a given player or bet to be processed in order, I must ensure they all land on the same partition.
>
> The mechanism: use the entity's ID as the message key. The default partitioner hashes the key to a partition, and the same key always maps to the same partition. So `bet_id` as the key ensures all events for bet 12345 — placed, accepted, settled — land on the same partition, in order.
>
> Three failure modes to be aware of:
>
> First, if you use a null key or random key, events for the same entity land on different partitions — no ordering guarantee.
>
> Second, if you increase the partition count, the hash changes. Events for the same key that existed before the change are on the old partition; new events go to the new one. You lose ordering across the partition count change. Never change partition count on a topic that requires per-key ordering without a migration plan.
>
> Third, if you parallelize processing within a consumer instance, you break ordering even within a partition. Each partition must be processed sequentially.
>
> For Winamax's bet lifecycle: `bet_id` as the key, partition count chosen at topic creation to support peak throughput, never changed afterward."

---

## Q5: What is the difference between at-least-once and exactly-once semantics?

**What they are testing:** Understanding of commit semantics and practical knowledge of when to use each.

**Answer:**

> "The processing guarantee in Kafka is determined by when the consumer commits the offset relative to when it processes the message.
>
> **At-least-once:** commit after processing. If the consumer crashes after processing but before committing, it replays from the last committed offset on restart — the message is processed again. Messages are never lost, but can be reprocessed. This is the standard, and almost all Kafka consumers use this model. The application must be idempotent — processing the same message twice should produce the same outcome.
>
> **At-most-once:** commit before processing. If the consumer crashes after committing but before finishing, the message is gone. Avoids duplicates but risks loss. Almost never correct for financial events.
>
> **Exactly-once:** requires Kafka transactions. The consumer reads from topic A, transforms, writes to topic B, and commits the input offset — all atomically. If anything fails, the transaction aborts: the output to topic B is rolled back and the input offset is not committed. On retry, the message is reprocessed, but the transaction commit is idempotent — no duplicate output reaches consumers of topic B.
>
> In practice: at-least-once + idempotent consumer logic handles 90% of cases at lower complexity. Kafka transactions are reserved for consume-transform-produce pipelines where duplicate output is financially harmful — bet settlement writing to a balance topic, for example."

---

## Q6: Why does Winamax use both Kafka and Redis? What does each handle?

**What they are testing:** Architecture understanding — why two event systems, what is each optimized for?

**Answer:**

> "Kafka and Redis optimize for different things.
>
> Kafka is a durable, replicated commit log. Messages are written to disk, replicated across brokers, and retained for days. It is designed for high-throughput async workflows where durability and replay matter: bet lifecycle events, fraud signals, analytics, balance updates. If Redis goes down and comes back up, those Kafka messages are still there. Kafka is the financial backbone.
>
> Redis is an in-memory store. Sub-millisecond read latency. Not designed for days of retention. Redis Streams or pub/sub is used for real-time broadcasts — live odds updates pushed to WebSocket-connected users, live score events, session-local activity feeds. A player watching a live match needs new odds in tens of milliseconds. Routing that through Kafka adds unnecessary latency. And if an odds update is lost, the client will get the next one within milliseconds — acceptable data loss.
>
> The failure consequence is different: Kafka down means financial operations halt. Redis down means live odds updates stop and users see stale data — worse user experience, but no financial data loss. This informs incident priority and SLO design."

---

## Q7: A producer is writing at 75k msg/sec and consumers are falling behind. What do you do?

**What they are testing:** Structured incident response — do you look for root cause before taking action?

**Answer:**

> "First, I diagnose before acting. Consumer lag growing is a symptom, not a cause.
>
> I look at the partition-level lag breakdown. If lag is spread evenly across all partitions, it is a throughput problem — consumers are too slow. If lag is concentrated on one or two partitions, it is likely a hot partition or a poison message.
>
> For a throughput problem: I check how many consumer instances are running vs how many partitions the topic has. If there are 12 partitions and 4 consumers, I can immediately scale to 12 consumers — each gets one partition, tripling throughput. If I already have one consumer per partition, the bottleneck is within each consumer: slow DB write, slow external API call, expensive computation. I profile the consumer, find the hot path.
>
> For a hot partition: scaling consumers does not help — one partition can only have one consumer. I need to fix the key distribution (why is one key producing disproportionately many messages?) or increase partition count (planned operation, not an incident fix).
>
> For a poison message: scaling helps nothing. DLQ the message, advance the offset.
>
> If the production rate genuinely exceeds what the infrastructure can handle even after scaling, I consider shedding load at the API layer — HTTP 429 to the caller — or accepting the lag for non-critical topics while prioritizing scaling for critical ones like fraud detection."

---

## Q8: What is an ISR and why does it matter during a broker restart?

**What they are testing:** Operational depth on replication — the most common production concern during maintenance.

**Answer:**

> "ISR stands for In-Sync Replicas — the set of replicas for a partition that are fully caught up with the leader. A replica is considered in-sync if it has fetched all messages within `replica.lag.time.max.ms`.
>
> During a broker restart (planned maintenance, rolling upgrade), the restarting broker drops out of the ISR for all partitions it hosts. With RF=3 and one broker restarting, ISR drops to 2.
>
> Why this matters: if `min.insync.replicas=2` (recommended), writes still succeed — we still have 2 in-sync replicas. But if a second broker becomes unavailable at the same time (coincident failure during the restart), ISR drops to 1, which is below `min.insync.replicas=2`, and writes are rejected. This is why rolling restarts must go one broker at a time — never restart two brokers simultaneously.
>
> Also: when the restarted broker comes back, it needs to catch up the data it missed while down. This generates replication traffic proportional to how long it was down. On a 75k msg/sec cluster, a 5-minute restart creates ~22 GB of catch-up data. Watch for disk and network saturation during the catch-up window.
>
> The operational checklist for a broker restart: verify ISR is healthy before starting, restart one broker at a time, monitor under-replicated partitions count until it returns to zero before restarting the next broker."

---

## Q9: How do you safely reassign partitions on a live cluster?

**What they are testing:** Do you know about throttling, and can you walk through the operation without risking production impact?

**Answer:**

> "Partition reassignment moves replica data between brokers — it generates inter-broker network and disk I/O proportional to the partition size. On a loaded cluster, an unthrottled reassignment can saturate broker network and cause producer request timeouts.
>
> The procedure:
>
> First, generate the reassignment plan using `kafka-reassign-partitions.sh --generate`. Review it before executing — confirm it is moving the partitions you intend.
>
> Second, set a throttle. I calculate available network headroom by checking current inter-broker replication traffic on Grafana, then set the throttle to leave at least 50% headroom for production traffic. For a cluster with 100 MB/sec broker capacity used at 30 MB/sec, I might set the throttle to 30 MB/sec — enough to make progress without impacting production.
>
> Third, execute with `--throttle 31457280 --execute`.
>
> Fourth, monitor progress with `--verify`. Watch producer latency and consumer lag on Grafana during the operation — any increase signals the throttle is too high.
>
> Fifth — and this is often forgotten — remove the throttle after completion. The throttle configuration is written to the topic and broker configs and does not auto-clear. If you forget to remove it, replication stays throttled permanently. Use `kafka-configs.sh --alter --delete-config` on both the topic and the brokers.
>
> I schedule reassignments during off-peak hours and never on Friday afternoons."

---

## Q10: MSK vs self-managed Kafka — when would you choose each?

**What they are testing:** Do you understand what MSK actually manages and can you reason through the trade-off?

**Answer:**

> "MSK removes broker infrastructure operations — provisioning, OS patching, ZooKeeper management, multi-AZ placement, version upgrades. It does not remove Kafka operations — topic design, partition management, consumer group configuration, lag monitoring, schema governance, ACLs. That is still your responsibility.
>
> I choose MSK as the default: it lets the team focus on the Kafka operational work that actually matters to the business, rather than managing EC2 instance patching and broker rack awareness. For a new region or a team without deep Kafka infrastructure experience, MSK is faster to production and lower operational risk.
>
> Self-managed makes sense when: you need a Kafka version ahead of MSK's support (MSK lags releases by weeks to months); you need specific broker configurations that MSK does not expose; or you have very high sustained throughput where the cost math favors local NVMe SSDs on EC2 spot instances over EBS-backed MSK.
>
> The hidden cost of self-managed: rolling upgrades, broker failure recovery automation, OS patching runbooks. That engineering time has a real cost. The question is whether the flexibility or cost savings justify it. For most teams at most scales, MSK is the right call."
