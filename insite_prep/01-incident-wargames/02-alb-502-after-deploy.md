# Wargame 02 — ALB 502 After Terraform Apply + ECS Deploy

## The scenario

It is 16:22. Two things happened in the last 15 minutes:
- A Terraform apply ran against `prod/services/bet-validator` (security group and task definition changes)
- A new ECS deployment started immediately after

Current state:
```
ALB: bet-validator-alb
  HTTP 502 error rate: 94%
  Healthy target count: 0
  
ECS Service: bet-validator
  Desired: 8 | Running: 8 | Pending: 0
```

The tasks show as running. The ALB shows 0 healthy targets. Bets are failing.

---

## Your job

1. The tasks are running but the ALB says 0 healthy. What are the possible explanations?
2. What is the first thing you check and why?
3. Terraform changed security groups and task definition. Which of those is more likely to cause this specific symptom?
4. Walk through your full diagnosis and fix.

**Do not scroll down until you have spoken through all four points.**

---
---
---
---
---
---

## Diagnosis path

### Why "tasks running + 0 healthy" is a specific failure mode

Running in ECS and healthy in ALB are checked by different components:
- ECS running = the container process started and is alive at the ECS agent level
- ALB healthy = the ALB made an HTTP request to the task's IP:port and got the expected response

You can have tasks running but be unhealthy to the ALB if:
1. The security group blocks the ALB's health check probe
2. The app is listening on the wrong port
3. The health check path returns a non-200 status
4. The health check grace period expired before the app was ready
5. The task IP is not registered in the target group

### Step 1 — Check the ALB target health details

```bash
aws elbv2 describe-target-health \
  --target-group-arn <bet-validator-tg-arn> \
  --query 'TargetHealthDescriptions[*].{IP: Target.Id, Port: Target.Port, State: TargetHealth.State, Reason: TargetHealth.Reason, Description: TargetHealth.Description}'
```

The `Reason` field will be one of:
- `Elb.InternalError` — ALB cannot reach the target at all (SG or routing issue)
- `Target.FailedHealthChecks` — ALB reached the target but got wrong status or timeout
- `Target.NotRegistered` — target is not in the target group
- `Elb.InitialHealthChecking` — just registered, still in grace period

**If reason is `Elb.InternalError`:** the ALB cannot establish a TCP connection to the task. This is almost certainly the security group change.

**If reason is `Target.FailedHealthChecks`:** the ALB can reach the task but the app returns the wrong status code or the path is wrong. This is the application or task definition change.

### Step 2 — Security group check (most likely culprit given Terraform apply)

The Terraform apply changed the security group. The most common mistake: a change to `sg-bet-validator-ecs` removed or replaced the inbound rule that allows the ALB to reach port 8080.

```bash
# Check the current inbound rules on the ECS task SG
aws ec2 describe-security-groups \
  --group-ids sg-bet-validator-ecs \
  --query 'SecurityGroups[0].IpPermissions'

# What you need to see:
# Port 8080, source = sg-bet-validator-alb
# If missing, this is your root cause
```

Check the Terraform plan output from the apply — what changed on the security group?

```bash
# In the Terraform root
git log --oneline -5
git show HEAD  # see what was actually applied
```

Fix:
```hcl
# The rule that must exist in aws_security_group_rule or inline rule:
ingress {
  from_port       = 8080
  to_port         = 8080
  protocol        = "tcp"
  security_groups = [aws_security_group.bet_validator_alb.id]
  description     = "Allow ALB health checks and traffic"
}
```

Apply the fix, wait 30 seconds for SG propagation, health checks should recover.

### Step 3 — If SG is correct, check health check configuration

The task definition change may have changed the container port mapping. If the container now listens on 8081 but the target group still health-checks port 8080:

```bash
# Check what port the task definition maps
aws ecs describe-task-definition \
  --task-definition bet-validator \
  --query 'taskDefinition.containerDefinitions[0].portMappings'

# Check what port the target group health-checks
aws elbv2 describe-target-groups \
  --names bet-validator \
  --query 'TargetGroups[0].{Port: Port, HealthCheckPort: HealthCheckPort, HealthCheckPath: HealthCheckPath}'
```

### Step 4 — Check deregistration / registration timing

During a rolling deploy, old tasks deregister and new tasks register. If the `deregistration_delay` is set high (default 300 seconds) and the deployment is happening rapidly, you may be in a window where old tasks are draining and new tasks haven't passed their initial health checks yet.

```bash
aws elbv2 describe-target-group-attributes \
  --target-group-arn <arn> \
  --query 'Attributes[?Key==`deregistration_delay.timeout_seconds`]'
```

If this is the cause: wait. Healthy count should recover as new tasks pass health checks and old tasks finish draining.

### Step 5 — Rollback if SG fix is not quick

If the SG fix takes time (Terraform change requires review process), immediate mitigation is to roll back the ECS service to the previous task definition:

```bash
# Get the previous task definition revision
aws ecs describe-services \
  --cluster winamax-prod \
  --services bet-validator \
  --query 'services[0].deployments'

# Roll back to previous revision
aws ecs update-service \
  --cluster winamax-prod \
  --service bet-validator \
  --task-definition bet-validator:PREVIOUS_REVISION
```

This restores the previous port mapping if the task definition change caused it, but does not fix a broken SG.

---

## Follow-up questions they will ask

**"The SG rule exists. The health check path is correct. Tasks are still unhealthy. What else?"**

Check if the app itself is crashing on startup silently — it might start and then fail on the first DB connection. Check CloudWatch Logs for the container. Also check if the app takes more than `healthCheckGracePeriodSeconds` to be ready — a common issue with Java/JVM services that have long warm-up times. Increase the grace period temporarily.

**"How do you prevent a Terraform SG change from causing an outage in the future?"**

Two controls: first, the Terraform plan on PR must be reviewed before merge — any `-` or `~` on a security group inbound rule should trigger a "traffic impact?" review comment. Second, add a canary or synthetic health check that fires within 60 seconds of degraded ALB health, so you catch this before users see 502s.

**"What is the difference between an ALB 502 and a 503 in this context?"**

502 Bad Gateway = the ALB reached the target but got an invalid response, or could not establish a connection. 503 Service Unavailable = the ALB has no healthy targets to route to (target group is empty or all targets unhealthy). In this scenario the 94% error rate with 0 healthy targets should actually produce 503s — if you're seeing 502s, it means some targets are partially healthy and returning malformed responses, which is a different root cause.
