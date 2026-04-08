# Module 7 Interview Questions — Redis & Event-Driven Architecture

These questions cover the topics Winamax is likely to probe: caching at scale, event reliability, Redis operational depth, and batch/orchestration trade-offs.

---

## Q1: Walk me through how you would prevent a cache stampede on a high-traffic sports betting platform.

**Answer:**

The cache stampede problem is specific and worth naming precisely: a hot key's TTL expires under peak load, causing all requests to simultaneously miss the cache and hammer the database. At Winamax's scale — 400,000 concurrent users during a Champions League final — this can go from zero to Aurora CPU saturation in 30 seconds.

There are three mitigations I would combine.

First, jitter on TTL. Instead of `setex(key, 30)`, I use `setex(key, 30 + random(-5, 5))`. This staggers expiry so a batch of keys that were set within the same second do not expire at the same second. Simple, zero cost, effective for baseline protection.

Second, distributed locking with SETNX for the refresh path. When a request detects a cache miss, it tries to acquire a lock key with `SET lock_key 1 NX EX 5`. Only the first request wins the lock and performs the DB query. The rest spin-wait briefly and retry the cache read. The lock has a 5-second TTL to handle the case where the lock holder crashes — otherwise the lock is never released.

Third, background refresh for known-hot keys. Live match odds are always hot during a match. A dedicated background job refreshes these keys every 20 seconds, before the 30-second TTL expires. The cache hit rate for these keys is 100% regardless of traffic. The trade-off is that odds can be up to 20 seconds stale — which is acceptable for a caching layer (the odds engine controls when odds change, not the cache TTL).

In an incident, if stampede has already started and Aurora is overwhelmed, the fastest mitigation without a code deploy is to manually seed the cache: run a script that queries Aurora for all live match odds and writes them to Redis. This restores the cache within seconds and stops the bleed.

---

## Q2: When would you use Redis Streams instead of Kafka? What is the trade-off?

**Answer:**

Both solve the same problem — durable, ordered, consumer-group-based message delivery — but at different scales and operational costs.

I use Redis Streams when three conditions are true: the data is ephemeral (I do not need days of replay), the consumer is always running (no long-term lag expected), and the producer and consumer are owned by the same team. At Winamax, the Casino team's real-time game events fit this profile — hand results, bets placed in a Casino game, player disconnection events. These need to be processed within milliseconds. The team owns both sides. Replay is not required.

I use Kafka when I need durability across days, cross-team fan-out, or throughput at the level of millions of messages per second. The core bet pipeline — 75,000 messages per second, consumed by settlement, notification, analytics, and fraud detection independently — requires Kafka. Each of those teams needs to set their own consumer group offset, replay independently, and operate without knowing what the other consumers are doing.

The critical trade-off: Redis Streams is memory-bounded. A `MAXLEN 1,000,000` stream trimmed to fit in memory loses old entries permanently. If the audit-logger consumer falls behind by more than the stream depth, it misses events. For compliance-critical data, that is unacceptable. Kafka's disk-backed log does not have this constraint.

The answer I give in an interview is: "Kafka for anything that crosses team boundaries, requires replay, or has compliance requirements. Redis Streams for real-time, ephemeral, intra-team event pipelines where we already have Redis."

---

## Q3: A bet settlement event is processed twice, crediting a user's wallet twice. Walk me through the post-incident analysis and the fix.

**Answer:**

First, I confirm the incident scope: how many users were double-credited, and what is the total financial exposure. I check `wallet_transactions` for records with the same business event but two different rows. At the same time, I check Kafka consumer metrics — was there a consumer rebalance, a crash loop, or a DLQ replay that caused redelivery?

The root cause is almost always one of three things: the Kafka offset was committed after the DB write succeeded but before the commit was confirmed, causing redelivery; a DLQ replay included events that had already been partially processed; or the wallet credit logic was not idempotent — two inserts succeed where one should be a no-op.

The fix at the database level: the `wallet_transactions` table must have a unique constraint on `event_id`. The credit insert should be:
```sql
INSERT INTO wallet_transactions (event_id, user_id, amount, type)
VALUES ('settle-88991234-...', '456', 47.50, 'credit')
ON DUPLICATE KEY UPDATE event_id = event_id; -- no-op on duplicate
```
A duplicate `event_id` results in `affected_rows = 0`. The application checks this and skips the downstream steps (notification, etc.) — idempotent.

For the remediation of the existing double-credits: identify all duplicates, generate compensating debit transactions with a clear reason code ("correction: duplicate settlement YYYYMMDD"), and communicate to Finance for their ledger reconciliation. Also send a courtesy email to affected users explaining the correction.

Going forward: the unique constraint is the hard stop. But the monitoring gap is also a failure — a daily reconciliation job should compare `wallet_transactions` against `bets settled` for 1:1 cardinality. If any bet shows two credits, that fires a P1 alert before a user even notices.

---

## Q4: What eviction policy would you set on an ElastiCache cluster used purely as a cache, and why?

**Answer:**

`allkeys-lfu` — least frequently used across all keys.

The reason I prefer LFU over LRU for a betting platform: access patterns are heavily skewed by what is happening right now. During the Champions League final, the odds for that match are accessed millions of times per minute. Odds for a cricket match happening simultaneously are accessed a few thousand times. LFU keeps the Champions League data hot — it has a very high frequency score — and naturally evicts the low-frequency cricket data to make room.

LRU (least recently used) does not work as well here: a key could be accessed 50,000 times in the past hour but then not accessed in the last 10 seconds (between match events). LRU would evict it despite its historical hotness, causing an unnecessary cache miss spike.

The second policy I would avoid is `noeviction`. It rejects writes when the cache is full instead of making room. For a cache, that breaks the application — writes fail, the DB bypass fails, and suddenly all reads go to Aurora. The entire point of a cache is graceful degradation, not hard failure.

The third thing I would monitor: `Evictions` in CloudWatch. If evictions are growing rapidly, the cluster is undersized for the workload. The fix is either adding memory (scale up the node type) or reducing TTLs (shrink the working set). A high eviction rate combined with a low hit rate is the signal that the cache is evicting useful data — the working set exceeds available memory.

---

## Q5: Design an idempotent event processing pipeline for bet settlement at Winamax scale.

**Answer:**

The foundational principle: at-least-once delivery is the default for Kafka. The pipeline must handle duplicates without side effects. Financial correctness is non-negotiable.

The design has three layers.

**Layer 1: Unique event IDs.** Every `bet.settled` event carries a globally unique `event_id` generated by the settlement engine — `settle-{betId}-{timestamp}`. This is the idempotency key for everything downstream.

**Layer 2: Database constraints as the hard stop.** The `bets` table has a unique column `settled_event_id`. The settlement update is:
```sql
UPDATE bets SET status='settled', settled_event_id=? 
WHERE bet_id=? AND settled_event_id IS NULL
```
If `settled_event_id` is already set, `rows_affected = 0` — the consumer detects this and exits without crediting the wallet or sending the notification. The same logic applies to `wallet_transactions` — unique constraint on `event_id`.

**Layer 3: State machine guards.** A bet in state `settled` cannot be re-settled. A bet in state `cancelled` cannot be settled. The state machine rejects invalid transitions at the SQL level, not just application logic.

Non-retryable errors (invalid data, business rule violations) go directly to a DLQ with the original event and the error reason. Retryable errors (DB timeout, downstream unavailable) trigger exponential backoff with three attempts before DLQ.

The DLQ is monitored with a CloudWatch alarm. Any DLQ depth > 0 is a P2 alert — SRE investigates within 30 minutes. DLQ depth > 100 for financial events is P1. After the fix is deployed, DLQ events are replayed to the main topic. Because the pipeline is idempotent, events that were already fully processed are safe to replay — they are silently skipped.

---

## Q6: Explain how AWS Batch differs from running an ECS task directly, and when you would use one over the other.

**Answer:**

AWS Batch is a job scheduler built on top of ECS. When you submit a job to Batch, Batch handles: deciding when to run it (queue priority, dependency management), provisioning the underlying compute (EC2 instances or Fargate), placing the container, retrying on failure, and cleaning up afterward. You get array jobs (N parallel copies of one job definition) and job dependencies (job B starts only after job A succeeds) out of the box.

Running an ECS task directly gives you more control but zero orchestration. You specify the task definition, the cluster, the network config, and you start it. There is no queue, no automatic retry, no dependency management. If the task fails, you find out by polling or via CloudWatch Events — you are responsible for the retry logic.

At Winamax, I would use Batch for:
- Heavy processing jobs that take 30 minutes to 3 hours (financial reports, ML model retraining)
- Parallel processing of N files (Batch array jobs with `AWS_BATCH_JOB_ARRAY_INDEX`)
- Workloads that should scale to zero when idle (Batch EC2 compute environments provision from 0 min vCPUs)
- Jobs with dependencies (extract then transform then load)

I would use ECS tasks directly for:
- Always-on services (ECS Service, not one-off task)
- One-off tasks triggered from Airflow via `ECSOperator` where Airflow owns the orchestration
- Short-lived tasks (< 5 minutes) where Batch's scheduling overhead is disproportionate

The key Batch advantage for cost: EC2 Spot compute environments. Batch automatically requests Spot capacity and handles interruption by retrying on a different instance. For long-running data processing jobs, Spot can reduce compute cost by 60–80%. But you must design jobs to be restartable (checkpoint to S3) since Spot can be interrupted at any time.

---

## Q7: How does consumer group lag in Redis Streams become a production problem, and how do you detect and fix it?

**Answer:**

Consumer group lag in Redis Streams means the group has messages pending that have not been processed. Lag itself is not the problem — every consumer has some lag. The problem arises from the interaction between lag and stream trimming.

If the stream is configured with `MAXLEN 1,000,000` and a slow consumer falls 1,500,000 messages behind, Redis has already trimmed the entries the consumer needs to process. Those entries are gone. The consumer reads past the start of the stream and misses data permanently — without any error or alarm, by default.

Detection:
```redis
XINFO GROUPS casino:game:events
-- Check "pending" field for each group
-- Redis 7.0: "lag" field shows how far behind the group is
```

In CloudWatch for ElastiCache, there is no native "stream consumer lag" metric — you need a custom metric. A monitoring job runs every 60 seconds, calls `XINFO GROUPS`, and publishes the lag as a custom CloudWatch metric. Alert on lag growing over time (derivative > 0 for 5 consecutive minutes).

Fix options:
1. **Scale consumers horizontally.** If the consumer group is one worker and processing rate < ingestion rate, add more workers. Up to the number of partitions/streams (Redis Streams does not have native partitioning, so you may need multiple streams).
2. **Increase MAXLEN.** Buy time by increasing the stream length limit, at the cost of more memory.
3. **Investigate slow processing.** A consumer that is slow is usually hitting a downstream bottleneck — a slow DB write, a slow API call, a high failure/retry rate. Profile the processing loop.
4. **Separate high-retention consumers.** If one consumer (audit-logger) needs full history and another (game-state-updater) only needs the last 30 seconds, give audit-logger its own stream or use S3 archival before trimming.
