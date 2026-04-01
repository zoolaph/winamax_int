# ECS Task Definition — Deep Operational Guide

---

## 1. Why JSON? Where does YAML fit?

ECS Task Definitions are **natively JSON**. This is because ECS is an AWS API — when you register a task definition, you are making an API call (`RegisterTaskDefinition`) and the payload is JSON. AWS stores it, versions it, and returns it as JSON.

**In practice nobody writes raw JSON by hand in production.** Here is how it actually works in the three environments you will encounter:

```
Development / learning      →  raw JSON file, deployed via AWS CLI
Staging / production        →  Terraform HCL, which contains the JSON inline or as a template
CI/CD pipeline              →  Terraform plan + apply, triggered by a git push
```

The JSON you see in the module is what gets sent to the AWS API. Terraform is the wrapper that manages the lifecycle of that call.

---

## 2. The logical blocks of a Task Definition

A task definition has **6 logical concerns**. Every field belongs to one of them.

```
┌─────────────────────────────────────────────────────────────┐
│  1. IDENTITY          Who is this task? What family/version?│
│  2. COMPUTE           How much CPU and memory?              │
│  3. NETWORKING        How does it connect to the network?   │
│  4. CONTAINERS        What runs inside? (the core block)    │
│  5. STORAGE           What volumes does it need?            │
│  6. OBSERVABILITY     Where do logs go?                     │
└─────────────────────────────────────────────────────────────┘
```

Let's go through each with full context.

---

### Block 1 — IDENTITY

```json
{
  "family": "betting-api",
  "taskRoleArn": "arn:aws:iam::123456789:role/betting-api-task-role",
  "executionRoleArn": "arn:aws:iam::123456789:role/ecsTaskExecutionRole"
}
```

**`family`**
The name of your task definition. Every time you register a new version, AWS appends `:1`, `:2`, `:3` etc. So `betting-api:7` means the 7th revision of the `betting-api` family. The family is the logical name; the revision is the immutable snapshot.

**`taskRoleArn`**
The IAM role your application code assumes at runtime. When your app calls `s3.getObject()`, the AWS SDK hits the link-local credentials endpoint `http://169.254.170.2/v2/credentials/<uuid>`. That endpoint returns temporary credentials for this role. If your app cannot call AWS services → check this role.

**`executionRoleArn`**
The IAM role the ECS Agent assumes before your container starts. The agent uses it to:
- Pull the Docker image from ECR
- Fetch secrets from Secrets Manager and inject them as environment variables
- Write stdout/stderr to CloudWatch Logs

If your task won't start at all, or the image fails to pull → check this role. This role must exist. It is usually shared across all services in a cluster (one `ecsTaskExecutionRole` per account/region).

---

### Block 2 — COMPUTE

```json
{
  "cpu": "1024",
  "memory": "2048",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc"
}
```

**CPU units:** 1024 units = 1 vCPU. Valid Fargate combinations are fixed pairs:
```
256 cpu  / 512–2048 MB memory
512 cpu  / 1024–4096 MB memory
1024 cpu / 2048–8192 MB memory
2048 cpu / 4096–16384 MB memory
4096 cpu / 8192–30720 MB memory
```
On EC2-backed ECS, you have more flexibility — you can specify fractional CPUs and larger memory.

**Task-level vs container-level resources:**
- Task-level `cpu` and `memory` = what the **scheduler uses for placement decisions**. "Is there an instance with 1024 CPU units free?"
- Container-level `cpu` and `memory` = what **Docker enforces via cgroups** at runtime. A container hitting its hard memory limit gets OOM-killed by the kernel.

On Fargate you must set both at task level. On EC2, task-level is optional but good practice.

**`requiresCompatibilities`**
Tells ECS whether this task definition is for `FARGATE`, `EC2`, or both. If you declare `FARGATE`, ECS enforces that `networkMode` must be `awsvpc`.

---

### Block 3 — NETWORKING

```json
{
  "networkMode": "awsvpc"
}
```

Three options exist. Only one matters for modern production:

| Mode | What it means | Use it? |
|------|--------------|---------|
| `awsvpc` | Each task gets its own ENI, own IP, own security group | **Yes — always** |
| `bridge` | Docker bridge networking, port mapping on the host | Legacy only |
| `host` | Container shares the EC2 host network interface | Rare, specific use cases |

`awsvpc` is the only mode that lets you apply per-task security group rules. It is required for Fargate. In production at scale (700+ microservices like Winamax), every service has its own security group and `awsvpc` is what makes that possible.

The actual subnet and security group assignment happens at **service** level, not task definition level. The task definition just declares the mode.

---

### Block 4 — CONTAINERS (the core block)

This is where most of the work is. A task definition can have multiple container definitions.

---

#### Required vs nice-to-have fields

```
REQUIRED (API will reject the task definition without these)
─────────────────────────────────────────────────────────────
  name          Unique identifier for this container within the task.
                Used by dependsOn, load balancer registration, and log stream names.

  image         Full URI of the Docker image.
                Must include registry, repo, and tag.
                ECR format: <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>

EFFECTIVELY REQUIRED (API accepts without them, but the task will misbehave)
─────────────────────────────────────────────────────────────────────────────
  essential     Defaults to true, but always set it explicitly.
                Controls whether this container's death kills the whole task.
                Main app: true. Sidecars: false.

  logConfiguration  Without this, stdout/stderr go nowhere — completely blind in prod.

  healthCheck   Without this, ECS has no signal about whether your app is actually
                serving traffic. It will mark tasks healthy as soon as the process starts,
                even if the app is crashing internally.

  portMappings  Required if this container receives any network traffic.
                Without it, the ALB cannot route to it.

NICE TO HAVE (used in production but not always needed)
────────────────────────────────────────────────────────
  cpu / memory          Container-level resource limits.
                        Required on Fargate. On EC2, omitting them means no cgroup
                        enforcement — a runaway container can starve others on the host.

  memoryReservation     Soft limit. Scheduler uses this for placement math.
                        Set this lower than memory (hard limit).
                        e.g. memory: 1024, memoryReservation: 768

  environment           Plaintext env vars. Fine for non-sensitive config.

  secrets               Sensitive values from Secrets Manager or SSM Parameter Store.
                        Fetched at task start by the agent using the executionRole.

  dependsOn             Controls startup ordering between containers in the same task.
                        Conditions: START, COMPLETE, SUCCESS, HEALTHY.

  stopTimeout           Seconds ECS waits after sending SIGTERM before sending SIGKILL.
                        Default: 30s. Increase if your app needs more time to drain connections.
                        Max: 120s on Fargate, 2 minutes on EC2.

  command               Overrides the Docker CMD. Useful when the same image runs
                        in different modes (e.g. worker vs web).

  entryPoint            Overrides the Docker ENTRYPOINT. Less common.

  workingDirectory      Sets the working directory inside the container.

  user                  Run the process as a specific user. Use this to avoid running as root.

  readonlyRootFilesystem  Mounts the container filesystem as read-only.
                          Security hardening — forces all writes to explicitly mounted volumes.

  ulimits               Override OS limits like max open file descriptors (nofile).
                        Important for high-connection services (Kafka consumers, proxies).

  mountPoints           Mount volumes declared at the task level into this container.

  linuxParameters       Advanced: add/drop Linux capabilities, configure tmpfs mounts,
                        set shared memory size. Rarely needed unless you have specific
                        OS-level requirements.
```

---

#### The two patterns you will see in production

**Pattern A — Single container (most microservices)**

```
containerDefinitions: [ app ]

All traffic goes to app. Simple, easy to reason about.
```

**Pattern B — App + sidecar**

```
containerDefinitions: [ app, otel-collector ]

app starts after otel-collector (dependsOn: START)
Both share the same network namespace → app sends traces to localhost:4317
otel-collector is essential: false → its crash does not kill the app
```

The sidecar shares the same network namespace as the app. Your app sends traces to `localhost:4317` as if it were a local process. This is identical to K8s sidecar containers.

---

#### Default template — production-ready main container

Use this as your starting point and remove what you do not need.

```json
{
  "name": "app",

  "image": "123456789.dkr.ecr.eu-west-1.amazonaws.com/my-service:REPLACE_TAG",

  "cpu": 512,
  "memory": 1024,
  "memoryReservation": 768,

  "essential": true,

  "portMappings": [
    {
      "containerPort": 3000,
      "protocol": "tcp"
    }
  ],

  "environment": [
    { "name": "NODE_ENV", "value": "production" },
    { "name": "PORT",     "value": "3000"        }
  ],

  "secrets": [
    {
      "name":      "DATABASE_URL",
      "valueFrom": "arn:aws:secretsmanager:eu-west-1:123456789:secret:prod/my-service/db-url-SUFFIX"
    }
  ],

  "healthCheck": {
    "command":     ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
    "interval":    30,
    "timeout":     5,
    "retries":     3,
    "startPeriod": 60
  },

  "stopTimeout": 30,

  "logConfiguration": {
    "logDriver": "awslogs",
    "options": {
      "awslogs-group":         "/ecs/my-service",
      "awslogs-region":        "eu-west-1",
      "awslogs-stream-prefix": "ecs"
    }
  }
}
```

---

#### Default template — sidecar container (OTel collector)

```json
{
  "name": "otel-collector",

  "image": "otel/opentelemetry-collector-contrib:0.96.0",

  "cpu": 128,
  "memory": 256,
  "memoryReservation": 128,

  "essential": false,

  "portMappings": [
    { "containerPort": 4317, "protocol": "tcp" },
    { "containerPort": 4318, "protocol": "tcp" }
  ],

  "command": ["--config=/etc/otel/config.yaml"],

  "mountPoints": [
    {
      "sourceVolume":  "otel-config",
      "containerPath": "/etc/otel",
      "readOnly":      true
    }
  ],

  "logConfiguration": {
    "logDriver": "awslogs",
    "options": {
      "awslogs-group":         "/ecs/my-service",
      "awslogs-region":        "eu-west-1",
      "awslogs-stream-prefix": "otel"
    }
  }
}
```

---

#### Field decisions to make explicit in an interview

**`memory` vs `memoryReservation`**
Set both. `memory` is the hard ceiling — the kernel OOM-kills the container if it exceeds this. `memoryReservation` is the soft reservation the scheduler uses to decide placement. Setting only `memory` means ECS plans capacity as if every container will always use its maximum — this leads to underutilized hosts and scheduling failures on EC2.

**`stopTimeout`**
The default is 30 seconds. If your service handles long HTTP requests, database transactions, or Kafka consumer commits, 30 seconds may not be enough to drain gracefully. Raise it to match your p99 request duration + a safety buffer. If you exceed it, the kernel sends SIGKILL — no cleanup, no graceful shutdown.

**`essential: false` on sidecars**
Always. An observability sidecar crashing should never take down production traffic. The app can run without traces; it cannot run without itself.

**`readonlyRootFilesystem: true`**
Security best practice. Forces your app to write only to explicitly declared volumes (tmpfs or EFS). Prevents an attacker from writing to the container filesystem if they get code execution. Not always possible if the app writes temp files — in that case add a tmpfs volume for `/tmp`.

---

### Block 5 — STORAGE

```json
{
  "volumes": [
    {
      "name": "app-tmp",
      "host": {}
    },
    {
      "name": "shared-data",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-0a1b2c3d",
        "rootDirectory": "/data"
      }
    }
  ]
}
```

And inside the container definition:
```json
{
  "mountPoints": [
    { "sourceVolume": "app-tmp", "containerPath": "/tmp/app" },
    { "sourceVolume": "shared-data", "containerPath": "/mnt/data", "readOnly": false }
  ]
}
```

**Three storage options:**

| Type | What it is | Durable? | Shared? |
|------|-----------|---------|--------|
| Ephemeral (default) | Local disk on the task's VM/host | No — gone when task stops | No |
| Bind mount | Directory on the host EC2 | Only while instance lives | Only containers in same task |
| EFS | Managed NFS | Yes — persists forever | Yes — across tasks and services |

For stateless services (most microservices) you need nothing here. For services that need shared config files or temporary scratch space, you use bind mounts. For services that need durable shared storage, you use EFS.

---

### Block 6 — OBSERVABILITY

```json
{
  "logConfiguration": {
    "logDriver": "awslogs",
    "options": {
      "awslogs-group": "/ecs/betting-api",
      "awslogs-region": "eu-west-1",
      "awslogs-stream-prefix": "ecs"
    }
  }
}
```

`awslogs` is the standard driver. Each task creates a log stream under the group:
```
/ecs/betting-api/ecs/app/<task-id>
```

**Other log drivers used in production:**

`awsfirelens` — routes logs through Fluent Bit (a sidecar container). Used when you need to:
- Ship to multiple destinations (CloudWatch + S3 + Datadog simultaneously)
- Filter or transform logs before shipping
- Avoid CloudWatch costs by routing high-volume logs to S3/Quickwit directly

At Winamax scale (75k msg/sec Kafka, 700+ services), they almost certainly use FireLens or a similar aggregation layer rather than raw `awslogs` for everything.

---

## 3. The complete task definition — assembled

Two versions below. The first is a stateless service (no volumes — the common case). The second adds a sidecar and a shared volume so you can see all blocks together.

---

### Version A — stateless service (no volumes needed)

Most microservices are stateless. They read from databases, write to queues, keep nothing on disk. No `volumes` block is needed and no `mountPoints` in the container. The absence of `volumes` is intentional, not an omission.

```json
{
  "family": "betting-api",
  "taskRoleArn": "arn:aws:iam::123456789:role/betting-api-task-role",
  "executionRoleArn": "arn:aws:iam::123456789:role/ecsTaskExecutionRole",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["EC2"],
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "123456789.dkr.ecr.eu-west-1.amazonaws.com/betting-api:1.2.3",
      "cpu": 512,
      "memory": 1024,
      "memoryReservation": 768,
      "essential": true,
      "portMappings": [
        { "containerPort": 3000, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT",     "value": "3000"        }
      ],
      "secrets": [
        {
          "name":      "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:eu-west-1:123456789:secret:prod/betting-api/db-url-AbCdEf"
        }
      ],
      "healthCheck": {
        "command":     ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval":    30,
        "timeout":     5,
        "retries":     3,
        "startPeriod": 60
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/betting-api",
          "awslogs-region":        "eu-west-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
  // No "volumes" block — stateless service, nothing to mount.
}
```

---

### Version B — app + OTel sidecar with shared config volume

Here the OTel collector needs a config file. The config is stored on the EC2 host (or baked into an S3-backed bind mount) and mounted into the sidecar container. The `volumes` block is at task level; `mountPoints` inside the container references it by name.

```json
{
  "family": "betting-api",
  "taskRoleArn": "arn:aws:iam::123456789:role/betting-api-task-role",
  "executionRoleArn": "arn:aws:iam::123456789:role/ecsTaskExecutionRole",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["EC2"],
  "cpu": "1024",
  "memory": "2048",

  "volumes": [
    {
      "name": "otel-config",
      "host": {
        "sourcePath": "/etc/ecs/otel-config.yaml"
      }
    }
  ],

  "containerDefinitions": [
    {
      "name": "app",
      "image": "123456789.dkr.ecr.eu-west-1.amazonaws.com/betting-api:1.2.3",
      "cpu": 512,
      "memory": 1024,
      "memoryReservation": 768,
      "essential": true,
      "dependsOn": [
        { "containerName": "otel-collector", "condition": "START" }
      ],
      "portMappings": [
        { "containerPort": 3000, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "NODE_ENV",         "value": "production" },
        { "name": "PORT",             "value": "3000"       },
        { "name": "OTEL_EXPORTER",    "value": "localhost:4317" }
      ],
      "secrets": [
        {
          "name":      "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:eu-west-1:123456789:secret:prod/betting-api/db-url-AbCdEf"
        }
      ],
      "healthCheck": {
        "command":     ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval":    30,
        "timeout":     5,
        "retries":     3,
        "startPeriod": 60
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/betting-api",
          "awslogs-region":        "eu-west-1",
          "awslogs-stream-prefix": "app"
        }
      }
    },
    {
      "name": "otel-collector",
      "image": "otel/opentelemetry-collector-contrib:0.96.0",
      "cpu": 256,
      "memory": 512,
      "memoryReservation": 256,
      "essential": false,
      "command": ["--config=/etc/otel/config.yaml"],
      "portMappings": [
        { "containerPort": 4317, "protocol": "tcp" }
      ],
      "mountPoints": [
        {
          "sourceVolume":  "otel-config",
          "containerPath": "/etc/otel",
          "readOnly":      true
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/betting-api",
          "awslogs-region":        "eu-west-1",
          "awslogs-stream-prefix": "otel"
        }
      }
    }
  ]
}
```

**Key things to notice in Version B:**
- `volumes` is a sibling of `containerDefinitions` — task level, not inside any container
- `mountPoints.sourceVolume` matches `volumes[].name` exactly — that's the link
- `app` has `dependsOn: otel-collector START` — the app waits for the sidecar to start before it boots, so traces are never dropped during startup
- Both containers log to the same CloudWatch group `/ecs/betting-api` but different stream prefixes (`app` vs `otel`) — easy to filter in the console
- `otel-collector` is `essential: false` — its crash does not stop the app

---

## 4. How multiple tasks are managed — the deployment lifecycle

### Where does desiredCount live?

NOT in the task definition. In the **Service**.

```
Task Definition  →  answers "what to run and how"
Service          →  answers "how many, where, and when to replace"
```

### What happens when you deploy a new version

```
Step 1: Developer merges to main
        CI/CD pipeline triggers

Step 2: Build new Docker image
        docker build -t betting-api:1.2.4 .

Step 3: Push to ECR
        docker push 123456789.dkr.ecr.eu-west-1.amazonaws.com/betting-api:1.2.4

Step 4: Register new task definition revision
        The only change: image tag 1.2.3 → 1.2.4
        AWS returns: betting-api:8  (was :7)

Step 5: Update the Service to use betting-api:8
        ECS begins the rolling deploy

Step 6: ECS launches new tasks (using :8)
        Waits for ALB health checks to pass
        Drains and stops old tasks (using :7)
```

**Nothing changes in the cluster or the service configuration.**
The only artifact that changes per deploy is the task definition revision and the image tag inside it.

### Rollback

```
# Point the service back to the previous revision
aws ecs update-service \
  --cluster prod-cluster \
  --service betting-api \
  --task-definition betting-api:7

# ECS immediately starts a rolling deploy back to :7
```

Because revisions are immutable, rollback is always safe. You are not reverting a mutation — you are pointing the service at a known-good snapshot.

---

## 5. The production file structure (Terraform)

In production, nobody registers task definitions or creates clusters by hand. It is all Terraform. Here is the typical file structure for one service:

```
infrastructure/
├── modules/
│   └── ecs-service/          ← reusable module, used by every service
│       ├── main.tf
│       ├── variables.tf
│       └── outputs.tf
├── environments/
│   ├── prod/
│   │   ├── main.tf           ← calls the module with prod values
│   │   ├── variables.tf
│   │   └── terraform.tfvars
│   └── staging/
│       └── main.tf
└── global/
    ├── cluster.tf            ← the ECS cluster itself
    ├── iam.tf                ← execution role, shared task roles
    └── alb.tf                ← the load balancer
```

### The cluster (created once, shared by all services)

```hcl
# global/cluster.tf

resource "aws_ecs_cluster" "main" {
  name = "prod-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"     # enables CloudWatch Container Insights metrics
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = "FARGATE"
  }
}
```

### The task definition

```hcl
# modules/ecs-service/main.tf

resource "aws_ecs_task_definition" "this" {
  family                   = var.service_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = aws_iam_role.task.arn

  # The container definitions are JSON embedded in HCL
  # jsonencode() converts HCL maps to JSON for the AWS API
  container_definitions = jsonencode([
    {
      name  = "app"
      image = "${var.ecr_repo_url}:${var.image_tag}"

      cpu    = var.container_cpu
      memory = var.container_memory

      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = var.environment },
        { name = "PORT",     value = tostring(var.container_port) }
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = var.db_url_secret_arn
        }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:${var.container_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = var.start_period
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/${var.service_name}"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  # Terraform tracks the lifecycle. When image_tag changes,
  # Terraform registers a new revision and updates the service.
  lifecycle {
    create_before_destroy = true
  }
}
```

### The service

```hcl
resource "aws_ecs_service" "this" {
  name            = var.service_name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn   # always points to latest revision
  desired_count   = var.desired_count

  # Deployment configuration
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Use the new rolling deployment controller
  deployment_controller {
    type = "ECS"   # options: ECS (rolling), CODE_DEPLOY (blue/green), EXTERNAL
  }

  # Health check grace period
  # Give tasks this many seconds before the service starts checking ALB health
  # Set to slightly more than your app startup time
  health_check_grace_period_seconds = var.health_check_grace_period

  # Networking — where to place tasks
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false    # tasks in private subnets, ALB in public
  }

  # Load balancer registration
  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "app"
    container_port   = var.container_port
  }

  # Autoscaling is configured separately via aws_appautoscaling_*
  # Do not manage desired_count manually if autoscaling is enabled
  lifecycle {
    ignore_changes = [desired_count]   # let autoscaling manage this
  }
}
```

### Autoscaling

```hcl
# Register the ECS service as a scalable target
resource "aws_appautoscaling_target" "this" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${var.cluster_name}/${var.service_name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# Target tracking policy — scale to keep CPU at 70%
resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.service_name}-cpu-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300   # wait 5 minutes before scaling in (conservative)
    scale_out_cooldown = 60    # scale out quickly to protect availability
  }
}

# Scheduled scaling — pre-scale for Champions League kickoff
resource "aws_appautoscaling_scheduled_action" "champions_league" {
  name               = "pre-scale-champions-league"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  schedule = "cron(30 20 ? * TUE,WED *)"   # 20:30 UTC on match days

  scalable_target_action {
    min_capacity = 20
    max_capacity = 50
  }
}
```

---

## 6. The CI/CD pipeline — end to end

In production the deploy pipeline is fully automated:

```
git push → main
    │
    ▼
GitHub Actions / GitLab CI
    │
    ├── 1. Run tests
    │
    ├── 2. docker build
    │       tag: git SHA  (e.g. abc1234)
    │       never use :latest
    │
    ├── 3. docker push → ECR
    │
    ├── 4. terraform plan
    │       only change: image_tag = "abc1234"
    │       plan shows: aws_ecs_task_definition will be updated
    │
    └── 5. terraform apply
            registers new task definition revision
            updates service → triggers rolling deploy
            ECS handles the rest
```

### How image_tag flows from the pipeline into a running container

This is the chain you need to be able to trace end to end.

**Step 1 — CI sets the variable**
```yaml
# .github/workflows/deploy.yml
- name: Deploy
  run: terraform apply -auto-approve
  env:
    TF_VAR_image_tag: ${{ github.sha }}   # e.g. "a3f9c12"
```

`TF_VAR_image_tag` is how you pass a Terraform variable from the environment. Terraform automatically reads any env var prefixed `TF_VAR_` as the matching variable.

**Step 2 — Terraform receives the variable**
```hcl
# modules/ecs-service/variables.tf
variable "image_tag" {
  type        = string
  description = "Docker image tag to deploy. Always a git SHA in production."
}
```

**Step 3 — Terraform embeds it into the task definition JSON**
```hcl
# modules/ecs-service/main.tf
container_definitions = jsonencode([
  {
    name  = "app"
    image = "${var.ecr_repo_url}:${var.image_tag}"
    # resolves to: "123456789.dkr.ecr.eu-west-1.amazonaws.com/betting-api:a3f9c12"
  }
])
```

`jsonencode()` converts the HCL map to a JSON string. Terraform calls `RegisterTaskDefinition` with that JSON. AWS stores it as a new revision.

**Step 4 — Terraform updates the service**
```hcl
resource "aws_ecs_service" "this" {
  task_definition = aws_ecs_task_definition.this.arn
  # .arn always points to the revision just created by this apply
  # e.g. arn:aws:ecs:eu-west-1:123456789:task-definition/betting-api:8
}
```

**Step 5 — ECS reads the revision, pulls the image, runs the container**
```
ECS scheduler reads betting-api:8
  → image: "123456789.dkr.ecr.eu-west-1.amazonaws.com/betting-api:a3f9c12"
ECS agent on the host calls ECR using executionRole
  → docker pull ...betting-api:a3f9c12
Container starts, app runs git commit a3f9c12
```

**The full chain:**
```
github.sha "a3f9c12"
  → TF_VAR_image_tag="a3f9c12"
    → var.image_tag in Terraform
      → jsonencode() → image field in JSON
        → RegisterTaskDefinition API → betting-api:8
          → aws_ecs_service.task_definition = betting-api:8
            → ECS pulls + runs the correct image
```

If a rollback is needed, you run `terraform apply` again with a previous SHA, or point the service directly at a previous revision number via the CLI. Either way the image tag is always traceable.

---

## 7. How to read a task definition in an interview

If the interviewer hands you a task definition JSON, work through it in this order:

```
1. family + revision       → what service, what version
2. executionRoleArn        → can the agent pull images and write logs?
3. taskRoleArn             → what AWS services can the app access?
4. networkMode             → awsvpc? bridge? (should be awsvpc)
5. cpu + memory            → is the allocation sensible for the workload?
6. image tag               → is it pinned? (:latest is a red flag)
7. environment vs secrets  → are secrets in environment? (red flag)
8. healthCheck.startPeriod → is it set? what's the app startup time?
9. logConfiguration        → where do logs go? awslogs or firelens?
10. essential flags        → do sidecars have essential: false?
```

**Common red flags to call out:**
- `:latest` image tag — you cannot roll back, you do not know what is running
- Secrets in `environment` instead of `secrets` — exposed in the AWS console and API
- No `startPeriod` on `healthCheck` — healthy apps get killed on slow startup
- `networkMode: bridge` — no per-task security groups, port conflicts on host
- No `memoryReservation` — scheduler cannot make accurate placement decisions
- `executionRoleArn` missing — task will fail to start on Fargate

---

## 8. Worked example — find the bugs

The interviewer hands you this task definition and asks: "This service keeps crashing in production. What do you see?"

Read it before looking at the answer.

```json
{
  "family": "payment-service",
  "executionRoleArn": "arn:aws:iam::123456789:role/ecsTaskExecutionRole",
  "networkMode": "bridge",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "3072",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "123456789.dkr.ecr.eu-west-1.amazonaws.com/payment-service:latest",
      "cpu": 512,
      "memory": 1024,
      "essential": true,
      "portMappings": [
        { "containerPort": 8080, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "NODE_ENV",     "value": "production" },
        { "name": "DB_PASSWORD",  "value": "s3cr3tpassword!" },
        { "name": "STRIPE_KEY",   "value": "sk_live_abc123xyz" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/payment-service",
          "awslogs-region":        "eu-west-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    },
    {
      "name": "otel-collector",
      "image": "otel/opentelemetry-collector:latest",
      "cpu": 256,
      "memory": 512,
      "essential": true,
      "portMappings": [
        { "containerPort": 4317, "protocol": "tcp" }
      ]
    }
  ]
}
```

---

**The bugs — and why each one matters in production:**

**Bug 1 — `networkMode: bridge` with `requiresCompatibilities: FARGATE`**
```
"networkMode": "bridge"          ← INVALID
"requiresCompatibilities": ["FARGATE"]
```
Fargate requires `awsvpc`. This task definition will be rejected by the API or fail at scheduling. It also means no per-task security groups, which is a security problem at scale.

---

**Bug 2 — Invalid Fargate CPU/memory combination**
```
"cpu": "512"
"memory": "3072"
```
Valid combinations for `512` CPU are: 1024, 2048, 3072, 4096 MB. So `3072` is actually valid here — but it is worth verifying. The common trap is `256 cpu / 1024 memory` (valid) vs `256 cpu / 2049 memory` (invalid). Always check the Fargate pairing table.

*(This one is not a bug — but you should say "I'd verify this against the Fargate pairing table" out loud.)*

---

**Bug 3 — `:latest` image tag on both containers**
```
"image": "...payment-service:latest"
"image": "otel/opentelemetry-collector:latest"
```
Two problems:
- You cannot roll back. If `:latest` breaks, pointing the service at the previous task definition revision still pulls `:latest` — which is still broken.
- You do not know what is running. `latest` changes silently on every push.

Fix: pin to a specific git SHA for your app image, a specific version for third-party images (`otel/opentelemetry-collector:0.96.0`).

---

**Bug 4 — Secrets in `environment` instead of `secrets`**
```json
{ "name": "DB_PASSWORD", "value": "s3cr3tpassword!" },
{ "name": "STRIPE_KEY",  "value": "sk_live_abc123xyz" }
```
These are now stored in plaintext inside the task definition. Anyone with `ecs:DescribeTaskDefinition` IAM permission — which is often broadly granted — can read them. They also appear in CloudTrail logs and the AWS console.

Fix: move to `secrets`, store values in Secrets Manager, reference by ARN.

---

**Bug 5 — Missing `startPeriod` on health check**
```json
"healthCheck": {
  "command": [...],
  "interval": 30,
  "timeout": 5,
  "retries": 3
  // startPeriod missing — defaults to 0
}
```
If `payment-service` takes more than `timeout × retries = 15 seconds` to boot, ECS will kill it before it is ready. The service then loops: start → kill → start → kill. This is a very common cause of "tasks keep crashing" in production.

Fix: set `startPeriod` to slightly above the p99 cold-start time of the app.

---

**Bug 6 — `otel-collector` sidecar is `essential: true`**
```json
{
  "name": "otel-collector",
  "essential": true    ← wrong for a sidecar
}
```
If the OTel collector crashes or restarts, ECS stops the entire task — including the payment service. Observability infrastructure should never take down production traffic.

Fix: `"essential": false` on the sidecar. The app keeps running even if the sidecar is unhealthy.

---

**Also missing — `taskRoleArn`**
The payment service almost certainly needs to call AWS services (Secrets Manager at minimum, probably SQS or DynamoDB). Without a task role, those calls will fail with 403. This was probably omitted by accident.

---

**Summary of findings:**
```
Critical  → networkMode incompatible with Fargate        (task won't start)
Critical  → secrets in environment                        (security breach)
High      → missing startPeriod on health check           (boot-loop risk)
High      → otel-collector essential: true                (sidecar kills payment traffic)
Medium    → :latest on both images                        (no rollback, unknown version)
Low       → taskRoleArn missing                           (app cannot call AWS services)
```

---

## 9. How to write a task definition in an interview

Use this mental checklist:

```
□ family name
□ executionRoleArn  (agent needs: ECR pull, CloudWatch write, Secrets Manager read)
□ taskRoleArn       (app needs: whatever AWS services it calls)
□ networkMode: awsvpc
□ requiresCompatibilities: [FARGATE] or [EC2]
□ task-level cpu and memory (must be valid Fargate pair if Fargate)
□ container name, image with pinned tag
□ container cpu and memory
□ portMappings
□ environment (plaintext config only)
□ secrets (anything sensitive — DB URLs, API keys, tokens)
□ healthCheck with startPeriod
□ logConfiguration (awslogs at minimum)
□ essential: true on main container
```

Start with identity (family, roles), then compute, then the container block. This is how interviewers read it too — top to bottom mirrors the conceptual layers.
