# ECS Autoscaling — Deep Operational Knowledge

**Audience:** Senior engineer with strong Kubernetes/HPA background  
**Goal:** Answer any follow-up in a Winamax SRE interview with operational depth  
**Context:** Winamax runs 700+ microservices on ECS, 75k Kafka msg/sec, 900k bets/day. Champions League finals cause 10x traffic spikes in minutes.

---

## 1. The Two Levels of Autoscaling — Get This Right First

This is the most important concept. There are **two completely independent scaling systems** that must be coordinated. Confusing them or thinking there is only one is the most common ECS interview mistake.

```
LEVEL 1: ECS Service Auto Scaling
  Scales the number of TASKS (containers) running in a service.
  Analogous to: Kubernetes HPA

LEVEL 2: EC2 ASG + Cluster Auto Scaling (CAS)
  Scales the number of EC2 INSTANCES in the ECS cluster.
  Analogous to: Kubernetes Cluster Autoscaler
```

### The Dependency

Tasks run on EC2 instances. If you scale tasks but have no EC2 capacity to place them on, the tasks sit in PENDING state and never start. You get no additional throughput. The alarm that triggered the scale-out is still firing. You are now in a degraded state waiting for EC2 capacity that may never come unless CAS is also configured.

```
                        ┌─────────────────────────────┐
                        │         ECS CLUSTER          │
                        │                              │
  Task count  ──────►   │  [Task] [Task] [Task] [???]  │
  (HPA equiv)           │                              │
                        │   EC2        EC2             │
  Instance count ──►    │  [i3.xl]    [i3.xl]          │
  (CA equiv)            │                              │
                        └─────────────────────────────┘

Scenario: Service scaled from 4 tasks to 8 tasks.
  EC2 instances have capacity for 6 tasks.
  Tasks 7 and 8 → PENDING. Traffic still overloading tasks 1-6.
  CAS must detect PENDING tasks → signal ASG → launch EC2 → register → place tasks.
  This takes 2-5 minutes. Your users are suffering for those 2-5 minutes.
```

### Concrete Winamax Example

A Champions League final kicks off. Bet volume spikes from 75k to 750k msg/sec on the betting service. ECS Service Auto Scaling fires immediately and tries to go from 10 tasks to 50 tasks. But the cluster only has enough EC2 capacity for 30 tasks. Tasks 31-50 sit PENDING. CAS detects the PENDING tasks, signals the ASG, new instances are launching — but EC2 bootstrap takes 2-4 minutes. For those minutes you are operating at 60% of needed capacity during peak load. This is why pre-scaling exists (covered in section 7).

### K8s Mental Model

| Kubernetes | ECS Equivalent |
|---|---|
| HPA (Horizontal Pod Autoscaler) | ECS Service Auto Scaling |
| Pod | ECS Task |
| Node | EC2 Instance |
| Cluster Autoscaler | CAS + EC2 ASG |
| Node pool / node group | Capacity Provider + ASG |

The key operational discipline is identical: **scale the workload layer AND the infrastructure layer, and make the infrastructure layer scale faster or pre-emptively.**

---

## 2. ECS Service Auto Scaling — The Three Policies

ECS Service Auto Scaling is built on **Application Auto Scaling** (the same AWS service used by DynamoDB, Aurora Serverless, etc.). You register an ECS service as a scalable target, then attach policies.

### 2a. Target Tracking

The simplest and most common policy. You say: "Keep metric X at value Y. AWS handles the rest."

**How the math works:**

AWS CloudWatch continuously measures the metric. When the current value exceeds the target, Application Auto Scaling calculates:

```
desired_tasks = ceil(current_tasks × (current_metric_value / target_value))

Example:
  current_tasks = 10
  target = 60% CPU
  current CPU = 90%
  desired = ceil(10 × (90 / 60)) = ceil(15) = 15 tasks
```

This calculation happens every 1 minute. It is greedy — it tries to reach the target in one step, not gradually.

**Built-in metrics (no custom metric publishing needed):**

- `ECSServiceAverageCPUUtilization` — average CPU across all tasks in the service
- `ECSServiceAverageMemoryUtilization` — average memory across all tasks
- `ALBRequestCountPerTarget` — requests per task from an ALB target group (requires ALB integration)

**Scale-out vs scale-in cooldowns:**

```
scaleOutCooldown: 60 seconds  (default)
scaleInCooldown: 300 seconds  (default)

During cooldown, no new scaling action fires in that direction.
Scale-out cooldown is short because you need to respond to load fast.
Scale-in cooldown is long because premature scale-in causes thrashing.
```

**When target tracking fails you:**

Target tracking on CPU is wrong for Kafka consumers. Here is the failure mode:

1. Kafka producer publishes at 75k msg/sec. Consumer is processing at 70k msg/sec. Lag is growing at 5k msg/sec.
2. Consumer tasks are doing mostly IO wait (polling Kafka, writing to DB). CPU is at 15%.
3. Target tracking on CPU target 60% sees CPU at 15% → it wants to SCALE IN, removing tasks.
4. Lag continues to grow. Service falls further behind. CPU stays low. You have just made the problem worse.

The correct signal is consumer group lag (covered in section 6).

### 2b. Step Scaling

Step scaling gives you explicit control over what happens at each alarm threshold. You define CloudWatch alarms and specify exactly how many tasks to add or remove when each alarm fires.

**Structure:**

```
Alarm: CPUUtilization > 70% for 2 consecutive minutes
  Step 1: If breach is 0-20% above threshold (70-90%) → add 2 tasks
  Step 2: If breach is 20-40% above threshold (90-110%) → add 5 tasks
  Step 3: If breach is >40% above threshold (>110%) → add 10 tasks
```

The "breach" is calculated relative to the alarm threshold. This is called a **step adjustment with metric interval lower/upper bound**.

**The dead band concept:**

You set separate alarms for scale-out and scale-in with a gap between them (the dead band). This prevents oscillation.

```
Scale-out alarm: CPU > 70%
Scale-in alarm:  CPU < 40%

Dead band: 40-70% — no action fires in this range.

Without a dead band:
  CPU hits 71% → add tasks → CPU drops to 68% → remove tasks → CPU hits 72% → thrash
```

**When to use step scaling over target tracking:**

- When you need asymmetric responses (add 10 tasks on severe breach, remove 1 task at a time on scale-in)
- When the metric relationship to load is non-linear
- When you need precise control for a service with expensive cold-start (adding too few tasks on step 1, adding many on severe breach)
- When you need a dead band that target tracking does not provide

For Winamax's betting service during Champions League, step scaling lets you say: "If we are more than 2x over target, add 20 tasks at once instead of ramping up gradually."

### 2c. Scheduled Scaling

You override the `minCapacity` and/or `maxCapacity` of the scalable target on a cron schedule.

**How it interacts with target tracking:**

This is the key operational insight. Scheduled scaling does not directly set the desired count. It sets the **floor** (`minCapacity`). Target tracking still operates, but it cannot scale below the floor.

```
Normal operation:
  min=2, max=50, target tracking running, desired=8

30 minutes before Champions League kickoff:
  Scheduled action fires: min=30, max=100
  Application Auto Scaling: desired is 8, min is now 30 → immediately schedules 30 tasks
  Target tracking continues: can now scale between 30 and 100 based on actual load

Post-match wind-down (2 hours later):
  Scheduled action fires: min=2, max=50
  Target tracking scales down gradually (respecting scaleInCooldown)
```

**Cron syntax in AWS Scheduled Actions:**

AWS uses a 6-field cron format (unlike the standard 5-field Unix cron):

```
cron(Minutes Hours Day-of-month Month Day-of-week Year)

Pre-scale for a Wednesday 9pm CET match (8pm UTC):
  cron(30 19 * * 4 *)   # 7:30pm UTC every Thursday (pre-scale 30 min before)

Note: AWS cron is always in UTC. Always convert.
```

---

## 3. Scale-Out is Fast, Scale-In is Slow — Why This Is Correct

This is deliberate design, not a limitation. Getting this question wrong signals you do not understand operational safety.

### Scale-Out Urgency

When load increases, users are immediately affected. Every second you are under-provisioned is a second of degraded experience. Scale out as fast as CloudWatch alarms allow (minimum 1-minute granularity for ECS metrics, 3-minute for custom metrics if published at that frequency).

**Recommended scaleOutCooldown:** 60 seconds. Sometimes 30 seconds for critical services.

### Scale-In Conservatism

When load decreases, the risk of scaling in too aggressively is:

1. **Thrashing:** Load bounces. You remove tasks. Load spikes again. You add tasks. Repeat. Each scale-out event has startup latency (task pull from ECR, container init, ALB registration, health check pass). During each cycle users see errors.

2. **Thundering herd on remaining tasks:** If you remove 10 tasks at once, the remaining tasks absorb the load of those 10 until new tasks can register. If the remaining tasks are already at 60% CPU, absorbing an additional 30% may push them to 90% and trigger another scale-out.

3. **ALB connection draining:** When a task is deregistered from an ALB target group, in-flight requests must complete. Aggressive scale-in cuts this short.

**Recommended scaleInCooldown:** 300 seconds (5 minutes) minimum. For stateful or slow-to-start services, consider 600 seconds.

### Scale-In Protection on Individual Tasks

ECS allows you to mark an individual task as **protected from scale-in**. The task will not be terminated by an automatic scale-in action.

Use case: A Kafka consumer task is in the middle of a large batch commit. You do not want it terminated mid-commit, which would cause re-processing. The task sets its own scale-in protection via the ECS API at the start of a long operation, then removes it when done.

```bash
# Task sets its own protection (called from within the task)
aws ecs update-task-protection \
  --cluster my-cluster \
  --tasks <task-arn> \
  --protection-enabled \
  --expires-in-minutes 10
```

This is the ECS equivalent of a Kubernetes PodDisruptionBudget applied at the individual pod level.

---

## 4. Capacity Providers and Cluster Auto Scaling (CAS)

Capacity Providers are how you link ECS task scheduling to EC2 ASG scaling. Without Capacity Providers, you are managing the EC2 layer manually or with a separate mechanism.

### Architecture

```
                ┌──────────────────────────────────────────┐
                │           ECS Service                     │
                │  Desired tasks: 50  Running tasks: 30     │
                │  PENDING tasks: 20  (no EC2 capacity)     │
                └───────────────┬──────────────────────────┘
                                │ ECS detects PENDING
                                ▼
                ┌──────────────────────────────────────────┐
                │        Capacity Provider                  │
                │  Managed Scaling: ENABLED                 │
                │  Target Capacity: 80%                     │
                └───────────────┬──────────────────────────┘
                                │ Signals needed instances
                                ▼
                ┌──────────────────────────────────────────┐
                │           EC2 Auto Scaling Group          │
                │  current: 15 instances                    │
                │  target: 20 instances (CAS calculated)    │
                └───────────────┬──────────────────────────┘
                                │ Launches 5 new instances
                                ▼
                ┌──────────────────────────────────────────┐
                │  New EC2 instance lifecycle               │
                │  Launch → Bootstrap → ECS agent starts    │
                │  → Registers with cluster → Available     │
                │  Time: 2-5 minutes                        │
                └───────────────┬──────────────────────────┘
                                │ PENDING tasks now placed
                                ▼
                ┌──────────────────────────────────────────┐
                │  Tasks 31-50 placed and starting          │
                │  Container pull from ECR: 15-60s          │
                │  Health check pass: 30s                   │
                │  ALB registration: 10s                    │
                └──────────────────────────────────────────┘
```

Total time from PENDING to traffic-serving: **3-8 minutes in a real system.**

### target_capacity Explained

`target_capacity` is the percentage of EC2 capacity that CAS aims to fill before scaling out the ASG.

```
target_capacity = 80%

If tasks are consuming 80% of available EC2 compute resources,
CAS considers the cluster "full" and will scale out the ASG
to maintain headroom.

At 100%: No headroom. Any new task goes PENDING. Extremely risky.
At 50%:  Always 50% spare capacity. Safe but expensive.
At 80%:  10-20% headroom. Reasonable default for most services.
```

For Winamax's spike-prone workload, consider 70% or lower on the betting service cluster. The 20-30% headroom means that a sudden 20-30% task scale-out can be placed immediately on existing EC2 without waiting for new instances.

### Managed Scaling vs Manual

With `managed_scaling = ENABLED`:
- CAS watches for PENDING tasks and reservation metrics
- CAS sends scale-out signals to the ASG automatically
- CAS sends scale-in signals when EC2 utilization drops (with termination protection for running tasks)

With `managed_scaling = DISABLED`:
- You must scale the ASG yourself (via separate CloudWatch alarms or scheduled actions)
- The decoupling can be useful if you want tight control, but is operationally harder to maintain

**Recommendation for Winamax:** Enable managed scaling, set target_capacity to 70-75%, and layer scheduled scaling pre-events on top.

---

## 5. Fargate Autoscaling — When to Use It

Fargate removes the EC2 layer entirely. You have no instances to manage. ECS Service Auto Scaling still applies (scaling task count), but there is no CAS or EC2 ASG.

```
Fargate:
  ECS Service Auto Scaling → scale tasks → AWS provisions compute → task starts
  You pay per vCPU-second and GB-second of task runtime.

EC2-backed:
  ECS Service Auto Scaling → scale tasks → may need EC2 capacity → CAS → ASG → wait
  You pay for EC2 instances even when tasks are not using them.
```

### Fargate Cold Start Latency

Even without EC2 bootstrap time, Fargate has latency:

- Fargate compute allocation: 5-30 seconds
- Container image pull from ECR: depends on image size (15s for a small image, 90s for a large one)
- Application startup: whatever your app takes
- ALB health check pass: 30s typical

Total: **1-3 minutes** for a Fargate task to serve traffic. Better than EC2-backed (2-5 min), but still significant during a live spike.

### When Fargate is Acceptable

- Services with gradual, predictable load (Fargate can scale out ahead of demand if you have a few minutes of runway)
- Batch jobs, async consumers where startup latency does not directly affect user experience
- Low-traffic services where EC2 overhead is not worth it
- Services with infrequent but unpredictable load (Fargate's per-second billing is more economical at low utilization)

### When EC2-Backed is Needed

- Latency-sensitive services that cannot tolerate 2+ minutes of scale-out lag
- Services requiring specific instance types (GPU, high memory, specific network performance)
- High-density workloads where EC2 per-task overhead matters economically
- Services requiring EBS volumes or specific Linux kernel capabilities

For Winamax, the betting API and Kafka consumers are likely EC2-backed with pre-scaling. Background analytics, reporting jobs, and low-traffic internal services are Fargate candidates.

---

## 6. Custom Metrics Scaling — Kafka Consumer Lag

This is the operationally correct pattern for any Kafka consumer service. It is a strong differentiator to discuss in an interview.

### Why CPU Fails for Kafka Consumers

```
Scenario: 75k msg/sec ingress, consumer processing at 60k msg/sec.
  Lag growing at 15k msg/sec.
  Tasks are blocked on I/O (network read from Kafka broker, DB writes).
  CPU utilization: 12%.
  
  Target tracking on CPU (target: 60%):
    12% < 60% → wants to scale IN → makes the problem worse.
  
  Correct signal: lag = 450,000 messages (30 seconds × 15,000/sec)
  Target tracking on lag (target: 10,000 messages per task):
    actual lag per task = 450,000 / 8 tasks = 56,250
    desired tasks = ceil(8 × (56,250 / 10,000)) = ceil(45) = 45 tasks
    Scale from 8 to 45 tasks.
```

### Publishing Consumer Lag to CloudWatch

Kafka does not natively push metrics to CloudWatch. You need a bridge:

**Option 1: Prometheus → CloudWatch Exporter**
Deploy a Kafka exporter (e.g., `danielqsj/kafka-exporter`) that exposes `kafka_consumer_group_lag` as a Prometheus metric. Use a CloudWatch agent or `amazon-cloudwatch-agent` to push it as a custom metric.

**Option 2: Custom Lambda/sidecar publisher**
A Lambda function (or sidecar container) that:
1. Calls `kafka-consumer-groups.sh --describe` or uses the AdminClient API to get lag
2. Publishes to CloudWatch via `aws cloudwatch put-metric-data`

```python
# Lambda publishing consumer lag to CloudWatch
import boto3
from kafka.admin import KafkaAdminClient

def publish_consumer_lag(consumer_group, topic, bootstrap_servers):
    admin = KafkaAdminClient(bootstrap_servers=bootstrap_servers)
    offsets = admin.list_consumer_group_offsets(consumer_group)
    
    # Calculate total lag across all partitions
    total_lag = sum(
        partition_offset.offset - consumer_offset.offset
        for tp, consumer_offset in offsets.items()
        for partition_offset in [admin.list_offsets({tp: OffsetSpec.latest()})[tp]]
    )
    
    cw = boto3.client('cloudwatch')
    cw.put_metric_data(
        Namespace='Winamax/Kafka',
        MetricData=[{
            'MetricName': 'ConsumerGroupLag',
            'Dimensions': [
                {'Name': 'ConsumerGroup', 'Value': consumer_group},
                {'Name': 'Topic', 'Value': topic},
            ],
            'Value': total_lag,
            'Unit': 'Count'
        }]
    )
```

**Publish frequency:** Every 60 seconds. CloudWatch high-resolution custom metrics support 1-second granularity at extra cost, but 60-second is sufficient for autoscaling decisions (alarms evaluate on 1-3 data points).

### Target Tracking Policy on Custom Metric

```
Metric: Winamax/Kafka ConsumerGroupLag (per consumer group)
Target: lag_per_task = total_lag / running_tasks

For target tracking, you cannot use "per task" metrics directly unless
you publish the per-task average. Alternatively:

Option A: Publish total lag, set target to (acceptable_lag × current_tasks)
  This breaks as task count changes — not recommended.

Option B: Publish lag per task (total_lag / running_tasks) as a separate metric.
  Target tracking works correctly on this.

Option C: Use step scaling on total lag thresholds.
  More control, simpler metric.
```

The cleanest production pattern: publish `lag_per_task` as a custom metric, use target tracking with a target of 10,000-50,000 messages per task depending on your processing speed.

---

## 7. Pre-Scaling Patterns for Winamax

### The Problem

Champions League final. Kickoff is 21:00 CET. Winamax knows from historical data:
- 30 minutes before kickoff: 3x normal bet volume
- Kickoff + 5 minutes: 10x normal bet volume
- Match end: volume drops to 2x over 30 minutes

The reactive autoscaling loop is too slow:
1. Volume spikes → metric exceeds threshold → alarm fires (1-3 min)
2. Scale-out action executes → tasks go PENDING (30-60s)
3. CAS detects PENDING → signals ASG → EC2 launches (2-4 min)
4. Instance registers → tasks placed → containers start (1-2 min)
5. Health checks pass → ALB routes traffic (30-60s)

**Total reactive lag: 5-10 minutes.** During a Champions League spike, 5-10 minutes of degraded service is unacceptable.

### Calculating the Pre-Scale Target

```
Historical peak for previous Champions League final:
  Normal baseline: 100 tasks on betting-api service
  Peak observed:   820 tasks (8.2x)

Pre-scale calculation:
  Pre-scale target = historical_peak × headroom_multiplier
  Pre-scale target = 820 × 1.25 = 1025 tasks

Set scheduled action:
  20:30 CET (30 min before kickoff): min=1000, max=1500
  23:30 CET (after match winds down): min=100, max=500

Target tracking still runs. If actual peak is 600 tasks, 
  target tracking does NOT scale in below min=1000 during the event window.
  After the scheduled min drops to 100, target tracking scales in gradually.
```

### The SRE Trade-Off

**Over-provisioning risk:** Running 1000 tasks when peak hits 600 means 400 idle tasks for ~2 hours. At Fargate prices, this is quantifiable cost. For EC2-backed, the instances are pre-warmed so the cost is in reserved/on-demand EC2 hours.

**Under-provisioning risk:** User-facing errors during the highest-revenue moment of the week. 900k bets/day concentrated into 90 minutes means each minute of degradation is ~10k bets. Lost revenue is orders of magnitude more than the cost of idle EC2 for 2 hours.

**Framing for the interview:** "We use historical data plus a 25% buffer as a starting point. We then review post-match: if we were at 40% utilization during peak, we over-provisioned and can reduce the buffer next time. If we hit 90%+ and had PENDING tasks, we increase it. This is an iterative process anchored in data, not guesswork."

### Automated Pre-Scaling via EventBridge

For recurring events (weekly Champions League matches during the season), use EventBridge scheduled rules to trigger a Lambda that sets scheduled scaling actions dynamically based on the match calendar.

```
EventBridge Rule → Lambda → aws application-autoscaling put-scheduled-action
```

This is more robust than static cron-based scheduled actions because the match schedule changes week-to-week.

---

## 8. What Autoscaling Does NOT Protect You From

Knowing the failure modes of the tool is what separates an SRE from a DevOps engineer.

### Database Connection Exhaustion

ECS scales from 20 to 200 tasks. Each task opens a DB connection pool of 10 connections. You now have 2000 connections to Aurora. Aurora max_connections for a db.r6g.4xlarge is ~1700. New connections are refused. Tasks start failing health checks. ALB removes them. You have just caused a cascading failure at the worst possible moment.

**Mitigations:**
- RDS Proxy sits in front of Aurora, pools connections, presents a stable connection count to the database
- Set max_connections on the pool in each task to a calculated safe value: `floor(aurora_max_connections * 0.8 / max_expected_tasks)`
- Monitor `DatabaseConnections` CloudWatch metric and alert before the limit is hit, not after

### Downstream Service Rate Limits

Your service scales to handle 10x load. The third-party payment provider you call has a rate limit of 500 req/sec per API key. You now have 500 tasks each sending 5 req/sec = 2500 req/sec. You get 429s. Your retry logic makes it worse.

**Mitigation:** Client-side rate limiting using a shared token bucket (Redis-backed), circuit breakers, and coordinated backoff that does not scale with task count.

### Kafka Consumer Group Rebalancing Storms

This is critical for Winamax's Kafka usage. When ECS scales out your consumer service from 10 to 50 tasks rapidly:

1. 40 new consumer instances join the consumer group
2. Kafka triggers a group rebalance: ALL consumers (all 50) stop consuming during rebalance
3. Rebalance completes, partitions are redistributed
4. If tasks are still starting up while rebalance is in progress, another rebalance triggers
5. If any task fails its health check mid-rebalance and terminates, another rebalance

During a full rebalance of 50 consumers, consumption stops for 10-60 seconds. At 75k msg/sec, that is 750k-4.5M messages backed up in 10-60 seconds.

**Mitigations:**
- Use Kafka's **incremental cooperative rebalancing** (`CooperativeStickyAssignor`) instead of eager rebalancing. Only partitions that need to move are revoked; other consumers continue processing.
- Scale out gradually (step scaling, not +40 at once) to space out the join events
- Use Kafka's `group.initial.rebalance.delay.ms` to batch join events within a window
- Monitor rebalance frequency as a metric; alert on elevated rebalance rates

### ALB Target Group Registration Lag

When a new task starts, it registers with the ALB target group and begins health checks. The ALB will not route traffic to it until health checks pass. If your health check is:

```
interval: 30s
threshold: 3 healthy checks required
```

A new task takes at minimum 90 seconds before it receives traffic. During scale-out, you have tasks running but not serving traffic for 90 seconds. This is why scale-out does not linearly add capacity immediately.

**Mitigation:** Tune health check interval down (10s) and healthy threshold to 2 for non-critical services. Or use fast health check paths that respond in <100ms and do not depend on downstream services.

### Memory Leaks and Task Bloat Under Load

At baseline, each task uses 512MB. Under 10x load with connection pools filled and large request objects, actual memory use is 900MB. You have sized your EC2 instances to pack 8 tasks per instance at 512MB each. Under load, task placement fails because there is not enough memory per instance even though CPU is available.

**Mitigation:** Load test at peak concurrency. Measure actual memory under realistic load. Size task memory reservations with a 40% buffer. Monitor `MemoryUtilized` (actual) vs `MemoryReserved` (configured limit).

---

## 9. Terraform for All Three Policy Types

### Scalable Target (required first)

```hcl
resource "aws_appautoscaling_target" "betting_api" {
  max_capacity       = 500
  min_capacity       = 10
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.betting_api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}
```

### Target Tracking Policy

```hcl
resource "aws_appautoscaling_policy" "betting_api_cpu" {
  name               = "betting-api-cpu-target-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.betting_api.resource_id
  scalable_dimension = aws_appautoscaling_target.betting_api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.betting_api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    # Disable scale-in if you want to manage scale-in only via scheduled actions
    # disable_scale_in = true
  }
}

# Custom metric target tracking (Kafka consumer lag per task)
resource "aws_appautoscaling_policy" "kafka_consumer_lag" {
  name               = "kafka-consumer-lag-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.kafka_consumer.resource_id
  scalable_dimension = aws_appautoscaling_target.kafka_consumer.scalable_dimension
  service_namespace  = aws_appautoscaling_target.kafka_consumer.service_namespace

  target_tracking_scaling_policy_configuration {
    customized_metric_specification {
      metric_name = "ConsumerGroupLagPerTask"
      namespace   = "Winamax/Kafka"
      statistic   = "Average"
      unit        = "Count"
      dimensions {
        name  = "ConsumerGroup"
        value = "betting-events-consumer"
      }
    }
    target_value       = 10000.0  # 10k messages lag per task
    scale_in_cooldown  = 600      # aggressive cooldown for consumers
    scale_out_cooldown = 60
  }
}
```

### Step Scaling Policy

```hcl
# CloudWatch alarm that triggers step scaling
resource "aws_cloudwatch_metric_alarm" "betting_api_high_cpu" {
  alarm_name          = "betting-api-high-cpu"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 70.0
  alarm_description   = "Trigger step scale-out for betting API"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.betting_api.name
  }

  alarm_actions = [aws_appautoscaling_policy.betting_api_step_out.arn]
}

resource "aws_appautoscaling_policy" "betting_api_step_out" {
  name               = "betting-api-step-scale-out"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.betting_api.resource_id
  scalable_dimension = aws_appautoscaling_target.betting_api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.betting_api.service_namespace

  step_scaling_policy_configuration {
    adjustment_type          = "ChangeInCapacity"
    cooldown                 = 60
    metric_aggregation_type  = "Average"

    # 70-90% CPU: add 5 tasks
    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = 20
      scaling_adjustment          = 5
    }

    # 90-110% CPU: add 15 tasks
    step_adjustment {
      metric_interval_lower_bound = 20
      metric_interval_upper_bound = 40
      scaling_adjustment          = 15
    }

    # >110% CPU: add 40 tasks (Champions League emergency)
    step_adjustment {
      metric_interval_lower_bound = 40
      scaling_adjustment          = 40
    }
  }
}

# Scale-in alarm (dead band: scale-in at <40%, scale-out at >70%)
resource "aws_cloudwatch_metric_alarm" "betting_api_low_cpu" {
  alarm_name          = "betting-api-low-cpu"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 5  # more conservative for scale-in
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 40.0

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.betting_api.name
  }

  alarm_actions = [aws_appautoscaling_policy.betting_api_step_in.arn]
}

resource "aws_appautoscaling_policy" "betting_api_step_in" {
  name               = "betting-api-step-scale-in"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.betting_api.resource_id
  scalable_dimension = aws_appautoscaling_target.betting_api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.betting_api.service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 300  # 5-minute cooldown on scale-in
    metric_aggregation_type = "Average"

    # Remove 2 tasks at a time to avoid thundering herd on remaining tasks
    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -2
    }
  }
}
```

### Scheduled Scaling for Champions League

```hcl
# Pre-scale 30 minutes before Champions League kickoffs
# Wednesday matches at 21:00 CET = 20:00 UTC
resource "aws_appautoscaling_scheduled_action" "champions_league_prescale" {
  name               = "champions-league-prescale"
  resource_id        = aws_appautoscaling_target.betting_api.resource_id
  scalable_dimension = aws_appautoscaling_target.betting_api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.betting_api.service_namespace

  # 7:30 PM UTC every Wednesday
  schedule = "cron(30 19 ? * 4 *)"

  scalable_target_action {
    min_capacity = 300
    max_capacity = 1000
  }
}

# Return to normal after match ends (~23:00 CET = 22:00 UTC + buffer)
resource "aws_appautoscaling_scheduled_action" "champions_league_wind_down" {
  name               = "champions-league-wind-down"
  resource_id        = aws_appautoscaling_target.betting_api.resource_id
  scalable_dimension = aws_appautoscaling_target.betting_api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.betting_api.service_namespace

  # 11:30 PM UTC every Wednesday
  schedule = "cron(30 22 ? * 4 *)"

  scalable_target_action {
    min_capacity = 10
    max_capacity = 500
  }
}
```

### Capacity Provider (linking to ASG)

```hcl
resource "aws_ecs_capacity_provider" "main" {
  name = "winamax-betting-cp"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs_workers.arn
    managed_termination_protection = "ENABLED"

    managed_scaling {
      maximum_scaling_step_size = 10    # max 10 instances added per CAS evaluation
      minimum_scaling_step_size = 1
      status                    = "ENABLED"
      target_capacity           = 75    # keep EC2 at 75% utilization before scaling out ASG
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = [aws_ecs_capacity_provider.main.name]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = aws_ecs_capacity_provider.main.name
  }
}
```

---

## Interview Answer Frameworks

### "How does ECS autoscaling work?"

Start with the two levels. Never describe just one. Structure: "There are two independent systems that must be coordinated. First, ECS Service Auto Scaling scales the number of tasks — this is analogous to Kubernetes HPA. Second, Capacity Providers link task scheduling to an EC2 ASG, which scales the number of EC2 instances — analogous to Cluster Autoscaler. If you only configure task scaling without EC2 scaling, you will get PENDING tasks when the cluster is full."

### "How would you handle a Champions League spike?"

Three-layer answer:
1. Pre-scale via scheduled actions 30 minutes before kickoff, based on historical peak data plus 25% headroom.
2. Target tracking on CPU and ALBRequestCountPerTarget continues to operate within the pre-scaled bounds for real-time adjustment.
3. Step scaling as a safety net for extreme deviations — adds capacity in large chunks if CPU breaches 2x the target.

### "How would you scale a Kafka consumer service?"

"CPU is the wrong metric for Kafka consumers because they are typically I/O-bound. Consumer lag directly represents backlog — that is the signal to scale on. I would publish consumer group lag as a custom CloudWatch metric from a Lambda or sidecar, then use target tracking on lag-per-task with a target of roughly X messages (calibrated by processing throughput). I would also use incremental cooperative rebalancing to avoid the rebalancing storms you get when adding many consumers rapidly."

### "What does autoscaling not protect you from?"

Name three without hesitation: database connection limits (mitigated by RDS Proxy), downstream rate limits (mitigated by client-side rate limiting and circuit breakers), Kafka consumer group rebalancing storms on rapid scale-out (mitigated by incremental cooperative rebalancing and scaling gradually).

---

## Key Numbers to Internalize

| Parameter | Value | Rationale |
|---|---|---|
| scaleOutCooldown | 60s | Fast response to load |
| scaleInCooldown | 300-600s | Prevent thrashing |
| target_capacity (CAS) | 70-75% | Headroom for immediate task placement |
| EC2 bootstrap lag | 2-5 min | Why pre-scaling is necessary |
| Fargate task ready time | 1-3 min | Better than EC2, still significant |
| ALB health check (tuned) | 10s interval × 2 = 20s | Minimum realistic registration time |
| Kafka rebalance (eager) | 10-60s of zero consumption | Why cooperative rebalancing matters |
| Winamax peak lag target | 10k-50k msg/task | Calibrated to processing throughput |
