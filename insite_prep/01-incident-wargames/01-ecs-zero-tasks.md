# Wargame 01 — ECS Service: 0/10 Tasks Running

## The scenario

It is 14:47. A PagerDuty alert fires:

```
CRITICAL: ECS Service HealthyTaskCount = 0
Service: bet-validator
Cluster: winamax-prod
Desired: 10 | Running: 0 | Pending: 0
```

The service was redeployed 8 minutes ago as part of a routine release. It was running fine before the deploy. There are no other alerts.

---

## Your job

Talk through your full diagnosis out loud. Cover:
1. What is your first action?
2. What are the three most likely causes given the context?
3. What do you check first and what output are you looking for?
4. How does each cause present differently?
5. What is the fix for each?

**Do not scroll down until you have spoken for at least 3 minutes.**

---
---
---
---
---
---

## Diagnosis path

### Step 1 — Read the stopped reason

Go to ECS console → bet-validator service → Tasks tab → filter by Stopped. Click the most recently stopped task. The "Stopped reason" field almost always tells you the root cause directly.

Alternatively via CLI:

```bash
aws ecs describe-tasks \
  --cluster winamax-prod \
  --tasks $(aws ecs list-tasks --cluster winamax-prod --service-name bet-validator --desired-status STOPPED --query 'taskArns[0]' --output text) \
  --query 'tasks[0].{StoppedReason: stoppedReason, Containers: containers[*].{Name: name, Reason: reason, ExitCode: exitCode}}'
```

### Step 2 — Match the stopped reason to a cause

**Cause A: Image pull failure**

Stopped reason:
```
CannotPullContainerError: pull image manifest has been retried 1 time(s):
failed to resolve ref "123456789.dkr.ecr.eu-west-3.amazonaws.com/bet-validator:abc1234":
unexpected status code 403 Forbidden
```

Root cause: execution role missing ECR permissions, or the image tag does not exist in ECR.

Check:
```bash
# Does the image tag exist?
aws ecr describe-images \
  --repository-name bet-validator \
  --image-ids imageTag=abc1234

# Does the execution role have ECR permissions?
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::123456789:role/bet-validator-execution-role \
  --action-names ecr:GetAuthorizationToken ecr:BatchGetImage ecr:GetDownloadUrlForLayer \
  --resource-arns '*'
```

Fix: attach `AmazonECSTaskExecutionRolePolicy` to the execution role, or add the specific ECR permissions. If image tag missing: the CI pipeline did not push the image before the deploy triggered.

---

**Cause B: Container exits immediately (application crash)**

Stopped reason:
```
Essential container in task exited
```

Exit code: non-zero (1, 127, 137, etc.)

This means the container started but the application crashed. The stopped reason on the container level tells you the exit code.

Check CloudWatch Logs:
```bash
aws logs get-log-events \
  --log-group-name /ecs/bet-validator \
  --log-stream-name ecs/bet-validator/<task-id> \
  --limit 50
```

Common causes in this category:
- Missing environment variable or secret (startup config error)
- Wrong `CMD` in Dockerfile (exit code 127 = command not found)
- Application panic on startup (database unreachable, schema mismatch)
- OOM on startup (exit code 137 = killed by kernel)

Fix depends on exit code and log output. For a missing secret: check the task definition's `secrets` block and verify the secret ARN exists in Secrets Manager.

---

**Cause C: Health check failing**

Tasks reach RUNNING state but the ALB health check fails, so ECS keeps replacing them. You would see tasks cycling — briefly running, then stopped.

Stopped reason:
```
Task failed ELB health checks in (target-group arn:aws:elasticloadbalancing:...)
```

Check:
```bash
# What is the health check path and expected status code?
aws elbv2 describe-target-groups \
  --query 'TargetGroups[?TargetGroupName==`bet-validator`].HealthCheckPath'

# Are the tasks registering as targets at all?
aws elbv2 describe-target-health \
  --target-group-arn <arn>
```

Common causes:
- The health check path changed (`/health` → `/healthz`) and the ALB still checks the old path
- The app returns 200 only after a warm-up period that exceeds `healthCheckGracePeriodSeconds`
- The app listens on port 8080 but the task definition maps the health check to port 80

Fix: update the ALB target group health check path, or increase `healthCheckGracePeriodSeconds` in the ECS service definition.

---

**Cause D: No capacity / placement failure**

Stopped reason:
```
Scaling activity initiated by (deployment ecs-svc/...). 
No Container Instances were found in your capacity providers.
```

Or for Fargate:
```
ResourceInitializationError: unable to pull secrets or registry auth: ...
```

The cluster has no available capacity to place the task. On EC2-backed clusters: the ASG has not scaled up yet. On Fargate: the task definition requests more CPU/memory than a Fargate tier supports.

Check:
```bash
aws ecs describe-clusters \
  --clusters winamax-prod \
  --include STATISTICS
```

---

**Cause E: Networking/secrets failure before container starts**

Stopped reason:
```
ResourceInitializationError: unable to pull secrets or registry auth:
execution resource retrieval failed: unable to retrieve secret from SSM:
service call has been retried 1 time(s):
RequestError: send request failed
```

The ECS agent cannot reach Secrets Manager or SSM. This is a network issue — the task's subnet has no route to the service endpoint.

Check: does the subnet have a route to a NAT Gateway or a VPC endpoint for Secrets Manager?

```bash
aws ec2 describe-route-tables \
  --filters Name=association.subnet-id,Values=<subnet-id>
```

---

### Step 3 — Fix and verify

After fixing, force a new deployment:
```bash
aws ecs update-service \
  --cluster winamax-prod \
  --service bet-validator \
  --force-new-deployment
```

Watch tasks come up:
```bash
aws ecs wait services-stable \
  --cluster winamax-prod \
  --services bet-validator
```

---

## Follow-up questions they will ask

**"The stopped reason says CannotPullContainerError but the execution role looks correct. What else could cause a 403 from ECR?"**

The ECR repository policy. In addition to the execution role's IAM policy, the ECR repository itself has a resource-based policy. If that policy explicitly denies access from the task's account or role, it overrides the identity policy. Check the repository policy directly.

**"Tasks are running but the service shows 0 healthy. How is that different from 0 running?"**

Running means ECS considers the container healthy at the ECS level. Healthy means the ALB target group health check is passing. You can have 10 running tasks with 0 healthy — the containers are up but not passing the HTTP health check. The service will keep replacing them until health checks pass or the deployment fails.

**"How would you prevent this class of failure in your deployment pipeline?"**

Smoke test in CI before triggering the ECS deployment: verify the image exists in ECR, verify the secret ARNs referenced in the task definition exist in Secrets Manager, and optionally run the container locally with the same env to catch startup crashes. After the deploy, verify `running_count == desired_count` before marking the pipeline green.
