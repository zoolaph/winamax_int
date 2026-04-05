# Exercise 1 — Aurora Failover Simulation

## Scenario

You are on-call for Winamax's production platform. It is 22:30 on a Friday — a Champions League match is in progress and bet volume is at peak. A P1 incident fires: the Aurora writer in `eu-west-3a` is experiencing intermittent errors. CloudWatch shows `DMLLatency` spiking to 8 seconds (normal: < 5ms).

You have 3 nodes in your Aurora cluster:
- Writer: `winamax-prod-instance-1` (eu-west-3a) — `promotion_tier=0`
- Reader 1: `winamax-prod-instance-2` (eu-west-3b) — `promotion_tier=1`
- Reader 2: `winamax-prod-instance-3` (eu-west-3c) — `promotion_tier=1`

---

## Task 1: Diagnose before acting

Before touching the cluster, what do you check first? List 5 specific metrics or commands you run and what you are looking for in each.

```
1. Metric/Command: ____________________
   Looking for: ____________________

2. Metric/Command: ____________________
   Looking for: ____________________

3. Metric/Command: ____________________
   Looking for: ____________________

4. Metric/Command: ____________________
   Looking for: ____________________

5. Metric/Command: ____________________
   Looking for: ____________________
```

---

## Task 2: Failover decision

Based on your investigation, you determine that the writer instance has a storage I/O problem specific to the `eu-west-3a` zone. The underlying issue is AWS-side — not application code.

**Decision:** You decide to trigger a manual failover to promote Reader 1 to writer.

Write the AWS CLI command to trigger a manual Aurora failover, targeting `winamax-prod-instance-2` as the new writer:

```bash
aws rds ___________________________
```

---

## Task 3: Application behavior during failover

Your ECS tasks are connecting to the cluster endpoint with a JDBC connection pool (HikariCP) configured with:
- `minimumIdle=2`, `maximumPoolSize=10`
- `connectionTimeout=30000` (30 seconds)
- `idleTimeout=600000`
- No `autoReconnect` flag set

Questions:
1. What happens to in-flight transactions during the failover?
2. Will HikariCP reconnect automatically after the failover? Why or why not?
3. What configuration change would make the application more resilient to the ~30-second failover window?

---

## Task 4: Post-failover verification

The failover completes. Write the SQL queries you would run to verify the new writer is healthy and data is consistent:

```sql
-- Query 1: Verify this node is now the writer (not a replica)
___________________________

-- Query 2: Check replication lag on the remaining readers
___________________________

-- Query 3: Check for any pending/stuck transactions
___________________________
```

---

## Task 5: Post-incident action

The issue was AZ-specific. What infrastructure change do you recommend to reduce the blast radius of a future AZ failure, and how would you implement it?

---

## Answer Key

### Task 1: What to check before acting

```
1. CloudWatch → DMLLatency and ReadLatency → Is it writes only or reads too?
   If reads are also slow, this might be storage, not just the writer instance.

2. CloudWatch → VolumeWriteIOPs vs provisioned IOPS limit → Are we hitting the IOPS ceiling?
   If VolumeWriteIOPs = max provisioned: IOPS throttling, not instance failure.

3. RDS Console / CloudWatch → FreeableMemory on the writer → Memory pressure?
   Low memory causes swap usage and I/O thrashing.

4. MySQL SHOW PROCESSLIST on the writer → Are there blocking transactions?
   A long-running DDL or unindexed query can block all other writes.

5. CloudWatch → AuroraReplicaLag → How far behind are the readers?
   High lag means the storage volume is under pressure — a failover will promote
   a reader that is already caught up (Aurora's shared storage means lag is usually <10ms).
```

### Task 2: Manual failover CLI command

```bash
aws rds failover-db-cluster \
  --db-cluster-identifier winamax-prod \
  --target-db-instance-identifier winamax-prod-instance-2 \
  --region eu-west-3
```

`--target-db-instance-identifier` is optional but recommended — without it, Aurora chooses based on `promotion_tier`. Since both readers have `promotion_tier=1`, it would be random.

### Task 3: Application behavior

1. **In-flight transactions are rolled back.** The new writer has no knowledge of uncommitted transactions on the old writer. Applications must implement retry logic for transactional operations.

2. **HikariCP will reconnect automatically** — but only after the pool detects the broken connections. HikariCP uses `keepaliveTime` and `connectionTestQuery` to detect dead connections. Without these configured, it may take a full `connectionTimeout` (30 seconds) to detect and evict broken connections, then another cycle to establish new ones. During this period, the application returns `SQLException: Unable to acquire connection`.

3. **Configuration improvements:**
   ```properties
   # Detect dead connections faster
   keepaliveTime=30000           # Test idle connections every 30s
   connectionTestQuery=SELECT 1
   
   # JDBC URL options for Aurora failover
   jdbc:mysql://winamax-prod.cluster-xyz.eu-west-3.rds.amazonaws.com/bets_db
     ?autoReconnect=true
     &failOverReadOnly=false     # After failover, new writer accepts writes
     &socketTimeout=5000         # Fail fast on network issues (don't wait 30s)
   ```

### Task 4: Post-failover SQL checks

```sql
-- Query 1: Verify this is the writer
SHOW GLOBAL VARIABLES LIKE 'innodb_read_only';
-- Expected on writer: innodb_read_only = OFF
-- On a replica: innodb_read_only = ON

-- Or: Aurora-specific
SELECT @@aurora_server_id, @@read_only;

-- Query 2: Replication lag (run on the remaining readers)
SHOW REPLICA STATUS\G
-- Look for: Seconds_Behind_Source = 0

-- Or Aurora-specific metric:
SELECT server_id, durable_lsn, highest_lsn, feedback_epoch 
FROM information_schema.replica_host_status;

-- Query 3: Stuck transactions
SELECT * FROM information_schema.INNODB_TRX
WHERE TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) > 30;
-- Any transaction older than 30 seconds should be investigated
```

### Task 5: Reducing AZ blast radius

**Recommendation:** If not already in place, ensure NAT Gateways and RDS Proxy endpoints exist in each AZ independently. An AZ failure should not cascade through shared infrastructure.

**Specifically for Aurora:**
- Set `promotion_tier=0` on the reader in the same AZ as the most common writer (eu-west-3b or eu-west-3c, since eu-west-3a just failed). This ensures the next failover promotes the closest replica.
- Consider Aurora Global Database if the requirement is cross-region, not just cross-AZ (RTO of <1 minute for region failover).

**Terraform change:**
```hcl
resource "aws_rds_cluster_instance" "reader_3b" {
  promotion_tier = 0  # Promote this instance first on next failover
  # (was 1, now 0 — eu-west-3a is the problem zone)
}
```
