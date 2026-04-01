# ECS Deployments — Deep Operational Knowledge

**Target:** Winamax SRE/DevOps interview preparation  
**Audience:** Senior engineer with strong Kubernetes production background  
**Goal:** Operational depth — enough to answer every follow-up and explain the *why*

---

## Mental model before we start

In Kubernetes you reason about:
- `Deployment` spec (replicas, rollingUpdate strategy)
- `ReplicaSet` (old vs new)
- `Service` (selector switches on label)
- Readiness probes (gates traffic)

In ECS you reason about:
- `Service` spec (deployment configuration, task count)
- `TaskDefinition` (old revision vs new revision — analogous to a new image tag triggering a new ReplicaSet)
- `Target Group` (where tasks register; ALB routes to this)
- `Health checks` (two separate systems — more on this below)

The same *problem* (how do I replace 700 running tasks without dropping a bet slip?) — different knobs.

---

## 1. Rolling Deployments — How They Actually Work

### The two knobs: minimumHealthyPercent and maximumPercent

These are set on the ECS service's `deploymentConfiguration`. They control how ECS replaces tasks during a rolling update.

```
minimumHealthyPercent  — floor: ECS will not drop below this % of the desired count
maximumPercent         — ceiling: ECS will not exceed this % of the desired count
```

ECS counts **running healthy tasks** against minimumHealthyPercent. A task is "healthy" from ECS's perspective once it is passing its ALB target group health check (or the ECS-level container health check if there is no load balancer).

### Concrete math: 4 tasks running, new task definition deployed

**Setting A: min=100, max=200 (safest, requires headroom)**

```
Desired = 4, min=4 tasks must stay healthy, ceiling = 8 tasks allowed

Step 1: Launch 4 new tasks (now at 8 total — ceiling hit)
Step 2: New tasks pass health checks and register with ALB
Step 3: Deregister and drain 4 old tasks
Step 4: Terminate old tasks

Net effect: zero downtime, but you need capacity for 8 tasks simultaneously.
```

This is the Kubernetes equivalent of `maxSurge=100%, maxUnavailable=0`.

**Setting B: min=50, max=100 (default AWS console values)**

```
Desired = 4, min=2 tasks must stay healthy, ceiling = 4 tasks (no extra capacity)

Step 1: Stop 2 old tasks (now at 2 healthy — floor hit)
Step 2: Start 2 new tasks (now at 4 total — ceiling hit)
Step 3: New tasks become healthy, old ones drain and stop
Step 4: Repeat with remaining 2 old tasks

Net effect: at any point, at least 2 tasks are serving traffic.
This is the K8s equivalent of maxSurge=0, maxUnavailable=50%.
```

**Setting C: min=0, max=100 (aggressive, risky)**

```
Desired = 4, min=0 tasks must stay healthy, ceiling = 4 tasks

Step 1: Stop all 4 old tasks immediately
Step 2: Start 4 new tasks
Step 3: If new tasks are slow to start: full outage window

Only acceptable for non-production or truly stateless batch tasks.
```

**Setting D: min=100, max=100 (impossible — ECS will error)**

```
Cannot start new tasks (ceiling = 4) without stopping old ones (floor = 4).
ECS cannot make progress. The deployment will hang indefinitely.
Don't do this.
```

### What ECS actually does step by step

1. You trigger a service update (new task definition revision, new image, env var change — anything in the task def).
2. ECS scheduler compares current task count vs desired and applies the min/max math.
3. ECS starts new tasks on container instances (EC2) or Fargate slots.
4. New tasks go through their container startup, then register with the ALB target group.
5. ALB runs its health check against the new task. Until the task passes, it stays in `initial` or `unhealthy` state in the target group — **ECS waits here**.
6. Once the new task is healthy, ECS begins draining an old task from the target group.
7. After the deregistration delay expires, the old task is stopped.
8. Repeat until all tasks are on the new revision.

### ALB connection draining — step by step

When ECS deregisters a task from the target group, the ALB does not immediately stop sending traffic. This is "connection draining" (AWS calls it "deregistration delay").

```
Timeline of one task being replaced:

t=0:   ECS tells target group: deregister task A
t=0:   ALB stops routing NEW connections to task A
t=0:   ALB keeps EXISTING connections to task A alive
t=0:   Deregistration delay timer starts (default: 300 seconds)
t=X:   All existing connections to task A close naturally (HTTP keep-alive, SSE, WebSocket)
t=300: Deregistration delay expires — ALB force-closes any remaining connections
t=300: ECS sends SIGTERM to the task container
t=300+: Container handles SIGTERM, finishes in-flight work, exits
t=330+: ECS stops the task (30s grace period after SIGTERM before SIGKILL)
```

**Key insight:** The deregistration delay is an ALB concern. It happens *before* ECS sends SIGTERM. Your task is still running during the drain window — it will receive no *new* requests but must complete existing ones.

**Winamax implication:** A sports betting slip in-flight during a Champions League final should not be dropped. You want a deregistration delay high enough that the request completes, but not so high that deployments take 5 minutes per task. 30–60 seconds is common for stateless HTTP services. WebSocket or long-poll services need longer.

```
Deregistration delay too short → in-flight requests get connection-reset errors
Deregistration delay too long  → deployments take forever (300s * N batches)
```

### health_check_grace_period_seconds vs task definition healthCheck startPeriod

These are two completely different things. Confusing them is a common operational mistake.

**task definition healthCheck startPeriod** (set in the task/container definition):

```json
"healthCheck": {
  "command": ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"],
  "interval": 30,
  "timeout": 5,
  "retries": 3,
  "startPeriod": 60
}
```

- This is a Docker/ECS agent-level health check.
- `startPeriod` tells the ECS agent: "don't count failures during the first N seconds after the container starts."
- If the container fails health checks after `startPeriod`, ECS marks it `UNHEALTHY` and can restart it.
- This is evaluated *by the ECS agent on the host* (or Fargate control plane), not by the ALB.

**service-level health_check_grace_period_seconds** (set on the ECS service):

```
aws ecs create-service --health-check-grace-period-seconds 120 ...
```

- This tells ECS: "after a task registers with the load balancer, wait N seconds before checking whether the target group considers it healthy."
- Without this, ECS might see a task failing ALB health checks during its startup (JVM warming up, DB migrations running) and immediately stop the task, causing a deployment loop.
- This is about the ALB/target group health check, not the container-level check.

**Mental model:**

```
Container starts
  |
  +-- ECS agent health check starts (startPeriod grace before counting failures)
  |
  +-- Task registers with ALB target group
        |
        +-- ALB begins health check polling
        |
        +-- health_check_grace_period_seconds timer starts
              |
              +-- During grace period: ECS ignores ALB health check failures
              +-- After grace period: if ALB says unhealthy, ECS acts on it
```

**Practical rule:** `health_check_grace_period_seconds` should be >= your application's worst-case cold start time. For JVM services or anything doing schema migrations on start, budget generously (90–180s). For a Go binary, 15–30s is usually enough.

---

## 2. Blue/Green Deployments via AWS CodeDeploy

### The conceptual difference from rolling

Rolling: tasks are replaced in batches *within the same service*. At some point in time, you have a mix of old and new tasks.

Blue/Green: two complete, separate environments exist simultaneously. Traffic is shifted atomically (or gradually) from one to the other. At no point does a single request hit both blue and new.

**K8s analogy:** Blue/green in K8s is done by running two `Deployment` objects, then switching the `Service` selector from `version: blue` to `version: green`. The ECS/CodeDeploy equivalent switches which target group the ALB listener routes to.

### The two target groups pattern

```
                        ALB
                         |
          +──────────────+──────────────+
          |                             |
    Listener :443                 Listener :8080
    (production)                   (test, optional)
          |                             |
    [Rule: default]               [Rule: default]
          |                             |
    Target Group BLUE            Target Group GREEN
    (old task revision)          (new task revision)

During deployment:
  - CodeDeploy shifts PROD listener from BLUE → GREEN
  - Test listener stays on GREEN so you can validate before shift completes
  - After successful shift, old BLUE tasks are drained and terminated
```

### Traffic shifting options

**AllAtOnce**

```
t=0:   100% traffic on BLUE
t=1:   CodeDeploy shifts 100% traffic to GREEN
t=1:   All connection draining of BLUE begins simultaneously

Risk:  If GREEN is bad, 100% of production traffic hits the bad version instantly.
Use:  Only for dev/staging or services with very fast automatic rollback alarms.
```

**Linear (example: CodeDeployDefault.ECSLinear10PercentEvery1Minute)**

```
t=0:   10% GREEN, 90% BLUE
t=1m:  20% GREEN, 80% BLUE
t=2m:  30% GREEN, 70% BLUE
...
t=9m:  100% GREEN, 0% BLUE

Each step: CodeDeploy checks CloudWatch alarms. If alarm fires → rollback.
```

**Canary (example: CodeDeployDefault.ECSCanary10Percent5Minutes)**

```
t=0:   10% GREEN, 90% BLUE   ← canary bake period begins
t=5m:  CodeDeploy checks alarms
       - If healthy: shift remaining 90% to GREEN immediately
       - If alarm: rollback instantly to 100% BLUE

This is the most common production choice: small canary bake, then all-at-once.
```

Other named presets:
- `ECSCanary10Percent15Minutes` — longer bake period
- `ECSLinear10PercentEvery3Minutes` — 30-minute full rollout
- `ECSAllAtOnce` — instant

You can also define custom percentages and intervals.

### The test listener

The test listener is an optional second ALB listener (typically on port 8080) that always points to the *green* (new) target group, regardless of where production traffic is.

This lets you:
- Run smoke tests against the new version before it receives production traffic
- Run integration tests as part of the CodeDeploy `BeforeAllowTraffic` lifecycle hook
- Validate with real infrastructure but synthetic traffic

```
CodeDeploy lifecycle hooks (blue/green):

  BeforeInstall         → run before new tasks start
  AfterInstall          → run after new tasks start but before traffic shifts
  AfterAllowTestTraffic → run after test listener points to green (smoke tests here)
  BeforeAllowTraffic    → run just before production traffic shifts to green
  AfterAllowTraffic     → run after production traffic is fully on green
  BeforeDeinstall       → run before blue tasks drain
  AfterDeinstall        → run after blue tasks terminate
```

### Rollback — why it's instant

In blue/green, rollback is a load balancer operation: shift traffic back to the blue target group. The old tasks are still running (they are kept alive for the configurable `terminationWaitTimeInMinutes` after a successful deployment).

```
Normal deployment:
  t=0:    Shift traffic BLUE → GREEN (success)
  t=60m:  terminationWaitTimeInMinutes expires → BLUE tasks drained and stopped

Rollback triggered (alarm fires at t=5m):
  t=5m:   CodeDeploy shifts traffic GREEN → BLUE (immediate, single ALB rule update)
  t=5m:   BLUE tasks were still running — zero spin-up time
  t=5m:   GREEN tasks begin drain, will be terminated

Total rollback time: seconds (ALB rule update + connection drain of green)
```

**This is the fundamental operational advantage of blue/green over rolling.**

With rolling, "rollback" means re-deploying the old task definition. That takes as long as the original deployment — possibly minutes per batch depending on your configuration and container startup times.

### When to use blue/green over rolling

Use blue/green when:
- The service handles payments, bets, or any financial transaction where a bad deployment must be reversible in seconds, not minutes
- You need automated rollback on error rate/latency alarms
- You want to validate a new version with test traffic before exposing it to production
- The deployment risk is high (new dependency, schema change affecting the hot path)

Use rolling when:
- The service is stateless and tolerates momentary mixed versions
- You don't want the operational overhead of CodeDeploy setup and two target groups
- Deployment frequency is high and rollback speed is acceptable as a re-deploy

### Operational cost of blue/green

You pay for this safety:
- Two target groups per service (Terraform is more complex)
- CodeDeploy application and deployment group per service
- IAM role for CodeDeploy with specific ECS and ELB permissions
- Bake period means deployments take longer even when everything is healthy
- The task count *doubles* during deployment (blue + green both running) — you need this capacity
- CloudWatch alarms must be tuned; false positives cause unnecessary rollbacks

---

## 3. Canary Deployments

### What "canary" means in ECS context — two different things

The word "canary" is overloaded here. Be precise in interviews.

**Canary traffic shifting (CodeDeploy preset):** A two-step traffic shift where a small percentage goes to the new version first, then the rest follows if the bake period passes without alarms. This is *within* a blue/green CodeDeploy deployment. The underlying mechanism is ALB weighted target group routing managed by CodeDeploy.

**Manual canary (without CodeDeploy):** Running two separate ECS services — one stable, one canary — and using ALB weighted target group rules to split traffic between them. You manage this yourself.

### Manual canary on ECS without CodeDeploy

```
                        ALB Listener
                              |
              +───────────────+───────────────+
              |                               |
      Target Group STABLE             Target Group CANARY
      (old task def, weight=90)       (new task def, weight=10)
      Service: betting-api-stable     Service: betting-api-canary
      Tasks: 9                        Tasks: 1
```

You create two ECS services sharing the same ALB but pointing to different weighted target groups. ALB weighted routing splits traffic by the weights you set.

**Promotion flow:**

```
Phase 1: 90/10 split — monitor error rates, p99 latency for N minutes
Phase 2: 70/30 — still healthy? continue
Phase 3: 0/100 — stable service scaled to 0, canary becomes the new stable
Phase 4: Rename / update the stable service task definition
```

**Trade-offs vs CodeDeploy canary:**

| Aspect | Manual canary | CodeDeploy canary |
|---|---|---|
| Automation | Manual or scripted | Fully automated with alarms |
| Rollback | Manual (re-weight to 100/0) | Automatic on alarm |
| Complexity | Two services, managed separately | One CodeDeploy deployment |
| Flexibility | Any weight, any duration | Preset or custom configurations |
| Visibility | Logs/metrics tagged by service | CodeDeploy console + alarms |

Manual canary is useful when CodeDeploy overhead is not justified but you still want gradual traffic exposure. For Winamax's scale (700+ services), automated CodeDeploy canary is more operationally sustainable.

---

## 4. Decision Framework — When to Use Which Strategy

```
Is this service on the payment or betting critical path?
  YES → Blue/Green with CodeDeploy
         + Canary10Percent5Minutes preset
         + CloudWatch alarms on error_rate and p99_latency
         + Test listener smoke tests in AfterAllowTestTraffic hook
  NO  → Is this a high-risk change? (new DB schema, new external dependency)
          YES → Blue/Green or manual canary
          NO  → Rolling (min=100, max=200 if you have capacity; or min=50, max=100)
```

**Winamax-specific reasoning:**

Given 700+ microservices, 900k bets/day, and Champions League final traffic spikes:

- **Bet placement service, payment gateway, odds calculation** → Blue/Green, non-negotiable. Instant rollback is required. A 5-minute rolling re-deploy during a final is not acceptable.
- **Match data enrichment, push notification, analytics** → Rolling is fine. A brief degradation of these services has no financial consequence.
- **Core API gateway / ingress** → Blue/Green. Any bad deployment here affects all 700 services.
- **Background workers / Kafka consumers** → Rolling is usually fine. The risk profile is lower because they're not directly in the request path.

**Traffic spike consideration:** During a Champions League final, Winamax likely freezes all non-critical deployments. The ones that must go out (security patches, hotfixes) use blue/green because capacity is pre-provisioned in the green environment.

---

## 5. Rollback — Mechanics for Each Strategy

### Rolling rollback

There is no "undo" button. Rollback means deploying the previous task definition revision.

```
Deployment of v10 started:
  t=0:  2 of 4 tasks updated to v10
  t=2m: You notice p99 latency spike
  t=2m: You trigger rollback = deploy v9

Rollback deployment:
  t=2m: ECS starts deploying v9 task definition
  t=4m: v10 tasks drain and stop, v9 tasks come up
  t=6m: All 4 tasks on v9

Total incident window: 6 minutes minimum
Mixed-version traffic window: 4 minutes (v9 and v10 serving simultaneously)
```

**Operational implication:** With rolling, you *will* have mixed-version traffic during both the deployment and the rollback. If v10 has a data format change that breaks v9 readers, this mixed window is dangerous. Design your services to be forward/backward compatible across one revision (Postel's Law: be conservative in what you send, liberal in what you accept).

### Blue/Green rollback

```
Deployment of v10:
  t=0:  GREEN (v10) starts up, BLUE (v9) still serving 100%
  t=3m: Traffic shifted 10% GREEN, 90% BLUE (canary)
  t=4m: CloudWatch alarm fires: error_rate > 1%
  t=4m: CodeDeploy shifts 100% traffic back to BLUE (single ALB rule change)
  t=4m: GREEN tasks begin draining

Total incident window: 1 minute (from canary shift to rollback)
Mixed-version traffic window: 1 minute, at 10% of requests
BLUE tasks were never stopped: rollback is instantaneous
```

### Summary table

| Strategy | Rollback mechanism | Rollback speed | Mixed version window |
|---|---|---|---|
| Rolling | Re-deploy old task def | Minutes (full deployment) | Yes — during both deploy and rollback |
| Blue/Green | ALB rule change | Seconds | No — traffic switches atomically |
| Manual canary | Re-weight target groups | Seconds (manual action) | Effectively no — only 10% ever hit canary |

---

## 6. What ECS Does NOT Do Automatically

**This is a critical interview point. Most candidates get this wrong.**

### ECS does NOT auto-rollback if new tasks fail health checks

Here is exactly what happens when a new task definition produces tasks that never become healthy:

```
t=0:   Deployment triggered (v10)
t=0:   ECS starts new task
t=30s: Task fails ALB health check
t=30s: ECS marks task as unhealthy
t=30s: ECS stops the task
t=30s: ECS immediately starts another new task (it keeps trying)
t=1m:  Second task fails health check — same story
t=1m:  ECS starts third new task
...
t=∞:   ECS keeps cycling through failed tasks forever
       Old tasks (v9) stay running and serving traffic (min=100% protects them)
       The service deployment status shows: IN_PROGRESS / degraded
       No alarm fires unless YOU configured one
       No rollback happens unless YOU trigger it or have circuit breaker enabled
```

**The service just sits in a degraded deployment state.** If you set minimumHealthyPercent=50, ECS might have stopped some v9 tasks already, and you're serving reduced capacity on v9 tasks while v10 tasks fail in a loop.

### The ECS Deployment Circuit Breaker

Added by AWS in 2020. This is the native mechanism for automatic rollback.

```hcl
resource "aws_ecs_service" "api" {
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
```

How it works:

```
ECS tracks the number of task launch failures in a deployment.

Failure threshold:
  - If more than 50% of the desired task count fails to start
    AND the same task has failed more than a threshold number of times
    (roughly: min(200, 10 * desired_count))

Then:
  - If rollback = true:  ECS automatically re-deploys the previous task definition
  - If rollback = false: ECS stops trying but does not roll back (deployment = FAILED)

Default state: circuit breaker disabled (you must explicitly enable it)
```

**The circuit breaker has limitations:**

1. It only triggers on task *launch* failures. If tasks start successfully but serve errors (5xx), the circuit breaker does nothing — that's an application-level failure, not an ECS-level failure.
2. Rollback via circuit breaker is still a rolling re-deploy of the old revision — not instant.
3. It does not integrate with ALB metrics (error rates, latency). Only ECS task health.

### External tooling for proper automatic rollback

For production-grade rollback on application-level errors:

**Option 1: CodeDeploy alarms**
Configure CloudWatch alarms on your service's error rate and latency. Attach these to the CodeDeploy deployment group. If an alarm fires during the bake period, CodeDeploy rolls back by shifting the ALB listener back to the blue target group. This is instant.

**Option 2: Lambda watcher**
A Lambda function triggered by CloudWatch Metric Alarms. If error_rate on the target group exceeds threshold, it calls `aws ecs update-service` with the previous task definition ARN. This is effectively scripted rolling rollback — not instant, but automated.

**Option 3: Deployment circuit breaker + CodeDeploy**
Use CodeDeploy for traffic shifting (blue/green) with CloudWatch alarms for application-level failures. Use the circuit breaker for task-level failures. Both are needed for full coverage.

---

## 7. Terraform for Each Pattern

### Rolling deployment — key blocks

```hcl
resource "aws_ecs_service" "betting_api" {
  name            = "betting-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.betting_api.arn
  desired_count   = 4

  deployment_controller {
    type = "ECS"  # default — rolling
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = 200  # allow up to 8 tasks during update
  deployment_minimum_healthy_percent = 100  # never drop below 4 healthy tasks

  health_check_grace_period_seconds = 120

  load_balancer {
    target_group_arn = aws_lb_target_group.betting_api.arn
    container_name   = "betting-api"
    container_port   = 8080
  }
}

resource "aws_lb_target_group" "betting_api" {
  name                 = "betting-api"
  port                 = 8080
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"  # required for Fargate; use "instance" for EC2 launch type
  deregistration_delay = 60    # seconds — tune based on max expected request duration

  health_check {
    path                = "/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}
```

### Blue/Green deployment — key blocks

Blue/green with CodeDeploy requires `deployment_controller = CODE_DEPLOY`. This means ECS hands off deployment orchestration to CodeDeploy. You no longer manage the task definition update directly in the ECS service — CodeDeploy does it.

**Implication for Terraform:** When `deployment_controller = CODE_DEPLOY`, Terraform must *ignore* the `task_definition` and `load_balancer` fields on the service, because CodeDeploy manages them at deploy time. If Terraform tries to manage them, it will fight with CodeDeploy.

```hcl
resource "aws_ecs_service" "betting_api_bg" {
  name          = "betting-api"
  cluster       = aws_ecs_cluster.main.id
  desired_count = 4

  # task_definition is managed by CodeDeploy — set once, then ignore_changes
  task_definition = aws_ecs_task_definition.betting_api.arn

  deployment_controller {
    type = "CODE_DEPLOY"
  }

  # Both target groups must be attached at service creation
  load_balancer {
    target_group_arn = aws_lb_target_group.blue.arn
    container_name   = "betting-api"
    container_port   = 8080
  }

  # Ignore changes that CodeDeploy manages
  lifecycle {
    ignore_changes = [
      task_definition,
      load_balancer,
    ]
  }
}

# Blue target group (initially receives production traffic)
resource "aws_lb_target_group" "blue" {
  name                 = "betting-api-blue"
  port                 = 8080
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 60

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    matcher             = "200"
  }
}

# Green target group (receives traffic during deployment, then swaps to production)
resource "aws_lb_target_group" "green" {
  name                 = "betting-api-green"
  port                 = 8080
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 60

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    matcher             = "200"
  }
}

# Production listener — CodeDeploy manages which TG this points to
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.blue.arn  # CodeDeploy will update this
  }

  lifecycle {
    ignore_changes = [default_action]  # CodeDeploy manages this
  }
}

# Test listener — always points to green, used for pre-traffic smoke tests
resource "aws_lb_listener" "test" {
  load_balancer_arn = aws_lb.main.arn
  port              = 8080
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.green.arn
  }

  lifecycle {
    ignore_changes = [default_action]
  }
}

# CodeDeploy application
resource "aws_codedeploy_app" "betting_api" {
  name             = "betting-api"
  compute_platform = "ECS"
}

# CodeDeploy deployment group
resource "aws_codedeploy_deployment_group" "betting_api" {
  app_name               = aws_codedeploy_app.betting_api.name
  deployment_group_name  = "betting-api-prod"
  service_role_arn       = aws_iam_role.codedeploy.arn

  deployment_config_name = "CodeDeployDefault.ECSCanary10Percent5Minutes"

  ecs_service {
    cluster_name = aws_ecs_cluster.main.name
    service_name = aws_ecs_service.betting_api_bg.name
  }

  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route {
        listener_arns = [aws_lb_listener.https.arn]
      }

      test_traffic_route {
        listener_arns = [aws_lb_listener.test.arn]
      }

      target_group {
        name = aws_lb_target_group.blue.name
      }

      target_group {
        name = aws_lb_target_group.green.name
      }
    }
  }

  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }

  alarm_configuration {
    alarms = [
      aws_cloudwatch_metric_alarm.betting_api_error_rate.name,
      aws_cloudwatch_metric_alarm.betting_api_p99_latency.name,
    ]
    enabled = true
  }

  # How long to keep old tasks alive after successful deployment (for emergency rollback)
  blue_green_deployment_config {
    deployment_ready_option {
      action_on_timeout    = "CONTINUE_DEPLOYMENT"
      wait_time_in_minutes = 0
    }

    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = 60  # keep blue alive for 60 min after success
    }
  }
}

# IAM role for CodeDeploy
resource "aws_iam_role" "codedeploy" {
  name = "codedeploy-ecs-betting-api"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "codedeploy.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "codedeploy_ecs" {
  role       = aws_iam_role.codedeploy.name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
}
```

### The ignore_changes pattern — why it matters

When you switch to CODE_DEPLOY, CodeDeploy becomes the source of truth for which task definition is running and which target group the listener points to. Terraform does not know about this — on the next `terraform plan`, it will see drift and try to set the task definition back to whatever is in state.

`ignore_changes` tells Terraform to stop tracking these fields. This is intentional and necessary — it is not a hack. Without it, every `terraform apply` after a CodeDeploy deployment would revert to the pre-deployment state.

This is a common point of confusion for teams migrating from rolling to blue/green. Document it explicitly in your team's runbooks.

---

## Key interview questions and how to answer them

**"What happens if you set minimumHealthyPercent=100 and maximumPercent=100?"**

ECS cannot make progress. It cannot start a new task (ceiling = current count) and cannot stop an old task (floor = current count). The deployment hangs indefinitely. You'd need to manually cancel and fix the configuration.

**"Does ECS automatically roll back if a deployment fails?"**

Only if you explicitly enable the deployment circuit breaker with `rollback = true`. By default, ECS keeps retrying failed task launches indefinitely. The service sits in a degraded state. For application-level failures (HTTP errors, latency), you need CodeDeploy alarms or external tooling — the circuit breaker only handles task launch failures.

**"What's the difference between the container health check startPeriod and the service health_check_grace_period_seconds?"**

`startPeriod` is in the task definition and governs the ECS agent's container-level health check — it prevents the agent from counting early failures during slow startup. `health_check_grace_period_seconds` is on the ECS service and tells ECS to ignore *ALB target group* health check results for N seconds after a task registers. They operate at different layers and both can be necessary simultaneously.

**"If Winamax deploys to 700 services, how do you manage the CodeDeploy setup at scale?"**

Terraform modules. You write a reusable module that takes the service name, cluster, task definition, alarms, and deployment strategy as inputs, and outputs all the CodeDeploy + target group + listener resources. Services opt into blue/green by passing `deployment_strategy = "blue-green"`. This is exactly the kind of developer enablement / self-service platform problem SRE teams solve.

**"Why not just use Kubernetes instead of ECS?"**

This question is a trap if you answer it technically. The right answer at Winamax: "Winamax has invested heavily in ECS, their operational tooling, runbooks, and team expertise are built around it. The control plane is different but the problems are the same. My job is to solve distributed systems problems — I'm solving them here with ECS primitives instead of Kubernetes primitives."
