# Module 1 — AWS ECS & Container Runtime Operations

**Why this is first:** ECS is the single biggest gap between your background and this role. Everything else you can bridge from existing knowledge. ECS requires building a new mental model. Do this first while you are fresh.

---

## Part 1: Concept — How ECS works

### The three-layer model
See `01-three-layer-model.md` for the full architecture diagram — cluster, service, task, task definition, traffic flow, and rolling deploy sequence with K8s mapping.

**The one thing to keep sharp here — what the Service actually does:**

- The Service is not just a counter. It is a reconciliation controller that simultaneously manages desired count, runs the placement algorithm against the capacity pool, and coordinates with the ALB to register/deregister task IPs.
- The Cluster is not a host — it is a scheduling boundary and capacity pool. The ECS Agent on each EC2 instance is what registers available CPU/memory into that pool.

Do not describe ECS layers as "buckets that contain things." Describe what each layer does.

---
### EC2-backed ECS vs Fargate

| | EC2-backed ECS | Fargate |
|--|--|--|
| You manage | EC2 instances, AMIs, ASG, ECS agent | Nothing (serverless) |
| Cost model | Pay for instances (running or idle) | Pay per vCPU/memory per second |
| Startup time | Fast (container pulls on pre-warmed hosts) | Slower (cold start includes VM provisioning) |
| Customization | Full OS access, custom instance types, GPU | None — locked OS |
| Winamax likely uses | **EC2 for steady high-traffic services** | Fargate for batch/background tasks |

**Key insight for Winamax:** At 75,000 msg/sec and 900k bets/day, cold-start variance matters. Steady-traffic, latency-sensitive services want pre-warmed EC2-backed tasks. Fargate fits batch workloads (Airflow workers, AWS Batch) where you do not care about a few seconds of startup.

---

### Task Definitions in depth

See `01-ecs-taskdef-deep.md` for the full operational guide — required vs optional fields, production templates, Terraform, the CI/CD image tag flow, and a worked broken-file exercise.

**The one thing to keep sharp here — the two IAM roles:**
- `executionRoleArn` — used by the **ECS agent** before the container starts: pull image from ECR, write logs to CloudWatch, fetch secrets from Secrets Manager. If the task won't start → check this role.
- `taskRoleArn` — used by the **application code** at runtime via `http://169.254.170.2`: call S3, DynamoDB, SQS, etc. If the app gets 403s on AWS API calls → check this role.

This is a common interview trap. Do not confuse them.

---

### Health checks and failure replacement

ECS services monitor task health. When a task fails its health check or exits, ECS replaces it automatically.

**Two layers of health checks:**
1. **ECS health check** — defined in the task definition, runs inside the container
2. **ALB health check** — the load balancer probes the target group endpoint

A task must pass the ALB health check before ECS routes traffic to it. If it fails the ECS health check, ECS kills it and starts a replacement.

**`startPeriod`** gives the container time to warm up before the health check counts failures. Set this to slightly more than your app's startup time. Forgetting this causes healthy apps to be killed on startup.

---

### Rolling deployments

See `01-ecs-deployments-deep.md` for the full guide — minimumHealthyPercent/maximumPercent math, blue/green via CodeDeploy, canary with weighted target groups, and rollback comparison.

**The one thing to keep sharp here — rolling is not always enough:**

- Rolling deploy rollback = re-deploy the old revision (takes minutes, traffic hits bad code during the window).
- Blue/green rollback = flip the ALB target group pointer (takes seconds, zero exposure).
- For the core betting and payment path, blue/green is the right answer. For stateless background services, rolling is fine.

The deployment circuit breaker detects task launch failures, not application errors. A bad deploy that starts but returns 500s will not trigger it.

---
### Autoscaling
See `01-ecs-autoscaling-deep.md` for the full guide — target tracking math, step scaling, scheduled scaling, Cluster Auto Scaling, custom Kafka lag metrics, and what autoscaling won't save you from.

**The one thing to keep sharp here — there are two levels:**

- Level 1 — ECS Service Auto Scaling: adds or removes Tasks. Fast (seconds to minutes).
- Level 2 — EC2 ASG / Cluster Auto Scaling: adds or removes EC2 instances to give Tasks somewhere to land. Slow (5+ minutes for EC2 boot).

If you only configure Level 1, scale-out stalls the moment the cluster runs out of capacity. Pre-scale for Champions League with a scheduled action that sets a floor — do not rely on reactive autoscaling to absorb an instant spike.

---
### Lambda — when and why

See `01-ecs-lambda-deep.md` for the full guide — execution environment lifecycle, cold start causes and mitigations, concurrency model, event source retry behavior, VPC Lambda costs, and the full Lambda vs ECS decision framework.

**The one thing to keep sharp here — the decision is about execution model, not just duration:**

- Lambda does not maintain warm connection pools. A Lambda hitting Aurora on every invocation re-establishes the connection each time (use RDS Proxy to mitigate).
- Cold start on a VPC Lambda includes ENI provisioning — can add hundreds of milliseconds. Not acceptable on the core betting path.
- At Winamax: Lambda fits notifications, S3 event processing, scheduled checks, and glue code. It does not fit the core betting API, Kafka consumers at 75k msg/sec, or anything needing predictable sub-50ms latency.

---

## Part 2: Why Winamax cares

Winamax runs **thousands of service instances in parallel** on AWS. ECS is their runtime. When they interview you, they need confidence you can:

1. Debug why a task keeps dying and not getting traffic
2. Safely deploy a new version of a critical service without downtime
3. Design autoscaling for a service that sees 10x traffic spikes during major sports events
4. Reason about the right compute type for a given workload
5. Write and review task definitions in Terraform

These are not theoretical — they are the day-to-day operational questions for this role.

---

## Part 3: Bridge from Kubernetes

You already know everything conceptually. You just need to map the terminology and learn the operational tools.

| Kubernetes | ECS equivalent |
|--|--|
| Pod | Task |
| Deployment | ECS Service |
| ReplicaSet | ECS Service desired count management |
| Node | EC2 instance (in a cluster) |
| Namespace | ECS Cluster (roughly) |
| HPA | ECS Service Auto Scaling |
| Liveness probe | ECS health check |
| Readiness probe | ALB target group health check |
| ConfigMap | Task Definition environment vars / SSM |
| Secret | AWS Secrets Manager / SSM SecureString |
| ServiceAccount | Task Role (IAM) |
| Container Registry | ECR |
| kubectl rollout status | `aws ecs describe-services` + watching events |
| kubectl logs | CloudWatch Logs (`awslogs` driver) |
| kubectl exec | ECS Exec (SSM-based shell into running task) |

**The key difference:** Kubernetes has a rich control plane with its own API server, etcd, and controllers. ECS is thinner — AWS manages the control plane for you, and you interact via AWS APIs. Less control, less operational overhead.

---

## Part 4: Hands-on exercise

Go to `exercises/01-ecs/` for the lab.

**Quick exercise (no AWS account needed):**

Write a task definition JSON for a Node.js service called `betting-api` that:
- Runs image from ECR (region eu-west-1, account 123456789)
- Needs 1 vCPU (1024 CPU units) and 2 GB RAM
- Exposes port 3000
- Has an environment variable `NODE_ENV=production`
- Reads `DATABASE_URL` from Secrets Manager
- Logs to CloudWatch under `/ecs/betting-api`
- Has a health check hitting `GET /health` on port 3000
- Gives the app permission to read from S3 (choose appropriate role)

Answer template in `exercises/01-ecs/task-definition.json`

---

## Part 5: Interview Q&A

**Q: What is the difference between a Task and a Service in ECS?**

A Task is a single running instance — one or more containers, ephemeral, like a K8s Pod. A Service is the controller that maintains a desired count of Tasks, replaces failed ones, manages rolling deployments, and integrates with load balancers. You define a Task Definition once; the Service ensures that the right number of Tasks based on that definition are always running.

---

**Q: What are the two IAM roles in an ECS task definition and what is the difference?**

The execution role is used by the ECS agent itself — to pull the container image from ECR, write logs to CloudWatch, and fetch secrets at startup. The task role is used by the application code at runtime — to call AWS services like S3, DynamoDB, or SQS. If your app cannot access S3, check the task role. If your task cannot start because it cannot pull the image, check the execution role.

---

**Q: A new deployment is stuck — tasks keep starting, failing health checks, and being replaced. How do you debug it?**

First, look at the ECS service events — these tell you what ECS is seeing (task started, health check failed, task stopped). Second, look at the CloudWatch logs for the container itself — did the app crash? Did it throw an error on startup? Third, check whether the ALB health check is configured with a long enough timeout and the right path. Fourth, check startPeriod in the task definition — if the app takes 30 seconds to start and startPeriod is 0, ECS will kill it before it is ready. Finally, check IAM — if the task cannot connect to the database or read a secret, it may fail silently.

---

**Q: How would you handle a 10x traffic spike during a Champions League final?**

Two strategies. First, pre-scale: if you know the game kicks off at 21:00, add a scheduled scaling action at 20:30 to pre-scale to your expected peak capacity. This avoids the lag between the spike starting and autoscaling catching up. Second, verify your autoscaling ceiling is set correctly and your metrics alarm period is short enough to react quickly. Beyond ECS, make sure the ALB target group has enough connection headroom, and that upstream dependencies like the database and Kafka can absorb the load — ECS scaling alone does not help if Aurora hits its connection limit.

---

**Q: When would you choose Lambda over ECS for a Winamax workload?**

Lambda fits short-lived, event-driven, spiky-with-idle-periods workloads — think: processing a file uploaded to S3, reacting to a DynamoDB stream event, or handling a webhook. For Winamax, I'd consider Lambda for things like: sending notifications when a bet is settled, running data quality checks on a schedule, or gluing together AWS services in a pipeline. I would NOT use Lambda for the core betting or poker service path — those need predictable latency, warm connection pools, and long-running process models that Lambda does not support well.

---

**Q: How does ECS handle zero-downtime deployments?**

ECS uses minimum/maximum health percentages on the service to control the rollout. With minimumHealthyPercent=100 and maximumPercent=200, ECS launches the full new set of tasks, waits until they pass health checks and are registered with the load balancer, then drains and terminates the old tasks. The ALB stops routing to a task as soon as it enters draining state and waits for in-flight connections to complete before the task is stopped. This is equivalent to a Kubernetes rolling update — the key is that the load balancer is the arbiter of when traffic switches, not the container start time.
