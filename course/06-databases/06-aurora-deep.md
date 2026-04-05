# Aurora MySQL — Deep Dive

## What Aurora is (and is not)

Aurora is not just "managed MySQL." The storage engine is completely different. Regular RDS MySQL replicates the entire binlog to replicas — the primary writes to its local disk, then streams the log to replicas, which re-apply it. Aurora decouples compute from storage entirely.

**Aurora architecture:**

```
┌─────────────────────────────────────────────────────┐
│                  Aurora Cluster                      │
│                                                     │
│  Writer instance       Reader instance(s)           │
│  (primary)             (read replicas)              │
│       │                      │                      │
│       └──────────┬───────────┘                      │
│                  │                                  │
│         Shared Storage Volume                       │
│    (6 copies across 3 AZs — 2 per AZ)              │
│    eu-west-3a  eu-west-3b  eu-west-3c               │
└─────────────────────────────────────────────────────┘
```

- The writer writes to shared storage. Replicas read from the **same storage** — no log shipping.
- A write is acknowledged when 4 of 6 storage nodes confirm. Two AZs can fail and you still have quorum.
- Replication lag between writer and readers is typically under 10ms — much less than traditional MySQL replication.

---

## Endpoints — the critical interview topic

Aurora exposes multiple endpoint types. Using the wrong one is a common mistake.

| Endpoint | What it points to | Use for |
|--|--|--|
| **Cluster endpoint** | Current writer (auto-updates after failover) | All writes, transactions |
| **Reader endpoint** | Load-balanced across all readers | Read-heavy queries, analytics |
| **Instance endpoint** | Specific instance (writer or a specific reader) | Direct access, maintenance, debugging |
| **Custom endpoint** | Subset of instances you define | Isolate analytical queries to larger readers |

**Application configuration:**
```
# Write connection — always use cluster endpoint
AURORA_WRITE_HOST=winamax-prod.cluster-xyz.eu-west-3.rds.amazonaws.com

# Read connection — use reader endpoint for read-heavy paths
AURORA_READ_HOST=winamax-prod.cluster-ro-xyz.eu-west-3.rds.amazonaws.com
```

If an ECS service is using the cluster endpoint for reads, it puts unnecessary load on the writer and defeats the purpose of having read replicas.

---

## Failover mechanics

When the writer fails (instance crash, AZ outage, manual failover):

1. Aurora detects the failure (~10 seconds).
2. It promotes a replica to writer. The replica already has current storage — no catchup needed.
3. The cluster endpoint updates its DNS to point to the new writer (~30 seconds total).
4. Applications reconnect. JDBC drivers with automatic reconnect pick this up transparently.

**Why 30 seconds instead of seconds:** The bottleneck is DNS TTL propagation, not Aurora internals. The DNS record for the cluster endpoint has a short TTL (5 seconds by default), but client DNS caches can hold it longer. This is why applications should implement connection retry logic with exponential backoff.

**Parameter that controls failover priority:**
```sql
-- Higher tier (0) = promoted first. Set to 0 on the replica in the primary AZ.
-- Set to 1 on replicas in secondary AZs.
-- aurora_replica_priority = 0
```

Or in Terraform:
```hcl
resource "aws_rds_cluster_instance" "reader_primary_az" {
  promotion_tier = 0  # This instance is promoted first on failover
}
```

---

## Parameter Groups

Aurora parameter groups work at two levels:

1. **DB Cluster Parameter Group** — applies to the entire cluster (storage behavior, binlog format, character set).
2. **DB Parameter Group** — applies to individual instances (connection limits, query cache, slow query log).

**Critical parameters to know:**

```
# Cluster level
binlog_format = ROW          # Required for data replication tools (DMS, Debezium)
character_set_server = utf8mb4   # Handles emoji and extended Unicode (bet data has this)
innodb_flush_log_at_trx_commit = 1  # Full ACID durability. Don't change this.

# Instance level
max_connections = 1000       # Tune based on instance class. Too low = connection refused.
slow_query_log = 1           # Log queries over long_query_time
long_query_time = 1          # 1 second threshold for slow query log
performance_schema = 1       # Required for detailed query analysis
```

Parameter group changes: **static parameters** require a reboot, **dynamic parameters** apply immediately. Know which is which before changing in production.

---

## Aurora Serverless v2

Aurora Serverless v2 is worth knowing — it scales ACUs (Aurora Capacity Units) up and down in ~1-second increments based on load.

```hcl
resource "aws_rds_cluster" "winamax_prod" {
  engine_mode = "provisioned"   # Serverless v2 uses "provisioned" with serverless_v2_scaling_configuration
  
  serverless_v2_scaling_configuration {
    min_capacity = 0.5   # 0.5 ACU minimum — stays warm but cheap at idle
    max_capacity = 128   # 128 ACU maximum — enough for Winamax's peak
  }
}
```

**Winamax use case:** The sports betting load is extremely spiky — a Champions League final generates 10x the normal write rate in 5 minutes. Serverless v2 handles this without pre-provisioning for peak.

---

## Connection pooling with RDS Proxy (Aurora integration)

See `06-rds-proxy-deep.md`. The Aurora-specific behavior:

- RDS Proxy pins a connection to a specific backend connection when it detects transactions or session state (SET commands, temp tables). Pinning reduces the multiplexing benefit — write queries that use transactions should be fast and release the connection quickly.
- For Aurora, RDS Proxy supports IAM authentication natively — no passwords stored in the application.

---

## Operational runbook — Aurora incident checklist

**Scenario: Write latency spike**
1. Check `DMLLatency`, `CommitLatency`, `BufferCacheHitRatio` in CloudWatch or Prometheus.
2. Check `max_connections` — is the writer rejecting new connections?
3. Check `aurora_replica_lag_in_milliseconds` — if replicas are lagging, read traffic is shifting to writer.
4. Check `VolumeWriteIOPs` — storage IOPS throttling if at provisioned limit.
5. Run `SHOW PROCESSLIST` on the writer — are there blocking transactions?

**Scenario: Reader returns stale data**
1. Check `AuroraReplicaLag` metric. Under 20ms is normal. Over 100ms indicates load.
2. If the application has just written and immediately reads, the replica may not have the write yet. Solution: route post-write reads back to the writer endpoint for a short window (or use sticky routing).

---

## Aurora vs RDS MySQL — when to choose what

Always use Aurora in production unless:
- You need a specific MySQL version Aurora does not support (rare).
- Cost is the primary driver for a tiny database (RDS MySQL is slightly cheaper at minimal scale).
- You need MySQL-compatible replication to an on-premise system (Aurora's replication is proprietary storage-level; binlog-based replication to external systems requires enabling binlog separately).

Aurora's failover, storage scalability, and replication lag advantages are decisive for Winamax's scale.
