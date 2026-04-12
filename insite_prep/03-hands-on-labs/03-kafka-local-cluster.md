# Hands-On Lab 03 — Run a Local Kafka Cluster and Operate It

## Goal

Run a 3-broker Kafka cluster locally using Docker Compose. Produce messages, consume them, simulate consumer lag, inspect it, and practice the operational commands you will use in the on-site interview.

**Time required:** 1.5 hours  
**Prerequisites:** Docker and Docker Compose installed

---

## Part 1: Start the cluster

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  zookeeper:
    image: confluentinc/cp-zookeeper:7.5.0
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000
    ports:
      - "2181:2181"

  broker-1:
    image: confluentinc/cp-kafka:7.5.0
    depends_on: [zookeeper]
    ports:
      - "9092:9092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 3
      KAFKA_DEFAULT_REPLICATION_FACTOR: 3
      KAFKA_MIN_INSYNC_REPLICAS: 2

  broker-2:
    image: confluentinc/cp-kafka:7.5.0
    depends_on: [zookeeper]
    ports:
      - "9093:9093"
    environment:
      KAFKA_BROKER_ID: 2
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 3
      KAFKA_DEFAULT_REPLICATION_FACTOR: 3
      KAFKA_MIN_INSYNC_REPLICAS: 2

  broker-3:
    image: confluentinc/cp-kafka:7.5.0
    depends_on: [zookeeper]
    ports:
      - "9094:9094"
    environment:
      KAFKA_BROKER_ID: 3
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9094
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 3
      KAFKA_DEFAULT_REPLICATION_FACTOR: 3
      KAFKA_MIN_INSYNC_REPLICAS: 2
```

```bash
docker compose up -d
# Wait 15 seconds for brokers to fully start
sleep 15

# Verify all 3 brokers are up
docker exec broker-1 kafka-broker-api-versions --bootstrap-server localhost:9092 \
  | grep "id: " | head -5
```

---

## Part 2: Create topics and understand partition layout

```bash
BOOTSTRAP="localhost:9092,localhost:9093,localhost:9094"

# Create a topic with 6 partitions, RF=3
docker exec broker-1 kafka-topics \
  --bootstrap-server $BOOTSTRAP \
  --create \
  --topic bet-events \
  --partitions 6 \
  --replication-factor 3 \
  --config min.insync.replicas=2 \
  --config retention.ms=172800000

# Describe the topic — note which broker is leader for each partition
docker exec broker-1 kafka-topics \
  --bootstrap-server $BOOTSTRAP \
  --describe \
  --topic bet-events
```

**What to look for:** Each partition has a Leader, Replicas list, and Isr (in-sync replicas) list. Leader is the broker that handles reads and writes for that partition. Replicas are all copies. ISR is the subset that are fully caught up.

**Practice question:** If broker-2 becomes the leader for partition 3, which broker handles reads and writes for that partition?

---

## Part 3: Produce and consume messages

**Terminal 1 — start a consumer:**
```bash
docker exec -it broker-1 kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic bet-events \
  --group fraud-detection-service \
  --from-beginning \
  --property print.key=true \
  --property print.partition=true \
  --property print.offset=true
```

**Terminal 2 — produce messages with keys:**
```bash
# Produce 100 messages with bet_id as key
for i in $(seq 1 100); do
  echo "bet-${i}:BET_PLACED user_id=${i} amount=$((RANDOM % 500 + 10))"
done | docker exec -i broker-1 kafka-console-producer \
  --bootstrap-server localhost:9092 \
  --topic bet-events \
  --property parse.key=true \
  --property key.separator=":"
```

**Observe in Terminal 1:** Messages arrive with their partition number. Notice that messages with the same key (bet-1, bet-1) always arrive on the same partition — key-based partitioning.

---

## Part 4: Simulate and inspect consumer lag

**Stop the consumer (Ctrl+C in Terminal 1). Then produce many more messages:**

```bash
# Produce 10,000 messages fast while consumer is stopped
for i in $(seq 1 10000); do
  echo "bet-${i}:BET_PLACED user_id=${i}"
done | docker exec -i broker-1 kafka-console-producer \
  --bootstrap-server localhost:9092 \
  --topic bet-events \
  --property parse.key=true \
  --property key.separator=":"

# Now check consumer lag — consumer is stopped, lag should be 10,000
docker exec broker-1 kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group fraud-detection-service
```

**What you see:**
```
PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG     CONSUMER-ID
0          17              1683            1666    -
1          16              1668            1652    -
2          17              1671            1654    -
...
```

`CONSUMER-ID = -` means no active consumer. The lag is real. When you restart the consumer, it will process from where it left off.

**Restart consumer and watch lag close:**
```bash
# Terminal 1 — restart consumer
docker exec -it broker-1 kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic bet-events \
  --group fraud-detection-service

# Terminal 3 — watch lag in real time (run every 5 seconds)
watch -n 5 "docker exec broker-1 kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group fraud-detection-service"
```

Watch the `LAG` column decrease as the consumer catches up.

---

## Part 5: Simulate a broker failure and ISR behavior

```bash
# Check ISR before failure — should be [1,2,3] for all partitions
docker exec broker-1 kafka-topics \
  --bootstrap-server localhost:9092 \
  --describe --topic bet-events

# Stop broker-2
docker compose stop broker-2

# Check ISR immediately after
sleep 5
docker exec broker-1 kafka-topics \
  --bootstrap-server localhost:9092 \
  --describe --topic bet-events
```

**What you see:** Partitions where broker-2 was a replica now show ISR=[1,3] (broker-2 dropped out). With `min.insync.replicas=2`, writes still succeed — we have 2 of 3 replicas.

**Check under-replicated partitions:**
```bash
docker exec broker-1 kafka-topics \
  --bootstrap-server localhost:9092 \
  --describe \
  --under-replicated-partitions
```

All partitions show as under-replicated. In production: this would fire a `UnderReplicatedPartitions > 0` alert.

**Restart broker-2 and watch it catch up:**
```bash
docker compose start broker-2

# Watch ISR recover
watch -n 3 "docker exec broker-1 kafka-topics \
  --bootstrap-server localhost:9092 \
  --describe --topic bet-events | grep 'Leader\|Isr'"
```

Broker-2 rejoins ISR once it fully catches up. This is the same process as a planned broker rolling restart.

---

## Part 6: Practice the partition reassignment runbook

```bash
# Create the topics.json file for reassignment
cat > /tmp/topics.json << 'EOF'
{"topics": [{"topic": "bet-events"}], "version": 1}
EOF

# Generate a reassignment plan
docker exec broker-1 kafka-reassign-partitions \
  --bootstrap-server localhost:9092 \
  --broker-list "1,2,3" \
  --topics-to-move-json-file /tmp/topics.json \  
  --generate

# This shows current assignment and proposed assignment
# In a real cluster: review the proposed plan before executing
```

---

## Part 7: DLQ pattern — practice with a consumer that fails

Create `consumer-with-dlq.js`:

```javascript
const { Kafka } = require('kafkajs');

const kafka = new Kafka({ brokers: ['localhost:9092'] });
const consumer = kafka.consumer({ groupId: 'dlq-test-group' });
const producer = kafka.producer();

const DLQ_TOPIC = 'bet-events.dlq';
const MAX_RETRIES = 3;

async function processMessage(message) {
  const value = message.value.toString();
  // Simulate: fail on every 5th message
  if (parseInt(message.offset) % 5 === 0) {
    throw new Error(`Simulated processing failure at offset ${message.offset}`);
  }
  console.log(`Processed: ${value.substring(0, 50)}`);
}

async function run() {
  await consumer.connect();
  await producer.connect();

  // Create DLQ topic if needed
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [{ topic: DLQ_TOPIC, numPartitions: 1 }]
  }).catch(() => {});
  await admin.disconnect();

  await consumer.subscribe({ topic: 'bet-events', fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      let lastError;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await processMessage(message);
          return;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100));
          }
        }
      }

      // Send to DLQ
      await producer.send({
        topic: DLQ_TOPIC,
        messages: [{
          key: message.key,
          value: message.value,
          headers: {
            'dlq-source-topic': 'bet-events',
            'dlq-source-partition': String(message.partition),
            'dlq-source-offset': String(message.offset),
            'dlq-error': lastError.message,
            'dlq-timestamp': new Date().toISOString(),
          }
        }]
      });
      console.log(`DLQ: offset ${message.offset} — ${lastError.message}`);
    }
  });
}

run().catch(console.error);
```

```bash
npm init -y && npm install kafkajs
node consumer-with-dlq.js &

# Produce messages and watch DLQ fill up
for i in $(seq 1 50); do
  echo "bet-${i}:PLACED amount=${i}"
done | docker exec -i broker-1 kafka-console-producer \
  --bootstrap-server localhost:9092 \
  --topic bet-events \
  --property parse.key=true \
  --property key.separator=":"

# Check DLQ
docker exec broker-1 kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic bet-events.dlq \
  --from-beginning \
  --property print.headers=true \
  --max-messages 20
```

---

## Cleanup

```bash
docker compose down -v
```
