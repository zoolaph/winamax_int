# Module 6 — Database Operations & Access Governance

**Priority: HIGH — "Automated DB access management" is a named example project in the JD.**

Winamax explicitly calls out automating access management across all database types, and environment cloning with anonymization. This is governance + operational work — not just "knows SQL." They have 50 TB of database data and hundreds of services accessing it. They need engineers who have thought about who can access what, when, and how to prove it.

---

## How to use this module

Each topic below has its own deep-dive file. This file gives you the one mental model to carry into the interview. The deep-dive files have the operational detail.

---

## Part 1: Aurora MySQL — The production relational database

See `06-aurora-deep.md` for the full guide — cluster architecture, reader/writer endpoints, failover mechanics, parameter groups, and Winamax-scale operations.

**The one thing to keep sharp here — the cluster is two planes that fail independently:**

- The **cluster endpoint** always points at the current writer. After a failover, it automatically resolves to the new writer. Your application should use this for writes.
- The **reader endpoint** load-balances across read replicas. Use this for analytics queries, reporting, and read-heavy service paths.
- Failover is fast (~30 seconds) because Aurora stores data in a shared storage volume — replicas do not need to catch up via log shipping. The new writer just takes over the storage.

**K8s bridge:** The Aurora cluster endpoint behaves like a Kubernetes Service. The writer failover is like a pod being terminated and a new pod passing readiness — the Service endpoint updates, clients reconnect. The difference is Aurora handles this in the storage layer, not the application layer.

---

## Part 2: DynamoDB — Event state, session data, high-frequency writes

See `06-dynamodb-deep.md` for the full guide — partition keys, sort keys, GSIs, capacity modes, DynamoDB Streams, and the access patterns that matter.

**The one thing to keep sharp here — DynamoDB is designed around your access patterns, not your data model:**

- You cannot query by arbitrary attributes like SQL. Every query must target either the primary key (partition key + sort key) or a GSI you define up-front.
- **Partition key design determines your throughput ceiling**: a hot partition key (e.g., `userId=winamax_admin`) funnels all traffic to one shard. At 75k msg/sec, a bad partition key is a production incident.
- **Capacity modes**: On-demand is pay-per-request with no capacity planning, ideal for unpredictable spikes (sports events). Provisioned + Auto Scaling is cheaper for steady workloads.

**Winamax use case:** Bet state tracking — each in-flight bet has a record keyed by `betId`. High-frequency writes during live sports events. On-demand capacity handles the spikes.

---

## Part 3: Redshift — Analytics and reporting

See `06-redshift-deep.md` for the full guide — columnar storage, distribution keys, sort keys, WLM, and when to choose Redshift over DynamoDB.

**The one thing to keep sharp here — Redshift and DynamoDB answer different questions:**

| | DynamoDB | Redshift |
|--|--|--|
| Query type | Single record by key | Aggregations across millions of rows |
| Latency | Single-digit ms | Seconds to minutes |
| Use at Winamax | Bet state, session data, real-time lookups | Reporting, business intelligence, revenue analysis |
| Schema | Flexible, document-like | Fixed columnar schema, optimized at design time |

You would not run `SELECT COUNT(*) FROM bets GROUP BY sport WHERE date > '2024-01-01'` against DynamoDB. That query runs against Redshift.

---

## Part 4: ElastiCache (Valkey/Redis) — Caching and ephemeral state

See `06-elasticache-deep.md` for the full guide — cluster mode, replication groups, eviction policies, and operational patterns.

**The one thing to keep sharp here — Redis is not a persistent store, and that is a feature:**

- ElastiCache Redis stores data in memory. When the node restarts, data is gone (unless persistence is configured, which most caching use cases do not need).
- The correct mental model: Redis is a fast, temporary layer in front of your authoritative data store (Aurora, DynamoDB). A cache miss should always be recoverable from the source of truth.
- **Eviction policy matters**: at Winamax's scale, the cache will fill. `allkeys-lru` (evict least recently used keys) is the right default for a cache. `noeviction` (reject writes when full) is dangerous — it breaks the application instead of falling back to the DB.

**K8s bridge:** An ElastiCache Redis cluster is like a StatefulSet with a Service in front. Cluster mode with multiple shards is like sharding a StatefulSet across multiple headless service endpoints.

---

## Part 5: Least-Privilege DB Access — IAM auth, ephemeral credentials, break-glass

See `06-db-access-governance.md` for the full guide — IAM auth for RDS, the automated access management system Winamax built, break-glass procedures, and audit trails.

**The one thing to keep sharp here — the goal is zero long-lived DB credentials:**

- **IAM database authentication for RDS/Aurora**: instead of a static username/password, an IAM identity generates a temporary token via `rds:connect`. The token expires in 15 minutes. If it leaks, the blast radius is a 15-minute window.
- **The Winamax access governance project**: they automated DB access requests — a developer requests access, the system creates an ephemeral DB user with minimum required privileges, the access expires automatically after a defined window (e.g., 1 hour for a debugging session). No standing access.
- **Break-glass**: for emergencies, there is a documented procedure to get elevated access, with automatic alerting that the glass was broken and audit logging of everything done during the session.

**Why this matters more than it looks**: with 700+ services and 50 TB of data, standing DB access for developers means `SELECT * FROM users` is one forgotten tab away. Ephemeral access closes that permanently.

---

## Part 6: Environment Cloning with Anonymization

See `06-env-cloning.md` for the full guide — the pipeline for copying prod data to staging, PII anonymization patterns, and how to validate the result.

**The one thing to keep sharp here — staging data must be real enough to be useful, fake enough to be safe:**

- A staging environment that does not look like production will not catch production bugs. The cardinality of user IDs, the distribution of bet amounts, the structure of event data — these must be representative.
- But you cannot copy `email`, `full_name`, `IBAN`, `IP address`, or bet history that could identify a real user to a lower-security environment.
- The solution is **deterministic anonymization**: `email = sha256(original_email + salt)@anonymous.winamax.fr`. The shape is preserved (it is an email). The value is irreversible. Importantly, deterministic hashing means the same user always maps to the same anonymized ID — relational integrity is preserved across tables.

**Regulatory context (France):** CNIL (the French data protection authority) has clear requirements. Winamax processes bet history, payment info, and identity documents. A data breach of a staging database is still a data breach if the data is real.

---

## Part 7: Connection Pooling — RDS Proxy

See `06-rds-proxy-deep.md` for the full guide — how RDS Proxy works, connection multiplexing, failover behavior, IAM integration, and when to use it vs not.

**The one thing to keep sharp here — 700 services × N connections each = a connection problem:**

- Aurora MySQL has a connection limit. At 700 services, each with multiple ECS tasks, each opening their own connection pool, you can exhaust Aurora's max connections before load becomes a problem.
- **RDS Proxy** sits between your application and Aurora. It maintains a small pool of long-lived database connections and multiplexes thousands of short-lived application connections onto them. The database sees a fraction of the connections.
- RDS Proxy also improves failover: instead of applications reconnecting directly to Aurora (30-second failover), they reconnect to the Proxy (seconds), and the Proxy handles the Aurora failover in the background.

**K8s bridge:** RDS Proxy is like an Nginx upstream proxy for database connections. The applications connect to the proxy VIP (the proxy endpoint), not the database directly.

---

## Exercises

`exercises/06-databases/` — hands-on labs:
- `01-aurora-failover.md` — simulate and diagnose an Aurora failover
- `02-dynamodb-access-patterns.md` — design DynamoDB schema for bet tracking
- `03-db-access-governance.md` — design the ephemeral DB access system
- `04-anonymization-pipeline.md` — design the prod-to-staging data pipeline

## Interview Q&A

`interview/06-database-questions.md`
