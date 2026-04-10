# Lambda Deep Dive — Execution Model, Concurrency, Event Sources, and ECS Trade-offs

**Module:** 01-ecs-lambda-deep  
**Audience:** Senior engineer with strong Kubernetes background, limited Lambda operational experience  
**Goal:** Enough depth to reason about Lambda vs ECS trade-offs and explain choices under interview pressure

---

## 1. The Lambda Execution Model — What Actually Happens

When a Lambda function is invoked, AWS provisions an **execution environment** — an isolated microVM (using Firecracker) that contains your code, its dependencies, and the language runtime. Understanding the lifecycle of this environment is the foundation of everything else.

### Execution Environment Lifecycle

```
COLD START PATH
===============

  Invoke Request
       |
       v
  [Download code package / container image from S3/ECR]
       |
       v
  [Start the runtime process (Node.js, Python, JVM, etc.)]
       |
       v
  [Run initialization code — everything OUTSIDE the handler]
       |     <- This is where you pay the most cost
       v
  [Run handler function]  <-- INIT_DURATION ends here, DURATION begins
       |
       v
  [Return response]
       |
       v
  [Environment stays alive, waiting for next invocation]
       |
       |-- Next invoke arrives quickly --> WARM START (skip all of the above)
       |
       |-- Idle for ~15 minutes ---------> Environment is frozen/terminated


WARM START PATH
===============

  Invoke Request
       |
       v
  [Execution environment already running — REUSED]
       |
       v
  [Run handler function directly]
       |
       v
  [Return response]
```

### What Persists Between Invocations

This is operationally critical and frequently misunderstood:

| Resource | Persists across warm invocations? | Notes |
|---|---|---|
| Global variables | YES | Initialized once in the init phase |
| Database connections | YES | If opened outside the handler |
| SDK clients (boto3, AWS SDK, etc.) | YES | Should be initialized outside handler |
| /tmp filesystem | YES | Up to 10 GB (configurable), but not shared across environments |
| In-handler local variables | NO | Garbage collected after each invocation |
| HTTP keep-alive connections | YES | If the client supports it and is global |

### The Practical Implication — Initialize Outside the Handler

```python
# WRONG — DB connection created on every invocation, cold start cost paid every time
def handler(event, context):
    conn = psycopg2.connect(host="rds.example.com", ...)  # expensive!
    result = conn.execute("SELECT ...")
    return result

# RIGHT — connection initialized once during cold start, reused on warm invocations
import psycopg2

conn = psycopg2.connect(host="rds.example.com", ...)  # runs once per environment

def handler(event, context):
    result = conn.execute("SELECT ...")  # reuses the connection
    return result
```

The same principle applies to boto3 clients, HTTP session objects, loaded ML models, parsed configuration files — anything expensive to initialize. On warm invocations you skip the initialization entirely.

K8s analogy: this is similar to a container's entrypoint vs the main process. The entrypoint (init code) runs once when the container starts. The main process (handler) runs on each request. Except in Lambda, "container restart" happens unpredictably based on idle time and scaling.

---

## 2. Cold Starts in Depth

### What Causes a Cold Start

A new execution environment is provisioned when:

1. **First invocation ever** — no environments exist yet
2. **Scaling out** — incoming concurrency exceeds available warm environments
3. **After an idle period** — Lambda freezes and eventually terminates idle environments (typically ~15 minutes idle, but AWS does not guarantee a specific duration)
4. **Deployment** — new function version deployed, existing environments are for the old version

You cannot entirely eliminate cold starts (unless using provisioned concurrency), but you can minimize their frequency and duration.

### What Affects Cold Start Duration

```
Cold start duration = code download + runtime start + init code execution

Factors:
┌─────────────────────────────────────────────────────────┐
│  Runtime choice (biggest single factor)                 │
│  ─────────────────────────────────────────────────────  │
│  Go/Rust:    ~1-10ms   (compiled, minimal runtime)      │
│  Node.js:    ~100-500ms                                 │
│  Python:     ~100-500ms                                 │
│  .NET:       ~500ms-2s                                  │
│  Java/JVM:   ~2-10s    (JVM startup + class loading)   │
│  Java+GraalVM native: ~100-300ms (ahead-of-time compile)│
├─────────────────────────────────────────────────────────┤
│  Package size                                           │
│  ─────────────────────────────────────────────────────  │
│  Smaller package = faster download + faster class load  │
│  Java with Spring Boot: can be 80-100 MB = seconds      │
│  Go binary: 10-15 MB = milliseconds                     │
├─────────────────────────────────────────────────────────┤
│  VPC attachment                                         │
│  ─────────────────────────────────────────────────────  │
│  Non-VPC Lambda: cold start as above                    │
│  VPC Lambda: +1-3 seconds for ENI provisioning          │
│  (Hyperplane ENIs have reduced this for most regions,   │
│   but the overhead is still real and measurable)        │
├─────────────────────────────────────────────────────────┤
│  Init code complexity                                   │
│  ─────────────────────────────────────────────────────  │
│  Loading large models, opening many connections,        │
│  parsing large config files — all add to cold start     │
└─────────────────────────────────────────────────────────┘
```

### How to Measure Cold Starts

CloudWatch Logs captures INIT_DURATION only for cold starts:

```
# Cold start log entry:
REPORT RequestId: abc-123  Duration: 234.56 ms  Billed Duration: 235 ms
       Memory Size: 512 MB  Max Memory Used: 89 MB  Init Duration: 1823.45 ms

# Warm start log entry (no Init Duration):
REPORT RequestId: def-456  Duration: 12.34 ms   Billed Duration: 13 ms
       Memory Size: 512 MB  Max Memory Used: 89 MB
```

`Init Duration` only appears in the log line when a cold start occurred. You can create a CloudWatch Metrics Insights query or a Lambda Insights dashboard to track cold start frequency and duration over time.

### Cold Start Mitigation Strategies

| Strategy | How it works | Cost | Trade-off |
|---|---|---|---|
| Provisioned concurrency | AWS pre-warms N environments permanently | Always-on cost, ~$0.015/GB-hr | Eliminates cold starts for pre-warmed pool |
| Keep packages small | Less to download, faster runtime init | Dev effort | Requires dependency discipline |
| Choose faster runtime | Go/Rust/Node vs Java | Rewrite cost | Language constraints |
| Avoid VPC unless required | Skip ENI provisioning | Architecture change | May limit access to private resources |
| SnapStart (Java) | Snapshots JVM after init, restores snapshot | Free but Java-only | ~1s restore vs 5-10s JVM startup |
| Lambda warming ping | Scheduled EventBridge rule pings the function | Hacky, unreliable | Does not work at scale, avoid in production |

---

## 3. Concurrency Model

This is where Lambda most differs from a service running on ECS or a K8s Deployment.

```
CONCURRENCY MODEL
=================

Account limit: 1000 concurrent executions per region (default, soft limit)
              ┌─────────────────────────────────────────┐
              │         Account Concurrency Pool        │
              │  [fn-A: max 200] [fn-B: max 300] [...]  │
              │  [Unreserved: whatever is left]          │
              └─────────────────────────────────────────┘

Types of concurrency allocation:

1. UNRESERVED (default)
   - Function shares from the account pool
   - No upper bound except the account limit
   - Risk: a runaway function can exhaust the entire account limit,
     starving all other functions

2. RESERVED CONCURRENCY
   - Hard cap on a specific function: e.g., max 50 concurrent executions
   - Protects downstream systems (RDS, downstream APIs) from being overwhelmed
   - Also RESERVES that capacity — those 50 slots cannot be used by other functions
   - If the function hits the limit: THROTTLED (behavior depends on trigger)
   - Cost: none (it's just a limit, not pre-warming)

3. PROVISIONED CONCURRENCY
   - AWS pre-warms N execution environments
   - Those environments are always ready — zero cold start
   - Costs money even when idle (~$0.015 per GB-hour, on top of normal invocation cost)
   - Use for latency-sensitive APIs where cold starts are unacceptable
   - Can be combined with reserved concurrency
```

### Throttling Behavior by Trigger Type

This is critical for incident response — the behavior is not uniform:

| Trigger | Behavior when throttled |
|---|---|
| SQS | Message stays in queue, Lambda retries. Visibility timeout expires, message becomes visible again. Eventually hits DLQ if max receive count exceeded. |
| API Gateway | Returns HTTP 429 to the caller immediately. No retry. |
| Synchronous invocation (SDK) | Returns `TooManyRequestsException` to the caller. Caller must handle retry. |
| Kinesis / DynamoDB Streams | Lambda retries the batch. Shard processing stalls until capacity is available. |
| EventBridge / async | Lambda retries up to 2 times, then sends to DLQ if configured. |
| Scheduled EventBridge | Invocation is dropped if throttled. Event is lost unless you have DLQ. |

K8s analogy: reserved concurrency is like setting `resources.limits` on a Pod. Provisioned concurrency is like having a minimum number of ready replicas (`minReplicas` in HPA). The account limit is like a cluster-level node resource ceiling.

---

## 4. Event Sources

An event source is whatever triggers your Lambda. The key question for each one is:
**if Lambda fails or is too busy — what happens to the event?**

The answer depends on one fundamental split:

```
PULL-based (Lambda polls)          PUSH-based (source calls Lambda)
──────────────────────────         ──────────────────────────────────
SQS                                API Gateway
Kinesis                            S3
DynamoDB Streams                   EventBridge
                                   SNS

Lambda reaches out and             The source fires at Lambda.
fetches work when ready.           Lambda must respond immediately.

Backpressure is natural:           No buffer — if Lambda is busy
events stay in the queue           or fails, it's the source's
until Lambda picks them up.        problem to decide what to do.
```

---

### SQS — Pull, Safe, Forgiving

SQS is the most operationally forgiving trigger. Messages sit in a queue. Lambda polls and processes batches. If Lambda fails, the message goes back in the queue and gets retried.

```
SQS Queue: [msg1][msg2][msg3][msg4]...
                    |
          Lambda polls (not your code — AWS does this)
                    |
          Processes a batch (up to 10,000 messages)
                    |
          SUCCESS → messages deleted from queue
          FAILURE → messages become visible again → retried → DLQ
```

**The one rule you must know — visibility timeout:**

When Lambda picks up a message, SQS hides it from other consumers for a duration called the visibility timeout. If Lambda doesn't finish within that window, SQS assumes Lambda died and makes the message visible again — causing duplicate processing.

**Rule: set visibility timeout to at least 6× your Lambda timeout.**

```
Lambda timeout = 30s  →  visibility timeout must be ≥ 180s
```

**Partial batch failure:**

If your batch has 10 messages and message 7 crashes, by default Lambda retries all 10 — including 1-6 that already succeeded. That's wasteful and dangerous (double processing).

Fix: enable `ReportBatchItemFailures`. Your handler returns only the IDs of failed messages. Lambda retries only those.

---

### Kinesis / DynamoDB Streams — Pull, Ordered, Unforgiving

These work like SQS with one critical difference: **ordering is guaranteed within a shard.**

```
Shard 0: [rec1] → [rec2] → [rec3] → [rec4] → [rec5]...
                             ↑
                         Lambda is here

rec3 fails:
  → Lambda cannot skip to rec4 (that would break ordering)
  → Lambda retries rec3... and retries... and retries
  → The entire shard is FROZEN until rec3 succeeds or expires
```

This is the **stuck shard** problem. A single bad record (poison pill) halts all processing on that shard. Records pile up behind it. Your consumer falls further and further behind.

**You must configure these three settings on every stream consumer:**

| Setting | What it does |
|---|---|
| `BisectBatchOnFunctionError: true` | On failure, split the batch in half and retry each half. Quickly isolates the one bad record. |
| `MaximumRetryAttempts: N` | Stop retrying after N attempts. Don't loop forever. |
| `DestinationConfig.OnFailure` | After retries are exhausted, send the failed batch to SQS/SNS so the shard can unblock. |

Without these, one malformed event can halt your consumer permanently.

**How to monitor:** watch the `IteratorAge` CloudWatch metric. It measures how far behind the shard tip you are. A growing IteratorAge = your consumer is stuck or falling behind.

---

### S3 — Push, Async, Fire and Forget

A file is uploaded to S3 → S3 calls your Lambda. Lambda processes it.

```
File uploaded to S3
       ↓
S3 fires event at Lambda (asynchronously — S3 doesn't wait for a response)
       ↓
Lambda runs: reads the file, transforms it, stores the result
       ↓
SUCCESS → done
FAILURE → Lambda retries automatically (2 times with backoff)
        → After 2 retries, event goes to DLQ (if configured on the Lambda function)
```

Key points:
- S3 does not wait for Lambda to finish — it fires and forgets
- Events can arrive out of order (two uploads close together may trigger in any sequence)
- Configure the DLQ on the **Lambda function**, not on the S3 bucket

---

### API Gateway — Push, Synchronous, No Retry

This is the only trigger where something is actively waiting for Lambda's response.

```
HTTP request → API Gateway → Lambda runs → response returned to caller
                                  ↓
                            FAILURE or TIMEOUT
                                  ↓
                         API GW returns error to caller immediately
                         No retry. The caller handles it.
```

Key constraints:
- **Hard timeout: 29 seconds** — this is API Gateway's limit, not Lambda's. If your Lambda runs longer than 29s, API GW returns 504 regardless.
- **Throttled:** API GW returns HTTP 429 to the caller. No buffering, no retry from AWS.
- Your Lambda timeout must be set below 29 seconds when used with API GW.

---

### EventBridge — Push, Async, Retries Included

An event happens in your system (e.g. "bet settled") → EventBridge routes it → Lambda processes it.

```
Event published to EventBridge
       ↓
EventBridge calls Lambda (asynchronously)
       ↓
FAILURE → EventBridge retries up to 2 times with exponential backoff
        → After retries: sent to DLQ if configured
```

**EventBridge Scheduler (cron):** runs Lambda on a schedule (`rate(5 minutes)`, `cron(0 8 * * ? *)`). If Lambda is throttled when the schedule fires, the invocation is simply **dropped** — not retried. If this matters, add a DLQ.

---

### Summary — What Happens When Lambda Fails

| Source | If Lambda fails | If Lambda is throttled (too busy) |
|---|---|---|
| SQS | Message returns to queue, retried, then DLQ | Message stays in queue until Lambda is free |
| Kinesis/DynamoDB Streams | Shard blocks, retried until `MaximumRetryAttempts` | Shard blocks |
| S3 | 2 automatic retries, then DLQ | Event dropped (no buffer) |
| API Gateway | Error returned to caller immediately | HTTP 429 returned to caller |
| EventBridge | 2 automatic retries, then DLQ | Event dropped |
| EventBridge Scheduler | 2 automatic retries, then DLQ | Invocation dropped |

The pattern: **pull-based sources (SQS, Kinesis) are naturally resilient** because the data lives in a queue/stream until Lambda consumes it. **Push-based sources depend on either retries or a DLQ** — and if neither is configured, the event is lost.

---

## 5. Lambda Limits That Matter Operationally

Memorize these. They define what Lambda can and cannot do.

| Limit | Value | Operational implication |
|---|---|---|
| Max execution timeout | 15 minutes | Not for long-running jobs. Batch jobs over 15 min need ECS/Fargate or Step Functions. |
| Max memory | 10 GB | CPU scales linearly with memory. 1 vCPU at ~1.7 GB, 6 vCPU at 10 GB. |
| Ephemeral /tmp storage | 512 MB – 10 GB (configurable) | Default is 512 MB. Large file processing needs explicit configuration. |
| Synchronous payload | 6 MB request, 6 MB response | Cannot return large results synchronously. Use S3 presigned URL pattern. |
| Async payload | 256 KB | EventBridge, async invoke, SQS standard payloads up to this |
| Default concurrent executions | 1,000 per region | Shared across ALL functions in the account. Soft limit, can be raised. |
| Layers | 5 layers, 250 MB unzipped total | Shared code/dependencies across functions |
| Environment variables | 4 KB total | Use SSM Parameter Store or Secrets Manager for large config |

The CPU scaling implication is important for cost optimization: if your function is CPU-bound, increasing memory from 512 MB to 1024 MB may cut execution time in half, potentially reducing cost (you pay `GB × seconds`).

---

## 6. Lambda in a VPC

### When You Need It

You need VPC attachment when your Lambda must reach:
- RDS or Aurora in a private subnet
- ElastiCache (Elasticache is never publicly accessible)
- Internal services on private IP addresses
- Systems protected by security groups that only allow VPC traffic

### The Cost: ENI Provisioning

```
Lambda VPC Cold Start Timeline
================================

Non-VPC Lambda:
  [init code] -> handler  (cold start: ~100ms-2s depending on runtime)

VPC Lambda:
  [ENI provisioning] -> [init code] -> handler
  |<---  1-3 seconds  -->|

ENI = Elastic Network Interface
  - Each concurrent Lambda execution needs an ENI in your VPC
  - ENIs are created in the subnets you specify
  - Shared across executions using Hyperplane ENIs (AWS improvement ~2019)
  - Still adds latency on cold start
```

### ENI Exhaustion — A Real Production Failure Mode

Each AWS account and region has an ENI limit (default 5,000). If your Lambda scales to high concurrency and is attached to multiple subnets, ENI creation can fail:

- Lambda invocations fail with `EC2ThrottledException` or `NetworkInterfaceLimit`
- Monitor ENI count in CloudWatch: `AWS/Lambda` metric `ENICreation`
- Mitigation: use fewer subnets (Lambda creates ENIs per subnet × concurrent executions combination), increase ENI limits via AWS Support

### Best Practice

Only attach Lambda to a VPC when strictly necessary. If you need RDS access from Lambda, consider:
1. RDS Proxy — manages connection pooling for Lambda (Lambda opens/closes connections per invocation, which destroys connection pools; RDS Proxy absorbs this)
2. Keeping VPC Lambda in private subnets with NAT Gateway for internet access (Lambda in a VPC has no internet access by default)

---

## 7. Lambda vs ECS — Decision Framework

This is the core interview question. Not "Lambda for small things, ECS for big things" — that's junior-level. The real framework:

```
DECISION SIGNALS
================

Signal                     Favors Lambda              Favors ECS (Fargate)
─────────────────────────────────────────────────────────────────────────
Execution duration         < 15 minutes               > 15 minutes
Traffic pattern            Spiky/unpredictable        Steady/predictable
Idle time                  Long idle periods          Always-on traffic
Cold start tolerance       Tolerant (async/batch)     Intolerant (sync API)
Connection pool needs      No (stateless, or RDS Proxy) Yes (DB, cache)
State between requests     Stateless                  Stateful session
Startup latency req.       > 1 second acceptable      < 100ms required
Package/image size         < 250 MB zip / 10 GB image Large, complex apps
Concurrency model          Event-driven, isolated     Long-running workers
Operational overhead       Near-zero (no infra mgmt)  Low (Fargate) to medium
Cost at sustained load     Higher per-hour equivalent Lower at high concurrency
Cost at bursty/idle load   Much lower (pay per ms)    Higher (idle containers)
```

### The Cost Math at Scale

At very high sustained concurrency, ECS is cheaper. The math:

```
Lambda pricing (us-east-1, simplified):
  $0.0000000083 per GB-second
  1,000 concurrent executions × 512 MB × 3,600 seconds/hour
  = 1,000 × 0.5 GB × 3,600 = 1,800,000 GB-seconds/hour
  = 1,800,000 × $0.0000000083 = ~$14.94/hour

Fargate pricing (us-east-1, simplified):
  $0.04048 per vCPU-hour + $0.004445 per GB-hour
  1,000 tasks × 0.25 vCPU × $0.04048 = $10.12/hour
  1,000 tasks × 0.5 GB × $0.004445 = $2.22/hour
  Total: ~$12.34/hour

At sustained high concurrency: ECS/Fargate wins on cost.
At 5% utilization (20 hours idle per day): Lambda wins decisively.
```

The crossover point depends on your specific memory/vCPU allocation and utilization pattern. Winamax's core betting API is always-on with predictable load — ECS is the right call. An S3 processing pipeline that runs 50 times/day for 2 minutes — Lambda is obvious.

---

## 8. Lambda at Winamax — Likely Use Cases and Non-Use Cases

Reason through their actual workload rather than citing generic best practices.

### What Lambda is Probably Doing at Winamax

| Use Case | Why Lambda Fits |
|---|---|
| S3 event processing | Async, spiky, stateless. Bet data files uploaded → Lambda transforms and loads. |
| EventBridge rules for cross-service events | Async fan-out, no sustained throughput, event routing between microservices |
| Scheduled data quality checks | Cron-based, infrequent, short-lived. "Check for orphaned bets every hour." |
| DynamoDB Streams → cache invalidation | Stream consumer, low-throughput, simple logic |
| Bet settlement notifications | Async post-settlement hooks, triggered by EventBridge |
| Image/media processing | Profile pictures, tournament graphics — S3 trigger, bursty |
| Automated database access governance | Likely Lambda behind an API or EventBridge — grants/revokes access on-demand |

### What Lambda is NOT Doing at Winamax

| Workload | Why Lambda Cannot Handle It |
|---|---|
| Core betting API | Latency-sensitive, synchronous, connection pool needs, always-on traffic → ECS |
| Kafka consumers at 75k msg/sec | Lambda's MSK trigger exists but has throughput limits, ordering constraints, and consumer group management overhead. ECS-based consumers are operationally simpler at this scale. |
| Poker game state management | Stateful, long-lived sessions, sub-second latency → ECS |
| Real-time odds calculation | Always-on, CPU-intensive, connection-heavy → ECS |
| Any service with persistent WebSocket connections | Lambda doesn't support persistent connections. API Gateway WebSocket + Lambda is complex and limited. |

The pattern: Lambda handles the event-driven, asynchronous, infrequent, or spiky workloads at the edges. ECS handles the 700+ core microservices that serve traffic continuously.

---

## 9. Terraform for Lambda — Concrete Example

A Lambda function triggered by SQS, with a DLQ for failed messages.

```hcl
# ─── IAM Role ────────────────────────────────────────────────────────────────

resource "aws_iam_role" "bet_processor_lambda" {
  name = "bet-processor-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "basic_execution" {
  role       = aws_iam_role.bet_processor_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "sqs_access" {
  name = "bet-processor-sqs-policy"
  role = aws_iam_role.bet_processor_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.bet_events.arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.bet_events_dlq.arn
      }
    ]
  })
}

# ─── SQS Queue and DLQ ───────────────────────────────────────────────────────

resource "aws_sqs_queue" "bet_events_dlq" {
  name                      = "bet-events-dlq"
  message_retention_seconds = 1209600  # 14 days — time to investigate failures
}

resource "aws_sqs_queue" "bet_events" {
  name                       = "bet-events"
  visibility_timeout_seconds = 180  # 6x Lambda timeout (30s × 6)

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.bet_events_dlq.arn
    maxReceiveCount     = 3  # 3 attempts before DLQ
  })
}

# ─── Lambda Function ─────────────────────────────────────────────────────────

resource "aws_lambda_function" "bet_processor" {
  function_name = "bet-processor"
  role          = aws_iam_role.bet_processor_lambda.arn

  # Assumes you're deploying from a zip package
  filename         = "bet_processor.zip"
  source_code_hash = filebase64sha256("bet_processor.zip")

  handler = "main.handler"
  runtime = "python3.12"

  timeout     = 30   # seconds — must be < visibility_timeout / 6
  memory_size = 512  # MB

  environment {
    variables = {
      ENVIRONMENT = "production"
      LOG_LEVEL   = "INFO"
    }
  }

  # Optional: reserve concurrency to protect downstream RDS
  reserved_concurrent_executions = 50

  # Optional: DLQ for async invocations (not SQS-triggered — SQS handles its own DLQ)
  dead_letter_config {
    target_arn = aws_sqs_queue.bet_events_dlq.arn
  }
}

# ─── Event Source Mapping (SQS → Lambda) ─────────────────────────────────────

resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  event_source_arn = aws_sqs_queue.bet_events.arn
  function_name    = aws_lambda_function.bet_processor.arn

  batch_size                         = 10
  maximum_batching_window_in_seconds = 5  # wait up to 5s to fill a batch

  # Prevents entire batch retry when one message fails
  function_response_types = ["ReportBatchItemFailures"]

  # Scaling: Lambda will poll with up to reserved_concurrent_executions pollers
}

# ─── Lambda Permission (for API GW or S3 — not needed for SQS) ───────────────
# SQS trigger does not need aws_lambda_permission — the event source mapping
# handles authorization. You need aws_lambda_permission for push-based triggers:
# S3, API Gateway, EventBridge, SNS.

resource "aws_lambda_permission" "allow_s3" {
  # Example: separate function triggered by S3
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.bet_processor.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = "arn:aws:s3:::winamax-bet-data"
}
```

### Key Terraform Resources to Know

| Resource | Purpose |
|---|---|
| `aws_lambda_function` | The function itself — code, runtime, memory, timeout, env vars |
| `aws_lambda_event_source_mapping` | Connects SQS, Kinesis, DynamoDB Streams to Lambda (poll-based) |
| `aws_lambda_permission` | Allows push-based services (S3, API GW, EventBridge) to invoke Lambda |
| `aws_iam_role` + `aws_iam_role_policy_attachment` | Execution role — required for every Lambda |
| `aws_lambda_alias` | Points to a specific version — used with provisioned concurrency |
| `aws_lambda_provisioned_concurrency_config` | Pre-warm N environments for an alias |

### Provisioned Concurrency in Terraform

```hcl
resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.bet_processor.function_name
  function_version = aws_lambda_function.bet_processor.version
}

resource "aws_lambda_provisioned_concurrency_config" "bet_processor" {
  function_name                  = aws_lambda_function.bet_processor.function_name
  qualifier                      = aws_lambda_alias.live.name
  provisioned_concurrent_executions = 10
}
```

---

## 10. Interview Q&A — Anticipated Questions

**Q: Walk me through what happens when a Lambda cold start occurs.**

Walk through the four phases: environment creation, code download, runtime startup, init code execution. Mention that INIT_DURATION captures this in CloudWatch. Explain that global variables and SDK clients survive to warm invocations, which is why you initialize them outside the handler.

**Q: A Lambda processing a Kinesis stream is stuck. What do you check?**

The shard is blocked by a failing record. Check: CloudWatch `IteratorAge` metric (time behind the stream tip), function error rate, whether `BisectBatchOnFunctionError` is enabled, `MaximumRetryAttempts` setting, and `DestinationConfig` for failed records. Immediate mitigation if configured: failed records go to SQS DLQ, unblocking the shard. If not configured: you may need to manually advance the iterator.

**Q: Why would you choose ECS over Lambda for a service?**

Use the decision table. Key reasons: execution duration over 15 minutes, sustained high-traffic with steady load (cost), connection pool requirements (DB connections, caches), latency-sensitive synchronous APIs where cold starts are unacceptable, Kafka consumers at high throughput, any workload requiring persistent state.

**Q: You have a Lambda behind API Gateway hitting throttle limits. What do you do?**

Identify the root cause: is it the 1000 account limit? Reserved concurrency set too low? Downstream service protecting itself? Options: request account limit increase (AWS Support), increase reserved concurrency, implement API Gateway usage plans and rate limiting to smooth traffic, add SQS as a buffer between API GW and Lambda to decouple throughput, or evaluate whether ECS Fargate is a better fit for this traffic pattern.

**Q: How does VPC attachment affect Lambda, and when do you avoid it?**

VPC Lambda needs ENI provisioning on cold start (+1-3s). Requires enough free IPs in your subnets. Can hit ENI limits at scale. Avoid unless you must reach private resources (RDS, ElastiCache). If you need RDS access, evaluate RDS Proxy + VPC Lambda vs. exposing RDS through a private API. Non-VPC Lambda can still reach AWS services via public AWS endpoints.

---

## Key Numbers to Have Ready

| What | Number |
|---|---|
| Max Lambda timeout | 15 minutes |
| API Gateway max timeout | 29 seconds |
| Default account concurrency limit | 1,000 per region |
| Max Lambda memory | 10 GB |
| VPC cold start overhead | 1-3 seconds (ENI) |
| JVM cold start without SnapStart | 2-10 seconds |
| Go/Rust cold start | < 10ms |
| Async payload limit | 256 KB |
| Sync payload limit | 6 MB |
| SQS visibility timeout rule | > Lambda timeout × 6 |
