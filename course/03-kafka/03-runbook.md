# Kafka Operational Runbook — Partition Reassignment, Broker Failure, Topic Cleanup

## Overview

This runbook covers the three most common high-impact Kafka operational tasks. Know these cold — Winamax will ask what you do when a broker fails or when a topic is filling up disk.

---

## 1. Broker failure

### What happens automatically

When a broker dies, Kafka does the following without operator intervention:
1. ZooKeeper (or KRaft controller) detects the broker is no longer sending heartbeats
2. Leader elections are triggered for all partitions where the dead broker was the leader
3. A broker in the ISR for each affected partition is elected as the new leader
4. Producers and consumers automatically reconnect to the new leaders
5. Time to new leaders: typically 10-30 seconds depending on `zookeeper.session.timeout.ms` / `broker.session.timeout.ms`

### What you need to do

**Step 1: Verify the failure**

```bash
# List all brokers in the cluster
kafka-broker-api-versions.sh --bootstrap-server kafka-broker:9092

# Check which partitions are under-replicated (ISR < replication factor)
kafka-topics.sh \
  --bootstrap-server kafka-broker:9092 \
  --describe \
  --under-replicated-partitions

# Output shows partitions where ISR is now only 1 (down from 3)
Topic: bet-placed  Partition: 7  Leader: 2  Replicas: 0,1,2  Isr: 1,2
#                                                              ↑ broker 0 is dead
```

**Step 2: Check whether writes are still possible**

```bash
# If min.insync.replicas=2 and ISR=2, writes still succeed
# If ISR drops to 1 on a topic with min.insync.replicas=2, writes will fail
kafka-topics.sh --describe --topic bet-placed --bootstrap-server kafka-broker:9092
```

**Step 3: Replace or restart the broker**

For a permanent failure (hardware dead):
- Provision a new broker with the same `broker.id` as the dead one (if using static IDs)
- Or provision with a new ID and trigger partition reassignment to bring replicas back to count

For a transient failure (broker process crash, OOM):
- Restart the broker process
- Kafka automatically starts replicating to catch up the restarted broker
- Monitor ISR recovery: `kafka-topics.sh --describe --under-replicated-partitions` until output is empty

**Step 4: Monitor ISR recovery**

```bash
# Watch under-replicated partitions recover (run in a loop or Grafana)
watch -n5 "kafka-topics.sh --bootstrap-server kafka-broker:9092 \
  --describe --under-replicated-partitions | wc -l"
```

ISR recovery time = amount of data the follower needs to catch up / replication bandwidth. A throttle is not needed during recovery (it is only needed during manual reassignment).

**Step 5: Verify preferred leader election**

After a broker comes back, it may not automatically resume leadership for its preferred partitions. Trigger a preferred replica election:

```bash
kafka-leader-election.sh \
  --bootstrap-server kafka-broker:9092 \
  --election-type PREFERRED \
  --all-topic-partitions
```

This rebalances leader distribution across brokers, preventing one broker from handling more than its share of write traffic.

---

## 2. Partition reassignment

Partition reassignment moves partition replicas from one broker to another. Required when:
- Adding a new broker (distribute load to it)
- Decommissioning a broker (move its data off first)
- Rebalancing uneven partition distribution

**This is the most dangerous maintenance operation.** It moves data across the network while the cluster is serving traffic.

### Step 1: Generate the reassignment plan

```bash
# Create topics-to-reassign.json
cat > /tmp/topics-to-move.json << 'EOF'
{
  "topics": [
    {"topic": "bet-placed"},
    {"topic": "bet-settled"}
  ],
  "version": 1
}
EOF

# Generate a balanced reassignment plan targeting specific broker IDs
kafka-reassign-partitions.sh \
  --bootstrap-server kafka-broker:9092 \
  --broker-list "0,1,2,3" \  # include the new broker 3
  --topics-to-move-json-file /tmp/topics-to-move.json \
  --generate \
  > /tmp/reassignment-plan.json

# Inspect the plan before executing
cat /tmp/reassignment-plan.json
```

### Step 2: Set a throttle (CRITICAL)

Without a throttle, reassignment saturates inter-broker network and causes producer timeout errors.

```bash
# Set throttle to 50 MB/sec per broker (adjust based on available headroom)
kafka-reassign-partitions.sh \
  --bootstrap-server kafka-broker:9092 \
  --reassignment-json-file /tmp/reassignment-plan.json \
  --throttle 52428800 \  # 50 MB/sec in bytes
  --execute
```

**How to pick the throttle value:**
- Check current inter-broker replication traffic (Grafana / CloudWatch)
- Leave 50% headroom for normal traffic
- Start conservative, increase if reassignment is too slow

### Step 3: Monitor progress

```bash
# Check reassignment status
kafka-reassign-partitions.sh \
  --bootstrap-server kafka-broker:9092 \
  --reassignment-json-file /tmp/reassignment-plan.json \
  --verify

# Output shows status per partition:
# Status of partition reassignment:
# Reassignment of partition bet-placed-7 is still in progress
# Reassignment of partition bet-placed-3 is completed
```

### Step 4: Remove throttle after completion

```bash
# Throttle configs linger on topics even after reassignment completes — remove them
kafka-configs.sh \
  --bootstrap-server kafka-broker:9092 \
  --entity-type topics \
  --entity-name bet-placed \
  --alter \
  --delete-config leader.replication.throttled.replicas,follower.replication.throttled.replicas

# Also remove broker-level throttle
kafka-configs.sh \
  --bootstrap-server kafka-broker:9092 \
  --entity-type brokers \
  --entity-name 0 \
  --alter \
  --delete-config leader.replication.throttled.rate,follower.replication.throttled.rate
# Repeat for each broker
```

Forgetting to remove the throttle is a common mistake — it silently limits replication bandwidth long after the reassignment is done.

---

## 3. Topic cleanup — retention, compaction, disk management

### Topic retention configuration

Topics have two retention modes:

**Time-based retention** (default):

```bash
# Set retention to 7 days
kafka-configs.sh \
  --bootstrap-server kafka-broker:9092 \
  --entity-type topics \
  --entity-name analytics-events \
  --alter \
  --add-config retention.ms=604800000  # 7 days in ms
```

**Size-based retention:**

```bash
# Limit topic to 100 GB per partition
kafka-configs.sh \
  --bootstrap-server kafka-broker:9092 \
  --entity-type topics \
  --entity-name analytics-events \
  --alter \
  --add-config retention.bytes=107374182400  # 100 GB
```

**Both together:** Kafka deletes segments when EITHER limit is reached. Use both for topics where you want a time window AND a size cap.

### Log compaction

For topics that represent state (e.g., latest player preferences, current config values), log compaction keeps only the most recent value per key — older messages with the same key are deleted.

```bash
kafka-configs.sh \
  --bootstrap-server kafka-broker:9092 \
  --entity-type topics \
  --entity-name player-preferences \
  --alter \
  --add-config cleanup.policy=compact
```

A tombstone (message with null value) marks a key for deletion even from the compacted log.

### Emergency disk recovery

If a broker disk is filling up and Kafka is at risk:

**Short-term (emergency):**

```bash
# Temporarily reduce retention on the largest topics
kafka-configs.sh \
  --bootstrap-server kafka-broker:9092 \
  --entity-type topics \
  --entity-name analytics-events \
  --alter \
  --add-config retention.ms=3600000  # 1 hour — aggressive

# Force immediate log deletion (triggers cleanup beyond normal schedule)
kafka-configs.sh \
  --bootstrap-server kafka-broker:9092 \
  --entity-type brokers \
  --entity-name 0 \
  --alter \
  --add-config log.retention.check.interval.ms=60000  # check every minute instead of every 5
```

**Medium-term:**
- Add storage to the broker (expand EBS volume if on MSK/AWS)
- Add a new broker and reassign some partitions to it (with throttle)

**Never do:** Do not manually delete log segment files from the broker's data directory. Kafka tracks segment state internally — manual deletion corrupts that state.

---

## 4. Consumer group offset reset

When a consumer bug processes messages incorrectly and you need to replay:

```bash
# Stop all consumers in the group first — offset reset requires no active consumers
# Then:

# Reset to earliest (replay entire topic)
kafka-consumer-groups.sh \
  --bootstrap-server kafka-broker:9092 \
  --group fraud-detection-service \
  --topic bet-placed \
  --reset-offsets \
  --to-earliest \
  --execute

# Reset to a specific datetime
kafka-consumer-groups.sh \
  --bootstrap-server kafka-broker:9092 \
  --group fraud-detection-service \
  --topic bet-placed \
  --reset-offsets \
  --to-datetime 2026-03-15T14:00:00.000 \
  --execute

# Reset to a specific offset on a specific partition
kafka-consumer-groups.sh \
  --bootstrap-server kafka-broker:9092 \
  --group fraud-detection-service \
  --topic bet-placed:7 \
  --reset-offsets \
  --to-offset 1450000 \
  --execute
```

**Always use `--dry-run` before `--execute`:**

```bash
kafka-consumer-groups.sh \
  ... \
  --reset-offsets \
  --to-earliest \
  --dry-run  # shows what would change, does not execute
```

---

## 5. Quick diagnostic commands

```bash
# List all topics
kafka-topics.sh --bootstrap-server kafka-broker:9092 --list

# Describe a topic (partitions, ISR, leader)
kafka-topics.sh --bootstrap-server kafka-broker:9092 --describe --topic bet-placed

# Show all under-replicated partitions
kafka-topics.sh --bootstrap-server kafka-broker:9092 --describe --under-replicated-partitions

# Show all unavailable partitions (no leader)
kafka-topics.sh --bootstrap-server kafka-broker:9092 --describe --unavailable-partitions

# List consumer groups
kafka-consumer-groups.sh --bootstrap-server kafka-broker:9092 --list

# Describe consumer group lag
kafka-consumer-groups.sh --bootstrap-server kafka-broker:9092 --describe --group fraud-detection-service

# Show broker configs
kafka-configs.sh --bootstrap-server kafka-broker:9092 --describe --entity-type brokers --entity-name 0

# Show topic configs
kafka-configs.sh --bootstrap-server kafka-broker:9092 --describe --entity-type topics --entity-name bet-placed
```
