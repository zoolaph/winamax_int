# Architecture Design 05 — Multi-AZ Failover for the Betting API

## Set the timer: 10 minutes. Close your notes.

---

## The constraints

- Betting API: 900,000 bets/day, P99 latency SLO = 200ms, availability SLO = 99.95%
- Deployed in `eu-west-3` (Paris) with 3 AZs: eu-west-3a, eu-west-3b, eu-west-3c
- The API is stateless (session state in Redis, bet state in Aurora)
- Aurora cluster: 1 writer + 2 readers, one per AZ
- Redis cluster: ElastiCache with Multi-AZ replication
- Kafka: MSK with brokers across 3 AZs
- No second region (cost constraint) — but DR plan must exist for a full region failure

**Design:**
1. How traffic is distributed across AZs normally
2. What fails if eu-west-3a goes down completely, and the recovery path
3. What the SRE observes (alerts) when an AZ failure begins
4. How Aurora failover works and what the application experiences
5. The DR plan for a full region failure (no budget for hot standby in second region)
6. What you do NOT rely on and why (DNS TTL limitations, etc.)

---

**STOP. Design it now.**

---
---
---
---
---
---

## Reference design

### Normal traffic distribution

```
Internet
    │
    ▼
Route 53
  A record: api.winamax.fr → ALB DNS (alias record)
  TTL: 60s
  Health check: polls ALB every 10s
    │
    ▼
ALB (Application Load Balancer)
  Multi-AZ: ALB nodes in eu-west-3a, eu-west-3b, eu-west-3c
  Cross-zone load balancing: ENABLED
  Listener: HTTPS 443 → target group: betting-api
    │
    ├── eu-west-3a: 3 ECS tasks (Fargate)
    ├── eu-west-3b: 3 ECS tasks (Fargate)  
    └── eu-west-3c: 3 ECS tasks (Fargate)
    
    Total: 9 tasks
    Each task: 2 vCPU, 4GB RAM
    Total capacity: ~5,400 req/sec at P99 200ms
```

Cross-zone load balancing is critical: without it, ALB routes traffic only to tasks in the same AZ as the receiving ALB node. A task imbalance across AZs causes hot spots. With cross-zone enabled, the ALB distributes evenly across all 9 tasks regardless of AZ.

### What fails when eu-west-3a goes down

**ECS tasks in eu-west-3a:** 3 tasks become unreachable. ALB health checks fail within 2-3 probe intervals (30 seconds with 10s interval, 3-failure threshold). ALB stops routing to those 3 tasks.

**Impact:** capacity drops from 9 to 6 tasks (33% reduction). At baseline traffic (1,100 req/sec) this is fine. At peak match traffic (3,000 req/sec), 6 tasks may be insufficient — ECS autoscaling must compensate.

**Aurora writer in eu-west-3a:** If the writer is in 3a, Aurora triggers automatic failover. One of the readers (3b or 3c) is promoted to writer. This takes 30-60 seconds. During this window, write operations fail.

**Aurora readers in eu-west-3a:** Read traffic that was routed to the 3a reader must be redistributed to the remaining 2 readers. Aurora's reader endpoint automatically stops routing to unhealthy readers.

**Redis in eu-west-3a:** If the primary node is in 3a, ElastiCache promotes the replica. Typically completes in under 60 seconds. During failover, writes to Redis fail or return errors.

**MSK brokers in eu-west-3a:** Partitions with leaders in 3a trigger leader re-election. ISR election completes in seconds. With RF=3 and min.insync.replicas=2, writes continue as long as 2 of the 3 brokers are healthy.

### Alert sequence during an AZ failure

```
T+0s:   AZ goes dark

T+10s:  ALB health check: 3 targets unhealthy (first probe)
T+20s:  ALB health check: 3 targets unhealthy (second probe)
T+30s:  ALB deregisters 3a tasks
         ALERT: ALB HealthyHostCount < 9 (warning threshold)
         
T+45s:  Aurora detects writer lost, begins failover
         ALERT: Aurora writer unavailable
         ALERT: betting-api error rate > 1% (write failures during failover)
         
T+75s:  Aurora failover completes (new writer in 3b)
         Errors stop. Write latency spike resolves.
         
T+90s:  ECS autoscaling: detects reduced capacity, adds tasks to 3b and 3c
         ALERT resolves: HealthyHostCount recovers to 6 (then 9 after scale-out)
         
T+120s: ElastiCache failover completes (if primary was in 3a)
         Redis read/write errors stop
```

Alerting setup:
```
CRITICAL: ALB HealthyHostCount < 6 for 1 minute (more than one AZ's worth gone)
WARNING:  ALB HealthyHostCount < 9 for 2 minutes (any AZ degradation)
CRITICAL: Aurora FreeableMemory = 0 OR Connections spike (failover indicator)
CRITICAL: betting-api error_rate > 1% for 2 minutes
```

### Aurora failover — what the application experiences

Aurora uses a cluster endpoint (`aurora-cluster.cluster-xxx.eu-west-3.rds.amazonaws.com`). This endpoint's DNS record is updated during failover to point to the new writer. The application connection pool holds connections to the old writer's IP.

What happens:
1. Old writer becomes read-only or unreachable
2. Application's existing connections start returning errors (`read-only transaction` or connection reset)
3. The application's connection pool must detect these failures and reconnect
4. DNS propagation: the cluster endpoint DNS TTL is typically 5 seconds (Aurora-managed, not configurable)
5. After reconnection, the application reaches the new writer

The application must handle this gracefully:
- Connection pool must retry on connection errors (not just fail immediately)
- Write retries must be idempotent (the failed write may or may not have committed)
- Health check endpoint should not fail if a single write fails — it should retry

In practice: 30-60 second window of elevated write errors during Aurora failover. After failover, full write throughput resumes. This is the expected behavior for a 99.95% SLO — a 60-second outage every few months is within budget.

### DR plan for a full eu-west-3 region failure

**Reality:** a full AWS region failure is extremely rare and typically lasts hours. The question is: what is your recovery plan?

**Approach: warm standby with manual activation (not hot standby)**

Hot standby (fully provisioned second region always running) is expensive at Winamax's scale. Warm standby means infrastructure defined in Terraform for `eu-west-1` (Ireland) but not running at full capacity — enough to validate it works, not enough to absorb full traffic.

```
Normal state:
  eu-west-3 (Paris):   Active, full capacity
  eu-west-1 (Ireland): Warm standby
    - ECS service: desired_count = 1 (health check only)
    - Aurora: cross-region read replica (receives all writes from Paris writer via replication)
    - MSK: standby cluster with cross-region topic mirroring via MirrorMaker 2
    - ECR: images replicated via cross-region replication rule

Region failure activation (manual, ~30 minutes):
  1. Promote Aurora Ireland read replica to standalone cluster (5 min)
  2. Update ECS desired_count to full capacity (5 min)
  3. Update Route 53 records to point to Ireland ALB (DNS TTL: 60s propagation)
  4. Verify smoke tests against Ireland endpoint
  5. Update DNS via Route 53 failover routing (health check on Paris, failback when Paris recovers)
```

**What you do NOT rely on:**

- **Route 53 automatic failover for full availability:** Route 53 TTL is 60 seconds. Even after Route 53 switches to the secondary record, resolvers that have cached the primary record continue sending traffic to Paris for up to 60 seconds. For payment-critical traffic, this 60-second window matters.

- **Aurora automatic cross-region failover:** AWS does not automatically promote a cross-region read replica. Promotion is manual. Plan for this.

- **"It'll never happen":** Full region failures are rare but real. The 30-minute RTO must be tested at least twice a year via a DR drill.

### Summary: what makes this design solid

| Layer | Mechanism | RTO |
|-------|-----------|-----|
| Single task failure | ECS restarts + ALB health check | < 60s |
| Single AZ failure | ALB cross-zone, ECS autoscaling, Aurora failover | 60-90s |
| Full region failure | Warm standby promotion, Route 53 update | ~30 min (manual) |
| Data durability | Aurora Multi-AZ, cross-region replica | RPO < 5 min |
