# ECS Interview Q&A

This is the missing module from the course. These are the questions you will be asked at Stage 2 and Stage 3. Answers are written in interview voice — direct, operational, connected to Winamax's context.

---

## Q1: Walk me through how a rolling deployment works in ECS

**Answer:**

When you update an ECS service — either a new task definition or a config change — ECS starts a rolling deploy. The behavior is controlled by two parameters: `minimumHealthyPercent` and `maximumPercent`.

With `minimumHealthyPercent=100` and `maximumPercent=200`, ECS first starts new tasks bringing the total to 2x desired count. It waits for the new tasks to pass ALB health checks. Only once a new task is healthy does ECS stop one of the old tasks. It repeats this until all old tasks are replaced.

At no point does capacity drop below 100% — the old tasks keep serving traffic until the new ones are verified healthy. Zero downtime.

The deployment circuit breaker is the safety net: if new tasks consistently fail health checks or crash before the rollout completes, ECS automatically rolls back to the previous task definition. No human intervention.

The failure mode to watch: if `healthCheckGracePeriodSeconds` is too short and the app takes 30 seconds to warm up, ECS will mark the task as unhealthy before it is ready, the circuit breaker fires, and you get an automatic rollback that looks like a bug when it is actually a configuration issue.

---

## Q2: What is the difference between EC2-backed ECS and Fargate? When would Winamax use each?

**Answer:**

Fargate is serverless — AWS manages the underlying compute. You specify CPU and memory in the task definition and Fargate provisions isolated compute per task. You have no EC2 instances to patch, no capacity to manage.

EC2-backed ECS runs tasks on EC2 instances that you provision and manage. The ECS agent on each instance registers available capacity into the cluster pool, and ECS places tasks based on available CPU and memory.

For Winamax specifically: at 900,000 bets/day with sustained high throughput, EC2-backed ECS is likely used for latency-sensitive, high-traffic services. The reason is cold start behavior. When autoscaling triggers on Fargate, provisioning the task includes allocating a new VM. This takes 5-15 seconds versus sub-second for a container starting on a pre-warmed EC2 host. During a major match spike, that cold start time matters.

Fargate makes sense for batch workloads — Airflow workers, data pipeline tasks, AWS Batch — where a few seconds of cold start is irrelevant. It also makes sense for services with spiky, infrequent traffic where you do not want to pay for idle EC2 capacity.

---

## Q3: How does ECS autoscaling work? What are the two layers and why do you need both?

**Answer:**

There are two layers of scaling and they operate independently.

The first layer is ECS Service Auto Scaling — this scales the number of ECS tasks. You define scaling policies (target tracking on CPU utilization, request count per task, or custom metrics via Application Auto Scaling). ECS adds or removes tasks within the desired count bounds you configure.

The second layer is the EC2 Auto Scaling Group — this scales the number of EC2 instances in your cluster. The ECS Capacity Provider connects these two layers. When ECS wants to place more tasks but there is no available capacity (not enough free CPU/memory on existing instances), it signals the capacity provider to add more EC2 instances.

You need both because tasks run on instances. If you scale tasks but not instances, ECS will queue tasks in PENDING state — they are requested but no host can accept them. Conversely, if you scale instances but not tasks, you have capacity sitting idle.

With Fargate you only have the first layer — ECS Service Auto Scaling. AWS manages the compute layer automatically. This is one reason Fargate is simpler operationally.

---

## Q4: An ECS service shows PENDING tasks that never become RUNNING. What do you investigate?

**Answer:**

PENDING means ECS has scheduled the task but cannot place it on any instance — or in Fargate, cannot provision the compute.

First I check the service events:
```bash
aws ecs describe-services --cluster winamax-prod --services bet-validator \
  --query 'services[0].events[:5]'
```

The events almost always tell you why placement is failing.

**Common causes:**

If the message is "no container instances found": the EC2 ASG has not scaled up yet. Check if the capacity provider is configured and whether the ASG scaling policy is active.

If "insufficient memory" or "insufficient CPU": all instances are busy. Tasks are queued waiting for capacity. Either scale up the ASG or scale down the task's resource requirements.

If the error is about placement constraints: you have a spread or affinity constraint that cannot be satisfied. For example, `distinctInstance` requires at least as many instances as desired tasks. With 10 tasks and 3 instances, you can only place 3 tasks with `distinctInstance`.

For Fargate, a task stuck in PENDING usually means the task definition is requesting more CPU or memory than any valid Fargate tier (the valid combinations are specific — e.g., 4 vCPU requires at least 8GB memory).

---

## Q5: How does ECS service discovery work? What are the options?

**Answer:**

ECS has two mechanisms for service-to-service communication.

The older approach is ALB-based. Each service gets an internal ALB. Other services call the ALB DNS name. This gives you load balancing and health checking but adds latency (ALB hop) and cost (one ALB per service adds up at 700 services).

The newer approach is ECS Service Connect, which builds on Cloud Map. Each service registers its tasks in Cloud Map with DNS names. Services call each other via a local proxy that ECS injects as a sidecar. The proxy handles load balancing, retries, and observability at the sidecar level. No separate ALB needed for internal traffic.

For Winamax at 700 services: Service Connect is the architecturally cleaner solution for internal traffic. ALBs are reserved for external-facing services that need the full feature set (WAF, advanced routing, SSL termination at the load balancer).

The third option — direct IP via Cloud Map — is simpler but requires each service to handle its own load balancing and health checking logic. Not recommended at scale.

---

## Q6: How do you do zero-downtime secrets rotation for a running ECS service?

**Answer:**

The challenge: ECS injects secrets from Secrets Manager at task launch time. A running task holds the old secret value. If you rotate the secret in Secrets Manager, running tasks do not automatically pick up the new value.

The rotation procedure:

First, rotate the secret in Secrets Manager. The rotation Lambda creates a new version of the secret. Running tasks still hold the old version — this is fine, the old version remains valid during the rotation window.

Second, force a new ECS deployment. This registers a new task definition revision (or just triggers a rolling deploy). New tasks start, pulling the new secret value from Secrets Manager at launch. Old tasks drain their connections and stop.

Third, after all old tasks are replaced and the new tasks are healthy, complete the rotation in Secrets Manager — mark the old version as deprecated. It can now be safely deleted.

The key point: you need a rotation window during which both old and new secret values are simultaneously valid. For a database password rotation, this means the database must accept both passwords briefly. Aurora supports this via a two-step rotation: create new password, test it, then invalidate the old one.

For API keys: same pattern. Keep old key active until all tasks are replaced, then revoke it.

---

## Q7: Walk me through the ECS task lifecycle — from `docker pull` to `RUNNING`

**Answer:**

When ECS decides to start a task — due to a new deployment, autoscaling, or a failed task being replaced — this is the sequence:

ECS scheduler picks a host (or Fargate allocates compute). The ECS agent on that host receives the task definition.

The agent uses the execution role to pull the container image from ECR. It calls `ecr:GetAuthorizationToken` to get temporary credentials, then pulls the image layers.

If the task definition references secrets in Secrets Manager or SSM, the agent resolves them using the execution role. The resolved values are injected as environment variables into the container at launch.

The agent starts the container. The container's `CMD` or `ENTRYPOINT` runs.

If the task definition has a health check, Docker runs it on the configured interval. When the health check passes enough times, the task transitions to HEALTHY.

If there is an ALB target group, the ECS agent registers the task's private IP and container port as a target. The ALB begins routing traffic after the ALB's own health check passes (separate from the ECS health check).

Total time from "start task" to "receiving traffic": typically 30-90 seconds depending on image size, secret count, and app warm-up time.

---

## Q8: What is the ECS task metadata endpoint and why does it matter?

**Answer:**

The task metadata endpoint is an HTTP endpoint available at `http://169.254.170.2` within every ECS task. It serves two purposes.

First, it provides IAM credentials for the task role. When the application calls the AWS SDK and needs to sign a request, the SDK calls `http://169.254.170.2/v4/credentials` and receives temporary credentials scoped to the task role. This is how the application accesses S3, SQS, DynamoDB, and other AWS services without any long-lived access keys.

Second, it provides task metadata: the task's ARN, cluster name, container information, and resource limits. This is useful for the application to tag its own metrics and logs with infrastructure context.

This is the ECS equivalent of EC2 instance metadata (`http://169.254.169.254`). In Kubernetes terms, it is comparable to the Kubernetes downward API plus IRSA — the application gets both its identity and its environment context from a local endpoint.

The security implication: if an application is vulnerable to SSRF, an attacker can use it to call the metadata endpoint and steal the task role credentials. This is why task role permissions must be scoped as tightly as possible.
