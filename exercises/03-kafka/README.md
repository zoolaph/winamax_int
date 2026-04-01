# Module 3 Exercises — Kafka Operational Depth

These exercises test operational judgment, not just knowledge. The goal is to produce answers you can defend in an interview with a Winamax SRE.

---

## Exercise 1: Design a topic and partition layout for the Winamax bet lifecycle

### Scenario

You are designing the Kafka topics for the bet placement flow at Winamax:

- 900,000+ bets/day peak (~75,000 msg/sec cluster-wide)
- The following events exist in the bet lifecycle: `BET_PLACED`, `BET_ACCEPTED`, `BET_REJECTED`, `BET_SETTLED`, `BET_CANCELLED`
- The fraud detection service must process events for the same bet in order
- The analytics pipeline must receive all events but order does not matter
- The settlement service must process `BET_SETTLED` exactly-once to avoid double payment
- Retention: fraud service needs 2 days of replay; analytics needs 30 days
- Replication factor must tolerate 1 broker failure

### Your task

Answer these questions in writing:

1. How many topics do you create? What are they named? Why not one topic for everything?
2. What message key do you use for each topic? Why?
3. How many partitions for the `bet-placed` topic? Show your calculation.
4. What replication factor? What `min.insync.replicas`?
5. What retention policy for each topic?
6. How does the settlement service achieve exactly-once semantics?

### Solution

<details>
<summary>Expand after attempting</summary>

**Topics:**

```
bet-events          → all bet lifecycle events (placed, accepted, rejected, settled, cancelled)
bet-settled-billing → only BET_SETTLED events, for the settlement service
```

Or alternatively, single topic with consumer groups filtering by event type. The choice is a trade-off:
- Single topic: simpler, but settlement service reads all events including ones it discards
- Separate topic: settlement service only reads what it needs, but requires routing logic at the producer

Both are defensible. Be ready to explain the trade-off.

**Message key:**
- `bet_id` — guarantees all events for a bet land on the same partition, ensuring ordered processing

**Partition calculation for `bet-events`:**

```
Peak throughput: ~10,000 bets/sec (within 75k cluster-wide)
Assume 1 KB average message → 10 MB/sec to this topic
Safe throughput per partition: ~10 MB/sec (depends on disk speed, but this is conservative)
Partitions needed for throughput: 10 MB/sec ÷ 10 MB/sec = 1 partition (throughput is fine)

But we want parallelism: fraud detection needs enough partitions for its consumer count.
If fraud detection runs 24 instances at peak: 24 partitions minimum.

Round up to next power of 2 for easier hash distribution: 32 partitions
```

**Replication and ISR:**

```
Replication factor: 3 (tolerates 1 broker failure)
min.insync.replicas: 2 (writes succeed with 2 of 3 replicas — one broker can fail/restart)
```

**Retention:**

```
bet-events:             retention.ms = 172800000 (2 days) — fraud service max replay window
bet-settled-billing:    retention.ms = 172800000 (2 days) — settlement replay window
analytics pipeline:     reads from bet-events, stores in its own long-term sink — Kafka is not the 30-day store
```

**Exactly-once for settlement:**

Option A: Kafka transactions — `bet-settled-billing` consumer uses transactional producer to write to the balance-update topic atomically with offset commit.

Option B: Idempotent consumer — settlement service uses `bet_id` as an idempotency key in the database (`INSERT ... ON CONFLICT DO NOTHING`). At-least-once + idempotent DB operation = effectively exactly-once.

Option B is simpler and is the correct answer for most production systems.

</details>

---

## Exercise 2: Diagnose consumer lag on a critical topic

### Scenario

You receive a PagerDuty alert at 2 AM:

```
CRITICAL: kafka_consumergroup_lag_sum{consumergroup="fraud-detection-service",topic="bet-placed"} = 850000
Alert threshold: 10000 for 5m
```

The bet service is operating normally. Kafka brokers show no errors. The fraud detection service ECS tasks are running (desired count: 8, running count: 8).

You run:
```
kafka-consumer-groups.sh --describe --group fraud-detection-service

PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG      CONSUMER-ID
0          12450000        12900000        450000   consumer-1
1          8900000         9200000         300000   consumer-2
2          5600000         5701000         101000   consumer-3
3          5600000         5701000         101000   consumer-4
...
(partitions 2-7 all show ~100k lag, relatively small)
(partitions 0 and 1 have 450k and 300k respectively)
```

### Your task

1. What is your immediate hypothesis?
2. What do you check next?
3. What are the possible root causes for the skew on partitions 0 and 1?
4. How do you resolve it?

### Solution

<details>
<summary>Expand after attempting</summary>

**Immediate hypothesis:** Partition skew — partitions 0 and 1 are receiving disproportionately more messages than partitions 2-7. This usually means the message key distribution is uneven (a "hot partition" problem).

**What to check next:**

```bash
# 1. Check production rate per partition
kafka-log-dirs.sh \
  --bootstrap-server kafka-broker:9092 \
  --topic-list bet-placed \
  --describe | grep "bet-placed"

# 2. Check consumer logs for consumer-1 and consumer-2
# Are they erroring? Are they slow? Processing time per message?

# 3. Check the message key distribution
# If bet_id is the key: are a small number of bet_ids generating huge volumes?
# (a testing script, a bot, a replay job)
```

**Possible root causes:**

1. **Hot partition from key skew:** If bet_id hashes are concentrating on partitions 0 and 1. This can happen if:
   - A large number of bets share a common key prefix
   - An automated testing system is placing thousands of bets with sequential IDs that hash to the same partition
   - A replay job is flooding the topic with events for a specific set of bets

2. **Consumer 1 and 2 are slower:** The consumers assigned to partitions 0 and 1 have a downstream bottleneck (slow DB shard, slow external API call) that the others do not.

3. **Recent repartitioning or skewed initial distribution:** If partitions were reassigned, the distribution may be uneven.

**Resolution path:**

If hot partition (production skew):
- Identify the source producing so many messages to partitions 0 and 1
- If it is a legitimate traffic spike: add more consumer instances and more partitions (but partition count change is a planned operation, not a hotfix)
- If it is runaway automation: stop the automation at the source

If consumer slowness:
- Check consumer-1 and consumer-2 logs
- Check their downstream dependencies
- Restart if they are in a degraded state

**Immediate mitigation:** Scale consumer group from 8 to 16 instances. ECS will rebalance and partitions 0 and 1 will each get 2 consumers... but wait — one partition can only have 1 consumer per group. Scaling consumers above partition count does not help partition skew.

The real fix for hot partitions is to fix the key distribution or increase the partition count. Neither is a 2 AM hotfix. The right 2 AM action is: stop the source of the spike, reduce the immediate lag, then fix partition layout in the morning.

</details>

---

## Exercise 3: Implement a Dead Letter Queue pattern

### Scenario

You are building the fraud detection consumer for Winamax. It reads from `bet-placed` and calls an internal fraud scoring API. Design the DLQ handling.

### Your task

Write pseudocode (or JavaScript) for a consumer that:
1. Reads from `bet-placed`
2. Calls `fraudScoringApi.score(betEvent)` with up to 3 retries, exponential backoff
3. On final failure: writes to `bet-placed.dlq` with diagnostic headers
4. Commits the offset either way (does not block the partition)
5. Alerts if more than 5 DLQ messages appear within 60 seconds

### Solution

<details>
<summary>Expand after attempting</summary>

```javascript
const { Kafka } = require('kafkajs');

const kafka = new Kafka({ brokers: ['kafka:9092'] });
const consumer = kafka.consumer({ groupId: 'fraud-detection-service' });
const dlqProducer = kafka.producer();

const DLQ_TOPIC = 'bet-placed.dlq';
const MAX_ATTEMPTS = 3;
let dlqCountInWindow = 0;

async function processWithDLQ(message) {
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const betEvent = JSON.parse(message.value.toString());
      await fraudScoringApi.score(betEvent);
      return; // success
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(Math.pow(2, attempt) * 200); // 400ms, 800ms
      }
    }
  }

  // All attempts failed — send to DLQ
  await dlqProducer.send({
    topic: DLQ_TOPIC,
    messages: [{
      key: message.key,
      value: message.value,
      headers: {
        'dlq-source-topic': 'bet-placed',
        'dlq-source-partition': String(message.partition),
        'dlq-source-offset': String(message.offset),
        'dlq-error-message': lastError.message,
        'dlq-error-type': lastError.constructor.name,
        'dlq-failed-at': new Date().toISOString(),
        'dlq-attempts': String(MAX_ATTEMPTS),
      },
    }],
  });

  // Track DLQ volume for alerting
  dlqCountInWindow++;
  if (dlqCountInWindow >= 5) {
    await alerting.fire('kafka.dlq.spike', {
      topic: 'bet-placed',
      count: dlqCountInWindow,
      recentError: lastError.message,
    });
  }
}

// Reset DLQ window counter every 60 seconds
setInterval(() => { dlqCountInWindow = 0; }, 60000);

async function run() {
  await consumer.connect();
  await dlqProducer.connect();
  await consumer.subscribe({ topic: 'bet-placed', fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      await processWithDLQ(message);
      // Offset commits automatically after eachMessage returns (auto-commit mode)
      // Or call consumer.commitOffsets() explicitly for manual control
    },
  });
}
```

**Key points in this implementation:**
- Offset commits after both success AND DLQ write — partition always advances
- DLQ headers enable operational forensics: when, which partition, which offset, what error
- In-memory DLQ counter with a reset interval — simple alerting signal (a real system would use a Prometheus counter)

</details>

---

## Exercise 4: MSK or self-managed? Justify your choice

### Scenario

Winamax is expanding to Germany and needs to deploy a new Kafka cluster to handle German regulatory requirements (data residency). Current cluster: 75,000 msg/sec, RF=3, 24 partitions per topic, ~40 topics. The German cluster will start at 20% of that load and grow.

The team has: 3 senior platform engineers familiar with Kafka operations, no AWS Kafka-specific experience. Budget is not a constraint for infrastructure (it is for team time).

### Your task

Write a recommendation: MSK or self-managed? Include:
1. Your recommendation
2. Three reasons supporting it
3. One risk you are accepting
4. One thing you would do differently if budget were constrained

### Solution

<details>
<summary>Expand after attempting</summary>

**Recommendation: MSK (provisioned)**

**Reasons:**

1. **Reduced time-to-production for a new region:** MSK handles broker provisioning, multi-AZ placement, OS patching, and version upgrades. The team can focus on topic design, consumer group migration, and application-layer concerns — the same skills they already have — rather than standing up broker infrastructure from scratch.

2. **Team is already Kafka-operationally capable, not Kafka-infra-operationally capable:** The 3 engineers know Kafka operations (consumer groups, partition management, lag monitoring). They do not have MSK-specific experience, but MSK does not require it — it abstracts broker infrastructure. Self-managed EC2 would require learning AWS-specific infrastructure management on top of Kafka operations.

3. **Starting at 20% load with growth:** MSK makes capacity scaling (broker count, storage expansion) straightforward. At 20% of Winamax's main cluster load, MSK sizing is straightforward. If the cluster grows 5x, adding MSK brokers is a console/Terraform change, not a manual provisioning and rack-awareness exercise.

**Risk accepted:**

MSK's Kafka version lags behind Apache Kafka releases. If the German regulatory compliance stack requires a Kafka feature in a version MSK does not yet support, this becomes a blocker. Mitigate: check MSK's current supported Kafka version against any features you need before committing.

**If budget were constrained:**

Run the German cluster on fewer, larger EC2 instances with self-managed Kafka using KRaft (no ZooKeeper overhead). With KRaft, a 3-broker self-managed cluster is operationally simpler than the ZooKeeper-era setup. The team's existing Kafka knowledge transfers directly.

</details>

---

## Exercise 5: Write a partition reassignment runbook step

### Scenario

You are adding 3 new brokers (IDs: 4, 5, 6) to the Winamax Kafka cluster (currently brokers 0, 1, 2, 3). The cluster is live at 75,000 msg/sec. You need to reassign some partitions from brokers 0-3 to include the new brokers 4-6 to balance the load.

### Your task

Write the exact commands (with explanations) you would run to:
1. Generate a reassignment plan
2. Execute it safely with a throttle
3. Monitor progress
4. Remove the throttle after completion

Include: what value you would set for the throttle and why, and what you watch on Grafana during the operation.

### Solution

<details>
<summary>Expand after attempting</summary>

See `03-runbook.md` for the complete commands. Key decision points to articulate:

**Throttle value calculation:**
```
Current cluster network utilization: check Grafana (assume 30 MB/sec per broker)
Available headroom: typical broker capacity 100 MB/sec, 70 MB/sec available
Conservative throttle: 30 MB/sec (leave 40 MB/sec for production traffic)
Command: --throttle 31457280 (30 MB in bytes)
```

**Grafana panels to watch:**
- Broker network throughput (ensure it does not spike above safe limit)
- Under-replicated partitions count (should stay at 0 outside of the moving partitions)
- Producer request latency (should not increase — sign of broker overload)
- Consumer lag on critical topics (should not grow during reassignment)

**Execution checklist:**
1. `--dry-run` the plan first
2. Schedule during off-peak hours (3-5 AM)
3. Set throttle before executing
4. Monitor every 5 minutes
5. Remove throttle immediately after `--verify` shows completion
6. Trigger preferred leader election to balance leader distribution

</details>
