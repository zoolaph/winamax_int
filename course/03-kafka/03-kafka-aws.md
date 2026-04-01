# Kafka on AWS — MSK vs Self-Managed

## The options

1. **Amazon MSK (Managed Streaming for Apache Kafka)** — AWS-managed Kafka brokers
2. **MSK Serverless** — capacity-managed MSK, auto-scales, pay per throughput
3. **Self-managed Kafka on EC2** — you provision and operate brokers yourself
4. **Amazon Kinesis** — not Kafka, but sometimes compared; different model entirely

---

## What MSK manages (and what it does not)

### MSK handles:
- Broker provisioning (EC2 instance selection, placement across AZs)
- Broker OS patching and JVM updates
- Kafka version upgrades (with managed rolling restart)
- ZooKeeper provisioning and management (or KRaft in newer versions)
- Multi-AZ replication at the broker level
- CloudWatch metrics integration
- IAM-based authentication (MSK IAM)
- VPC placement and security groups
- Storage auto-expansion (with EBS)

### MSK does NOT handle:
- Topic creation, partition count, replication factor
- Consumer group configuration
- Schema registry (you bring your own: Confluent Schema Registry or Glue Schema Registry)
- Kafka Connect (MSK Connect is a separate service, covers this)
- Consumer lag monitoring (you bring kafka-exporter or use CloudWatch custom metrics)
- ACL configuration (topic-level permissions)
- Performance tuning (`log.segment.bytes`, `log.retention.ms`, etc.)
- Your application code (obviously)

**The key insight:** MSK removes infrastructure operations. It does not remove Kafka operations. An engineer who only knows how to click through the AWS console cannot operate a Kafka cluster on MSK any more than they could on EC2.

---

## MSK configuration — what you still need to know

### Broker type selection

| Type | vCPU | RAM | Network | Use case |
|---|---|---|---|---|
| `kafka.t3.small` | 2 | 2 GB | Up to 5 Gbps | Dev/test only |
| `kafka.m5.large` | 2 | 8 GB | Up to 10 Gbps | Small production |
| `kafka.m5.4xlarge` | 16 | 64 GB | Up to 25 Gbps | Heavy production |
| `kafka.m5.24xlarge` | 96 | 384 GB | 25 Gbps dedicated | Extreme throughput |

For 75,000 msg/sec: assume ~1 KB average message = 75 MB/sec. With replication factor 3, each broker handles ~225 MB/sec of combined producer + replication traffic. `m5.4xlarge` to `m5.8xlarge` range is typical.

### Storage

MSK uses EBS (gp3) per broker. Size it based on: `retention_days × throughput_per_day × replication_factor`. Storage auto-expansion can be enabled, but it is not instant — provision headroom upfront.

### Networking

MSK brokers run inside your VPC across multiple AZs (2 or 3). Consumers and producers must be in the same VPC or use VPC peering/Transit Gateway. Public access is available but not recommended for financial data.

---

## MSK IAM authentication

MSK supports several authentication mechanisms:

| Method | Use case |
|---|---|
| **IAM** | AWS-native, no certificate management, works with ECS task roles |
| **SASL/SCRAM** | Username/password, stored in Secrets Manager |
| **TLS mutual auth** | Certificate-based, high operational overhead |
| **Unauthenticated** | Dev/test only, never production |

MSK IAM is the recommended choice for ECS workloads — ECS tasks already have IAM roles, so Kafka auth uses the same identity system.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kafka-cluster:Connect",
        "kafka-cluster:DescribeGroup",
        "kafka-cluster:AlterGroup",
        "kafka-cluster:ReadData",
        "kafka-cluster:WriteData",
        "kafka-cluster:DescribeTopic"
      ],
      "Resource": [
        "arn:aws:kafka:eu-west-1:123456789:cluster/winamax-kafka/*",
        "arn:aws:kafka:eu-west-1:123456789:topic/winamax-kafka/*/bet-placed",
        "arn:aws:kafka:eu-west-1:123456789:group/winamax-kafka/*/fraud-detection-*"
      ]
    }
  ]
}
```

---

## Self-managed Kafka on EC2 — when it makes sense

### Reasons to self-manage

1. **Kafka version ahead of MSK support** — MSK lags Kafka releases by weeks to months. If you need a feature in Kafka 3.6 and MSK only supports 3.5, you self-manage.
2. **Specific broker tuning** — MSK exposes a subset of Kafka configuration. Some advanced tuning (specific `socket.send.buffer.bytes`, non-standard `log.flush.interval.ms`) requires direct broker access.
3. **Cost at extreme scale** — EC2 spot instances + local NVMe SSD can be cheaper than MSK EBS at very high throughput, but requires engineering work to achieve reliability.
4. **Non-AWS cloud or on-premises** — MSK is AWS-only.

### Reasons to use MSK

1. **Reduced operational burden** — no broker OS patching, no Kafka upgrade runbooks, no broker failure recovery automation needed.
2. **Faster to production** — VPC integration, CloudWatch, IAM auth out of the box.
3. **Multi-AZ by default** — MSK places brokers in different AZs automatically.
4. **AWS Support** — if something goes wrong with the brokers themselves, AWS support has access to the underlying infrastructure.

### Self-managed operational responsibilities

If you choose self-managed, you own:
- Broker EC2 instance provisioning (Terraform/Ansible)
- Disk management (NVMe recommended for write-heavy workloads)
- JVM tuning (GC, heap sizing — G1GC recommended)
- ZooKeeper or KRaft ensemble (if ZooKeeper mode)
- Rolling broker restarts for upgrades
- Broker failure detection and recovery
- Capacity planning and scaling

---

## MSK Serverless — when it makes sense

MSK Serverless auto-scales capacity and charges per-throughput:
- No broker sizing decisions
- Scales to 200 MB/sec throughput automatically
- Pay: ~$0.10/GB ingested + $0.05/GB stored

**Limitations:**
- Higher per-GB cost at sustained high throughput vs provisioned MSK
- Less control over partition placement and replication
- Limited configuration options

**Use case:** Variable workloads, dev/staging environments, or services with unpredictable growth where you do not want to manage broker sizing.

---

## The practical Winamax decision

Winamax's public architecture references mention self-hosting their observability stack. For Kafka at 75k msg/sec in production, they likely run either provisioned MSK or self-managed on EC2 — the throughput is high enough that MSK Serverless per-unit costs would be significant, and the engineering team clearly has the operational depth to manage it.

In an interview context: if asked "MSK or self-managed," the correct answer is not a preference — it is a trade-off:

> "MSK is the right default: it removes broker operations and lets the team focus on Kafka operations, which is still significant work. Self-managed is justified if you need a Kafka version ahead of MSK support, need specific broker tuning MSK doesn't expose, or your throughput is high enough that the cost math favors EC2 + NVMe over EBS-backed MSK. The operational cost of self-managed is real — rolling restarts, broker failure handling, OS patching. You are trading infrastructure work for flexibility and cost."
