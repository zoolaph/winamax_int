# Module 7 — Redis & Event-Driven Architecture Patterns

**Priority: MEDIUM-HIGH — Redis appears in cache, stream, and real-time contexts across Winamax.**

Winamax uses ElastiCache (Redis/Valkey) for caching, Redis Streams for lightweight messaging, and Airflow + AWS Batch for batch workloads. The Casino team uses Redis for real-time game state. This module covers the operational depth expected across these use cases.

---

## How to use this module

Each topic below has its own deep-dive file. This file gives you the one mental model to carry into the interview. The deep-dive files have the operational detail.

---

## Part 1: Redis Data Structures — the right tool for each problem

See `07-redis-data-structures.md` for the full guide — strings, hashes, lists, sorted sets, streams, and the Winamax use cases for each.

**The one thing to keep sharp here — Redis is a data structure server, not just a cache:**

- A **sorted set** is the data structure for leaderboards, rate limiting, and time-series indexing. At Winamax, a real-time poker tournament ranking is a sorted set — `ZADD tournament:123:rank 1500 player:farouq`. Query by score range in O(log N).
- A **hash** is the right structure for a user session or a bet record — one hash per entity, fields for each attribute. More memory-efficient than storing serialized JSON in a string.
- A **stream** is a persistent, ordered log. Unlike pub/sub (fire-and-forget), streams allow consumer groups to track exactly where they are — unprocessed messages survive consumer restarts.

**K8s bridge:** A Redis sorted set is like a Kubernetes PriorityQueue — items are scored and dequeued in order. A Redis stream consumer group is like a Kafka consumer group with a committed offset, but managed inside Redis.

---

## Part 2: Redis Streams vs Kafka — when to use each

See `07-redis-streams-vs-kafka.md` for the full comparison — delivery guarantees, consumer groups, retention, throughput, and the decision framework.

**The one thing to keep sharp here — they solve the same problem at different scales:**

| | Redis Streams | Kafka |
|--|--|--|
| Throughput | Hundreds of thousands/sec per shard | Millions/sec, partitioned |
| Retention | Memory-bound (configurable max length) | Disk-backed, days to weeks |
| Consumer groups | Yes, similar semantics | Yes, native |
| Replay | Limited (up to max length) | Full replay from offset 0 |
| Operational cost | Shared with Redis cluster | Separate Kafka cluster |
| Winamax use | Casino real-time events, short-lived streams | 75,000 msg/sec bet pipeline |

**Decision rule:** Use Redis Streams when the data is ephemeral, latency is critical, and you already have Redis. Use Kafka when you need persistence, replay, or cross-team fan-out at scale.

---

## Part 3: Cache Patterns — how data flows between Redis and the DB

See `07-cache-patterns.md` for the full guide — cache-aside, write-through, write-behind, TTL strategy, cache stampede, and eviction policies.

**The one thing to keep sharp here — cache-aside is the default, but its failure mode is stampede:**

- **Cache-aside (lazy loading):** Application checks cache first. On miss, reads from DB, writes to cache, returns. Most flexible. Miss penalty is one extra DB round trip.
- **Write-through:** On every write to DB, also write to cache. Cache is always warm. Double write on every mutation.
- **Write-behind:** Write to cache first, asynchronously persist to DB. Lowest write latency. Risk of data loss if Redis fails before the async write completes.
- **Cache stampede:** When a hot key expires, thousands of requests all miss the cache simultaneously and flood the DB. Fix: probabilistic early expiration, distributed locking (SETNX), or background refresh.

**Eviction policy decision:**
- `allkeys-lru` — evict least recently used across all keys. Best for a pure cache.
- `volatile-lru` — only evict keys that have a TTL set. Good when mixing cached and permanent data in Redis.
- `noeviction` — reject writes when full. **Never use this for a cache** — it breaks the application instead of falling back gracefully.

**K8s bridge:** Cache stampede is like a thundering herd after a pod restart — all pods simultaneously request the same resource. The fix (leader election for the refresh) is the same pattern as using a Kubernetes leader election sidecar.

---

## Part 4: Redis Cluster — sharding, replication, failover

See `07-redis-cluster.md` for the full guide — hash slots, cluster topology, replica promotion, and ElastiCache cluster mode.

**The one thing to keep sharp here — cluster mode shards data across nodes using hash slots:**

- Redis Cluster divides the keyspace into **16,384 hash slots**. Each node owns a range. `CLUSTER KEYSLOT mykey` tells you which slot a key maps to.
- A key tagged with `{user:123}` routes all operations for that tag to the same slot — critical for multi-key operations like `MGET` or Lua scripts that must hit the same node.
- Failover: each primary node has one or more replicas. If a primary is unreachable for `cluster-node-timeout` milliseconds (default 15s), its replica is promoted. The cluster remains available as long as at least one primary per hash slot range is alive.

**ElastiCache specifics:** In ElastiCache cluster mode enabled, you cannot add/remove shards without a configuration change (and brief interruption). Cluster mode disabled gives you one primary + N replicas, simpler but no horizontal scaling of write throughput.

---

## Part 5: Event-Driven Design — idempotency, ordering, retry safety

See `07-event-driven-design.md` for the full guide — idempotency keys, exactly-once semantics, ordering guarantees, retry safety, and the saga pattern.

**The one thing to keep sharp here — at 75,000 msg/sec, every event will be retried eventually:**

- **Idempotency:** Processing the same event twice must produce the same outcome. The pattern: include a unique `event_id` in every message. Before processing, check if `event_id` has been seen (using a Redis SET or DynamoDB item). If yes, skip. If no, process and record.
- **Ordering:** Kafka guarantees ordering within a partition. If order matters, all related events must go to the same partition (use a consistent key like `betId`). Redis Streams preserves insertion order within one stream.
- **Retry safety:** Distinguish between retryable errors (network timeout, downstream unavailable) and non-retryable errors (invalid data, business rule violation). Retryable → exponential backoff with jitter. Non-retryable → dead letter queue.

**K8s bridge:** A Kubernetes Job with `restartPolicy: OnFailure` is the pod-level version of this pattern. The same question applies: if the job runs twice, is the result correct?

---

## Part 6: Airflow — DAG design and operational basics

See `07-airflow.md` for the full guide — DAG structure, task types, operators, sensors, scheduling, and failure handling.

**The one thing to keep sharp here — Airflow orchestrates dependencies, not execution:**

- Airflow defines a **DAG** (Directed Acyclic Graph) where nodes are tasks and edges are dependencies. `task_b.set_upstream(task_a)` means task B does not start until task A succeeds.
- **Operators** are the task types: `PythonOperator` (run Python), `BashOperator` (run shell), `S3ToRedshiftOperator` (ELT), `ECSOperator` (run an ECS task). At Winamax, Airflow likely orchestrates data pipeline steps — extract from Aurora, transform, load to Redshift.
- **Sensors** are polling tasks: `S3KeySensor` waits for a file to appear in S3 before proceeding. `ExternalTaskSensor` waits for another DAG's task to complete. Sensors can hold a DAG slot for hours — use `mode='reschedule'` instead of `mode='poke'` to avoid blocking a worker slot.
- **XComs:** tasks share state by pushing values to XCom. Useful for small values (a file path, a count). Not for large data — that goes to S3.

---

## Part 7: AWS Batch — job queues and compute environments

See `07-aws-batch.md` for the full guide — compute environments (EC2 vs Fargate), job queues, job definitions, array jobs, and the Lambda/Airflow/Batch decision framework.

**The one thing to keep sharp here — AWS Batch manages compute lifecycle for you:**

- A **compute environment** is a pool of EC2 or Fargate capacity. EC2 compute environments scale from 0 to `maxvCPUs` automatically. Fargate compute environments provision on-demand with no warm-up time, ideal for sporadic jobs.
- A **job queue** has a priority and routes jobs to one or more compute environments. High-priority queue → spot compute environment first, then on-demand as fallback.
- **Array jobs:** one job definition that spawns N parallel copies. Each copy gets `AWS_BATCH_JOB_ARRAY_INDEX` env var — useful for processing N files in parallel without writing coordination logic.

**The decision framework:**

| | Lambda | AWS Batch | Airflow + ECS |
|--|--|--|--|
| Max runtime | 15 minutes | No limit | No limit |
| State management | None | AWS manages | Airflow manages |
| Parallelism | Event-driven fan-out | Array jobs | Task parallelism |
| Use at Winamax | Webhooks, small transformations | Heavy batch processing (ML, reports) | Multi-step data pipelines |

---

## Exercises

`exercises/07-redis-events/` — hands-on labs:
- `01-cache-stampede.md` — diagnose and fix a cache stampede incident
- `02-redis-streams-consumer-groups.md` — design a consumer group processing pipeline
- `03-event-driven-idempotency.md` — design idempotent event processing at Winamax scale
- `04-airflow-dag-design.md` — design a data pipeline DAG with failure handling

## Interview Q&A

`interview/07-events-questions.md`
