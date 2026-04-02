# CloudWatch — Deep Dive

## What CloudWatch is

CloudWatch is AWS's native observability service. It covers:
- **Logs** — collect, store, and query log streams
- **Metrics** — time-series data for AWS services and custom instrumentation
- **Alarms** — threshold-based alerting on metrics
- **Dashboards** — visualization
- **Container Insights** — ECS/EKS-specific metrics (CPU, memory, task counts)

CloudWatch is serviceable and tightly integrated with AWS services. It is the default. But at Winamax's scale, they use Prometheus + Grafana for metrics and Quickwit for logs — while CloudWatch remains for AWS-native alarms.

---

## CloudWatch Logs

### Log groups and streams

```
Log Group: /ecs/winamax-api-prod
  Log Stream: ecs/api-container/task-id-abc123
  Log Stream: ecs/api-container/task-id-def456
  Log Stream: ecs/api-container/task-id-ghi789
```

Each ECS task writes to its own log stream. Log streams are automatically created by the `awslogs` log driver.

### ECS log driver configuration

In the ECS task definition:
```json
{
  "logConfiguration": {
    "logDriver": "awslogs",
    "options": {
      "awslogs-group": "/ecs/winamax-api-prod",
      "awslogs-region": "eu-west-3",
      "awslogs-stream-prefix": "ecs",
      "awslogs-create-group": "true"
    }
  }
}
```

This is the simplest logging setup. Container stdout/stderr goes to CloudWatch Logs. The ECS agent (via the `executionRoleArn`) handles the `logs:PutLogEvents` calls.

### Log retention

By default, CloudWatch log groups have **infinite retention**. Set a retention policy or your log costs will grow unbounded.

```
Log Group: /ecs/winamax-api-prod
  Retention: 30 days
```

After 30 days, logs are automatically deleted. For longer retention, export to S3 (manual or via subscription filter).

### CloudWatch Logs Insights

Query language for searching log groups:

```
fields @timestamp, @message, level, requestId
| filter level = "ERROR"
| filter @message like /TimeoutException/
| sort @timestamp desc
| limit 100
```

This is useful for quick searches during incidents. But at Winamax's volume (700+ services, high request rate), Quickwit on S3 is significantly cheaper and faster for structured log queries.

### Subscription filters

Stream log data in real-time to:
- Lambda (for processing, alerting)
- Kinesis Data Streams
- Kinesis Data Firehose → S3 (for archival and Quickwit indexing)

This is how log shipping to S3 works in a CloudWatch-first setup:
```
ECS → CloudWatch Logs → Subscription Filter → Kinesis Firehose → S3 → Quickwit
```

---

## CloudWatch Metrics

### Namespace and dimensions

Every metric lives in a namespace (e.g., `AWS/ECS`, `AWS/ApplicationELB`) and has dimensions (key-value pairs that identify the specific resource).

```
Namespace: AWS/ECS
Metric: CPUUtilization
Dimensions:
  ClusterName: winamax-prod
  ServiceName: api-service
Value: 73.2
Unit: Percent
Timestamp: 2026-04-01T14:00:00Z
```

### Default metrics

AWS services publish metrics automatically:

| Service | Key metrics |
|--|--|
| ECS | CPUUtilization, MemoryUtilization, RunningTaskCount |
| ALB | RequestCount, TargetResponseTime, HTTPCode_Target_5XX_Count |
| RDS | CPUUtilization, DatabaseConnections, FreeStorageSpace |
| EC2 | CPUUtilization, NetworkIn/Out (NOT memory — install CW agent for that) |
| SQS | NumberOfMessagesSent, ApproximateAgeOfOldestMessage |

**EC2 memory is not reported by default.** You need the CloudWatch Agent installed on the instance to get memory metrics.

### Custom metrics

Your application can publish custom metrics via:
1. AWS SDK (`put_metric_data` API call)
2. CloudWatch Embedded Metric Format (structured log line that CloudWatch auto-extracts as a metric)
3. CloudWatch Agent (scrapes statsd or collectd from the app)

**Cost:** $0.30 per custom metric per month (standard resolution). At Winamax's scale with 700+ services emitting custom metrics, this adds up — one reason they prefer Prometheus (where you own the storage cost and can control cardinality).

### Metric Math

CloudWatch supports expressions over multiple metrics:

```
# Error rate as percentage
error_rate = (m1 / m2) * 100
  where m1 = HTTPCode_Target_5XX_Count
        m2 = RequestCount
```

Useful but verbose compared to PromQL.

---

## CloudWatch Alarms

An alarm monitors a metric and transitions between states:
- **OK** — metric within threshold
- **ALARM** — metric breached threshold
- **INSUFFICIENT_DATA** — not enough data to evaluate

```
Alarm: ecs-api-prod-high-5xx
  Metric: HTTPCode_Target_5XX_Count (ALB, tg-api-prod)
  Statistic: Sum
  Period: 60s
  Evaluation periods: 3
  Threshold: > 50
  
  Actions:
    ALARM → SNS topic → PagerDuty / Slack
    OK    → SNS topic → "resolved" notification
```

**Composite alarms**: combine multiple alarms with AND/OR logic. "Alert only if BOTH the error rate is high AND latency is elevated" — reduces alert noise.

---

## Container Insights

Container Insights is an enhanced monitoring add-on for ECS and EKS. Enable it per cluster.

Adds:
- Per-task CPU, memory, network metrics
- Container-level granularity (not just service-level)
- Performance dashboards pre-built in CloudWatch

Cost: significantly more expensive than basic CloudWatch metrics (~$0.50–$2/node/month depending on volume). At Winamax's scale, this cost is often replaced by Prometheus + Grafana.

---

## Why Winamax moved to Prometheus + Grafana

CloudWatch's limitations at scale:

| Issue | CloudWatch | Prometheus + Grafana |
|--|--|--|
| Custom metric cost | $0.30/metric/month × thousands of metrics | $0 (you own the TSDB) |
| Query language | CloudWatch Math (limited) | PromQL (powerful, flexible) |
| Alerting | CloudWatch Alarms (simple threshold) | Alertmanager (routing, silencing, grouping) |
| Dashboard quality | Decent but limited | Grafana (industry standard) |
| Cross-service correlation | Hard | Easy with PromQL joins |
| High cardinality | Very expensive | Manageable (Thanos/Cortex for long-term) |

**The answer to "why Prometheus?" in your interview:** "CloudWatch works well for AWS-native alarms on standard metrics — we still use it for billing alerts and ECS task count monitoring. But for application-level metrics across 700+ services, the cost model breaks down and PromQL gives us query flexibility that CloudWatch Math cannot. Grafana gives us better dashboards and Alertmanager gives us better alert routing than CloudWatch Alarms."

---

## What CloudWatch is still used for at Winamax (inferred)

1. **ECS container logs** — `awslogs` driver is the zero-configuration default. Even if Quickwit is the query layer, logs flow through CloudWatch Logs first.
2. **AWS service alarms** — billing alarms, EC2 status checks, RDS storage alarms. These use built-in metrics.
3. **CloudTrail integration** — CloudWatch Logs receives CloudTrail events for security monitoring.
4. **ECS task lifecycle events** — task start/stop events via CloudWatch Events (EventBridge) trigger automation.
