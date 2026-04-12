# Architecture Design 04 — CI/CD Pipeline for 700 Microservices on ECS

## Set the timer: 10 minutes. Close your notes.

---

## The constraints

- 700 microservices, each in its own repository (or monorepo with 700 modules — your choice)
- Each service deploys independently — a bet-validator release should not block odds-engine
- Target: developers push code, pipeline runs tests, deploys to staging, deploys to prod — zero manual steps
- Prod deployments must be zero-downtime rolling (no blue/green budget for all 700)
- Terraform manages infrastructure; ECS task definition image tag is the only thing that changes per deploy
- Secrets must not appear in pipeline logs or environment variables
- If a deploy fails health checks, it must roll back automatically
- Terraform drift detection must run on a schedule and alert if someone made a manual change in the AWS console

**Design:**
1. The pipeline steps from `git push` to production
2. How you handle the image tag in Terraform without a Terraform apply per deploy
3. The rollback mechanism
4. How secrets get into the container
5. The drift detection job
6. How you prevent a bad deploy from one service from blocking others

---

**STOP. Design it now.**

---
---
---
---
---
---

## Reference design

### Pipeline overview

```
Developer: git push to feature branch
    │
    ▼
CI: GitHub Actions (per-service workflow)
    │
    ├─ [on: pull_request]
    │    ├── Unit tests
    │    ├── Integration tests (testcontainers or Docker Compose)
    │    ├── Build Docker image (tag: sha-$GITHUB_SHA)
    │    ├── Push to ECR (staging tag)
    │    └── terraform plan (comment on PR)
    │
    └─ [on: push to main]
         ├── Build Docker image (tag: sha-$GITHUB_SHA)
         ├── Push to ECR
         ├── Deploy to STAGING via ECS image update
         ├── Run smoke tests against staging
         ├── Deploy to PROD via ECS image update
         └── Verify prod health (wait for stable)
```

### The image tag problem

**The problem:** Terraform manages the ECS task definition. The task definition includes the image tag. If you update the image tag via `terraform apply` on every deploy, you need the full Terraform pipeline (plan → review → apply) for every code push. That is too slow for 700 services deploying multiple times per day.

**The solution: separate the deploy pipeline from Terraform**

Terraform manages the task definition template with a variable image tag. The deploy pipeline updates the tag directly via the ECS API, bypassing Terraform for this one attribute. Terraform ignores this attribute via `ignore_changes`.

```hcl
# In the Terraform task definition:
resource "aws_ecs_task_definition" "bet_validator" {
  family = "bet-validator"

  container_definitions = jsonencode([{
    name  = "bet-validator"
    image = "${aws_ecr_repository.bet_validator.repository_url}:latest"
    # 'latest' is the placeholder — actual tag managed by deploy pipeline
  }])

  lifecycle {
    ignore_changes = [container_definitions]
    # Terraform manages CPU, memory, IAM roles, log config
    # The deploy pipeline manages the image tag
  }
}
```

**Deploy pipeline registers a new task definition revision:**

```bash
# In GitHub Actions deploy step:

# 1. Get current task definition
TASK_DEF=$(aws ecs describe-task-definition \
  --task-definition bet-validator \
  --query 'taskDefinition' \
  --output json)

# 2. Update the image tag in the task definition JSON
NEW_TASK_DEF=$(echo $TASK_DEF | jq \
  --arg IMAGE "${ECR_REGISTRY}/bet-validator:sha-${GITHUB_SHA}" \
  '.containerDefinitions[0].image = $IMAGE | 
   del(.taskDefinitionArn, .revision, .status, .requiresAttributes, 
       .placementConstraints, .compatibilities, .registeredAt, .registeredBy)')

# 3. Register the new task definition revision
NEW_REVISION=$(aws ecs register-task-definition \
  --cli-input-json "$NEW_TASK_DEF" \
  --query 'taskDefinition.revision' \
  --output text)

# 4. Update the ECS service to use the new revision
aws ecs update-service \
  --cluster winamax-prod \
  --service bet-validator \
  --task-definition bet-validator:${NEW_REVISION}

# 5. Wait for the deployment to complete
aws ecs wait services-stable \
  --cluster winamax-prod \
  --services bet-validator
```

### Zero-downtime rolling deploy

ECS rolling deploy parameters in the service configuration:

```hcl
resource "aws_ecs_service" "bet_validator" {
  deployment_minimum_healthy_percent = 100  # never reduce below 100% capacity
  deployment_maximum_percent         = 200  # allow up to 2x tasks during rollout

  deployment_circuit_breaker {
    enable   = true
    rollback = true  # automatic rollback if deployment fails
  }

  health_check_grace_period_seconds = 60
}
```

With `minimum_healthy_percent = 100` and `maximum_percent = 200`:
- ECS starts new tasks (bringing total to 2x desired)
- Only stops old tasks after new tasks pass ALB health checks
- Zero traffic interruption during the rollover

### Automatic rollback

`deployment_circuit_breaker` with `rollback = true` monitors the rolling deploy:
- If new tasks fail to reach `RUNNING` state after the configured rollout threshold
- ECS automatically rolls back to the previous task definition revision
- No human intervention required
- CloudWatch event is emitted; the pipeline fails and alerts the developer

The pipeline also fails explicitly:
```bash
# If aws ecs wait services-stable times out (30-minute timeout):
if ! aws ecs wait services-stable --cluster winamax-prod --services bet-validator; then
  echo "Deployment failed — ECS circuit breaker will rollback"
  exit 1
fi
```

### How secrets get into containers

Secrets never go through the pipeline. They are resolved by the ECS agent at task launch time.

```hcl
# In the task definition (managed by Terraform):
container_definitions = jsonencode([{
  secrets = [
    {
      name      = "DB_PASSWORD"
      valueFrom = "arn:aws:secretsmanager:eu-west-3:123456789:secret:winamax/prod/bet-validator/db-password"
    }
  ]
  environment = [
    { name = "ENV", value = "prod" }
    # Non-sensitive config only in environment
  ]
}])
```

The ECS execution role has `secretsmanager:GetSecretValue` permission scoped to that specific ARN. When the task starts, the ECS agent fetches the secret value and injects it as an environment variable. The secret value never appears in the pipeline, the Terraform state, or the task definition JSON stored in ECS.

Secret rotation: update the secret value in Secrets Manager → deploy a new task revision (or restart tasks) → new tasks pick up the new value. Zero Terraform changes required.

### Drift detection pipeline

```yaml
# .github/workflows/drift-detection.yml
on:
  schedule:
    - cron: '0 */6 * * *'   # every 6 hours

jobs:
  detect:
    strategy:
      fail-fast: false   # check all roots even if one fails
      matrix:
        root: [prod/networking, prod/ecs-cluster, prod/alb, prod/msk, prod/rds]

    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/TerraformDriftDetection
          # Read-only role: no write permissions, cannot apply anything

      - run: terraform plan -detailed-exitcode
        id: plan
        continue-on-error: true

      - name: Alert on drift (exit code 2)
        if: steps.plan.outputs.exit_code == '2'
        run: |
          curl -X POST $SLACK_WEBHOOK \
            -d '{"text": ":warning: Drift in ${{ matrix.root }} — see ${{ github.run_url }}"}'

      - name: Alert on detection failure (exit code 1)
        if: steps.plan.outputs.exit_code == '1'
        run: |
          curl -X POST $SLACK_WEBHOOK \
            -d '{"text": ":red_circle: Drift detection FAILED for ${{ matrix.root }}"}'
```

Exit code semantics:
- `0` = no drift, silent success
- `1` = plan errored (provider auth failure, state corrupt) = detection system broken, page the team
- `2` = drift detected = alert in Slack, team remediates

### Isolation: why one service's deploy doesn't block others

Each service has its own GitHub Actions workflow, its own ECR repository, its own ECS service, and its own Terraform root. A deploy failure for `bet-validator` has zero effect on `odds-engine` — they share the cluster and the VPC, but not the pipeline, the task definition, or the Terraform state.

The only shared dependency is the ECS cluster itself. If the cluster is unhealthy, all services are affected — but that is a platform incident, not a service-level deploy issue.
