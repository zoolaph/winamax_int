# Wargame 03 — Kafka Consumer Lag: 850k on fraud-detection

## The scenario

It is 20:47 on a Saturday — Champions League match is live. PagerDuty fires:

```
CRITICAL: kafka_consumergroup_lag_sum{
  consumergroup="fraud-detection-service",
  topic="bet-placed"
} = 847293

Threshold: 10000 for 5m
Fired at: 20:43
```

You check the ECS service:
```
fraud-detection-service
  Desired: 8 | Running: 8 | Pending: 0
```

All 8 consumers appear healthy. No application errors in CloudWatch Logs. The bet-placed topic is receiving messages normally.

You run the consumer group describe:

```
PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG      CONSUMER-ID
0          18400000        18820000        420000   consumer-3
1          15200000        15510000        310000   consumer-7
2          9100000         9217000         117000   consumer-1
3          9100000         9218000         118000   consumer-2
4          9100000         9219000         119000   consumer-4
5          9100000         9219000         119000   consumer-5
6          9100000         9218000         118000   consumer-6
7          9100000         9219000         119000   consumer-8
```

---

## Your job

1. What does the partition-level breakdown tell you immediately?
2. What are the two plausible root causes given this distribution?
3. How do you differentiate between them right now?
4. What is your immediate mitigation at 20:47?
5. What is your permanent fix (not tonight)?

**Talk through all five points before scrolling.**

---
---
---
---
---
---

## Diagnosis path

### Reading the partition breakdown

Partitions 0 and 1 have 420k and 310k lag respectively. Partitions 2–7 have ~118k lag each — roughly equal and significantly lower.

This is not a uniform throughput problem (all partitions equally behind). This is **partition skew** — partitions 0 and 1 are either:
- Receiving far more messages than the other 6 (hot partition / key skew)
- Being consumed far slower than the other 6 (slow consumer on those partitions)

### Differentiating: hot partition vs slow consumer

**Check production rate per partition:**

```bash
kafka-log-dirs.sh \
  --bootstrap-server kafka-broker:9092 \
  --topic-list bet-placed \
  --describe \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for broker in data['brokers']:
    for log in broker['logDirs'][0]['partitions']:
        print(f\"Partition {log['partition']}: size={log['size']}, offsetLag={log['offsetLag']}\")
  "
```

If partition 0 and 1 have much larger `size` than others: the data is skewed at production. Hot partition.

If partition 0 and 1 have similar size to others: the data is even, but consumers on those partitions are slower. Slow consumer.

**Check consumer processing time in CloudWatch Logs:**

```bash
aws logs filter-log-events \
  --log-group-name /ecs/fraud-detection-service \
  --filter-pattern "processing_time_ms" \
  --start-time $(date -d '30 minutes ago' +%s000) \
  | jq '.events[].message' | head -20
```

If consumer-3 (on partition 0) logs show processing_time_ms of 800ms while others show 50ms: slow consumer.

### Root cause A: Hot partition from key skew

The bet-placed topic uses `bet_id` as the key. During a Champions League match, a large betting bot or automated system is placing thousands of bets rapidly — and the bot's bet IDs happen to hash to partition 0 and 1.

Or: a replay job was triggered that re-publishes historical bets, and those historical bet IDs hash to the same partitions.

**Immediate mitigation:**
Stop the source of the spike. Check if there is an anomalous producer:
```bash
# Check producer client IDs and rates — requires JMX or kafka-producer-perf-test metrics
# In MSK: check CloudWatch metric ProducerCount per partition
```

If it's a legitimate traffic spike (many bets on the match): you cannot fix partition count tonight. Your options:
1. Accept the lag on partitions 0 and 1 for the duration of the match — fraud detection will be delayed for those bets
2. Spin up dedicated consumers for partitions 0 and 1 only via `partition.assignment.strategy=manual` — this requires a code change

### Root cause B: Slow consumer on partitions 0 and 1

Consumer-3 and consumer-7 are hitting a slower downstream dependency — perhaps a different shard of the fraud scoring database, or a downstream API that is rate-limiting those two consumer instances specifically.

**Immediate mitigation:**
Restart consumer-3 and consumer-7. ECS rebalance will reassign those partitions to the other healthy consumers temporarily:

```bash
aws ecs stop-task \
  --cluster winamax-prod \
  --task <task-id-for-consumer-3>
# ECS will start a replacement task; rebalance will redistribute partition 0
```

Watch whether the lag on those partitions immediately starts closing after rebalance. If yes: the two consumer instances were in a degraded state. If no: it is not the consumer, it is the data.

### At 20:47 — what you actually do

1. Confirm lag is growing (not stable): run describe twice 60 seconds apart, compare the `CURRENT-OFFSET`
2. Check consumer logs for processing time skew — 2 minutes
3. If slow consumer: restart the two slow tasks
4. If hot partition: identify and stop the anomalous producer; accept lag on those partitions for the match duration
5. Page the fraud team: "fraud detection is delayed X minutes for partitions 0 and 1, bets being accepted but fraud review will lag"

### Permanent fix (tomorrow morning)

If hot partition from key skew:
- Investigate key distribution — is `bet_id` truly random or sequential in some ranges?
- Consider adding a random suffix to the key for analytics-only consumers (not for the financial path where ordering matters)
- Increase partition count in a planned operation (with coordination — partition count change is irreversible)

If slow consumer:
- Add per-partition processing time histogram to Prometheus: `processing_time_ms` labeled by `partition`
- Alert when any partition's P99 processing time is 5x the median — this catches slow consumers before lag spikes

---

## Follow-up questions they will ask

**"You said you'd accept the lag for the match. What is the business impact of fraud detection being 10 minutes behind on those partitions?"**

Bets placed by fraudulent actors on partitions 0 and 1 will be accepted and processed before the fraud signal arrives. If the fraud score comes back high after settlement, you can flag the account but may not be able to reverse the payout. The business impact depends on the settlement timing — if bets settle immediately, 10 minutes of lag means exposure. Communicate this clearly to the fraud and business team during the incident so they can decide whether to halt settlement on suspicious accounts manually.

**"Scaling consumers from 8 to 16 — does that help?"**

No. You already have one consumer per partition (8 consumers, 8 partitions). Adding more consumers above the partition count means some consumers get zero partitions assigned — they sit idle. The maximum useful consumer count equals the partition count. Scaling consumers does not help partition skew.

**"What is `unclean.leader.election` and is it relevant here?"**

Not directly relevant to consumer lag, but: `unclean.leader.election.enable=true` allows Kafka to elect an out-of-sync replica as leader if all ISR members are unavailable. This risks message loss. For Winamax's bet data, this should be `false`. It would only come up here if the lag spike was caused by a broker failure that triggered an unclean election.
