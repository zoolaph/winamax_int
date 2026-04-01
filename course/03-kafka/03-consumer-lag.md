# Consumer Lag — How to Measure, Alert, and Respond

## What lag is

**Consumer lag** is the difference between the latest offset produced to a partition and the last offset committed by a consumer group.

```
Partition 0:
  Latest offset (end):        offset 1,500,000
  Consumer committed offset:  offset 1,498,500
  Lag:                        1,500

Partition 1:
  Latest offset (end):        offset 2,200,000
  Consumer committed offset:  offset 2,198,000
  Lag:                        2,000

Total lag for this consumer group: 3,500 messages
```

Lag tells you **how far behind the consumer is** relative to the producer. It does not directly tell you how long that will take to process — that depends on the consumer's processing rate.

---

## Lag vs time-to-catchup

A lag of 50,000 messages sounds alarming. Whether it is a problem depends on:

```
time_to_catchup = lag / (consumption_rate - production_rate)
```

- Production rate: 75,000 msg/sec
- Consumption rate (current): 80,000 msg/sec
- Net: 5,000 msg/sec catchup speed
- Lag: 50,000 messages
- Time to catchup: 10 seconds → acceptable for most use cases

If consumption_rate < production_rate, lag grows indefinitely. This is the critical case.

---

## How to measure lag

### Command line

```bash
# Describe all partitions for a consumer group
kafka-consumer-groups.sh \
  --bootstrap-server kafka-broker:9092 \
  --group fraud-detection-service \
  --describe

# Output:
GROUP                    TOPIC       PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG  CONSUMER-ID
fraud-detection-service  bet-placed  0          1498500         1500000         1500  consumer-1
fraud-detection-service  bet-placed  1          2198000         2200000         2000  consumer-2
fraud-detection-service  bet-placed  2          980000          982000          2000  consumer-3
```

### JMX metrics (for Prometheus scraping)

The most important JMX metric:

```
kafka.consumer:type=consumer-fetch-manager-metrics,
  client-id=<id>,
  topic=<topic>,
  partition=<n>
  attribute=records-lag-max
```

`records-lag-max` is the maximum lag across all partitions for that consumer. Expose this via the JMX Prometheus exporter and scrape it with Prometheus.

### Kafka Exporter (easier at Winamax scale)

[kafka-exporter](https://github.com/danielqsj/kafka_exporter) exposes Prometheus metrics without JMX:

```
kafka_consumergroup_lag{consumergroup="fraud-detection-service", partition="0", topic="bet-placed"} 1500
kafka_consumergroup_lag_sum{consumergroup="fraud-detection-service", topic="bet-placed"} 5500
```

---

## How to alert on lag

### Do not alert on absolute lag alone

A lag of 100,000 is fine if your consumer processes at 200k msg/sec. A lag of 500 is critical if your consumer is completely stopped.

### Alert patterns

**Pattern 1: Lag exceeds a threshold for sustained time**

```yaml
# Prometheus alerting rule
- alert: KafkaConsumerLagCritical
  expr: |
    kafka_consumergroup_lag_sum{consumergroup="fraud-detection-service"} > 10000
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Fraud detection consumer lag sustained above 10k for 5 minutes"
```

The `for: 5m` prevents alerting on transient spikes (rebalance, brief slowdown).

**Pattern 2: Lag is growing (consumer falling behind)**

```yaml
- alert: KafkaConsumerLagGrowing
  expr: |
    rate(kafka_consumergroup_lag_sum{consumergroup="fraud-detection-service"}[5m]) > 0
  for: 10m
  annotations:
    summary: "Consumer is consistently falling behind — lag is growing"
```

This catches the worst scenario: production rate > consumption rate. Even if absolute lag is small, if it grows continuously it will eventually be a problem.

**Pattern 3: Consumer is completely stopped (lag = log size)**

```yaml
- alert: KafkaConsumerGroupDead
  expr: |
    kafka_consumergroup_lag_sum > 0
    and
    kafka_consumergroup_current_offset == kafka_consumergroup_current_offset offset 10m
  annotations:
    summary: "Consumer offset has not moved in 10 minutes"
```

---

## How to respond to lag

The response depends on the cause.

### Case 1: Consumer is too slow (processing bottleneck)

Symptoms: consumer is running but lag grows; CPU or DB utilization high in the consumer service.

Options:
1. **Scale consumers horizontally** — add more consumer instances (up to partition count). If you have 12 partitions and 4 consumers, adding 8 more consumers doubles throughput.
2. **Increase `max.poll.records`** — consume more messages per poll cycle if your batch processing is efficient.
3. **Optimize the processing logic** — profile the consumer, find the slow operation (DB write, external API call, complex computation).
4. **Increase partition count** — allows more consumer parallelism. Requires topic partition count increase and consumer group restart. Do not do this during the incident.

### Case 2: Consumer is crashed or not running

Symptoms: no offset commits moving, consumer group has no active members.

```bash
# Check active consumers in the group
kafka-consumer-groups.sh --describe --group fraud-detection-service
# If CONSUMER-ID column is empty for all partitions, no consumers are active
```

Response: restart the consumer service. Once running, it resumes from committed offsets. Monitor lag decrease rate.

### Case 3: Rebalance storm

Symptoms: lag spikes repeatedly, consumers show as joining/leaving frequently.

Cause: consumers are crashing and restarting in a loop, or processing takes longer than `max.poll.interval.ms`.

Response:
- Check consumer logs for errors causing crashes
- Increase `max.poll.interval.ms` if processing is legitimately slow
- Reduce `max.poll.records` to ensure each poll batch finishes within the interval

### Case 4: Upstream burst (temporary acceptable lag)

Symptoms: traffic spike (e.g., a major sporting event just ended, millions of bets settling simultaneously), lag spikes then recovers.

Response: monitor, do not act. Alert thresholds should include `for: 5m` to avoid false alarms during legitimate bursts. Ensure autoscaling can add consumer instances for the next spike.

### Case 5: Poison message causing partition halt

Symptoms: lag on one specific partition grows while others are fine; consumer logs show repeated errors on the same offset.

This is covered in `03-poison-messages.md`. The key point: this looks like consumer lag on one partition, but the root cause is a bad message, not a throughput problem. Scaling consumers does not help.

---

## Consumer lag per topic type — Winamax priorities

| Topic | Max acceptable lag | Alert threshold | Response SLA |
|---|---|---|---|
| bet-placed (fraud) | < 5,000 | 10,000 for 2 min | Immediate |
| bet-settled (balance) | < 10,000 | 25,000 for 5 min | Immediate |
| odds-update (broadcast) | < 1,000 | 5,000 for 1 min | Immediate |
| analytics-events | < 1,000,000 | > 5min of production | Best effort |
| audit-log | < 100,000 | 500,000 for 10 min | Within 30 min |

These numbers are illustrative — real thresholds depend on business SLOs. The pattern is: financial/safety topics have tight thresholds; analytics/audit have loose thresholds.

---

## Dashboard: what to show on a Kafka lag dashboard

```
[Consumer Lag Sum by Group]      — stacked area chart, per consumer group
[Lag Rate of Change]             — if rising, we have a problem
[Partition-Level Lag Heatmap]    — spot skew: is one partition falling behind?
[Consumer Instances Active]      — how many consumers are in each group
[Consumption Rate vs Production Rate] — the ratio that matters
[Time-to-Catchup]                — derived: lag / (consume_rate - produce_rate)
```

The partition-level heatmap is particularly useful for catching poison messages (one hot partition with growing lag, others healthy).
